import test from "node:test";
import assert from "node:assert/strict";
import { loginAllowed, ALLOWED, WINDOW_MINUTES } from "../src/lib/login-throttle";

/*
 * A password is only as good as the number of guesses an attacker gets. The site allowed
 * unlimited ones, which is survivable on a pharmacy LAN and is the whole security of the thing
 * the moment it is reachable from anywhere else.
 */

const now = new Date("2026-09-08T12:00:00.000Z");
const minutesAgo = (m: number) => new Date(now.getTime() - m * 60_000).toISOString();
const fails = (...m: number[]) => m.map((x) => ({ at: minutesAgo(x), ok: false }));

test("a clean account is let in", () => {
  assert.equal(loginAllowed([], now).allowed, true);
});

test("wrong passwords up to the limit still get a try", () => {
  assert.equal(loginAllowed(fails(1, 2, 3, 4), now).allowed, true);
});

test("the sixth wrong password closes the door, and says for how long", () => {
  const v = loginAllowed(fails(1, 2, 3, 4, 5), now);
  assert.equal(v.allowed, false);
  if (v.allowed) return;
  // The oldest failure still counting was five minutes ago, so ten minutes of the window remain.
  assert.equal(v.waitMinutes, 10);
  assert.match(v.says, /Too many wrong passwords/);
  assert.match(v.says, /audit log/, "and it points at where to see who was trying");
});

test("failures older than the window stop counting", () => {
  assert.equal(loginAllowed(fails(20, 21, 22, 23, 24), now).allowed, true);
});

test("getting in clears what came before it", () => {
  // Four fat-fingered attempts, then a success, then one more slip. Not one attempt from a lockout.
  const attempts = [...fails(9, 8, 7, 6), { at: minutesAgo(5), ok: true }, ...fails(1)];
  assert.equal(loginAllowed(attempts, now).allowed, true);
});

test("a success does not clear failures that came after it", () => {
  const attempts = [{ at: minutesAgo(10), ok: true }, ...fails(5, 4, 3, 2, 1)];
  assert.equal(loginAllowed(attempts, now).allowed, false);
});

test("the door reopens as the oldest failure ages out, not all at once", () => {
  // Five failures spread across the window: the wait is measured to the oldest one still counting.
  const v = loginAllowed(fails(14, 10, 8, 3, 1), now);
  assert.equal(v.allowed, false);
  if (v.allowed) return;
  assert.equal(v.waitMinutes, 1);
});

test("attempts stamped in the future do not count for or against", () => {
  const ahead = new Date(now.getTime() + 60 * 60_000).toISOString();
  const attempts = [...fails(1, 2, 3, 4), { at: ahead, ok: false }];
  assert.equal(loginAllowed(attempts, now).allowed, true, "a clock skew must not lock anybody out");
  const cleared = [...fails(1, 2, 3, 4, 5), { at: ahead, ok: true }];
  assert.equal(loginAllowed(cleared, now).allowed, false, "nor unlock them");
});

test("the limit and the window are the ones the site advertises", () => {
  assert.equal(ALLOWED, 5);
  assert.equal(WINDOW_MINUTES, 15);
});
