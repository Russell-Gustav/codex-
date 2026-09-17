const { startServer, stopServer, getServerUrl } = require("../server");
const { openEdge } = require("./edge");

async function main() {
  await startServer();
  const url = getServerUrl("/?mode=desktop");
  const child = openEdge(url, { appMode:true });

  child.on("error", async (error) => {
    console.error(`桌面窗口启动失败：${error.message}`);
    await stopServer();
    process.exitCode = 1;
  });
  child.on("close", async () => { await stopServer(); });
}

main().catch((error) => {
  console.error(`桌面模式启动失败：${error.message}`);
  process.exitCode = 1;
});
