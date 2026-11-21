const { test } = require("node:test");
const assert = require("node:assert/strict");
const { Readable } = require("node:stream");
const { mkdtempSync, rmSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const S = require("../lib/selfserve.cjs");
const D = require("../lib/dispatch.cjs");
const AI = require("../lib/ai.cjs");
const { openStore } = require("../store.cjs");
const { createApplication } = require("../server.cjs");

test("客户自助：七要素默认值生成公交加地铁方案，改预算与档期输出差异", () => {
  const first = S.plan({ budgetWan: 200 });
  assert.equal(first.status, "ready");
  assert.ok(first.counts.bus > 0 && first.counts.metro > 0, "公交加地铁");
  assert.ok(first.totals.total.max <= first.totals.cap, "上沿不超过预算扣缓冲");
  assert.equal(first.responses.length, 7, "七要素逐条回应");
  for (const key of ["items", "coverage", "schedule", "monitoring", "pending"]) assert.ok(first[key], key);
  assert.ok(first.items.every((item) => item.reason && item.cost.total.max > 0));
  assert.ok(first.schedule.nights.every((night) => night.bus <= 5 && night.metro <= 3));
  assert.ok(first.monitoring.kpis.some((k) => k.type === "估算") && first.monitoring.kpis.some((k) => k.type === "实际"), "估算与实际分列");

  const second = S.plan({ budgetWan: 100, startDate: "2027-06-05" });
  const diff = S.diff(first, second);
  assert.deepEqual(diff.fields.map((f) => f.label), ["预算（万元）", "开始日期"]);
  assert.ok(diff.kept.length && diff.removed.length, "保留与移除");
  assert.ok(diff.impact.totalMax.to < diff.impact.totalMax.from);
  assert.ok(diff.impact.coverage.to <= diff.impact.coverage.from);
  assert.notEqual(diff.impact.firstNight.from, diff.impact.firstNight.to, "排期影响");
  // 六月被合成占用的线路不能入选
  assert.ok(!second.items.some((item) => item.id === "bus:S911:L"));
  // 改档期产生同商圈替换
  const third = S.plan({ budgetWan: 200, startDate: "2027-07-05" });
  assert.ok(S.diff(first, third).replaced.length > 0, "地铁占用导致同商圈替换");
});

test("客户自助：必选资源冲突给出原因与替代，由客户自己调整", () => {
  const conflict = S.plan({ mustKeep: [{ id: "bus:S911:L", units: 2 }], startDate: "2027-06-05" });
  assert.equal(conflict.status, "conflict");
  const c = conflict.conflicts[0];
  assert.equal(c.code, "availability");
  assert.match(c.message, /可售 0.*合成占用/);
  assert.ok(c.options.some((o) => o.patch.startDate) && c.options.some((o) => o.patch.replaceMustKeep) && c.options.some((o) => o.patch.removeMustKeep));
  assert.equal(conflict.items.length, 0, "冲突时不自动删掉客户硬约束");
  const fixed = S.plan(S.applyPatch(conflict.brief, c.options.find((o) => o.patch.startDate).patch));
  assert.equal(fixed.status, "ready");
  assert.ok(fixed.items.find((i) => i.id === "bus:S911:L" && i.mustKeep && i.units === 2));

  const budget = S.plan({ budgetWan: 30, mustKeep: [{ id: "metro:jingan-1", units: 1 }, { id: "metro:lujiazui-1", units: 1 }] });
  assert.equal(budget.conflicts[0].code, "budget");
  assert.ok(budget.conflicts[0].options[0].patch.budgetWan > 30);
  const media = S.plan({ media: ["bus"], mustKeep: [{ id: "metro:jingan-1", units: 1 }] });
  assert.equal(media.conflicts[0].code, "media");
  assert.equal(S.plan({ budgetWan: 5 }).status, "invalid");
  assert.equal(S.plan({ startDate: "2027-12-20", duration: 30 }).status, "invalid");
  assert.equal(S.plan({ mode: "manual" }).conflicts[0].code, "manual");
});

test("执行调度：12 台候选、10 台起投、每晚 5 台；进保替补、误一补二、缺车与雨天缺口", () => {
  const config = D.defaultConfig();
  const fleet = D.syntheticFleet("S9DEMO", 12);
  const plan = D.schedule(config, fleet);
  assert.equal(plan.status, "ready");
  assert.equal(plan.assignments.length, 10);
  assert.ok(plan.nights.every((n) => n.vehicles.length <= 5));
  assert.equal(plan.nights.filter((n) => n.vehicles.length).length, 2);
  assert.equal(plan.standby.length, 1);
  assert.ok(plan.rules.source.includes("误"), "保留规则来源");
  const state = { config, fleet, plan };

  const out = plan.assignments[2].vehicle;
  const pre = D.preview(state, { type: "maintenance", vehicle: out, from: "2027-05-08", to: "2027-05-20" });
  assert.equal(pre.applicable, true);
  assert.equal(pre.delta.pairs.length, 1);
  assert.equal(pre.delta.pairs[0].out, out);
  assert.ok(pre.delta.pairs[0].in.startsWith("SYN-"));
  assert.equal(pre.delta.removed[0], out);
  assert.equal(pre.plan.assignments.length, 10);
  assert.ok(pre.tasks.length >= 4 && pre.tasks.every((t) => t.owner));
  assert.ok(pre.tasks.slice(1).every((t) => t.dependsOn.length), "任务先后");
  assert.match(pre.notice.body, new RegExp(pre.delta.pairs[0].in));
  assert.match(pre.notice.body, /草稿/);
  const kept = pre.plan.assignments.filter((a) => a.vehicle !== pre.delta.pairs[0].in);
  assert.ok(kept.every((a) => plan.assignments.find((b) => b.vehicle === a.vehicle).night === a.night), "未受影响车辆不改夜次");

  const live = D.preview(state, { type: "maintenance", vehicle: out, from: "2027-05-15", to: "2027-05-20" });
  assert.equal(live.delta.pairs[0].missedDays, 1);
  assert.equal(live.delta.pairs[0].makeGoodDays, 2, "误一补二");

  const tight = fleet.map((v, i) => i < 2 ? { ...v, status: "maintenance" } : v);
  const tightState = { config, fleet: tight, plan: D.schedule(config, tight) };
  const short = D.preview(tightState, { type: "maintenance", vehicle: tightState.plan.assignments[0].vehicle, from: "2027-05-08", to: "2027-05-12" });
  assert.equal(short.applicable, false);
  assert.equal(short.plan.shortfall.missingVehicles, 1);
  assert.match(short.plan.shortfall.message, /缺 1 台.*不发布/);
  assert.ok(short.plan.shortfall.options.length >= 2);

  const rain = D.preview(state, { type: "weather", from: "2027-05-07", dates: ["2027-05-07", "2027-05-08"] });
  assert.equal(rain.applicable, false);
  assert.equal(rain.plan.shortfall.missingNights, 1);
  assert.match(rain.plan.shortfall.options.join(), /提前 1 晚|单夜容量/);
  const drizzle = D.preview(state, { type: "weather", from: "2027-05-07", dates: ["2027-05-07"] });
  assert.equal(drizzle.applicable, true);
  assert.equal(drizzle.delta.moved.length, 5, "同车顺延");

  const late = fleet.map((v) => ({ ...v, depotReturn: "01:30" }));
  assert.equal(D.schedule(config, late).excluded.length, 12, "回场过晚不满足夜间窗口");
  assert.throws(() => D.preview(state, { type: "maintenance", vehicle: "NOPE", from: "2027-05-08" }));
  assert.equal(D.preview(state, { type: "client_revision", from: "2027-05-08" }).tasks[0].owner, "制作供应商", "其他类型复用入口");
});

test("AI：未配置、超时、越界数字都回退模板；通过校验才采用", async () => {
  const plan = S.plan({});
  const off = await AI.narrative(plan, null, {}, null);
  assert.equal(off.source, "template");
  assert.match(off.summary, /公交/);
  const env = { DEEPSEEK_API_KEY: "test", DEEPSEEK_MODEL: "test-model" };
  const reply = (content) => async () => ({ ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify(content) } }] }) });
  const good = await AI.narrative(plan, null, env, reply({ summary: "公交 " + plan.counts.bus + " 辆配合地铁 " + plan.counts.metro + " 处。", tradeoffs: ["优先保证商圈触点。"], reasons: { [plan.items[0].id]: "命中目标商圈。", bogus: "x" } }));
  assert.equal(good.source, "ai");
  assert.deepEqual(Object.keys(good.reasons), [plan.items[0].id]);
  const invented = await AI.narrative(plan, null, env, reply({ summary: "预计带来 98765 次到店。", tradeoffs: ["x"] }));
  assert.equal(invented.source, "template", "编造数字被拦截");
  const broken = await AI.narrative(plan, null, env, async () => { throw new Error("timeout"); });
  assert.equal(broken.source, "template");

  const rules = await AI.extract("某连锁咖啡品牌6月中旬上新品，静安和南京西路到店，上班族，预算150万，投一个月，公交和地铁，看核销", {}, null);
  assert.equal(rules.source, "rules");
  assert.equal(rules.prefill.budgetWan, 150);
  assert.equal(rules.prefill.startDate, "2027-06-11");
  assert.deepEqual(rules.prefill.media, ["bus", "metro"]);
  const ai = await AI.extract("预算两百万", env, reply({ budgetWan: 200, industry: "spaceship", campaignGoal: "visit", zones: [{ id: "nowhere" }] }));
  assert.equal(ai.source, "ai");
  assert.equal(ai.prefill.budgetWan, 200);
  assert.equal(ai.prefill.industry, undefined, "非法枚举丢弃");
  assert.equal(ai.prefill.zones, undefined);
  assert.ok(ai.missing.some((m) => m.key === "industry"), "缺失字段交给客户补充");

  const config = D.defaultConfig(), fleet = D.syntheticFleet();
  const view = D.preview({ config, fleet, plan: D.schedule(config, fleet) }, { type: "maintenance", vehicle: "SYN-03", from: "2027-05-08", to: "2027-05-20" });
  assert.equal((await AI.notice(view, {}, null)).source, "template");
  assert.equal((await AI.notice(view, env, reply({ subject: "调整说明", body: "SYN-03 由 SYN-77 替补。草稿，待负责人审阅" }))).source, "template", "虚构车辆编号被拦截");
  assert.equal((await AI.notice(view, env, reply({ subject: "调整说明", body: "SYN-03 由 " + view.delta.pairs[0].in + " 替补。草稿，待负责人审阅" }))).source, "ai");
});

test("在线流程：客户入口、草稿历史、分享导出、团队审核、调度变更、跨项目权限与重启恢复（AI 关闭）", async () => {
  const directory = mkdtempSync(join(tmpdir(), "flair-selfserve-"));
  const filename = join(directory, "app.sqlite");
  let store = openStore(filename);
  const env = { PUBLIC_ORIGIN: "https://flair.example.test" };
  let handler = createApplication(store, env);
  async function call(method, url, body, cookie) {
    const request = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]);
    Object.assign(request, { method, url, socket: { remoteAddress: "127.0.0.1" },
      headers: { origin: env.PUBLIC_ORIGIN, host: "flair.example.test", "x-flair-client": "1", "content-type": "application/json", cookie } });
    const result = { status: 0, headers: {} };
    await handler(request, {
      setHeader(k, v) { result.headers[k.toLowerCase()] = v; },
      writeHead(status, headers) { result.status = status; Object.assign(result.headers, headers); return this; },
      end(payload) {
        const text = typeof payload === "string" ? payload : payload && Buffer.from(payload).toString();
        result.body = String(result.headers["Content-Type"]).startsWith("application/json") && text ? JSON.parse(text) : text;
      },
    });
    return result;
  }
  const login = async (name, password) => {
    const r = await call("POST", "/api/session", { name, password });
    assert.equal(r.status, 200, name);
    return r.headers["set-cookie"].split(";")[0];
  };
  try {
    await store.bootstrap("admin", "test-only admin 2027");
    const admin = await login("admin", "test-only admin 2027");
    const a = (await call("POST", "/api/projects", { name: "咖啡新品案", industry: "food", brand: "某连锁咖啡品牌", campaign: "夏季新品", sample: true }, admin)).body;
    const b = (await call("POST", "/api/projects", { name: "银行网点案", industry: "bank", brand: "某区域银行", campaign: "网点认知", sample: true }, admin)).body;
    assert.equal((await call("POST", "/api/team", { name: "client.alpha", password: "client password 2027", role: "client", projects: [a.id] }, admin)).status, 201);
    assert.equal((await call("POST", "/api/team", { name: "client.beta", password: "client password 2027", role: "client", projects: [b.id] }, admin)).status, 201);
    assert.equal((await call("POST", "/api/team", { name: "ops.editor", password: "editor password 2027", role: "editor" }, admin)).status, 201);
    assert.match((await call("GET", "/client")).body, /客户自助提案/);
    assert.match((await call("GET", "/ops")).body, /执行调度/);
    assert.equal((await call("GET", "/assets/client.js")).status, 200);

    const alpha = await login("client.alpha", "client password 2027");
    const beta = await login("client.beta", "client password 2027");
    const editor = await login("ops.editor", "editor password 2027");
    assert.equal((await call("GET", "/api/projects", undefined, alpha)).status, 403, "客户不能进团队接口");
    assert.equal((await call("GET", "/api/projects/" + a.id, undefined, alpha)).status, 403);
    assert.equal((await call("GET", "/api/client/catalog", undefined, editor)).status, 403, "团队不走客户入口");
    const catalog = await call("GET", "/api/client/catalog", undefined, alpha);
    assert.equal(catalog.body.ai, false);
    const mine = (await call("GET", "/api/client/projects", undefined, alpha)).body;
    assert.deepEqual(mine.map((p) => p.id), [a.id], "只看到授权项目");
    assert.equal((await call("POST", "/api/client/projects/" + b.id + "/check", { brief: {} }, alpha)).status, 404, "跨项目不可见");

    const base = "/api/client/projects/" + a.id;
    const extracted = await call("POST", "/api/client/ai/extract", { text: "6月中旬，静安，预算150万，公交和地铁，看核销", anonymized: true }, alpha);
    assert.equal(extracted.body.source, "rules");
    const check = await call("POST", base + "/check", { brief: { mustKeep: [{ id: "bus:S911:L", units: 2 }], startDate: "2027-06-05" } }, alpha);
    assert.equal(check.body.plan.status, "conflict");
    assert.ok(check.body.inventory.find((r) => r.id === "bus:S911:L").free === 0);
    const refused = await call("POST", base + "/drafts", { brief: { mustKeep: [{ id: "bus:S911:L", units: 2 }], startDate: "2027-06-05" } }, alpha);
    assert.equal(refused.status, 422);
    assert.ok(refused.body.conflicts.length);

    const v1 = await call("POST", base + "/drafts", { brief: { budgetWan: 200, media: ["bus", "metro"] } }, alpha);
    assert.equal(v1.status, 201, JSON.stringify(v1.body));
    assert.equal(v1.body.seq, 1);
    for (const section of ["需求逐条回应", "推荐线路和点位", "覆盖证据", "费用明细", "投放与施工排期", "监测交付", "待复核事项"]) assert.match(v1.body.html, new RegExp(section));
    assert.equal(v1.body.narrative.source, "template");
    const share = await call("POST", "/api/client/drafts/" + v1.body.id + "/share", { days: 7 }, alpha);
    assert.equal(share.status, 201);
    const page = await call("GET", share.body.path);
    assert.equal(page.status, 200);
    assert.match(page.body, /已分享固定版本/);
    const v2 = await call("POST", base + "/drafts", { brief: { ...v1.body.brief, budgetWan: 100, startDate: "2027-06-05" }, parentId: v1.body.id }, alpha);
    assert.equal(v2.status, 201);
    assert.equal(v2.body.seq, 2);
    assert.ok(v2.body.diff.removed.length || v2.body.diff.replaced.length);
    assert.match(v2.body.html, /本次修改的影响/);
    assert.equal((await call("GET", share.body.path)).body, page.body, "已分享版本不随修改变化");
    const list = (await call("GET", base + "/drafts", undefined, alpha)).body;
    assert.deepEqual(list.map((d) => d.status), ["draft", "shared"]);

    const html = await call("GET", "/api/client/drafts/" + v2.body.id + "/export?format=html", undefined, alpha);
    assert.match(html.headers["Content-Disposition"], /attachment/);
    assert.match(html.body, /<style>/);
    assert.match((await call("GET", "/api/client/drafts/" + v2.body.id + "/export?format=csv", undefined, alpha)).body, /资源,类型/);
    assert.equal((await call("GET", "/api/client/drafts/" + v2.body.id + "/export?format=json", undefined, alpha)).body.seq, 2);
    assert.equal((await call("GET", "/api/client/drafts/" + v2.body.id, undefined, beta)).status, 404, "其他客户不可读");
    assert.equal((await call("POST", "/api/client/drafts/" + v2.body.id + "/submit", {}, alpha)).body.status, "submitted");

    const team = (await call("GET", "/api/projects/" + a.id + "/client-drafts", undefined, editor)).body;
    assert.equal(team.length, 2, JSON.stringify(team));
    assert.equal((await call("POST", "/api/projects/" + a.id + "/client-drafts/" + v2.body.id + "/review", { decision: "accepted", note: "进入正式报价" }, editor)).status, 200);
    const handoff = await call("GET", "/api/projects/" + a.id + "/handoff", undefined, editor);
    assert.equal(handoff.body.id, v2.body.id, "采纳版本直接成为调度交接版本");
    assert.ok(handoff.body.media.length && handoff.body.schedule.nights.length);
    assert.equal((await call("GET", "/api/projects/" + b.id + "/handoff", undefined, editor)).body, null);
    assert.equal((await call("GET", "/api/projects/" + a.id + "/handoff", undefined, alpha)).status, 403);
    assert.equal((await call("PUT", "/api/projects/" + a.id + "/map-evidence", { shareUrl: "https://example.test/track" }, editor)).status, 422);
    const geojson = { type: "FeatureCollection", features: [{ type: "Feature", properties: { kind: "bus", key: "926路" },
      geometry: { type: "LineString", coordinates: [[121.43, 31.21], [121.46, 31.2]] } }] };
    assert.equal((await call("PUT", "/api/projects/" + a.id + "/map-evidence", { geojson }, editor)).body.count, 1);
    assert.equal((await call("GET", "/api/projects/" + b.id + "/map-evidence", undefined, editor)).body, null);
    assert.equal((await call("GET", "/api/projects/" + b.id + "/client-drafts", undefined, editor)).body.length, 0, "草稿按项目隔离");

    const ops = "/api/projects/" + a.id;
    assert.equal((await call("PUT", ops + "/dispatch", { config: {}, fleet: [] }, editor)).status, 422, "缺车级台账");
    const disp = await call("PUT", ops + "/dispatch", { config: { minUnits: 10, perNight: 5 }, synthetic: true, count: 12 }, editor);
    assert.equal(disp.status, 200, JSON.stringify(disp.body));
    assert.equal(disp.body.plan.assignments.length, 10);
    assert.equal(disp.body.config.synthetic, true);
    const target = disp.body.plan.assignments[1].vehicle;
    const order = await call("POST", ops + "/changes", { type: "maintenance", vehicle: target, from: "2027-05-08", to: "2027-05-20" }, editor);
    assert.equal(order.status, 201);
    assert.equal(order.body.status, "pending");
    assert.equal(order.body.notice.source, "template");
    const viewer = await call("POST", ops + "/changes/" + order.body.id + "/apply", {}, alpha);
    assert.equal(viewer.status, 403, "客户不能应用变更");
    const rain = await call("POST", ops + "/changes", { type: "weather", from: "2027-05-07", dates: ["2027-05-07", "2027-05-08"] }, editor);
    assert.equal(rain.body.preview.applicable, false);
    assert.equal((await call("POST", ops + "/changes/" + rain.body.id + "/apply", {}, editor)).status, 422, "缺口方案不能发布");
    assert.equal((await call("PUT", ops + "/changes/" + order.body.id + "/notice", { subject: "调整说明", body: "已人工修改。草稿" }, editor)).status, 200);
    const applied = await call("POST", ops + "/changes/" + order.body.id + "/apply", {}, editor);
    assert.equal(applied.status, 200);
    assert.equal(applied.body.state.revision, 2);
    assert.ok(!applied.body.state.plan.assignments.some((x) => x.vehicle === target));
    assert.equal((await call("GET", ops + "/changes/" + rain.body.id, undefined, editor)).body.status, "stale", "旧预览过期");
    assert.equal((await call("POST", ops + "/changes/" + order.body.id + "/apply", {}, editor)).status, 409);

    store.db.close();
    store = openStore(filename);
    handler = createApplication(store, env);
    const again = (await call("GET", base + "/drafts", undefined, alpha)).body;
    assert.equal(again.length, 2, "重启后草稿仍在");
    assert.equal((await call("GET", ops + "/dispatch", undefined, editor)).body.state.revision, 2, "重启后调度仍在");
    assert.equal((await call("GET", share.body.path)).status, 200);
  } finally {
    store.db.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
