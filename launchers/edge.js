const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");

function findEdge() {
  const candidates = [
    process.env["ProgramFiles(x86)"] && path.join(process.env["ProgramFiles(x86)"], "Microsoft", "Edge", "Application", "msedge.exe"),
    process.env.ProgramFiles && path.join(process.env.ProgramFiles, "Microsoft", "Edge", "Application", "msedge.exe"),
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, "Microsoft", "Edge", "Application", "msedge.exe"),
    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  ].filter(Boolean);
  return candidates.find((candidate) => fs.existsSync(candidate));
}

function openEdge(url, options = {}) {
  const edge = findEdge();
  if (!edge) throw new Error("未找到Microsoft Edge");
  const args = options.appMode ? [`--app=${url}`, "--new-window"] : ["--new-window", url];
  if (options.profileDir) {
    fs.mkdirSync(options.profileDir, { recursive: true });
    args.push(`--user-data-dir=${options.profileDir}`, "--no-first-run", "--disable-background-mode");
  }
  return spawn(edge, args, {
    windowsHide: false,
    stdio: "ignore",
    detached: Boolean(options.detached),
  });
}

module.exports = { findEdge, openEdge };
