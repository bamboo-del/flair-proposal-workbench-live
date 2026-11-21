(() => {
  "use strict";

  const node = (tag, text, attrs = {}) => {
    const el = document.createElement(tag);
    if (text) el.textContent = text;
    for (const [key, value] of Object.entries(attrs)) el.setAttribute(key, value);
    return el;
  };
  const colors = { bus: "#ae6039", metro: "#327788" };

  function mount(target, data) {
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
    const lons = coords.map(([lon]) => lon);
    const lats = coords.map(([, lat]) => lat);
    const middle = [(Math.max(...lons) + Math.min(...lons)) / 2, (Math.max(...lats) + Math.min(...lats)) / 2];
    const meridianScale = Math.cos(middle[1] * Math.PI / 180);
    const ratio = Math.max((Math.max(...lons) - Math.min(...lons)) * meridianScale, Math.max(...lats) - Math.min(...lats), 0.002);
    const canvas = node("canvas", "", { class: "flair-route-canvas", "aria-label": "投放资源的真实线路与点位", role: "img" });
    const ctx = canvas.getContext("2d");
    let active = null, zoom = 1, offset = [0, 0], drag;

    function paint() {
      const width = canvas.clientWidth || 520;
      const height = canvas.clientHeight || 320;
      const density = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = width * density;
      canvas.height = height * density;
      ctx.scale(density, density);
      const scale = Math.min(width, height) * 0.82 / ratio * zoom;
      const xy = ([lon, lat]) => [width / 2 + (lon - middle[0]) * scale * meridianScale + offset[0], height / 2 - (lat - middle[1]) * scale + offset[1]];
      ctx.fillStyle = "#f1f5f3";
      ctx.fillRect(0, 0, width, height);
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
