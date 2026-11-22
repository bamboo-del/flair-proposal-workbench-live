"use strict";

const assert = require("node:assert/strict");
const http = require("node:http");
const { once } = require("node:events");
const { test } = require("node:test");
const { openStore } = require("../store.cjs");
const { createApplication } = require("../server.cjs");

test("路演可匿名生成七要素、改预算档期并保留核心组合", async () => {
  const store = openStore(":memory:");
  const server = http.createServer(createApplication(store, {}));
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const origin = "http://127.0.0.1:" + server.address().port;
  const request = (path, body, headers = {}) => fetch(origin + path, body === undefined ? {} : {
    method: "POST",
    headers: { "content-type": "application/json", "x-flair-client": "1", ...headers },
    body: JSON.stringify(body),
  });

  try {
    const page = await request("/roadshow");
    assert.equal(page.status, 200);
    const html = await page.text();
    assert.match(html, /<h1>户外广告投放提案<\/h1>/);
    assert.doesNotMatch(html, /早高峰咖啡补给计划/);
    for (const step of ["assumptions", "media", "execution"]) {
      const route = await request("/roadshow/" + step);
      assert.equal(route.status, 200);
      assert.match(await route.text(), new RegExp('data-page="' + step + '"'));
    }
    const config = await (await request("/api/roadshow")).json();
    assert.equal(config.brief.brandType, "Manner Coffee");
    assert.equal(config.emptyBrief.brandType, "");
    assert.equal(config.emptyBrief.budgetWan, null);
    assert.equal(config.aiEnabled, false);
    const extracted = await (await request("/api/roadshow/extract", { text: config.briefText.replace("200万元", "100万元") })).json();
    assert.equal(extracted.brief.budgetWan, 100);
    assert.equal(extracted.brief.startDate, "2027-05-10");
    const ask = async (brief, previous) => {
      const result = await request("/api/roadshow/plan", { brief, previous });
      assert.equal(result.status, 200);
      return result.json();
    };
    const standard = await ask(config.brief);
    const small = await ask(extracted.brief, config.brief);
    const large = await ask({ ...config.brief, budgetWan: 500 }, config.brief);
    const shifted = await ask({ ...config.brief, startDate: "2027-06-05" }, config.brief);
    for (const { plan, budgetMix, elapsedMs } of [standard, small, large, shifted]) {
      assert.equal(plan.status, "ready");
      assert.equal(plan.responses.length, 7);
      assert.ok(plan.totals.total.max <= plan.totals.cap);
      assert.ok(budgetMix.reduce((sum, row) => sum + row.share, 0) > 0);
      assert.ok(elapsedMs >= 0);
    }
    assert.ok(small.diff.kept.length && small.diff.removed.length);
    assert.ok(large.diff.kept.length && large.diff.added.length);
    const timeAndBudget = (result) => result.plan.responses.find((row) => row.key === "budget");
    assert.match(timeAndBudget(standard).need, /预算 200 万元/);
    assert.match(timeAndBudget(large).need, /预算 500 万元/);
    assert.match(timeAndBudget(large).answer, /未分配/);
    assert.deepEqual(large.plan.window, standard.plan.window);
    const businessNote = "要在工作日晚高峰面向通勤者推广新服务。\n".repeat(35).trim();
    const expanded = await ask({ ...config.brief, businessNote, budgetWan: 100,
      zones: config.zones.map(({ id }) => ({ id, priority: false })) });
    assert.equal(expanded.plan.responses.find((row) => row.key === "business").need, "门店引流：" + businessNote);
    const audienceResponse = expanded.plan.responses.find((row) => row.key === "audience").answer;
    assert.match(audienceResponse, /未命中：.*实际人群触达待监测。/);
    assert.doesNotMatch(audienceResponse, /100%/);
    assert.notEqual(shifted.diff.impact.firstNight.to, shifted.diff.impact.firstNight.from);
    assert.equal(shifted.plan.window.end, "2027-07-04");
    assert.equal((await request("/api/roadshow/plan", { brief: { ...config.brief, startDate: "2026-05-10" } })).status, 422);
    assert.equal((await request("/api/roadshow/plan", { brief: config.brief }, { origin: "https://example.invalid" })).status, 403);
    assert.equal((await request("/api/projects")).status, 401);
    const inventory = await (await request("/api/roadshow/inventory", { brief: config.brief })).json();
    assert.equal(inventory.status, "disabled");
    const narrative = await (await request("/api/roadshow/ai", { brief: config.brief })).json();
    assert.equal(narrative.source, "template");
  } finally {
    await new Promise((resolve) => server.close(resolve));
    store.db.close();
  }
});
