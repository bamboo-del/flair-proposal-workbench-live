"use strict";

const S = require("./selfserve.cjs");
const L = require("./ledger.cjs");
const { createRedbean } = require("./redbean.cjs");
const { mappedTargets } = require("./roadshow-inventory.cjs");

const clean = (value) => String(value || "").normalize("NFKC").replace(/\s+/g, "").toLowerCase();
const line = (name) => clean(name).replace(/路$/, "");
const keyFor = (kind, name, format) => kind + ":" + (kind === "bus" ? line(name) + "|" + clean(format) : clean(name).replace(/[·・]/g, ""));

function defaults(project) {
  const state = JSON.parse(project.state);
  const base = S.defaults(state.industry);
  return { ...base, brandType: state.brand || base.brandType, businessNote: state.assumptions?.business || "",
    startDate: state.startDate, duration: S.OPTIONS.duration.includes(state.duration) ? state.duration : base.duration,
    budgetWan: state.budget / 10000, zones: state.targets?.length ? state.targets.map(({ id, priority }) => ({ id, priority })) : base.zones,
    media: state.media, mode: "auto" };
}

function createClientPlanning(env, request) {
  const inventory = createRedbean(env, request);
  return async function prepare(project, input) {
    const state = JSON.parse(project.state);
    const requested = { ...defaults(project), ...input?.brief };
    const automatic = input?.autoMedia === true;
    if (automatic) Object.assign(requested, { media: ["bus", "metro"], busFormat: "any", mode: "auto", mustKeep: [] });
    const validation = S.normalizeBrief({ ...requested, mustKeep: [] });
    const { brief } = validation;
    if (validation.errors.length) return { plan: { ...validation, status: "invalid" }, inventory: [] };
    if (state.sample && !input?.live) return { plan: S.plan(requested), inventory: S.inventoryFor(requested) };

    const { start, end } = S.windowOf(brief);
    const coverage = new Map((state.data?.coverage || []).map(([key, zones]) => [clean(key).replace(/[·・]/g, ""), zones]));
    const targets = mappedTargets(brief);
    const imported = [...(state.data?.bus || []).map((row) => ({ ...row, kind: "bus" })), ...(state.data?.metro || []).map((row) => ({ ...row, kind: "metro" }))];
    for (const target of targets) {
      const keys = [...coverage].filter(([, zones]) => zones.includes(target.id)).map(([key]) => key);
      const busLines = keys.filter((key) => key.startsWith("bus:")).map((key) => key.slice(4).split("|")[0]);
      const metroKeywords = imported.filter((row) => row.kind === "metro" && row.station && keys.includes(keyFor("metro", row.name))).map((row) => row.station);
      if (busLines.length) target.busLines = [...new Set(busLines)];
      if (metroKeywords.length) target.metroKeywords = [...new Set(metroKeywords)];
    }
    const live = await inventory.lookup({ start, end, media: brief.media, targets });
    const exactMirror = imported.filter((row) => row.queryStart === start && row.queryEnd === end && row.status === "available");
    const resources = new Map();
    for (const row of exactMirror) {
      const name = row.route || row.name;
      const format = row.kind === "bus" ? row.mediaType : "地铁出入口";
      const key = keyFor(row.kind, name, format);
      resources.set(key, { id: `mirror:${row.id}`, kind: row.kind, name, format, level: row.level,
        zoneIds: coverage.get(key) || row.zoneIds || [row.zoneId].filter(Boolean), available: row.available, bookings: [], area: row.actualArea ?? state.areaOverrides?.[row.id],
        source: "mirror", synthetic: false, association: coverage.has(key) ? "按大数据平台覆盖导入关联" : "按团队库存资料关联" });
    }
    for (const row of live.candidates) {
      const name = row.mode === "bus" ? row.query : row.name;
      const key = keyFor(row.mode, name, row.format);
      const known = resources.get(key);
      const associations = row.mode === "bus" ? "busLines" : "metroKeywords";
      const zones = coverage.get(key) || known?.zoneIds || targets.filter((target) => target[associations]?.some((part) => clean(part) === clean(row.query))).map((target) => target.id);
      resources.set(key, { ...known, id: known?.id || `redbean:${key}`, kind: row.mode, name: row.name, query: row.query, format: row.format || (row.mode === "metro" ? "地铁出入口" : "车身形式待核"),
        level: row.grade || known?.level || "待核", zoneIds: zones, available: row.freeCount, bookings: [], source: "redbean", synthetic: false,
        association: coverage.has(key) ? "按大数据平台覆盖导入关联" : "按线路或站名候选关联" });
    }
    const pool = [...resources.values()].map((row) => {
      const tiers = (state.rateCard || L.DATA.rates)[row.kind];
      const estimateLevel = tiers[row.level] ? row.level : Object.keys(tiers).at(-1);
      return { ...row, estimateLevel, ...(state.rateCard ? { rateCard: state.rateCard } : {}) };
    }).filter((row) => row.estimateLevel);
    const solve = (selection) => S.plan(selection, { resources: pool, executionBufferNights: state.execution?.buffer ?? 1, execution: state.execution });
    let plan = solve({ ...requested, ...brief, mustKeep: automatic ? [] : requested.mustKeep });
    if (automatic && plan.status !== "ready") {
      const alternatives = (brief.campaignGoal === "visit" ? ["metro", "bus"] : ["bus", "metro"]).map((mode) => solve({ ...brief, media: [mode] }));
      plan = alternatives.filter((choice) => choice.status === "ready").sort((a, b) => b.coverage.percent - a.coverage.percent)[0] || plan;
    }
    if (state.sample && !pool.length) return { plan: S.plan(requested), inventory: S.inventoryFor(requested) };
    if (plan.status !== "invalid") {
      plan.inventorySource = live.status === "verified" ? "redbean" : exactMirror.length ? "mirror" : "unavailable";
      plan.inventoryAsOf = live.asOf || "";
      plan.coverage.basis = coverage.size
        ? "团队导入的大数据平台覆盖与线路或站名候选关联。各目标圈去重加权，实际人流与步行距离需单独复核。"
        : "按已核库存的线路或站名关联目标圈。实际覆盖与出站步行路径待平台复核。";
      plan.pricingSource = state.rateCard?.source || "工作台参考刊例";
      plan.pending.push(state.rateCard ? "发布费按项目刊例折扣计算，制作费单列。" : "报价采用工作台参考刊例，需团队补充项目刊例、折扣及执行费。");
      plan.pending.push(state.execution?.fallback || "夜间作业遇到天气或管制需重排。误一补二及备用车安排按实际合同确认。");
      if (plan.status !== "ready") plan.warnings.unshift(live.note || "当前未找到与本档期及预算相符的库存。");
    }
    return { plan, inventory: pool.map((row) => ({ id: row.id, name: row.name, kind: row.kind, level: row.level, format: row.format,
      zones: row.zoneIds.map((id) => L.zoneName.get(id)), free: row.available, available: row.available })) };
  };
}

module.exports = { createClientPlanning, defaults };
