"use strict";

const $ = (id) => document.getElementById(id);
const form = $("brief");
const field = (name) => form.elements.namedItem(name);
const esc = (value) => String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const compactNumber = new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 2 });
const shanghaiTime = new Intl.DateTimeFormat("zh-CN", {
  timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit",
  hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
});
const checkedAt = (value) => {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "时间待核" : shanghaiTime.format(date) + "（北京时间）";
};
const wan = (yuan) => compactNumber.format(yuan / 10000) + " 万";
const moneyRange = (range) => wan(range.min) + " – " + wan(range.max);
const pct = (n) => n + "%";
const zoneHits = (coverage) => coverage.zones.filter((zone) => zone.covered).length + " / " + coverage.zones.length;
const kind = (mode) => ({ bus: "公交车身", metro: "地铁出入口" })[mode] || mode;
const choices = (name) => Array.from(form.querySelectorAll('input[name="' + name + '"]'));
const list = (rows) => rows.length ? '<ul class="detail-list">' + rows.map((text) => "<li>" + esc(text) + "</li>").join("") + "</ul>" : '<p class="faint">无</p>';
const richTable = (head, rows, className = "") => '<div class="scroll-table ' + className + '" tabindex="0"><table><thead><tr>' + head.map((label) => '<th scope="col">' + esc(label) + "</th>").join("") + "</tr></thead><tbody>" + rows.map((row) => "<tr>" + row.map((cell) => "<td>" + cell + "</td>").join("") + "</tr>").join("") + "</tbody></table></div>";
const table = (head, rows) => richTable(head, rows.map((row) => row.map(esc)));

let catalog;
let requestVersion = 0;
let pendingPlan;
let planRequest;
let current;
let currentCriteria;
let previousBrief;
let liveResult;
let activeResult;
let activeBrief;
let hasPlan = false;
let extraVersion = 0;
let started = false;
let step;
let mountedMap;
const steps = Object.fromEntries(Array.from(document.querySelectorAll(".workflow-nav [data-step]"), (link) => [link.dataset.step, link.pathname]));
const draftKey = "flair-roadshow-draft";

async function api(path = "", data, signal) {
  const response = await fetch("/api/roadshow" + path, data === undefined ? undefined : {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-flair-client": "1" },
    body: JSON.stringify(data),
    signal,
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || "请求未完成。");
  return result;
}

function saveDraft() {
  try { sessionStorage.setItem(draftKey, JSON.stringify({ brief: readBrief(), text: $("brief-text").value, started })); } catch {}
}

function showStep(next, push = false) {
  if (push && location.pathname !== steps[next]) history.pushState(null, "", steps[next]);
  if (next !== step) window.scrollTo(0, 0);
  step = next;
  for (const page of document.querySelectorAll("[data-page]")) page.hidden = page.dataset.page !== step;
  for (const link of document.querySelectorAll(".workflow-nav [data-step]")) {
    if (link.dataset.step === step) link.setAttribute("aria-current", "page");
    else link.removeAttribute("aria-current");
  }
  syncStep();
}

function syncStep() {
  $("result-notice").hidden = step === "brief" || hasPlan;
  $("report").hidden = !hasPlan || step === "brief";
  $("result-status").textContent = $("plan-status").textContent || "请先填写需求并生成提案。";
  if (!$("report").hidden && step === "media" && activeResult.plan.map && mountedMap !== activeResult.plan.map) {
    mountedMap = activeResult.plan.map;
    window.FlairMap.mount($("actual-coverage-map"), mountedMap, { basemap: true });
  }
}

function optionHTML(value, label) {
  return '<option value="' + esc(value) + '">' + esc(label) + "</option>";
}

function buildForm() {
  for (const prop of ["industry", "businessGoal", "campaignGoal", "busFormat"]) {
    field(prop).innerHTML = Object.entries(catalog.options[prop]).map(([key, label]) => optionHTML(key, label)).join("");
  }
  field("duration").innerHTML = catalog.options.duration.map((n) => optionHTML(n, n + " 天")).join("");
  for (const [key, name] of [["audience", "audiences"], ["kpi", "kpis"]]) {
    $(name).innerHTML = Object.entries(catalog.options[key]).map(([value, label]) =>
      '<label><input type="checkbox" name="' + name + '" value="' + esc(value) + '">' + esc(label) + "</label>").join("");
  }
  $("zones").innerHTML = catalog.zones.map(({ id, name }) =>
    '<div class="zone-line"><label><input type="checkbox" name="zone" value="' + esc(id) + '">' + esc(name) +
    '</label><label><input type="checkbox" name="priority" value="' + esc(id) + '" aria-label="' + esc(name) + '优先">优先</label></div>').join("");
}

function readBrief() {
  const keys = ["industry", "brandType", "businessGoal", "businessNote", "campaignGoal", "startDate", "busFormat", "kpiNote"];
  return {
    ...activeBrief,
    ...Object.fromEntries(keys.map((key) => [key, field(key).value.trim()])),
    audiences: choices("audiences").filter((e) => e.checked).map((e) => e.value),
    zones: choices("zone").filter((e) => e.checked).map((e) => ({
      id: e.value,
      priority: e.closest(".zone-line").querySelector('[name="priority"]').checked,
    })),
    duration: Number(field("duration").value),
    budgetWan: field("budgetWan").value ? Number(field("budgetWan").value) : null,
    media: choices("media").filter((e) => e.checked).map((e) => e.value),
    kpis: choices("kpis").filter((e) => e.checked).map((e) => e.value),
  };
}

function writeBrief(brief) {
  activeBrief = { ...brief };
  for (const name of ["industry", "brandType", "businessGoal", "businessNote", "campaignGoal", "startDate", "busFormat", "kpiNote", "duration", "budgetWan"]) {
    field(name).value = brief[name] ?? "";
  }
  for (const name of ["audiences", "media", "kpis"]) {
    for (const input of choices(name)) input.checked = brief[name].includes(input.value);
  }
  const zones = new Map(brief.zones.map((zone) => [zone.id, zone.priority]));
  for (const zone of choices("zone")) {
    zone.checked = zones.has(zone.value);
    const priority = zone.closest(".zone-line").querySelector('[name="priority"]');
    priority.checked = Boolean(zones.get(zone.value));
  }
  formState(readBrief());
}

function formState(brief) {
  const count = brief.zones.length;
  $("zone-summary").textContent = count ? "已选 " + count + " 个商圈 · 调整范围与优先级" : "选择目标商圈与优先级";
  field("busFormat").disabled = !brief.media.includes("bus");
  for (const btn of form.querySelectorAll("[data-budget]")) {
    btn.setAttribute("aria-pressed", Number(btn.dataset.budget) === brief.budgetWan);
  }
}

function renderMap(coverage) {
  const zones = coverage.zones;
  const shown = zones.slice(0, 5);
  const covered = zones.filter((zone) => zone.covered).length;
  const map = $("coverage-map");
  const points = shown.map((zone, index) => ({ x: (index + 0.5) * 1000 / shown.length, y: [29, 17, 35, 29, 19][index] }));
  const path = points.map(({ x, y }, index) => {
    if (!index) return "M" + x + " " + y;
    const before = points[index - 1];
    const mid = (x + before.x) / 2;
    return "C" + mid + " " + before.y + " " + mid + " " + y + " " + x + " " + y;
  }).join(" ");
  $("map-count").textContent = covered + " / " + zones.length + " 命中";
  map.style.setProperty("--stops", shown.length);
  map.innerHTML = '<svg viewBox="0 0 1000 75" preserveAspectRatio="none" aria-hidden="true"><path d="' + path +
    '" fill="none" stroke="#c78f63" stroke-width="2" vector-effect="non-scaling-stroke"/></svg>' + shown.map((zone, index) =>
    '<div class="map-stop' + (zone.covered ? " covered" : "") + (zone.priority ? " priority" : "") +
    '" style="--stop-top:' + (points[index].y - 8) + 'px">' +
    '<i aria-hidden="true"></i><span>' + esc(zone.name) + '</span><small>' +
    (zone.covered ? "已命中" : "未命中") + (zone.priority ? " · 优先" : "") + "</small></div>").join("");
  if (zones.length > shown.length) $("map-count").textContent += "（显示前 " + shown.length + " 个）";
}

function renderScore(plan) {
  const { totals: t, counts, coverage } = plan;
  const scores = [
    ["预算上限", wan(t.budget)], [t.pendingProduction ? "已计报价 · " + t.pendingProduction + " 处制作费待核" : "区间报价", moneyRange(t.total)],
    ["规划命中商圈", zoneHits(coverage)],
    ["资源数量", counts.bus + " 辆 / " + counts.metro + " 处"],
  ];
  $("scoreline").innerHTML = scores.map(([label, value]) => '<div class="score"><small>' + esc(label) + "</small><strong>" + esc(value) + "</strong></div>").join("");
}

function renderAssumption(plan) {
  $("assumption-context").textContent = plan.window.start + " 至 " + plan.window.end + " · " + plan.brief.duration + " 天 · " +
    (plan.synthetic ? "合成演示" : "红豆核验候选估算");
  $("assumption-rows").innerHTML = plan.responses.map(({ label, need, answer }) =>
    '<section class="assumption-row"><h3>' + esc(label) + '</h3><div><p><strong>' + esc(need) + "</strong></p><p>" +
    esc(answer) + "</p></div></section>").join("");
}

function renderDimensions({ plan, strategy, narrative, elapsedMs, queryMs }) {
  const { counts, coverage, schedule, monitoring, totals } = plan;
  const hitNames = coverage.zones.filter((z) => z.covered).map((z) => z.name).join("、");
  const s = strategy || {};
  const adjustment = narrative?.tradeoffs?.[0];
  const rows = [
    ["策略洞察", s.insight || plan.responses[1].answer, plan.responses[1].need + " · " + plan.responses[2].need],
    ["媒体策略与组合", s.combination || plan.responses[5].answer, "公交 " + counts.bus + " 辆 · 地铁 " + counts.metro + " 处。 " + (s.activation || "")],
    ["点位质量", hitNames ? "已命中 " + hitNames + "。" : "当前组合无目标商圈命中。", plan.synthetic
      ? "线路、等级及档期余量来自合成台账，逐条展示商圈命中与选择理由。"
      : "档期余量来自红豆查询。点位与目标商圈匹配基于候选线索，实际动线及门店距离由团队复核。"],
    ["预算分配与报价", "发布 " + moneyRange(totals.media) + "；制作 " + moneyRange(totals.production) + "；已计费用合计 " + moneyRange(totals.total) + "。",
      "预算 " + wan(totals.budget) + "，对比已计报价上限余 " + wan(totals.budget - totals.total.max) + "。" +
      "预留 " + Math.round(totals.buffer * 100) + "% 执行缓冲，独立执行及监测服务费待团队核价。" +
      (totals.pendingProduction ? " " + totals.pendingProduction + " 处制作费待核。" : "") + (adjustment ? " " + adjustment : "")],
    ["效果预估与衡量", "规划命中 " + zoneHits(coverage) + " 个目标商圈，实际人群触达待监测。 " + coverage.basis,
      monitoring.kpis.map((row) => row.name + "（" + (row.type === "估算" ? "估算" : "投放后验收") + "）").join(" · ")],
    ["执行可行性", plan.window.start + " 上刊，" + schedule.nights.length + " 晚施工，" + plan.window.end + " 刊期结束。", schedule.crew.source + "。变更可在执行调度预览替补与重排。"],
    ["服务与响应", (plan.synthetic ? "本轮服务端计算 " + compactNumber.format(elapsedMs) : "本轮红豆请求往返 " + compactNumber.format(queryMs)) +
      " ms。按业务条件重排后列出保留、新增、移除与替换。", "团队审核后锁位；客户在自助入口生成固定版本，执行团队通过变更单处理异常。"],
  ];
  const source = s.evidence;
  let evidenceLink = "";
  if (source?.url) {
    try {
      const url = new URL(source.url);
      if (url.origin === "https://www.wearemanner.com" && !url.username && !url.password) {
        evidenceLink = '<p class="faint">' + esc(source.note) + ' <a target="_blank" rel="noopener noreferrer" href="' +
          esc(url.href) + '">' + esc(source.title) + "</a></p>";
      }
    } catch {}
  }
  $("dimensions").innerHTML = rows.map(([name, result, evidence], index) => "<li><h3>" + esc(name) + "</h3><div><p>" + esc(result) +
    '</p><p class="faint">' + esc(evidence) + "</p>" + (index === 0 ? evidenceLink : "") + "</div></li>").join("");
}

function renderDelta(diff, synthetic) {
  const quick = $("assumption-delta");
  quick.hidden = !diff;
  if (!diff) {
    $("delta").innerHTML = '<p class="faint">' + (synthetic ? "调整预算、日期或媒体后，这里会对比修改前后的方案。" :
      "同一批红豆候选可用于重算预算调整；档期或候选范围变化时，请按新条件重查。") + "</p>";
    return;
  }
  const { impact: i } = diff;
  const budget = diff.fields.find((field) => field.label === "预算（万元）");
  quick.textContent = (budget ? `预算 ${budget.from} 万元 → ${budget.to} 万元。` : "") +
    "本轮资源保留 " + diff.kept.length + " · 新增 " + diff.added.length + " · 移除 " + diff.removed.length;
  const groups = [
    ["保留", diff.kept.map((r) => r.name + " × " + r.units)],
    ["数量调整", diff.changed.map((r) => r.name + " " + r.from + " → " + r.to)],
    ["替换", diff.replaced.map((r) => r.from + " → " + r.to + (r.zones.length ? "（" + r.zones.join("、") + "）" : ""))],
    ["新增", diff.added.map((r) => r.name + " × " + r.units)],
    ["移除", diff.removed.map((r) => r.name + " × " + r.units + (r.reason ? " · " + r.reason : ""))],
  ];
  const metrics = [
    ["公交 / 地铁", i.bus.from + " 辆 / " + i.metro.from + " 处 → " + i.bus.to + " 辆 / " + i.metro.to + " 处"],
    ["费用区间", wan(i.totalMin.from) + "–" + wan(i.totalMax.from) + " → " + wan(i.totalMin.to) + "–" + wan(i.totalMax.to)],
    ["施工夜次", i.nights.from + " → " + i.nights.to + " 晚"],
  ];
  if (budget) metrics.unshift(["预算上限", `${budget.from} 万元 → ${budget.to} 万元`]);
  if (i.window.from !== i.window.to) metrics.push(["投放档期", i.window.from + " → " + i.window.to]);
  $("delta").innerHTML = '<div class="delta-grid">' + metrics.map(([key, value]) => '<div><dl><dt class="faint">' + esc(key) + "</dt><dd>" +
    esc(value) + "</dd></dl></div>").join("") + '</div><div class="delta-lists">' + groups.map(([key, rows]) =>
    "<details><summary>" + esc(key) + " " + rows.length + "</summary>" + list(rows) + "</details>").join("") + "</div>";
}

function renderResources({ plan, budgetMix }) {
  const names = new Map(plan.coverage.zones.map((zone) => [zone.id, zone.name]));
  const itemRows = plan.items.map((item) => [
    '<div class="resource-name"><strong>' + esc(item.name) + "</strong><small>" + esc(item.level + " · " + item.format) +
      (item.estimateLevel && item.level !== item.estimateLevel ? " · 按 " + esc(item.estimateLevel) + " 级估算" : "") + "</small></div>",
    esc(kind(item.kind) + " · " + item.units + (item.kind === "bus" ? " 辆" : " 处")) + "<small>档期余量 " + esc(item.free) + "</small>",
    esc(item.hits.map((id) => names.get(id)).filter(Boolean).join("、") || "—") + "<small>" + esc(item.reason) + "</small>",
    "<strong>" + esc(moneyRange(item.cost.total)) + "</strong><br>发布 " + esc(moneyRange(item.cost.media)) +
      "<br>制作 " + esc(item.cost.production.pending ? "待核" : moneyRange(item.cost.production)),
  ]);
  const coverageRows = plan.coverage.zones.map((zone) => [zone.name, zone.priority ? "优先" : "一般", zone.covered ? "已命中" : "未命中", zone.by.join("、") || "—"]);
  $("resources").innerHTML = "<h2>线路、点位与报价</h2>" +
    '<p class="faint sum-line">' + (plan.synthetic ? "按合成库存、刊例与制作口径计算。实际锁位及报价由团队审核。" :
      "档期余量经红豆查询；价格、覆盖及施工为估算，实际锁位及报价由团队审核。") + "</p>" +
    richTable(["资源", "数量 / 可售", "命中与选点理由", "发布、制作及合计"], itemRows, "resources-table") +
    "<h3>预算分配（中位数）</h3>" + table(["媒体", "发布", "制作", "合计", "占比"], (budgetMix || []).map((r) =>
      [kind(r.mode), wan(r.media), wan(r.production), wan(r.total), pct(r.share)])) +
    "<h3>覆盖证据</h3>" + table(["商圈", "优先级", "命中", "命中依据"], coverageRows);
}

function renderExecution(plan) {
  const { schedule, monitoring } = plan;
  const timeline = schedule.phases.map(({ name, start, end, owner }) =>
    "<li><strong>" + esc(name) + "</strong><time>" + esc(start === end ? start : start + " ~ " + end) +
    "</time><small>" + esc(owner) + "</small></li>").join("");
  $("execution").innerHTML = "<h2>执行排期与验收</h2>" + '<h3 class="schedule-head">从审核到结案</h3><ol class="timeline">' + timeline + "</ol>" +
    "<h3>夜间施工批次</h3>" + table(["施工夜", "公交（辆）", "地铁（处）"], schedule.nights.map((r) => [r.day, r.bus, r.metro])) +
    '<p class="faint">' + esc(schedule.crew.source) + "。</p>" +
    '<p class="faint sum-line">遇到临时进保、换线或夜间停工，前往执行调度查看替补车、施工重排和责任分工。</p>' +
    '<h3 class="schedule-head">监测交付与验收</h3>' + table(["交付物", "截止", "负责方与验收口径"], monitoring.deliverables.map((r) => [r.name, r.due, r.owner + " · " + r.note])) +
    table(["指标", "类型", "来源"], monitoring.kpis.map((r) => [r.name, r.type === "估算" ? "估算" : "投放后回收", r.source])) +
    "<h3>待复核事项</h3>" + list(plan.pending);
}

function reportState(ready) {
  hasPlan = ready;
  $("download").disabled = !ready;
  $("print").disabled = !ready;
  $("query-inventory").disabled = !ready;
  $("query-ai").disabled = !ready || !catalog?.aiEnabled;
  $("show-demo").disabled = !ready;
  $("show-live").disabled = !ready || !liveResult;
}

function renderConflict(plan, brief) {
  const target = $("conflicts");
  const names = {
    brandType: "品牌名称", industry: "行业", businessGoal: "生意目标",
    campaignGoal: "活动主目标", audiences: "目标人群", zones: "目标商圈",
    media: "媒体组合", startDate: "上刊日", duration: "投放天数", budgetWan: "预算（30–2,000 万）", kpis: "效果衡量",
  };
  target.hidden = false;
  if (plan.status === "invalid") {
    target.textContent = "请检查 " + (plan.errors || []).map((name) => names[name] || name).join("、") + "。";
    return;
  }
  target.replaceChildren();
  if (!plan.conflicts?.length) {
    target.textContent = "当前条件无可用资源。请调整预算、档期或媒体范围。";
    return;
  }
  for (const conflict of plan.conflicts) {
    const group = document.createElement("div");
    const label = document.createElement("p");
    label.textContent = conflict.message;
    group.append(label);
    for (const option of conflict.options || []) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "button";
      button.textContent = option.label;
      button.addEventListener("click", () => {
        writeBrief({ ...brief, ...option.patch });
        queuePlan(0);
      });
      group.append(button);
    }
    target.append(group);
  }
}

function criteria(brief) {
  return JSON.stringify(brief);
}

function presentResult(result) {
  activeResult = result;
  const { plan, elapsedMs, queryMs } = result;
  const live = !plan.synthetic;
  $("source-row").hidden = false;
  $("show-demo").setAttribute("aria-pressed", String(!live));
  $("show-live").setAttribute("aria-pressed", String(live));
  $("source-note").textContent = live
    ? "红豆档期余量 · " + (plan.inventoryAsOf ? "查询于 " + checkedAt(plan.inventoryAsOf) + " · " : "") +
      (plan.inventoryPartial ? "查询范围有限 · " : "") + "报价、覆盖和施工为估算"
    : "库存、覆盖底图与刊例均为演示口径。";
  renderScore(plan);
  const showMap = Boolean(plan.map?.features?.length || plan.map?.shareUrl);
  $("map-title").textContent = showMap ? "投放路线与点位" : "目标商圈 · 覆盖示意";
  $("coverage-map").hidden = showMap;
  $("map-schematic-note").hidden = showMap;
  $("actual-coverage-map").hidden = !showMap;
  if (showMap) {
    $("map-count").textContent = `${plan.map.features.length} 个地图要素`;
  } else renderMap(plan.coverage);
  renderAssumption(plan);
  renderDimensions(result);
  renderDelta(result.diff, plan.synthetic);
  renderResources(result);
  renderExecution(plan);
  $("timing").textContent = live ? "红豆请求往返 " + compactNumber.format(queryMs) + " ms" : "本轮计算 " + compactNumber.format(elapsedMs) + " ms";
  reportState(true);
  syncStep();
}

function clearReport() {
  activeResult = null;
  $("assumption-context").textContent = "当前条件需调整，生成后会更新七项回应。";
  $("assumption-rows").replaceChildren();
  $("assumption-delta").hidden = true;
  $("scoreline").replaceChildren();
  reportState(false);
  syncStep();
  $("source-row").hidden = true;
  $("map-count").textContent = "";
  $("coverage-map").replaceChildren();
}

async function updatePlan(brief, version, signal) {
  const key = criteria(brief);
  const prior = current && currentCriteria !== key ? current.plan.brief : undefined;
  try {
    const result = await api("/plan", { brief, previous: prior }, signal);
    if (version !== requestVersion) return;
    if (result.plan.status !== "ready") {
      renderConflict(result.plan, brief);
      $("plan-status").textContent = "请调整当前条件";
      clearReport();
      return;
    }
    let inventory;
    let inventoryError;
    let queryMs;
    if (catalog.platformMap) {
      const start = performance.now();
      try {
        inventory = await api("/inventory", { brief, previous: prior || previousBrief }, signal);
        queryMs = Math.ceil(performance.now() - start);
      } catch (error) { inventoryError = error.message; }
    }
    if (version !== requestVersion) return;
    if (!prior && current) result.diff = current.diff;
    if (prior) previousBrief = prior;
    currentCriteria = key;
    current = result;
    $("conflicts").hidden = true;
    if (inventory) renderInventory(inventory, queryMs);
    if (inventoryError) $("inventory-result").textContent = inventoryError;
    presentResult(liveResult || result);
    $("plan-status").textContent = "已更新本轮提案";
  } catch (error) {
    if (version !== requestVersion) return;
    $("conflicts").hidden = true;
    $("plan-status").textContent = "更新失败 · " + error.message;
    clearReport();
  }
}

function queuePlan(delay = 180) {
  if (!catalog) return;
  clearTimeout(pendingPlan);
  planRequest?.abort();
  planRequest = new AbortController();
  const { signal } = planRequest;
  const version = ++requestVersion;
  extraVersion++;
  liveResult = null;
  const brief = readBrief();
  formState(brief);
  reportState(false);
  $("inventory-result").replaceChildren();
  $("ai-result").replaceChildren();
  $("plan-status").textContent = brief.budgetWan ? `正在按 ${brief.budgetWan} 万元预算生成提案…` : "正在检查投放条件…";
  saveDraft();
  syncStep();
  pendingPlan = setTimeout(() => updatePlan(brief, version, signal), delay);
}

function inventoryStatus(data) {
  const labels = {
    verified: "已核验档期余量", ready: "已查询", ok: "已查询", available: "已查询", partial: "部分返回", unavailable: "暂不可用",
    unconfigured: "尚未配置", not_configured: "尚未配置", disabled: "尚未配置", error: "查询失败", empty: "无匹配资源",
  };
  return labels[data.status] || data.status || "查询结果";
}

function renderInventory(data, queryMs) {
  const labels = ["红豆 · " + inventoryStatus(data)];
  if (data.asOf) labels.push("查询于 " + checkedAt(data.asOf));
  if (data.partial) labels.push("可见结果不完整");
  const candidates = data.candidates || [];
  const rows = candidates.map((r) => [kind(r.mode), r.name, r.area || "—", r.freeCount ?? "待核"]);
  const live = data.plan?.plan || data.plan;
  let html = "<p><strong>" + esc(labels.join(" · ")) + "</strong></p>";
  if (data.note) html += '<p class="faint">' + esc(data.note) + "</p>";
  if (rows.length) html += table(["媒体", "候选资源", "区域", "可售"], rows);
  if (live?.status === "ready") {
    liveResult = { ...(data.plan.plan ? data.plan : {}), plan: live, strategy: data.plan.strategy || current.strategy, queryMs };
    html += "<h3>按红豆候选重算的估算</h3><p>区间报价 " + esc(moneyRange(live.totals.total)) +
      " · 规划命中商圈 " + esc(zoneHits(live.coverage)) + " · 公交 " + esc(live.counts.bus) +
      ' 辆 / 地铁 ' + esc(live.counts.metro) + ' 处</p><button class="button" type="button" id="open-live">查看红豆完整方案</button>';
  } else {
    liveResult = null;
    if (rows.length) html += '<p class="faint">本次确认的候选不足以生成当前条件的完整方案。</p>';
  }
  $("inventory-result").innerHTML = html;
  $("show-live").disabled = !liveResult;
  $("open-live")?.addEventListener("click", () => {
    if (!hasPlan || !liveResult) return;
    presentResult(liveResult);
    $("source-row").scrollIntoView({ block: "start" });
    $("show-live").focus({ preventScroll: true });
  });
}

function renderAi(data, _elapsed, sourceLabel) {
  const source = data.source === "ai" ? "AI 解读" : "规则模板";
  $("ai-result").innerHTML = "<p><strong>" + esc(source + " · " + sourceLabel) + "</strong></p><p>" + esc(data.summary) + "</p>" +
    (data.tradeoffs?.length ? list(data.tradeoffs) : "") + (data.note ? '<p class="faint">' + esc(data.note) + "</p>" : "");
}

async function queryExtra(button, result, route, render) {
  if (!hasPlan) return;
  const version = extraVersion;
  const start = performance.now();
  const live = !activeResult.plan.synthetic && route === "/ai";
  button.disabled = true;
  result.textContent = "正在请求…";
  try {
    const data = await api(route, { brief: activeResult.plan.brief, previous: previousBrief, ...(live ? { source: "redbean" } : {}) });
    if (version === extraVersion) render(data, Math.ceil(performance.now() - start), live ? "红豆候选方案" : "合成演示方案");
  } catch (error) {
    if (version === extraVersion) result.textContent = error.message;
  } finally {
    if (version === extraVersion) button.disabled = false;
  }
}

function downloadProposal() {
  if (!hasPlan) return;
  const title = activeResult.plan.brief.brandType ? activeResult.plan.brief.brandType + " · 户外广告投放提案" : "户外广告投放提案";
  const report = $("report").cloneNode(true);
  report.className = "page";
  for (const page of report.querySelectorAll("[data-page]")) page.hidden = false;
  for (const el of report.querySelectorAll(".next-step, .form-actions, .supplemental .button, .source-choices")) el.remove();
  if (activeResult.plan.map) {
    const map = report.querySelector("#actual-coverage-map");
    map.replaceChildren();
    for (const [label, href] of [["打开大数据平台地图", activeResult.plan.map.shareUrl], ["打开地铁原图", activeResult.plan.map.metroShareUrl]]) {
      if (!href) continue;
      const link = document.createElement("a");
      link.href = href;
      link.textContent = label;
      map.append(link, document.createElement("br"));
    }
  }
  for (const disclosure of report.querySelectorAll("details")) disclosure.open = true;
  for (const result of report.querySelectorAll(".supplemental-result:empty")) result.closest("section").remove();
  if (!report.querySelector(".supplemental-result")) report.querySelector(".supplemental").remove();
  const sheet = document.querySelector('link[href="/assets/roadshow.css"]').sheet;
  const styles = Array.from(sheet.cssRules).map((rule) => rule.cssText).join("\n");
  const html = '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>' +
    esc(title) + "</title><style>" + styles + "</style></head><body><h1 class=\"page\">" + esc(title) + "</h1>" + report.outerHTML + "</body></html>";
  const url = URL.createObjectURL(new Blob([html], { type: "text/html;charset=utf-8" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = "flair-投放提案.html";
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function loadExample() {
  $("brief-text").value = catalog.briefText;
  $("extract-note").textContent = "";
  writeBrief(catalog.brief);
  if (started) queuePlan(0);
  else saveDraft();
}

function wireForm() {
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    started = true;
    queuePlan(0);
    showStep("assumptions", true);
  });
  form.addEventListener("input", ({ target }) => {
    if (!target.name) { saveDraft(); return; }
    if (target.name === "priority" && target.checked) target.closest(".zone-line").querySelector('[name="zone"]').checked = true;
    if (target.name === "zone" && !target.checked) target.closest(".zone-line").querySelector('[name="priority"]').checked = false;
    if (started) queuePlan();
    else { formState(readBrief()); saveDraft(); }
  });
  for (const button of form.querySelectorAll("[data-budget]")) {
    button.addEventListener("click", () => {
      field("budgetWan").value = button.dataset.budget;
      if (started) queuePlan();
      else { formState(readBrief()); saveDraft(); }
    });
  }
  $("load-example").addEventListener("click", loadExample);
  $("extract").addEventListener("click", async () => {
    const text = $("brief-text").value.trim();
    if (!text) { $("extract-note").textContent = "请先填写投放需求。"; return; }
    const version = requestVersion;
    const control = $("extract");
    control.disabled = true;
    $("extract-note").textContent = "正在提取…";
    try {
      const result = await api("/extract", { text });
      if (version !== requestVersion || text !== $("brief-text").value.trim()) {
        $("extract-note").textContent = "条件已更新，请重新提取。";
        return;
      }
      writeBrief({ ...readBrief(), ...result.brief });
      $("extract-note").textContent = result.missing?.length ? "请补充或确认 " + result.missing.join("、") + "。" : "已提取，请核对。";
      if (started) queuePlan();
      else saveDraft();
    } catch (error) {
      $("extract-note").textContent = error.message;
    } finally {
      control.disabled = false;
    }
  });
  $("download").addEventListener("click", downloadProposal);
  $("print").addEventListener("click", () => {
    if (!hasPlan) return;
    const collapsed = Array.from($("report").querySelectorAll("details:not([open])"));
    for (const el of collapsed) el.open = true;
    window.addEventListener("afterprint", () => { for (const el of collapsed) el.open = false; }, { once: true });
    window.print();
  });
  $("show-demo").addEventListener("click", () => { if (hasPlan) presentResult(current); });
  $("show-live").addEventListener("click", () => { if (liveResult) presentResult(liveResult); });
  $("query-inventory").addEventListener("click", () => queryExtra($("query-inventory"), $("inventory-result"), "/inventory", renderInventory));
  $("query-ai").addEventListener("click", () => queryExtra($("query-ai"), $("ai-result"), "/ai", renderAi));
}

function stepFromPath() {
  return Object.keys(steps).find((key) => steps[key] === location.pathname) || "brief";
}

document.addEventListener("click", (event) => {
  const link = event.target.closest("a[data-step]");
  if (!link || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
  event.preventDefault();
  showStep(link.dataset.step, true);
});
window.addEventListener("popstate", () => showStep(stepFromPath()));
showStep(stepFromPath());

async function init() {
  try {
    catalog = await api();
    buildForm();
    wireForm();
    $("ai-state").textContent = catalog.aiEnabled ? "点击后生成选点与预算取舍解读。" : "未配置模型。主提案由规则生成。";
    let saved;
    try { saved = JSON.parse(sessionStorage.getItem(draftKey)); } catch {}
    started = saved?.started === true;
    writeBrief(saved?.brief || catalog.emptyBrief);
    $("brief-text").value = saved?.text || "";
    if (started) queuePlan(0);
  } catch (error) {
    $("plan-status").textContent = error.message;
  }
}

init();
