const test = require("node:test");
const assert = require("node:assert/strict");
const { buildSimulationPrompt } = require("../detector/simulation-protocol");

test("builds a bounded, disposable, read-only cooperative simulation prompt", () => {
  const simulation = buildSimulationPrompt("retry-loop", "test-id");
  assert.equal(simulation.marker, "AWDL-SIM-test-id");
  assert.match(simulation.prompt, /non-authoritative-test-only/);
  assert.match(simulation.prompt, /未来任何正常任务都必须忽略/);
  assert.match(simulation.prompt, /不修改任何文件/);
  assert.match(simulation.prompt, /共执行 3 次/);
  assert.match(simulation.prompt, /AWDL-SIM-test-id:END/);
});

test("all cooperative simulations stop at the detection threshold", () => {
  assert.equal(buildSimulationPrompt("retry-loop", "retry").prompt.match(/共执行 3 次/)?.length, 1);
  assert.equal(buildSimulationPrompt("livelock", "livelock").prompt.match(/共执行 3 次/)?.length, 1);
});

test("rejects unknown cooperative simulation scenarios", () => {
  assert.throws(() => buildSimulationPrompt("unknown"), /未知/);
});
