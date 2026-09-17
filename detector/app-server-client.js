const { EventEmitter } = require("node:events");
const { spawn } = require("node:child_process");
const readline = require("node:readline");
const APP_VERSION = require("../package.json").version;

function normalizedCodexEnv(env = process.env) {
  const normalized = { ...env };
  if (process.platform === "win32") {
    const userHome = normalized.USERPROFILE
      || (normalized.HOMEDRIVE && normalized.HOMEPATH ? `${normalized.HOMEDRIVE}${normalized.HOMEPATH}` : null);
    if (!normalized.HOME && userHome) normalized.HOME = userHome;
    if (!normalized.USERPROFILE && normalized.HOME) normalized.USERPROFILE = normalized.HOME;
    if (!normalized.CODEX_HOME && userHome) normalized.CODEX_HOME = require("node:path").join(userHome, ".codex");
  }
  return normalized;
}

class AppServerClient extends EventEmitter {
  constructor(options = {}) {
    super();
    this.executable = options.executable || (process.platform === "win32" ? "codex.exe" : "codex");
    this.args = options.args || ["app-server", "--listen", "stdio://"];
    this.env = normalizedCodexEnv(options.env || process.env);
    this.requestTimeoutMs = options.requestTimeoutMs || 30_000;
    this.nextId = 1;
    this.pending = new Map();
    this.child = null;
    this.ready = false;
    this.closing = false;
    this.diagnostics = [];
  }

  async start() {
    if (this.ready) return;
    if (this.child) throw new Error("Codex app-server 正在启动");
    this.closing = false;
    const child = spawn(this.executable, this.args, {
      env: this.env,
      windowsHide: true,
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child = child;
    const stdout = readline.createInterface({ input: child.stdout });
    const stderr = readline.createInterface({ input: child.stderr });
    stdout.on("line", (line) => this.#handleLine(line));
    stderr.on("line", (line) => {
      this.diagnostics.push(line);
      if (this.diagnostics.length > 8) this.diagnostics.shift();
      this.emit("diagnostic", line);
    });
    child.on("error", (error) => this.#fail(error));
    child.on("close", (code, signal) => {
      const diagnostic = this.diagnostics.slice(-3).join("\n");
      const error = this.closing ? null : new Error(`Codex app-server 已退出（code=${code ?? "null"}${signal ? `, signal=${signal}` : ""}）${diagnostic ? `\n${diagnostic}` : ""}`);
      this.ready = false;
      this.child = null;
      for (const { reject, timer } of this.pending.values()) {
        clearTimeout(timer);
        reject(error || new Error("Codex app-server 已关闭"));
      }
      this.pending.clear();
      this.emit("close", { code, signal, error });
    });

    await new Promise((resolve, reject) => {
      const onSpawn = () => { cleanup(); resolve(); };
      const onError = (error) => { cleanup(); reject(error); };
      const cleanup = () => { child.off("spawn", onSpawn); child.off("error", onError); };
      child.once("spawn", onSpawn);
      child.once("error", onError);
    });
    await this.request("initialize", {
      clientInfo: { name: "codex-workflow-controller", title: "Codex 4.0 工作流控制台", version:APP_VERSION },
      capabilities: { experimentalApi: true, requestAttestation: false },
    });
    this.notify("initialized");
    this.ready = true;
    this.emit("ready");
  }

  request(method, params = undefined) {
    if (!this.child?.stdin?.writable) return Promise.reject(new Error("Codex app-server 未连接"));
    const id = this.nextId++;
    const message = { method, id };
    if (params !== undefined) message.params = params;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Codex RPC 超时：${method}`));
      }, this.requestTimeoutMs);
      timer.unref?.();
      this.pending.set(id, { resolve, reject, timer, method });
      this.#write(message);
    });
  }

  notify(method, params = undefined) {
    const message = { method };
    if (params !== undefined) message.params = params;
    this.#write(message);
  }

  respond(id, result) { this.#write({ id, result }); }
  respondError(id, code, message) { this.#write({ id, error: { code, message } }); }

  async close(graceMs = 3000) {
    const child = this.child;
    if (!child) return;
    this.closing = true;
    const closed = new Promise((resolve) => child.once("close", resolve));
    child.stdin.end();
    const timer = setTimeout(() => child.kill("SIGTERM"), graceMs);
    timer.unref?.();
    await closed;
    clearTimeout(timer);
  }

  #write(message) {
    if (!this.child?.stdin?.writable) throw new Error("Codex app-server 连接已关闭");
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  #handleLine(line) {
    if (!line.trim()) return;
    let message;
    try { message = JSON.parse(line); }
    catch { this.emit("diagnostic", `非 JSON RPC 输出：${line}`); return; }
    if (Object.prototype.hasOwnProperty.call(message, "id") && !message.method) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error) {
        const error = new Error(message.error.message || `Codex RPC 失败：${pending.method}`);
        error.code = message.error.code;
        error.data = message.error.data;
        error.method = pending.method;
        pending.reject(error);
      }
      else pending.resolve(message.result);
      return;
    }
    if (message.method && Object.prototype.hasOwnProperty.call(message, "id")) {
      this.emit("request", message);
      return;
    }
    if (message.method) this.emit("notification", message);
  }

  #fail(error) {
    this.emit("diagnostic", error.message);
  }
}

module.exports = { AppServerClient, normalizedCodexEnv };
