const fs = require("node:fs");
const path = require("node:path");
const { WorkflowDetector, loadSpec } = require("../detector/workflow-detector");

const input = process.argv[2];
const simulationMode = process.argv.includes("--simulation");
if (!input) {
  console.error("用法: node tools/analyze-log.js <%LOCALAPPDATA%\\CodexThoughtMonitor\\logs\\run-xxx.jsonl>");
  process.exit(2);
}

const inputPath = path.resolve(input);
const specPath = path.join(__dirname, "..", "formal", "default-workflow.awdl.json");
const baseSpec = loadSpec(specPath);
const detector = new WorkflowDetector(simulationMode ? {
  ...baseSpec,
  rules: {
    ...baseSpec.rules,
    repeat_min_duration_ms:0,
    no_progress_min_duration_ms:0,
    planning_churn_min_duration_ms:0,
  },
} : baseSpec);
const alerts = [];
let eventCount = 0;

for (const [index, line] of fs.readFileSync(inputPath, "utf8").split(/\r?\n/).entries()) {
  if (!line.trim()) continue;
  try {
    const event = JSON.parse(line);
    eventCount += 1;
    alerts.push(...detector.observe(event));
  } catch (error) {
    console.error(`第${index + 1}行无法解析：${error.message}`);
  }
}

const result = {
  file: inputPath,
  events: eventCount,
  workflowEvents: detector.history.length,
  alerts: alerts.map((alert) => ({
    code: alert.detection.code,
    severity: alert.detection.severity,
    rule: alert.detection.rule,
    evidence_event_ids: alert.detection.evidence_event_ids,
    message: alert.detail,
  })),
};

console.log(JSON.stringify(result, null, 2));
