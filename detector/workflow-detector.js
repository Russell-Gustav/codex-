const fs = require("node:fs");

function validateSpec(spec) {
  if (spec?.language !== "AWDL") throw new Error("不是有效的AWDL规范");
  for (const key of ["states", "terminal", "transitions", "progress", "rules"]) {
    if (!spec[key]) throw new Error(`AWDL缺少字段：${key}`);
  }
  if (!spec.states.includes(spec.initial)) throw new Error("AWDL初始状态不在states中");
  for (const state of spec.terminal) {
    if (!spec.states.includes(state)) throw new Error(`未知终态：${state}`);
  }
  return spec;
}

function loadSpec(filePath) {
  return validateSpec(JSON.parse(fs.readFileSync(filePath, "utf8")));
}

function canonicalize(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[0-9a-f]{8}-[0-9a-f-]{27,}/g, "<uuid>")
    .replace(/run-\d+/g, "run-<n>")
    .replace(/\b\d{2,}\b/g, "<n>")
    .replace(/\s+/g, " ")
    .trim();
}

function actionSignature(event) {
  const item = event.raw?.item || event.raw?.params?.item || {};
  const action = item.command || item.name || item.tool || (event.source === "codex-session" ? `${event.title || ""}|${event.detail || ""}` : event.title || "");
  return canonicalize(action);
}

function isError(event) {
  const item = event.raw?.item || event.raw?.params?.item || {};
  return event.category === "error" || event.phase === "FAILED" || item.type === "error" || Number(item.exit_code) > 0;
}

function isSuccessfulAction(event) {
  const item = event.raw?.item || event.raw?.params?.item || {};
  const completed = item.status === "completed" || event.raw?.method === "item/completed" || (event.source === "codex-session" && event.phase === "OBSERVING");
  const failed = item.status === "failed" || Number(item.exit_code) > 0;
  return event.category === "tool" && event.phase === "OBSERVING" && completed && !failed;
}

function isSameStreamingStep(previous, event) {
  if (!previous || !["RESPONDING", "REASONING_SUMMARY"].includes(event.phase)) return false;
  return previous.phase === event.phase
    && previous.category === event.category
    && (previous.threadId || null) === (event.threadId || null)
    && (previous.turnId || null) === (event.turnId || null);
}

function elapsed(events) {
  if (events.length < 2) return 0;
  return Math.max(0, Date.parse(events.at(-1).timestamp) - Date.parse(events[0].timestamp));
}

class WorkflowDetector {
  constructor(spec) {
    this.spec = validateSpec(spec);
    this.reset();
  }

  reset() {
    this.history = [];
    this.successfulActions = new Set();
    this.lastPhase = null;
    this.lastEventAt = Date.now();
    this.emitted = new Set();
    this.lastAlertIndex = new Map();
    this.terminal = false;
  }

  warning(code, severity, message, evidence, rule) {
    const evidenceIds = evidence.map((event) => event.id).filter(Boolean);
    const fingerprint = `${code}:${evidenceIds.join(",")}`;
    if (this.emitted.has(fingerprint)) return null;
    const previous = this.lastAlertIndex.get(code);
    if (previous != null && this.history.length - previous < this.spec.rules.repeat_window) return null;
    this.emitted.add(fingerprint);
    this.lastAlertIndex.set(code, this.history.length);
    return {
      category: "alert",
      phase: severity === "critical" ? "CRITICAL" : "WARNING",
      title: code,
      detail: message,
      source: "awdl-detector",
      detection: { code, severity, rule, evidence_event_ids: evidenceIds },
    };
  }

  observe(event) {
    this.lastEventAt = Date.now();
    if (["stderr", "raw", "system"].includes(event.category)) return [];
    if (!this.spec.states.includes(event.phase)) return [];
    if (isSameStreamingStep(this.history.at(-1), event)) {
      // One continuous reasoning/response behavior is one formal step. Keep
      // its first record so evidence numbering points to where it began.
      return [];
    }
    const alerts = [];
    const signature = actionSignature(event);
    const successful = isSuccessfulAction(event);
    const progress = event.phase === "COMPLETED" || (successful && signature && !this.successfulActions.has(signature));
    if (successful && signature) this.successfulActions.add(signature);

    const record = { ...event, workflowPhase:event.phase, signature, progress, abstract: `${event.phase}|${event.category}|${signature}` };
    this.history.push(record);
    this.terminal = this.terminal || (event.source === "monitor" && this.spec.terminal.includes(event.phase)) || event.raw?.type === "turn.completed";

    const allowed = this.lastPhase ? this.spec.transitions[this.lastPhase] : null;
    if (event.source !== "codex-session" && this.lastPhase && allowed && !allowed.includes(event.phase)) {
      const alert = this.warning(
        "INVALID_TRANSITION",
        "warning",
        `检测到规范外迁移：${this.lastPhase} → ${event.phase}`,
        this.history.slice(-2),
        "S1"
      );
      if (alert) alerts.push(alert);
    }
    this.lastPhase = event.phase;

    if (!this.terminal) {
      alerts.push(...this.checkBudgets(), ...this.checkErrors(), ...this.checkRetries(), ...this.checkNoProgress(), ...this.checkCycle(), ...this.checkPlanningChurn());
    }
    return alerts.filter(Boolean);
  }

  checkBudgets() {
    const max = this.spec.rules.max_events;
    if (this.history.length <= max) return [];
    const evidence = this.history.slice(-this.spec.rules.no_progress_window);
    if (evidence.some((event) => event.progress) || elapsed(evidence) < (this.spec.rules.no_progress_min_duration_ms ?? 180_000)) return [];
    return [this.warning("EVENT_BUDGET_EXCEEDED", "critical", `事件数已超过预算${max}，并且持续没有可验证进展。`, evidence, "L1")];
  }

  checkErrors() {
    const max = this.spec.rules.max_consecutive_errors;
    const tail = [];
    for (let index = this.history.length - 1; index >= 0 && isError(this.history[index]); index -= 1) tail.unshift(this.history[index]);
    if (tail.length < max) return [];
    return [this.warning("ERROR_STORM", "warning", `连续出现${tail.length}个错误事件，达到阈值${max}。`, tail, "S3")];
  }

  checkRetries() {
    // The repeat window is an action budget, not a raw-event budget. Codex can
    // emit several observations and duplicated message records between two
    // tool calls; counting those records would evict the first retry before
    // the third identical action arrives.
    const actions = this.history
      .filter((event) => event.signature && event.category === "tool" && event.phase === "TOOL_CALLING")
      .slice(-this.spec.rules.repeat_window);
    if (!actions.length) return [];
    const last = actions.at(-1);
    const same = actions.filter((event) => event.signature === last.signature);
    const noProgress = same.slice(1).every((event) => !event.progress);
    const formalDemo = same.every((event) => event.source === "awdl-demo");
    if (same.length < this.spec.rules.max_same_action || !noProgress || (!formalDemo && elapsed(same) < (this.spec.rules.repeat_min_duration_ms ?? 60_000))) return [];
    return [this.warning("RETRY_STORM", "warning", `同一动作在最近${actions.length}次工具调用中出现${same.length}次，且重复执行未产生新进展。`, same, "S2")];
  }

  checkNoProgress() {
    const size = this.spec.rules.no_progress_window;
    const window = this.history.slice(-size);
    if (window.length < size || window.some((event) => event.progress)) return [];
    const duration = Date.parse(window.at(-1).timestamp) - Date.parse(window[0].timestamp);
    const minDuration = this.spec.rules.no_progress_min_duration_ms ?? 180_000;
    const actions = window.filter((event) => event.category === "tool" && event.signature);
    const repeatedAction = actions.length >= this.spec.rules.max_same_action
      && new Set(actions.map((event) => event.signature)).size === 1;
    if (duration < minDuration || !repeatedAction) return [];
    return [this.warning("NO_PROGRESS", "warning", `同一动作持续重复超过${Math.round(minDuration / 1000)}秒，且没有观察到新的成功结果。`, window, "L2")];
  }

  checkCycle() {
    const { cycle_min_period: min, cycle_max_period: max, cycle_repetitions: reps } = this.spec.rules;
    for (let period = min; period <= max; period += 1) {
      const required = period * reps;
      const tail = this.history.slice(-required);
      if (tail.length < required || tail.some((event) => event.progress)) continue;
      if (tail.every((event) => event.category === "error")) continue;
      if (!tail.every((event) => event.source === "awdl-demo") && elapsed(tail) < (this.spec.rules.cycle_min_duration_ms ?? 60_000)) continue;
      const base = tail.slice(0, period).map((event) => event.abstract);
      let repeated = true;
      for (let offset = period; offset < tail.length; offset += period) {
        if (tail.slice(offset, offset + period).some((event, index) => event.abstract !== base[index])) repeated = false;
      }
      if (repeated) {
        return [this.warning("PERIODIC_LIVELOCK", "critical", `发现长度为${period}的抽象状态周期，已连续重复${reps}次且无进展。`, tail, "L3")];
      }
    }
    return [];
  }

  checkPlanningChurn() {
    const size = this.spec.rules.planning_churn_window;
    const threshold = this.spec.rules.planning_churn_messages;
    const window = this.history.slice(-size);
    if (window.length < size || window.some((event) => event.category === "tool" || event.progress)) return [];
    const messages = window.filter((event) => event.phase === "RESPONDING" || event.phase === "REASONING_SUMMARY");
    const duration = elapsed(window);
    const signatures = new Set(messages.map((event) => event.signature).filter(Boolean));
    if (messages.length < threshold || duration < (this.spec.rules.planning_churn_min_duration_ms ?? 180_000) || signatures.size > 1) return [];
    return [this.warning("PLANNING_CHURN", "warning", `最近${size}个事件中有${messages.length}个规划/说明事件，但没有工具执行或有效进展。`, window, "L4")];
  }

  checkClock(now = Date.now()) {
    if (this.terminal || !this.history.length) return [];
    const timeout = this.spec.rules.silent_timeout_ms;
    if (now - this.lastEventAt < timeout) return [];
    const alert = this.warning("SILENT_STALL", "warning", `任务已超过${Math.round(timeout / 1000)}秒没有产生新事件，可能正在等待、死锁或外部调用挂起。`, this.history.slice(-1), "L5");
    return alert ? [alert] : [];
  }
}

module.exports = { WorkflowDetector, loadSpec, validateSpec, canonicalize, actionSignature };
