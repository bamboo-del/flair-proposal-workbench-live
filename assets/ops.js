(() => {
  "use strict";
  const $ = (id) => document.getElementById(id);
  let me = null, projectId = null, state = null, types = {}, defaults = null, selectedChange = null;
  const el = (tag, attrs = {}, ...children) => {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (k === "text") node.textContent = v;
      else if (k === "on") for (const [ev, fn] of Object.entries(v)) node.addEventListener(ev, fn);
      else if (v !== false && v != null) node.setAttribute(k, v === true ? "" : v);
    }
    node.append(...children.filter((c) => c != null));
    return node;
  };
  const tell = (text = "", tone = "") => { $("msg").textContent = text; $("msg").dataset.tone = tone; };
  async function api(url, method = "GET", data) {
    const response = await fetch(url, { method, headers: { "Content-Type": "application/json", "X-Flair-Client": "1" }, ...(data === undefined ? {} : { body: JSON.stringify(data) }) });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw Object.assign(new Error(body.error || "请求失败。"), { status: response.status });
    return body;
  }
  const path = (tail) => "/api/projects/" + projectId + tail;
  const run = (fn) => (...args) => Promise.resolve().then(() => fn(...args)).catch((error) => tell(error.message, "error"));
  const fill = (node, ...kids) => node.replaceChildren(...kids.filter((k) => k != null));
  const car = (id, cls = "") => el("span", { class: "ss-car " + cls, text: id });
  const table = (head, rows) => el("div", { class: "ss-table" }, el("table", {}, el("thead", {}, el("tr", {}, ...head.map((h) => el("th", { text: h })))),
    el("tbody", {}, ...rows.map((r) => el("tr", {}, ...r.map((c) => el("td", {}, c)))))));

  /* ---------- 配置 ---------- */
  function fillConfig(c) {
    const f = $("configForm");
    for (const key of ["route", "startDate", "duration", "minUnits", "perNight", "constructionNights", "buffer", "format", "artworkModel", "ruleSource"]) f[key].value = c[key];
    f.windowFrom.value = c.window.from; f.windowTo.value = c.window.to; f.minHours.value = c.window.minHours;
    f.miss.value = c.makeGood.miss; f.compensate.value = c.makeGood.compensate;
    f.stoppages.value = c.stoppages.map((s) => s.date + " " + s.reason).join("\n");
  }
  function parseCsv(text) {
    const [head, ...lines] = text.trim().split(/\r?\n/).map((line) => line.split(",").map((x) => x.trim()));
    if (!head || !head.includes("id")) throw new Error("台账 CSV 需要表头，至少包含 id 列。");
    return lines.filter((l) => l.length > 1).map((cells) => {
      const row = Object.fromEntries(head.map((h, i) => [h, cells[i] ?? ""]));
      return { ...row, idleDays: Number(row.idleDays) || 0, unavailable: [] };
    });
  }
  async function saveConfig(event) {
    event.preventDefault();
    const f = event.target;
    const n = (k) => Number(f[k].value);
    const config = {
      route: f.route.value, startDate: f.startDate.value, duration: n("duration"), minUnits: n("minUnits"), perNight: n("perNight"), constructionNights: n("constructionNights"), buffer: n("buffer"),
      window: { from: f.windowFrom.value, to: f.windowTo.value, minHours: n("minHours") }, format: f.format.value, artworkModel: f.artworkModel.value,
      makeGood: { miss: n("miss"), compensate: n("compensate") }, ruleSource: f.ruleSource.value,
      stoppages: f.stoppages.value.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).map((l) => { const [date, ...r] = l.split(/\s+/); return { date, reason: r.join(" ") || "停工" }; }),
    };
    const synthetic = f.fleetSource.value === "synthetic";
    const body = { config, revision: state?.revision, synthetic, count: n("count"), ...(synthetic ? {} : { fleet: parseCsv(f.fleetCsv.value) }) };
    const result = await api(path("/dispatch"), "PUT", body);
    state = result;
    selectedChange = null;
    $("previewView").replaceChildren();
    renderPlan();
    await changes();
    tell("已保存配置并生成初始计划（第 " + state.revision + " 版）。");
  }

  /* ---------- 计划 ---------- */
  function nightsView(nights, highlight = {}) {
    return el("div", {}, ...nights.map((n) => el("div", { class: "ss-night" },
      el("strong", { text: n.date + " 晚" + (n.inCampaign ? "（在刊期补位）" : "") }),
      el("div", {}, ...(n.stopped ? [el("span", { class: "ss-stopped", text: "停工：" + n.stopped + " " })] : []),
        ...(n.before || []).filter((v) => !(n.after || n.vehicles).includes(v)).map((v) => car(v, "ss-out")),
        ...(n.after || n.vehicles).map((v) => car(v, highlight[v] ? "ss-in" : "")),
        el("small", { class: "ss-muted", text: " " + (n.after || n.vehicles).length + (n.capacity != null ? "/" + n.capacity : "") + " 台" })))));
  }
  function shortfallView(s) {
    return el("div", { class: "ss-conflict", role: "alert" }, el("p", {}, el("strong", { text: s.message })),
      s.stopped.length ? el("p", { text: "停工夜：" + s.stopped.join("；") }) : null,
      el("p", { text: "可调整的条件：" }), el("ul", {}, ...s.options.map((o) => el("li", { text: o }))));
  }
  function renderPlan() {
    $("planCard").hidden = !state; $("changeCard").hidden = !state;
    if (!state) return;
    const p = state.plan;
    $("planStatus").className = "ss-status " + p.status;
    $("planStatus").textContent = p.status === "ready" ? "可执行（待团队确认）" : "待复核 · 不发布";
    const fleet = new Map(state.fleet.map((v) => [v.id, v]));
    fill($("planView"),
      el("p", { text: state.config.route + " 线 · " + p.campaign.start + " 至 " + p.campaign.end + " · 起投 " + p.rules.minUnits + " 台 · 每晚最多 " + p.rules.perNight + " 台 · 窗口 " + p.rules.window.from + "–" + p.rules.window.to + " · 误 " + p.rules.makeGood.miss + " 补 " + p.rules.makeGood.compensate }),
      el("p", { class: "ss-muted", text: "规则来源：" + p.rules.source + (p.synthetic ? " · 车辆为合成数据（SYN-*），待正式车级台账联调" : "") + " · 第 " + state.revision + " 版，" + state.updatedBy + " 更新于 " + new Date(state.updated).toLocaleString("zh-CN") }),
      p.shortfall ? shortfallView(p.shortfall) : null,
      el("h3", { text: "施工夜次" }), nightsView(p.nights),
      el("p", {}, "备用车：", ...(p.standby.length ? p.standby.map((v) => car(v)) : [el("span", { text: "无" })])),
      p.excluded.length ? el("div", {}, el("h3", { text: "硬约束排除" }), table(["车辆", "原因"], p.excluded.map((x) => [x.id, x.reasons.join("；")]))) : null,
      el("h3", { text: "制作单" }), table(["车辆", "画面", "是否沿用原版", "最迟到位"], p.production.map((x) => [x.vehicle, x.item, x.reuse ? "沿用" : "需按车型补印", x.due])),
      el("details", {}, el("summary", { text: "车级台账（" + state.fleet.length + " 台）" }),
        table(["车辆", "车型", "形式", "状态", "回场", "闲置天数", "不可用时段"], state.fleet.map((v) => [v.id, v.model, v.format, v.status, v.depotReturn, String(v.idleDays), v.unavailable.map((u) => u.reason + " " + u.from + "–" + u.to).join("；") || "—"]))));
    const sel = $("changeForm").vehicle;
    sel.replaceChildren(el("option", { value: "", text: "（不涉及车辆）" }), ...state.fleet.map((v) => el("option", { value: v.id, text: v.id + (p.assignments.some((a) => a.vehicle === v.id) ? " · 已排" : "") + " · " + v.model })));
    void fleet;
  }

  /* ---------- 变更单 ---------- */
  async function createChange(event) {
    event.preventDefault();
    const f = event.target;
    const data = { type: f.type.value, vehicle: f.vehicle.value, from: f.from.value, to: f.to.value || f.from.value, note: f.note.value,
      dates: f.dates.value.split(/[,，\s]+/).filter(Boolean) };
    const order = await api(path("/changes"), "POST", data);
    selectedChange = order;
    renderPreview(order);
    await changes();
    tell(order.preview.applicable ? "已生成变更预览，确认后应用。" : "变更后存在缺口，方案保留待复核状态。");
  }
  function renderPreview(order) {
    const pv = order.preview;
    const d = pv.delta;
    const ins = Object.fromEntries(d.pairs.map((x) => [x.in, true]));
    const view = $("previewView");
    fill(view,
      el("h3", {}, "变更预览：" + order.label + " ", el("span", { class: "ss-status " + pv.plan.status, text: pv.plan.status === "ready" ? "可应用" : "待复核 · 不发布" }), " ", el("small", { class: "ss-muted", text: "状态：" + ({ pending: "待确认", applied: "已应用", rejected: "已驳回", stale: "已过期" })[order.status] })),
      el("p", { text: (order.input.vehicle ? order.input.vehicle + " · " : "") + order.input.from + (order.input.to !== order.input.from ? " 至 " + order.input.to : "") + (order.input.type === "weather" || order.input.type === "city_control" ? " · 停工夜 " + order.input.dates.join("、") : "") + (order.input.note ? " · " + order.input.note : "") }),
      pv.plan.shortfall ? shortfallView(pv.plan.shortfall) : null,
      d.pairs.length ? el("div", {}, el("h3", { text: "替补车辆" }), table(["退出", "替补", "施工夜", "车型", "误刊 / 补偿"], d.pairs.map((x) => [x.out || "—", x.in, x.night + " 晚", x.model, x.missedDays ? "误 " + x.missedDays + " 天 → 补 " + x.makeGoodDays + " 天" : "不影响在刊"]))) : null,
      d.moved.length ? el("div", {}, el("h3", { text: "顺延的车辆" }), table(["车辆", "原施工夜", "新施工夜"], d.moved.map((x) => [x.vehicle, x.from, x.to]))) : null,
      el("h3", { text: "施工夜次（变更前 → 变更后）" }), nightsView(d.nights.filter((n) => n.changed || n.after.length || n.before.length), ins),
      el("h3", { text: "受影响的制作事项" }), table(["车辆", "画面", "处理"], pv.plan.production.filter((x) => ins[x.vehicle]).map((x) => [x.vehicle, x.item, x.reuse ? "原制作单改绑或按原版补印" : "需按车型补印"]).concat(d.removed.map((v) => [v, "—", pv.plan.status === "ready" ? "原制作单转给替补车或作废" : "未排上施工夜，制作单暂缓，待缺口方案确定"]))),
      el("h3", { text: "待办（按先后顺序）" }),
      el("ol", { class: "ss-tasks" }, ...pv.tasks.map((t) => el("li", {}, el("strong", { text: t.id + " · " + t.owner + "：" + t.title }), el("br"), el("small", { text: t.detail + (t.dependsOn.length ? "（前置：" + t.dependsOn.join("、") + "）" : "") })))),
      el("h3", { text: "客户通知草稿（" + order.notice.state + " · " + (order.notice.source === "ai" ? "AI 生成" : "模板") + "）" }),
      el("p", { class: "ss-muted", text: order.notice.note || "" }),
      el("label", {}, "标题", el("input", { id: "noticeSubject", value: order.notice.subject, maxlength: 80, style: "width:100%" })),
      el("label", {}, "正文", el("textarea", { id: "noticeBody", rows: 8 }, order.notice.body)),
      el("div", { class: "portal-actions" },
        el("button", { type: "button", class: "portal-button secondary", text: "保存通知草稿", disabled: order.status !== "pending", on: { click: run(saveNotice) } }),
        el("button", { type: "button", class: "portal-button", text: "团队确认并应用", disabled: order.status !== "pending" || !pv.applicable, on: { click: run(applyChange) } }),
        el("button", { type: "button", class: "portal-button secondary", text: "驳回", disabled: order.status !== "pending", on: { click: run(rejectChange) } }),
        !pv.applicable ? el("span", { class: "ss-warn", text: "存在缺口，不能应用。请调整条件后重新录入变更单。" }) : null));
  }
  async function saveNotice() {
    selectedChange = await api(path("/changes/" + selectedChange.id + "/notice"), "PUT", { subject: $("noticeSubject").value, body: $("noticeBody").value });
    renderPreview(selectedChange);
    tell("通知草稿已保存，仍需负责人审阅后由团队发送。");
  }
  async function applyChange() {
    const result = await api(path("/changes/" + selectedChange.id + "/apply"), "POST", {});
    state = result.state; selectedChange = result.order;
    renderPlan(); renderPreview(selectedChange); await changes();
    tell("变更已应用，执行计划更新为第 " + state.revision + " 版。客户通知仍为草稿。");
  }
  async function rejectChange() {
    selectedChange = await api(path("/changes/" + selectedChange.id + "/reject"), "POST", {});
    renderPreview(selectedChange); await changes();
  }
  async function changes() {
    const rows = await api(path("/changes"));
    const label = { pending: "待确认", applied: "已应用", rejected: "已驳回", stale: "已过期" };
    $("changeRows").replaceChildren(...(rows.length ? rows.map((r) => el("button", { type: "button", class: "ss-history", on: { click: () => { selectedChange = r; renderPreview(r); } } },
      el("strong", { text: r.label + " · " + label[r.status] + " · " + (r.preview.applicable ? "可执行" : "待复核") }),
      el("small", { text: (r.input.vehicle || r.input.dates.join("、")) + " · " + r.author + " · " + new Date(r.created).toLocaleString("zh-CN") }))) : [el("p", { text: "暂无变更单。" })]));
  }

  /* ---------- 客户 ---------- */
  async function clients() {
    $("grantForm").hidden = me.role !== "admin";
    if (me.role === "admin") {
      const grants = await api(path("/clients"));
      $("grantRows").replaceChildren(el("p", { text: "已授权客户：" + (grants.map((g) => g.name).join("、") || "无") }));
    } else $("grantRows").replaceChildren();
    const drafts = await api(path("/client-drafts"));
    const label = { draft: "草稿", shared: "已分享", submitted: "已提交审核" };
    $("draftRows").replaceChildren(el("h3", { text: "客户草稿（" + drafts.length + "）" }), ...(drafts.length ? [table(["客户", "版本", "状态", "档期", "预算", "公交/地铁", "费用区间", "覆盖", "操作"], drafts.map((d) => [
      d.owner, "第 " + d.seq + " 版", label[d.status] + (d.review ? " · " + (d.review.decision === "accepted" ? "已采纳" : "已退回") : ""), d.window.start + " 起", d.budgetWan + " 万", d.counts.bus + " / " + d.counts.metro,
      (d.total[0] / 10000).toFixed(1) + "–" + (d.total[1] / 10000).toFixed(1) + " 万", d.coverage + "%",
      el("span", {}, el("button", { type: "button", class: "portal-button secondary", text: "查看", on: { click: run(() => viewDraft(d.id)) } }),
        me.role !== "viewer" && d.status === "submitted" ? el("button", { type: "button", class: "portal-button secondary", text: "采纳并交接", on: { click: run(() => review(d.id, "accepted")) } }) : null,
        me.role !== "viewer" && d.status === "submitted" ? el("button", { type: "button", class: "portal-button secondary", text: "退回", on: { click: run(() => review(d.id, "returned")) } }) : null),
    ]))] : [el("p", { text: "客户尚未生成草稿。" })]));
  }
  async function viewDraft(id) {
    const d = await api(path("/client-drafts/" + id));
    $("draftView").hidden = false;
    $("draftView").innerHTML = d.html; // 服务端已转义
    window.FlairMap.mount($("draftView").querySelector("[data-proposal-map]"), d.plan.map);
    $("draftView").scrollIntoView({ behavior: "smooth" });
  }
  async function review(id, decision) {
    const note = decision === "returned" ? prompt("退回原因（客户可见）", "") ?? "" : "已采纳，团队将按审核流程出具正式报价并锁位。";
    await api(path("/client-drafts/" + id + "/review"), "POST", { decision, note });
    await Promise.all([clients(), handoff()]);
    tell("已记录审核结论。采纳的版本已同步至执行交接。");
  }

  async function handoff() {
    const target = $("handoffRows");
    const [data, map] = await Promise.all([api(path("/handoff")), api(path("/map-evidence"))]);
    $("mapForm").hidden = me.role === "viewer";
    $("mapForm").elements.shareUrl.value = map?.shareUrl || "";
    $("mapForm").elements.metroShareUrl.value = map?.metroShareUrl || "";
    $("mapStatus").textContent = map ? `${map.source}，${map.count} 条路线或点位。新草稿将按资源名称匹配。` : "暂无地图资料。";
    if (!data) { target.textContent = "采纳客户提交的版本后，这里会显示线路、点位、档期和待复核事项。"; return; }
    const bus = data.media.filter((row) => row.kind === "bus");
    target.replaceChildren(el("p", { text: `${data.title} · 第 ${data.seq} 版 · ${data.window.start} 至 ${data.window.end}` }),
      table(["资源", "媒体", "数量", "执行"], data.media.map((row) => [row.name, row.kind === "bus" ? "公交" : "地铁", row.units,
        row.kind === "bus" && me.role !== "viewer" ? el("button", { type: "button", class: "portal-button secondary", text: "带入排班", on: { click: () => {
          const form = $("configForm");
          form.route.value = row.query || row.name.split("·")[0].trim();
          form.startDate.value = data.window.start;
          form.duration.value = Math.round((Date.parse(data.window.end) - Date.parse(data.window.start)) / 86400000) + 1;
          form.minUnits.value = row.units;
          form.format.value = row.format;
          form.fleetSource.value = "csv";
          form.scrollIntoView({ behavior: "smooth" });
          tell("已带入选中线路和档期，请填写合同约束并录入真实车级台账，再保存。");
        } } }) : "核对点位、面积与夜间施工"])),
      el("p", { text: bus.length > 1 ? "按单条公交线路带入排班。锁位、刊例及车辆安排由团队确认。" : "请确认锁位和施工条件后排班。" }),
      el("ul", {}, ...data.pending.map((item) => el("li", { text: item }))));
  }

  async function selectProject(id) {
    projectId = id;
    history.replaceState(null, "", "#p=" + id);
    $("teamProjectLink").href = "/#p=" + encodeURIComponent(id);
    const data = await api(path("/dispatch"));
    types = data.types; defaults = data.defaults; state = data.state;
    $("changeForm").type.replaceChildren(...Object.entries(types).map(([v, t]) => el("option", { value: v, text: t })));
    fillConfig(state?.config || defaults);
    $("previewView").replaceChildren();
    renderPlan();
    if (state) await changes();
    await Promise.all([clients(), handoff()]);
  }
  async function start() {
    try { me = await api("/api/session"); } catch { me = null; }
    if (!me) { $("loginPanel").hidden = false; return; }
    if (me.role === "client") { location.href = "/client"; return; }
    $("loginPanel").hidden = true; $("appPanel").hidden = false;
    $("whoami").textContent = me.name;
    const projects = (await api("/api/projects")).filter((p) => !p.archived);
    if (!projects.length) return tell("请先在工作台新建项目。");
    $("projectSelect").replaceChildren(...projects.map((p) => el("option", { value: p.id, text: p.name })));
    const h = new URLSearchParams(location.hash.slice(1)).get("p");
    const id = projects.some((p) => p.id === h) ? h : projects[0].id;
    $("projectSelect").value = id;
    await selectProject(id);
  }
  $("loginForm").addEventListener("submit", run(async (event) => { event.preventDefault(); await api("/api/session", "POST", Object.fromEntries(new FormData(event.target))); await start(); }));
  $("projectSelect").addEventListener("change", run((e) => selectProject(e.target.value)));
  $("configForm").addEventListener("submit", run(saveConfig));
  $("changeForm").addEventListener("submit", run(createChange));
  $("mapForm").addEventListener("submit", run(async (event) => {
    event.preventDefault();
    const form = event.target;
    const file = form.elements.geojson.files[0];
    if (file && file.size > 1450000) throw new Error("地图坐标文件不能超过 1.45 MB。");
    const geojson = file ? JSON.parse(await file.text()) : undefined;
    await api(path("/map-evidence"), "PUT", { shareUrl: form.elements.shareUrl.value.trim(), metroShareUrl: form.elements.metroShareUrl.value.trim(), geojson });
    form.elements.geojson.value = "";
    await handoff();
    tell("地图资料已保存，新生成的提案会关联匹配的路线与点位。");
  }));
  document.querySelector(".ss-report-nav").addEventListener("click", (event) => {
    const link = event.target.closest("a");
    if (link) { event.preventDefault(); document.getElementById(link.hash.slice(1))?.scrollIntoView({ behavior: "smooth" }); }
  });
  $("grantForm").addEventListener("submit", run(async (event) => { event.preventDefault(); await api(path("/clients"), "POST", { name: event.target.name.value }); event.target.reset(); await clients(); tell("已授权。"); }));
  start().catch((error) => tell(error.message, "error"));
})();
