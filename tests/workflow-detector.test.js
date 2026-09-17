const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { WorkflowDetector, loadSpec } = require("../detector/workflow-detector");

const specPath = path.join(__dirname, "..", "formal", "default-workflow.awdl.json");
let id = 0;

function event(phase, category, extra = {}) {
  return { id: ++id, timestamp: new Date().toISOString(), phase, category, title: phase, source: "test", ...extra };
}

function command(phase, commandText, status, exitCode) {
  return event(phase, "tool", { raw: { type: phase === "TOOL_CALLING" ? "item.started" : "item.completed", item: { type: "command_execution", command: commandText, status, exit_code: exitCode } } });
}

test("normal workflow completes without livelock alert", () => {
  const detector = new WorkflowDetector(loadSpec(specPath));
  const alerts = [
    ...detector.observe(event("STARTING", "lifecycle")),
    ...detector.observe(event("STARTED", "lifecycle")),
    ...detector.observe(command("TOOL_CALLING", "check files", "in_progress", null)),
    ...detector.observe(command("OBSERVING", "check files", "completed", 0)),
    ...detector.observe(command("TOOL_CALLING", "analyze data", "in_progress", null)),
    ...detector.observe(command("OBSERVING", "analyze data", "completed", 0)),
    ...detector.observe(event("COMPLETED", "lifecycle")),
  ];
  assert.equal(alerts.some((alert) => alert.title === "PERIODIC_LIVELOCK"), false);
});

test("treats passive tool observations as real progress", () => {
  const detector = new WorkflowDetector(loadSpec(specPath));
  const alerts = [];
  alerts.push(...detector.observe(event("STARTED", "lifecycle", { source:"codex-session" })));
  alerts.push(...detector.observe(event("RESPONDING", "input", { source:"codex-session" })));
  alerts.push(...detector.observe(event("RESPONDING", "message", { source:"codex-session" })));
  alerts.push(...detector.observe(event("TOOL_CALLING", "tool", { source:"codex-session", detail:"read project" })));
  alerts.push(...detector.observe(event("OBSERVING", "tool", { source:"codex-session", detail:"result page 1" })));
  alerts.push(...detector.observe(event("OBSERVING", "tool", { source:"codex-session", detail:"result page 2" })));
  alerts.push(...detector.observe(event("REASONING_SUMMARY", "reasoning", { source:"codex-session", detail:"analyze" })));
  alerts.push(...detector.observe(event("RESPONDING", "message", { source:"codex-session", detail:"answer" })));
  alerts.push(...detector.observe(event("COMPLETED", "lifecycle", { source:"codex-session" })));
  assert.equal(alerts.some((alert) => alert.title === "NO_PROGRESS"), false);
  assert.ok(detector.history.filter((item) => item.progress).length >= 3);
});

test("does not call a long but varied reasoning process planning churn", () => {
  const detector = new WorkflowDetector(loadSpec(specPath));
  const start = Date.now();
  const alerts = [];
  for (let index = 0; index < 8; index += 1) {
    alerts.push(...detector.observe(event("REASONING_SUMMARY", "reasoning", { timestamp:new Date(start + index * 60_000).toISOString(), detail:`distinct stage ${index}` })));
  }
  assert.equal(alerts.some((alert) => ["NO_PROGRESS", "PLANNING_CHURN"].includes(alert.title)), false);
});

test("detects a two-state periodic livelock", () => {
  const detector = new WorkflowDetector(loadSpec(specPath));
  const start = Date.now();
  detector.observe(event("STARTING", "lifecycle", { timestamp:new Date(start).toISOString() }));
  detector.observe(event("STARTED", "lifecycle", { timestamp:new Date(start + 1000).toISOString() }));
  const alerts = [];
  for (let repeat = 0; repeat < 2; repeat += 1) {
    const call = command("TOOL_CALLING", "retry same tool", "in_progress", null);
    call.timestamp = new Date(start + 2000 + repeat * 40_000).toISOString();
    alerts.push(...detector.observe(call));
    alerts.push(...detector.observe(event("RESPONDING", "message", { detail:"重新规划", timestamp:new Date(start + 22_000 + repeat * 40_000).toISOString() })));
  }
  assert.equal(alerts.some((alert) => alert.title === "PERIODIC_LIVELOCK"), true);
});

test("coalesces consecutive streaming responses into one workflow step", () => {
  const detector = new WorkflowDetector(loadSpec(specPath));
  detector.observe(event("STARTING", "lifecycle"));
  detector.observe(event("STARTED", "lifecycle"));
  const alerts = [];
  for (let chunk = 0; chunk < 12; chunk += 1) {
    alerts.push(...detector.observe(event("RESPONDING", "message", { threadId:"thread-1", turnId:"turn-1", detail:`partial ${chunk}` })));
  }
  assert.equal(detector.history.filter((item) => item.phase === "RESPONDING").length, 1);
  assert.equal(detector.history.find((item) => item.phase === "RESPONDING").detail, "partial 0");
  assert.equal(alerts.some((alert) => ["PERIODIC_LIVELOCK", "PLANNING_CHURN", "NO_PROGRESS"].includes(alert.title)), false);
});

test("does not report incomplete passive-session transitions as invalid", () => {
  const detector = new WorkflowDetector(loadSpec(specPath));
  detector.observe(event("REASONING_SUMMARY", "reasoning", { source:"codex-session" }));
  const alerts = detector.observe(event("OBSERVING", "tool", { source:"codex-session" }));
  assert.equal(alerts.some((alert) => alert.title === "INVALID_TRANSITION"), false);
});

test("detects silent stall after timeout", () => {
  const detector = new WorkflowDetector(loadSpec(specPath));
  detector.observe(event("STARTING", "lifecycle"));
  const alerts = detector.checkClock(detector.lastEventAt + detector.spec.rules.silent_timeout_ms + 1);
  assert.equal(alerts[0].title, "SILENT_STALL");
});

test("finite retry followed by success is not a retry storm", () => {
  const detector = new WorkflowDetector(loadSpec(specPath));
  detector.observe(event("STARTING", "lifecycle"));
  detector.observe(event("STARTED", "lifecycle"));
  const alerts = [];
  for (let attempt = 0; attempt < 2; attempt += 1) {
    alerts.push(...detector.observe(command("TOOL_CALLING", "fetch remote data", "in_progress", null)));
    alerts.push(...detector.observe(event("RUNNING", "error", { detail: "temporary timeout" })));
  }
  alerts.push(...detector.observe(command("OBSERVING", "fetch remote data", "completed", 0)));
  alerts.push(...detector.observe(event("COMPLETED", "lifecycle")));
  assert.equal(alerts.some((alert) => alert.title === "RETRY_STORM"), false);
});

test("detects an exact repeated-action dead loop with evidence", () => {
  const detector = new WorkflowDetector(loadSpec(specPath));
  detector.observe(event("STARTING", "lifecycle"));
  detector.observe(event("STARTED", "lifecycle"));
  const alerts = [];
  const start = Date.now();
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const item = command("TOOL_CALLING", "retry-identical-action", "in_progress", null);
    item.timestamp = new Date(start + attempt * 31_000).toISOString();
    alerts.push(...detector.observe(item));
  }
  const retry = alerts.find((alert) => alert.title === "RETRY_STORM");
  assert.ok(retry);
  assert.equal(retry.detection.rule, "S2");
  assert.equal(retry.detection.evidence_event_ids.length, 3);
});

test("honors a zero repeat-duration threshold for cooperative simulations", () => {
  const base = loadSpec(specPath);
  const detector = new WorkflowDetector({
    ...base,
    rules: { ...base.rules, repeat_min_duration_ms:0, no_progress_min_duration_ms:0 },
  });
  const alerts = [];
  const startedAt = Date.now();
  for (let attempt = 0; attempt < 3; attempt += 1) {
    alerts.push(...detector.observe(event("TOOL_CALLING", "tool", {
      source:"codex-session",
      detail:"AWDL-SIM-TEST:NO_PROGRESS repeated probe",
      timestamp:new Date(startedAt + attempt * 5_000).toISOString(),
    })));
    alerts.push(...detector.observe(event("OBSERVING", "tool", {
      source:"codex-session",
      detail:"successful command result",
      timestamp:new Date(startedAt + attempt * 5_000 + 1_000).toISOString(),
    })));
  }
  assert.ok(alerts.some((alert) => alert.title === "RETRY_STORM"));
});

test("counts the retry window by tool calls despite noisy session records", () => {
  const base = loadSpec(specPath);
  const detector = new WorkflowDetector({
    ...base,
    rules: { ...base.rules, repeat_min_duration_ms:0 },
  });
  const alerts = [];
  const startedAt = Date.now();
  for (let attempt = 0; attempt < 3; attempt += 1) {
    alerts.push(...detector.observe(event("TOOL_CALLING", "tool", {
      source:"codex-session",
      detail:"same simulated command",
      timestamp:new Date(startedAt + attempt * 8_000).toISOString(),
    })));
    for (let noise = 0; noise < 4; noise += 1) {
      alerts.push(...detector.observe(event(noise < 2 ? "OBSERVING" : "RESPONDING", noise < 2 ? "tool" : "message", {
        source:"codex-session",
        detail:`session noise ${noise}`,
        timestamp:new Date(startedAt + attempt * 8_000 + noise + 1).toISOString(),
      })));
    }
  }
  const retry = alerts.find((alert) => alert.title === "RETRY_STORM");
  assert.ok(retry);
  assert.equal(retry.detection.evidence_event_ids.length, 3);
});
