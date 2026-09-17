const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { locateCodex, recordCodexLocation } = require("../detector/codex-locator");

test("finds Codex executable on PATH and derives the user data directory", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-locator-"));
  const bin = path.join(root, "bin");
  const home = path.join(root, "user");
  fs.mkdirSync(bin, { recursive:true });
  fs.mkdirSync(path.join(home, ".codex", "sessions"), { recursive:true });
  const executable = path.join(bin, process.platform === "win32" ? "codex.exe" : "codex");
  fs.writeFileSync(executable, "test");
  const location = locateCodex({ env:{ PATH:bin, USERPROFILE:home, HOME:home }, platform:process.platform });
  assert.equal(location.executable, fs.realpathSync(executable));
  assert.equal(location.codexHome, fs.realpathSync(path.join(home, ".codex")));
  assert.equal(location.sessionsAvailable, true);
  fs.rmSync(root, { recursive:true, force:true });
});

test("honors explicit locations and writes a reusable discovery record", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-location-record-"));
  const executable = path.join(root, process.platform === "win32" ? "custom-codex.exe" : "custom-codex");
  const codexHome = path.join(root, "custom-home");
  fs.writeFileSync(executable, "test");
  fs.mkdirSync(codexHome);
  const location = locateCodex({ env:{ CODEX_EXECUTABLE:executable, CODEX_HOME:codexHome, PATH:"" }, platform:process.platform });
  const target = path.join(root, "runtime", "codex-location.json");
  recordCodexLocation(location, target);
  assert.equal(location.executableSource, "environment");
  assert.equal(JSON.parse(fs.readFileSync(target, "utf8")).codexHome, fs.realpathSync(codexHome));
  fs.rmSync(root, { recursive:true, force:true });
});

test("finds the versioned executable bundled with Codex Desktop", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-desktop-locator-"));
  const executable = path.join(root, "OpenAI", "Codex", "bin", "version-1", "codex.exe");
  fs.mkdirSync(path.dirname(executable), { recursive:true });
  fs.writeFileSync(executable, "test");
  const location = locateCodex({ env:{ LOCALAPPDATA:root, PATH:"" }, platform:"win32" });
  assert.equal(location.executable, fs.realpathSync(executable));
  fs.rmSync(root, { recursive:true, force:true });
});
