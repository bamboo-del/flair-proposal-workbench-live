"use strict";

const assert = require("node:assert/strict");
const { test } = require("node:test");
const { createRedbean } = require("../lib/redbean.cjs");
const { inventoryTargets, inventoryPlan } = require("../lib/roadshow-inventory.cjs");
const S = require("../lib/selfserve.cjs");

const env = {
  REDBEAN_USERNAME: "mock-user",
  REDBEAN_PASSWORD: "mock-password",
  REDBEAN_CLIENT_ID: "mock-client",
  REDBEAN_CLIENT_SECRET: "mock-secret",
};
const range = { start: "2027-05-10", end: "2027-06-08" };
const token = (value) => Response.json({ code: 0, data: { access_token: value, expires_in: 1800 } });
const inventory = (list) => Response.json({ code: 0, data: { total: list.length, list } });

test("红豆使用完整档期及窄查询；缓存同批请求，只输出可展示的库存字段", async () => {
  let loginCount = 0;
  const queries = [];
  const redbean = createRedbean(env, async (url, options) => {
    const path = new URL(url);
    assert.equal(path.origin, "https://flairmedia.com.cn:881");
    assert.equal(options.headers["tenant-id"], "1");
    if (path.pathname.endsWith("/token")) {
      loginCount++;
      assert.equal(options.method, "POST");
      assert.equal(options.headers.authorization, "Basic " + Buffer.from("mock-client:mock-secret").toString("base64"));
      assert.deepEqual(Object.fromEntries(options.body), { grant_type: "password", username: "mock-user", password: "mock-password" });
      return token("mock-access");
    }
    queries.push(path);
    assert.equal(options.headers.authorization, "Bearer mock-access");
    assert.equal(path.searchParams.get("startDate"), range.start);
    assert.equal(path.searchParams.get("endDate"), range.end);
    if (path.pathname.includes("/bus/")) {
      assert.equal(path.searchParams.get("lineName"), "100");
      return inventory([
        { lineName: "1000", mediatypename: "广告", freeCount: 20 },
        { lineName: "100路", mediaName: "大三侧", lineLevel: "1", freeCount: 3, resourceId: "redacted", order: "redacted", contractCount: 4 },
      ]);
    }
    assert.equal(path.searchParams.get("keyword"), "静安寺");
    return inventory([{ lineName: "静安寺", exitName: "2", districtname: "静安区", freeCount: 1, customerName: "redacted" }]);
  });
  const input = { ...range, media: ["bus", "metro"], targets: ["100路", "jingan", "S913"] };
  const [first, concurrent] = await Promise.all([redbean.lookup(input), redbean.lookup(input)]);
  assert.strictEqual(first, concurrent);
  assert.strictEqual(first, await redbean.lookup(input));
  assert.equal(loginCount, 1);
  assert.equal(queries.length, 2);
  assert.equal(first.status, "verified");
  assert.equal(first.partial, false);
  assert.ok(Number.isFinite(Date.parse(first.asOf)));
  assert.deepEqual(first.candidates, [
    { mode: "bus", query: "100", name: "100路 · 大三侧", format: "大三侧", freeCount: 3 },
    { mode: "metro", query: "静安寺", name: "静安寺 · 2号口", area: "静安区", freeCount: 1 },
  ]);
  assert.match(first.note, /尚未锁位/);
});

test("红豆刷新过期令牌一次，保留已查到的部分候选；无配置、无明确目标均不请求", async () => {
  let loginCount = 0;
  let tryCount = 0;
  const provider = async (url, options) => {
    if (url.endsWith("/token")) return token("token-" + (++loginCount));
    tryCount++;
    if (options.headers.authorization === "Bearer token-1") return new Response(null, { status: 401 });
    if (new URL(url).searchParams.get("keyword") === "静安寺") return inventory([{ lineName: "静安寺", exitName: "演示出口", freeCount: 0 }]);
    return new Response(null, { status: 503 });
  };
  const redbean = createRedbean(env, provider);
  assert.equal((await createRedbean({}, provider).lookup()).status, "disabled");
  assert.equal((await redbean.lookup({ ...range, media: ["bus"], targets: ["S913"] })).status, "unavailable");
  assert.equal((await redbean.lookup({ ...range, start: "2027-04-31", media: ["metro"], targets: ["静安寺"] })).status, "unavailable");
  assert.equal(loginCount, 0);
  assert.equal(tryCount, 0);
  const result = await redbean.lookup({ ...range, media: ["bus", "metro"], targets: ["静安寺", "南京西路"] });
  assert.equal(loginCount, 2);
  assert.equal(tryCount, 4);
  assert.equal(result.status, "verified");
  assert.equal(result.partial, true);
  assert.deepEqual(result.candidates, [{ mode: "metro", query: "静安寺", name: "静安寺 · 演示出口", freeCount: 0 }]);
  assert.match(result.note, /公交需指定线路/);
  assert.match(result.note, /有 1 项查询未返回/);
});

test("路演选点只使用已查询的正库存，未确认等级按 A+ 档估算，施工留出缓冲", () => {
  const brief = { ...S.defaults(), startDate: range.start, zones: [{ id: "jingan", priority: true }, { id: "nanjing_west" }] };
  assert.deepEqual(inventoryTargets(brief), [
    { busLines: ["926"], metroKeywords: ["静安寺"] },
    { busLines: ["926"], metroKeywords: ["南京西路"] },
  ]);
  const bus = { mode: "bus", query: "926", name: "926路 · 大三侧", format: "大三侧", freeCount: 2 };
  const metro = { mode: "metro", query: "南京西路", name: "南京西路 · 5号口", freeCount: 3 };
  const live = { status: "verified", asOf: "2026-11-21T09:00:00Z", candidates: [
    bus, metro,
    { mode: "bus", query: "955", name: "无关线路", freeCount: 3 },
    { mode: "metro", query: "静安寺", name: "无空位出入口", freeCount: 0 },
  ] };
  const plan = inventoryPlan(brief, live, { executionBufferNights: 2 });
  assert.equal(plan.synthetic, false);
  assert.equal(plan.inventoryAsOf, live.asOf);
  assert.deepEqual(plan.counts, { bus: 2, metro: 1 });
  assert.ok(plan.items.every((row) => row.source === "redbean" && row.level === "待核" && row.estimateLevel === "A+"));
  assert.match(plan.coverage.basis, /门店步行距离及实际到达待核/);
  assert.equal(plan.schedule.nights.at(-1).day, "2027-05-07");
  assert.equal(plan.schedule.phases[4].name, "上线前执行缓冲（2 晚）");
  assert.equal(inventoryPlan(brief, { ...live, candidates: [metro] }), null);
  assert.equal(S.plan(brief).synthetic, true);
  assert.equal(S.plan(brief).schedule.nights.at(-1).day, "2027-05-09");
});
