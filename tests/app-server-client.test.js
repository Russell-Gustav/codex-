const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { AppServerClient, normalizedCodexEnv } = require("../detector/app-server-client");

test("normalizes the Windows home environment expected by Codex", () => {
  const env = normalizedCodexEnv({ USERPROFILE:"C:\\Users\\tester" });
  if (process.platform === "win32") {
    assert.equal(env.HOME, "C:\\Users\\tester");
    assert.equal(env.CODEX_HOME, "C:\\Users\\tester\\.codex");
  }
  else assert.equal(env.HOME, undefined);
});

test("uses Codex app-server JSON-RPC for persistent turns and interruption", async () => {
  const client = new AppServerClient({ executable:process.execPath, args:[path.join(__dirname, "fixtures", "fake-app-server.js")] });
  const methods = [];
  let completedResolve;
  const completed = new Promise((resolve) => { completedResolve = resolve; });
  client.on("notification", (message) => { methods.push(message.method); if (message.method === "turn/completed") completedResolve(); });
  await client.start();
  const thread = await client.request("thread/start", { cwd:__dirname, sandbox:"read-only", approvalPolicy:"never" });
  const turn = await client.request("turn/start", { threadId:thread.thread.id, input:[{ type:"text", text:"hello", text_elements:[] }] });
  await client.request("turn/interrupt", { threadId:thread.thread.id, turnId:turn.turn.id });
  await completed;
  assert.equal(thread.thread.id, "thread-test");
  assert.equal(turn.turn.id, "turn-test");
  assert.deepEqual(methods, ["thread/started", "turn/started", "turn/completed"]);
  await client.close();
});
