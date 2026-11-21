"use strict";
/*
 * 客户自助入口（/api/client/*，仅 client 角色）与执行调度、变更单（/api/projects/:id/dispatch|changes，团队角色）。
 * 客户只能访问被授权的项目和自己生成的草稿；正式报价、锁位、应用变更都在团队侧完成。
 */
const S = require("./selfserve.cjs");
const D = require("./dispatch.cjs");
const AI = require("./ai.cjs");
const R = require("./render.cjs");
const ClientPlanning = require("./client-planning.cjs");
const { checkedMap, selectMap } = require("./map-evidence.cjs");
const { createPlatformMap } = require("./platform-map.cjs");

const idPattern = /^[a-zA-Z0-9_-]{32}$/;

function migrate(run) {
  run(`CREATE TABLE IF NOT EXISTS client_access (
    name TEXT NOT NULL REFERENCES users(name) ON DELETE CASCADE, project_id TEXT NOT NULL REFERENCES projects(id), created TEXT NOT NULL,
    PRIMARY KEY (name, project_id))`);
  run(`CREATE TABLE IF NOT EXISTS client_drafts (
    id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id), owner TEXT NOT NULL, parent_id TEXT, seq INTEGER NOT NULL,
    title TEXT NOT NULL, brief TEXT NOT NULL, plan TEXT NOT NULL, diff TEXT, narrative TEXT, created TEXT NOT NULL,
    shared_at TEXT, submitted_at TEXT, review TEXT)`);
  run(`CREATE TABLE IF NOT EXISTS draft_shares (
    digest TEXT PRIMARY KEY, draft_id TEXT NOT NULL REFERENCES client_drafts(id), expires INTEGER NOT NULL, revoked INTEGER NOT NULL DEFAULT 0, created TEXT NOT NULL)`);
  run(`CREATE TABLE IF NOT EXISTS project_handoffs (
    project_id TEXT PRIMARY KEY REFERENCES projects(id), draft_id TEXT NOT NULL REFERENCES client_drafts(id), adopted TEXT NOT NULL, adopted_by TEXT NOT NULL)`);
  run(`CREATE TABLE IF NOT EXISTS project_maps (
    project_id TEXT PRIMARY KEY REFERENCES projects(id), payload TEXT NOT NULL, updated TEXT NOT NULL, updated_by TEXT NOT NULL)`);
  run(`CREATE TABLE IF NOT EXISTS dispatch (
    project_id TEXT PRIMARY KEY REFERENCES projects(id), config TEXT NOT NULL, fleet TEXT NOT NULL, plan TEXT NOT NULL,
    revision INTEGER NOT NULL, updated TEXT NOT NULL, updated_by TEXT NOT NULL)`);
  run(`CREATE TABLE IF NOT EXISTS change_orders (
    id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id), base_revision INTEGER NOT NULL, type TEXT NOT NULL,
    input TEXT NOT NULL, preview TEXT NOT NULL, notice TEXT NOT NULL, status TEXT NOT NULL, created TEXT NOT NULL, author TEXT NOT NULL,
    decided TEXT, decided_by TEXT)`);
}

function createRoutes({ store, env, request, fail, json, readJson, useLimit }) {
  const { get, query, run, date, secret, hash } = store;
  migrate(run);
  const aiAttempts = new Map();
  const prepare = ClientPlanning.createClientPlanning(env, request);
  const authorizedMap = createPlatformMap(request);
  const mapFor = (id) => get("SELECT payload,updated,updated_by FROM project_maps WHERE project_id=?", id);
  const send = (res, status, type, content, filename) => res.writeHead(status, {
    "Content-Type": type + "; charset=utf-8", ...(filename ? { "Content-Disposition": "attachment; filename*=UTF-8''" + encodeURIComponent(filename) } : {}),
  }).end(content);

  const draftRow = (row) => row && {
    id: row.id, projectId: row.project_id, owner: row.owner, parentId: row.parent_id, seq: row.seq, title: row.title, created: row.created,
    shared: Boolean(row.shared_at), submitted: Boolean(row.submitted_at), review: row.review ? JSON.parse(row.review) : null,
    status: row.submitted_at ? "submitted" : row.shared_at ? "shared" : "draft",
    brief: JSON.parse(row.brief), plan: JSON.parse(row.plan), diff: row.diff ? JSON.parse(row.diff) : null, narrative: row.narrative ? JSON.parse(row.narrative) : null,
  };
  const summary = (d) => ({ id: d.id, seq: d.seq, title: d.title, parentId: d.parentId, created: d.created, status: d.status, owner: d.owner, review: d.review,
    budgetWan: d.brief.budgetWan, window: d.plan.window, counts: d.plan.counts, total: [Math.round(d.plan.totals.total.min), Math.round(d.plan.totals.total.max)], coverage: d.plan.coverage.percent });
  const withHtml = (d) => ({ ...d, html: R.body(d) });

  function grantedProject(name, id) {
    if (!idPattern.test(id || "")) return null;
    return get("SELECT p.id,p.name,p.state FROM client_access a JOIN projects p ON p.id=a.project_id WHERE a.name=? AND a.project_id=? AND p.archived=0", name, id);
  }
  function ownDraft(name, id) {
    if (!idPattern.test(id || "")) return null;
    const row = get("SELECT d.* FROM client_drafts d JOIN client_access a ON a.project_id=d.project_id AND a.name=d.owner JOIN projects p ON p.id=d.project_id WHERE d.id=? AND d.owner=? AND p.archived=0", id, name);
    return draftRow(row);
  }
  function exportDraft(res, d, format) {
    const base = "提案草稿-v" + d.seq;
    if (format === "json") return send(res, 200, "application/json", JSON.stringify({ title: d.title, seq: d.seq, created: d.created, brief: d.brief, plan: d.plan, diff: d.diff, narrative: d.narrative }, null, 2), base + ".json");
    if (format === "csv") return send(res, 200, "text/csv", R.csv(d), base + "-资源清单.csv");
    return send(res, 200, "text/html", R.standalone(d), base + ".html");
  }

  async function client(req, res, url, p, me) {
    const method = req.method;
    if (p[2] === "catalog" && method === "GET") return json(res, { ...S.catalog(), ai: AI.configured(env) });
    if (p[2] === "ai" && p[3] === "extract" && method === "POST") {
      const input = await readJson(req, 12000);
      const text = typeof input?.text === "string" ? input.text.trim().slice(0, 2000) : "";
      if (!text || input.anonymized !== true) fail(422, "请填写需求并确认已去除真实客户名与联系方式。");
      useLimit(aiAttempts, me.name, 10, 60000);
      return json(res, await AI.extract(text, env, request));
    }
    if (p[2] === "projects" && p.length === 3 && method === "GET") {
      return json(res, query("SELECT p.id,p.name,p.state FROM client_access a JOIN projects p ON p.id=a.project_id WHERE a.name=? AND p.archived=0 ORDER BY p.updated DESC", me.name)
        .map((row) => { const state = JSON.parse(row.state); return { id: row.id, name: row.name, brand: state.brand, industry: state.industry,
          sample: state.sample === true, defaults: ClientPlanning.defaults(row) }; }));
    }
    if (p[2] === "projects") {
      const project = grantedProject(me.name, p[3]);
      if (!project) fail(404, "项目不存在或未授权。");
      if (p[4] === "check" && method === "POST") {
        const input = await readJson(req, 60000);
        return json(res, await prepare(project, input));
      }
      if (p[4] === "drafts" && method === "GET") {
        return json(res, query("SELECT * FROM client_drafts WHERE project_id=? AND owner=? ORDER BY seq DESC", project.id, me.name).map(draftRow).map(summary));
      }
      if (p[4] === "drafts" && method === "POST") {
        const input = await readJson(req, 60000);
        const { plan } = await prepare(project, input);
        if (plan.status === "invalid") fail(422, "请检查表单：" + plan.errors.join("、"));
        if (plan.status === "conflict") return json(res, { error: "存在需要客户调整的冲突，未生成方案。", conflicts: plan.conflicts }, 422);
        if (plan.status === "empty") fail(422, "当前条件下没有可用资源，请调整档期、媒体或预算。");
        const parent = input.parentId ? ownDraft(me.name, input.parentId) : null;
        if (input.parentId && (!parent || parent.projectId !== project.id)) fail(404, "上一版草稿不存在。");
        const diff = parent ? S.diff(parent.plan, plan) : null;
        const map = mapFor(project.id);
        if (map && !plan.synthetic) plan.map = selectMap(JSON.parse(map.payload), plan.items);
        useLimit(aiAttempts, "draft:" + me.name, 10, 60000);
        const narrative = await AI.narrative(plan, diff, env, request);
        const seq = (get("SELECT max(seq) AS n FROM client_drafts WHERE project_id=? AND owner=?", project.id, me.name).n || 0) + 1;
        const id = secret();
        const title = (typeof input.title === "string" && input.title.trim().slice(0, 80)) || (JSON.parse(project.state).brand || project.name) + " · 户外投放方案";
        run("INSERT INTO client_drafts (id,project_id,owner,parent_id,seq,title,brief,plan,diff,narrative,created) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
          id, project.id, me.name, parent?.id || null, seq, title, JSON.stringify(plan.brief), JSON.stringify(plan), diff && JSON.stringify(diff), JSON.stringify(narrative), date());
        return json(res, withHtml(ownDraft(me.name, id)), 201);
      }
    }
    if (p[2] === "drafts") {
      const d = ownDraft(me.name, p[3]);
      if (!d) fail(404, "草稿不存在或未授权。");
      if (p.length === 4 && method === "GET") return json(res, withHtml(d));
      if (p[4] === "export" && method === "GET") return exportDraft(res, d, url.searchParams.get("format"));
      if (p[4] === "share" && method === "POST") {
        const input = await readJson(req, 2000);
        const days = [1, 7, 30].includes(input?.days) ? input.days : 7;
        const link = secret();
        run("UPDATE client_drafts SET shared_at=coalesce(shared_at,?) WHERE id=?", date(), d.id);
        run("INSERT INTO draft_shares VALUES (?,?,?,0,?)", hash(link), d.id, Date.now() + days * 86400000, date());
        return json(res, { path: "/d/" + link, days }, 201);
      }
      if (p[4] === "share" && method === "DELETE") {
        run("UPDATE draft_shares SET revoked=1 WHERE draft_id=?", d.id);
        return json(res, { revoked: true });
      }
      if (p[4] === "submit" && method === "POST") {
        run("UPDATE client_drafts SET submitted_at=coalesce(submitted_at,?) WHERE id=?", date(), d.id);
        return json(res, summary(ownDraft(me.name, d.id)));
      }
    }
    fail(404, "接口不存在。");
  }

  function sharedDraft(res, token) {
    const row = idPattern.test(token) && get("SELECT d.* FROM draft_shares s JOIN client_drafts d ON d.id=s.draft_id JOIN projects p ON p.id=d.project_id WHERE s.digest=? AND s.revoked=0 AND s.expires>? AND p.archived=0", hash(token), Date.now());
    if (!row) return send(res, 404, "text/plain", "链接无效、已过期或已撤回。");
    res.setHeader("X-Robots-Tag", "noindex, nofollow");
    return send(res, 200, "text/html", R.standalone(draftRow(row)));
  }

  /* ---------- 团队侧：客户草稿审核、调度、变更单 ---------- */
  const dispatchState = (projectId) => {
    const row = get("SELECT * FROM dispatch WHERE project_id=?", projectId);
    return row && { config: JSON.parse(row.config), fleet: JSON.parse(row.fleet), plan: JSON.parse(row.plan), revision: row.revision, updated: row.updated, updatedBy: row.updated_by };
  };
  const changeRow = (row) => row && { id: row.id, type: row.type, label: D.TYPES[row.type], baseRevision: row.base_revision, status: row.status, created: row.created, author: row.author,
    decided: row.decided, decidedBy: row.decided_by, input: JSON.parse(row.input), preview: JSON.parse(row.preview), notice: JSON.parse(row.notice) };

  async function teamRoutes(req, res, url, p, me, project, canEdit) {
    const method = req.method;
    if (p[3] === "map-evidence" && p.length === 4) {
      if (method === "GET") {
        const map = mapFor(project.id);
        if (!map) return json(res, null);
        const data = JSON.parse(map.payload);
        return json(res, { source: data.source, shareUrl: data.shareUrl, metroShareUrl: data.metroShareUrl, count: data.features.length, updated: map.updated });
      }
      if (method === "PUT" && canEdit) {
        const input = await readJson(req, 1500000);
        let data;
        try {
          data = checkedMap(input);
          if (!data.features.length && (data.shareUrl || data.metroShareUrl)) {
            const [bus, metro] = await Promise.all([data.shareUrl && authorizedMap(data.shareUrl), data.metroShareUrl && authorizedMap(data.metroShareUrl)]);
            data.source = (bus || metro).source;
            data.coordinateSystem = (bus || metro).coordinateSystem;
            data.features = [...(bus?.features || []), ...(metro?.features || []).map((feature) => ({ ...feature, reference: feature.type !== "Point" }))];
          }
        } catch (error) { fail(422, error.message); }
        run(`INSERT INTO project_maps VALUES (?,?,?,?) ON CONFLICT(project_id)
          DO UPDATE SET payload=excluded.payload,updated=excluded.updated,updated_by=excluded.updated_by`, project.id, JSON.stringify(data), date(), me.name);
        return json(res, { source: data.source, shareUrl: data.shareUrl, metroShareUrl: data.metroShareUrl, count: data.features.length });
      }
      return null;
    }
    if (p[3] === "handoff" && p.length === 4 && method === "GET") {
      const row = get("SELECT d.* FROM project_handoffs h JOIN client_drafts d ON d.id=h.draft_id WHERE h.project_id=?", project.id);
      const draft = draftRow(row);
      return json(res, draft ? { ...summary(draft), media: draft.plan.items.map(({ name, kind, units, level, format, query }) => ({ name, kind, units, level, format, query })),
        pending: draft.plan.pending, schedule: draft.plan.schedule } : null);
    }
    if (p[3] === "client-drafts") {
      if (p.length === 4 && method === "GET") return json(res, query("SELECT * FROM client_drafts WHERE project_id=? ORDER BY created DESC", project.id).map(draftRow).map(summary));
      const d = draftRow(idPattern.test(p[4] || "") && get("SELECT * FROM client_drafts WHERE id=? AND project_id=?", p[4], project.id));
      if (!d) fail(404, "客户草稿不存在。");
      if (p.length === 5 && method === "GET") return json(res, withHtml(d));
      if (p[5] === "review" && method === "POST" && canEdit) {
        const input = await readJson(req, 4000);
        if (!["accepted", "returned"].includes(input?.decision)) fail(422, "请选择审核结论。");
        if (!d.submitted) fail(409, "客户提交后才可审核。");
        const review = { decision: input.decision, note: typeof input.note === "string" ? input.note.trim().slice(0, 400) : "", by: me.name, at: date() };
        store.db.exec("BEGIN IMMEDIATE");
        try {
          run("UPDATE client_drafts SET review=? WHERE id=?", JSON.stringify(review), d.id);
          if (review.decision === "accepted") run(`INSERT INTO project_handoffs VALUES (?,?,?,?) ON CONFLICT(project_id)
            DO UPDATE SET draft_id=excluded.draft_id,adopted=excluded.adopted,adopted_by=excluded.adopted_by`, project.id, d.id, review.at, me.name);
          else run("DELETE FROM project_handoffs WHERE project_id=? AND draft_id=?", project.id, d.id);
          store.db.exec("COMMIT");
        } catch (error) { store.db.exec("ROLLBACK"); throw error; }
        return json(res, review);
      }
      return null;
    }
    if (p[3] === "clients" && me.role === "admin") {
      if (method === "GET") return json(res, query("SELECT name,created FROM client_access WHERE project_id=? ORDER BY name", project.id));
      if (method === "POST") {
        const input = await readJson(req, 2000);
        const user = get("SELECT name FROM users WHERE name=? AND role='client'", input?.name);
        if (!user) fail(422, "请先在团队成员中创建客户账号。");
        run("INSERT OR IGNORE INTO client_access VALUES (?,?,?)", user.name, project.id, date());
        return json(res, { name: user.name }, 201);
      }
      if (method === "DELETE" && p[4]) {
        run("DELETE FROM client_access WHERE name=? AND project_id=?", p[4], project.id);
        return json(res, { removed: true });
      }
    }
    if (p[3] === "dispatch") {
      if (method === "GET") return json(res, { state: dispatchState(project.id), types: D.TYPES, defaults: D.defaultConfig() });
      if (method === "PUT" && canEdit) {
        const input = await readJson(req, 400000);
        const { config, errors } = D.normalizeConfig(input?.config || {});
        if (errors.length) fail(422, "检查执行配置：" + errors.join("、"));
        let fleet;
        try { fleet = input.synthetic === true ? D.syntheticFleet(config.route, Number.isInteger(input.count) ? Math.min(Math.max(input.count, 1), 60) : 12) : D.normalizeFleet(input.fleet); }
        catch (error) { fail(422, error.message); }
        if (!fleet.length) fail(422, "缺车级台账：线路级库存只能支撑推荐和初步估价，具体排车需要车级台账或明确标记的合成车辆。");
        config.synthetic = fleet.some((v) => v.synthetic);
        const current = dispatchState(project.id);
        if (current && current.revision !== input.revision) fail(409, "执行计划已更新，请刷新后再改。");
        const plan = D.schedule(config, fleet);
        const revision = (current?.revision || 0) + 1;
        run("INSERT INTO dispatch VALUES (?,?,?,?,?,?,?) ON CONFLICT(project_id) DO UPDATE SET config=excluded.config,fleet=excluded.fleet,plan=excluded.plan,revision=excluded.revision,updated=excluded.updated,updated_by=excluded.updated_by",
          project.id, JSON.stringify(config), JSON.stringify(fleet), JSON.stringify(plan), revision, date(), me.name);
        run("UPDATE change_orders SET status='stale' WHERE project_id=? AND status='pending'", project.id);
        return json(res, dispatchState(project.id));
      }
      return null;
    }
    if (p[3] === "changes") {
      if (p.length === 4 && method === "GET") return json(res, query("SELECT * FROM change_orders WHERE project_id=? ORDER BY created DESC", project.id).map(changeRow));
      if (p.length === 4 && method === "POST" && canEdit) {
        const state = dispatchState(project.id);
        if (!state) fail(422, "请先生成初始执行计划。");
        const input = await readJson(req, 8000);
        let view;
        try { view = D.preview(state, input); } catch (error) { fail(422, error.message); }
        const notice = await AI.notice(view, env, request);
        const id = secret();
        run("INSERT INTO change_orders (id,project_id,base_revision,type,input,preview,notice,status,created,author) VALUES (?,?,?,?,?,?,?,?,?,?)",
          id, project.id, state.revision, view.change.type, JSON.stringify(view.change), JSON.stringify({ plan: view.plan, delta: view.delta, tasks: view.tasks, applicable: view.applicable, config: view.config, fleet: view.fleet, before: state.plan }),
          JSON.stringify({ ...notice, state: "草稿 · 待负责人审阅" }), "pending", date(), me.name);
        return json(res, changeRow(get("SELECT * FROM change_orders WHERE id=?", id)), 201);
      }
      const order = idPattern.test(p[4] || "") && changeRow(get("SELECT * FROM change_orders WHERE id=? AND project_id=?", p[4], project.id));
      if (!order) fail(404, "变更单不存在。");
      if (p.length === 5 && method === "GET") return json(res, order);
      if (p[5] === "notice" && method === "PUT" && canEdit) {
        const input = await readJson(req, 8000);
        const subject = typeof input?.subject === "string" && input.subject.trim().slice(0, 80);
        const body = typeof input?.body === "string" && input.body.trim().slice(0, 2000);
        if (!subject || !body) fail(422, "通知标题和正文不能为空。");
        run("UPDATE change_orders SET notice=? WHERE id=?", JSON.stringify({ ...order.notice, subject, body, editedBy: me.name, state: "草稿 · 已人工修改，待负责人审阅" }), order.id);
        return json(res, changeRow(get("SELECT * FROM change_orders WHERE id=?", order.id)));
      }
      if (p[5] === "apply" && method === "POST" && canEdit) {
        if (order.status !== "pending") fail(409, "该变更单已处理或已过期。");
        if (!order.preview.applicable) fail(422, "排期存在缺口，保留待复核状态，不能应用：" + order.preview.plan.shortfall.message);
        store.db.exec("BEGIN IMMEDIATE");
        try {
          const changed = run("UPDATE dispatch SET config=?,fleet=?,plan=?,revision=revision+1,updated=?,updated_by=? WHERE project_id=? AND revision=?",
            JSON.stringify(order.preview.config), JSON.stringify(order.preview.fleet), JSON.stringify(order.preview.plan), date(), me.name, project.id, order.baseRevision);
          if (!changed.changes) fail(409, "执行计划在预览后已变化，请重新录入变更单。");
          run("UPDATE change_orders SET status='applied',decided=?,decided_by=? WHERE id=?", date(), me.name, order.id);
          run("UPDATE change_orders SET status='stale' WHERE project_id=? AND status='pending'", project.id);
          store.db.exec("COMMIT");
        } catch (error) { store.db.exec("ROLLBACK"); throw error; }
        return json(res, { order: changeRow(get("SELECT * FROM change_orders WHERE id=?", order.id)), state: dispatchState(project.id) });
      }
      if (p[5] === "reject" && method === "POST" && canEdit) {
        if (order.status !== "pending") fail(409, "该变更单已处理。");
        run("UPDATE change_orders SET status='rejected',decided=?,decided_by=? WHERE id=?", date(), me.name, order.id);
        return json(res, changeRow(get("SELECT * FROM change_orders WHERE id=?", order.id)));
      }
    }
    return null;
  }

  // 返回 true 表示已处理；未匹配的路由交回 server.cjs 的统一 404/403。
  const team = async (...args) => (await teamRoutes(...args)) !== null;
  return { client, team, sharedDraft };
}

module.exports = { createRoutes };
