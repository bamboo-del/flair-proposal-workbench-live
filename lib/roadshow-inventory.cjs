"use strict";

const S = require("./selfserve.cjs");
const L = require("./ledger.cjs");

// 旧工作台候选演示口径（workbench/scripts/out/stats.txt）。它提供查询线索，线路实际途经和门店距离仍须核对。
const targetsByZone = {
  jingan: { busLines: ["926"], metroKeywords: ["静安寺"] },
  nanjing_west: { busLines: ["926"], metroKeywords: ["南京西路"] },
  huaihai: { busLines: ["932"], metroKeywords: ["淮海中路"] },
  xintiandi: { busLines: ["955"], metroKeywords: ["新天地"] },
  lujiazui: { busLines: ["81"], metroKeywords: ["陆家嘴"] },
  xujiahui: { busLines: ["43"], metroKeywords: ["徐家汇"] },
  wujiaochang: { busLines: ["55"], metroKeywords: ["五角场"] },
  renmin: { busLines: ["18"], metroKeywords: ["人民广场"] },
  nanjing_east: { metroKeywords: ["南京东路"] },
  zhongshan: { metroKeywords: ["中山公园"] },
  hongqiao: { metroKeywords: ["虹桥火车站"] },
  qiantan: { metroKeywords: ["东方体育中心"] },
  longyang: { metroKeywords: ["龙阳路"] },
  haichang: { metroKeywords: ["临港大道"] },
};
const grades = new Set(["S", "A++", "A+", "AA", "A"]);
const busFormats = new Set(["车身三侧", "大三侧", "全色车"]);

function mappedTargets(brief) {
  return [...(brief.zones || [])].sort((a, b) => Number(Boolean(b.priority)) - Number(Boolean(a.priority)))
    .filter((zone) => Object.hasOwn(targetsByZone, zone.id)).slice(0, 5)
    .map((zone) => ({ id: zone.id, ...targetsByZone[zone.id] }));
}

function inventoryTargets(brief) {
  return mappedTargets(brief).map(({ busLines, metroKeywords }) => ({ busLines, metroKeywords }));
}

function inventoryPlan(brief, live, { executionBufferNights = 1 } = {}) {
  if (live?.status !== "verified" || brief.mode === "manual" || brief.mustKeep?.length) return null;
  const targets = mappedTargets(brief);
  const resources = [];
  for (const row of live.candidates || []) {
    const { mode, name, area, query, freeCount } = row;
    if (!["bus", "metro"].includes(mode) || !Number.isInteger(freeCount) || freeCount <= 0) continue;
    const match = mode === "bus" ? "busLines" : "metroKeywords";
    const zoneIds = targets.filter((zone) => zone[match]?.includes(query)).map((zone) => zone.id);
    if (!zoneIds.length) continue;
    const confirmedGrade = grades.has(row.grade) ? row.grade : null;
    const format = mode === "bus"
      ? busFormats.has(row.format) ? row.format : "车身形式待核"
      : "地铁出入口";
    resources.push({
      id: "redbean:" + JSON.stringify([mode, name, area]), name, query, kind: mode, format, zoneIds,
      level: confirmedGrade || "待核", estimateLevel: L.DATA.rates[mode][confirmedGrade] ? confirmedGrade : "A+",
      available: freeCount, bookings: [], synthetic: false,
    });
  }
  if (!resources.length) return null;
  const plan = S.plan(brief, { resources, executionBufferNights });
  if (plan.status !== "ready") return null;
  const incompleteRegions = targets.length < plan.brief.zones.length;
  if (incompleteRegions) plan.pending.push("即时查询只查前五个有候选线索的目标商圈，其余目标待复核。");
  const unallocated = plan.totals.cap - plan.totals.total.max;
  if (unallocated > 0) plan.pending.push("只从本次红豆查询的候选中选点。预留执行缓冲后，按已计费用上沿计算仍有 " + S.wan(unallocated) + " 未分配。");
  return { ...plan, inventorySource: "redbean", inventoryAsOf: live.asOf, inventoryPartial: live.partial === true || incompleteRegions };
}

module.exports = { inventoryTargets, inventoryPlan, mappedTargets };
