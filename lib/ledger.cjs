"use strict";
/*
 * 客户自助入口使用的线路级库存与合成占用记录。
 * 线路、点位、等级、刊例沿用 assets/data.js 的合成样例；占用记录与地铁面积按确定性规则生成，
 * 只用于演示档期变化。正式库存由红豆导出镜像替换，见 docs/data-contract.md。
 */
const fs = require("node:fs");
const vm = require("node:vm");
const path = require("node:path");

const context = vm.createContext({ window: {} });
new vm.Script(fs.readFileSync(path.join(__dirname, "..", "assets", "data.js"), "utf8"), { filename: "assets/data.js" }).runInContext(context);
const DATA = JSON.parse(JSON.stringify(context.window.NEWCLOUD_DATA));

const DAY = 86400000;
const iso = (ms) => new Date(ms).toISOString().slice(0, 10);
const ms = (day) => Date.parse(day + "T00:00:00Z");
const addDays = (day, n) => iso(ms(day) + n * DAY);
const overlaps = (a0, a1, b0, b1) => a0 <= b1 && b0 <= a1;

const zones = DATA.zones.map(({ id, name }) => ({ id, name }));
const zoneName = new Map(zones.map((zone) => [zone.id, zone.name]));

const bus = DATA.busRoutes.map((route, index) => {
  const bookings = [];
  if (index % 5 === 1 && route.available) bookings.push({ start: "2027-06-01", end: "2027-06-30", units: route.available, note: "合成占用 · 其他客户" });
  if (index % 7 === 3 && route.available > 1) bookings.push({ start: "2027-05-01", end: "2027-05-31", units: 1, note: "合成预定 · 待释放" });
  return {
    id: "bus:" + route.route + ":" + (route.mediaType === "大三侧" ? "L" : "S"),
    kind: "bus", name: route.route + " 路", route: route.route, level: route.level, format: route.mediaType,
    zoneIds: route.zoneIds, available: route.available, bookings, operator: route.operator, synthetic: true,
  };
});

const metro = DATA.subwayPoints.map((point, index) => ({
  id: "metro:" + point.id.replace("fixture-metro-", ""),
  kind: "metro", name: point.name, station: point.station, level: point.level, format: "出入口灯箱",
  zoneIds: [point.zoneId], available: point.available,
  bookings: index % 4 === 2 ? [{ start: "2027-07-01", end: "2027-07-31", units: 1, note: "合成占用 · 其他客户" }] : [],
  area: index % 3 === 0 ? null : 12 + (index % 5) * 2, synthetic: true,
}));

const resources = [...bus, ...metro];
const byId = new Map(resources.map((row) => [row.id, row]));

function freeUnits(resource, start, end) {
  const taken = resource.bookings.filter((b) => overlaps(start, end, b.start, b.end));
  const used = taken.reduce((sum, b) => sum + b.units, 0);
  return { free: Math.max(0, resource.available - used), taken };
}

/** 从 from 起向前后搜索，找到能放下 units 的最近整段档期开始日。 */
function nearestWindow(resource, duration, from, units = 1) {
  const first = "2027-01-01";
  const last = addDays("2027-12-31", -(duration - 1));
  for (let step = 1; step <= 365; step += 1) {
    for (const day of [addDays(from, step), addDays(from, -step)]) {
      if (day < first || day > last) continue;
      if (freeUnits(resource, day, addDays(day, duration - 1)).free >= units) return day;
    }
  }
  return null;
}

const rates = DATA.rates;
function unitPrice(resource, duration, card = rates) {
  const rate = card[resource.kind]?.[resource.level];
  if (!rate) return null;
  const factor = duration / 30 * (card.discount || 1);
  const media = { min: rate.min * factor, mid: rate.mid * factor, max: rate.max * factor };
  if (resource.kind === "bus") {
    const production = { min: card.busProductionMin, mid: card.busProductionMid, max: card.busProductionMax, pending: false, basis: "公交单车制作区间" };
    return { rate, media, production };
  }
  const known = Number.isFinite(resource.area);
  const fee = known ? resource.area * card.metroProductionPerSqm : 0;
  return { rate, media, production: { min: fee, mid: fee, max: fee, pending: !known,
    basis: known ? resource.area + "㎡ × " + card.metroProductionPerSqm + " 元/㎡" : "缺画面面积，待核" } };
}

module.exports = { DATA, zones, zoneName, resources, byId, freeUnits, nearestWindow, unitPrice, addDays, ms, iso, DAY, overlaps };
