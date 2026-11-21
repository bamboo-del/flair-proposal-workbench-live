"use strict";
/*
 * 可选 AI 辅助（服务端 DeepSeek）。三件事：口语需求 → 表单预填；方案摘要与推荐理由；变更通知草稿。
 * 规则：库存、金额、车辆、日期、容量只来自规则计算；AI 输出先过结构校验，
 * 文案里出现的数字必须能在输入事实中找到，否则丢弃改用模板。未配置 Key、超时或异常时全部回退模板。
 */
const S = require("./selfserve.cjs");
const L = require("./ledger.cjs");

const configured = (env) => Boolean(env.DEEPSEEK_API_KEY && env.DEEPSEEK_MODEL);
const chatEndpoint = (env) => (env.DEEPSEEK_API_BASE_URL || "https://api.deepseek.com").replace(/\/+$/, "") + "/chat/completions";
const chatOptions = (env) => env.DEEPSEEK_DISABLE_THINKING === "1" ? { thinking: { type: "disabled" } } : {};

async function chat(env, request, system, user, maxTokens = 900) {
  if (!configured(env)) throw new Error("not-configured");
  const response = await request(chatEndpoint(env), {
    method: "POST", signal: AbortSignal.timeout(Number(env.AI_TIMEOUT_MS) || 15000),
    redirect: "error",
    headers: { "content-type": "application/json", authorization: "Bearer " + env.DEEPSEEK_API_KEY },
    body: JSON.stringify({ model: env.DEEPSEEK_MODEL, response_format: { type: "json_object" }, max_tokens: maxTokens, ...chatOptions(env),
      messages: [{ role: "system", content: system }, { role: "user", content: user }] }),
  });
  if (!response.ok) throw new Error("status-" + response.status);
  const body = await response.json();
  const parsed = JSON.parse(body.choices[0].message.content);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not-object");
  return parsed;
}

const numbers = (value) => new Set(String(value).match(/\d+(?:\.\d+)?/g) || []);
function grounded(output, facts) {
  const allowed = numbers(JSON.stringify(facts));
  return [...numbers(output)].every((token) => allowed.has(token) || allowed.has(String(Number(token))));
}
const str = (value, limit) => typeof value === "string" && value.trim() ? value.trim().slice(0, limit) : null;

/* ---------- 1. 口语需求 → 表单预填 ---------- */
const CN = { 一: 1, 两: 2, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 };
const ZONE_WORDS = { renmin: ["人民广场"], nanjing_east: ["南京东路"], nanjing_west: ["南京西路"], jingan: ["静安"], huaihai: ["淮海"], xintiandi: ["新天地"],
  xujiahui: ["徐家汇"], lujiazui: ["陆家嘴"], zhongshan: ["中山公园"], wujiaochang: ["五角场"], hongqiao: ["虹桥"], qiantan: ["前滩"], longyang: ["龙阳路"], haichang: ["滨海"] };
const WORDS = {
  industry: { food: /咖啡|茶饮|饮料|食品|餐饮|奶茶/, bank: /银行|保险|理财/, health: /保健|营养/, hospital: /医院|体检|诊所/, park: /乐园|游乐|景区/ },
  businessGoal: { launch: /新品|上市|首发/, traffic: /门店引流|客流|进店/, rebrand: /焕新|升级|换标/, expand: /拓展|新区|新开|开店/, member: /会员/ },
  campaignGoal: { promotion: /促销|优惠|折扣|满减/, acquisition: /拉新|新客|注册/, visit: /到店|引流|进店|打卡/, awareness: /认知|曝光|知名度|声量/ },
  audiences: { commuter: /白领|上班|通勤/, shopper: /逛街|购物|商圈客流/, family: /社区|家庭/, youth: /学生|年轻|青年/, parent: /亲子|孩子|宝妈|家长/ },
  kpis: { coverage: /覆盖/, monitor: /监测|照片|监拍/, landing: /活动页|落地页|访问/, redemption: /核销/, scan: /扫码|二维码/, survey: /调研|认知度/ },
};
const REQUIRED = { industry: "行业", businessGoal: "生意目标", campaignGoal: "活动目标", audiences: "人群", zones: "门店或商圈", startDate: "投放开始日", duration: "投放天数", budgetWan: "预算", media: "媒体", kpis: "衡量结果" };

function ruleExtract(raw) {
  const t = String(raw);
  const out = {};
  for (const key of ["industry", "businessGoal", "campaignGoal"]) {
    const hit = Object.entries(WORDS[key]).find(([, re]) => re.test(t));
    if (hit) out[key] = hit[0];
  }
  for (const key of ["audiences", "kpis"]) {
    const hits = Object.entries(WORDS[key]).filter(([, re]) => re.test(t)).map(([id]) => id);
    if (hits.length) out[key] = hits;
  }
  const at = (words) => Math.min(...words.map((w) => t.indexOf(w)).filter((i) => i >= 0));
  const zones = Object.entries(ZONE_WORDS).filter(([, words]) => words.some((w) => t.includes(w)))
    .sort((a, b) => at(a[1]) - at(b[1])).map(([id], i) => ({ id, priority: i < 2 }));
  if (zones.length) out.zones = zones;
  const media = [/公交|车身|巴士/.test(t) && "bus", /地铁|出入口|站口/.test(t) && "metro"].filter(Boolean);
  if (media.length) out.media = media;
  if (/大三侧/.test(t)) out.busFormat = "大三侧"; else if (/车身三侧/.test(t)) out.busFormat = "车身三侧";
  const money = t.match(/(\d+(?:\.\d+)?)\s*万/) || t.match(/([一二两三四五六七八九十])\s*百万/);
  if (money) out.budgetWan = Math.round(/百万/.test(money[0]) ? CN[money[1]] * 100 : Number(money[1]));
  else { const m = t.match(/(\d+)\s*百万/); if (m) out.budgetWan = Number(m[1]) * 100; }
  const date = t.match(/(?:2027\s*年\s*)?(\d{1,2})\s*月\s*(?:(\d{1,2})\s*[日号]|(上旬|中旬|下旬|初|中|底))?/);
  if (date) out.startDate = "2027-" + date[1].padStart(2, "0") + "-" + (date[2] || { 上旬: "1", 初: "1", 中旬: "11", 中: "11", 下旬: "21", 底: "21" }[date[3]] || "1").padStart(2, "0");
  const days = t.match(/(\d+)\s*天/);
  const months = t.match(/([一两二三])\s*个月/);
  const weeks = t.match(/([一两二三])\s*(?:周|星期)/);
  const span = days ? Number(days[1]) : months ? CN[months[1]] * 30 : weeks ? CN[weeks[1]] * 7 : null;
  if (span) out.duration = S.OPTIONS.duration.reduce((best, d) => Math.abs(d - span) < Math.abs(best - span) ? d : best);
  const brand = t.match(/某[一-龥A-Za-z]{2,12}?(?:品牌|连锁|门店|银行|医院|乐园)/);
  if (brand) out.brandType = brand[0].replace(/^某/, "");
  return out;
}

/** 只保留能通过表单校验的字段。 */
function validFields(candidate) {
  const out = {};
  for (const [key, value] of Object.entries(candidate || {})) {
    if (!["industry", "industryNote", "brandType", "businessGoal", "businessNote", "campaignGoal", "audiences", "zones", "startDate", "duration", "budgetWan", "media", "busFormat", "kpis", "kpiNote"].includes(key)) continue;
    const { brief, errors } = S.normalizeBrief({ [key]: value });
    if (!errors.includes(key) && !(Array.isArray(brief[key]) && !brief[key].length)) out[key] = brief[key];
  }
  return out;
}

async function extract(raw, env, request) {
  const rules = validFields(ruleExtract(raw));
  let ai = {}, source = "rules", note = configured(env) ? "" : "未配置 AI，使用关键词规则预填。";
  if (configured(env)) {
    try {
      const o = S.OPTIONS;
      const enums = (map) => Object.entries(map).map(([k, v]) => k + "=" + v).join("，");
      const parsed = await chat(env, request,
        "只输出 JSON 对象。从用户已脱敏的口语需求中提取户外广告投放表单字段，没提到的字段不要输出，不得编造。字段：industry(" + enums(o.industry) + ")，brandType(字符串)，businessGoal(" + enums(o.businessGoal) + ")，businessNote，campaignGoal(" + enums(o.campaignGoal) + ")，audiences(数组:" + enums(o.audience) + ")，zones(数组 {id,priority}，id 取 " + L.zones.map((z) => z.id + "=" + z.name).join("，") + ")，startDate(2027-MM-DD)，duration(" + o.duration.join("/") + ")，budgetWan(整数，万元)，media(数组 bus/metro)，busFormat(any/车身三侧/大三侧)，kpis(数组:" + enums(o.kpi) + ")，kpiNote。",
        String(raw).slice(0, 2000), 700);
      ai = validFields(parsed);
      source = "ai";
      note = "AI 预填，" + Object.keys(ai).length + " 个字段通过校验；请逐项确认。";
    } catch { note = "AI 调用失败或超时，已改用关键词规则预填。"; }
  }
  const prefill = { ...rules, ...ai };
  const sources = Object.fromEntries(Object.keys(prefill).map((key) => [key, Object.hasOwn(ai, key) ? "ai" : "rules"]));
  const missing = Object.entries(REQUIRED).filter(([key]) => !Object.hasOwn(prefill, key)).map(([key, label]) => ({ key, label }));
  return { source, note, prefill, sources, missing };
}

/* ---------- 2. 方案摘要、推荐理由、预算取舍 ---------- */
function planFacts(plan, diff) {
  return {
    window: plan.window, budgetWan: plan.brief.budgetWan, capWan: Math.round(plan.totals.cap / 100) / 100,
    rangeWan: [Math.round(plan.totals.total.min / 100) / 100, Math.round(plan.totals.total.max / 100) / 100],
    counts: plan.counts, coverage: plan.coverage.percent, goal: S.OPTIONS.campaignGoal[plan.brief.campaignGoal], business: S.OPTIONS.businessGoal[plan.brief.businessGoal],
    covered: plan.coverage.zones.filter((z) => z.covered).map((z) => z.name), uncovered: plan.coverage.zones.filter((z) => !z.covered).map((z) => z.name),
    items: plan.items.slice(0, 12).map((i) => ({ id: i.id, name: i.name, units: i.units, level: i.level, zones: i.hits.map((z) => L.zoneName.get(z)) })),
    change: diff ? { fields: diff.fields, removed: diff.removed.length, added: diff.added.length, replaced: diff.replaced.length, coverage: diff.impact.coverage } : null,
  };
}

function narrativeTemplate(plan, diff) {
  const f = planFacts(plan, diff);
  const lead = f.counts.bus >= f.counts.metro ? "公交车身做沿线频次，地铁出入口补足商圈现场可见度" : "地铁出入口建立商圈可见度，公交车身补频";
  const summary = "本方案在 " + f.window.start + " 至 " + f.window.end + " 投放公交 " + f.counts.bus + " 辆、地铁 " + f.counts.metro + " 处，以" + lead + "，服务「" + f.business + "」与「" + f.goal + "」。目标商圈加权覆盖约 " + f.coverage + "%（估算），费用区间 " + f.rangeWan[0] + "–" + f.rangeWan[1] + " 万元，不超过预算扣除执行缓冲后的 " + f.capWan + " 万元。";
  const tradeoffs = [
    "预算优先保证目标商圈至少有一个触点，再在剩余额度内加车提高频次。",
    f.uncovered.length ? "未覆盖 " + f.uncovered.join("、") + "：该档期内对应资源无空位或超出预算上限。" : "全部目标商圈均有触点，追加预算主要用于提升频次。",
    ...(diff && diff.fields.length ? ["本次调整（" + diff.fields.map((x) => x.label).join("、") + "）后，覆盖由 " + diff.impact.coverage.from + "% 变为 " + diff.impact.coverage.to + "%。"] : []),
  ];
  return { summary, tradeoffs, reasons: {} };
}

async function narrative(plan, diff, env, request, strategy) {
  const base = narrativeTemplate(plan, diff);
  if (!configured(env)) return { source: "template", note: "未配置 AI，使用模板文案。", ...base };
  const facts = { ...planFacts(plan, diff), ...(strategy ? { strategy, inventorySource: plan.synthetic ? "合成演示库存" : "红豆档期候选，未锁位" } : {}) };
  try {
    const out = await chat(env, request,
      "只输出 JSON 对象 {summary:字符串≤220字, tradeoffs:字符串数组≤4条, reasons:{资源id:一句话理由}}。用中文解释媒体主次、预算增加或减少时保什么和舍什么。只能引用输入里的数字、日期和资源名称，优先给具体取舍，无需复述数字。覆盖率是估算，不能说成实际人流。若库存来源有值，保持该口径，不得承诺锁位、效果或正式报价。",
      JSON.stringify(facts), 900);
    const summary = str(out.summary, 400);
    const tradeoffs = Array.isArray(out.tradeoffs) ? out.tradeoffs.map((x) => str(x, 200)).filter(Boolean).slice(0, 4) : [];
    const ids = new Set(facts.items.map((i) => i.id));
    const reasons = Object.fromEntries(Object.entries(out.reasons && typeof out.reasons === "object" ? out.reasons : {}).filter(([id, v]) => ids.has(id) && str(v, 160)).map(([id, v]) => [id, str(v, 160)]));
    const all = [summary, ...tradeoffs, ...Object.values(reasons)].join("\n");
    if (!summary || !tradeoffs.length || !grounded(all, facts)) return { source: "template", note: "AI 文案未通过校验（结构或数字无法溯源），已用模板。", ...base };
    return { source: "ai", note: "AI 文案已通过结构与数字溯源校验。", summary, tradeoffs, reasons };
  } catch { return { source: "template", note: "AI 调用失败或超时，已用模板文案。", ...base }; }
}

/* ---------- 3. 变更通知草稿 ---------- */
async function notice(preview, env, request) {
  const base = preview.notice;
  if (!configured(env)) return { source: "template", note: "未配置 AI，使用模板通知。", ...base };
  const facts = { change: preview.change, campaign: preview.plan.campaign, route: preview.config.route, status: preview.plan.status,
    pairs: preview.delta.pairs, moved: preview.delta.moved, shortfall: preview.plan.shortfall && { summary: preview.plan.shortfall.summary, options: preview.plan.shortfall.options } };
  try {
    const out = await chat(env, request,
      "只输出 JSON 对象 {subject:字符串≤40字, body:字符串≤500字}。根据变更清单给广告客户写一份礼貌、清楚的执行调整通知草稿，结尾注明「草稿，待负责人审阅」。只能使用输入里的车辆编号、日期和数字，不得承诺输入以外的补偿或结果。",
      JSON.stringify(facts), 700);
    const subject = str(out.subject, 60), body = str(out.body, 900);
    if (!subject || !body || !grounded(subject + body, facts)) return { source: "template", note: "AI 通知未通过校验，已用模板。", ...base };
    return { source: "ai", note: "AI 通知已通过结构与数字溯源校验，仍需负责人审阅。", subject, body };
  } catch { return { source: "template", note: "AI 调用失败或超时，已用模板通知。", ...base }; }
}

module.exports = { configured, chatEndpoint, chatOptions, extract, ruleExtract, narrative, narrativeTemplate, notice, grounded };
