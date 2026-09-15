/**
 * Brings one of the two Claude sessions back, with Remote Control on, in the same conversation.
 *
 * The pharmacist runs two sessions on this computer against this repository — "Pharmacy 1", which
 * deploys and talks to him, and "Pharmacy 2", which builds — and both start in this folder. That
 * matters: `claude --continue` resumes whichever conversation in a folder was touched last, so with
 * two of them a plain --continue is a coin toss and reopening one can pick up the other's thread.
 *
 * So each session is reopened by its own id, which is stable for the life of the conversation and
 * is the name of its transcript file. If that transcript is gone — a cleared history, a new
 * machine — the script does not start a blank session pretending to be the old one. It hands over
 * to Claude's own picker so the person can see what conversations exist and choose, which is the
 * honest answer to "the one you wanted is not here".
 *
 *   node scripts/reopen-session.mjs "Pharmacy 1" <session-id>
 *
 * Started by double-clicking "Reopen Pharmacy 1.cmd" or "Reopen Pharmacy 2.cmd".
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
process.chdir(root);
const isWin = process.platform === "win32";

const name = process.argv[2] || "Pharmacy Admin";
const sessionId = process.argv[3] || "";

/**
 * Where Claude keeps this folder's conversations.
 *
 * The folder name is the working directory with every separator and colon turned into a dash,
 * which is how Claude Code names it. Worked out rather than hard-coded so this keeps working if
 * the repository is ever moved or copied to another machine.
 */
const projectDir = path.join(os.homedir(), ".claude", "projects", root.replace(/[\\/:]/g, "-"));
const transcript = sessionId ? path.join(projectDir, `${sessionId}.jsonl`) : "";
const found = Boolean(transcript && fs.existsSync(transcript));

console.log(`Reopening ${name} in ${root}`);
if (found) {
  const when = fs.statSync(transcript).mtime.toLocaleString();
  console.log(`Its conversation was last written ${when}. Remote Control will be on, so the Claude app`);
  console.log("on your phone can reach this session as soon as it starts.");
} else if (sessionId) {
  console.log(`That conversation (${sessionId.slice(0, 8)}…) is not on this computer any more.`);
  console.log("Claude will show you the conversations it does have — pick the one you want.");
} else {
  console.log("No conversation id was given, so Claude will show you the list to pick from.");
}
console.log("");

const args = ["--remote-control", name, "--resume", ...(found ? [sessionId] : [])];
const child = spawn(isWin ? "claude.cmd" : "claude", args, { stdio: "inherit", shell: isWin, cwd: root });
child.on("exit", (code) => process.exit(code ?? 0));
