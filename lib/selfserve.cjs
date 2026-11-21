"use strict";
/*
 * 客户自助提案：七要素表单 → 规则选点 → 冲突与替代 → 费用、覆盖、排期、监测 → 草稿差异。
 * 金额、库存、数量、日期全部由本文件的确定性规则计算；AI 只用于预填和文案（lib/ai.cjs）。
 */
const L = require("./ledger.cjs");

const OPTIONS = {
  industry: { food: "食品饮料", bank: "银行保险", health: "保健品", hospital: "私立医院", park: "乐园", other: "其他行业" },
  businessGoal: { launch: "新品上市", traffic: "门店引流", rebrand: "品牌焕新", expand: "区域拓展", member: "会员拉新" },
  campaignGoal: { awareness: "认知", visit: "到店", promotion: "促销", acquisition: "拉新" },
  audience: { commuter: "通勤白领", shopper: "商圈逛街客流", family: "社区家庭", youth: "学生青年", parent: "亲子家庭" },
  duration: [14, 21, 30, 45, 60, 90],
  busFormat: { any: "不限", "车身三侧": "车身三侧", "大三侧": "大三侧" },
  kpi: {
    coverage: "目标圈覆盖", monitor: "上下刊监测", landing: "活动页访问", redemption: "到店核销", scan: "扫码参与", survey: "品牌认知调研",
  },
};
const GOAL_SHARE = { awareness: 0.6, visit: 0.4, promotion: 0.45, acquisition: 0.5 };
const LEVEL = { S: 5, "A++": 4, "A+": 3, AA: 2, A: 1 };
const KPI_SOURCE = {
  coverage: ["估算", "按目标商圈与已选线路／出入口命中计算的加权覆盖，非实际人流"],
  monitor: ["实际", "上刊照片（上刊后 2 天内）、监测报告（5 个工作日内）、下刊照片与结案报告"],
  landing: ["实际", "客户活动页独立追踪链接或 UTM，由客户方数据回传"],
  redemption: ["实际", "门店核销码或 POS 活动码，由客户方系统统计"],
  scan: ["实际", "画面二维码独立渠道码扫码次数"],
  survey: ["实际", "投放前后第三方或客户自有调研，样本口径另行确认"],
};
const BUFFER = 0.05;
const CREW = { bus: 5, metro: 3, source: "合成默认施工容量（公交 5 辆／夜、地铁 3 处／夜），以团队执行排期为准" };

const text = (value, limit = 300) => typeof value === "string" ? value.trim().slice(0, limit) : "";
const isoDay = (value) => typeof value === "string" && /^2027-\d{2}-\d{2}$/.test(value) && L.iso(L.ms(value)) === value;
const wan = (yuan) => (Math.round(yuan / 100) / 100).toLocaleString("zh-CN", { maximumFractionDigits: 2 }) + " 万元";
const round = (n) => Math.round(n);
const sum = (rows, pick) => rows.reduce((total, row) => total + pick(row), 0);
const noise = (id) => { let h = 7; for (const c of id) h = (h * 31 + c.charCodeAt(0)) % 997; return h / 99700; };

function defaults(industry = "food") {
  const brand = L.DATA.brands[industry] || L.DATA.brands.food;
  return {
    industry, industryNote: "", brandType: brand.brand.replace(/^某/, "") || "", businessGoal: "launch", businessNote: "",
    campaignGoal: "awareness", audiences: ["commuter", "shopper"],
    zones: brand.targetZones.map((zone, index) => ({ id: zone.id, priority: index < 2 })),
    startDate: L.DATA.meta.defaultStartDate, duration: 30, budgetWan: 200, media: ["bus", "metro"], busFormat: "any",
    mode: "auto", mustKeep: [], kpis: ["coverage", "monitor", "landing"], kpiNote: "",
  };
}

/** 校验客户表单；不合规的字段报错而不是静默改值，缺省字段用默认值补齐。 */
function normalizeBrief(input = {}, catalogById = L.byId) {
  const base = defaults(Object.hasOwn(OPTIONS.industry, input.industry) ? input.industry : "food");
  const errors = [];
  const pick = (key, options) => {
    if (input[key] === undefined) return base[key];
    if (Object.hasOwn(options, input[key])) return input[key];
    errors.push(key);
    return base[key];
  };
  const list = (key, options) => {
    if (input[key] === undefined) return base[key];
    if (!Array.isArray(input[key])) { errors.push(key); return base[key]; }
    const values = [...new Set(input[key])].filter((value) => Object.hasOwn(options, value));
    if (values.length !== new Set(input[key]).size) errors.push(key);
    return values;
  };
  const brief = {
    industry: pick("industry", OPTIONS.industry), industryNote: text(input.industryNote, 80), brandType: text(input.brandType ?? base.brandType, 80),
    businessGoal: pick("businessGoal", OPTIONS.businessGoal), businessNote: text(input.businessNote, 300),
    campaignGoal: pick("campaignGoal", OPTIONS.campaignGoal), audiences: list("audiences", OPTIONS.audience),
    zones: base.zones, startDate: base.startDate, duration: base.duration, budgetWan: base.budgetWan,
    media: list("media", { bus: 1, metro: 1 }), busFormat: pick("busFormat", OPTIONS.busFormat),
    mode: input.mode === "manual" ? "manual" : "auto", mustKeep: [], kpis: list("kpis", OPTIONS.kpi), kpiNote: text(input.kpiNote, 200),
  };
  if (input.zones !== undefined) {
    const zones = Array.isArray(input.zones) ? input.zones.filter((zone) => L.zoneName.has(zone?.id)) : [];
    if (!Array.isArray(input.zones) || zones.length !== input.zones.length) errors.push("zones");
    brief.zones = [...new Map(zones.map((zone) => [zone.id, { id: zone.id, priority: Boolean(zone.priority) }])).values()].slice(0, 14);
  }
  if (input.startDate !== undefined) isoDay(input.startDate) ? brief.startDate = input.startDate : errors.push("startDate");
  if (input.duration !== undefined) OPTIONS.duration.includes(input.duration) ? brief.duration = input.duration : errors.push("duration");
  if (input.budgetWan !== undefined) Number.isInteger(input.budgetWan) && input.budgetWan >= 30 && input.budgetWan <= 2000 ? brief.budgetWan = input.budgetWan : errors.push("budgetWan");
  if (input.mustKeep !== undefined) {
    const rows = Array.isArray(input.mustKeep) ? input.mustKeep.slice(0, 40) : [];
    if (!Array.isArray(input.mustKeep) || rows.some((row) => !catalogById.has(row?.id) || !Number.isInteger(row.units) || row.units < 1 || row.units > 20)) errors.push("mustKeep");
    brief.mustKeep = [...new Map(rows.filter((row) => catalogById.has(row?.id) && Number.isInteger(row.units) && row.units >= 1 && row.units <= 20)
      .map((row) => [row.id, { id: row.id, units: catalogById.get(row.id).kind === "metro" ? 1 : row.units }])).values()];
  }
  if (brief.startDate && L.addDays(brief.startDate, brief.duration - 1) > "2027-12-31") errors.push("duration");
  if (!brief.media.length) errors.push("media");
  if (!brief.zones.length) errors.push("zones");
  if (!brief.audiences.length) errors.push("audiences");
  if (!brief.kpis.length) errors.push("kpis");
  return { brief, errors: [...new Set(errors)] };
}

function windowOf(brief) { return { start: brief.startDate, end: L.addDays(brief.startDate, brief.duration - 1) }; }

function unitPrice(resource, duration) {
  return L.unitPrice(resource.estimateLevel ? { ...resource, level: resource.estimateLevel } : resource, duration, resource.rateCard);
}

function candidate(resource, brief, targets, units) {
  const { start, end } = windowOf(brief);
  const price = unitPrice(resource, brief.duration);
  const { free, taken } = L.freeUnits(resource, start, end);
  const hits = resource.zoneIds.filter((id) => targets.has(id));
  const weight = sum(hits, (id) => targets.get(id));
  const level = LEVEL[resource.level] || 1;
  const goal = brief.campaignGoal;
  const aud = new Set(brief.audiences);
  const bias = (resource.kind === "bus" ? (aud.has("commuter") ? 0.4 : 0) + (aud.has("youth") ? 0.2 : 0)
    : (aud.has("shopper") ? 0.4 : 0) + (aud.has("parent") || aud.has("family") ? 0.2 : 0)) + (goal === "promotion" && resource.kind === "metro" ? 0.5 : 0);
  const score = weight * (goal === "visit" ? 4.5 : 3) + level * (goal === "awareness" ? 0.6 : 0.3) + bias + noise(resource.id);
  return {
    id: resource.id, kind: resource.kind, name: resource.name, level: resource.level, format: resource.format,
    zoneIds: resource.zoneIds, hits, weight, score, free, taken, price, units: units || 1, synthetic: resource.synthetic,
    ...(resource.synthetic === false ? { source: resource.source || "redbean", query: resource.query, association: resource.association, estimateLevel: resource.estimateLevel } : {}),
  };
}

function reasonFor(item, brief) {
  const zones = item.hits.map((id) => L.zoneName.get(id));
  if (item.synthetic === false) {
    const association = item.association || (item.kind === "bus" ? "按旧方案线路候选关联" : "按地铁站名关联");
    const capacity = item.free + (item.kind === "bus" ? " 辆" : " 处");
    return association + (zones.join("、") || "待确认区域") + "。门店动线待实测。" + (item.source === "mirror" ? "团队库存镜像" : "红豆在线查询") + "整段档期空位 " + capacity + "，尚未锁位。";
  }
  const goal = OPTIONS.campaignGoal[brief.campaignGoal];
  const where = zones.length ? "命中目标商圈 " + zones.join("、") + "（权重 " + item.weight.toFixed(2) + "）" : "未直接命中目标商圈，作为通勤动线补充";
  const why = item.kind === "bus"
    ? item.level + " 级" + item.format + "，沿线重复触达，服务「" + goal + "」的频次需求"
    : item.level + " 级出入口，承接出站到门店最后一段步行，服务「" + goal + "」的现场可见度";
  return (item.mustKeep ? "客户指定保留。" : "") + where + "；" + why + "；档期内可售 " + item.free + (item.kind === "bus" ? " 辆" : " 处") + "。";
}

function cost(item) {
  const p = item.price;
  return {
    media: { min: p.media.min * item.units, mid: p.media.mid * item.units, max: p.media.max * item.units },
    production: { min: p.production.min * item.units, mid: p.production.mid * item.units, max: p.production.max * item.units, pending: p.production.pending, basis: p.production.basis },
    total: { min: (p.media.min + p.production.min) * item.units, mid: (p.media.mid + p.production.mid) * item.units, max: (p.media.max + p.production.max) * item.units },
  };
}

function plan(input, { resources, executionBufferNights = 0, execution } = {}) {
  const poolSource = resources ?? L.resources;
  const byId = resources ? new Map(resources.map((row) => [row.id, row])) : L.byId;
  const { brief, errors } = normalizeBrief(input, byId);
  if (errors.length) return { brief, errors, status: "invalid" };
  const { start, end } = windowOf(brief);
  const budget = brief.budgetWan * 10000;
  const cap = Math.floor(budget * (1 - BUFFER));
  const targets = new Map(brief.zones.map((zone) => [zone.id, zone.priority ? 1 : 0.75]));
  const media = new Set(brief.media);
  const conflicts = [];
  const warnings = [];
  const fmt = (resource) => brief.busFormat === "any" || resource.kind !== "bus" || resource.format === brief.busFormat;

  // 1. 客户指定必选资源：只检查、不替客户删除。
  const must = [];
  for (const keep of brief.mustKeep) {
    const resource = byId.get(keep.id);
    const item = candidate(resource, brief, targets, keep.units);
    item.mustKeep = true;
    if (!media.has(resource.kind)) {
      conflicts.push({ code: "media", resource: item.name, message: item.name + " 属于" + (resource.kind === "bus" ? "公交车身" : "地铁出入口") + "，但当前媒体组合未选该类媒体。",
        options: [{ label: "加入" + (resource.kind === "bus" ? "公交车身" : "地铁出入口"), patch: { media: [...media, resource.kind] } }, { label: "移除该必选资源", patch: { removeMustKeep: keep.id } }] });
      continue;
    }
    if (!fmt(resource)) {
      conflicts.push({ code: "format", resource: item.name, message: item.name + " 为" + resource.format + "，与指定车身形式「" + brief.busFormat + "」不符。",
        options: [{ label: "车身形式改为不限", patch: { busFormat: "any" } }, { label: "移除该必选资源", patch: { removeMustKeep: keep.id } }] });
      continue;
    }
    if (item.free < keep.units) {
      const day = resources ? null : L.nearestWindow(resource, brief.duration, brief.startDate, keep.units);
      const alts = poolSource.filter((row) => row.kind === resource.kind && row.id !== resource.id && fmt(row)
        && row.zoneIds.some((id) => resource.zoneIds.includes(id) || targets.has(id)) && L.freeUnits(row, start, end).free >= 1)
        .map((row) => candidate(row, brief, targets)).sort((a, b) => b.score - a.score).slice(0, 3);
      const busy = item.taken.map((b) => b.start + " 至 " + b.end + " " + b.note).join("；");
      conflicts.push({
        code: "availability", resource: item.name,
        message: item.name + " 在 " + start + " 至 " + end + " 可售 " + item.free + "，少于指定的 " + keep.units + (resource.kind === "bus" ? " 辆" : " 处") + (busy ? "（" + busy + "）" : "") + "。",
        options: [
          ...(day ? [{ label: "档期改为 " + day + " 起（该资源可满足）", patch: { startDate: day } }] : []),
          ...(item.free > 0 && resource.kind === "bus" ? [{ label: "数量降为 " + item.free + " 辆", patch: { mustKeep: { id: keep.id, units: item.free } } }] : []),
          ...alts.map((alt) => ({ label: "改用 " + alt.name + "（" + alt.hits.map((id) => L.zoneName.get(id)).join("、") + "，可售 " + alt.free + "）", patch: { replaceMustKeep: { from: keep.id, to: alt.id, units: Math.min(keep.units, alt.free) } } })),
          { label: "移除该必选资源", patch: { removeMustKeep: keep.id } },
        ],
      });
      continue;
    }
    must.push(item);
  }
  const mustMax = sum(must, (item) => cost(item).total.max);
  if (mustMax > cap) {
    const need = Math.ceil(mustMax / (1 - BUFFER) / 10000);
    const priciest = [...must].sort((a, b) => cost(b).total.max - cost(a).total.max)[0];
    conflicts.push({ code: "budget", message: "必选资源费用上沿 " + wan(mustMax) + "，超过预算扣除 5% 执行缓冲后的上限 " + wan(cap) + "。",
      options: [{ label: "预算调到 " + need + " 万元", patch: { budgetWan: need } }, { label: "移除最贵的必选资源 " + priciest.name, patch: { removeMustKeep: priciest.id } }] });
  }

  // 2. 候选池：硬条件（媒体、形式、档期可售、刊例）先过滤，再按得分排序。
  const pool = poolSource.filter((row) => media.has(row.kind) && fmt(row) && unitPrice(row, brief.duration) && !must.some((m) => m.id === row.id))
    .map((row) => candidate(row, brief, targets)).filter((item) => item.free > 0).sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
  const blocked = poolSource.filter((row) => media.has(row.kind) && fmt(row) && row.available > 0 && L.freeUnits(row, start, end).free === 0)
    .filter((row) => row.zoneIds.some((id) => targets.has(id)));

  const chosen = must.map((item) => ({ ...item }));
  let mid = sum(chosen, (item) => cost(item).total.mid);
  let max = mustMax;
  if (brief.mode === "auto" && !conflicts.length) {
    const share = media.size === 2 ? GOAL_SHARE[brief.campaignGoal] : media.has("bus") ? 1 : 0;
    const target = cap * 0.97;
    const goals = { bus: target * share, metro: target * (1 - share) };
    const spent = (kind) => sum(chosen.filter((item) => item.kind === kind), (item) => cost(item).total.mid);
    const unitMax = (item) => item.price.media.max + item.price.production.max;
    const cheapestMetro = Math.min(...pool.filter((item) => item.kind === "metro").map(unitMax));
    let reserve = media.size === 2 && !chosen.some((item) => item.kind === "metro") && Number.isFinite(cheapestMetro) ? cheapestMetro : 0;
    const add = (item) => {
      const existing = chosen.find((row) => row.id === item.id);
      const unit = unitMax(item);
      if (max + unit > cap - (item.kind === "bus" ? reserve : 0)) return false;
      if (existing) { if (existing.units >= Math.min(existing.free, resources && existing.kind === "metro" ? 1 : 3)) return false; existing.units += 1; }
      else chosen.push({ ...item, units: 1 });
      max += unit;
      mid += item.price.media.mid + item.price.production.mid;
      return true;
    };
    // 覆盖优先：每个目标商圈先放一个得分最高、放得下的触点（优先商圈在前）。
    for (const zone of [...brief.zones].sort((x, y) => Number(y.priority) - Number(x.priority))) {
      if (chosen.some((item) => item.zoneIds.includes(zone.id))) continue;
      const kinds = media.size === 2 ? (spent("bus") / (goals.bus || 1) <= spent("metro") / (goals.metro || 1) ? ["bus", "metro"] : ["metro", "bus"]) : [...media];
      for (const kind of kinds) {
        const hit = pool.find((item) => item.kind === kind && item.zoneIds.includes(zone.id) && unitMax(item) + max <= cap - (kind === "bus" ? reserve : 0));
        if (hit && add(hit)) { if (kind === "metro") reserve = 0; break; }
      }
    }
    for (const kind of ["bus", "metro"]) {
      if (kind === "metro") reserve = 0;
      if (!media.has(kind)) continue;
      const list = pool.filter((item) => item.kind === kind);
      for (let pass = 0; pass < 3; pass += 1) {
        for (const item of list) {
          if (spent(kind) >= goals[kind] * (kind === "metro" ? 1 : 0.98)) break;
          if (pass && !chosen.some((row) => row.id === item.id)) continue;
          add(item);
        }
      }
    }
    for (const item of pool) if (mid < target) add(item); // 回填剩余预算
  }

  const items = chosen.map((item) => ({ ...item, cost: cost(item), reason: reasonFor(item, brief) }));
  const count = (kind) => sum(items.filter((item) => item.kind === kind), (item) => item.units);
  if (brief.mode === "manual" && !must.length && !conflicts.length) {
    conflicts.push({ code: "manual", message: "已选择「只用指定资源」，但还没有指定任何资源。", options: [{ label: "改为系统推荐", patch: { mode: "auto" } }] });
  }
  if (media.size === 2 && !conflicts.length && (!count("bus") || !count("metro"))) {
    const cheapest = (kind) => Math.min(...pool.filter((item) => item.kind === kind).map((item) => item.price.media.max + item.price.production.max));
    const need = Math.ceil((cheapest("bus") + cheapest("metro")) / (1 - BUFFER) / 10000);
    const missing = !count("bus") ? "bus" : "metro";
    const none = !pool.some((item) => item.kind === missing);
    conflicts.push({ code: none ? "inventory" : "mix", message: none
      ? (resources ? "本次红豆查询的候选中没有可用的" : "所选档期内没有可售的") + (missing === "bus" ? "公交线路" : "地铁出入口") + "，无法组成公交加地铁组合。"
      : "预算上限 " + wan(cap) + " 不足以同时放入公交和地铁资源。",
      options: [...(none ? [] : [{ label: "预算调到 " + need + " 万元", patch: { budgetWan: need } }]),
        { label: "只投" + (missing === "bus" ? "地铁出入口" : "公交车身"), patch: { media: [missing === "bus" ? "metro" : "bus"] } }] });
  }

  // 3. 覆盖证据：同一商圈被多个资源命中只算一次。
  const zoneRows = brief.zones.map((zone) => {
    const by = items.filter((item) => item.zoneIds.includes(zone.id)).map((item) => item.name);
    return { id: zone.id, name: L.zoneName.get(zone.id), priority: zone.priority, weight: targets.get(zone.id), covered: by.length > 0, by };
  });
  const totalWeight = sum(zoneRows, (row) => row.weight);
  const coverage = { percent: totalWeight ? Math.round(sum(zoneRows.filter((row) => row.covered), (row) => row.weight) / totalWeight * 100) : 0, zones: zoneRows,
    basis: resources
      ? "估算：按旧方案线路候选和红豆地铁站名关联目标商圈，商圈去重、按优先级加权；路线、门店步行距离及实际到达待核。"
      : "估算：目标商圈按优先级加权（优先 1.0／一般 0.75），线路途经或出入口所在商圈视为命中，重复命中只计一次；非实际人流。",
  };
  for (const row of conflicts.length ? [] : zoneRows.filter((zone) => !zone.covered)) {
    const reach = blocked.filter((resource) => resource.zoneIds.includes(row.id)).map((resource) => resource.name);
    warnings.push(row.name + (resources ? " 未被本次已核库存候选覆盖" : " 未被当前组合覆盖") + (reach.length ? "；" + reach.slice(0, 3).join("、") + " 在该档期已无空位" : "") + "。");
  }

  const totals = {
    media: { min: sum(items, (i) => i.cost.media.min), mid: sum(items, (i) => i.cost.media.mid), max: sum(items, (i) => i.cost.media.max) },
    production: { min: sum(items, (i) => i.cost.production.min), mid: sum(items, (i) => i.cost.production.mid), max: sum(items, (i) => i.cost.production.max) },
    total: { min: sum(items, (i) => i.cost.total.min), mid: sum(items, (i) => i.cost.total.mid), max: sum(items, (i) => i.cost.total.max) },
    pendingProduction: items.filter((i) => i.cost.production.pending).length, budget, cap, buffer: BUFFER,
  };
  const counts = { bus: count("bus"), metro: count("metro") };
  const schedule = scheduleFor(brief, counts, executionBufferNights, execution);
  const result = {
    status: conflicts.length ? "conflict" : items.length ? "ready" : "empty", brief, window: { start, end }, conflicts, warnings,
    items: items.map(({ price, taken, score, ...item }) => ({ ...item, unitRate: price.rate, score: Math.round(score * 100) / 100 })),
    counts, totals, coverage, schedule, monitoring: monitoringFor(brief), synthetic: !resources,
  };
  result.responses = responsesFor(result);
  result.pending = pendingFor(result);
  return result;
}

function scheduleFor(brief, counts, bufferNights, execution) {
  const { start, end } = windowOf(brief);
  const buffer = Number.isInteger(bufferNights) ? Math.max(0, Math.min(14, bufferNights)) : 0;
  const installEnd = L.addDays(start, -1 - buffer);
  const nights = [];
  const crew = execution ? { bus: execution.busPerNight, metro: execution.metroPerNight, source: "团队工作台的项目夜间施工容量及停工日期" } : CREW;
  const blackouts = new Set(execution?.blackout || []);
  let bus = counts.bus, metro = counts.metro, day = installEnd;
  while (bus > 0 || metro > 0) {
    if (blackouts.has(day)) { day = L.addDays(day, -1); continue; }
    const b = Math.min(bus, crew.bus), m = Math.min(metro, crew.metro);
    nights.unshift({ day, bus: b, metro: m });
    bus -= b; metro -= m; day = L.addDays(day, -1);
  }
  const firstNight = nights[0]?.day || installEnd;
  return {
    crew, nights,
    phases: [
      { name: "团队审核与库存复核", start: L.addDays(firstNight, -14), end: L.addDays(firstNight, -10), owner: "提案团队" },
      { name: "正式报价与锁位", start: L.addDays(firstNight, -9), end: L.addDays(firstNight, -7), owner: "销售 + 媒体运营" },
      { name: "画面定稿与制作", start: L.addDays(firstNight, -6), end: L.addDays(firstNight, -1), owner: "客户创意 + 制作供应商" },
      { name: "夜间施工（" + nights.length + " 晚）", start: firstNight, end: installEnd, owner: "施工外包 + 媒体运营" },
      ...(buffer ? [{ name: "上线前执行缓冲（" + buffer + " 晚）", start: L.addDays(installEnd, 1), end: L.addDays(start, -1), owner: "媒体运营" }] : []),
      { name: "媒体发布", start, end, owner: "媒体运营" },
      { name: "下刊与结案", start: L.addDays(end, 1), end: L.addDays(end, 8), owner: "运营 + 提案" },
    ],
  };
}

function monitoringFor(brief) {
  const { start, end } = windowOf(brief);
  return {
    deliverables: [
      { name: "上刊照片", due: L.addDays(start, 2), owner: "媒体运营", note: "每辆车／每处出入口一张可核验照片" },
      { name: "上刊监测报告", due: L.addDays(start, 7), owner: "运营", note: "上刊后 5 个工作日内" },
      ...(brief.duration > 30 ? [{ name: "月度在刊监测", due: L.addDays(start, 30), owner: "运营", note: "画面完整性与异常回传" }] : []),
      { name: "下刊照片", due: L.addDays(end, 4), owner: "运营", note: "下刊后 5 个工作日内" },
      { name: "结案报告", due: L.addDays(end, 8), owner: "提案 + 运营", note: "投放清单、监测照片、异常与优化建议" },
    ],
    kpis: brief.kpis.map((key) => ({ key, name: OPTIONS.kpi[key], type: KPI_SOURCE[key][0], source: KPI_SOURCE[key][1] })),
  };
}

function responsesFor(result) {
  const { brief, counts, totals, coverage, window } = result;
  const o = OPTIONS;
  const covered = coverage.zones.filter((zone) => zone.covered).map((zone) => zone.name);
  const lead = counts.bus && counts.metro ? (counts.bus * 1 >= counts.metro ? "公交为主、地铁为辅" : "地铁为主、公交补频") : counts.bus ? "仅公交车身" : counts.metro ? "仅地铁出入口" : "暂无资源";
  const industry = o.industry[brief.industry] + (brief.industryNote ? "（" + brief.industryNote + "）" : "");
  return [
    { key: "customer", label: "客户与品牌", need: industry + " · " + (brief.brandType || "品牌类型待补充"),
      answer: "按" + industry + "的门店与商圈分布选点，优先保留目标商圈内的 " + covered.length + " 个触点区域。" },
    { key: "business", label: "生意目标", need: o.businessGoal[brief.businessGoal] + (brief.businessNote ? "：" + brief.businessNote : ""),
      answer: "以" + lead + "支撑「" + o.businessGoal[brief.businessGoal] + "」：公交提供沿线重复露出，地铁出入口承接到店前最后一段动线。" },
    { key: "goal", label: "Campaign 主目标", need: o.campaignGoal[brief.campaignGoal],
      answer: "主目标「" + o.campaignGoal[brief.campaignGoal] + "」对应预算分配 公交 " + Math.round((counts.bus || counts.metro ? sum(result.items.filter((i) => i.kind === "bus"), (i) => i.cost.total.mid) / (totals.total.mid || 1) : 0) * 100) + "%，并用「" + brief.kpis.map((k) => o.kpi[k]).join("、") + "」衡量。" },
    { key: "audience", label: "目标人群与区域", need: brief.audiences.map((a) => o.audience[a]).join("、") + " · " + coverage.zones.map((zone) => zone.name).join("、"),
      answer: "目标圈加权覆盖 " + coverage.percent + "%（估算）。已覆盖：" + (covered.join("、") || "无") + "。" + (coverage.zones.length > covered.length ? "未覆盖：" + coverage.zones.filter((z) => !z.covered).map((z) => z.name).join("、") + "，见待复核事项。" : "") },
    { key: "budget", label: "时间与预算", need: window.start + " 至 " + window.end + "（" + brief.duration + " 天）· 预算 " + brief.budgetWan + " 万元",
      answer: (result.synthetic ? "费用区间 " : "按工作台示例刊例粗估，费用区间 ") + wan(totals.total.min) + " – " + wan(totals.total.max) + (result.synthetic ? "，上沿不超过扣除 5% 执行缓冲后的 " : "，已知费用上沿不超过扣除 5% 执行缓冲后的 ") + wan(totals.cap) + "。" + (totals.pendingProduction ? totals.pendingProduction + " 处地铁制作费缺面积，未计入。" : "") },
    { key: "media", label: "媒体范围", need: brief.media.map((m) => m === "bus" ? "公交车身" : "地铁出入口").join(" + ") + (brief.busFormat !== "any" ? "（" + brief.busFormat + "）" : ""),
      answer: "公交 " + counts.bus + " 辆、地铁 " + counts.metro + " 处，" + lead + "。" + (brief.mustKeep.length ? "客户指定资源 " + brief.mustKeep.length + " 项均已保留。" : "") },
    { key: "success", label: "成功衡量", need: brief.kpis.map((k) => o.kpi[k]).join("、") + (brief.kpiNote ? "；" + brief.kpiNote : ""),
      answer: "估算指标（目标圈覆盖）与实际指标（监测、访问、核销等）分开呈现；实际指标按各自数据来源在结案时回收。" },
  ];
}

function pendingFor(result) {
  const list = [
    result.synthetic
      ? "库存、线路与刊例为合成数据，正式提案需用红豆／大数据平台镜像复核空位与查询区间。"
      : "库存来自红豆整段查询。商圈依据旧线路候选及地铁站名，实际路线、门店距离和几何覆盖待核。红豆未提供可确认的等级对应关系时按工作台 A+ 档示例刊例粗估。",
    "费用为刊例区间估算，未含折扣、税费与特殊点位费用；正式报价由团队审核后出具。",
    "锁位、施工排期和执行确认沿用团队审核流程，本草稿不构成锁位。",
  ];
  if (result.totals.pendingProduction) list.push(result.totals.pendingProduction + " 处地铁出入口缺画面面积，制作费待核。");
  for (const warning of result.warnings) list.push(warning);
  if (result.brief.kpis.some((k) => KPI_SOURCE[k][0] === "实际" && k !== "monitor")) list.push("活动页、核销、扫码等实际指标需客户方提供独立追踪口径。");
  return list;
}

/** 两版方案的资源与影响差异：保留、数量变化、替换、移除、新增，以及覆盖、费用、排期变化。 */
function diff(before, after) {
  if (!before || !after || !before.items || !after.items) return null;
  const a = new Map(before.items.map((item) => [item.id, item]));
  const b = new Map(after.items.map((item) => [item.id, item]));
  const kept = [], changed = [], removed = [], added = [];
  for (const [id, item] of a) {
    const next = b.get(id);
    if (!next) removed.push(item);
    else if (next.units === item.units) kept.push(next);
    else changed.push({ name: next.name, id, from: item.units, to: next.units });
  }
  for (const [id, item] of b) if (!a.has(id)) added.push(item);
  const replaced = [];
  for (const old of [...removed]) {
    const match = added.find((item) => item.kind === old.kind && item.zoneIds.some((zone) => old.zoneIds.includes(zone)));
    if (!match) continue;
    replaced.push({ from: old.name, to: match.name, zones: match.zoneIds.filter((z) => old.zoneIds.includes(z)).map((z) => L.zoneName.get(z)) });
    removed.splice(removed.indexOf(old), 1);
    added.splice(added.indexOf(match), 1);
  }
  const lastNight = (p) => p.schedule.nights[0]?.day || null;
  const fields = [];
  for (const [key, label] of [["budgetWan", "预算（万元）"], ["startDate", "开始日期"], ["duration", "天数"], ["media", "媒体"], ["campaignGoal", "主目标"]]) {
    const x = JSON.stringify(before.brief[key]), y = JSON.stringify(after.brief[key]);
    if (x !== y) fields.push({ label, from: before.brief[key], to: after.brief[key] });
  }
  const why = (item) => {
    const resource = L.byId.get(item.id);
    if (resource && L.freeUnits(resource, after.window.start, after.window.end).free === 0) return "新档期无空位";
    if (!after.brief.media.includes(item.kind)) return "媒体组合不再包含该类";
    if (after.brief.budgetWan < before.brief.budgetWan) return "预算下调，保留得分更高或覆盖必要的资源";
    return "组合重新排序后让位";
  };
  return {
    fields,
    kept: kept.map((item) => ({ name: item.name, units: item.units })), changed,
    replaced, removed: removed.map((item) => ({ name: item.name, units: item.units, reason: why(item) })), added: added.map((item) => ({ name: item.name, units: item.units })),
    impact: {
      coverage: { from: before.coverage.percent, to: after.coverage.percent },
      bus: { from: before.counts.bus, to: after.counts.bus }, metro: { from: before.counts.metro, to: after.counts.metro },
      totalMin: { from: round(before.totals.total.min), to: round(after.totals.total.min) },
      totalMax: { from: round(before.totals.total.max), to: round(after.totals.total.max) },
      window: { from: before.window.start + " 至 " + before.window.end, to: after.window.start + " 至 " + after.window.end },
      firstNight: { from: lastNight(before), to: lastNight(after) },
      nights: { from: before.schedule.nights.length, to: after.schedule.nights.length },
    },
  };
}

/** 套用冲突选项里的调整；只在客户点击时调用。 */
function applyPatch(brief, patch) {
  const next = JSON.parse(JSON.stringify(brief));
  for (const key of ["startDate", "budgetWan", "media", "busFormat", "mode"]) if (patch[key] !== undefined) next[key] = patch[key];
  if (patch.removeMustKeep) next.mustKeep = next.mustKeep.filter((row) => row.id !== patch.removeMustKeep);
  if (patch.mustKeep) next.mustKeep = next.mustKeep.map((row) => row.id === patch.mustKeep.id ? patch.mustKeep : row);
  if (patch.replaceMustKeep) next.mustKeep = next.mustKeep.map((row) => row.id === patch.replaceMustKeep.from ? { id: patch.replaceMustKeep.to, units: patch.replaceMustKeep.units } : row);
  return next;
}

/** 客户可选资源清单（含当前档期可售数）。 */
function inventoryFor(input) {
  const { brief } = normalizeBrief(input);
  const { start, end } = windowOf(brief);
  return L.resources.map((row) => ({
    id: row.id, kind: row.kind, name: row.name, level: row.level, format: row.format,
    zones: row.zoneIds.map((id) => L.zoneName.get(id)), free: L.freeUnits(row, start, end).free, available: row.available,
  }));
}

function catalog() {
  return { options: OPTIONS, zones: L.zones, defaults: defaults(), industries: Object.fromEntries(Object.keys(OPTIONS.industry).map((id) => [id, defaults(id === "other" ? "food" : id).zones])) };
}

module.exports = { OPTIONS, defaults, normalizeBrief, windowOf, plan, diff, applyPatch, inventoryFor, catalog, wan };
