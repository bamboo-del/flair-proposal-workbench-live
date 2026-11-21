"use strict";

const { performance } = require("node:perf_hooks");
const S = require("./selfserve.cjs");
const L = require("./ledger.cjs");
const AI = require("./ai.cjs");
const { createRedbean } = require("./redbean.cjs");
const { inventoryTargets, inventoryPlan } = require("./roadshow-inventory.cjs");
const { createPlatformMap } = require("./platform-map.cjs");
const { selectMap } = require("./map-evidence.cjs");

const caseBrief = {
  ...S.defaults("food"),
  brandType: "Manner Coffee",
  industryNote: "上海连锁咖啡 · 公开品牌情境假设",
  businessGoal: "traffic",
  businessNote: "早高峰咖啡补给计划。把办公商圈通勤者沿途看到的新品信息，转成工作日上午的门店到访。",
  campaignGoal: "visit",
  audiences: ["commuter"],
  zones: ["jingan", "nanjing_west", "huaihai", "lujiazui", "xujiahui"].map((id, i) => ({ id, priority: i < 2 })),
  startDate: "2027-05-10",
  duration: 30,
  budgetWan: 200,
  kpis: ["coverage", "scan", "redemption", "monitor"],
  kpiNote: "按点位独立二维码与门店核销码，观察工作日早高峰 07:30–10:00。以活动前同星期、同门店作参照，记录天气与促销干扰。",
};
const briefText = "品牌 Manner Coffee，上海连锁咖啡。做一轮早高峰门店引流，主要目标是到店，面向上班通勤白领，优先静安、南京西路，再覆盖淮海中路、陆家嘴、徐家汇。2027年5月10日起投30天，预算200万元，地铁出入口承接最后一段步行，公交车身在通勤路线上补频。用目标圈覆盖、点位扫码、到店核销和上下刊照片来衡量。";

function strategyFor(plan) {
  const { brief, counts } = plan;
  const manner = /\bmanner\s*coffee\b/i.test(brief.brandType) && brief.campaignGoal === "visit";
  const bus = counts.bus > 0;
  const metro = counts.metro > 0;
  const focus = plan.coverage.zones.filter((zone) => zone.priority).map((zone) => zone.name).join("、");
  const combination = bus && metro
    ? (brief.campaignGoal === "visit" ? "地铁出入口承接到店前最后一段步行，公交车身在通勤走廊补频。" : "公交车身做沿线重复触达，地铁出入口强化商圈触点。")
    : bus ? "沿通勤走廊布局公交车身，用重复经过建立记忆。"
      : metro ? "在目标区域的地铁出入口设置触点，优先贴近步行动线。" : "当前组合未能选出资源，请先处理档期、媒体或预算冲突。";
  return {
    title: manner ? "早高峰咖啡补给计划" : `${brief.brandType || "品牌"} · ${S.OPTIONS.campaignGoal[brief.campaignGoal]}计划`,
    insight: manner
      ? "把新品提示放在办公室通勤者每天经过的路径上，出站前形成需求，出站后能看到下一步门店行动。门店步行距离和导流能力需品牌确认。"
      : `${S.OPTIONS.businessGoal[brief.businessGoal]}对应${S.OPTIONS.campaignGoal[brief.campaignGoal]}目标。${focus ? `预算先覆盖${focus}，` : "预算先覆盖选定区域，"}再扩大周边触点。`,
    combination,
    activation: manner
      ? "画面只传达新品、步行方向与行动入口。按触点使用独立二维码，早间到店由门店核销验证。"
      : "每个触点保留可追踪的行动入口，按所选 KPI 收集监测及活动数据。",
    evidence: manner ? {
      title: "Manner 官网门店名录",
      url: "https://www.wearemanner.com/",
      note: "品牌官网列有南京西路与陆家嘴门店。将门店作为承接候选，投放前逐店确认早间营业、步行路径和追踪码。",
    } : null,
  };
}

function mixFor(plan) {
  return plan.brief.media.map((mode) => {
    const costs = plan.items.filter((item) => item.kind === mode).map((item) => item.cost);
    const media = costs.reduce((total, cost) => total + cost.media.mid, 0);
    const production = costs.reduce((total, cost) => total + cost.production.mid, 0);
    const total = media + production;
    const share = plan.totals.total.mid ? Math.round(total / plan.totals.total.mid * 100) : 0;
    return { mode, media, production, total, share };
  });
}

function reportFor(plan, diff, elapsedMs) {
  const strategy = strategyFor(plan);
  const budgetMix = mixFor(plan);
  if (plan.status === "ready") {
    const business = plan.responses.find((row) => row.key === "business");
    business.answer = strategy.combination;
    const media = plan.responses.find((row) => row.key === "media");
    media.answer = strategy.combination + ` 公交 ${plan.counts.bus} 辆，地铁 ${plan.counts.metro} 处。`;
  }
  const narrative = { source: "template", ...AI.narrativeTemplate(plan, diff), summary: strategy.combination };
  return { plan, diff, elapsedMs, strategy, budgetMix, narrative };
}

function createRoadshow({ env, request, fail, json, readJson, useLimit }) {
  const inventory = createRedbean(env, request);
  const authorizedMap = createPlatformMap(request);
  const limits = new Map();
  const actions = new Set(["extract", "plan", "inventory", "ai"]);
  const isBrief = (value) => value && typeof value === "object" && !Array.isArray(value);

  function calculate(brief, previous) {
    if (!isBrief(brief)) fail(422, "请填写投放需求。");
    const start = performance.now();
    const plan = S.plan(brief, { executionBufferNights: 1 });
    if (plan.status === "invalid") fail(422, "请检查预算、2027 年档期、目标商圈、媒体与 KPI。");
    const before = isBrief(previous) ? S.plan(previous, { executionBufferNights: 1 }) : null;
    return reportFor(plan, S.diff(before, plan), Math.ceil(performance.now() - start));
  }

  async function checkedInventory(brief, window, previous) {
    const started = performance.now();
    const targets = inventoryTargets(brief);
    const live = await inventory.lookup({ ...window, media: brief.media, targets });
    const plan = inventoryPlan(brief, live);
    if (!plan) return live;
    if (env.ROADSHOW_PLATFORM_MAP_URL || env.ROADSHOW_PLATFORM_METRO_URL) {
      const [bus, metro] = await Promise.allSettled([env.ROADSHOW_PLATFORM_MAP_URL && authorizedMap(env.ROADSHOW_PLATFORM_MAP_URL),
        env.ROADSHOW_PLATFORM_METRO_URL && authorizedMap(env.ROADSHOW_PLATFORM_METRO_URL)]);
      const busMap = bus.value, metroMap = metro.value;
      if (busMap || metroMap) plan.map = selectMap({ source: (busMap || metroMap).source, coordinateSystem: "BD09", shareUrl: busMap?.shareUrl, metroShareUrl: metroMap?.shareUrl,
        features: [...(busMap?.features || []), ...(metroMap?.features || []).map((feature) => ({ ...feature, reference: feature.type !== "Point" }))] }, plan.items);
      else plan.pending.push("大数据平台线路图暂时不可用，已保留本版资源清单。");
    }
    const before = isBrief(previous) ? S.normalizeBrief(previous) : null;
    const sameInventory = before && !before.errors.length && before.brief.startDate === brief.startDate && before.brief.duration === brief.duration &&
      JSON.stringify(before.brief.media) === JSON.stringify(brief.media) && JSON.stringify(inventoryTargets(before.brief)) === JSON.stringify(targets);
    const priorPlan = sameInventory ? inventoryPlan(before.brief, live) : null;
    return { ...live, plan: reportFor(plan, S.diff(priorPlan, plan), Math.ceil(performance.now() - started)) };
  }

  return async function roadshow(req, res, parts) {
    const action = parts[2];
    if (req.method === "GET" && parts.length === 2) {
      return json(res, { briefText, brief: caseBrief, options: S.OPTIONS, zones: L.zones, aiEnabled: AI.configured(env), platformMap: Boolean(env.ROADSHOW_PLATFORM_MAP_URL || env.ROADSHOW_PLATFORM_METRO_URL) });
    }
    if (parts.length !== 3 || req.method !== "POST" || !actions.has(action)) fail(404, "路演接口不存在。");
    useLimit(limits, "roadshow", 300, 60000);
    const payload = await readJson(req, 20000);
    if (!isBrief(payload)) fail(422, "请提交投放需求。");

    if (action === "extract") {
      if (typeof payload.text !== "string" || !payload.text.trim() || payload.text.length > 1600) fail(422, "请输入 1 至 1600 字的已脱敏需求。");
      const manner = /\bmanner\s*coffee\b/i.test(payload.text);
      const extraction = await AI.extract(payload.text, {}, request);
      const isoDate = payload.text.match(/\b2027-\d{2}-\d{2}\b/)?.[0];
      const brandType = manner ? caseBrief.brandType : payload.text.match(/(?:品牌(?:名)?|客户)\s*[：:]\s*([^，、。；\n,;]{1,32})/)?.[1]?.trim();
      const fields = { ...(manner ? caseBrief : S.defaults(extraction.prefill.industry || "food")), ...extraction.prefill };
      if (!manner) fields.brandType = brandType || extraction.prefill.brandType || "";
      if (isoDate) fields.startDate = isoDate;
      const missing = extraction.missing.filter((entry) => entry.key !== "startDate" || !isoDate).map((entry) => entry.label);
      if (!fields.brandType) missing.unshift("客户与品牌");
      return json(res, { brief: fields, missing, source: "rules" });
    }

    const result = calculate(payload.brief, payload.previous);
    const { plan } = result;
    if (action === "inventory") {
      useLimit(limits, "inventory", 60, 60000);
      return json(res, await checkedInventory(plan.brief, plan.window, payload.previous));
    }
    if (action === "ai") {
      if (!AI.configured(env)) return json(res, { ...result.narrative, note: "服务端尚未配置 DeepSeek。" });
      if (plan.status !== "ready") return json(res, { ...result.narrative, note: "请先解决资源或预算冲突。" });
      useLimit(limits, "ai-minute", 10, 60000);
      useLimit(limits, "ai-hour", 80, 3600000);
      const current = payload.source === "redbean" ? (await checkedInventory(plan.brief, plan.window, payload.previous)).plan : result;
      if (!current) return json(res, { source: "template", summary: "当前档期暂无可解读的红豆候选方案。", tradeoffs: [], note: "请重查档期或改用即时演算。" });
      const narrative = await AI.narrative(current.plan, current.diff, env, request, {
        insight: current.strategy.insight, combination: current.strategy.combination, activation: current.strategy.activation,
      });
      return json(res, narrative.source === "ai" ? narrative : { ...current.narrative, note: narrative.note });
    }
    return json(res, result);
  };
}

module.exports = { createRoadshow };
