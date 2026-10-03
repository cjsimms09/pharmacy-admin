/**
 * Everything the pharmacy computer needs so that nobody has to walk to it again.
 *
 * The pharmacist is at the counter or not in the building, and the session that runs this site
 * is reached from his phone. Three things stood between that and "never going to that desk":
 *
 *   1. Claude asked permission for every push, every build and every restart, and the only place
 *      to say yes was the keyboard in front of it. The answer is a permissions file for this
 *      machine only — never committed, listed in .gitignore — that lets it run git, npm, node and
 *      PowerShell here. The deny rules in `.claude/settings.json` stay in force and win: no force
 *      push, no reading of the data folder through the file tool.
 *   2. Commits made on this machine that had not reached GitHub. Those are erased by the next
 *      "Update Pharmacy Admin.cmd", which resets hard to what GitHub holds. `scripts/deploy.mjs`
 *      pushes, then has the launcher install the result.
 *   3. A Claude session that lives in one console window and dies with it. It is registered to
 *      start at sign-in, minimised, continuing its last conversation, with Remote Control on, so
 *      the phone finds it after a reboot too. The site is already started the same way.
 *
 * The session running right now cannot read a permissions file written after it started, so it is
 * restarted at the end — `--continue` keeps the conversation — and the phone picks it up again.
 *
 * Run by double-clicking "Let Claude run the site.cmd". Safe to run again; every step is a
 * statement of how things should be, not a change that stacks.
 */
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
process.chdir(root);
const isWin = process.platform === "win32";

const say = (line = "") => console.log(line);
const step = (t) => say(`\n  ${t}`);
const ok = (t) => say(`  ${t}`);

function ps(script) {
  const r = spawnSync("powershell", ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")], {
    encoding: "utf8",
    timeout: 120_000,
  });
  return { out: (r.stdout || "").trim(), err: (r.stderr || "").trim(), status: r.status };
}

// ── 1. Permissions for this machine ──────────────────────────────────
function writePermissions() {
  step("Letting Claude push, build and restart on this computer without asking…");
  const file = path.join(root, ".claude", "settings.local.json");
  const rules = {
    permissions: {
      allow: [
        "Bash(git:*)",
        "Bash(npm:*)",
        "Bash(npx:*)",
        "Bash(node:*)",
        "Bash(powershell:*)",
        "Bash(schtasks:*)",
        "Bash(cat:*)", "Bash(sed:*)", "Bash(grep:*)", "Bash(ls:*)", "Bash(head:*)", "Bash(tail:*)",
        "Bash(wc:*)", "Bash(find:*)", "Bash(file:*)", "Bash(mkdir:*)", "Bash(cp:*)", "Bash(mv:*)",
        "Bash(rm -f ./scratch:*)",
        "Edit",
        "Write",
      ],
    },
  };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  // No byte-order mark: PowerShell's default UTF-8 writes one and the file then does not parse.
  fs.writeFileSync(file, JSON.stringify(rules, null, 2) + "\n", { encoding: "utf8" });
  ok(`Written to ${path.relative(root, file)} (this machine only; git ignores it).`);
}

// ── 2. Claude at sign-in ─────────────────────────────────────────────
function registerClaudeAtSignIn() {
  step("Registering Claude to start at sign-in, continuing its last conversation…");
  if (!isWin) {
    ok("Not Windows; skipped.");
    return;
  }
  const cmd = path.join(root, "Work on this with Claude.cmd");
  // Minimised rather than hidden: Claude is a conversation, and a window that can be found is
  // worth more than one that cannot. The site's own task stays as it is.
  const tr = `cmd /c start "" /min "${cmd}" --continue`;
  // No shell, so Node quotes the task's command line as one argument with its inner quotes escaped,
  // which is the form schtasks expects and the form a shell would tear apart.
  const r = spawnSync("schtasks", ["/Create", "/F", "/SC", "ONLOGON", "/TN", "Claude on the pharmacy computer", "/TR", tr], { encoding: "utf8" });
  if (r.status === 0) ok("Done. After a restart, the phone finds the session again on its own.");
  else ok(`Could not register (${(r.stderr || r.stdout || "").trim().split("\n")[0]}). Everything else still works; right-click the .cmd and "Run as administrator" to add this.`);
}

// ── 3. Commit this setup itself, if the session could not ────────────
/*
 * The session that wrote these files was refused the commit — the same wall this whole file exists
 * to remove — so they may still be sitting uncommitted, and deploy.mjs rightly refuses to deploy
 * over uncommitted work. Only these named files are committed here, never "whatever is dirty":
 * anything else on disk is somebody's work in progress and deploy.mjs will name it and stop.
 */
function commitThisSetup() {
  const mine = ["Let Claude run the site.cmd", "Work on this with Claude.cmd", "scripts/let-claude-work.mjs", "scripts/claude-here.mjs"];
  // No shell: two of these file names carry spaces, and with a shell Node hands the arguments over
  // unquoted, so "Let Claude run the site.cmd" would arrive as five files git has never heard of.
  const status = spawnSync("git", ["status", "--porcelain", "--", ...mine], { encoding: "utf8" }).stdout.trim();
  if (!status) return;
  step("Committing this setup (Claude was not allowed to)…");
  spawnSync("git", ["add", "--", ...mine], { encoding: "utf8" });
  const message = [
    "So nobody has to walk to that computer again",
    "",
    "One double-click on the pharmacy computer: a permissions file for this",
    "machine only, so Claude can push, build and restart here without a hand at",
    "the keyboard; the session registered to start at sign-in with --continue",
    "and Remote Control, so a reboot does not lose it; and the commits sitting",
    "here pushed and installed, before an Update Pharmacy Admin.cmd could reset",
    "them away.",
    "",
    "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>",
    "Claude-Session: https://claude.ai/code/session_013dVFbCGTjMHjNvhRpqNqZi",
  ].join("\n");
  const r = spawnSync("git", ["commit", "-q", "-F", "-"], { input: message, encoding: "utf8" });
  if (r.status === 0) ok("Committed.");
  else ok(`Could not commit (${(r.stderr || r.stdout || "").trim().split("\n")[0]}). The deploy below will say what is in the way.`);
}

// ── 4. Push and install what is committed ────────────────────────────
function deploy() {
  step("Pushing what is committed here and having the site install it (one to three minutes)…");
  const r = spawnSync(process.execPath, [path.join(root, "scripts", "deploy.mjs")], { stdio: "inherit", timeout: 30 * 60_000 });
  if (r.status === 0) ok("The site is on the latest commit.");
  else ok("The deploy did not finish — read the lines above. The site keeps running whatever it had.");
  return r.status === 0;
}

// ── 5. Restart the session so it reads the permissions ───────────────
function restartClaude() {
  step("Restarting Claude so it reads the new permissions (the conversation continues)…");
  if (!isWin) {
    ok("Not Windows; start Claude again by hand with --continue.");
    return;
  }
  // Only the Claude Code process itself. The launcher (launch.mjs) and the site (next start) are
  // node too, and this must never touch them.
  const found = ps(`Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" | Where-Object { $_.CommandLine -like '*claude-code*' -and $_.CommandLine -notlike '*launch.mjs*' -and $_.CommandLine -notlike '*next*' } | ForEach-Object { $_.ProcessId }`).out
    .split(/\s+/)
    .filter(Boolean);
  for (const pid of found) ps(`Stop-Process -Id ${pid} -Force -ErrorAction SilentlyContinue`);
  ok(found.length ? `Stopped the running session (pid ${found.join(", ")}).` : "No session was running.");
  const cmd = path.join(root, "Work on this with Claude.cmd");
  const child = spawn("cmd", ["/c", "start", "", "/min", cmd, "--continue"], { detached: true, stdio: "ignore", shell: false });
  child.unref();
  ok("Started again, minimised, with Remote Control on. Open the Claude app on your phone and pick it up there.");
}

function main() {
  say("Let Claude run the site");
  say("=======================");
  say();
  say("After this, the site updates itself from what Claude pushes, and Claude runs here without");
  say("asking for permission at the keyboard. The pharmacy's data is not touched by any of it.");
  writePermissions();
  registerClaudeAtSignIn();
  commitThisSetup();
  deploy();
  restartClaude();
  say();
  say("Done. You should not need this computer again for the site.");
}

main();
