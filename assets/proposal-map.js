(() => {
  "use strict";

  const node = (tag, text, attrs = {}) => {
    const el = document.createElement(tag);
    if (text) el.textContent = text;
    for (const [key, value] of Object.entries(attrs)) el.setAttribute(key, value);
    return el;
  };
  const colors = { bus: "#ae6039", metro: "#327788" };
  const radians = Math.PI / 180;
  const tileSize = 256;

  // The platform shares BD-09 coordinates. OpenStreetMap uses WGS 84 / Web Mercator.
  function fromBaidu([lon, lat]) {
    const x = lon - 0.0065;
    const y = lat - 0.006;
    const distance = Math.hypot(x, y) - 0.00002 * Math.sin(y * radians * 3000);
    const angle = Math.atan2(y, x) - 0.000003 * Math.cos(x * radians * 3000);
    const gcjLon = distance * Math.cos(angle);
    const gcjLat = distance * Math.sin(angle);
    let wgsLon = gcjLon;
    let wgsLat = gcjLat;
    for (let i = 0; i < 2; i++) {
      const dx = wgsLon - 105;
      const dy = wgsLat - 35;
      const wave = (20 * Math.sin(6 * dx * Math.PI) + 20 * Math.sin(2 * dx * Math.PI)) * 2 / 3;
      const latShift = -100 + 2 * dx + 3 * dy + 0.2 * dy ** 2 + 0.1 * dx * dy + 0.2 * Math.sqrt(Math.abs(dx)) + wave +
        (20 * Math.sin(dy * Math.PI) + 40 * Math.sin(dy / 3 * Math.PI) + 160 * Math.sin(dy / 12 * Math.PI) + 320 * Math.sin(dy / 30 * Math.PI)) * 2 / 3;
      const lonShift = 300 + dx + 2 * dy + 0.1 * dx ** 2 + 0.1 * dx * dy + 0.1 * Math.sqrt(Math.abs(dx)) + wave +
        (20 * Math.sin(dx * Math.PI) + 40 * Math.sin(dx / 3 * Math.PI) + 150 * Math.sin(dx / 12 * Math.PI) + 300 * Math.sin(dx / 30 * Math.PI)) * 2 / 3;
      const phi = wgsLat * radians;
      const magic = 1 - 0.006693421622965943 * Math.sin(phi) ** 2;
      const radius = 6378245 / Math.sqrt(magic);
      wgsLon = gcjLon - lonShift / (radius * Math.cos(phi) * radians);
      wgsLat = gcjLat - latShift / (radius * (1 - 0.006693421622965943) / magic * radians);
    }
    return [wgsLon, wgsLat];
  }

  function mercator([lon, lat]) {
    return [tileSize * (lon + 180) / 360, tileSize * (1 - Math.asinh(Math.tan(lat * radians)) / Math.PI) / 2];
  }

  function mount(target, data, { basemap = false } = {}) {
    if (!target) return;
    target.replaceChildren();
    const features = data?.features || [];
    const share = data?.shareUrl || data?.metroShareUrl;
    if (!features.length && !share) return;
    const panel = node("div", "", { class: "proposal-map" });
    target.append(panel);
    if (share) {
      const link = node("a", "打开大数据平台地图", { href: share, target: "_blank", rel: "noopener noreferrer" });
      panel.append(link);
    }
    if (data.metroShareUrl && data.shareUrl) panel.append(node("a", "打开地铁原图", { href: data.metroShareUrl, target: "_blank", rel: "noopener noreferrer" }));
    if (!features.length) {
      const iframe = node("iframe", "", { class: "flair-provider-map", src: share, title: "授权的公交地铁线路地图", loading: "lazy", referrerpolicy: "no-referrer", allowfullscreen: "" });
      panel.prepend(iframe);
      if (data.unmatched?.length) panel.append(node("p", "平台地图为已授权的线路图。当前资源清单以本版提案为准。", { class: "proposal-map-note" }));
      return;
    }

    const lineParts = (feature) => feature.type === "LineString" ? [feature.coordinates] : feature.type === "Point" ? [] : feature.coordinates;
    const coords = features.flatMap((f) => f.type === "Point" ? [f.coordinates] : lineParts(f).flat());
    const lats = coords.map(([, lat]) => lat);
    const meridianScale = Math.cos((Math.max(...lats) + Math.min(...lats)) / 2 * radians);
    const project = basemap
      ? (point) => mercator(data.coordinateSystem === "BD09" ? fromBaidu(point) : point)
      : ([lon, lat]) => [lon * meridianScale, -lat];
    const projected = new Map(coords.map((point) => [point, project(point)]));
    const xs = [...projected.values()].map(([x]) => x);
    const ys = [...projected.values()].map(([, y]) => y);
    const middle = [(Math.max(...xs) + Math.min(...xs)) / 2, (Math.max(...ys) + Math.min(...ys)) / 2];
    const ratio = Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys), basemap ? 0.0015 : 0.002);
    const canvas = node("canvas", "", { class: "flair-route-canvas", "aria-label": "投放资源的真实线路与点位", role: "img" });
    const ctx = canvas.getContext("2d");
    let active = null, zoom = 1, offset = [0, 0], drag;
    const tiles = new Map();

    function paintBasemap(width, height, scale, left, top) {
      const level = Math.max(0, Math.min(19, Math.round(Math.log2(scale))));
      const count = 2 ** level;
      const size = tileSize * scale / count;
      for (let y = Math.max(0, Math.floor(-top / size)); y < Math.min(count, Math.ceil((height - top) / size)); y++) {
        for (let x = Math.floor(-left / size); x < Math.ceil((width - left) / size); x++) {
          const key = `${level}/${(x % count + count) % count}/${y}`;
          let tile = tiles.get(key);
          if (!tile) {
            if (tiles.size >= 96) tiles.delete(tiles.keys().next().value);
            tile = new Image();
            tile.referrerPolicy = "origin";
            tile.onload = () => { if (canvas.isConnected) paint(); };
            tiles.set(key, tile);
            tile.src = `https://tile.openstreetmap.org/${key}.png`;
          }
          if (tile.complete && tile.naturalWidth) ctx.drawImage(tile, left + x * size, top + y * size, size + 0.5, size + 0.5);
        }
      }
    }

    function paint() {
      const width = canvas.clientWidth || 520;
      const height = canvas.clientHeight || 320;
      const density = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = width * density;
      canvas.height = height * density;
      ctx.scale(density, density);
      const scale = Math.min(width, height) * 0.82 / ratio * zoom;
      const left = width / 2 - middle[0] * scale + offset[0];
      const top = height / 2 - middle[1] * scale + offset[1];
      const xy = (point) => {
        const [x, y] = projected.get(point);
        return [left + x * scale, top + y * scale];
      };
      ctx.fillStyle = "#f1f5f3";
      ctx.fillRect(0, 0, width, height);
      if (basemap) paintBasemap(width, height, scale, left, top);
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      for (const feature of features) {
        const focused = !active || active === feature;
        ctx.globalAlpha = focused ? feature.reference ? 0.5 : 1 : 0.18;
        ctx.strokeStyle = colors[feature.kind];
        ctx.fillStyle = colors[feature.kind];
        ctx.lineWidth = active === feature ? 5 : 3;
        for (const line of lineParts(feature)) {
          ctx.beginPath();
          ctx.moveTo(...xy(line[0]));
          for (const coordinate of line.slice(1)) ctx.lineTo(...xy(coordinate));
          ctx.stroke();
        }
        if (feature.type === "Point") {
          ctx.beginPath();
          ctx.arc(...xy(feature.coordinates), active === feature ? 8 : 5, 0, 2 * Math.PI);
          ctx.fill();
        }
      }
      ctx.globalAlpha = 1;
    }

    const tools = node("div", "", { class: "proposal-map-tools" });
    for (const [label, action] of [["放大", () => { zoom = Math.min(8, zoom * 1.35); }], ["缩小", () => { zoom = Math.max(0.6, zoom / 1.35); }],
      ["全览", () => { zoom = 1; offset = [0, 0]; }]]) {
      const button = node("button", label, { type: "button" });
      button.addEventListener("click", () => { action(); paint(); });
      tools.append(button);
    }
    const list = node("div", "", { class: "proposal-map-items", "aria-label": "选择高亮线路或点位" });
    const locator = node("p", "", { class: "proposal-map-note", role: "status" });
    for (const feature of features) {
      const button = node("button", (feature.kind === "bus" ? "公交 " : feature.reference ? "地图参考 " : "地铁 ") + feature.name, { type: "button", "aria-pressed": "false" });
      button.addEventListener("click", () => {
        active = active === feature ? null : feature;
        locator.replaceChildren();
        if (active?.sourceUrl) locator.append(node("a", "核对地铁出口位置（高德地图）", { href: active.sourceUrl, rel: "noopener noreferrer", target: "_blank" }));
        for (const item of list.children) item.setAttribute("aria-pressed", String(Boolean(active) && item === button));
        paint();
      });
      list.append(button);
    }
    const frame = node("div", "", { class: "proposal-map-frame" });
    frame.append(canvas, tools);
    if (basemap) frame.append(node("a", "© OpenStreetMap contributors", {
      class: "proposal-map-attribution", href: "https://www.openstreetmap.org/copyright", target: "_blank", rel: "noopener noreferrer",
    }));
    panel.prepend(frame, list, locator);
    panel.append(node("p", data.source + (data.unmatched?.length ? `。${data.unmatched.length} 项资源待匹配地图。` : "。"), { class: "proposal-map-note" }));
    if (features.some((feature) => feature.sourceUrl)) panel.append(node("p", "公开地图定位指地铁出口，广告画面的具体位置以现场核实为准。", { class: "proposal-map-note" }));
    canvas.addEventListener("pointerdown", (event) => {
      drag = [event.clientX - offset[0], event.clientY - offset[1]];
      canvas.setPointerCapture(event.pointerId);
    });
    canvas.addEventListener("pointermove", (event) => {
      if (!drag) return;
      offset = [event.clientX - drag[0], event.clientY - drag[1]];
      paint();
    });
    for (const stop of ["pointerup", "pointercancel", "lostpointercapture"]) canvas.addEventListener(stop, () => { drag = null; });
    const resize = new ResizeObserver(() => { if (canvas.isConnected) paint(); else resize.disconnect(); });
    resize.observe(frame);
    paint();
  }

  window.FlairMap = { mount };
})();
