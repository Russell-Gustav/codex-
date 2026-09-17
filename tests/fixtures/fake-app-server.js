const readline = require("node:readline");
const input = readline.createInterface({ input:process.stdin });
let threadId = "thread-test";
function send(message) { process.stdout.write(`${JSON.stringify(message)}\n`); }
input.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") send({ id:message.id, result:{ userAgent:"fake" } });
  if (message.method === "thread/start") {
    send({ method:"thread/started", params:{ thread:{ id:threadId } } });
    send({ id:message.id, result:{ thread:{ id:threadId }, model:"test", modelProvider:"test", cwd:message.params.cwd } });
  }
  if (message.method === "turn/start") {
    send({ id:message.id, result:{ turn:{ id:"turn-test", status:"inProgress", items:[] } } });
    send({ method:"turn/started", params:{ threadId, turn:{ id:"turn-test", status:"inProgress" } } });
  }
  if (message.method === "turn/interrupt") {
    send({ id:message.id, result:{} });
    send({ method:"turn/completed", params:{ threadId, turn:{ id:"turn-test", status:"interrupted" } } });
  }
});
input.on("close", () => process.exit(0));
