const fs = require("node:fs");
const path = require("node:path");
const { EventEmitter } = require("node:events");

function defaultSessionsRoot(env = process.env) {
  const codexHome = env.CODEX_HOME || (env.USERPROFILE ? path.join(env.USERPROFILE, ".codex") : null);
  return codexHome ? path.join(codexHome, "sessions") : null;
}

function listRollouts(root) {
  const files = [];
  const visit = (directory) => {
    let entries;
    try { entries = fs.readdirSync(directory, { withFileTypes:true }); }
    catch { return; }
    for (const entry of entries) {
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(target);
      else if (entry.isFile() && /^rollout-.*\.jsonl$/i.test(entry.name)) files.push(target);
    }
  };
  visit(root);
  return files;
}

function contentText(content) {
  if (!Array.isArray(content)) return "";
  return clip(content.map((part) => part.text || part.input_text || part.output_text || "").filter(Boolean).join("\n"));
}

function clip(value, limit = 12_000) {
  const text = String(value || "");
  return text.length > limit ? `${text.slice(0, limit)}\n…内容已截断（原始长度 ${text.length}）` : text;
}

function activeTurnAtEnd(file) {
  let text;
  try {
    const stat = fs.statSync(file);
    const length = Math.min(stat.size, 512 * 1024);
    const buffer = Buffer.alloc(length);
    const handle = fs.openSync(file, "r");
    try { fs.readSync(handle, buffer, 0, length, stat.size - length); }
    finally { fs.closeSync(handle); }
    text = buffer.toString("utf8");
  } catch { return null; }
  let active = null;
  for (const line of text.split(/\r?\n/)) {
    try {
      const record = JSON.parse(line);
      const type = record.payload?.type;
      if (type === "task_started" && record.payload?.turn_id) active = record.payload.turn_id;
      else if (["task_complete", "task_completed", "turn_completed", "turn_aborted", "task_aborted", "turn_cancelled"].includes(type)) active = null;
    } catch {}
  }
  return active;
}

function itemEvent(item = {}, completed = false) {
  const type = String(item.type || "").toLowerCase();
  if (type === "usermessage") return { category:"input", phase:"RESPONDING", title:"用户向 Codex 发送消息", detail:contentText(item.content) };
  if (type === "agentmessage") return { category:"message", phase:"RESPONDING", title:"Codex 回复", detail:contentText(item.content) || item.text || "" };
  if (type === "reasoning") return { category:"reasoning", phase:"REASONING_SUMMARY", title:"Codex 推理阶段", detail:(item.summary_text || []).join("\n") || "推理阶段已更新" };
  if (type.includes("command")) return { category:"tool", phase:completed ? "OBSERVING" : "TOOL_CALLING", title:"Codex 执行命令", detail:clip(Array.isArray(item.command) ? item.command.join(" ") : item.command || item.aggregated_output || item.output || "") };
  if (type === "extension") return { category:"tool", phase:completed ? "OBSERVING" : "TOOL_CALLING", title:item.kind || "Codex 调用扩展", detail:item.query || item.name || JSON.stringify(item.action || {}, null, 2) };
  if (type.includes("tool") || type.includes("function") || type.includes("mcp")) return { category:"tool", phase:completed ? "OBSERVING" : "TOOL_CALLING", title:item.name || item.type || "Codex 调用工具", detail:item.arguments ? JSON.stringify(item.arguments, null, 2) : item.output || "" };
  return null;
}

function classifyRolloutRecord(record, filePath) {
  const payload = record.payload || {};
  const fileThreadId = path.basename(filePath).match(/([0-9a-f]{8}-[0-9a-f-]{27,})\.jsonl$/i)?.[1] || null;
  const threadId = payload.thread_id || payload.session_id || (record.type === "session_meta" ? payload.id : null) || fileThreadId;
  const turnId = payload.turn_id || payload.root_turn_id || null;
  const base = { timestamp:record.timestamp, source:"codex-session", threadId, turnId, raw:{ type:record.type, ordinal:record.ordinal, payloadType:payload.type, itemType:payload.item?.type, itemId:payload.item?.id || payload.id, role:payload.role } };
  if (record.type === "session_meta") return { ...base, category:"lifecycle", phase:"STARTING", title:"发现 Codex 会话", detail:`工作目录：${payload.cwd || "未知"}\n来源：${payload.originator || payload.source || "Codex"}` };
  if (record.type === "event_msg") {
    if (payload.type === "task_started") return { ...base, category:"lifecycle", phase:"STARTED", title:"Codex 开始处理新消息", detail:`Turn：${turnId || "未知"}` };
    if (["task_complete", "task_completed", "turn_completed"].includes(payload.type)) return { ...base, category:"lifecycle", phase:"COMPLETED", title:"Codex 本轮工作完成", detail:payload.last_agent_message || `Turn：${turnId || "未知"}` };
    if (["turn_aborted", "task_aborted", "turn_cancelled"].includes(payload.type)) return { ...base, category:"lifecycle", phase:"STOPPED", title:"Codex 本轮工作已停止", detail:payload.reason || `Turn：${turnId || "未知"}` };
    if (payload.type === "error") return { ...base, category:"error", phase:"FAILED", title:"Codex 工作流错误", detail:payload.message || payload.error?.message || JSON.stringify(payload.error || {}, null, 2) };
    if (payload.type === "item_started" || payload.type === "item_completed") {
      const event = itemEvent(payload.item, payload.type === "item_completed");
      return event ? { ...base, ...event } : null;
    }
  }
  if (record.type === "response_item") {
    if (payload.type === "message" && ["user", "assistant"].includes(payload.role)) {
      return { ...base, category:payload.role === "user" ? "input" : "message", phase:"RESPONDING", title:payload.role === "user" ? "用户向 Codex 发送消息" : "Codex 回复", detail:contentText(payload.content) };
    }
    if (payload.type === "custom_tool_call") return { ...base, category:"tool", phase:"TOOL_CALLING", title:payload.name || "Codex 调用工具", detail:clip(typeof payload.input === "string" ? payload.input : JSON.stringify(payload.input || {}, null, 2)) };
    if (payload.type === "custom_tool_call_output") return { ...base, category:"tool", phase:"OBSERVING", title:"工具返回结果", detail:contentText(payload.output) };
  }
  return null;
}

class SessionWatcher extends EventEmitter {
  constructor(options = {}) {
    super();
    this.root = options.root || defaultSessionsRoot(options.env);
    this.intervalMs = options.intervalMs || 2000;
    this.files = new Map();
    this.fragments = new Map();
    this.activeTurns = new Map();
    this.timer = null;
    this.fsWatcher = null;
    this.scanTimer = null;
    this.scanning = false;
    this.lastScanAt = null;
    this.lastEventAt = null;
    this.errorCount = 0;
  }

  start() {
    if (this.running) return;
    if (!this.root || !fs.existsSync(this.root)) throw new Error(`找不到 Codex 会话目录：${this.root || "未配置"}`);
    for (const file of listRollouts(this.root)) {
      const stat = fs.statSync(file);
      this.files.set(file, this.#fileState(stat, stat.size));
      const activeTurn = activeTurnAtEnd(file);
      if (activeTurn) this.activeTurns.set(file, activeTurn);
    }
    this.timer = setInterval(() => this.scan(), this.intervalMs);
    this.timer.unref?.();
    try {
      this.fsWatcher = fs.watch(this.root, { recursive:true }, () => this.#scheduleScan());
      this.fsWatcher.on("error", (error) => this.#reportError(error));
    } catch (error) {
      this.#reportError(new Error(`原生目录通知不可用，已使用周期扫描：${error.message}`));
    }
    this.emit("ready", { root:this.root, files:this.files.size, nativeWatch:Boolean(this.fsWatcher) });
  }

  scan() {
    if (!this.running || this.scanning) return;
    this.scanning = true;
    this.lastScanAt = Date.now();
    try {
    for (const file of listRollouts(this.root)) {
      let stat;
      try { stat = fs.statSync(file); } catch { continue; }
      const previous = this.files.get(file);
      let position = previous?.position ?? 0;
      const identity = this.#identity(stat);
      const replaced = previous && previous.identity !== identity;
      const rewritten = previous && stat.size === position && stat.mtimeMs > previous.mtimeMs;
      if (replaced || rewritten || stat.size < position) { position = 0; this.fragments.delete(file); }
      if (stat.size === position) { this.files.set(file, this.#fileState(stat, position)); continue; }
      const length = stat.size - position;
      const buffer = Buffer.allocUnsafe(length);
      let handle;
      try {
        handle = fs.openSync(file, "r");
        let offset = 0;
        while (offset < length) {
          const bytesRead = fs.readSync(handle, buffer, offset, length - offset, position + offset);
          if (!bytesRead) break;
          offset += bytesRead;
        }
      } catch (error) { this.#reportError(error); continue; }
      finally { if (handle !== undefined) fs.closeSync(handle); }
      this.files.set(file, this.#fileState(stat, stat.size));
      const bytes = this.fragments.has(file) ? Buffer.concat([this.fragments.get(file), buffer]) : buffer;
      let start = 0;
      for (let index = 0; index < bytes.length; index += 1) {
        if (bytes[index] !== 0x0a) continue;
        const line = bytes.subarray(start, index).toString("utf8").replace(/\r$/, "");
        start = index + 1;
        if (!line.trim()) continue;
        try {
          const raw = JSON.parse(line);
          this.#emitRecord(raw, file);
        } catch (error) { this.#reportError(new Error(`${path.basename(file)} 增量记录解析失败：${error.message}`)); }
      }
      const tail = bytes.subarray(start);
      if (tail.length) {
        try {
          const raw = JSON.parse(tail.toString("utf8"));
          this.#emitRecord(raw, file);
          this.fragments.set(file, Buffer.alloc(0));
        } catch { this.fragments.set(file, tail); }
      } else this.fragments.set(file, Buffer.alloc(0));
    }
    } finally { this.scanning = false; }
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    if (this.scanTimer) clearTimeout(this.scanTimer);
    if (this.fsWatcher) this.fsWatcher.close();
    this.timer = null;
    this.scanTimer = null;
    this.fsWatcher = null;
    this.files.clear();
    this.fragments.clear();
    this.activeTurns.clear();
    this.scanning = false;
  }

  #scheduleScan() {
    if (!this.running || this.scanTimer) return;
    this.scanTimer = setTimeout(() => { this.scanTimer = null; this.scan(); }, 80);
    this.scanTimer.unref?.();
  }

  #emitRecord(raw, file) {
    const event = classifyRolloutRecord(raw, file);
    if (!event) return;
    if (event.phase === "STARTED" && event.turnId) this.activeTurns.set(file, event.turnId);
    else if (!event.turnId && this.activeTurns.has(file)) event.turnId = this.activeTurns.get(file);
    this.lastEventAt = Date.now();
    this.emit("event", event);
    if (["COMPLETED", "FAILED", "STOPPED"].includes(event.phase)) this.activeTurns.delete(file);
  }

  #identity(stat) { return `${stat.dev}:${stat.ino}:${stat.birthtimeMs}`; }
  #fileState(stat, position) { return { position, identity:this.#identity(stat), mtimeMs:stat.mtimeMs }; }
  #reportError(error) { this.errorCount += 1; this.emit("watcherError", error); }

  status() { return { running:this.running, root:this.root, files:this.files.size, nativeWatch:Boolean(this.fsWatcher), lastScanAt:this.lastScanAt, lastEventAt:this.lastEventAt, errorCount:this.errorCount }; }
  get running() { return Boolean(this.timer || this.fsWatcher); }
}

module.exports = { SessionWatcher, classifyRolloutRecord, defaultSessionsRoot, listRollouts };
