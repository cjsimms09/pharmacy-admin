/**
 * Puts what is committed onto the pharmacy's site: pushes the branch, then has the launcher
 * install it and waits until the app is answering again.
 *
 * The site is not deployed by copying files. `scripts/launch.mjs` runs the app, and when the app
 * exits with code 75 — or leaves `data/.update-requested` behind — the launcher takes the latest
 * commit on the branch it is on, rebuilds, migrates and starts again, showing its progress on the
 * port the whole time so the browser never sits on a dead connection. That is the only path an
 * update takes, and it has its own recovery: a rebuild that fails starts the previous build, a
 * migration that refuses does not stop a working site. This script does nothing the launcher does
 * not already do; it only starts that sequence from the command line and reports how it went.
 *
 * ── The two things it refuses to do ──
 *
 * It will not deploy with uncommitted changes on disk. The launcher runs `git checkout -- .` before
 * it builds, which does not leave edits out of the build — it deletes them from the working tree.
 *
 * It will not trigger the launcher until the push has succeeded. "Update Pharmacy Admin.cmd" resets
 * the working copy hard to what GitHub holds, so a commit that is only on this machine is one that
 * the next person to run that file erases, along with the fix in it.
 *
 * ── How it knows the app is back ──
 *
 * While the launcher is installing, the port answers with the launcher's own status page. The app
 * sends the security headers in `next.config.ts` on every response and the launcher's page sends
 * none, so a reply carrying `x-frame-options` is the app and one without it is the launcher. No
 * login is needed to tell them apart, and the build id in `.next/BUILD_ID` before and after says
 * whether what came back is actually the new build.
 *
 * Run as:  npm run deploy
 */
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
process.chdir(root);

const BRANCH = "feature/compliance";
const PORT = process.env.PORT || "3000";
const isWin = process.platform === "win32";
const dataDir = path.dirname(path.resolve(process.env.DATABASE_PATH ?? "./data/pharmacy-admin.db"));
const flagFile = path.join(dataDir, ".update-requested");
const updateLog = path.join(dataDir, "update.log");
const buildIdFile = path.join(root, ".next", "BUILD_ID");
/** A build on this machine is one to three minutes; the launcher retries a failed one with less at once. */
const WAIT_MS = 25 * 60_000;

function say(msg) {
  console.log(`[deploy] ${msg}`);
}
function fail(msg) {
  console.error(`[deploy] ${msg}`);
  process.exit(1);
}

function git(args) {
  const r = spawnSync("git", args, { encoding: "utf8", shell: isWin, timeout: 5 * 60_000 });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${(r.stderr || r.stdout || "").trim().split("\n")[0] || `exit ${r.status}`}`);
  return r.stdout.trim();
}

/**
 * Runs a PowerShell script and returns its output. Encoded rather than quoted, because the script
 * has to carry quotes of its own and every layer between here and PowerShell has an opinion about
 * them; base64 carries none.
 */
function ps(script) {
  const r = spawnSync("powershell", ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")], {
    encoding: "utf8",
    timeout: 60_000,
  });
  return (r.stdout || "").trim();
}

/** The process ids of every launcher, and of whatever is holding the port. */
function processes() {
  if (isWin) {
    const launchers = ps(`Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" | Where-Object { $_.CommandLine -like '*launch.mjs*' } | ForEach-Object { $_.ProcessId }`)
      .split(/\s+/)
      .filter(Boolean)
      .map(Number);
    const holder = Number(ps(`(Get-NetTCPConnection -LocalPort ${PORT} -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1).OwningProcess`)) || null;
    return { launchers, holder };
  }
  const launchers = (spawnSync("pgrep", ["-f", "launch.mjs"], { encoding: "utf8" }).stdout || "").split(/\s+/).filter(Boolean).map(Number);
  const holder = Number((spawnSync("lsof", ["-t", `-iTCP:${PORT}`, "-sTCP:LISTEN"], { encoding: "utf8" }).stdout || "").split(/\s+/)[0]) || null;
  return { launchers, holder };
}

function stopProcess(pid) {
  if (isWin) ps(`Stop-Process -Id ${pid} -Force -ErrorAction SilentlyContinue`);
  else process.kill(pid, "SIGTERM");
}

function readFile(file) {
  try {
    return fs.readFileSync(file, "utf8").trim();
  } catch {
    return null;
  }
}

/** One request to the port: who answered and, if it was the launcher, what its page says. */
function probe() {
  return new Promise((resolve) => {
    const req = http.get({ host: "127.0.0.1", port: PORT, path: "/", timeout: 5_000 }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (c) => {
        if (body.length < 8_000) body += c;
      });
      res.on("end", () => {
        if (res.headers["x-frame-options"]) return resolve({ who: "app" });
        const h1 = /<h1>(.*?)<\/h1>/.exec(body)?.[1] ?? "";
        const stepText = /<p class=s>(.*?)<\/p>/.exec(body)?.[1] ?? "";
        resolve({ who: "launcher", text: [h1, stepText].filter(Boolean).join(" — ") });
      });
    });
    req.on("timeout", () => {
      req.destroy();
      resolve({ who: "nobody" });
    });
    req.on("error", () => resolve({ who: "nobody" }));
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  // ── What is being deployed ─────────────────────────────────────────
  if (!fs.existsSync(path.join(root, ".git"))) fail("This folder is not a git checkout; there is nothing to push.");
  const branch = git(["rev-parse", "--abbrev-ref", "HEAD"]);
  if (branch !== BRANCH) fail(`This checkout is on ${branch}. The site runs from ${BRANCH}, and the launcher updates whichever branch it is on — switch first.`);

  // package-lock.json is the one file the pharmacy computer itself changes (npm install on an
  // update touches it), and the launcher discards that change on purpose. Anything else is work.
  const dirty = git(["status", "--porcelain"])
    .split("\n")
    .filter(Boolean)
    .filter((l) => !l.endsWith("package-lock.json"));
  if (dirty.length) fail(`Uncommitted changes, which the launcher would delete from disk before building:\n  ${dirty.join("\n  ")}\nCommit them first.`);

  const head = git(["rev-parse", "--short", "HEAD"]);
  const subject = git(["log", "-1", "--format=%s"]);

  // ── Push ────────────────────────────────────────────────────────────
  say(`Pushing ${head} "${subject}" to origin/${BRANCH}…`);
  try {
    git(["push", "origin", BRANCH]);
  } catch (e) {
    fail(`${e.message}\nNothing was deployed: a commit that is not on GitHub is one "Update Pharmacy Admin.cmd" would erase.`);
  }
  const remote = git(["rev-parse", "--short", `origin/${BRANCH}`]);
  if (remote !== head) fail(`After the push origin/${BRANCH} is ${remote}, not ${head}. Not touching the site until they agree.`);
  say(`GitHub has ${head}.`);

  // ── Ask the launcher ────────────────────────────────────────────────
  const buildBefore = readFile(buildIdFile);
  const { launchers, holder } = processes();

  if (launchers.length > 0 && holder) {
    // The launcher installs an update when its child exits with the flag file present. Writing the
    // flag and stopping the app is exactly what the Updates page does from inside the app.
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(flagFile, new Date().toISOString());
    say(`Launcher running (pid ${launchers.join(", ")}); stopping the app (pid ${holder}) so it installs ${head}…`);
    stopProcess(holder);
  } else if (launchers.length > 0) {
    // A launcher with no app on the port is one in the middle of a build or a recovery already.
    say(`Launcher running (pid ${launchers.join(", ")}) but nothing holds port ${PORT} — it is already building or recovering. Waiting for it.`);
  } else {
    // No launcher: build here, then start it the way sign-in does. It migrates on its way up.
    say(`No launcher is running. Building ${head} here, then starting the launcher hidden…`);
    const b = spawnSync(isWin ? "npm.cmd" : "npm", ["run", "build"], { stdio: "inherit", shell: isWin, timeout: 30 * 60_000 });
    if (b.status !== 0) fail("The build failed; the launcher was not started. Read the output above.");
    const child = isWin
      ? spawn("wscript.exe", [path.join(root, "scripts", "start-hidden.vbs")], { detached: true, stdio: "ignore" })
      : spawn(process.execPath, [path.join(root, "scripts", "launch.mjs")], { detached: true, stdio: "ignore", env: { ...process.env, NO_BROWSER: "1" } });
    child.unref();
  }

  // ── Wait for the app ────────────────────────────────────────────────
  const started = Date.now();
  let lastText = "";
  let sawLauncher = false;
  while (Date.now() - started < WAIT_MS) {
    await sleep(5_000);
    const p = await probe();
    if (p.who === "launcher") {
      sawLauncher = true;
      if (p.text && p.text !== lastText) {
        lastText = p.text;
        say(p.text);
      }
      continue;
    }
    if (p.who === "app") {
      // Straight after a stop the old process can answer one last time; insist on seeing it after
      // the launcher's page, or after enough time that a fresh start could have happened.
      if (!sawLauncher && Date.now() - started < 20_000) continue;
      const buildAfter = readFile(buildIdFile);
      const local = git(["rev-parse", "--short", "HEAD"]);
      if (buildAfter && buildAfter !== buildBefore) {
        say(`Live. ${local} is running on port ${PORT} (build ${buildBefore ?? "none"} → ${buildAfter}).`);
        return;
      }
      // Answering, but on the build it had before: the install failed and the launcher fell back.
      const log = readFile(updateLog);
      fail(
        `The app is answering but on the build it had before (${buildAfter ?? "none"}). The launcher installed nothing and started the previous version.` +
          (log ? `\n\nLast of data/update.log:\n  ${log.split("\n").slice(-12).join("\n  ")}` : ""),
      );
    }
  }
  const log = readFile(updateLog);
  fail(`Nothing answered on port ${PORT} within ${WAIT_MS / 60_000} minutes.` + (log ? `\n\nLast of data/update.log:\n  ${log.split("\n").slice(-12).join("\n  ")}` : ""));
}

main().catch((e) => fail(e?.stack || String(e)));
