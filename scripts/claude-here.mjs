/**
 * Puts Claude on the pharmacy computer, inside this project, with the live site and the live
 * database in front of it.
 *
 * The reason this exists is a wall found the hard way. Claude working on this site from the web
 * runs in a container whose network is restricted to a fixed list — GitHub, npm, a few package
 * registries — and nothing else. Every other host on the internet is refused, tunnel services
 * included, so the address the pharmacy opened to the outside could never have been reached from
 * there. No URL can be. That is not a setting anybody here can change.
 *
 * Which leaves the direction that was always better anyway: rather than opening the pharmacy to
 * Claude, put Claude in the pharmacy. Running here it reads the real database directly, opens the
 * real screens, runs the real tests, and changes the code in place — with nothing exposed to the
 * internet at all, no tunnel, no address, and no window anybody has to remember to close.
 *
 * Started by double-clicking "Work on this with Claude.cmd", which is the same shape as every
 * other thing on this computer.
 */
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
process.chdir(root);
const isWin = process.platform === "win32";
const npmCmd = isWin ? "npm.cmd" : "npm";

function say(line = "") {
  console.log(line);
}

/**
 * Whether Claude Code is already on this computer.
 *
 * Checked by running it rather than by looking for a file: a command that is installed but not on
 * the PATH is not installed as far as this is concerned, and that distinction is the whole
 * difference between working and a confusing error.
 */
function installedVersion() {
  const r = spawnSync(isWin ? "claude.cmd" : "claude", ["--version"], { encoding: "utf8", shell: isWin, timeout: 60_000 });
  return r.status === 0 ? (r.stdout || "").trim() : null;
}

function install() {
  say("Claude is not on this computer yet. Installing it — this takes a minute or two.");
  say();
  const r = spawnSync(npmCmd, ["install", "-g", "@anthropic-ai/claude-code"], { stdio: "inherit", shell: isWin, timeout: 20 * 60_000 });
  if (r.status !== 0) {
    say();
    say("The install did not finish. The usual reason is that this window is not allowed to install");
    say("programs. Close it, right-click \"Work on this with Claude.cmd\", choose \"Run as");
    say("administrator\", and try again.");
    return false;
  }
  return true;
}

function main() {
  say("Working on the pharmacy site with Claude");
  say("=========================================");
  say();

  if (!fs.existsSync(path.join(root, "package.json"))) {
    say(`This does not look like the pharmacy site folder (${root}).`);
    process.exit(1);
  }

  let version = installedVersion();
  if (!version) {
    if (!install()) process.exit(1);
    version = installedVersion();
    if (!version) {
      say();
      say("Claude installed but this window cannot see it yet, which Windows does after a new program");
      say("is added. Close this window and double-click the file again — it will work the second time.");
      process.exit(1);
    }
  }

  say(`Claude ${version} is ready, in ${root}`);
  say();
  say("It can read the pharmacy's real database and change this site directly. The work happens on");
  say("this computer — nothing about the pharmacy is published to the internet.");
  say();
  say("The first time, it will ask you to sign in with the same account you use on claude.ai.");
  say();
  say("A QR CODE will appear. Scan it with the Claude app on your phone and you can carry on the");
  say("same conversation from anywhere — the work still runs here, on this computer, against the");
  say("real data. If you do not have the app yet, type  /mobile  for a link to it.");
  say();
  say("Type what you want done and press enter. Type /exit when you are finished.");
  say("-----------------------------------------------------------------------------");
  say();

  /*
   * Started with Remote Control on, so the phone works without anybody having to know it exists.
   *
   * The pharmacist is not at this desk most of the day — he is at the counter, or not in the
   * building. A tool that can only be reached by walking to one computer is a tool that gets used
   * on the days somebody remembers to walk to it. With this flag the session is reachable from the
   * Claude app the moment it starts, and the work still happens here, on this machine, against the
   * real database. Nothing is published: the phone is a keyboard, not a copy.
   *
   * `--remote-control` rather than the `remote-control` sub-command deliberately. The sub-command
   * refuses to start at all on an account that cannot use it; the flag starts the session anyway
   * and simply says Remote Control is unavailable. Losing the phone is a disappointment. Losing
   * the session is the thing that makes somebody give up.
   *
   * Handed the terminal outright rather than run and reported on: this is a conversation, not a
   * job with an outcome, and every key the pharmacist presses has to reach it.
   */
  const child = spawn(isWin ? "claude.cmd" : "claude", ["--remote-control", "Pharmacy Admin"], { stdio: "inherit", shell: isWin, cwd: root });
  child.on("exit", (code) => process.exit(code ?? 0));
}

main();
