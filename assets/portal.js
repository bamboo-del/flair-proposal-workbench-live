(() => {
  "use strict";
  const planner = window.flairPlanner;
  const $ = (id) => document.getElementById(id);
  const fields = {
    customer: "客户与品牌", business: "生意目标", goal: "Campaign 主目标",
    audience: "目标人群与活动区域", budget: "时间与预算", media: "媒体范围", success: "成功衡量与监测",
  };
  const roles = { admin: "管理员", editor: "编辑", viewer: "只读", client: "客户" };
  const priceGrades = { bus: ["S", "A++", "A+", "AA", "A"], metro: ["A++", "A+", "AA", "A"] };
  let me, project, panel, selectedVersion, baseline;
  const canEdit = () => project && !project.archived && me.role !== "viewer";
  const node = (tag, text) => {
    const element = document.createElement(tag);
    if (text !== undefined) element.textContent = text;
    return element;
  };
  const button = (label, action) => {
    const element = node("button", label);
    element.type = "button";
    element.className = "portal-button secondary";
    element.addEventListener("click", () => run(action));
    return element;
  };
  const link = (label, href) => {
    const a = node("a", label);
    a.href = href;
    a.rel = "noopener noreferrer";
    return a;
  };
  const tell = (message = "") => { $("portalMessage").textContent = message; };
  function run(action) {
    return Promise.resolve().then(action).catch((error) => tell(error.message));
  }
  async function api(url, method = "GET", data) {
    const response = await fetch(url, {
      method, headers: { "Content-Type": "application/json", "X-Flair-Client": "1" },
      ...(data === undefined ? {} : { body: JSON.stringify(data) }),
    });
    const result = await response.json();
    if (!response.ok) throw Object.assign(new Error(result.error || "请求失败。"), { status: response.status });
    return result;
  }
  const projectPath = (tail = "") => "/api/projects/" + project.id + tail;
  const describe = (date) => new Date(date).toLocaleString("zh-CN");
  function row(container, title, subtitle, ...actions) {
    const element = node("article");
    element.className = "portal-list-row";
    const description = node("div");
    description.append(node("strong", title), node("small", subtitle));
    element.append(description, ...actions);
    container.append(element);
  }
  function form(id, action) {
    const element = $(id);
    element.addEventListener("submit", (event) => {
      event.preventDefault();
      if (element.dataset.busy) return;
      element.dataset.busy = "1";
      run(() => action(Object.fromEntries(new FormData(element)), element)).finally(() => { delete element.dataset.busy; });
    });
  }
  function assignButton(id, handler) { $(id).addEventListener("click", () => run(handler)); }

  function setupFields() {
    for (const [kind, grades] of Object.entries(priceGrades)) {
      for (const grade of grades) {
        const block = node("div");
        block.append(node("strong", (kind === "bus" ? "公交 " : "地铁 ") + grade));
        for (const [key, label] of [["min", "发布下限（元）"], ["max", "发布上限（元）"]]) {
          const field = node("label", label);
          const input = node("input");
          input.name = kind + ":" + grade + ":" + key;
          input.type = "number";
          input.min = "1";
          input.max = "20000000";
          field.append(input);
          block.append(field);
        }
        $("rateFields").append(block);
      }
    }
    for (const [value, industry] of Object.entries(planner.getIndustries())) {
      const option = node("option", value === "tea" ? "食品饮料 · 茶饮方案" : industry.industry);
      option.value = value;
      $("newIndustry").append(option);
    }
    for (const [key, label] of Object.entries(fields)) {
      const item = node("label", label);
      const field = node("textarea");
      field.id = "assumption-" + key;
      field.maxLength = 1400;
      field.rows = 3;
      item.append(field);
      $("assumptionFields").append(item);
    }
    for (const zone of planner.getZones()) {
      const item = node("label", zone.name);
      const flags = node("select");
      flags.dataset.zone = zone.id;
      for (const [value, name] of [["", "未选"], ["normal", "纳入"], ["key", "重点"]]) {
        const option = node("option", name);
        option.value = value;
        flags.append(option);
      }
      item.append(flags);
      $("targetFields").append(item);
    }
  }

  function formState() {
    const state = planner.getProject();
    state.campaign = $("campaignName").value.trim();
    state.assumptions = Object.fromEntries(Object.keys(fields).map((key) => [key, $("assumption-" + key).value.trim()]));
    const zones = new Map(planner.getZones().map((z) => [z.id, z.name]));
    state.targets = [...$("targetFields").querySelectorAll("select")].filter((input) => input.value).map((input) => ({ id: input.dataset.zone, label: zones.get(input.dataset.zone), priority: input.value === "key" }));
    return state;
  }

  function dirty() { return canEdit() && JSON.stringify({ name: $("projectName").value.trim(), state: formState() }) !== baseline; }
  function editor(projectValue) {
    project = projectValue;
    planner.applyProject(project.state);
    $("projectTitle").textContent = project.name;
    $("projectStatus").textContent = (project.archived ? "已归档" : project.state.sample ? "合成数据练习" : "业务项目") + " · 修订 " + project.revision + " · " + project.updated_by;
    $("projectName").value = project.name;
    $("campaignName").value = project.state.campaign;
    for (const key of Object.keys(fields)) $("assumption-" + key).value = project.state.assumptions[key] || "";
    const target = new Map(project.state.targets.map((z) => [z.id, z]));
    for (const input of $("targetFields").querySelectorAll("select")) input.value = target.has(input.dataset.zone) ? target.get(input.dataset.zone).priority ? "key" : "normal" : "";
    const card = project.state.rateCard;
    const pricingForm = $("pricingForm");
    pricingForm.reset();
    if (card) {
      for (const name of ["source", "discount", "busProductionMin", "busProductionMax", "metroProductionPerSqm"]) pricingForm.elements.namedItem(name).value = card[name];
      for (const [kind, grades] of Object.entries(priceGrades)) for (const grade of grades) for (const key of ["min", "max"]) {
        pricingForm.elements.namedItem(kind + ":" + grade + ":" + key).value = card[kind][grade]?.[key] ?? "";
      }
    }
    const editable = canEdit();
    const executionForm = $("executionForm");
    executionForm.reset();
    for (const input of executionForm.elements) {
      if (input.name && project.state.execution) {
        const value = project.state.execution[input.name];
        input.value = Array.isArray(value) ? value.join("\n") : value ?? "";
      }
      input.disabled = !editable;
    }
    for (const id of ["saveProject", "saveVersion", "toolbarVersion", "applyTargets", "evidenceForm"]) $(id).hidden = !editable;
    $("aiPanel").hidden = !editable || !me.ai;
    for (const item of document.querySelectorAll('[data-project-panel="assumptions"] textarea, [data-project-panel="assumptions"] input, #targetFields select')) item.disabled = !editable;
    for (const item of document.querySelectorAll("#brief input,#brief select,#brief button,[data-action='open-import']")) item.disabled = !editable;
    for (const item of pricingForm.elements) item.disabled = !editable;
    $("archiveProject").hidden = me.role !== "admin";
    $("archiveProject").textContent = project.archived ? "解除归档" : "归档";
    baseline = JSON.stringify({ name: project.name, state: formState() });
  }

  async function team() {
    if (me.role !== "admin") return;
    const members = await api("/api/team");
    $("teamRows").replaceChildren();
    for (const member of members) row($("teamRows"), member.name, roles[member.role], ...(member.role === "admin" ? [] : [button("移除", async () => {
      if (!window.confirm("移除成员 " + member.name + " 并结束该账号会话。")) return;
      await api("/api/team/" + member.name, "DELETE");
      await team();
    })]));
  }

  async function home() {
    if (project && dirty() && !window.confirm("当前编辑尚未保存，确定返回项目列表？")) return;
    project = null;
    $("homePanel").hidden = false;
    $("homeLink").hidden = true;
    $("projectPanel").hidden = true;
    $("workbenchShell").hidden = true;
    $("newProjectLink").hidden = me.role === "viewer";
    $("teamPanel").hidden = me.role !== "admin";
    const records = await api("/api/projects");
    await team();
    $("projects").replaceChildren();
    if (!records.length) $("projects").append(node("p", "团队还没有项目。"));
    for (const record of records) row($("projects"), record.name, (record.archived ? "已归档 · " : "") + "修订 " + record.revision + " · " + describe(record.updated), button("打开", () => open(record.id)));
  }

  async function open(id) {
    editor(await api("/api/projects/" + id));
    history.replaceState(null, "", "#p=" + id);
    $("opsLink").href = "/ops#p=" + encodeURIComponent(id);
    $("projectPanel").hidden = false;
    $("homePanel").hidden = true;
    $("homeLink").hidden = false;
    await select("workbench");
  }
  async function select(name) {
    panel = name;
    $("workbenchShell").hidden = name !== "workbench";
    for (const element of document.querySelectorAll("[data-project-panel]")) element.hidden = element.dataset.projectPanel !== name;
    for (const element of document.querySelectorAll("[data-panel]")) element.setAttribute("aria-pressed", String(element.dataset.panel === name));
    if (name === "versions") await versionList();
    if (name === "evidence") await evidenceList();
  }
  async function save() {
    if (!canEdit()) return false;
    const value = { name: $("projectName").value.trim(), state: formState(), revision: project.revision };
    if (dirty()) editor(await api(projectPath(), "PUT", value));
    return true;
  }
  async function versionList() {
    const [versions, mirrors] = await Promise.all([api(projectPath("/versions")), api(projectPath("/mirrors"))]);
    if (panel !== "versions") return;
    $("versions").replaceChildren();
    $("mirrors").replaceChildren();
    if (!versions.length) $("versions").append(node("p", "保存项目并生成客户版后，版本会出现在这里。"));
    if (!mirrors.length) $("mirrors").append(node("p", "导入并保存后，镜像批次会出现在这里。"));
    for (const version of versions) {
      const preview = link("预览", projectPath("/versions/" + version.id + "/preview"));
      preview.target = "_blank";
      const actions = [preview];
      if (canEdit()) actions.push(button("复制为草稿", async () => {
        if (dirty() && !window.confirm("用此版本作为当前草稿。未保存改动将被替换。")) return;
        const result = await api(projectPath("/versions/" + version.id));
        const current = project;
        editor({ ...current, state: result.state });
        baseline = null;
        await select("workbench");
        tell("历史方案已载入草稿，请保存后生效。");
      }), button("生成分享链接", () => { selectedVersion = version.id; $("shareForm").reset(); $("shareDialog").showModal(); }), button("撤回链接", async () => {
        if (!window.confirm("撤回此版本的所有外部链接。")) return;
        await api(projectPath("/versions/" + version.id + "/share"), "DELETE");
        tell("已撤回该版本的分享链接。");
      }));
      row($("versions"), version.title, "项目修订 " + version.revision + " · " + describe(version.created) + " · " + version.author, ...actions);
    }
    for (const mirror of mirrors) {
      const actions = canEdit() ? [button("载入该批次", async () => {
        const data = await api(projectPath("/mirrors/" + mirror.id));
        const state = formState();
        planner.applyProject({ ...state, data, areaOverrides: {} });
        tell("已载入镜像，请保存项目后生效。");
        await select("workbench");
      })] : [];
      row($("mirrors"), "镜像批次 " + mirror.id.slice(0, 6), describe(mirror.created) + " · " + mirror.author, ...actions);
    }
  }
  async function evidenceList() {
    const records = await api(projectPath("/evidence"));
    if (panel !== "evidence") return;
    $("evidenceRows").replaceChildren();
    if (!records.length) $("evidenceRows").append(node("p", "尚无执行与监测证据。"));
    for (const record of records) row($("evidenceRows"), record.label, record.kind + " · " + describe(record.created) + " · " + record.author, link("下载", projectPath("/evidence/" + record.id)));
  }

  async function begin() {
    try { me = await api("/api/session"); }
    catch (error) {
      if (error.status !== 401) throw error;
      $("signInPanel").hidden = false;
      return;
    }
    if (me.role === "client") { location.href = "/client"; return; }
    $("signInPanel").hidden = true;
    $("signOut").hidden = false;
    $("opsLink").hidden = false;
    $("accountLabel").textContent = me.name + " · " + roles[me.role];
    const selected = new URLSearchParams(location.hash.slice(1)).get("p");
    if (selected && /^[a-zA-Z0-9_-]{32}$/.test(selected)) {
      try { await open(selected); } catch { await home(); }
    } else await home();
  }

  setupFields();
  form("signInForm", async (data, element) => {
    await api("/api/session", "POST", data);
    element.reset();
    tell();
    await begin();
  });
  form("newProjectForm", async (data, element) => {
    const created = await api("/api/projects", "POST", { ...data, sample: data.sample === "on" });
    $("newProjectDialog").close();
    element.reset();
    await open(created.id);
    await select("assumptions");
  });
  form("teamForm", async (data, element) => { await api("/api/team", "POST", data); element.reset(); await team(); tell("成员已添加。"); });
  form("pricingForm", async (data) => {
    const rates = { bus: {}, metro: {}, source: data.source };
    for (const name of ["discount", "busProductionMin", "busProductionMax", "metroProductionPerSqm"]) rates[name] = Number(data[name]);
    for (const [kind, grades] of Object.entries(priceGrades)) for (const grade of grades) {
      const min = data[kind + ":" + grade + ":min"];
      const max = data[kind + ":" + grade + ":max"];
      if (min || max) rates[kind][grade] = { min: Number(min), max: Number(max) };
    }
    const state = { ...formState(), rateCard: rates };
    editor(await api(projectPath(), "PUT", { state, name: $("projectName").value.trim(), revision: project.revision }));
    tell("项目刊例和折扣已保存，报价已重新计算。");
  });
  form("executionForm", async (data) => {
    const execution = { ...data, blackout: data.blackout.split(/[\s,，]+/).filter(Boolean) };
    for (const key of ["busPerNight", "metroPerNight", "buffer", "contactsBus", "contactsMetro"]) execution[key] = Number(data[key]);
    const state = { ...formState(), execution };
    editor(await api(projectPath(), "PUT", { state, name: $("projectName").value.trim(), revision: project.revision }));
    tell("执行与监测配置已保存，下次生成客户版时应用。");
  });
  form("shareForm", async (data) => {
    const result = await api(projectPath("/versions/" + selectedVersion + "/share"), "POST", { days: Number(data.days), approved: data.approved === "on" });
    $("shareDialog").close();
    const target = new URL(result.path, location.origin).href;
    $("portalMessage").replaceChildren(node("span", "只读链接（" + result.days + " 天） "), link(target, target));
    try { await navigator.clipboard.writeText(target); } catch { /* Link remains on screen. */ }
  });
  form("aiForm", async (data) => {
    const result = await api("/api/ai", "POST", { brief: data.brief, anonymized: data.anonymized === "on" });
    for (const key of Object.keys(fields)) {
      const target = $("assumption-" + key);
      if (!target.value.trim() && result[key]) target.value = result[key];
    }
    tell("已将模型草稿填入空白项，请逐条复核。");
  });
  form("evidenceForm", async (data, element) => {
    if (!data.file.size || data.file.size > 2 * 1024 * 1024) throw new Error("每个文件最多 2 MB。");
    const bytes = new Uint8Array(await data.file.arrayBuffer());
    const chunks = [];
    for (let offset = 0; offset < bytes.length; offset += 8192) chunks.push(String.fromCharCode(...bytes.subarray(offset, offset + 8192)));
    await api(projectPath("/evidence"), "POST", { label: data.label, kind: data.kind, type: data.file.type, base64: btoa(chunks.join("")) });
    element.reset();
    tell("证据已保存。");
    await evidenceList();
  });
  const generateVersion = async () => {
    if (!await save()) return;
    await api(projectPath("/versions"), "POST", { revision: project.revision, title: project.state.campaign });
    await select("versions");
    tell("已生成客户版版本。");
  };
  assignButton("homeLink", async () => { history.replaceState(null, "", "/"); $("opsLink").href = "/ops"; await home(); });
  assignButton("newProjectLink", () => $("newProjectDialog").showModal());
  assignButton("closeNewProject", () => $("newProjectDialog").close());
  assignButton("closeShare", () => $("shareDialog").close());
  assignButton("signOut", async () => {
    if (dirty() && !window.confirm("当前编辑尚未保存，确定退出？")) return;
    await api("/api/session", "DELETE"); location.reload();
  });
  assignButton("saveProject", async () => { if (await save()) tell("项目已保存。"); });
  assignButton("saveVersion", generateVersion);
  assignButton("toolbarVersion", generateVersion);
  assignButton("applyTargets", async () => {
    planner.applyProject(formState()); await select("workbench"); tell("已更新目标商圈。");
  });
  assignButton("archiveProject", async () => {
    const archived = !project.archived;
    if (!window.confirm(archived ? "归档后该项目的外部链接会失效。" : "恢复此项目的编辑。")) return;
    editor(await api(projectPath("/archive"), "POST", { archived }));
    tell(archived ? "项目已归档。" : "项目已恢复。");
  });
  for (const tab of document.querySelectorAll("[data-panel]")) tab.addEventListener("click", () => run(() => select(tab.dataset.panel)));
  window.addEventListener("beforeunload", (event) => { if (dirty()) event.preventDefault(); });
  run(begin);
})();
