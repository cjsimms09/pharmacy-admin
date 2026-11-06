import fs from "node:fs";

/**
 * Reading a fixture, and altering one so that the alteration cannot silently miss.
 *
 * A test that breaks a fixture to prove a reader refuses it is only proving anything if the break actually happened. On
 * 15 September one did not: `tests/ipd-statement.test.ts` altered the statement with a string holding "\n" while the
 * checked-out file had CRLF, so the replacement matched nothing, the reader read a perfectly good statement, and the
 * case asserted a refusal against `r.ok ? "" : r.why` — which is the empty string when nothing went wrong. It passed
 * here and failed on session 1's checkout, on the same commit, and what it had been proving all along was nothing.
 *
 * `.gitattributes` now pins fixtures to LF so the bytes are the same everywhere (811e656). These are the other half:
 * the alteration says so when it misses, and the assertion cannot pass by looking at an empty string.
 */

/** A fixture's text, with line endings normalised so a test never depends on how git checked it out. */
export function fixture(path: string): string {
  return fs.readFileSync(path, "utf8").replace(/\r\n/g, "\n");
}

/**
 * The same text with one thing altered, refusing outright if the thing is not there.
 *
 * Use it wherever a case breaks a good document to prove it is refused. The throw is the point: a case that quietly
 * tests the unaltered document reports that a guard works when the guard was never reached, which is worse than a
 * failing test because nobody goes looking.
 */
export function mutate(text: string, from: string, to: string): string {
  const at = text.indexOf(from);
  if (at < 0) throw new Error(`the fixture does not contain "${from.slice(0, 60)}", so this case would test the unaltered document`);
  if (text.indexOf(from, at + from.length) >= 0) {
    throw new Error(`the fixture contains "${from.slice(0, 60)}" more than once, so which one this case alters is not decided`);
  }
  return text.slice(0, at) + to + text.slice(at + from.length);
}

/**
 * The part of a file between two markers, refusing if either is missing.
 *
 * The same fault in its other costume. A test that reads a source file and asserts on
 * `text.slice(text.indexOf("const isCredit ="))` is asserting on the whole tail of the file when that line has been
 * renamed — so it goes on passing while the thing it was watching no longer exists, or fails for a reason that has
 * nothing to do with what it meant. There are two dozen of these in this suite.
 */
export function section(text: string, from: string, to?: string): string {
  const start = text.indexOf(from);
  if (start < 0) throw new Error(`"${from.slice(0, 60)}" is not in this file, so this case is not looking at what it means to`);
  if (to === undefined) return text.slice(start);
  const end = text.indexOf(to, start + from.length);
  if (end < 0) throw new Error(`"${to.slice(0, 60)}" does not follow "${from.slice(0, 40)}", so this case has no section to look at`);
  return text.slice(start, end);
}

/**
 * What a reader said when it refused, or a failure when it did not refuse at all.
 *
 * `assert.match(r.ok ? "" : r.why, /…/)` is the shape that hid the fault above: where the reader was happy, the
 * assertion looks at an empty string and the case still has to be read carefully to see what went wrong. This says it.
 */
export function whyRefused(r: { ok: true } | { ok: false; why: string }): string {
  if (r.ok) throw new Error("expected this to be refused, and it was read without complaint");
  return r.why;
}
