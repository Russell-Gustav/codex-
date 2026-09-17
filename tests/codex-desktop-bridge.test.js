const test = require("node:test");
const assert = require("node:assert/strict");
const { BRIDGE_SCRIPT } = require("../detector/codex-desktop-bridge");

test("desktop bridge validates the visible title and exposes delivery controls", () => {
  assert.match(BRIDGE_SCRIPT, /expectedTitle/);
  assert.match(BRIDGE_SCRIPT, /ValuePattern/);
  assert.match(BRIDGE_SCRIPT, /SendWait\('\{ENTER\}'\)/);
  assert.match(BRIDGE_SCRIPT, /InvokePattern/);
  assert.match(BRIDGE_SCRIPT, /busy=\$busy/);
});
