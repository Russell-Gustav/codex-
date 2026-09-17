const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const root = path.resolve(__dirname, "..");
const buildDir = path.join(root, "build");
const exePath = path.join(root, "CodexMonitor.exe");

function setWindowsGuiSubsystem(file) {
  const executable = fs.readFileSync(file);
  const peOffset = executable.readUInt32LE(0x3c);
  if (executable.toString("ascii", peOffset, peOffset + 4) !== "PE\0\0") throw new Error("生成的EXE不是有效PE文件");
  const optionalHeader = peOffset + 24;
  const magic = executable.readUInt16LE(optionalHeader);
  if (magic !== 0x10b && magic !== 0x20b) throw new Error("无法识别EXE可选头");
  executable.writeUInt16LE(2, optionalHeader + 68);
  fs.writeFileSync(file, executable);
}

function run(command, args) {
  const result = spawnSync(command, args, { cwd: root, stdio: "inherit", shell: false });
  if (result.status !== 0) throw new Error(`${path.basename(command)}执行失败，退出码${result.status}`);
}

fs.rmSync(buildDir, { recursive: true, force: true });
fs.rmSync(exePath, { force: true });
fs.mkdirSync(buildDir, { recursive: true });

const esbuild = path.join(root, "node_modules", "esbuild", "bin", "esbuild");
run(process.execPath, [esbuild, "standalone.js", "--bundle", "--platform=node", "--format=cjs", `--outfile=${path.join(buildDir, "standalone.bundle.cjs")}`]);

const seaConfig = {
  main: path.join(buildDir, "standalone.bundle.cjs"),
  output: path.join(buildDir, "sea-prep.blob"),
  disableExperimentalSEAWarning: true,
  useSnapshot: false,
  useCodeCache: false
};
fs.writeFileSync(path.join(buildDir, "sea-config.json"), JSON.stringify(seaConfig, null, 2));
run(process.execPath, ["--experimental-sea-config", path.join(buildDir, "sea-config.json")]);

fs.copyFileSync(process.execPath, exePath);
const postject = path.join(root, "node_modules", "postject", "dist", "cli.js");
run(process.execPath, [postject, exePath, "NODE_SEA_BLOB", path.join(buildDir, "sea-prep.blob"), "--sentinel-fuse", "NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2"]);
setWindowsGuiSubsystem(exePath);

// SEA files are reproducible build intermediates and must not linger in the
// source tree where they can be mistaken for current release artifacts.
fs.rmSync(buildDir, { recursive:true, force:true });
console.log(`可执行文件已生成：${exePath}`);
