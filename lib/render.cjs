"use strict";
/* 客户自助提案草稿的 HTML 渲染：页面预览、只读分享和导出共用同一份标记。 */
const fs = require("node:fs");
const path = require("node:path");
const S = require("./selfserve.cjs");

const esc = (value) => String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const wan = S.wan;
const range = (r) => wan(r.min) + " – " + wan(r.max);
const kind = (k) => k === "bus" ? "公交车身" : "地铁出入口";
const unit = (k) => k === "bus" ? "辆" : "处";
const table = (head, rows) => "<div class=\"ss-table\"><table><thead><tr>" + head.map((h) => "<th>" + esc(h) + "</th>").join("") + "</tr></thead><tbody>"
  + rows.map((r) => "<tr>" + r.map((c) => "<td>" + c + "</td>").join("") + "</tr>").join("") + "</tbody></table></div>";

function diffSection(diff) {
  if (!diff) return "";
  const li = (rows, fmt) => rows.length ? "<ul>" + rows.map((r) => "<li>" + fmt(r) + "</li>").join("") + "</ul>" : "<p class=\"ss-muted\">无</p>";
  const i = diff.impact;
  const delta = (a, b, f = (x) => x) => esc(f(a)) + " → <strong>" + esc(f(b)) + "</strong>";
  return `<section class="ss-section" id="ss-diff"><h2>本次修改的影响</h2>
  <p>${diff.fields.map((f) => esc(f.label) + "：" + esc(JSON.stringify(f.from)) + " → " + esc(JSON.stringify(f.to))).join("；") || "条件未变化"}</p>
  <div class="ss-grid">
    <div><h3>保留（${diff.kept.length}）</h3>${li(diff.kept, (r) => esc(r.name) + " × " + r.units)}</div>
    <div><h3>数量调整（${diff.changed.length}）</h3>${li(diff.changed, (r) => esc(r.name) + "：" + r.from + " → " + r.to)}</div>
    <div><h3>替换（${diff.replaced.length}）</h3>${li(diff.replaced, (r) => esc(r.from) + " → " + esc(r.to) + "（同商圈 " + esc(r.zones.join("、")) + "）")}</div>
    <div><h3>移除（${diff.removed.length}）</h3>${li(diff.removed, (r) => esc(r.name) + " × " + r.units + (r.reason ? "<br><small>" + esc(r.reason) + "</small>" : ""))}</div>
    <div><h3>新增（${diff.added.length}）</h3>${li(diff.added, (r) => esc(r.name) + " × " + r.units)}</div>
  </div>
  ${table(["影响", "修改前 → 修改后"], [
    ["目标圈覆盖（估算）", delta(i.coverage.from + "%", i.coverage.to + "%")],
    ["公交 / 地铁", delta(i.bus.from + " 辆 / " + i.metro.from + " 处", i.bus.to + " 辆 / " + i.metro.to + " 处")],
    ["费用区间", delta(wan(i.totalMin.from) + " – " + wan(i.totalMax.from), wan(i.totalMin.to) + " – " + wan(i.totalMax.to))],
    ["投放档期", delta(i.window.from, i.window.to)],
    ["首个施工夜 / 施工晚数", delta((i.firstNight.from || "—") + " / " + i.nights.from + " 晚", (i.firstNight.to || "—") + " / " + i.nights.to + " 晚")],
  ])}</section>`;
}

function body(draft) {
  const p = draft.plan;
  const n = draft.narrative || {};
  const reasons = n.reasons || {};
  const t = p.totals;
  const source = p.synthetic !== false ? "演示库存" : p.inventorySource === "mirror" ? "团队库存镜像" : "红豆在线库存";
  const topics = [["策略洞察", "ss-summary"], ["媒体策略与组合", "ss-items"], ["点位质量", "ss-coverage"], ["预算分配与报价", "ss-cost"], ["效果预估与衡量", "ss-monitor"], ["执行可行性", "ss-schedule"], ["服务与响应", "ss-service"]];
  return `<header class="ss-head"><p class="ss-badge">提案草稿 · 第 ${esc(draft.seq)} 版 · ${draft.status === "shared" ? "已分享固定版本" : draft.status === "submitted" ? "已提交团队审核" : "未提交"} · ${source} · 费用待核</p>
  <h1>${esc(draft.title)}</h1><p>${esc(p.window.start)} 至 ${esc(p.window.end)} · 预算 ${esc(p.brief.budgetWan)} 万元 · 公交 ${p.counts.bus} 辆 · 地铁 ${p.counts.metro} 处 · 目标圈覆盖 ${p.coverage.percent}%（估算）</p></header>
  <nav class="ss-report-nav" aria-label="七项评审维度">${topics.map(([label, id]) => `<a href="#${id}">${label}</a>`).join("")}</nav>
  <section class="ss-section" id="ss-summary"><h2>策略洞察</h2><p>${esc(n.summary || "")}</p><p class="ss-muted">文案来源为${n.source === "ai" ? "DeepSeek，数量已通过溯源校验" : "规则模板"}。金额、数量和日期由规则计算。</p></section>
  ${diffSection(draft.diff)}
  <section class="ss-section" id="ss-response"><h2>一页投放假设与需求逐条回应</h2>${table(["要素", "客户需求", "方案回应"], p.responses.map((r) => [esc(r.label), esc(r.need), esc(r.answer)]))}</section>
  <section class="ss-section" id="ss-map"><h2>投放路线与点位</h2><div data-proposal-map></div>${p.map?.shareUrl ? `<p><a href="${esc(p.map.shareUrl)}" target="_blank" rel="noopener noreferrer">打开大数据平台授权地图</a></p>` : `<p class="ss-muted">${p.map?.features?.length ? "浏览器提案页可查看已匹配路线。" : "地图证据待团队补充。"}</p>`}</section>
  <section class="ss-section" id="ss-items"><h2>推荐线路和点位</h2>${table(["资源", "类型", "等级 / 形式", "数量", "命中商圈", "选点理由", "费用区间"], p.items.map((i) => [
    esc(i.name) + (i.mustKeep ? " <span class=\"ss-tag\">客户指定</span>" : ""), kind(i.kind), esc(i.level + " · " + i.format), i.units + " " + unit(i.kind) + "<br><small>档期可售 " + i.free + "</small>",
    esc(i.hits.map((z) => p.coverage.zones.find((x) => x.id === z)?.name).filter(Boolean).join("、") || "—"), esc(reasons[i.id] || i.reason), range(i.cost.total)]))}</section>
  <section class="ss-section" id="ss-coverage"><h2>覆盖证据</h2><p class="ss-muted">${esc(p.coverage.basis)}</p>${table(["目标商圈", "优先级", "是否覆盖", "命中资源（去重计一次）"], p.coverage.zones.map((z) => [esc(z.name), z.priority ? "优先" : "一般", z.covered ? "已覆盖" : "<strong>未覆盖</strong>", esc(z.by.join("、") || "—")]))}</section>
  <section class="ss-section" id="ss-cost"><h2>费用明细</h2>${table(["项目", "下限", "中位", "上限"], [
    ["发布费（刊例区间 × " + p.brief.duration + "/30 天）", wan(t.media.min), wan(t.media.mid), wan(t.media.max)],
    ["制作费" + (t.pendingProduction ? "（" + t.pendingProduction + " 处缺面积未计）" : ""), wan(t.production.min), wan(t.production.mid), wan(t.production.max)],
    ["<strong>合计</strong>", "<strong>" + wan(t.total.min) + "</strong>", "<strong>" + wan(t.total.mid) + "</strong>", "<strong>" + wan(t.total.max) + "</strong>"],
  ])}<p>预算 ${wan(t.budget)}，预留 ${Math.round(t.buffer * 100)}% 执行缓冲后上限 ${wan(t.cap)}。计价来源为${esc(p.pricingSource || "工作台参考刊例")}，执行费、税费与特殊点位费用由团队复核。</p>
  ${(n.tradeoffs || []).length ? "<h3>预算取舍</h3><ul>" + n.tradeoffs.map((x) => "<li>" + esc(x) + "</li>").join("") + "</ul>" : ""}</section>
  <section class="ss-section" id="ss-schedule"><h2>投放与施工排期</h2>${table(["阶段", "开始", "结束", "负责方"], p.schedule.phases.map((x) => [esc(x.name), x.start, x.end, esc(x.owner)]))}
  <h3>夜间施工批次</h3>${table(["施工夜", "公交（辆）", "地铁（处）"], p.schedule.nights.map((x) => [x.day + " 晚", x.bus, x.metro]))}<p class="ss-muted">${esc(p.schedule.crew.source)}。</p></section>
  <section class="ss-section" id="ss-monitor"><h2>监测交付</h2>${table(["交付物", "截止", "负责方", "说明"], p.monitoring.deliverables.map((x) => [esc(x.name), x.due, esc(x.owner), esc(x.note)]))}
  <h3>成功衡量</h3>${table(["指标", "类型", "数据来源与口径"], p.monitoring.kpis.map((k) => [esc(k.name), k.type === "估算" ? "估算" : "实际", esc(k.source)]))}</section>
  <section class="ss-section" id="ss-service"><h2>服务与响应</h2><p>客户可调整预算、档期并生成新版本。团队采纳后，按本版本进入库存复核、报价及执行交接。</p></section>
  <section class="ss-section" id="ss-pending"><h2>待复核事项</h2><ul>${p.pending.map((x) => "<li>" + esc(x) + "</li>").join("")}</ul></section>`;
}

let css = null;
function standalone(draft) {
  css ??= fs.readFileSync(path.join(__dirname, "..", "assets", "client.css"), "utf8");
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${esc(draft.title)}</title><style>${css}</style></head><body class="ss-doc"><main class="ss-proposal">${body(draft)}</main></body></html>`;
}

function csv(draft) {
  const rows = [["资源", "类型", "等级", "形式", "数量", "命中商圈", "费用下限(元)", "费用上限(元)", "选点理由"]];
  for (const i of draft.plan.items) rows.push([i.name, kind(i.kind), i.level, i.format, i.units, i.hits.join("|"), Math.round(i.cost.total.min), Math.round(i.cost.total.max), i.reason]);
  return "﻿" + rows.map((r) => r.map((c) => /[",\n]/.test(String(c)) ? '"' + String(c).replace(/"/g, '""') + '"' : c).join(",")).join("\r\n");
}

module.exports = { body, standalone, csv, esc };
