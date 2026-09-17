const test = require("node:test");
const assert = require("node:assert/strict");
const { FORMAL_DEMO_THREAD_ID, buildFormalDemoTrace } = require("../detector/formal-demo");

for (const scenario of ["livelock", "retry-loop"]) {
  test(`${scenario} demo spans multiple six-state rows on one timeline`, () => {
    const events = buildFormalDemoTrace(scenario);
    assert.equal(events.length, 14);
    assert.equal(Math.ceil((events.length + 1) / 6), 3); // includes the final STOPPED state
    assert.ok(events.every((event) => event.runId === "formal-demo"));
    assert.ok(events.every((event) => event.threadId === FORMAL_DEMO_THREAD_ID));
  });
}
