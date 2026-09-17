const { startServer, stopServer, getServerUrl } = require("../server");
const { openEdge } = require("./edge");

async function main() {
  await startServer();
  const url = getServerUrl("/");
  const edge = openEdge(url, { detached: true });
  edge.unref();
  console.log(`已在Microsoft Edge中打开：${url}`);

  const shutdown = async () => {
    await stopServer();
    process.exit(0);
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}

main().catch((error) => {
  console.error(`网页模式启动失败：${error.message}`);
  process.exitCode = 1;
});
