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

// ── Update progress, visible from the browser ────────────────────────
// While an update runs the app is down, so the launcher answers on the same port itself and shows
// what step it is on. Otherwise the browser sits on a dead connection and the update looks frozen.
const updateLog = path.join(root, "data", "update.log");
let updateStep = "Starting…";

function step(msg) {
  updateStep = msg;
  const line = `${new Date().toLocaleTimeString()}  ${msg}\n`;
  log(msg);
  try {
    fs.appendFileSync(updateLog, line);
  } catch {
    /* the log is a convenience, never a reason to fail an update */
  }
}

/**
 * Runs a build step with its output captured to the update log instead of the console.
 * Inheriting the console on Windows lets a stray click (QuickEdit selection) pause the process —
 * which is exactly what a frozen update looks like.
 */
function runLogged(cmd, args, timeoutMs = 15 * 60_000) {
  step(`${cmd} ${args.join(" ")}`);
  const r = spawnSync(cmd, args, { shell: isWin, encoding: "utf8", timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024 });
  const out = `${r.stdout ?? ""}${r.stderr ?? ""}`.trim();
  if (out) {
    try {
      fs.appendFileSync(updateLog, out.split("\n").slice(-40).join("\n") + "\n");
    } catch {
      /* ignore */
    }
  }
  if (r.error && r.error.code === "ETIMEDOUT") throw new Error(`${cmd} ${args.join(" ")} took too long and was stopped.`);
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(" ")} failed (exit ${r.status})${out ? `:\n${out.split("\n").slice(-8).join("\n")}` : ""}`);
}

function tailLog(n = 14) {
  try {
    return fs.readFileSync(updateLog, "utf8").trim().split("\n").slice(-n).join("\n");
  } catch {
    return "";
  }
}

function statusPage(finished, error) {
  const esc = (t) => String(t).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]);
  const body = error
    ? `<h1>The update could not be installed</h1><p class=s>${esc(error)}</p><p class=s>The previous version is starting again — nothing was lost. This page will return to the app on its own.</p>`
    : finished
      ? "<h1>Update installed</h1><p class=s>Starting the app…</p>"
      : `<h1>Installing the update…</h1><p class=s>${esc(updateStep)}</p><p class=s>This usually takes one to three minutes. Leave this page open — it returns to the app on its own.</p>`;
  return `<!doctype html><html><head><meta charset=utf-8><title>Installing update</title><meta http-equiv=refresh content=3>
<style>body{font:14px system-ui,Segoe UI,sans-serif;margin:0;background:#f7f7f6;color:#1b1b1a;display:flex;min-height:100vh;align-items:center;justify-content:center}
main{max-width:34rem;padding:2rem;text-align:center}h1{font-size:1.25rem;margin:0 0 .5rem}.s{color:#57564f;margin:.35rem 0}
pre{text-align:left;background:#fff;border:1px solid #e2e1dc;border-radius:.5rem;padding:.75rem;font-size:11px;overflow:auto;max-height:16rem;white-space:pre-wrap}</style>
</head><body><main>${body}<pre>${esc(tailLog())}</pre></main></body></html>`;
}

function startStatusServer() {
  let finished = false;
  let error = null;
  const server = http.createServer((req, res) => {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
    res.end(statusPage(finished, error));
  });
  server.on("error", () => {
    /* the port may take a moment to free after the app exits; the browser retries anyway */
  });
  server.listen(PORT, "0.0.0.0");
  return {
    done: () => {
      finished = true;
    },
    failed: (e) => {
      error = e;
    },
    stop: () =>
      new Promise((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections?.();
      }),
  };
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

/**
 * The folders the pharmacy drops files into. Created here rather than committed, because
 * everything under data/ is git-ignored on purpose — real documents never reach the repository.
 * Each gets a short README so the folder explains itself when it is opened in Explorer.
 */
function ensureFolders() {
  const folders = [
    [
      "contracts",
      [
        "CONTRACTS",
        "",
        "Put PBM and payer contract PDFs in here — base agreements, amendments,",
        "rate exhibits, fee schedules.",
        "",
        "Keep download_manifest.csv alongside them if you have one: portals often",
        "assign useless filenames, and the manifest is what maps them back to the",
        "real document names.",
        "",
        "Nothing in this folder is ever committed to the repository or sent anywhere",
        "except to Claude for reading, and only when you ask for that.",
      ],
    ],
    [
      "remits",
      [
        "REMITTANCE FILES",
        "",
        "Put remittance advice in here — 835 files, payer CSV exports, PDF remits.",
        "Apollo and MTF remits arrive separately from the rest; they belong here too.",
        "",
        "Patient details in these files are dropped as they are read. Only prescription",
        "numbers, dates, amounts, reason codes and trace numbers are stored.",
      ],
    ],
    [
      "reference",
      [
        "REFERENCE DATA",
        "",
        "Put the lookup tables in here — BIN crosswalk, contract index, PBM listing,",
        "open-claims aging, bank exports.",
        "",
        "These are the tables that let a claim be matched to the contract that governs it.",
      ],
    ],
  ];
  for (const [name, lines] of folders) {
    const dir = path.join(root, "data", name);
    fs.mkdirSync(dir, { recursive: true });
    const readme = path.join(dir, "README.txt");
    if (!fs.existsSync(readme)) fs.writeFileSync(readme, lines.join("\r\n") + "\r\n");
  }
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

function build(logged = false) {
  const r = logged ? runLogged : run;
  r(npmCmd, ["install", "--no-audit", "--no-fund"]);
  r(npmCmd, ["run", "build"]);
  fs.writeFileSync(path.join(root, ".next", "source-stamp"), sourceStamp());
}

function update() {
  try {
    fs.writeFileSync(updateLog, "");
  } catch {
    /* ignore */
  }
  // Update the branch this copy is on — never switch branches, which could install older code.
  const branch = spawnSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { encoding: "utf8", shell: isWin }).stdout.trim() || "main";
  step(`Downloading the latest version (${branch})…`);
  // The pharmacy computer never edits source; npm install may touch package-lock.json. Discard such changes.
  runLogged("git", ["checkout", "--", "."], 60_000);
  runLogged("git", ["fetch", "origin", branch], 5 * 60_000);
  runLogged("git", ["merge", "--ff-only", `origin/${branch}`], 60_000);
  step("Rebuilding the app — this is the slow part…");
  build(true);
  step(`Update installed (${branch}).`);
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
  ensureFolders();
  ensureEnv();
  if (!fs.existsSync(path.join(root, "node_modules")) || needsBuild()) build();
  let first = true;
  for (;;) {
    if (fs.existsSync(flagFile)) fs.rmSync(flagFile);
    run(npmCmd, ["run", "db:migrate"]);
    log(`Starting on http://localhost:${PORT}`);
    const child = spawn(process.execPath, [path.join(root, "node_modules", "next", "dist", "bin", "next"), "start", "-p", PORT, "-H", "0.0.0.0"], {
      stdio: "inherit",
      env: { ...process.env, PHARMACY_LAUNCHER: "1", PORT },
    });
    if (first) {
      first = false;
      waitForServer().then((ok) => ok && (process.env.NO_BROWSER ? null : openBrowser()));
    }
    const code = await new Promise((resolve) => child.on("exit", resolve));
    if (code === UPDATE_EXIT_CODE || fs.existsSync(flagFile)) {
      const status = startStatusServer();
      try {
        update();
        status.done();
      } catch (e) {
        step(`Update failed: ${e.message}`);
        status.failed(e.message);
        log("Restarting the current version — no data was changed.");
      }
      // Let the browser pick up the final state before the port goes back to the app.
      await new Promise((r) => setTimeout(r, 3500));
      await status.stop();
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
