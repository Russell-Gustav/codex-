const test = require("node:test");
const assert = require("node:assert/strict");
const { signalChildTermination } = require("../server");

test("sends SIGTERM to a running Agent process", () => {
  const signals = [];
  const child = { kill(signal) { signals.push(signal); return true; } };
  const accepted = signalChildTermination(child, () => false, 5);
  assert.equal(accepted, true);
  assert.deepEqual(signals, ["SIGTERM"]);
});

test("escalates to SIGKILL when Agent ignores the graceful request", async () => {
  const signals = [];
  const child = { kill(signal) { signals.push(signal); return true; } };
  signalChildTermination(child, () => true, 5);
  await new Promise((resolve) => setTimeout(resolve, 15));
  assert.deepEqual(signals, ["SIGTERM", "SIGKILL"]);
});
