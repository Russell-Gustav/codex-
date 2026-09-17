const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { SessionWatcher, classifyRolloutRecord } = require("../detector/session-watcher");

test("classifies public Codex Desktop workflow records without exposing encrypted reasoning", () => {
  const file = "rollout-2026-01-01T00-00-00-aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa.jsonl";
  const message = classifyRolloutRecord({ timestamp:"2026-01-01T00:00:00Z", type:"event_msg", payload:{ type:"item_completed", thread_id:"thread-1", turn_id:"turn-1", item:{ type:"UserMessage", content:[{ type:"text", text:"检查项目" }] } } }, file);
  const hidden = classifyRolloutRecord({ timestamp:"2026-01-01T00:00:01Z", type:"response_item", payload:{ type:"reasoning", encrypted_content:"secret" } }, file);
  assert.equal(message.category, "input");
  assert.equal(message.detail, "检查项目");
  assert.equal(hidden, null);
});

test("tails additions to existing Codex sessions and discovers new sessions", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-session-watcher-"));
  const existing = path.join(root, "rollout-existing.jsonl");
  fs.writeFileSync(existing, `${JSON.stringify({ timestamp:"2026-01-01T00:00:00Z", type:"event_msg", payload:{ type:"task_started", thread_id:"old", turn_id:"old-turn" } })}\n`);
  const watcher = new SessionWatcher({ root, intervalMs:60_000 });
  const events = [];
  watcher.on("event", (event) => events.push(event));
  watcher.start();
  fs.appendFileSync(existing, `${JSON.stringify({ timestamp:"2026-01-01T00:00:01Z", type:"event_msg", payload:{ type:"task_started", thread_id:"old", turn_id:"new-turn" } })}\n`);
  const fresh = path.join(root, "rollout-new.jsonl");
  fs.writeFileSync(fresh, `${JSON.stringify({ timestamp:"2026-01-01T00:00:02Z", type:"event_msg", payload:{ type:"item_completed", thread_id:"new", turn_id:"turn-2", item:{ type:"AgentMessage", content:[{ type:"text", text:"完成" }] } } })}\n`);
  watcher.scan();
  watcher.stop();
  fs.rmSync(root, { recursive:true, force:true });
  assert.deepEqual(events.map((event) => [event.threadId, event.title]), [["old", "Codex 开始处理新消息"], ["new", "Codex 回复"]]);
});

test("detects later turns in the same conversation and stops idempotently", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-session-turns-"));
  const file = path.join(root, "rollout-conversation.jsonl");
  fs.writeFileSync(file, "");
  const watcher = new SessionWatcher({ root, intervalMs:60_000 });
  const turns = [];
  watcher.on("event", (event) => turns.push(event.turnId));
  watcher.start();
  const first = JSON.stringify({ timestamp:"2026-01-01T00:00:00Z", type:"event_msg", ordinal:1, payload:{ type:"task_started", thread_id:"same-thread", turn_id:"turn-1" } });
  fs.appendFileSync(file, first);
  watcher.scan();
  const second = JSON.stringify({ timestamp:"2026-01-01T00:00:01Z", type:"event_msg", ordinal:2, payload:{ type:"task_started", thread_id:"same-thread", turn_id:"turn-2" } });
  fs.appendFileSync(file, `\n${second}\n`);
  watcher.scan();
  watcher.stop();
  watcher.stop();
  fs.rmSync(root, { recursive:true, force:true });
  assert.deepEqual(turns, ["turn-1", "turn-2"]);
  assert.equal(watcher.running, false);
});

test("propagates the active turn id to records that omit it", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-session-scope-"));
  const file = path.join(root, "rollout-conversation.jsonl");
  fs.writeFileSync(file, "");
  const watcher = new SessionWatcher({ root, intervalMs:60_000 });
  const events = [];
  watcher.on("event", (event) => events.push(event));
  watcher.start();
  fs.appendFileSync(file, [
    { timestamp:"2026-01-01T00:00:00Z", type:"event_msg", payload:{ type:"task_started", thread_id:"thread-1", turn_id:"turn-9" } },
    { timestamp:"2026-01-01T00:00:01Z", type:"response_item", payload:{ type:"message", role:"assistant", content:[{ type:"output_text", text:"处理中" }] } },
    { timestamp:"2026-01-01T00:00:02Z", type:"event_msg", payload:{ type:"task_complete", thread_id:"thread-1", turn_id:"turn-9" } },
  ].map(JSON.stringify).join("\n") + "\n");
  watcher.scan();
  watcher.stop();
  fs.rmSync(root, { recursive:true, force:true });
  assert.deepEqual(events.map((event) => event.turnId), ["turn-9", "turn-9", "turn-9"]);
});

test("recovers an already active turn when listening starts mid-task", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-session-mid-turn-"));
  const file = path.join(root, "rollout-conversation.jsonl");
  fs.writeFileSync(file, `${JSON.stringify({ timestamp:"2026-01-01T00:00:00Z", type:"event_msg", payload:{ type:"task_started", thread_id:"thread-1", turn_id:"turn-active" } })}\n`);
  const watcher = new SessionWatcher({ root, intervalMs:60_000 });
  const events = [];
  watcher.on("event", (event) => events.push(event));
  watcher.start();
  fs.appendFileSync(file, `${JSON.stringify({ timestamp:"2026-01-01T00:00:01Z", type:"response_item", payload:{ type:"message", role:"assistant", content:[{ type:"output_text", text:"继续处理" }] } })}\n`);
  watcher.scan();
  watcher.stop();
  fs.rmSync(root, { recursive:true, force:true });
  assert.equal(events[0].turnId, "turn-active");
});
