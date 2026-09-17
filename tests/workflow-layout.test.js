const test = require("node:test");
const assert = require("node:assert/strict");
const { compactWorkflowEvents, createWorkflowLayout } = require("../public/workflow-layout");

test("lays out exactly six workflow states per row", () => {
  const layout = createWorkflowLayout(13);
  assert.equal(layout.rows, 3);
  assert.deepEqual(layout.positions.map((point) => point.row), [0,0,0,0,0,0,1,1,1,1,1,1,2]);
  assert.ok(layout.positions[5].x > layout.positions[0].x);
  assert.ok(layout.positions[6].x > layout.positions[11].x);
});

test("five rows fit without scrolling and the sixth creates vertical history", () => {
  const fiveRows = createWorkflowLayout(30);
  const sixRows = createWorkflowLayout(31);
  assert.equal(fiveRows.rows, 5);
  assert.equal(fiveRows.height, fiveRows.viewportHeight);
  assert.equal(sixRows.rows, 6);
  assert.ok(sixRows.height > sixRows.viewportHeight);
});

test("keeps the first step of unchanged behavior and preserves local numbering gaps", () => {
  const events = [
    { id:101, phase:"STARTED", category:"lifecycle", threadId:"one" },
    { id:102, phase:"REASONING_SUMMARY", category:"reasoning", threadId:"one" },
    { id:103, phase:"REASONING_SUMMARY", category:"reasoning", threadId:"one" },
    { id:104, phase:"REASONING_SUMMARY", category:"reasoning", threadId:"one" },
    { id:105, phase:"TOOL_CALLING", category:"tool", threadId:"one" },
  ];
  const compacted = compactWorkflowEvents(events);
  assert.deepEqual(compacted.map((event) => event.id), [101, 102, 105]);
  assert.deepEqual(compacted.map((event) => event.windowStep), [1, 2, 5]);
});

test("never hides repeated tool actions used as livelock evidence", () => {
  const events = Array.from({ length:3 }, (_, index) => ({ id:index + 1, phase:"TOOL_CALLING", category:"tool", threadId:"one" }));
  assert.equal(compactWorkflowEvents(events).length, 3);
});
