const $ = (selector) => document.querySelector(selector);
const escapeHtml = (value) => String(value ?? "").replace(/[&<>'"]/g, (c) => ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", "'":"&#39;", '"':"&quot;" }[c]));
const state = { events: [], alerts: [], tasks: new Map(), selectedTaskId: null, desktopCurrent: null, spec: null, running: false, listening: false, filter: "reasoning", renderTimer: null };
const MAX_TASKS = 5;
const TEST_TASK_ID = "awdl-test";
let pendingTerminationAlert = null;

function setRunning(value, text) {
  state.running = value;
  if (text) $("#statusText").textContent = text;
}

async function postJson(url, body, timeoutMs = 8000) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { method:"POST", headers:{ "Content-Type":"application/json" }, body:JSON.stringify(body), signal:controller.signal });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(result.error || `请求失败（HTTP ${response.status}）`);
    return result;
  } catch (error) {
    if (error.name === "AbortError") throw new Error(`请求超过 ${Math.round(timeoutMs / 1000)} 秒未响应`);
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchJsonWithRetry(url, attempts = 8) {
  let lastError;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const response = await fetch(url, { cache:"no-store" });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return await response.json();
    } catch (error) {
      lastError = error;
      $("#statusText").textContent = `正在建立连接（${attempt + 1}/${attempts}）`;
      await new Promise((resolve) => setTimeout(resolve, Math.min(250 * 2 ** attempt, 2000)));
    }
  }
  throw lastError;
}

function setListening(value, root) {
  state.listening = value;
  $("#listenStart").disabled = value;
  $("#listenStop").disabled = !value;
  $("#dot").classList.toggle("live", value);
  $("#sessionState").textContent = value ? "监听中" : "未启动";
  if (root) $("#listenRoot").textContent = `会话目录：${root}`;
  $("#statusText").textContent = value ? "正在常驻监听 Codex" : "监视器已连接";
}

function showCodexLocation(location, recordPath) {
  if (!location) return;
  const executable = location.executable || "未找到（仍可使用会话旁路监听）";
  const home = location.codexHome || "未找到";
  $("#codexLocation").textContent = `Codex：${executable}\n数据目录：${home}${recordPath ? `\n检测记录：${recordPath}` : ""}`;
  $("#codexLocation").style.whiteSpace = "pre-wrap";
}

document.querySelectorAll(".tab").forEach((button) => button.addEventListener("click", () => {
  document.querySelectorAll(".tab").forEach((item) => item.classList.toggle("active", item === button));
  document.querySelectorAll(".view").forEach((view) => { view.hidden = view.id !== button.dataset.view; view.classList.toggle("active", !view.hidden); });
}));

function isProgress(event) {
  const item = event.raw?.item || {};
  return event.phase === "COMPLETED" || (event.phase === "OBSERVING" && (item.status === "completed" || item.exit_code === 0));
}

function selectedEvents() {
  if (!state.selectedTaskId) return state.events.filter((event) => !event.threadId);
  return state.events.filter((event) => event.threadId === state.selectedTaskId);
}

function selectedAlerts() {
  return state.alerts.filter((event) => !state.selectedTaskId
    ? !event.threadId
    : event.threadId === state.selectedTaskId);
}

function summaryCards(items) {
  return items.map(({ label, value, tone = "" }) => `<div><span>${escapeHtml(label)}</span><strong class="${tone}">${escapeHtml(value)}</strong></div>`).join("");
}

function renderAnalysisContext() {
  const task = state.selectedTaskId ? state.tasks.get(state.selectedTaskId) : null;
  const title = task?.title || "尚未选择对话";
  const identity = task ? `${title} · ${task.id.slice(0, 8)} · ${task.phase}` : title;
  document.querySelectorAll("[data-view-context]").forEach((host) => { host.textContent = identity; });

  const events = selectedEvents();
  const alerts = selectedAlerts();
  const progressCount = events.filter(isProgress).length;
  const currentPhase = task?.phase || events.at(-1)?.phase || "IDLE";
  $("#logicStats").innerHTML = summaryCards([
    { label:"已分类事件", value:events.filter((event) => event.category !== "alert").length },
    { label:"有效进展", value:progressCount, tone:progressCount ? "healthy" : "" },
    { label:"未构成进展", value:Math.max(0, events.filter((event) => event.category !== "alert").length - progressCount) },
    { label:"当前状态", value:currentPhase },
  ]);

  const evidenceCount = new Set(alerts.flatMap((alert) => alert.detection?.evidence_event_ids || [])).size;
  const highestSeverity = alerts.some((alert) => alert.detection?.severity === "critical") ? "CRITICAL" : alerts.length ? "WARNING" : "NORMAL";
  $("#awdlStats").innerHTML = summaryCards([
    { label:"已评估事件", value:events.length },
    { label:"规则告警", value:alerts.length, tone:alerts.length ? "danger" : "healthy" },
    { label:"证据事件", value:evidenceCount },
    { label:"最高等级", value:highestSeverity, tone:alerts.length ? "danger" : "healthy" },
  ]);

  const laneCounts = [0, 0, 0, 0];
  events.forEach((event) => { laneCounts[laneFor(event)] += 1; });
  $("#communicationStats").innerHTML = summaryCards([
    { label:"监视器 / AWDL", value:laneCounts[0] },
    { label:"Codex", value:laneCounts[1] },
    { label:"工具 / 命令", value:laneCounts[2] },
    { label:"用户输出", value:laneCounts[3] },
  ]);
  renderEventStats();
}

function renderEventStats() {
  const events = selectedEvents();
  const visibleCount = eventsFor(state.filter).length;
  const latest = events.at(-1);
  $("#eventStats").innerHTML = summaryCards([
    { label:"当前分类", value:state.filter.toUpperCase() },
    { label:"分类事件", value:visibleCount },
    { label:"全部事件", value:events.length },
    { label:"最近更新", value:latest ? new Date(latest.timestamp).toLocaleTimeString("zh-CN", { hour12:false }) : "—" },
  ]);
}

function updateTask(event) {
  if (!event.threadId) return;
  let task = state.tasks.get(event.threadId);
  if (!task) {
    const visibleTitle = state.desktopCurrent?.threadId === event.threadId ? state.desktopCurrent.title : null;
    task = { id:event.threadId, title:event.threadId === TEST_TASK_ID ? "内置工作流演示" : visibleTitle || "等待获取窗口标题", phase:"STARTING", updatedAt:0, turnId:null };
    state.tasks.set(event.threadId, task);
    if (!state.selectedTaskId) state.selectedTaskId = event.threadId;
  }
  task.updatedAt = Date.parse(event.timestamp) || Date.now();
  task.phase = event.phase || task.phase;
  task.turnId = event.turnId || task.turnId;
  if (state.tasks.size > MAX_TASKS) {
    const removable = [...state.tasks.values()].filter((item) => item.id !== state.selectedTaskId).sort((a, b) => a.updatedAt - b.updatedAt)[0];
    if (removable) state.tasks.delete(removable.id);
  }
}

function renderTasks() {
  const host = $("#taskCards");
  const tasks = [...state.tasks.values()].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, MAX_TASKS);
  $("#taskCapacity").textContent = `${tasks.length} / ${MAX_TASKS}`;
  if (!tasks.length) { host.className = "task-cards empty-state"; host.textContent = "等待 Codex 对话内容"; return; }
  host.className = "task-cards";
  host.innerHTML = tasks.map((task, index) => {
    const terminal = ["COMPLETED", "FAILED", "STOPPED"].includes(task.phase);
    const statusClass = task.phase === "FAILED" ? "failed" : terminal ? "" : "active";
    const isCurrent = state.desktopCurrent?.threadId === task.id;
    const label = task.id === TEST_TASK_ID ? "演练对话" : isCurrent ? "当前对话" : `对话 ${index + 1}`;
    const meta = task.id === TEST_TASK_ID ? "演练对话" : `对话 ID：${task.id.slice(0, 8)}${task.turnId ? ` · Turn：${task.turnId.slice(0, 8)}` : ""}`;
    return `<button class="task-card ${task.id === state.selectedTaskId ? "selected" : ""}" data-task-id="${escapeHtml(task.id)}"><span class="task-card-head"><span class="task-card-index">${escapeHtml(label)}</span><span class="task-status ${statusClass}">${escapeHtml(task.phase)}</span></span><span class="task-summary">${escapeHtml(task.title)}</span><span class="task-meta">${escapeHtml(meta)}</span></button>`;
  }).join("");
  host.querySelectorAll(".task-card").forEach((button) => button.addEventListener("click", () => { state.selectedTaskId = button.dataset.taskId; renderAll(); }));
}

function workflowSteps() {
  const observable = selectedEvents().filter((event) => event.category !== "alert" && !["system", "stderr", "raw"].includes(event.category));
  return WorkflowLayout.compactWorkflowEvents(observable);
}

function renderWorkflow() {
  const host = $("#workflowCanvas");
  const events = workflowSteps();
  if (!events.length) { host.className = "graph empty-state"; host.textContent = "等待任务事件"; return; }
  host.className = `graph${selectedAlerts().length ? " danger" : ""}`;
  const layout = WorkflowLayout.createWorkflowLayout(events.length);
  const { positions, width, height } = layout;
  const eventIds = new Set(events.map((event) => event.id));
  const scopedAlerts = selectedAlerts().filter((alert) => (alert.detection?.evidence_event_ids || []).some((id) => eventIds.has(id)));
  const evidence = new Set(scopedAlerts.flatMap((alert) => alert.detection?.evidence_event_ids || []));
  let paths = "";
  for (let i = 1; i < positions.length; i += 1) {
    const a = positions[i - 1], b = positions[i], cls = isProgress(events[i]) ? "edge progress" : "edge";
    const dx = b.x - a.x, dy = b.y - a.y, length = Math.hypot(dx, dy) || 1, ux = dx / length, uy = dy / length;
    paths += `<path class="${cls}" marker-end="url(#arrow)" d="M ${a.x + ux * 57} ${a.y + uy * 30} L ${b.x - ux * 57} ${b.y - uy * 30}"/>`;
  }
  for (const alert of scopedAlerts.slice(-3)) {
    const ids = alert.detection?.evidence_event_ids || [];
    const indexes = ids.map((id) => events.findIndex((event) => event.id === id)).filter((index) => index >= 0);
    if (indexes.length > 1) {
      const from = positions[Math.max(...indexes)], to = positions[Math.min(...indexes)];
      const lift = Math.max(36, Math.abs(from.x - to.x) / 4 + 30);
      paths += `<path class="edge loop" marker-end="url(#loopArrow)" d="M ${from.x} ${from.y - 29} C ${from.x} ${from.y - lift}, ${to.x} ${to.y - lift}, ${to.x} ${to.y - 29}"/>`;
    } else if (indexes.length === 1) {
      const point = positions[indexes[0]];
      paths += `<path class="edge loop" marker-end="url(#loopArrow)" d="M ${point.x + 25} ${point.y - 28} C ${point.x + 85} ${point.y - 85}, ${point.x - 85} ${point.y - 85}, ${point.x - 25} ${point.y - 28}"/>`;
    }
  }
  const nodes = events.map((event, index) => {
    const p = positions[index], classes = ["node", index === events.length - 1 ? "current" : "", evidence.has(event.id) ? "loop" : ""].join(" ");
    return `<g class="${classes}" transform="translate(${p.x - 55} ${p.y - 28})"><rect width="110" height="56" rx="9"/><text x="55" y="22" text-anchor="middle">${escapeHtml(event.phase || "EVENT")}</text><text class="sub" x="55" y="40" text-anchor="middle">#${event.windowStep} · ${escapeHtml(event.category)}</text></g>`;
  }).join("");
  host.innerHTML = `<svg style="height:${height}px" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" role="img" aria-label="Agent 工作流状态图，共 ${layout.rows} 行，每行最多 6 个状态"><defs><marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto"><path d="M0 0L10 5L0 10z" fill="#59728f"/></marker><marker id="loopArrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0 0L10 5L0 10z" fill="#ff5367"/></marker></defs>${paths}${nodes}</svg>`;
  host.scrollLeft = 0;
  requestAnimationFrame(() => { host.scrollTop = Math.max(0, host.scrollHeight - host.clientHeight); });
}

function renderLogic() {
  const host = $("#logicFeed"), events = selectedEvents().filter((event) => event.category !== "alert").slice(-16).reverse();
  if (!events.length) { host.className = "logic-feed empty-state"; host.textContent = "当前对话尚无逻辑层事件"; return; }
  host.className = "logic-feed";
  host.innerHTML = events.map((event) => `<div class="logic-item"><span class="badge">${escapeHtml(event.phase)}</span><span>${escapeHtml(event.category)} · ${escapeHtml(event.source)}</span><span class="${isProgress(event) ? "yes" : "no"}">${isProgress(event) ? "✓ 产生可验证进展" : "— 尚未构成进展"}　${escapeHtml(event.title)}</span></div>`).join("");
}

function renderSpec() {
  if (!state.spec) return;
  const rules = state.spec.rules;
  $("#specSummary").innerHTML = `<div><span>工作流</span><strong>${escapeHtml(state.spec.workflow)}</strong></div><div><span>语言版本</span><strong>AWDL ${escapeHtml(state.spec.version)}</strong></div><div><span>状态/终态</span><strong>${state.spec.states.length} / ${state.spec.terminal.length}</strong></div><div><span>事件预算</span><strong>${rules.max_events}</strong></div><div><span>无进展窗口</span><strong>${rules.no_progress_window}</strong></div><div><span>静默阈值</span><strong>${Math.round(rules.silent_timeout_ms / 1000)} 秒</strong></div>`;
  $("#transitionMap").innerHTML = Object.entries(state.spec.transitions).map(([from, to]) => `<div><b>${escapeHtml(from)}</b> → ${to.map(escapeHtml).join(" · ")}</div>`).join("");
}

function renderAlerts() {
  const host = $("#alertFeed"), alarm = $("#workflowAlert");
  const alerts = selectedAlerts();
  if (!alerts.length) { host.className = "alert-feed empty-state"; host.textContent = "尚未触发规则"; alarm.hidden = true; return; }
  host.className = "alert-feed";
  host.innerHTML = alerts.slice().reverse().map((alert) => `<article class="alert-item"><strong>${escapeHtml(alert.detection?.code || alert.title)}</strong><p>${escapeHtml(alert.detail)}</p><small>规则 ${escapeHtml(alert.detection?.rule || "-")} · 证据事件 ${(alert.detection?.evidence_event_ids || []).join(", ") || "无"}</small></article>`).join("");
  const latest = alerts[alerts.length - 1];
  alarm.hidden = false;
  alarm.innerHTML = `<strong>⚠ ${escapeHtml(latest.detection?.code || latest.title)}</strong>${escapeHtml(latest.detail)}`;
}

function laneFor(event) { if (event.source === "monitor" || event.source === "awdl-detector") return 0; if (event.category === "tool" || event.category === "stderr") return 2; if (event.category === "message") return 3; return 1; }
function renderCommunication() {
  const host = $("#sequence"), events = selectedEvents().slice(-18);
  if (!events.length) { host.className = "sequence empty-state"; host.textContent = "当前对话尚无通信事件"; return; }
  host.className = "sequence";
  const height = Math.max(300, events.length * 42 + 25);
  const messages = events.map((event, index) => {
    const lane = laneFor(event), previous = index ? laneFor(events[index - 1]) : 0, from = Math.min(previous, lane), span = Math.max(1, Math.abs(lane - previous));
    return `<div class="comm-event ${lane < previous ? "reverse" : ""}" style="top:${index * 42 + 8}px;left:calc(${from * 25}% + 7px);width:calc(${span * 25}% - 14px)"><span>${escapeHtml(event.title)}</span><i class="line"></i></div>`;
  }).join("");
  host.innerHTML = `<div class="lanes" style="height:${height}px"><div class="lane-title">监视器 / AWDL</div><div class="lane-title">Codex</div><div class="lane-title">工具 / 命令</div><div class="lane-title">用户输出</div><div class="lane"></div><div class="lane"></div><div class="lane"></div><div class="lane"></div>${messages}</div>`;
}

function syntheticEvent(category, phase, title, detail, sourceEvent) {
  return { id:`summary-${category}-${sourceEvent?.id || "pending"}`, timestamp:sourceEvent?.timestamp || new Date().toISOString(), category, phase, source:"monitor-summary", title, detail };
}

function eventsFor(filter) {
  const taskEvents = selectedEvents();
  const terminal = [...taskEvents].reverse().find((event) => ["COMPLETED", "FAILED", "STOPPED"].includes(event.phase));
  const errors = taskEvents.filter((event) => event.category === "error" || event.category === "stderr");
  if (filter === "reasoning") {
    const result = taskEvents.filter((event) => event.category === "reasoning");
    if (terminal) {
      const failed = terminal.phase === "FAILED";
      const evidence = errors
        .filter((event) => event.detail && !/^Reading additional input from stdin/i.test(event.detail))
        .slice(-3)
        .map((event) => event.detail);
      const detail = failed
        ? `任务未能完成。终止状态：FAILED。\n失败前共观察到 ${taskEvents.length} 个事件、${errors.length} 条异常诊断。${evidence.length ? `\n\n关键依据：\n- ${evidence.join("\n- ")}` : "\n未收到更具体的错误信息，请查看“异常”页。"}\n\n建议：优先检查最后一条诊断涉及的权限、依赖或外部服务，然后重新运行。`
        : terminal.phase === "COMPLETED"
          ? `任务正常完成。共观察到 ${taskEvents.length} 个事件、${taskEvents.filter((event) => event.category === "tool").length} 个工具事件，AWDL 告警 ${selectedAlerts().length} 条。`
          : `任务已由用户停止。停止前共观察到 ${taskEvents.length} 个事件。`;
      result.push(syntheticEvent("reasoning", terminal.phase, failed ? "失败后的监测总结" : "任务结果总结", detail, terminal));
    }
    return result;
  }
  if (filter === "tool") return taskEvents.filter((event) => event.category === "tool");
  if (filter === "message") {
    const result = taskEvents.filter((event) => event.category === "message" || event.category === "input");
    if (terminal && !result.length) result.push(syntheticEvent("message", terminal.phase, "任务没有产生用户输出", `任务以 ${terminal.phase} 结束，但 Codex CLI 没有返回可展示的 Agent 消息。`, terminal));
    return result;
  }
  if (filter === "error") return errors;
  if (filter === "alert") return taskEvents.filter((event) => event.category === "alert");
  return [];
}

function updateFilterCounts() {
  for (const filter of ["reasoning", "tool", "message", "error", "alert"]) {
    const counter = document.querySelector(`[data-count="${filter}"]`);
    if (counter) counter.textContent = eventsFor(filter).length;
  }
}

function renderTimeline() {
  const host = $("#timeline"), visible = eventsFor(state.filter).slice().reverse();
  updateFilterCounts();
  renderEventStats();
  if (!visible.length) {
    const empty = { reasoning:"尚无公开推理摘要；任务结束后会自动生成监测总结。", tool:"任务尚未调用工具或执行命令。", message:"尚未观察到 Codex 对话。", error:"当前没有异常或诊断错误。", alert:"当前没有触发 AWDL 形式化规则。" };
    host.className = "timeline empty-state"; host.textContent = empty[state.filter]; return;
  }
  host.className = "timeline";
  host.innerHTML = visible.slice(0, 200).map((event) => `<article class="event ${escapeHtml(event.category)}"><div class="time">${new Date(event.timestamp).toLocaleTimeString("zh-CN", { hour12:false })}</div><div><span class="badge">${escapeHtml(event.phase || event.category)}</span><div class="time">${escapeHtml(event.source)}</div></div><div><h3>${escapeHtml(event.title)}</h3><pre class="detail">${escapeHtml(event.detail)}</pre>${event.raw ? `<details><summary>查看原始 JSON</summary><pre>${escapeHtml(JSON.stringify(event.raw, null, 2))}</pre></details>` : ""}</div></article>`).join("");
}

function renderAll() {
  state.renderTimer = null;
  renderTasks(); renderAnalysisContext(); renderWorkflow(); renderLogic(); renderAlerts(); renderCommunication(); renderTimeline();
}

function scheduleRender() {
  if (state.renderTimer) return;
  state.renderTimer = setTimeout(renderAll, 120);
}

function addEvent(event) {
  updateTask(event);
  state.events.push(event); if (state.events.length > 300) state.events.splice(0, state.events.length - 300);
  if (event.category === "alert") { state.alerts.push(event); if (state.alerts.length > 100) state.alerts.shift(); }
  if (event.phase === "COMPLETED") {
    const transient = new Set(["NO_PROGRESS", "PLANNING_CHURN", "SILENT_STALL", "EVENT_BUDGET_EXCEEDED"]);
    const sameTurn = (alert) => alert.threadId === event.threadId && (!event.turnId || alert.turnId === event.turnId);
    state.alerts = state.alerts.filter((alert) => !(sameTurn(alert) && transient.has(alert.detection?.code || alert.title)));
    state.events = state.events.filter((item) => !(item.category === "alert" && sameTurn(item) && transient.has(item.detection?.code || item.title)));
  }
  $("#eventCount").textContent = state.events.length; $("#alertCount").textContent = state.alerts.length; $("#currentPhase").textContent = event.phase || "EVENT";
  if (["COMPLETED", "FAILED", "STOPPED"].includes(event.phase) && (event.source === "monitor" || (event.source === "codex-app-server" && state.running))) {
    setRunning(false, { COMPLETED:"任务已完成", FAILED:"任务异常结束", STOPPED:"任务已停止" }[event.phase]);
    document.querySelectorAll("[data-simulation]").forEach((button) => { button.disabled = false; });
    const simulationState = $("#simulationState");
    simulationState.className = "simulation-state";
    simulationState.textContent = event.phase === "STOPPED" ? "演练已被真实中断" : `演练已结束：${event.phase}`;
  }
  if (event.phase === "STOPPED" && event.source === "awdl-demo") $("#statusText").textContent = "形式化演示完成";
  if (event.category === "alert" && event.source === "awdl-detector" && event.runId !== "formal-demo" && state.running && !event.nativePrompt) promptForTermination(event);
  scheduleRender();
}

function promptForTermination(alert) {
  pendingTerminationAlert = alert;
  $("#terminationMessage").textContent = `${alert.detail} 是否立即终止当前 Agent，防止它继续消耗时间和调用预算？`;
  $("#terminationEvidence").textContent = `规则：${alert.detection?.rule || "-"}\n告警：${alert.detection?.code || alert.title}\n严重等级：${alert.detection?.severity || "warning"}\n证据事件：${(alert.detection?.evidence_event_ids || []).join(", ") || "无"}`;
  const dialog = $("#terminationDialog");
  if (!dialog.open) dialog.showModal();
}

$("#continueAgent").addEventListener("click", () => { pendingTerminationAlert = null; $("#terminationDialog").close(); });
$("#terminateAgent").addEventListener("click", async () => {
  const button = $("#terminateAgent");
  button.disabled = true;
  button.textContent = "正在终止……";
  const alert = pendingTerminationAlert;
  try {
    const result = await postJson("/api/stop", { reason:"用户确认终止异常工作流", alertCode:alert?.detection?.code || alert?.title || null });
    $("#statusText").textContent = `中断请求已发送 · Turn ${result.turnId?.slice(0, 8) || "-"}`;
  } catch (error) {
    addEvent({ id:`stop-error-${Date.now()}`, timestamp:new Date().toISOString(), category:"error", phase:"FAILED", source:"monitor", title:"终止 Agent 失败", detail:error.message });
  } finally {
    $("#terminationDialog").close(); pendingTerminationAlert = null; button.disabled = false; button.textContent = "终止 Agent";
  }
});

document.querySelectorAll(".filter").forEach((button) => button.addEventListener("click", () => { document.querySelectorAll(".filter").forEach((item) => item.classList.toggle("active", item === button)); state.filter = button.dataset.filter; renderTimeline(); }));
function clearSelectedTaskView() {
  const selectedId = state.selectedTaskId;
  const belongsToSelection = (event) => selectedId ? event.threadId === selectedId : !event.threadId;
  state.events = state.events.filter((event) => !belongsToSelection(event));
  state.alerts = state.alerts.filter((event) => !belongsToSelection(event));
  const task = selectedId ? state.tasks.get(selectedId) : null;
  if (task) {
    task.phase = "CLEARED";
    task.turnId = null;
  }
  $("#eventCount").textContent = state.events.length;
  $("#alertCount").textContent = state.alerts.length;
  $("#currentPhase").textContent = task?.phase || "IDLE";
  renderAll();
  if (!selectedEvents().length) {
    $("#logicFeed").className = "logic-feed empty-state";
    $("#logicFeed").textContent = "当前任务尚无逻辑层事件";
    $("#sequence").className = "sequence empty-state";
    $("#sequence").textContent = "当前任务尚无通信事件";
  }
}

document.querySelectorAll(".clear-view").forEach((button) => button.addEventListener("click", clearSelectedTaskView));

$("#listenStart").addEventListener("click", async () => {
  $("#listenStart").disabled = true; $("#statusText").textContent = "正在挂载 Codex 会话目录";
  try {
    const result = await postJson("/api/listen/start", {});
    setListening(true, result.root);
  } catch (error) {
    // A browser request can be interrupted while the server has already
    // mounted the watcher. Always ask the server for the authoritative state
    // before presenting a failure or re-enabling the start button.
    try {
      const status = await fetch("/api/status", { cache:"no-store" }).then((response) => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return response.json();
      });
      if (status.listening) {
        setListening(true, status.listenRoot);
        $("#statusText").textContent = "监听已启动（状态已自动校正）";
        return;
      }
    } catch {}
    addEvent({ id:`listen-${Date.now()}`, timestamp:new Date().toISOString(), category:"error", phase:"FAILED", source:"monitor", title:"启动监听失败", detail:error.message });
    setListening(false);
    $("#statusText").textContent = "监听启动失败";
    $("#listenRoot").textContent = `启动失败：${error.message}`;
  }
});
$("#listenStop").addEventListener("click", async () => {
  $("#listenStop").disabled = true;
  try { await postJson("/api/listen/stop", {}); setListening(false); }
  catch (error) {
    addEvent({ id:`listen-stop-${Date.now()}`, timestamp:new Date().toISOString(), category:"error", phase:"FAILED", source:"monitor", title:"停止监听失败", detail:error.message });
    try {
      const status = await fetch("/api/status", { cache:"no-store" }).then((response) => response.json());
      setListening(status.listening, status.listenRoot);
    } catch { setListening(true); }
  }
});
document.querySelectorAll("[data-demo]").forEach((button) => button.addEventListener("click", async () => {
  document.querySelectorAll("[data-demo]").forEach((item) => { item.disabled = true; });
  state.selectedTaskId = TEST_TASK_ID;
  renderAll();
  document.querySelector('[data-view="workflow"]').click();
  $("#statusText").textContent = "正在注入 AWDL 验证轨迹";
  const response = await fetch("/api/demo", { method:"POST", headers:{"Content-Type":"application/json"}, body:JSON.stringify({ scenario:button.dataset.demo }) });
  const result = await response.json();
  if (!response.ok) addEvent({ id:`demo-error-${Date.now()}`, timestamp:new Date().toISOString(), category:"error", phase:"FAILED", source:"monitor", title:"无法启动形式化演示", detail:result.error });
  setTimeout(() => { document.querySelectorAll("[data-demo]").forEach((item) => { item.disabled = false; }); }, 3000);
}));

document.querySelectorAll("[data-simulation]").forEach((button) => button.addEventListener("click", async () => {
  const simulationState = $("#simulationState");
  if (!state.desktopCurrent?.threadId) {
    simulationState.className = "simulation-state failed";
    simulationState.textContent = "尚未把 Codex 当前窗口唯一映射到会话";
    return;
  }
  // Passive session events can arrive out of order and their displayed phase is
  // not authoritative. The server resumes the thread and checks Codex's actual
  // status immediately before starting the simulation.
  document.querySelectorAll("[data-simulation]").forEach((item) => { item.disabled = true; });
  simulationState.className = "simulation-state active";
  simulationState.textContent = "正在把一次性演练协议发送到当前 Codex 会话……";
  try {
    const result = await postJson("/api/simulation/start", { threadId:state.desktopCurrent.threadId, scenario:button.dataset.simulation }, 20_000);
    state.selectedTaskId = result.threadId;
    setRunning(true, "真实 Agent 协同演练运行中");
    simulationState.textContent = `${result.simulation.name} · ${result.simulation.marker}\n已发送到当前窗口“${result.desktop.title}”，正在等待原会话回报 Turn`;
    renderAll();
    document.querySelector('[data-view="workflow"]').click();
  } catch (error) {
    simulationState.className = "simulation-state failed";
    simulationState.textContent = `启动失败：${error.message}`;
    document.querySelectorAll("[data-simulation]").forEach((item) => { item.disabled = false; });
  }
}));

const stream = new EventSource("/api/events");
stream.onopen = () => { $("#statusText").textContent = state.listening ? "正在常驻监听 Codex" : "监视器已连接"; };
stream.onerror = () => { $("#statusText").textContent = "事件连接中断，正在重连"; };
stream.onmessage = (message) => addEvent(JSON.parse(message.data));
fetchJsonWithRetry("/api/status").then((status) => { setListening(status.listening, status.listenRoot); showCodexLocation(status.codexLocation, status.codexLocationRecord); setRunning(status.running); $("#appVersion").textContent = `v${status.version || "未知"}`; }).catch((error) => { $("#statusText").textContent = `连接失败：${error.message}`; });
async function refreshDesktopCurrent() {
  try {
    const response = await fetch("/api/desktop/current", { cache:"no-store" });
    const current = await response.json();
    if (!response.ok) throw new Error(current.error || `HTTP ${response.status}`);
    state.desktopCurrent = current;
    if (current.threadId) {
      const task = state.tasks.get(current.threadId);
      if (task) task.title = current.title || "Codex 当前对话";
    }
    $("#desktopCurrent").textContent = `Codex 当前窗口：${current.title}\nThread：${current.threadId || `无法唯一匹配（${current.matchCount}）`}\n状态：${current.busy ? "处理中" : "空闲，可发送"}`;
    $("#desktopCurrent").style.whiteSpace = "pre-wrap";
    renderTasks();
  } catch (error) { state.desktopCurrent = null; $("#desktopCurrent").textContent = `当前窗口识别失败：${error.message}`; }
}
refreshDesktopCurrent();
setInterval(refreshDesktopCurrent, 5000);
fetchJsonWithRetry("/api/spec").then((spec) => { state.spec = spec; renderSpec(); }).catch(() => { $("#specSummary").textContent = "规范加载失败"; });
$("#runtimeMode").textContent = new URLSearchParams(location.search).get("mode") === "desktop" ? "Desktop" : "Web";
