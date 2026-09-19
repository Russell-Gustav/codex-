const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const { WorkflowDetector, loadSpec } = require("./detector/workflow-detector");
const { AppServerClient } = require("./detector/app-server-client");
const { inspectCodexDesktop, sendToCodexDesktop, stopCodexDesktop } = require("./detector/codex-desktop-bridge");
const { SessionWatcher, defaultSessionsRoot } = require("./detector/session-watcher");
const { locateCodex, recordCodexLocation } = require("./detector/codex-locator");
const { buildSimulationPrompt } = require("./detector/simulation-protocol");
const { FORMAL_DEMO_THREAD_ID, demoEvent, buildFormalDemoTrace } = require("./detector/formal-demo");
const { openEdge } = require("./launchers/edge");
const APP_VERSION = require("./package.json").version;

const HOST = "127.0.0.1";
let PORT = Number(process.env.PORT || 4317);
const PUBLIC_DIR = path.join(__dirname, "public");
const SPEC_PATH = path.join(__dirname, "formal", "default-workflow.awdl.json");
const WORKFLOW_SPEC = loadSpec(SPEC_PATH);
const USER_DATA_DIR = process.env.CODEX_MONITOR_DATA_DIR
  || (process.platform === "win32" && process.env.LOCALAPPDATA
    ? path.join(process.env.LOCALAPPDATA, "CodexThoughtMonitor")
    : path.join(__dirname, ".runtime"));
const LOG_DIR = path.join(USER_DATA_DIR, "logs");
const RUNTIME_DIR = path.join(USER_DATA_DIR, "runtime");
const CODEX_LOCATION_PATH = path.join(RUNTIME_DIR, "codex-location.json");

const clients = new Set();
const eventBuffer = [];
let activeRun = null;
let activeSession = null;
let appClient = null;
let appClientStart = null;
let sessionWatcher = null;
const passiveDetectors = new Map();
let demoRunning = false;
let sequence = 0;
let codexLocation = null;
let codexLocationRecordError = null;
let launcherProcess = null;

function registerLauncherProcess(child) {
  launcherProcess = child;
  child?.once("close", () => { if (launcherProcess === child) launcherProcess = null; });
}

function closeLauncherProcess() {
  const child = launcherProcess;
  launcherProcess = null;
  if (child && !child.killed) child.kill();
}

function discoverCodex() {
  codexLocation = locateCodex();
  try {
    recordCodexLocation(codexLocation, CODEX_LOCATION_PATH);
    codexLocationRecordError = null;
  } catch (error) {
    codexLocationRecordError = error.message;
    console.warn(`Codex位置记录写入失败（不影响启动）：${error.message}`);
  }
  return codexLocation;
}

function sendSse(res, event) {
  if (res.destroyed || res.writableEnded) return false;
  try { res.write(`id: ${event.id}\ndata: ${JSON.stringify(event)}\n\n`); return true; }
  catch { return false; }
}

function broadcast(event) {
  const normalized = {
    id: ++sequence,
    timestamp: new Date().toISOString(),
    ...event,
  };
  eventBuffer.push(normalized);
  if (eventBuffer.length > 500) eventBuffer.shift();
  for (const client of clients) if (!sendSse(client, normalized)) clients.delete(client);
  if (activeRun?.logStream) {
    activeRun.logStream.write(`${JSON.stringify(normalized)}\n`);
  }
  return normalized;
}

function observeAndBroadcast(event) {
  const normalized = broadcast(event);
  if (activeRun?.detector && event.source !== "awdl-detector") {
    for (const alert of activeRun.detector.observe(normalized)) {
      broadcast({ ...alert, runId:activeRun.runId, threadId:activeRun.threadId, turnId:activeRun.turnId });
    }
  }
  return normalized;
}

function observePassive(event) {
  const normalized = broadcast(event);
  if (!event.threadId || event.source === "awdl-detector") return normalized;
  const detectorKey = `${event.threadId}:${event.turnId || "unscoped"}`;
  if (!passiveDetectors.has(detectorKey)) passiveDetectors.set(detectorKey, new WorkflowDetector(WORKFLOW_SPEC));
  const detector = passiveDetectors.get(detectorKey);
  for (const alert of detector.observe(normalized)) broadcast({ ...alert, threadId:event.threadId, turnId:event.turnId });
  if (["COMPLETED", "FAILED", "STOPPED"].includes(event.phase)) passiveDetectors.delete(detectorKey);
  return normalized;
}

function startPassiveListening() {
  if (sessionWatcher?.running) return { listening:true, alreadyRunning:true, root:sessionWatcher.root };
  discoverCodex();
  const watcher = new SessionWatcher({ root:codexLocation?.sessionsRoot || defaultSessionsRoot() });
  watcher.on("event", (event) => {
    if (activeRun?.threadId === event.threadId) {
      if (event.turnId) { activeRun.turnId = event.turnId; if (activeSession) activeSession.turnId = event.turnId; }
      if (!activeRun.deliveryConfirmed && event.category === "input" && event.detail?.includes(activeRun.simulation?.marker)) {
        activeRun.deliveryConfirmed = true;
        broadcast({ category:"system", phase:"STARTED", title:"Codex 当前窗口已确认收到演练", detail:`标记：${activeRun.simulation.marker}\nThread：${event.threadId}\nTurn：${event.turnId || "正在获取"}`, source:"monitor", runId:activeRun.runId, threadId:event.threadId, turnId:event.turnId });
      }
      observeAndBroadcast({ ...event, runId:activeRun.runId });
      if (["COMPLETED", "FAILED", "STOPPED"].includes(event.phase)) finishTurn(event.phase);
    } else observePassive(event);
  });
  watcher.on("watcherError", (error) => broadcast({ category:"error", phase:"RUNNING", title:"Codex 会话监听异常", detail:error.message, source:"session-watcher" }));
  watcher.on("ready", ({ root, files, nativeWatch }) => broadcast({ category:"system", phase:"RUNNING", title:"Codex 常驻监听已启动", detail:`监听目录：${root}\n已挂载现有会话文件：${files}\n原生目录通知：${nativeWatch ? "已启用" : "不可用，使用周期扫描"}\n只读取启动监听之后新增的事件。`, source:"session-watcher" }));
  watcher.start();
  sessionWatcher = watcher;
  return { listening:true, alreadyRunning:false, root:watcher.root };
}

async function currentDesktopThread() {
  const desktop = await inspectCodexDesktop();
  const client = await ensureAppServer();
  const listed = await client.request("thread/list", { limit:100, sortKey:"updated_at" });
  const matches = (listed.data || []).filter((item) => item.name === desktop.title || item.preview === desktop.title);
  return { ...desktop, threadId:matches.length === 1 ? matches[0].id : null, matchCount:matches.length };
}

function stopPassiveListening() {
  if (!sessionWatcher?.running) return { listening:false, alreadyStopped:true };
  const root = sessionWatcher.root;
  sessionWatcher.stop();
  sessionWatcher = null;
  passiveDetectors.clear();
  broadcast({ category:"system", phase:"IDLE", title:"Codex 常驻监听已停止", detail:`已停止读取：${root}`, source:"session-watcher" });
  return { listening:false, alreadyStopped:false };
}

function textFromItem(item = {}) {
  if (typeof item.text === "string") return item.text;
  if (typeof item.content === "string") return item.content;
  if (Array.isArray(item.content)) {
    return item.content
      .map((part) => part.text || part.output_text || part.input_text || "")
      .filter(Boolean)
      .join("\n");
  }
  if (item.command) {
    return Array.isArray(item.command) ? item.command.join(" ") : String(item.command);
  }
  if (item.arguments) {
    return typeof item.arguments === "string"
      ? item.arguments
      : JSON.stringify(item.arguments, null, 2);
  }
  return "";
}

function appServerDetail(method, params = {}) {
  const item = params.item || params.turn || params.thread || params;
  return textFromItem(item)
    || item.message
    || item.error?.message
    || params.delta
    || params.text
    || JSON.stringify(params, null, 2);
}

function classifyAppServer(method, params = {}) {
  const item = params.item || {};
  const joined = `${method} ${item.type || ""}`.toLowerCase();
  let category = "event", phase = "RUNNING", title = method;
  if (method === "mcpServer/startupStatus/updated") { category = "system"; phase = "RUNNING"; title = `MCP ${params.name || "服务"}：${params.status || "状态更新"}`; }
  else if (method === "thread/started") { category = "lifecycle"; phase = "STARTED"; title = "Codex 会话已创建"; }
  else if (method === "turn/started") { category = "lifecycle"; phase = "STARTED"; title = "Codex 开始处理消息"; }
  else if (method === "turn/completed") {
    const status = params.turn?.status;
    category = status === "failed" ? "error" : "lifecycle";
    phase = status === "failed" ? "FAILED" : status === "interrupted" ? "STOPPED" : "COMPLETED";
    title = phase === "FAILED" ? "Codex 处理失败" : phase === "STOPPED" ? "Codex 已中断" : "Codex 完成回复";
  } else if (item.type === "userMessage") { category = "input"; phase = "RUNNING"; title = "用户消息已送达 Codex"; }
  else if (joined.includes("reasoning")) { category = "reasoning"; phase = "REASONING_SUMMARY"; title = "Codex 推理摘要"; }
  else if (joined.includes("command") || joined.includes("filechange") || joined.includes("mcp") || joined.includes("tool")) {
    category = "tool";
    phase = method === "item/completed" ? "OBSERVING" : "TOOL_CALLING";
    title = item.type || method;
  } else if (joined.includes("agentmessage") || joined.includes("message")) { category = "message"; phase = "RESPONDING"; title = "Codex 输出"; }
  else if (joined.includes("error") || joined.includes("failed")) { category = "error"; phase = params.willRetry ? "RUNNING" : "FAILED"; title = params.willRetry ? "Codex 通信异常，正在重试" : "Codex 错误"; }
  return { category, phase, title, detail: appServerDetail(method, params), source: "codex-app-server", raw: { method, params } };
}

function parseBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > 1_000_000) reject(new Error("请求体过大"));
    });
    req.on("end", () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch {
        reject(new Error("请求不是有效JSON"));
      }
    });
    req.on("error", reject);
  });
}

function json(res, status, value) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(value));
}

async function ensureAppServer() {
  if (appClient?.ready) return appClient;
  if (appClientStart) return appClientStart;
  const client = new AppServerClient({
    executable:codexLocation?.executable || undefined,
    env:codexLocation?.codexHome ? { ...process.env, CODEX_HOME:codexLocation.codexHome } : process.env,
  });
  appClient = client;
  client.on("diagnostic", (detail) => broadcast({ category:"stderr", phase:"RUNNING", title:"Codex app-server 诊断", detail, source:"codex-app-server" }));
  client.on("request", (request) => {
    broadcast({ category:"approval", phase:"RUNNING", title:`Codex 请求客户端处理：${request.method}`, detail:JSON.stringify(request.params, null, 2), source:"codex-app-server", raw:request });
    client.respondError(request.id, -32601, "监视器未启用交互式审批；当前会话使用 approvalPolicy=never");
  });
  client.on("notification", ({ method, params = {} }) => {
    const threadId = params.threadId || params.thread?.id;
    if (activeSession?.threadId && threadId && threadId !== activeSession.threadId) return;
    const event = classifyAppServer(method, params);
    const runId = activeRun?.runId || activeSession?.runId;
    const turnId = params.turnId || params.turn?.id || activeRun?.turnId || activeSession?.turnId || null;
    observeAndBroadcast({ ...event, runId, threadId:threadId || activeSession?.threadId || null, turnId });
    if (method === "turn/started" && activeRun) activeRun.turnId = params.turn?.id;
    if (method === "turn/completed" && activeRun) finishTurn(event.phase);
  });
  client.on("close", ({ error }) => {
    if (error) broadcast({ category:"error", phase:"FAILED", title:"Codex 控制连接中断", detail:error.message, source:"monitor", runId:activeRun?.runId });
    if (activeRun) finishTurn("FAILED");
    appClient = null;
  });
  appClientStart = client.start().then(() => client).catch((error) => {
    if (appClient === client) appClient = null;
    throw error;
  }).finally(() => { appClientStart = null; });
  return appClientStart;
}

function createRunLog(threadId = null, detectorSpec = WORKFLOW_SPEC) {
  fs.mkdirSync(LOG_DIR, { recursive:true });
  const runId = `run-${Date.now()}`;
  const logPath = path.join(LOG_DIR, `${runId}.jsonl`);
  const logStream = fs.createWriteStream(logPath, { flags: "a" });
  const detector = new WorkflowDetector(detectorSpec);
  activeRun = { runId, threadId, turnId:null, logStream, logPath, detector, startedAt:Date.now() };
  logStream.on("error", (error) => broadcast({ category:"error", phase:"RUNNING", title:"运行日志不可写", detail:`${logPath}\n${error.message}`, source:"monitor", runId }));
  activeRun.clock = setInterval(() => {
    if (activeRun?.runId !== runId) return;
    for (const alert of detector.checkClock()) broadcast({ ...alert, runId });
  }, 2000);
  return activeRun;
}

function finishTurn(phase) {
  if (!activeRun) return;
  const run = activeRun;
  clearInterval(run.clock);
  // The passive session event that ends the turn is sourced from codex-session.
  // Publish an explicit monitor lifecycle event so the UI can release its
  // simulation controls for completed, failed, and interrupted turns alike.
  broadcast({ category:"lifecycle", phase, title:"真实协同演练已结束", detail:`运行 ${run.runId} 已结束：${phase}`, source:"monitor", runId:run.runId, threadId:run.threadId, turnId:run.turnId });
  run.logStream?.end();
  if (activeSession) activeSession.turnId = null;
  activeRun = null;
  return phase;
}

async function startCooperativeSimulation({ threadId, scenario }) {
  if (activeRun || demoRunning) throw new Error("已有任务或演练正在运行");
  if (!threadId || typeof threadId !== "string") throw new Error("请先在并行任务区选择一个 Codex 会话");
  const simulation = buildSimulationPrompt(scenario);
  const desktop = await currentDesktopThread();
  if (desktop.matchCount !== 1) throw new Error(`无法把当前窗口“${desktop.title}”唯一映射到 Codex 会话（匹配 ${desktop.matchCount} 个）`);
  const visibleThread = { id:desktop.threadId, cwd:null };
  if (threadId && threadId !== desktop.threadId) throw new Error(`监视器所选会话不是 Codex 当前窗口。当前窗口：${desktop.title}（${desktop.threadId}）`);
  if (desktop.busy) throw new Error("当前 Codex 对话仍在处理中，请等待本轮完成后再启动演练");
  if (!sessionWatcher?.running) startPassiveListening();
  const simulationSpec = {
    ...WORKFLOW_SPEC,
    rules:{
      ...WORKFLOW_SPEC.rules,
      repeat_min_duration_ms:0,
      no_progress_min_duration_ms:0,
      planning_churn_min_duration_ms:0,
      silent_timeout_ms:30_000,
    },
  };
  const run = createRunLog(visibleThread.id, simulationSpec);
  run.simulation = simulation;
  run.desktopTitle = desktop.title;
  run.deliveryConfirmed = false;
  run.alertPrompted = false;
  activeSession = { threadId:visibleThread.id, turnId:null, workspace:visibleThread.cwd, sandbox:"read-only", runId:run.runId };
  observeAndBroadcast({
    category:"lifecycle", phase:"STARTING", title:"正在向 Codex 当前窗口发送真实演练",
    detail:`场景：${simulation.name}\n标记：${simulation.marker}\n当前窗口：${desktop.title}\nThread：${visibleThread.id}\n发送后将以原会话日志出现同一标记作为送达依据。`,
    source:"monitor", runId:run.runId, threadId:visibleThread.id,
    simulation:{ id:simulation.id, marker:simulation.marker, scenario:simulation.scenario, disposable:true },
  });
  try {
    const sent = await sendToCodexDesktop({ expectedTitle:desktop.title, text:simulation.prompt });
    return { runId:run.runId, threadId:visibleThread.id, turnId:null, desktop:{ title:desktop.title, sent:sent.sent }, simulation:{ id:simulation.id, marker:simulation.marker, scenario:simulation.scenario, name:simulation.name } };
  } catch (error) {
    observeAndBroadcast({ category:"error", phase:"FAILED", title:"无法向 Codex 当前窗口发送演练", detail:error.message, source:"monitor", runId:run.runId, threadId:visibleThread.id });
    finishTurn("FAILED");
    throw error;
  }
}

function signalChildTermination(child, isStillActive, graceMs = 3000) {
  const accepted = child.kill("SIGTERM");
  const forceTimer = setTimeout(() => {
    if (isStillActive()) child.kill("SIGKILL");
  }, graceMs);
  forceTimer.unref?.();
  return accepted;
}

function startFormalDemo(scenario) {
  if (activeRun || demoRunning) throw new Error("已有任务或形式化演示正在运行");
  const detector = new WorkflowDetector(WORKFLOW_SPEC);
  const events = buildFormalDemoTrace(scenario);
  demoRunning = true;
  events.forEach((event, index) => setTimeout(() => {
    const normalized = broadcast(event);
    for (const alert of detector.observe(normalized)) broadcast({ ...alert, runId:"formal-demo", threadId:FORMAL_DEMO_THREAD_ID });
    if (index === events.length - 1) {
      demoRunning = false;
      broadcast(demoEvent("STOPPED", "lifecycle", "形式化演示结束", "演示轨迹已注入；告警与证据保留在当前视图。"));
    }
  }, index * 420));
  return { scenario, events: events.length };
}

async function requestAgentStop(reason = "用户请求终止", alertCode = null) {
  if (!activeRun) throw new Error("当前没有运行中的Agent任务");
  if (activeRun.stopRequested) return { stopped:true, alreadyRequested:true, runId:activeRun.runId, threadId:activeRun.threadId, turnId:activeRun.turnId };
  activeRun.stopRequested = true;
  activeRun.stopReason = reason;
  const runId = activeRun.runId;
  const threadId = activeRun.threadId;
  const turnId = activeRun.turnId;
  if (!threadId) throw new Error("Codex 会话尚未返回可中断的 threadId");
  observeAndBroadcast({
    category:"lifecycle", phase:"STOP_REQUESTED", title:"已向 Agent 发送终止请求",
    detail:`原因：${reason}${alertCode ? `\n触发告警：${alertCode}` : ""}\nThread：${threadId}\nTurn：${turnId}`,
    source:"monitor", runId,
  });
  if (activeRun.desktopTitle) {
    await stopCodexDesktop({ expectedTitle:activeRun.desktopTitle });
    return { stopped:true, alreadyRequested:false, runId, threadId, turnId, protocol:"desktop-visible-stop" };
  }
  if (!turnId) throw new Error("Codex 会话尚未返回可中断的 turnId");
  await appClient.request("turn/interrupt", { threadId, turnId });
  return { stopped:true, alreadyRequested:false, runId, threadId, turnId, protocol:"turn/interrupt" };
}

function serveStatic(req, res) {
  const pathname = req.url.split("?")[0];
  const urlPath = pathname === "/" ? "/index.html" : pathname;
  const resolved = path.resolve(PUBLIC_DIR, `.${decodeURIComponent(urlPath)}`);
  if (!resolved.startsWith(PUBLIC_DIR + path.sep) && resolved !== path.join(PUBLIC_DIR, "index.html")) {
    res.writeHead(403).end("Forbidden");
    return;
  }
  fs.readFile(resolved, (error, data) => {
    if (error) {
      res.writeHead(404).end("Not found");
      return;
    }
    const ext = path.extname(resolved);
    const contentType = ext === ".html"
      ? "text/html; charset=utf-8"
      : ext === ".js"
        ? "text/javascript; charset=utf-8"
        : ext === ".css"
          ? "text/css; charset=utf-8"
          : ext === ".json"
            ? "application/json; charset=utf-8"
            : "text/plain; charset=utf-8";
    res.writeHead(200, { "Content-Type": contentType, "Cache-Control":"no-store, max-age=0" });
    res.end(data);
  });
}

const server = http.createServer(async (req, res) => {
  if (req.method === "GET" && req.url === "/api/events") {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "Access-Control-Allow-Origin": "*",
    });
    clients.add(res);
    res.on("error", () => clients.delete(res));
    const lastId = Number(req.headers["last-event-id"] || 0);
    if (lastId) for (const event of eventBuffer) if (event.id > lastId) sendSse(res, event);
    sendSse(res, { id: ++sequence, timestamp: new Date().toISOString(), category: "system", phase: activeRun ? "RUNNING" : "IDLE", title: "监视器已连接", detail: "等待Codex事件", source: "monitor" });
    req.on("close", () => clients.delete(res));
    return;
  }

  if (req.method === "GET" && req.url === "/api/status") {
    const listening = Boolean(sessionWatcher?.running);
    json(res, 200, { version:APP_VERSION, running:Boolean(activeRun), connected:listening, connectionMode:"passive-session-watch", listening, listenRoot:sessionWatcher?.root || codexLocation?.sessionsRoot || defaultSessionsRoot(), listener:sessionWatcher?.status() || null, codexLocation, codexLocationRecord:codexLocationRecordError ? null : CODEX_LOCATION_PATH, codexLocationRecordError, userDataRoot:USER_DATA_DIR, runId:activeRun?.runId || null, threadId:activeSession?.threadId || null, turnId:activeRun?.turnId || null, workflow:WORKFLOW_SPEC.workflow, awdlVersion:WORKFLOW_SPEC.version });
    return;
  }

  if (req.method === "GET" && req.url === "/api/spec") {
    json(res, 200, WORKFLOW_SPEC);
    return;
  }

  if (req.method === "GET" && req.url === "/api/desktop/current") {
    try { json(res, 200, await currentDesktopThread()); }
    catch (error) { json(res, 503, { error:error.message }); }
    return;
  }

  if (req.method === "POST" && req.url === "/api/listen/start") {
    try { json(res, 202, startPassiveListening()); }
    catch (error) { json(res, 500, { error:error.message }); }
    return;
  }

  if (req.method === "POST" && req.url === "/api/listen/stop") {
    try { json(res, 200, stopPassiveListening()); }
    catch (error) { json(res, 500, { error:error.message }); }
    return;
  }

  if (req.method === "POST" && req.url === "/api/demo") {
    try {
      const body = await parseBody(req);
      json(res, 202, startFormalDemo(body.scenario));
    } catch (error) {
      json(res, 409, { error: error.message });
    }
    return;
  }

  if (req.method === "POST" && req.url === "/api/simulation/start") {
    try {
      const body = await parseBody(req);
      json(res, 202, await startCooperativeSimulation(body));
    } catch (error) {
      json(res, 409, { error:error.message });
    }
    return;
  }

  if (req.method === "POST" && req.url === "/api/stop") {
    try {
      const body = await parseBody(req);
      json(res, 202, await requestAgentStop(body.reason, body.alertCode));
    } catch (error) {
      json(res, 409, { error: error.message });
    }
    return;
  }

  if (req.method === "POST" && req.url === "/api/open-view") {
    try {
      const body = await parseBody(req);
      const mode = body.mode === "desktop" ? "desktop" : "web";
      const url = `http://${HOST}:${PORT}/?mode=${mode}`;
      const desktopMode = mode === "desktop";
      const profileDir = path.join(RUNTIME_DIR, `edge-${mode}-${Date.now()}`);
      const view = openEdge(url, { appMode:desktopMode, detached:true, profileDir });
      // Edge may hand the new window to another process during first-run setup
      // or after an update. The spawned process exiting does not mean that the
      // visible window was closed, so it must never control the server lifetime.
      view.unref();
      json(res, 202, { opened:true, mode, url, window:desktopMode ? "app" : "browser", lifecycle:"server-independent" });
      const closeTimer = setTimeout(closeLauncherProcess, 500);
      closeTimer.unref?.();
    } catch (error) {
      json(res, 500, { error: error.message });
    }
    return;
  }

  if (req.method === "POST" && req.url === "/api/shutdown") {
    json(res, 202, { shuttingDown: true });
    setTimeout(async () => {
      await stopServer();
      process.exit(0);
    }, 150);
    return;
  }

  if (req.method === "GET") {
    serveStatic(req, res);
    return;
  }
  res.writeHead(405).end("Method not allowed");
});

function startServer() {
  if (server.listening) return Promise.resolve(server);
  fs.mkdirSync(USER_DATA_DIR, { recursive:true });
  const location = discoverCodex();
  console.log(`Codex executable: ${location.executable || "not found (passive monitoring only)"}`);
  console.log(`Codex home: ${location.codexHome || "not found"}`);
  console.log(`Codex location record: ${CODEX_LOCATION_PATH}`);
  return new Promise((resolve, reject) => {
    const onError = (error) => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.off("error", onError);
      console.log(`Codex Thought Monitor: http://${HOST}:${PORT}`);
      console.log(`Logs: ${LOG_DIR}`);
      resolve(server);
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(PORT, HOST);
  });
}

function getServerUrl(pathname = "/") {
  return `http://${HOST}:${PORT}${pathname}`;
}

async function stopServer() {
  stopPassiveListening();
  if (activeRun) {
    try { await requestAgentStop("监视器服务正在关闭"); }
    catch (error) { console.warn(`中断当前任务失败：${error.message}`); }
  }
  if (appClient) {
    try { await appClient.close(); }
    catch (error) { console.warn(`关闭Codex控制连接失败：${error.message}`); }
  }
  for (const client of clients) client.end();
  clients.clear();
  if (!server.listening) return;
  const closed = new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  // Edge keeps HTTP/1.1 connections alive after the SSE stream is closed.
  // Without explicitly closing them, the old executable can keep running
  // after it has released the port and race the next launch.
  server.closeIdleConnections?.();
  server.closeAllConnections?.();
  await closed;
}

if (require.main === module) {
  startServer().catch((error) => {
    console.error(`服务启动失败：${error.message}`);
    process.exitCode = 1;
  });
}

module.exports = { startServer, stopServer, server, HOST, getServerUrl, signalChildTermination, registerLauncherProcess };
