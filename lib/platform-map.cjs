"use strict";

const origin = "https://flairmedia.com.cn:38880";

function shareId(value) {
  const url = new URL(value);
  const id = url.searchParams.get("webId");
  if (url.origin !== origin || !["/busLineShow", "/busLineShowStation"].includes(url.pathname) || url.username || url.password || !/^\d{12,24}$/.test(id || "")) {
    throw new Error("请输入大数据平台授权的线路预览链接。");
  }
  return { id, shareUrl: `${origin}${url.pathname}?webId=${id}` };
}

function createPlatformMap(request = fetch) {
  const cache = new Map();
  async function json(path, query, success = 200) {
    const url = new URL(path, origin);
    url.search = new URLSearchParams(query);
    const response = await request(url.href, { redirect: "error", signal: AbortSignal.timeout(4500) });
    if (!response.ok) throw new Error("大数据平台暂时无法返回授权地图。");
    const body = await response.json();
    if (Number(body.code) !== success) throw new Error("授权地图已过期或不能外部访问。");
    return body;
  }

  async function read(id, shareUrl) {
    const metadata = await json("/baseInfoWeb/getWebById", { webId: id });
    const lines = metadata.data?.lineList;
    if (!Array.isArray(lines) || lines.length > 24) throw new Error("授权地图没有可导入的线路，或线路太多。");
    const features = [];
    for (let index = 0; index < lines.length; index += 4) {
      const batch = await Promise.allSettled(lines.slice(index, index + 4).map(async ({ linePath, lineName, staLocaltion, staName }) => {
        if (typeof staName === "string" && typeof staLocaltion === "string") {
          const coordinates = staLocaltion.split(",").slice(0, 2).map(Number);
          if (coordinates[0] >= 119 && coordinates[0] <= 124 && coordinates[1] >= 28 && coordinates[1] <= 34) {
            return { kind: "metro", key: staName, name: staName, type: "Point", coordinates };
          }
        }
        if (typeof linePath !== "string" || !linePath || linePath.length > 400 || typeof lineName !== "string") return null;
        const shape = await json("/baseInfoLine/getLineJson", { linePath }, 0);
        const row = typeof shape.data === "string" ? JSON.parse(shape.data) : shape.data;
        if (row?.type === "GPS" || !Array.isArray(row?.path)) return null;
        const coordinates = row.path.map(({ lat, lng }) => [Number(lat), Number(lng)]);
        if (coordinates.length < 2 || coordinates.some(([lon, lat]) => !(lon >= 119 && lon <= 124 && lat >= 28 && lat <= 34))) return null;
        return { kind: /地铁|轨交|^\d+号线/.test(lineName) ? "metro" : "bus", key: lineName, name: lineName, type: "LineString", coordinates };
      }));
      features.push(...batch.flatMap((part) => part.status === "fulfilled" && part.value ? [part.value] : []));
    }
    return { shareUrl, source: "新云大数据平台授权线路，百度地图坐标", coordinateSystem: "BD09", features };
  }

  return async (value) => {
    const { id, shareUrl } = shareId(value);
    const existing = cache.get(shareUrl);
    if (existing?.until > Date.now()) return existing.pending;
    if (cache.size >= 20) cache.delete(cache.keys().next().value);
    const pending = read(id, shareUrl).catch((error) => { cache.delete(shareUrl); throw error; });
    cache.set(shareUrl, { pending, until: Date.now() + 60000 });
    return pending;
  };
}

module.exports = { createPlatformMap, shareId };
