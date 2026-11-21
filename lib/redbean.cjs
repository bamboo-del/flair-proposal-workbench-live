"use strict";

const API = "https://flairmedia.com.cn:881/admin-api";
const stationAliases = {
  jingan: "静安寺",
  nanjing_west: "南京西路",
  nanjing_east: "南京东路",
  huaihai: "淮海中路",
  xuhui: "徐家汇",
  xujiahui: "徐家汇",
  lujiazui: "陆家嘴",
  "静安": "静安寺",
  "淮海": "淮海中路",
};
const clean = (value) => typeof value === "string" ? value.trim().slice(0, 36) : "";
const values = (value) => Array.isArray(value) ? value.slice(0, 5) : [];
const grades = new Set(["S", "A++", "A+", "AA", "A"]);
const formats = new Set(["车身三侧", "大三侧", "全色车"]);
const busLine = (name) => name.replace(/^(?:公交|巴士)\s*/, "").replace(/\s*路$/, "");

function day(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const ms = Date.parse(value);
  return Number.isFinite(ms) && new Date(ms).toISOString().slice(0, 10) === value;
}

function searches(media, targets) {
  const queues = { bus: new Set(), metro: new Set() };
  function add(kind, input) {
    const name = clean(input);
    if (!name || /^S\d+$/i.test(name)) return;
    if (kind === "metro") queues.metro.add(Object.hasOwn(stationAliases, name) ? stationAliases[name] : name);
    else queues.bus.add(busLine(name));
  }
  for (const target of values(targets)) {
    if (typeof target === "string") {
      const name = clean(target);
      if (/^(?:(?:公交|巴士)\s*)?\d{1,4}\s*(?:路)?$/.test(name)) add("bus", name);
      else add("metro", name);
    } else if (target && typeof target === "object") {
      for (const line of values(target.busLines)) add("bus", line);
      for (const keyword of (Array.isArray(target.metroKeywords) ? values(target.metroKeywords) : [target.name])) add("metro", keyword);
    }
  }
  const modes = values(media);
  return ["bus", "metro"].filter((mode) => modes.includes(mode))
    .flatMap((mode) => [...queues[mode]].filter(Boolean).slice(0, 5).map((name) => ({ mode, name })));
}

function publicRows(mode, query, rows) {
  return rows.flatMap((row) => {
    if (!row || !Number.isInteger(row.freeCount) || row.freeCount < 0) return [];
    const line = clean(row.lineName);
    const label = clean(mode === "bus" ? row.mediaName || row.mediatypename : row.exitName);
    if (mode === "bus" ? busLine(line) !== query : (!label || ![label, line].some((part) => part.includes(query)))) return [];
    const grade = grades.has(row.lineLevel) ? row.lineLevel : null;
    const format = mode === "bus" && formats.has(label) ? label : null;
    const route = /^\d+$/.test(line) ? line + "路" : line;
    const exit = /^\d+[A-Z]?$/i.test(label) ? label + "号口" : label;
    const name = mode === "bus" ? [route, label].filter(Boolean).join(" · ") : [line && !exit.includes(line) ? line : "", exit].filter(Boolean).join(" · ");
    const area = clean(row.districtname);
    if (!name) return [];
    return [{ mode, query, name, ...(area ? { area } : {}), ...(grade ? { grade } : {}), ...(format ? { format } : {}), freeCount: row.freeCount }];
  });
}

function createRedbean(env, request = fetch) {
  const configured = Boolean(env.REDBEAN_USERNAME && env.REDBEAN_PASSWORD && env.REDBEAN_CLIENT_ID && env.REDBEAN_CLIENT_SECRET);
  const clientAuth = configured && "Basic " + Buffer.from(env.REDBEAN_CLIENT_ID + ":" + env.REDBEAN_CLIENT_SECRET).toString("base64");
  const timeout = Math.min(8000, Math.max(500, Number(env.REDBEAN_TIMEOUT_MS) || 2200));
  const headers = { "tenant-id": "1" };
  const recent = new Map();
  const pending = new Map();
  let token;
  let authenticating;
  const result = (status, note) => ({ status, candidates: [], note });

  async function login() {
    const response = await request(API + "/system/oauth2/token", {
      method: "POST",
      redirect: "error",
      signal: AbortSignal.timeout(timeout),
      headers: { ...headers, "content-type": "application/x-www-form-urlencoded", authorization: clientAuth },
      body: new URLSearchParams({ grant_type: "password", username: env.REDBEAN_USERNAME, password: env.REDBEAN_PASSWORD }),
    });
    if (!response.ok) throw new Error("Redbean OAuth unavailable");
    const body = await response.json();
    const { access_token: value, expires_in: seconds } = body?.data || {};
    if (body?.code !== 0 || typeof value !== "string" || !value) throw new Error("Redbean OAuth rejected");
    token = { value, expires: Date.now() + Math.max(1000, (Number(seconds) || 60) * 1000 - 10000) };
    return token;
  }

  function accessToken() {
    if (token?.expires > Date.now()) return Promise.resolve(token);
    if (!authenticating) authenticating = login().finally(() => { authenticating = undefined; });
    return authenticating;
  }

  async function inventory(search, start, end, account, retry = true) {
    const { mode, name } = search;
    const filter = mode === "bus" ? "lineName" : "keyword";
    const params = new URLSearchParams({ pageNo: "1", pageSize: "20", startDate: start, endDate: end, [filter]: name });
    const response = await request(API + "/orders/media-inventory/" + mode + "/page?" + params, {
      redirect: "error",
      signal: AbortSignal.timeout(timeout),
      headers: { ...headers, authorization: "Bearer " + account.value },
    });
    const body = response.ok ? await response.json() : null;
    if (retry && (response.status === 401 || body?.code === 401)) {
      if (token === account) token = undefined;
      return inventory(search, start, end, await accessToken(), false);
    }
    if (!response.ok || body?.code !== 0 || !Array.isArray(body.data?.list)) throw new Error("Redbean inventory unavailable");
    return publicRows(mode, name, body.data.list.slice(0, 20)).sort((a, b) => b.freeCount - a.freeCount).slice(0, 4);
  }

  async function query(checks, start, end, media) {
    let account;
    try { account = await accessToken(); }
    catch { return result("unavailable", "红豆库存鉴权暂未成功，库存待复核。"); }
    const answers = await Promise.allSettled(checks.map((check) => inventory(check, start, end, account)));
    const successful = answers.filter((answer) => answer.status === "fulfilled");
    if (!successful.length) return result("unavailable", "红豆未返回本档期库存，需待复核。");
    const unique = new Map();
    for (const row of successful.flatMap((answer) => answer.value)) {
      const key = JSON.stringify([row.mode, row.name, row.area]);
      if (!unique.has(key)) unique.set(key, row);
    }
    const ranked = [...unique.values()].sort((a, b) => b.freeCount - a.freeCount);
    const pick = (mode, limit) => {
      const rows = ranked.filter((row) => row.mode === mode);
      const byQuery = new Map();
      for (const row of rows) if (row.freeCount > 0 && !byQuery.has(row.query)) byQuery.set(row.query, row);
      return [...new Set([...byQuery.values(), ...rows])].slice(0, limit);
    };
    const limit = checks.some((check) => check.mode === "bus") && checks.some((check) => check.mode === "metro") ? 5 : 8;
    const candidates = [...pick("bus", limit), ...pick("metro", limit)];
    const notes = [
      "按完整投放档期查询红豆，以下为本次小批库存候选，尚未锁位。",
      !candidates.length && "已查询的首批结果没有精确匹配。",
      media.includes("bus") && !checks.some((check) => check.mode === "bus") && "公交需指定线路后核查。",
      media.includes("metro") && !checks.some((check) => check.mode === "metro") && "地铁需指定车站或出入口后核查。",
      successful.length < checks.length && "有 " + (checks.length - successful.length) + " 项查询未返回，需待复核。",
    ];
    return {
      status: "verified",
      asOf: new Date().toISOString(),
      partial: successful.length < checks.length || ["bus", "metro"].some((mode) => media.includes(mode) && !checks.some((check) => check.mode === mode)),
      candidates,
      note: notes.filter(Boolean).join(" "),
    };
  }

  function lookup({ start, end, media, targets } = {}) {
    if (!configured) return Promise.resolve(result("disabled", "红豆库存服务未配置。"));
    if (!day(start) || !day(end) || end < start || Date.parse(end) - Date.parse(start) > 366 * 86400000) {
      return Promise.resolve(result("unavailable", "请确认完整投放起止日期。"));
    }
    const modes = values(media);
    const checks = searches(modes, targets);
    if (!checks.length) return Promise.resolve(result("unavailable", "请提供可核查的具体公交线路或地铁站名。"));
    const key = JSON.stringify([start, end, modes, checks]);
    const cached = recent.get(key);
    if (cached?.expires > Date.now()) return Promise.resolve(cached.result);
    if (pending.has(key)) return pending.get(key);
    if (pending.size >= 32) return Promise.resolve(result("unavailable", "红豆库存核查繁忙，请稍后重试。"));
    const work = query(checks, start, end, modes).then((data) => {
      if (data.status === "verified") {
        if (recent.size >= 80) recent.delete(recent.keys().next().value);
        recent.set(key, { result: data, expires: Date.now() + (data.partial ? 15000 : 60000) });
      }
      return data;
    }).finally(() => pending.delete(key));
    pending.set(key, work);
    return work;
  }
  return { lookup };
}

module.exports = { createRedbean };
