"use strict";

const { shareId } = require("./platform-map.cjs");
const normalizeName = (name) => String(name || "").normalize("NFKC").toLowerCase().replace(/[\s·・]/g, "").replace(/路$/, "");
const text = (value, limit) => typeof value === "string" ? value.trim().slice(0, limit) : "";
const publicExits = [
  ["陆家嘴 · 2号口", "BT10017063", 121.502095, 31.238446],
  ["南京西路 · 4号口", "BT10017057", 121.459424, 31.229254],
  ["静安寺 · 8号口", "BX10016967", 121.449308, 31.222208],
  ["徐家汇 · 1号口", "BT10016153", 121.437006, 31.189314],
];

function baiduCoordinate(lon, lat) {
  const xPi = Math.PI * 3000 / 180;
  const distance = Math.hypot(lon, lat) + 0.00002 * Math.sin(lat * xPi);
  const bearing = Math.atan2(lat, lon) + 0.000003 * Math.cos(lon * xPi);
  return [distance * Math.cos(bearing) + 0.0065, distance * Math.sin(bearing) + 0.006];
}

function checkedMap(input) {
  if (!input || typeof input !== "object") throw new Error("地图资料格式有误。");
  const shareUrl = input.shareUrl ? shareId(input.shareUrl).shareUrl : "";
  const metroShareUrl = input.metroShareUrl ? shareId(input.metroShareUrl).shareUrl : "";
  const rows = input.geojson?.features || [];
  if (!Array.isArray(rows) || rows.length > 250 || (input.geojson && input.geojson.type !== "FeatureCollection")) throw new Error("请使用 WGS84 GeoJSON FeatureCollection，最多 250 个要素。");
  let vertices = 0;
  function position(value) {
    if (!Array.isArray(value) || !Number.isFinite(value[0]) || !Number.isFinite(value[1]) ||
      value[0] < 119 || value[0] > 124 || value[1] < 28 || value[1] > 34 || ++vertices > 30000) throw new Error("坐标不在上海附近或总坐标数超限，请检查经纬度顺序和 WGS84 坐标系。");
    return [value[0], value[1]];
  }
  const features = rows.map((feature) => {
    const props = feature.properties || {};
    const kind = props.kind;
    const key = text(props.key || props.name, 140);
    const name = text(props.name || props.key, 140);
    const geom = feature.geometry || {};
    if (feature.type !== "Feature" || !["bus", "metro"].includes(kind) || !key || !name) throw new Error("每个要素须填写媒体类型 kind 和精确的线路或点位名 key。");
    const segment = (list) => {
      if (!Array.isArray(list) || list.length < 2) throw new Error("线路至少需要两个坐标。");
      return list.map(position);
    };
    let coordinates;
    if (geom.type === "Point" && kind === "metro") coordinates = position(geom.coordinates);
    else if (geom.type === "LineString") coordinates = segment(geom.coordinates);
    else if (geom.type === "MultiLineString" && Array.isArray(geom.coordinates) && geom.coordinates.length) coordinates = geom.coordinates.map(segment);
    else throw new Error("仅支持公交线路、地铁线路和地铁点位的几何类型。");
    return { kind, key, name, type: geom.type, coordinates };
  });
  return { shareUrl, metroShareUrl, features, source: text(input.source, 160) || "团队导入的大数据平台线路资料" };
}

function selectMap(evidence, items) {
  if (!evidence) return null;
  const keys = new Set();
  for (const item of items) {
    keys.add(item.kind + normalizeName(item.name));
    if (item.kind === "bus") keys.add(item.kind + normalizeName(item.query || item.name.split("·")[0]));
  }
  const hasMetro = items.some((item) => item.kind === "metro");
  const features = evidence.features.filter((feature) => keys.has(feature.kind + normalizeName(feature.key)) || (hasMetro && feature.reference));
  if (evidence.coordinateSystem === "BD09") {
    for (const [name, poi, lon, lat] of publicExits) {
      const key = normalizeName(name);
      if (keys.has("metro" + key) && !features.some((feature) => feature.kind === "metro" && normalizeName(feature.key) === key)) {
        features.push({ kind: "metro", key: name, name, type: "Point", coordinates: baiduCoordinate(lon, lat),
          sourceUrl: `https://ditu.amap.com/place/${poi}` });
      }
    }
  }
  return { source: evidence.source, shareUrl: evidence.shareUrl, metroShareUrl: evidence.metroShareUrl, features, unmatched: items.filter((item) => !features.some((f) => f.kind === item.kind &&
    [item.name, ...(item.kind === "bus" ? [item.query || item.name.split("·")[0]] : [])].some((name) => normalizeName(name) === normalizeName(f.key)))).map((item) => item.name) };
}

module.exports = { checkedMap, selectMap };
