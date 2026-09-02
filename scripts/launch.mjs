/**
 * Launcher: the one thing the pharmacy computer runs.
 *  - creates .env with fresh keys on first run
 *  - applies database migrations
 *  - builds the app when needed
 *  - starts the server and opens the browser
 *  - when the app asks for an update (exit code 75), pulls the latest version, rebuilds, restarts
 *
 * Start it with "Start Pharmacy Admin.cmd" (Windows) or `npm run launch`.
 */
import { spawn, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
process.chdir(root);
const PORT = process.env.PORT || "3000";
const isWin = process.platform === "win32";
const npmCmd = isWin ? "npm.cmd" : "npm";
const UPDATE_EXIT_CODE = 75;
const flagFile = path.join(root, "data", ".update-requested");

function log(msg) {
  console.log(`[pharmacy-admin] ${msg}`);
}

function run(cmd, args, opts = {}) {
  log(`${cmd} ${args.join(" ")}`);
  const r = spawnSync(cmd, args, { stdio: "inherit", shell: isWin, ...opts });
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(" ")} failed (exit ${r.status})`);
}

function ensureEnv() {
  const envPath = path.join(root, ".env");
  if (fs.existsSync(envPath)) {
    const txt = fs.readFileSync(envPath, "utf8");
    if (!/EXAMPLE_REPLACE_ME/.test(txt)) return;
  }
  const key = () => crypto.randomBytes(32).toString("base64");
  const content = [
    "DATABASE_PATH=./data/pharmacy-admin.db",
    "FILES_DIR=./data/files",
    `APP_ENCRYPTION_KEY=${key()}`,
    `SESSION_SECRET=${key()}`,
    "",
  ].join("\n");
  fs.writeFileSync(envPath, content, { mode: 0o600 });
  log("Created .env with fresh keys. Back up the APP_ENCRYPTION_KEY line (Settings → Backup shows how).");
}

function needsBuild() {
  const buildId = path.join(root, ".next", "BUILD_ID");
  if (!fs.existsSync(buildId)) return true;
  const stamp = path.join(root, ".next", "source-stamp");
  const current = sourceStamp();
  if (!fs.existsSync(stamp) || fs.readFileSync(stamp, "utf8") !== current) return true;
  return false;
}

function sourceStamp() {
  const r = spawnSync("git", ["rev-parse", "HEAD"], { encoding: "utf8", shell: isWin });
  const head = (r.stdout || "").trim() || "unknown";
  const lock = fs.existsSync("package-lock.json") ? fs.statSync("package-lock.json").mtimeMs : 0;
  return `${head}:${lock}`;
}

function build() {
  run(npmCmd, ["install", "--no-audit", "--no-fund"]);
  run(npmCmd, ["run", "build"]);
  fs.writeFileSync(path.join(root, ".next", "source-stamp"), sourceStamp());
}

function update() {
  log("Installing update…");
  const branch = spawnSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { encoding: "utf8", shell: isWin }).stdout.trim();
  run("git", ["fetch", "origin", "main"]);
  if (branch !== "main") run("git", ["checkout", "main"]);
  run("git", ["pull", "--ff-only", "origin", "main"]);
  build();
  log("Update installed.");
}

function waitForServer(tries = 120) {
  return new Promise((resolve) => {
    const attempt = (n) => {
      const req = http.get({ host: "127.0.0.1", port: PORT, path: "/login", timeout: 1000 }, (res) => {
        res.resume();
        resolve(true);
      });
      req.on("error", () => (n > 0 ? setTimeout(() => attempt(n - 1), 500) : resolve(false)));
      req.on("timeout", () => req.destroy());
    };
    attempt(tries);
  });
}

function openBrowser() {
  const url = `http://localhost:${PORT}`;
  try {
    if (isWin) spawn("cmd", ["/c", "start", "", url], { detached: true, stdio: "ignore" }).unref();
    else if (process.platform === "darwin") spawn("open", [url], { detached: true, stdio: "ignore" }).unref();
    else spawn("xdg-open", [url], { detached: true, stdio: "ignore" }).unref();
  } catch {
    log(`Open ${url} in your browser.`);
  }
}

async function main() {
  fs.mkdirSync(path.join(root, "data"), { recursive: true });
  ensureEnv();
  if (!fs.existsSync(path.join(root, "node_modules")) || needsBuild()) build();
  let first = true;
  for (;;) {
    if (fs.existsSync(flagFile)) fs.rmSync(flagFile);
    run(npmCmd, ["run", "db:migrate"]);
    log(`Starting on http://localhost:${PORT}`);
    const child = spawn(process.execPath, [path.join(root, "node_modules", "next", "dist", "bin", "next"), "start", "-p", PORT], {
      stdio: "inherit",
      env: { ...process.env, PHARMACY_LAUNCHER: "1", PORT },
    });
    if (first) {
      first = false;
      waitForServer().then((ok) => ok && (process.env.NO_BROWSER ? null : openBrowser()));
    }
    const code = await new Promise((resolve) => child.on("exit", resolve));
    if (code === UPDATE_EXIT_CODE || fs.existsSync(flagFile)) {
      try {
        update();
      } catch (e) {
        log(`Update failed: ${e.message}. Restarting the current version.`);
      }
      continue;
    }
    log(`Server stopped (exit ${code}).`);
    process.exit(code ?? 0);
  }
}

main().catch((e) => {
  console.error(e.message ?? e);
  process.exit(1);
});
