(() => {
  "use strict";
  const $ = (id) => document.getElementById(id);
  const form = $("briefForm");
  let me = null, catalog = null, projects = [], projectId = null, current = null, parentId = null, inventory = [], lastPlan = null, timer = null, checking = 0;

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
  const wan = (yuan) => (Math.round(yuan / 100) / 100).toLocaleString("zh-CN", { maximumFractionDigits: 2 }) + " 万";
  async function api(url, method = "GET", data) {
    const response = await fetch(url, { method, headers: { "Content-Type": "application/json", "X-Flair-Client": "1" }, ...(data === undefined ? {} : { body: JSON.stringify(data) }) });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw Object.assign(new Error(body.error || "请求失败。"), { status: response.status, body });
    return body;
  }
  const storeKey = () => "flair-client:" + me.name + ":" + projectId;
  const save = (brief) => { try { localStorage.setItem(storeKey(), JSON.stringify({ brief, parentId, autoMedia: $("autoMedia").checked, title: $("draftTitle").value })); } catch {} };
  const load = () => { try { return JSON.parse(localStorage.getItem(storeKey()) || "null"); } catch { return null; } };
  const setHash = () => { window.history.replaceState(null, "", "#p=" + projectId + (current ? "&d=" + current.id : "")); };
  const hash = () => Object.fromEntries(new URLSearchParams(location.hash.slice(1)));
  const selection = () => ({ brief: brief(), autoMedia: $("autoMedia").checked, live: $("autoMedia").checked });
  function view(name) {
    $("intakeView").hidden = name !== "Brief";
    $("resultCard").hidden = name !== "Proposal" || !current;
    $("historyCard").hidden = name !== "History";
    $("goProposal").disabled = !current;
    for (const step of ["Brief", "Proposal", "History"]) $("go" + step).setAttribute("aria-pressed", String(step === name));
  }

  /* ---------- 表单 ---------- */
  function options(select, map) {
    select.replaceChildren(...Object.entries(map).map(([value, label]) => el("option", { value, text: label })));
  }
  function buildForm() {
    const o = catalog.options;
    options(form.industry, o.industry);
    options(form.businessGoal, o.businessGoal);
    options(form.busFormat, o.busFormat);
    form.duration.replaceChildren(...o.duration.map((d) => el("option", { value: d, text: d + " 天" })));
    $("campaignGoalBox").replaceChildren(...Object.entries(o.campaignGoal).map(([v, label]) => el("label", { class: "inline-check" }, el("input", { type: "radio", name: "campaignGoal", value: v }), " " + label)));
    $("audienceBox").replaceChildren(...Object.entries(o.audience).map(([v, label]) => el("label", { class: "inline-check" }, el("input", { type: "checkbox", name: "audiences", value: v }), " " + label)));
    $("kpiBox").replaceChildren(...Object.entries(o.kpi).map(([v, label]) => el("label", { class: "inline-check" }, el("input", { type: "checkbox", name: "kpis", value: v }), " " + label)));
    $("zoneBox").replaceChildren(...catalog.zones.map((z) => el("div", { class: "ss-zone" },
      el("label", { class: "inline-check" }, el("input", { type: "checkbox", name: "zones", value: z.id }), " " + z.name),
      el("label", { class: "inline-check ss-small" }, el("input", { type: "checkbox", name: "priority", value: z.id }), " 优先"))));
  }
  const checked = (name) => [...form.querySelectorAll("input[name=" + name + "]:checked")].map((i) => i.value);
  function readForm() {
    const priority = new Set(checked("priority"));
    return {
      industry: form.industry.value, industryNote: form.industryNote.value, brandType: form.brandType.value,
      businessGoal: form.businessGoal.value, businessNote: form.businessNote.value,
      campaignGoal: form.querySelector("input[name=campaignGoal]:checked")?.value, audiences: checked("audiences"),
      zones: checked("zones").map((id) => ({ id, priority: priority.has(id) })), startDate: form.startDate.value, duration: Number(form.duration.value),
      budgetWan: Number(form.budgetWan.value), media: checked("media"), busFormat: form.busFormat.value,
      mode: form.querySelector("input[name=mode]:checked")?.value || "auto", kpis: checked("kpis"), kpiNote: form.kpiNote.value,
      mustKeep: [...$("resourceBox").querySelectorAll("input[data-keep]:checked")].map((box) => ({ id: box.value, units: Number(box.closest(".ss-res").querySelector("input[type=number]")?.value || 1) })),
    };
  }
  let pendingKeep = null;
  function writeForm(b) {
    form.industry.value = b.industry; form.industryNote.value = b.industryNote || ""; form.brandType.value = b.brandType || "";
    form.businessGoal.value = b.businessGoal; form.businessNote.value = b.businessNote || "";
    for (const i of form.querySelectorAll("input[name=campaignGoal]")) i.checked = i.value === b.campaignGoal;
    for (const i of form.querySelectorAll("input[name=audiences]")) i.checked = b.audiences.includes(i.value);
    const zones = new Map(b.zones.map((z) => [z.id, z]));
    for (const i of form.querySelectorAll("input[name=zones]")) i.checked = zones.has(i.value);
    for (const i of form.querySelectorAll("input[name=priority]")) i.checked = Boolean(zones.get(i.value)?.priority);
    form.startDate.value = b.startDate; form.duration.value = String(b.duration); form.budgetWan.value = b.budgetWan; $("budgetRange").value = b.budgetWan;
    for (const i of form.querySelectorAll("input[name=media]")) i.checked = b.media.includes(i.value);
    form.busFormat.value = b.busFormat;
    for (const i of form.querySelectorAll("input[name=mode]")) i.checked = i.value === (b.mode || "auto");
    for (const i of form.querySelectorAll("input[name=kpis]")) i.checked = b.kpis.includes(i.value);
    form.kpiNote.value = b.kpiNote || "";
    pendingKeep = b.mustKeep || [];
    renderResources();
  }

  function renderResources() {
    const keep = new Map((pendingKeep ?? readKeep()).map((k) => [k.id, k.units]));
    pendingKeep = null;
    const media = new Set(checked("media"));
    const q = $("resourceFilter").value.trim();
    const only = $("onlyMine").checked;
    const rows = inventory.filter((r) => (keep.has(r.id) || media.has(r.kind)) && (!only || keep.has(r.id))
      && (!q || (r.name + r.zones.join("") + r.level + r.format).includes(q)));
    $("resourceBox").replaceChildren(...rows.slice(0, 120).map((r) => el("div", { class: "ss-res" + (r.free ? "" : " ss-full") },
      el("label", { class: "inline-check" }, el("input", { type: "checkbox", value: r.id, "data-keep": "1", checked: keep.has(r.id) }), " " + r.name),
      el("small", { text: (r.kind === "bus" ? "公交 " : "地铁 ") + r.level + " · " + r.format + " · " + r.zones.join("、") }),
      el("small", { class: r.free ? "" : "ss-warn", text: "档期可售 " + r.free + "/" + r.available }),
      r.kind === "bus" ? el("input", { type: "number", min: 1, max: 20, value: keep.get(r.id) || 1, "aria-label": r.name + " 数量" }) : null)),
    ...(rows.length > 120 ? [el("p", { class: "ss-muted", text: "仅显示前 120 条，请输入筛选条件。" })] : []));
    // 已指定但被筛掉的资源保持选中状态
    hiddenKeep = [...keep].filter(([id]) => !rows.slice(0, 120).some((r) => r.id === id)).map(([id, units]) => ({ id, units }));
  }
  let hiddenKeep = [];
  function readKeep() {
    const shown = [...$("resourceBox").querySelectorAll("input[data-keep]")].map((box) => ({ id: box.value, on: box.checked, units: Number(box.closest(".ss-res").querySelector("input[type=number]")?.value || 1) }));
    const visible = new Set(shown.map((s) => s.id));
    return [...shown.filter((s) => s.on).map(({ id, units }) => ({ id, units })), ...hiddenKeep.filter((h) => !visible.has(h.id))];
  }
  const brief = () => ({ ...readForm(), mustKeep: readKeep() });

  /* ---------- 实时检查 ---------- */
  function schedule() { clearTimeout(timer); timer = setTimeout(check, 350); }
  async function check() {
    const b = brief();
    save(b);
    const ticket = ++checking;
    try {
      const { plan, inventory: inv } = await api("/api/client/projects/" + projectId + "/check", "POST", { ...selection(), brief: b });
      if (ticket !== checking) return;
      const dateChanged = !lastPlan || lastPlan.window?.start !== plan.window?.start || lastPlan.brief?.duration !== plan.brief?.duration ||
        inv.map((r) => r.id).join() !== inventory.map((r) => r.id).join();
      inventory = inv;
      lastPlan = plan;
      if (dateChanged) renderResources();
      renderCheck(plan);
    } catch (error) { tell(error.message, "error"); }
  }
  function renderCheck(plan) {
    const box = $("checkSummary");
    $("conflictBox").replaceChildren();
    $("warningBox").replaceChildren();
    if (plan.status === "invalid") {
      box.textContent = "请补充或修正：" + plan.errors.join("、");
      $("generate").disabled = true;
      return;
    }
    box.replaceChildren(
      el("p", {}, el("strong", { text: plan.status === "conflict" ? "存在冲突，需要您调整" : plan.status === "empty" ? "暂无可用资源" : "可以生成方案" })),
      el("p", { text: plan.window.start + " 至 " + plan.window.end + " · 公交 " + plan.counts.bus + " 辆 · 地铁 " + plan.counts.metro + " 处" }),
      el("p", { text: "费用区间 " + wan(plan.totals.total.min) + " – " + wan(plan.totals.total.max) + "（上限 " + wan(plan.totals.cap) + "）" }),
      el("p", { text: "目标圈覆盖 " + plan.coverage.percent + "%（估算）" }));
    $("generate").disabled = plan.status !== "ready";
    for (const c of plan.conflicts) {
      $("conflictBox").append(el("div", { class: "ss-conflict", role: "alert" }, el("p", { text: c.message }),
        el("div", { class: "portal-actions" }, ...c.options.map((o) => el("button", { type: "button", class: "portal-button secondary", text: o.label, on: { click: () => applyPatch(o.patch) } })))));
    }
    if (plan.warnings.length) $("warningBox").append(el("ul", { class: "ss-warnings" }, ...plan.warnings.map((w) => el("li", { text: w }))));
  }
  function applyPatch(patch) {
    const b = brief();
    for (const key of ["startDate", "budgetWan", "media", "busFormat", "mode"]) if (patch[key] !== undefined) b[key] = patch[key];
    if (patch.removeMustKeep) b.mustKeep = b.mustKeep.filter((r) => r.id !== patch.removeMustKeep);
    if (patch.mustKeep) b.mustKeep = b.mustKeep.map((r) => r.id === patch.mustKeep.id ? patch.mustKeep : r);
    if (patch.replaceMustKeep) b.mustKeep = b.mustKeep.map((r) => r.id === patch.replaceMustKeep.from ? { id: patch.replaceMustKeep.to, units: patch.replaceMustKeep.units } : r);
    if (patch.media || patch.mode || patch.busFormat) $("autoMedia").checked = false;
    hiddenKeep = [];
    writeForm(b);
    tell("已按您的选择调整条件，正在重新计算。");
    check();
  }

  /* ---------- 草稿 ---------- */
  async function generate() {
    $("generate").disabled = true;
    tell("正在生成方案…");
    try {
      const draft = await api("/api/client/projects/" + projectId + "/drafts", "POST", { ...selection(), parentId, title: $("draftTitle").value });
      show(draft);
      parentId = draft.id;
      save(brief());
      tell("已生成并保存第 " + draft.seq + " 版草稿。" + (draft.narrative?.note ? " " + draft.narrative.note : ""));
      await loadHistory();
    } catch (error) {
      if (error.body?.conflicts && lastPlan?.totals) renderCheck({ ...lastPlan, status: "conflict", conflicts: error.body.conflicts });
      $("detailBrief").open = true;
      tell(error.message, "error");
    } finally { $("generate").disabled = lastPlan?.status !== "ready"; }
  }
  function show(draft) {
    current = draft;
    setHash();
    view("Proposal");
    $("resultTitle").textContent = draft.title + " · 第 " + draft.seq + " 版";
    $("proposal").innerHTML = draft.html; // 服务端已转义
    window.FlairMap.mount($("proposal").querySelector("[data-proposal-map]"), draft.plan.map);
    $("proposal").querySelector(".ss-report-nav").addEventListener("click", (event) => {
      const target = event.target.closest("a");
      if (target) { event.preventDefault(); document.getElementById(target.hash.slice(1))?.scrollIntoView({ behavior: "smooth" }); }
    });
    const base = "/api/client/drafts/" + draft.id + "/export?format=";
    $("exportHtml").href = base + "html"; $("exportCsv").href = base + "csv"; $("exportJson").href = base + "json";
    $("submitDraft").disabled = draft.status === "submitted";
    $("submitDraft").textContent = draft.status === "submitted" ? "已提交团队审核" : "提交团队审核";
    $("shareLink").textContent = draft.review ? "团队审核：" + (draft.review.decision === "accepted" ? "已采纳" : "退回修改") + (draft.review.note ? " · " + draft.review.note : "") : "";
    $("parentNote").textContent = "下次生成将记为第 " + draft.seq + " 版的修改，并显示差异。";
  }
  async function loadHistory() {
    const rows = await api("/api/client/projects/" + projectId + "/drafts");
    const label = { draft: "草稿", shared: "已分享（固定）", submitted: "已提交审核" };
    $("historyBox").replaceChildren(...(rows.length ? rows.map((r) => el("button", { type: "button", class: "ss-history" + (current?.id === r.id ? " ss-active" : ""), on: { click: () => open(r.id) } },
      el("strong", { text: "第 " + r.seq + " 版 · " + label[r.status] + (r.review ? " · " + (r.review.decision === "accepted" ? "团队已采纳" : "团队退回") : "") }),
      el("small", { text: r.window.start + " 起 · " + r.budgetWan + " 万 · 公交 " + r.counts.bus + " / 地铁 " + r.counts.metro + " · 覆盖 " + r.coverage + "%" }),
      el("small", { text: new Date(r.created).toLocaleString("zh-CN") + (r.parentId ? " · 修改自上一版" : "") }))) : [el("p", { text: "暂无草稿。" })]));
  }
  async function open(id) {
    try { show(await api("/api/client/drafts/" + id)); await loadHistory(); } catch (error) { tell(error.message, "error"); }
  }

  /* ---------- 项目与登录 ---------- */
  async function selectProject(id, draftId) {
    clearTimeout(timer); checking++;
    projectId = id;
    $("projectSelect").value = id;
    current = null; parentId = null; lastPlan = null; hiddenKeep = [];
    view("Brief");
    const saved = load();
    const project = projects.find((p) => p.id === id);
    const base = saved?.brief || project.defaults || catalog.defaults;
    parentId = saved?.parentId || null;
    $("autoMedia").checked = saved?.autoMedia ?? true;
    $("draftTitle").value = saved?.title || "";
    inventory = [];
    writeForm(base);
    await loadHistory();
    if (draftId) await open(draftId).catch(() => {});
    else if (parentId) await open(parentId).catch(() => {});
    setHash();
    check();
  }
  async function start() {
    try { me = await api("/api/session"); } catch { me = null; }
    if (!me) { $("loginPanel").hidden = false; $("appPanel").hidden = true; return; }
    if (me.role !== "client") { tell("当前为团队账号。客户自助入口仅供客户账号使用，团队请回到工作台。"); $("loginPanel").hidden = false; return; }
    $("loginPanel").hidden = true; $("appPanel").hidden = false;
    $("whoami").textContent = me.name;
    catalog = await api("/api/client/catalog");
    $("aiState").textContent = catalog.ai ? "AI 辅助已启用" : "AI 未配置 · 使用规则与模板";
    buildForm();
    projects = await api("/api/client/projects");
    if (!projects.length) { tell("暂无授权项目，请联系提案团队开通。"); return; }
    $("projectSelect").replaceChildren(...projects.map((p) => el("option", { value: p.id, text: p.name })));
    const h = hash();
    await selectProject(projects.some((p) => p.id === h.p) ? h.p : projects[0].id, h.d);
  }

  $("loginForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    const data = Object.fromEntries(new FormData(event.target));
    try { await api("/api/session", "POST", data); tell(""); await start(); } catch (error) { tell(error.message, "error"); }
  });
  $("logout").addEventListener("click", async () => { await api("/api/session", "DELETE").catch(() => {}); location.hash = ""; location.reload(); });
  $("projectSelect").addEventListener("change", (e) => selectProject(e.target.value).catch((error) => tell(error.message, "error")));
  for (const step of ["Brief", "Proposal", "History"]) $("go" + step).addEventListener("click", () => view(step));
  form.addEventListener("input", (event) => {
    if (event.target.name === "budgetWan") $("budgetRange").value = form.budgetWan.value;
    if (["media", "busFormat", "mode"].includes(event.target.name) || event.target.dataset.keep) $("autoMedia").checked = false;
    if (event.target.name === "media") renderResources();
    schedule();
  });
  form.addEventListener("change", schedule);
  $("budgetRange").addEventListener("input", () => { form.budgetWan.value = $("budgetRange").value; schedule(); });
  $("resourceFilter").addEventListener("input", () => { hiddenKeep = readKeep(); renderResources(); });
  $("onlyMine").addEventListener("change", () => { hiddenKeep = readKeep(); renderResources(); });
  $("resetForm").addEventListener("click", () => { hiddenKeep = []; writeForm({ ...catalog.defaults }); check(); });
  $("generate").addEventListener("click", generate);
  $("draftTitle").addEventListener("input", () => save(brief()));
  $("printDraft").addEventListener("click", () => window.print());
  $("reviseDraft").addEventListener("click", () => {
    if (!current) return;
    parentId = current.id; hiddenKeep = [];
    view("Brief"); $("detailBrief").open = true;
    writeForm(current.brief);
    tell("已载入第 " + current.seq + " 版的条件。修改后点「生成方案」会生成新草稿，原版本保留。");
    form.scrollIntoView({ behavior: "smooth" });
    check();
  });
  $("shareDraft").addEventListener("click", async () => {
    try {
      const share = await api("/api/client/drafts/" + current.id + "/share", "POST", { days: Number($("shareDays").value) });
      const url = location.origin + share.path;
      $("shareLink").replaceChildren("只读链接（固定为第 " + current.seq + " 版，" + share.days + " 天有效）：", el("a", { href: url, target: "_blank", rel: "noopener noreferrer", text: url }));
      await loadHistory();
    } catch (error) { tell(error.message, "error"); }
  });
  $("submitDraft").addEventListener("click", async () => {
    try { await api("/api/client/drafts/" + current.id + "/submit", "POST", {}); tell("已提交团队审核。正式报价、锁位与执行确认由团队完成。"); await open(current.id); } catch (error) { tell(error.message, "error"); }
  });
  async function extractAndContinue(generateNow) {
    const text = $("quickText").value.trim();
    if (!text) return tell("请先写一段需求。", "error");
    if (!$("quickAnon").checked) return tell("请先确认内容已去除真实客户名、联系人和成交价。", "error");
    $("quickExtract").disabled = $("quickGenerate").disabled = true;
    const selectedProject = projectId;
    try {
      const result = await api("/api/client/ai/extract", "POST", { text, anonymized: true });
      if (selectedProject !== projectId) return;
      const b = { ...brief(), ...result.prefill };
      hiddenKeep = [];
      writeForm(b);
      for (const card of form.querySelectorAll("[data-filled]")) card.removeAttribute("data-filled");
      $("quickNote").textContent = result.note + (result.missing.length ? " 待您补充：" + result.missing.map((m) => m.label).join("、") + "（已保留默认值）。" : " 所有必填项均已预填，请逐项确认。");
      if (generateNow) { $("autoMedia").checked = true; await generate(); }
      else { $("detailBrief").open = true; check(); }
    } catch (error) { tell(error.message, "error"); } finally { $("quickExtract").disabled = $("quickGenerate").disabled = false; }
  }
  $("quickExtract").addEventListener("click", () => extractAndContinue(false));
  $("quickGenerate").addEventListener("click", () => extractAndContinue(true));
  start().catch((error) => tell(error.message, "error"));
})();
