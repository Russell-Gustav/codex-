const fs = require("node:fs");
const path = require("node:path");

function existingFile(candidate) {
  if (!candidate) return null;
  try {
    const resolved = path.resolve(candidate);
    return fs.statSync(resolved).isFile() ? fs.realpathSync(resolved) : null;
  } catch { return null; }
}

function existingDirectory(candidate) {
  if (!candidate) return null;
  try {
    const resolved = path.resolve(candidate);
    return fs.statSync(resolved).isDirectory() ? fs.realpathSync(resolved) : null;
  } catch { return null; }
}

function executableNames(platform, env) {
  if (platform !== "win32") return ["codex"];
  const extensions = String(env.PATHEXT || ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean);
  return ["codex.exe", "codex.cmd", "codex.bat", "codex.com", ...extensions.map((ext) => `codex${ext.toLowerCase()}`)];
}

function findOnPath(env, platform) {
  const pathValue = env.PATH || env.Path || env.path || "";
  for (const directory of pathValue.split(path.delimiter).filter(Boolean)) {
    for (const name of executableNames(platform, env)) {
      const found = existingFile(path.join(directory.replace(/^"|"$/g, ""), name));
      if (found) return found;
    }
  }
  return null;
}

function findDesktopCodex(env, platform) {
  if (platform !== "win32" || !env.LOCALAPPDATA) return null;
  const binRoot = path.join(env.LOCALAPPDATA, "OpenAI", "Codex", "bin");
  let entries;
  try { entries = fs.readdirSync(binRoot, { withFileTypes:true }); }
  catch { return null; }
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => existingFile(path.join(binRoot, entry.name, "codex.exe")))
    .filter(Boolean)
    .map((file) => ({ file, modified:fs.statSync(file).mtimeMs }))
    .sort((a, b) => b.modified - a.modified)[0]?.file || null;
}

function locateCodex(options = {}) {
  const env = options.env || process.env;
  const platform = options.platform || process.platform;
  const home = env.USERPROFILE || env.HOME || null;
  const explicitExecutable = env.CODEX_EXECUTABLE || env.CODEX_PATH || null;
  const executableCandidates = [
    explicitExecutable,
    findOnPath(env, platform),
    findDesktopCodex(env, platform),
    env.APPDATA && path.join(env.APPDATA, "npm", platform === "win32" ? "codex.cmd" : "codex"),
    env.LOCALAPPDATA && path.join(env.LOCALAPPDATA, "Microsoft", "WinGet", "Links", platform === "win32" ? "codex.exe" : "codex"),
    home && path.join(home, ".bun", "bin", platform === "win32" ? "codex.exe" : "codex"),
    home && path.join(home, ".local", "bin", "codex"),
  ];
  const executable = executableCandidates.map(existingFile).find(Boolean) || null;
  const homeCandidates = [env.CODEX_HOME, home && path.join(home, ".codex")];
  const codexHome = homeCandidates.map(existingDirectory).find(Boolean)
    || (homeCandidates.find(Boolean) ? path.resolve(homeCandidates.find(Boolean)) : null);
  const sessionsRoot = codexHome ? path.join(codexHome, "sessions") : null;
  return {
    detectedAt:new Date().toISOString(),
    executable,
    executableSource:explicitExecutable && executable === existingFile(explicitExecutable) ? "environment" : executable ? "automatic" : "not-found",
    codexHome,
    sessionsRoot,
    sessionsAvailable:Boolean(existingDirectory(sessionsRoot)),
    platform,
  };
}

function recordCodexLocation(location, target) {
  fs.mkdirSync(path.dirname(target), { recursive:true });
  const temporary = `${target}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(location, null, 2)}\n`, "utf8");
  fs.renameSync(temporary, target);
  return target;
}

module.exports = { locateCodex, recordCodexLocation, findOnPath, findDesktopCodex };
