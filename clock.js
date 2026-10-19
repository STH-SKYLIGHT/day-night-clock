(() => {
  "use strict";

  const $ = (id) => document.getElementById(id);
  const radians = Math.PI / 180;
  const day = 86400000;
  const wrap = (degrees) => ((degrees + 180) % 360 + 360) % 360 - 180;
  const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
  const browserZone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  const cities = {
    tianjin: ["天津市", 39.0842, 117.2009, "Asia/Shanghai"],
    beijing: ["北京市", 39.9042, 116.4074, "Asia/Shanghai"],
    shanghai: ["上海市", 31.2304, 121.4737, "Asia/Shanghai"],
    hongkong: ["香港", 22.3193, 114.1694, "Asia/Hong_Kong"],
    tokyo: ["东京", 35.6762, 139.6503, "Asia/Tokyo"],
    singapore: ["新加坡", 1.3521, 103.8198, "Asia/Singapore"],
    london: ["伦敦", 51.5074, -0.1278, "Europe/London"],
    paris: ["巴黎", 48.8566, 2.3522, "Europe/Paris"],
    newyork: ["纽约", 40.7128, -74.0060, "America/New_York"],
    losangeles: ["洛杉矶", 34.0522, -118.2437, "America/Los_Angeles"],
    sydney: ["悉尼", -33.8688, 151.2093, "Australia/Sydney"]
  };
  const canvas = $("world");
  const ctx = canvas.getContext("2d");
  const pin = document.createElement("div");
  pin.className = "world-pin";
  pin.hidden = true;
  pin.setAttribute("aria-hidden", "true");
  document.querySelector(".clock-face").append(pin);
  const points = window.LAND_DOTS.map(([lon, lat]) => ({
    lon, lat, sinLat: Math.sin(lat * radians), cosLat: Math.cos(lat * radians),
    sinLon: Math.sin(lon * radians), cosLon: Math.cos(lon * radians)
  }));
  let location = null;
  let formatter = makeFormatter(browserZone);
  let clockAnchor = null;
  let clockSyncAt = 0;
  let locationRequest = 0;
  let lastDraw = -1;
  let solarEvent = null;
  let eventCheckedAt = 0;
  let width = 0;
  let height = 0;
  let ticker = null;
  let noticeTimer = null;
  const requests = new Set();

  function makeFormatter(zone) {
    return new Intl.DateTimeFormat("en-GB", { timeZone: zone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
  }

  function now() {
    return clockAnchor ? clockAnchor.utc + performance.now() - clockAnchor.monotonic : Date.now();
  }

  // NOAA solar coordinates. East-positive longitude; the terminator is solar altitude zero.
  function sunPosition(milliseconds) {
    const t = (milliseconds / day + 2440587.5 - 2451545) / 36525;
    const meanLongitude = wrap(280.46646 + t * (36000.76983 + t * .0003032)) * radians;
    const anomaly = (357.52911 + t * (35999.05029 - .0001537 * t)) * radians;
    const eccentricity = .016708634 - t * (.000042037 + .0000001267 * t);
    const center = Math.sin(anomaly) * (1.914602 - t * (.004817 + .000014 * t))
      + Math.sin(2 * anomaly) * (.019993 - .000101 * t) + Math.sin(3 * anomaly) * .000289;
    const omega = (125.04 - 1934.136 * t) * radians;
    const longitude = meanLongitude + (center - .00569 - .00478 * Math.sin(omega)) * radians;
    const seconds = 21.448 - t * (46.815 + t * (.00059 - t * .001813));
    const obliquity = (23 + (26 + seconds / 60) / 60 + .00256 * Math.cos(omega)) * radians;
    const declination = Math.asin(Math.sin(obliquity) * Math.sin(longitude));
    const y = Math.tan(obliquity / 2) ** 2;
    const equation = 4 / radians * (y * Math.sin(2 * meanLongitude) - 2 * eccentricity * Math.sin(anomaly)
      + 4 * eccentricity * y * Math.sin(anomaly) * Math.cos(2 * meanLongitude)
      - .5 * y * y * Math.sin(4 * meanLongitude) - 1.25 * eccentricity ** 2 * Math.sin(2 * anomaly));
    const utcMinutes = ((milliseconds % day) + day) % day / 60000;
    const lon = wrap(180 - utcMinutes / 4 - equation / 4) * radians;
    return { declination, lon, x: Math.cos(declination) * Math.cos(lon), y: Math.cos(declination) * Math.sin(lon), z: Math.sin(declination) };
  }

  function altitude(milliseconds, lat, lon) {
    const sun = sunPosition(milliseconds);
    return Math.sin(lat * radians) * sun.z + Math.cos(lat * radians) * Math.cos(sun.declination) * Math.cos(lon * radians - sun.lon);
  }

  function nextSunEvent(milliseconds) {
    const threshold = Math.sin(-.833 * radians);
    let start = milliseconds;
    let previous = altitude(start, location.latitude, location.longitude) - threshold;
    for (let end = start + 600000; end <= milliseconds + day * 2; end += 600000) {
      const next = altitude(end, location.latitude, location.longitude) - threshold;
      if ((previous < 0) !== (next < 0)) {
        let lower = start;
        let upper = end;
        for (let iteration = 0; iteration < 18; iteration++) {
          const middle = (lower + upper) / 2;
          const middleValue = altitude(middle, location.latitude, location.longitude) - threshold;
          if ((middleValue < 0) === (previous < 0)) lower = middle;
          else upper = middle;
        }
        return { at: (lower + upper) / 2, rising: next > previous };
      }
      start = end;
      previous = next;
    }
    return null;
  }

  function mapFrame() {
    const portrait = height > width;
    return {
      x: width * (portrait ? .04 : .105), y: height * (portrait ? .25 : .10),
      width: width * (portrait ? .92 : .86), height: portrait ? width * .46 : height * .79,
      north: Math.max(86, (location?.latitude ?? 0) + 3), south: Math.min(-60, (location?.latitude ?? 0) - 3)
    };
  }

  function draw(milliseconds) {
    if (!ctx || !width || !height) return;
    const frame = mapFrame();
    const x = (lon) => frame.x + (lon + 180) / 360 * frame.width;
    const y = (lat) => frame.y + (frame.north - lat) / (frame.north - frame.south) * frame.height;
    const sun = sunPosition(milliseconds);
    const radius = Math.max(1.1, frame.width / 64 * .285);
    ctx.clearRect(0, 0, width, height);
    for (const point of points) {
      const illumination = point.sinLat * sun.z + point.cosLat * (point.cosLon * sun.x + point.sinLon * sun.y);
      const daylight = clamp((illumination + .06) / .15, 0, 1);
      const brightness = Math.round(91 + 97 * daylight);
      ctx.fillStyle = `rgb(${brightness}, 2, 0)`;
      ctx.beginPath();
      ctx.arc(x(point.lon), y(point.lat), radius, 0, Math.PI * 2);
      ctx.fill();
    }

    const gradient = ctx.createLinearGradient(0, frame.y, 0, frame.y + frame.height);
    gradient.addColorStop(0, "#c31104");
    gradient.addColorStop(.58, "#8d0800");
    gradient.addColorStop(1, "#260200");
    ctx.save();
    ctx.beginPath();
    ctx.rect(frame.x, 0, frame.width, height);
    ctx.clip();
    ctx.strokeStyle = gradient;
    ctx.lineWidth = Math.max(2, width * .0042);
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.beginPath();
    const u = [-Math.sin(sun.lon), Math.cos(sun.lon), 0];
    const v = [-sun.z * u[1], sun.z * u[0], Math.cos(sun.declination)];
    let previousLongitude = null;
    for (let i = 0; i <= 1440; i++) {
      const angle = i / 1440 * Math.PI * 2;
      const vx = u[0] * Math.cos(angle) + v[0] * Math.sin(angle);
      const vy = u[1] * Math.cos(angle) + v[1] * Math.sin(angle);
      const vz = v[2] * Math.sin(angle);
      const lon = Math.atan2(vy, vx) / radians;
      const lat = Math.asin(clamp(vz, -1, 1)) / radians;
      if (previousLongitude === null || Math.abs(lon - previousLongitude) > 180) ctx.moveTo(x(lon), y(lat));
      else ctx.lineTo(x(lon), y(lat));
      previousLongitude = lon;
    }
    ctx.stroke();
    ctx.restore();
    pin.hidden = !location;
    if (location) {
      pin.style.left = `${x(location.longitude)}px`;
      pin.style.top = `${y(location.latitude)}px`;
      pin.style.setProperty("--pin-size", `${radius * 4.6}px`);
    }
  }

  function tick(force = false) {
    if (document.hidden) return;
    const milliseconds = now();
    const time = formatter.format(milliseconds);
    if ($("local-time").textContent !== time) $("local-time").textContent = time;
    $("local-time").dateTime = new Date(milliseconds).toISOString();
    if (location && (force || milliseconds - eventCheckedAt > 600000 || (solarEvent && solarEvent.at <= milliseconds))) {
      eventCheckedAt = milliseconds;
      solarEvent = nextSunEvent(milliseconds);
      $("solar-event").hidden = !solarEvent;
      if (solarEvent) {
        const eventName = solarEvent.rising ? "下次日出" : "下次日落";
        $("solar-time").textContent = formatter.format(solarEvent.at);
        $("solar-time").dateTime = new Date(solarEvent.at).toISOString();
        $("solar-event").title = eventName;
        $("solar-event").setAttribute("aria-label", `${eventName} ${formatter.format(solarEvent.at)}`);
        $("sunrise-icon").toggleAttribute("hidden", !solarEvent.rising);
        $("sunset-icon").toggleAttribute("hidden", solarEvent.rising);
      }
    }
    const drawPeriod = Math.floor(milliseconds / 30000);
    if (force || drawPeriod !== lastDraw) { lastDraw = drawPeriod; draw(milliseconds); }
  }

  function resize() {
    width = window.innerWidth;
    height = window.innerHeight;
    const ratio = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.round(width * ratio);
    canvas.height = Math.round(height * ratio);
    ctx?.setTransform(ratio, 0, 0, ratio, 0, 0);
    tick(true);
  }

  function notify(message) {
    clearTimeout(noticeTimer);
    $("notice").textContent = message;
    $("notice").hidden = false;
    noticeTimer = setTimeout(() => { $("notice").hidden = true; }, 6500);
  }

  async function getJson(url) {
    const controller = new AbortController();
    requests.add(controller);
    const timeout = setTimeout(() => controller.abort(), 8000);
    try {
      const response = await fetch(url, { signal: controller.signal, credentials: "omit", referrerPolicy: "no-referrer", cache: "no-store" });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return await response.json();
    } finally { clearTimeout(timeout); requests.delete(controller); }
  }

  async function syncClock() {
    const started = performance.now();
    try {
      const data = await getJson("https://worldtimeapi.org/api/timezone/Etc/UTC");
      const timestamp = Date.parse(data.utc_datetime);
      if (!Number.isFinite(timestamp)) throw new Error("Invalid time");
      const received = performance.now();
      clockAnchor = { utc: timestamp + (received - started) / 2, monotonic: received };
      clockSyncAt = Date.now();
      $("time-source").textContent = "时间：公共 UTC · WorldTimeAPI";
      tick(true);
    } catch {
      $("time-source").textContent = clockAnchor ? "时间：上次公共授时 · 正在本地续走" : "时间：本机时钟 · 公共授时暂不可用";
    }
  }

  function setLocation(value, source, persist = false) {
    if (!Number.isFinite(value.latitude) || !Number.isFinite(value.longitude) || Math.abs(value.latitude) > 90 || Math.abs(value.longitude) > 180) throw new Error("Invalid coordinates");
    const nextFormatter = makeFormatter(value.timezone);
    location = { ...value };
    formatter = nextFormatter;
    $("place-name").textContent = location.name || "当前位置";
    $("location-source").textContent = `位置：${source} · ${location.timezone}`;
    $("coordinate-display").textContent = `${Math.abs(location.latitude).toFixed(2)}° ${location.latitude >= 0 ? "N" : "S"} / ${Math.abs(location.longitude).toFixed(2)}° ${location.longitude >= 0 ? "E" : "W"}`;
    $("place-button").title = source;
    if (persist) { try { localStorage.setItem("daynight.location.v1", JSON.stringify(location)); } catch {} }
    tick(true);
  }

  function localizedCity(name, zone) {
    const normalized = String(name || "").toLowerCase().replace(/\s+/g, "");
    for (const [key, values] of Object.entries(cities)) {
      if (normalized === key || normalized === `${key}shi`) return values[0];
    }
    return name || zone?.split("/").pop()?.replaceAll("_", " ") || "当前位置";
  }

  async function locateByIp() {
    const request = ++locationRequest;
    $("location-source").textContent = "位置：定位中";
    try {
      const data = await getJson("https://get.geojs.io/v1/ip/geo.json");
      if (request !== locationRequest) return;
      if (data.latitude == null || data.longitude == null) throw new Error("Missing coordinates");
      setLocation({ name: localizedCity(data.city, data.timezone), latitude: Number(data.latitude), longitude: Number(data.longitude), timezone: data.timezone || browserZone }, "IP 估算");
    } catch {
      if (request !== locationRequest) return;
      if (!location) $("place-name").textContent = "选择位置";
      $("location-source").textContent = location ? "位置：保留上次位置 · 自动定位不可用" : "位置：自动定位不可用，可手动选择";
    }
  }

  function locateDevice() {
    if (!navigator.geolocation || !window.isSecureContext) { notify("设备定位需 HTTPS 或 localhost；也可在设置中选择城市。"); return; }
    const request = ++locationRequest;
    $("locate").disabled = true;
    navigator.geolocation.getCurrentPosition(async ({ coords }) => {
      $("locate").disabled = false;
      if (request !== locationRequest) return;
      const value = { name: "当前位置", latitude: coords.latitude, longitude: coords.longitude, timezone: browserZone };
      setLocation(value, "设备定位 / 设备时区");
      try {
        const data = await getJson(`https://api.bigdatacloud.net/data/reverse-geocode-client?latitude=${coords.latitude}&longitude=${coords.longitude}&localityLanguage=zh`);
        if (request !== locationRequest) return;
        value.name = data.city || data.locality || "当前位置";
        setLocation(value, "设备定位 / 设备时区");
      } catch {}
    }, () => {
      $("locate").disabled = false;
      if (request === locationRequest) notify("未取得设备位置，可在设置中选择城市。");
    }, { enableHighAccuracy: false, timeout: 10000, maximumAge: 300000 });
  }

  function openSettings() {
    $("form-error").textContent = "";
    if (!$("preferences").open) $("preferences").showModal();
  }
  $("settings").addEventListener("click", openSettings);
  $("place-button").addEventListener("click", openSettings);
  $("close-settings").addEventListener("click", () => $("preferences").close());
  $("preferences").addEventListener("click", (event) => {
    if (event.target !== $("preferences")) return;
    const bounds = $("preferences").getBoundingClientRect();
    if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) $("preferences").close();
  });
  $("city").addEventListener("change", () => {
    $("custom-location").hidden = $("city").value !== "custom";
    $("form-error").textContent = "";
    if (location && $("city").value === "custom") {
      $("custom-name").value = location.name;
      $("latitude").value = location.latitude;
      $("longitude").value = location.longitude;
      $("timezone").value = location.timezone;
    }
  });
  $("location-form").addEventListener("submit", (event) => {
    event.preventDefault();
    const choice = $("city").value;
    let value;
    if (cities[choice]) {
      const [name, latitude, longitude, timezone] = cities[choice];
      value = { name, latitude, longitude, timezone };
    } else if (choice === "custom") {
      if (!$("latitude").value.trim() || !$("longitude").value.trim()) { $("form-error").textContent = "请填写经纬度。"; return; }
      value = { name: $("custom-name").value.trim() || "当前位置", latitude: Number($("latitude").value), longitude: Number($("longitude").value), timezone: $("timezone").value.trim() || browserZone };
    } else { $("form-error").textContent = "请选择城市。"; return; }
    try {
      setLocation(value, "手动选择", true);
      ++locationRequest;
      $("preferences").close();
    } catch { $("form-error").textContent = "请检查经纬度及 IANA 时区，例如 Asia/Shanghai。"; }
  });
  $("auto-location").addEventListener("click", () => {
    try { localStorage.removeItem("daynight.location.v1"); } catch {}
    $("preferences").close();
    locateByIp();
  });
  $("locate").addEventListener("click", locateDevice);
  $("fullscreen").addEventListener("click", async () => {
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else if (document.documentElement.requestFullscreen) await document.documentElement.requestFullscreen();
      else notify("此浏览器暂不支持页面全屏。");
    } catch { notify("未能切换全屏，可使用浏览器的全屏功能。"); }
  });
  document.addEventListener("fullscreenchange", () => { $("fullscreen").setAttribute("aria-label", document.fullscreenElement ? "退出全屏" : "全屏"); });
  window.addEventListener("resize", resize);
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) { clearInterval(ticker); ticker = null; }
    else {
      tick(true);
      if (!ticker) ticker = setInterval(tick, 1000);
      if (Date.now() - clockSyncAt > 3600000) syncClock();
    }
  });
  window.addEventListener("pagehide", () => { clearInterval(ticker); ticker = null; requests.forEach((controller) => controller.abort()); });
  window.addEventListener("pageshow", () => { if (!ticker) ticker = setInterval(tick, 1000); tick(true); });

  try {
    const saved = JSON.parse(localStorage.getItem("daynight.location.v1"));
    if (saved) setLocation(saved, "手动选择");
  } catch { try { localStorage.removeItem("daynight.location.v1"); } catch {} }
  if (!location) locateByIp();
  resize();
  ticker = setInterval(tick, 1000);
  syncClock();
})();
