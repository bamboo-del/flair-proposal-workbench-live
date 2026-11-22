const http = require("node:http");
const path = require("node:path");
const { readFile } = require("node:fs/promises");
const { openStore } = require("./store.cjs");
const { engine, normalize, FIELDS, customerHtml, pad } = require("./proposal.cjs");
const { createRoutes } = require("./lib/routes.cjs");
const { createRoadshow } = require("./lib/roadshow.cjs");
const { chatEndpoint, chatOptions } = require("./lib/ai.cjs");

const MIME = { html: "text/html", js: "text/javascript", css: "text/css" };
const assets = Object.fromEntries([
  "index.html", "assets/app.js", "assets/data.js", "assets/styles.css", "assets/workbench.css",
  "assets/vendor/jszip.min.js", "assets/portal.js", "assets/portal.css",
  "client.html", "ops.html", "assets/client.js", "assets/client.css", "assets/ops.js",
  "roadshow.html", "assets/roadshow.css", "assets/roadshow.js",
  "assets/proposal-map.js", "assets/proposal-map.css",
].map((file) => ["/" + file, file]));
assets["/"] = "index.html";
assets["/client"] = "client.html";
assets["/ops"] = "ops.html";
assets["/roadshow"] = "roadshow.html";

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
const fail = (status, message) => { throw new HttpError(status, message); };
const json = (res, data, status = 200) => res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" }).end(JSON.stringify(data));
const headerToken = (cookie = "") => cookie.match(/(?:^|; )flair_session=([a-zA-Z0-9_-]{32})(?:$|;)/)?.[1];
const idPattern = /^[a-zA-Z0-9_-]{32}$/;

async function readJson(req, limit = 3 * 1024 * 1024) {
  if (!String(req.headers["content-type"]).startsWith("application/json")) fail(415, "需要 JSON 请求。");
  const parts = [];
  let bytes = 0;
  for await (const chunk of req) {
    bytes += chunk.length;
    if (bytes > limit) fail(413, "文件或数据超过大小上限。");
    parts.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(parts).toString("utf8")); }
  catch { return fail(400, "JSON 格式有误。"); }
}

function parseProject(input, sample) {
  try { return normalize(input, sample); }
  catch (error) { return fail(422, error.message); }
}

async function suggest(text, env, request) {
  if (!env.DEEPSEEK_API_KEY || !env.DEEPSEEK_MODEL) fail(503, "服务器尚未配置 AI，可手动填写假设书。");
  const response = await request(chatEndpoint(env), {
    method: "POST", signal: AbortSignal.timeout(22000), redirect: "error",
    headers: { "content-type": "application/json", authorization: "Bearer " + env.DEEPSEEK_API_KEY },
    body: JSON.stringify({
      model: env.DEEPSEEK_MODEL, response_format: { type: "json_object" }, max_tokens: 900,
      ...chatOptions(env),
      messages: [
        { role: "system", content: "仅输出 JSON 对象。用中文提炼用户已脱敏的 Campaign 简介，字符串字段为 " + Object.keys(FIELDS).join(", ") + "。缺信息写待确认；不得编造数字、点位、库存、刊例或来源。" },
        { role: "user", content: text },
      ],
    }),
  });
  if (!response.ok) fail(502, "模型调用失败。草稿仍可手动编辑。");
  try {
    const body = await response.json();
    const fields = JSON.parse(body.choices[0].message.content);
    return Object.fromEntries(Object.keys(FIELDS).map((key) => [key, pad(fields[key])]));
  } catch { return fail(502, "模型未返回可用草稿。"); }
}

function createApplication(store, env = process.env, request = fetch) {
  const attempts = new Map();
  const aiAttempts = new Map();
  const { get, query, run, date, secret, hash } = store;
  run(`CREATE TABLE IF NOT EXISTS mirror_batches (
    id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id), digest TEXT NOT NULL,
    data TEXT NOT NULL, created TEXT NOT NULL, author TEXT NOT NULL, UNIQUE(project_id,digest)
  )`);
  const cookie = (token, age) => "flair_session=" + token + "; Path=/; HttpOnly; SameSite=Strict; Max-Age=" + age + (env.PUBLIC_ORIGIN?.startsWith("https:") ? "; Secure" : "");
  function useLimit(map, key, max, window) {
    const now = Date.now();
    for (const [name, entry] of map) if (entry.until <= now) map.delete(name);
    if (!map.has(key)) {
      if (map.size >= 12000) fail(429, "请求过于频繁，请稍后再试。");
      map.set(key, { n: 0, until: now + window });
    }
    if (++map.get(key).n > max) fail(429, "请求过于频繁，请稍后再试。");
  }
  function saveBatch(project, data, user) {
    if (!data.bus.length && !data.metro.length && !data.coverage) return;
    const snapshot = JSON.stringify(data);
    run("INSERT OR IGNORE INTO mirror_batches VALUES (?,?,?,?,?,?)", secret(), project, hash(snapshot), snapshot, date(), user);
  }
  const routes = createRoutes({ store, env, request, fail, json, readJson, useLimit });
  const roadshow = createRoadshow({ env, request, fail, json, readJson, useLimit });

  return async (req, res) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("Cache-Control", "no-store");
    try {
      const url = new URL(req.url, "http://internal");
      const mapTiles = ["/roadshow", "/roadshow.html"].includes(url.pathname) ? " https://tile.openstreetmap.org" : "";
      res.setHeader("Content-Security-Policy", `default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:${mapTiles}; frame-src 'self' https://flairmedia.com.cn:38880; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'`);
      const p = url.pathname.split("/").filter(Boolean);
      const method = req.method;
      if (url.pathname === "/healthz" && method === "GET") {
        get("SELECT 1");
        return json(res, { status: "ok" });
      }

      if (p[0] === "p" && p.length === 2 && method === "GET") {
        const row = idPattern.test(p[1]) && get("SELECT v.proposal FROM shares s JOIN versions v ON v.id=s.version_id JOIN projects p ON p.id=v.project_id WHERE s.digest=? AND s.revoked=0 AND s.expires>? AND p.archived=0", hash(p[1]), Date.now());
        if (!row) return res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" }).end("链接无效、已过期或已撤回。");
        res.setHeader("X-Robots-Tag", "noindex, nofollow");
        return res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }).end(customerHtml(JSON.parse(row.proposal), "/p/" + p[1], url.searchParams.get("budget")));
      }

      if (p[0] === "d" && p.length === 2 && method === "GET") return routes.sharedDraft(res, p[1]);

      if (p[0] !== "api") {
        const file = Object.hasOwn(assets, url.pathname) ? assets[url.pathname] : null;
        if (!file || !["GET", "HEAD"].includes(method)) fail(404, "页面不存在。");
        const content = await readFile(path.join(__dirname, file));
        const type = MIME[path.extname(file).slice(1)];
        return res.writeHead(200, { "Content-Type": type + "; charset=utf-8", "Content-Length": content.length }).end(method === "HEAD" ? undefined : content);
      }

      if (!["GET", "HEAD"].includes(method)) {
        const localOrigin = "http://" + req.headers.host;
        if (req.headers["x-flair-client"] !== "1" || (req.headers.origin && req.headers.origin !== (env.PUBLIC_ORIGIN || localOrigin))) {
          fail(403, "请求来源校验未通过。");
        }
      }
      if (p[1] === "roadshow") return await roadshow(req, res, p);
      const token = headerToken(req.headers.cookie);
      const me = store.session(token);
      if (p[1] === "session" && method === "POST") {
        const input = await readJson(req, 8192);
        if (typeof input?.password !== "string" || input.password.length > 200) fail(400, "请输入账号与密码。");
        const ip = req.socket.remoteAddress || "local";
        useLimit(attempts, "ip:" + ip, 80, 60000);
        useLimit(attempts, "account:" + pad(input.name, 50), 10, 60000);
        const session = await store.login(input.name, input.password);
        if (!session) fail(401, "账号或密码有误。");
        store.revokeSession(token);
        res.setHeader("Set-Cookie", cookie(session, store.defaultLifetime / 1000));
        return json(res, store.session(session));
      }
      if (!me) fail(401, "请登录工作台。");
      if (p[1] === "session" && method === "DELETE") {
        store.revokeSession(token);
        res.setHeader("Set-Cookie", cookie("", 0));
        return json(res, { signedOut: true });
      }
      if (p[1] === "session" && method === "GET") return json(res, { ...me, ai: Boolean(env.DEEPSEEK_API_KEY && env.DEEPSEEK_MODEL) });
      // 客户账号只能使用自助入口；团队账号不经过客户入口。
      if (me.role === "client") {
        if (p[1] !== "client") fail(403, "客户账号仅可使用客户自助入口。");
        return await routes.client(req, res, url, p, me);
      }
      if (p[1] === "client") fail(403, "客户自助入口仅供客户账号使用。");
      if (p[1] === "team") {
        if (me.role !== "admin") fail(403, "仅管理员可管理成员。");
        if (method === "GET") return json(res, query("SELECT u.name,u.role,u.created,group_concat(a.project_id) AS projects FROM users u LEFT JOIN client_access a ON a.name=u.name GROUP BY u.name ORDER BY u.name")
          .map((row) => ({ ...row, projects: row.projects ? row.projects.split(",") : [] })));
        if (method === "POST") {
          const input = await readJson(req, 8192);
          if (!["editor", "viewer", "client"].includes(input?.role) || !await store.addUser(input.name, input.password, input.role)) fail(422, "检查账号格式、密码及账号是否已存在。");
          const projects = input.role === "client" && Array.isArray(input.projects) ? input.projects.filter((id) => typeof id === "string" && get("SELECT 1 FROM projects WHERE id=?", id)) : [];
          for (const id of projects) run("INSERT OR IGNORE INTO client_access VALUES (?,?,?)", input.name, id, date());
          return json(res, { name: input.name, role: input.role, projects }, 201);
        }
        if (method === "DELETE" && p.length === 3) {
          if (!run("DELETE FROM users WHERE name=? AND role!='admin'", p[2]).changes) fail(404, "成员不存在或无法移除。");
          return json(res, { removed: true });
        }
      }
      if (p[1] === "ai" && method === "POST" && me.role !== "viewer") {
        const input = await readJson(req, 12000);
        if (input?.anonymized !== true || !pad(input.brief, 2600)) fail(422, "请明确确认输入内容已脱敏。");
        useLimit(aiAttempts, me.name, 6, 60000);
        try { return json(res, await suggest(pad(input.brief, 2600), env, request)); }
        catch (error) { throw error instanceof HttpError ? error : new HttpError(502, "模型连接失败或超时。"); }
      }
      if (p[1] !== "projects") fail(404, "接口不存在。");
      if (p.length === 2 && method === "GET") return json(res, query("SELECT id,name,revision,archived,updated,updated_by FROM projects ORDER BY archived,updated DESC"));
      if (p.length === 2 && method === "POST" && me.role !== "viewer") {
        const input = await readJson(req, 10000);
        if (!pad(input?.name, 100)) fail(422, "请填写项目名称。");
        const state = parseProject({ ...engine.defaults(), industry: input.industry, brand: pad(input.brand, 100), campaign: pad(input.campaign, 120) }, input.sample === true);
        const id = secret();
        run("INSERT INTO projects (id,name,state,revision,updated,updated_by) VALUES (?,?,?,?,?,?)", id, pad(input.name, 100), JSON.stringify(state), 1, date(), me.name);
        return json(res, store.byProject(id), 201);
      }
      const project = idPattern.test(p[2]) && store.byProject(p[2]);
      if (!project) fail(404, "项目不存在。");
      if (p.length === 3 && method === "GET") return json(res, project);
      const canEdit = me.role !== "viewer" && !project.archived;
      if (["client-drafts", "clients", "dispatch", "changes", "handoff", "map-evidence"].includes(p[3])) {
        const handled = await routes.team(req, res, url, p, me, project, canEdit);
        if (handled) return handled;
      }
      if (p.length === 3 && method === "PUT" && canEdit) {
        const input = await readJson(req);
        const name = pad(input?.name, 100);
        if (!name) fail(422, "项目名称不能为空。");
        const next = parseProject(input.state, project.state.sample);
        store.db.exec("BEGIN IMMEDIATE");
        try {
          const change = run("UPDATE projects SET name=?,state=?,revision=revision+1,updated=?,updated_by=? WHERE id=? AND revision=? AND archived=0",
            name, JSON.stringify(next), date(), me.name, project.id, Number(input.revision) || 0);
          if (!change.changes) fail(409, "项目已被修改。请重新打开后再保存。");
          saveBatch(project.id, next.data, me.name);
          store.db.exec("COMMIT");
        } catch (error) { store.db.exec("ROLLBACK"); throw error; }
        return json(res, store.byProject(project.id));
      }
      if (p[3] === "archive" && method === "POST" && me.role === "admin") {
        const input = await readJson(req, 5000);
        if (typeof input?.archived !== "boolean") fail(422, "归档状态无效。");
        store.db.exec("BEGIN IMMEDIATE");
        try {
          run("UPDATE projects SET archived=?,revision=revision+1,updated=?,updated_by=? WHERE id=?", input.archived ? 1 : 0, date(), me.name, project.id);
          if (input.archived) run("UPDATE shares SET revoked=1 WHERE version_id IN (SELECT id FROM versions WHERE project_id=?)", project.id);
          store.db.exec("COMMIT");
        } catch (error) { store.db.exec("ROLLBACK"); throw error; }
        return json(res, store.byProject(project.id));
      }
      if (p[3] === "mirrors" && method === "GET") {
        if (p.length === 4) return json(res, query("SELECT id,created,author FROM mirror_batches WHERE project_id=? ORDER BY created DESC", project.id));
        const row = get("SELECT data FROM mirror_batches WHERE id=? AND project_id=?", p[4], project.id);
        if (!row) fail(404, "镜像批次不存在。");
        return json(res, JSON.parse(row.data));
      }
      if (p[3] === "versions") {
        if (p.length === 4 && method === "GET") return json(res, query("SELECT id,title,revision,created,author FROM versions WHERE project_id=? ORDER BY created DESC", project.id));
        if (p.length === 4 && method === "POST" && canEdit) {
          const input = await readJson(req, 5000);
          if (input?.revision !== project.revision) fail(409, "请保存当前版本后重试。");
          const missing = Object.entries(FIELDS).filter(([key]) => !project.state.assumptions[key] || /^待确认[。！!\s]*$/.test(project.state.assumptions[key])).map(([, label]) => label);
          if (missing.length || !project.state.brand || !project.state.campaign) fail(422, "请补齐品牌、战役与假设书：" + missing.join("、"));
          const proposal = engine.buildCustomerProposal(project.state);
          const id = secret();
          run("INSERT INTO versions VALUES (?,?,?,?,?,?,?,?)", id, project.id, pad(input.title, 100) || proposal.title, project.revision,
            JSON.stringify(proposal), JSON.stringify(project.state), date(), me.name);
          return json(res, { id, revision: project.revision }, 201);
        }
        const version = p[4] && get("SELECT * FROM versions WHERE id=? AND project_id=?", p[4], project.id);
        if (p.length >= 5 && !version) fail(404, "提案版本不存在。");
        if (p.length === 5 && method === "GET") return json(res, { id: version.id, state: JSON.parse(version.state), proposal: JSON.parse(version.proposal) });
        if (p[5] === "preview" && method === "GET") {
          return res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }).end(customerHtml(JSON.parse(version.proposal), url.pathname, url.searchParams.get("budget")));
        }
        if (p[5] === "share" && method === "POST" && canEdit) {
          const input = await readJson(req, 5000);
          if (input?.approved !== true) fail(422, "请确认该案允许通过链接对外查看。");
          const days = [1, 7, 30].includes(input.days) ? input.days : 7;
          const link = secret();
          run("INSERT INTO shares (digest,version_id,expires,created) VALUES (?,?,?,?)", hash(link), version.id, Date.now() + days * 86400000, date());
          return json(res, { path: "/p/" + link, days }, 201);
        }
        if (p[5] === "share" && method === "DELETE" && canEdit) {
          run("UPDATE shares SET revoked=1 WHERE version_id=?", version.id);
          return json(res, { revoked: true });
        }
      }
      if (p[3] === "evidence") {
        if (p.length === 4 && method === "GET") return json(res, query("SELECT id,label,kind,content_type,length(body) AS bytes,created,author FROM evidence WHERE project_id=? ORDER BY created DESC", project.id));
        if (p.length === 4 && method === "POST" && canEdit) {
          const input = await readJson(req);
          const kind = ["上刊", "下刊", "结案", "异常"].includes(input?.kind) && input.kind;
          const contentType = ["image/jpeg", "image/png", "application/pdf", "text/plain"].includes(input?.type) && input.type;
          if (!kind || !contentType || !pad(input?.label, 120) || !/^[a-zA-Z0-9+/]+={0,2}$/.test(input?.base64 || "")) fail(422, "请选择有效证据和文件。");
          const bytes = Buffer.from(input.base64, "base64");
          if (!bytes.length || bytes.length > 2 * 1024 * 1024) fail(413, "每个文件最多 2 MB。");
          const id = secret();
          run("INSERT INTO evidence VALUES (?,?,?,?,?,?,?,?)", id, project.id, pad(input.label, 120), kind, contentType, bytes, date(), me.name);
          return json(res, { id }, 201);
        }
        if (p.length === 5 && method === "GET") {
          const proof = get("SELECT content_type,body FROM evidence WHERE id=? AND project_id=?", p[4], project.id);
          if (!proof) fail(404, "证据不存在。");
          return res.writeHead(200, { "Content-Type": proof.content_type, "Content-Disposition": 'attachment; filename="evidence"' }).end(proof.body);
        }
      }
      fail(me.role === "viewer" && method !== "GET" ? 403 : 404, "当前操作不可用。");
    } catch (error) {
      if (error instanceof HttpError) return json(res, { error: error.message }, error.status);
      console.error(error.name, error.code || "", error.message);
      return json(res, { error: "服务暂时不可用。" }, 500);
    }
  };
}

async function start(env = process.env) {
  const store = openStore(path.resolve(env.DATABASE_PATH || "private-data/flair.sqlite"));
  await store.bootstrap(env.ADMIN_USER, env.ADMIN_PASSWORD);
  const host = env.HOST || "127.0.0.1";
  const port = Number(env.PORT || 3000);
  const server = http.createServer(createApplication(store, env));
  server.listen(port, host, () => console.log("Flair Proposal " + host + ":" + port));
  for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => server.close(() => { store.db.close(); process.exit(0); }));
  return server;
}
if (require.main === module) start().catch((error) => { console.error(error.message); process.exitCode = 1; });
module.exports = { createApplication };
