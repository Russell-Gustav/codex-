const { startServer, stopServer, getServerUrl, registerLauncherProcess } = require("./server");
const { openEdge } = require("./launchers/edge");
const http = require("node:http");
const net = require("node:net");

function requestExisting(pathname, method = "GET") {
  return new Promise((resolve, reject) => {
    const request = http.request({ host:"127.0.0.1", port:4317, path:pathname, method, timeout:1500 }, (response) => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => { body += chunk; });
      response.on("end", () => {
        try { resolve({ status:response.statusCode, body:JSON.parse(body) }); }
        catch { reject(new Error("4317端口不是Codex监视器")); }
      });
    });
    request.on("timeout", () => request.destroy(new Error("连接现有监视器超时")));
    request.on("error", reject);
    request.end();
  });
}

function portIsAvailable() {
  return new Promise((resolve) => {
    const probe = net.createServer();
    probe.unref();
    probe.once("error", () => resolve(false));
    probe.listen(4317, "127.0.0.1", () => probe.close(() => resolve(true)));
  });
}

async function waitForPortRelease() {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    if (await portIsAvailable()) return;
  }
  throw new Error("旧监视器未能在5秒内释放4317端口");
}

async function main() {
  try {
    const existing = await requestExisting("/api/status");
    if (existing.body?.workflow !== "codex-general-task") throw new Error("4317端口已被其他程序占用");
    // Never reuse an already-running monitor. It may have the same package
    // version while still containing older code from a previous build.
    await requestExisting("/api/shutdown", "POST");
    await waitForPortRelease();
  } catch (error) {
    if (/其他程序占用|不是Codex监视器/.test(error.message)) throw error;
    if (!(await portIsAvailable())) throw new Error(`4317端口已被其他程序占用：${error.message}`);
  }
  await startServer();
  const url = getServerUrl("/launcher.html");
  const launcherProfile = require("node:path").join(process.env.LOCALAPPDATA || __dirname, "CodexThoughtMonitor", "runtime", `edge-launcher-${process.pid}`);
  const launcher = openEdge(url, { appMode:true, profileDir:launcherProfile });
  registerLauncherProcess(launcher);
  console.log(`Codex Monitor Launcher: ${url}`);

  launcher.on("error", async (error) => {
    console.error(`启动中心打开失败：${error.message}`);
    await stopServer();
    process.exitCode = 1;
  });
  // The launcher window is only a mode selector. The server must keep running
  // after it closes because the selected Web/Desktop monitor may still be open.
}

main().catch((error) => {
  console.error(`Codex Monitor启动失败：${error.message}`);
  process.exitCode = 1;
});
