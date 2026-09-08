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
  const r = spawnSync(cmd, args, { stdio: "inherit", shell: isWin, ...(opts ?? {}) });
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
function runLogged(cmd, args, timeoutMs = 30 * 60_000, env = undefined) {
  step(`${cmd} ${args.join(" ")}`);
  const r = spawnSync(cmd, args, {
    shell: isWin,
    encoding: "utf8",
    timeout: timeoutMs,
    maxBuffer: 32 * 1024 * 1024,
    env: env ? { ...process.env, ...env } : process.env,
  });
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

/**
 * The page shown when the site could not be started at all.
 *
 * Every path out of this launcher used to be process.exit(1) with the console window hidden, so a
 * failed build, a failed migration or a missing .next all looked identical from the pharmacy: the
 * browser said it could not connect, and there was nothing anywhere to say why. That is the worst
 * failure this program has, because it is the one that cannot be diagnosed from where it happens.
 *
 * So nothing exits quietly any more. Whatever went wrong is written on the port the site normally
 * answers on, the recovery keeps running behind it, and the page returns to the app by itself when
 * the site is up.
 */
function problemPage(title, detail) {
  const esc = (t) => String(t).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]);
  return `<!doctype html><html><head><meta charset=utf-8><title>${esc(title)}</title><meta http-equiv=refresh content=5>
<style>body{font:14px system-ui,Segoe UI,sans-serif;margin:0;background:#f7f7f6;color:#1b1b1a;display:flex;min-height:100vh;align-items:center;justify-content:center}
main{max-width:38rem;padding:2rem}h1{font-size:1.25rem;margin:0 0 .5rem}.s{color:#57564f;margin:.35rem 0}
pre{background:#fff;border:1px solid #e2e1dc;border-radius:.5rem;padding:.75rem;font-size:11px;overflow:auto;max-height:18rem;white-space:pre-wrap}</style>
</head><body><main><h1>${esc(title)}</h1>
<p class=s>Nothing has been lost — the database and every document are untouched. This keeps trying on its own and returns to the app the moment it succeeds.</p>
<pre>${esc(detail)}</pre>
<p class=s>Leave this page open. If it is still here in ten minutes, send this text on.</p></main></body></html>`;
}

/** Holds the port while the site cannot, so there is always something to look at. */
function startProblemServer() {
  let title = "Starting the pharmacy site\u2026";
  let detail = "";
  const server = http.createServer((req, res) => {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
    res.end(problemPage(title, detail));
  });
  server.on("error", () => {
    /* the port may still be held by the process that just died; the browser retries anyway */
  });
  server.listen(PORT, "0.0.0.0");
  return {
    set: (t, d) => {
      title = t;
      detail = `${d}\n\n${tailLog(20)}`.trim();
    },
    stop: () =>
      new Promise((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections?.();
      }),
  };
}

/* ── Reaching the site from outside the pharmacy, deliberately and briefly ── */

const accessFile = path.join(root, "data", "public-access.json");

/** What was asked for, or null. An unreadable record means not exposed; there is no benefit of the doubt. */
function readAccess() {
  try {
    const a = JSON.parse(fs.readFileSync(accessFile, "utf8"));
    return a && typeof a.expiresAt === "string" ? a : null;
  } catch {
    return null;
  }
}

function accessOpen(a) {
  if (!a) return false;
  const ends = Date.parse(a.expiresAt);
  return Number.isFinite(ends) && ends > Date.now();
}

/**
 * Where cloudflared is, or null if it is not on this computer.
 *
 * Not installed for the pharmacy automatically and not downloaded behind their back: a program that
 * opens a machine to the internet is one somebody should have put there on purpose.
 */
function cloudflaredPath() {
  const candidates = [
    path.join(root, "bin", isWin ? "cloudflared.exe" : "cloudflared"),
    isWin ? "C:\\Program Files (x86)\\cloudflared\\cloudflared.exe" : "/usr/local/bin/cloudflared",
    isWin ? "C:\\Program Files\\cloudflared\\cloudflared.exe" : "/usr/bin/cloudflared",
  ];
  for (const c of candidates) if (fs.existsSync(c)) return c;
  const which = spawnSync(isWin ? "where" : "which", ["cloudflared"], { encoding: "utf8", shell: isWin });
  const found = (which.stdout || "").split(/\r?\n/)[0].trim();
  return found && fs.existsSync(found) ? found : null;
}

/**
 * Opens the tunnel and waits for it to say what address it got.
 *
 * The address is random and only exists once the tunnel is up, which is why this has to happen
 * before the app starts rather than after: the app has to be told the address it is answering on,
 * or every button on every page fails the origin check silently.
 */
function startTunnel(bin) {
  return new Promise((resolve) => {
    const child = spawn(bin, ["tunnel", "--no-autoupdate", "--url", `http://localhost:${PORT}`], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let settled = false;
    const finish = (url) => {
      if (settled) return;
      settled = true;
      resolve({ child, url });
    };
    const look = (chunk) => {
      const m = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/i.exec(chunk.toString());
      if (m) finish(m[0]);
    };
    child.stdout.on("data", look);
    child.stderr.on("data", look);
    child.on("error", () => finish(null));
    child.on("exit", () => finish(null));
    // It normally answers in seconds. If it has not by now, it is not going to.
    setTimeout(() => finish(null), 60_000);
  });
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

/**
 * The build, with the memory it needs and a second attempt if the machine could not give it.
 *
 * The pharmacy's update failed with "Next.js build worker exited with code 3221225786" — 0xC000013A,
 * a Windows process killed rather than a compile error. That is a machine running out of room, not
 * broken code: the dispensing system, the label printer software and a browser are all open while
 * this runs. Nothing was changed, so the pharmacy stayed on the previous week's code with every fix
 * since sitting on GitHub — which is the worst outcome available, because it looks like the fixes
 * were never made.
 *
 * So the build gets a stated heap rather than whatever V8 guesses from the machine, and if it dies
 * anyway it is tried once more with less: half the heap, no parallelism, no telemetry. A slow update
 * that finishes beats a fast one that does not.
 */
function build(logged = false) {
  const r = logged ? runLogged : run;
  r(npmCmd, ["install", "--no-audit", "--no-fund"], logged ? 20 * 60_000 : undefined);
  const once = (env, timeout) => {
    if (logged) runLogged(npmCmd, ["run", "build"], timeout, env);
    else run(npmCmd, ["run", "build"], { env: { ...process.env, ...env } });
    // A build that exits nought without writing a BUILD_ID has not produced a site. Next has done
    // this when a worker died late, and the app then starts against a directory that looks built.
    if (!fs.existsSync(path.join(root, ".next", "BUILD_ID"))) {
      throw new Error("the build finished without producing a site (no BUILD_ID)");
    }
  };
  try {
    once({ NODE_OPTIONS: "--max-old-space-size=4096", NEXT_TELEMETRY_DISABLED: "1" }, 30 * 60_000);
  } catch (e) {
    /*
     * Start again from nothing rather than on top of the wreckage.
     *
     * A build killed part way leaves .next half written, and the next attempt reads that cache and
     * fails in stranger ways — while the app cannot start at all, because the working build it
     * replaced is gone. Clearing it costs a few minutes and is the difference between a pharmacy
     * that is slow to update and one that has no site.
     */
    step(`The build did not finish (${String(e.message).split("\n")[0]}). Clearing the half-built copy and trying again with less at once…`);
    try {
      fs.rmSync(path.join(root, ".next"), { recursive: true, force: true });
    } catch {
      /* Locked by something still running; the retry will overwrite what it can. */
    }
    once({ NODE_OPTIONS: "--max-old-space-size=2048", NEXT_TELEMETRY_DISABLED: "1", UV_THREADPOOL_SIZE: "2" }, 40 * 60_000);
  }
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
  /*
   * With no site at all, take the latest code before trying to build one.
   *
   * A build that fails leaves .next half written: the working site gone and the new one not there.
   * The app then cannot start, and the only way to ask for an update was a button inside the app —
   * so the fix for the failure sat on GitHub with no way to reach it, and every restart rebuilt the
   * same code the same way and failed the same way.
   *
   * A computer with no site has nothing to lose by taking the newest code first. If GitHub cannot
   * be reached, that is not a reason to stop: it builds what is here, which is what it would have
   * done anyway.
   */
  const noSite = !fs.existsSync(path.join(root, ".next", "BUILD_ID"));
  if (noSite && fs.existsSync(path.join(root, ".git"))) {
    const branch = spawnSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { encoding: "utf8", shell: isWin }).stdout.trim() || "main";
    log(`No built site found. Taking the latest ${branch} before building…`);
    for (const args of [["checkout", "--", "."], ["fetch", "origin", branch], ["merge", "--ff-only", `origin/${branch}`]]) {
      const r = spawnSync("git", args, { encoding: "utf8", shell: isWin, timeout: 5 * 60_000 });
      if (r.status !== 0) {
        log(`  git ${args[0]} did not run (${(r.stderr || "").trim().split("\n")[0] || "no network"}). Building what is here.`);
        break;
      }
    }
  }
  const buildId = path.join(root, ".next", "BUILD_ID");
  /*
   * One place that keeps the port answering while anything is wrong, and gets out of the way when
   * it is not. It is started only when needed, because while the app is running the app owns the port.
   */
  let problem = null;
  const showProblem = (title, detail) => {
    if (!problem) problem = startProblemServer();
    problem.set(title, String(detail ?? ""));
  };
  const clearProblem = async () => {
    if (problem) await problem.stop();
    problem = null;
  };

  /**
   * Builds, and does not give up.
   *
   * A pharmacy computer with no site has one job: get one. Failing once is common — the machine ran
   * out of room, GitHub was unreachable, a file was locked. Failing once and exiting is what turned
   * those into a morning without the site, so this keeps trying, taking the latest code each time
   * in case the fix for whatever broke has already been pushed.
   */
  const buildUntilItWorks = async (why) => {
    let attempt = 0;
    for (;;) {
      attempt++;
      showProblem("Building the pharmacy site\u2026", `${why}\n\nAttempt ${attempt}. This takes a minute or two each time.`);
      try {
        if (attempt > 1 && fs.existsSync(path.join(root, ".git"))) {
          // The fix may already be pushed; take it before spending another build on the same code.
          const branch = spawnSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { encoding: "utf8", shell: isWin }).stdout.trim() || "main";
          for (const args of [["checkout", "--", "."], ["fetch", "origin", branch], ["merge", "--ff-only", `origin/${branch}`]]) {
            spawnSync("git", args, { encoding: "utf8", shell: isWin, timeout: 5 * 60_000 });
          }
        }
        build(true);
        if (fs.existsSync(buildId)) return;
        why = "The build finished without producing a site.";
      } catch (e) {
        why = String(e.message ?? e);
        log(`Build failed: ${why.split("\n")[0]}`);
      }
      showProblem("The pharmacy site could not be built", `${why}\n\nTrying again in one minute.`);
      await new Promise((r) => setTimeout(r, 60_000));
    }
  };

  if (!fs.existsSync(path.join(root, "node_modules")) || needsBuild()) {
    try {
      build();
    } catch (e) {
      // A previous build still on disk is a working site; use it rather than leaving the pharmacy with none.
      if (fs.existsSync(buildId)) log(`The rebuild failed (${String(e.message ?? e).split("\n")[0]}). Starting the previous version instead.`);
      else await buildUntilItWorks(String(e.message ?? e));
    }
  }
  let first = true;
  let consecutiveFailures = 0;
  for (;;) {
    if (fs.existsSync(flagFile)) fs.rmSync(flagFile);
    /*
     * The migration is not allowed to be fatal either.
     *
     * It refuses to run when the migration files are out of order, which is right — applying them
     * anyway would silently skip one — but exiting on that refusal took the whole site down for a
     * fault that stops nothing already working.
     */
    try {
      run(npmCmd, ["run", "db:migrate"]);
    } catch (e) {
      if (!fs.existsSync(buildId)) {
        showProblem("The database could not be brought up to date", String(e.message ?? e));
        await new Promise((r) => setTimeout(r, 60_000));
        continue;
      }
      log(`The database migration did not run (${String(e.message ?? e).split("\n")[0]}). Starting anyway.`);
    }
    if (!fs.existsSync(buildId)) await buildUntilItWorks("There is no built site — the last build did not finish.");
    await clearProblem();

    /*
     * If somebody has asked for the site to be reachable from outside, the tunnel comes up first.
     *
     * First, because the app has to be told the address before it starts: Next refuses a server
     * action whose Origin does not match the host it believes it is serving, and a tunnel makes
     * those two different things. Told afterwards, every page would render and every button would
     * quietly fail.
     *
     * A record whose time has passed is not a request. Nothing here reopens on its own after a
     * restart either — a computer switched on in the morning comes up private, which is the
     * behaviour somebody would want if they had thought about it the night before and did not.
     */
    let access = readAccess();
    let tunnel = null;
    if (accessOpen(access)) {
      const bin = cloudflaredPath();
      if (!bin) {
        log("Public access was asked for, but cloudflared is not installed on this computer. Starting privately.");
        access = null;
      } else {
        step(`Opening the site to the outside until ${new Date(access.expiresAt).toLocaleTimeString()}\u2026`);
        const t = await startTunnel(bin);
        if (!t.url) {
          try { t.child?.kill(); } catch { /* it may already be gone */ }
          log("The tunnel did not come up. Starting privately, which is the safe way to fail.");
          access = null;
        } else {
          tunnel = t.child;
          access = { ...access, url: t.url };
          try { fs.writeFileSync(accessFile, JSON.stringify(access, null, 2)); } catch { /* the app reads it for the banner only */ }
          log(`The site is reachable at ${t.url} until ${new Date(access.expiresAt).toLocaleTimeString()}.`);
        }
      }
    }

    log(`Starting on http://localhost:${PORT}`);
    const child = spawn(process.execPath, [path.join(root, "node_modules", "next", "dist", "bin", "next"), "start", "-p", PORT, "-H", "0.0.0.0"], {
      stdio: "inherit",
      env: {
        ...process.env,
        PHARMACY_LAUNCHER: "1",
        PORT,
        // Both only ever set while a tunnel is actually up, and gone the moment it is not.
        ...(tunnel && access?.url ? { PUBLIC_ORIGIN: access.url, COOKIE_SECURE: "1" } : {}),
      },
    });

    /*
     * The clock that closes it, which is the whole safety of this feature.
     *
     * Exposure that depends on somebody remembering to end it is exposure that lasts until the
     * next person notices, and nobody notices a website that is working. So the launcher watches
     * the expiry itself and takes the site down and back up privately when it passes — and does
     * the same the moment the record is deleted, which is how the stop button works.
     */
    let closing = null;
    if (tunnel && access) {
      closing = setInterval(() => {
        const still = readAccess();
        if (accessOpen(still) && still?.expiresAt === access.expiresAt) return;
        log("Public access has ended. Closing the tunnel and restarting privately.");
        try { tunnel.kill(); } catch { /* already gone */ }
        try { fs.rmSync(accessFile, { force: true }); } catch { /* the expiry has already closed it */ }
        try { child.kill(); } catch { /* it is on its way out anyway */ }
      }, 15_000);
      closing.unref?.();
    }
    if (first) {
      first = false;
      waitForServer().then((ok) => ok && (process.env.NO_BROWSER ? null : openBrowser()));
    }
    // A start that answers a request is a start that worked, whatever it does later.
    void waitForServer(20).then((ok) => {
      if (ok) consecutiveFailures = 0;
    });
    const code = await new Promise((resolve) => child.on("exit", resolve));
    // A tunnel must never outlive the app it points at: that is a door onto a machine with nothing
    // behind it, and the next thing to bind the port inherits the address.
    if (closing) clearInterval(closing);
    if (tunnel) {
      try { tunnel.kill(); } catch { /* already gone */ }
    }
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
    /*
     * A server that stops on its own is not a reason to leave the pharmacy with nothing.
     *
     * This is the exact way the site disappeared: an update cleared .next and did not replace it,
     * `next start` found no build and exited at once, and the launcher exited with it — hidden
     * window, dead port, no message anywhere. Now a failure rebuilds and comes back, and only a
     * clean stop is treated as somebody meaning it.
     */
    if (code === 0 || code === null) {
      log("Server stopped.");
      process.exit(0);
    }
    consecutiveFailures++;
    log(`Server stopped (exit ${code}). Attempt ${consecutiveFailures} to bring it back.`);
    if (!fs.existsSync(buildId)) {
      await buildUntilItWorks(`The site stopped straight away (exit ${code}) and there is no built site.`);
    } else if (consecutiveFailures >= 2) {
      // Twice in a row with a build present is not a passing thing; rebuild it from the latest code.
      await buildUntilItWorks(`The site stopped straight away (exit ${code}), twice running.`);
    }
    showProblem("The pharmacy site is restarting\u2026", `It stopped with exit code ${code}.`);
    await new Promise((r) => setTimeout(r, consecutiveFailures > 2 ? 30_000 : 3_000));
  }
}

main().catch((e) => {
  /*
   * The last resort, and the whole point of it: something to look at.
   *
   * This used to print to a console window that is hidden by design and then exit, which from the
   * pharmacy is indistinguishable from the computer being off. Holding the port with the reason
   * costs nothing and turns "it will not come up" into a sentence that can be acted on.
   */
  const message = String(e?.message ?? e);
  console.error(message);
  try {
    const server = startProblemServer();
    server.set("The pharmacy site could not be started", message);
    log(`Holding http://localhost:${PORT} with the reason above. Close this window to stop.`);
  } catch {
    process.exit(1);
  }
});
