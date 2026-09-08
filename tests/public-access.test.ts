import test from "node:test";
import assert from "node:assert/strict";
import { isOpen, minutesLeft, expiryFor, allowedOrigins, MAX_HOURS, type PublicAccess } from "../src/lib/public-access";

/*
 * The site can be opened to the internet on purpose. These hold the two ways that goes wrong, and
 * neither of them is somebody deciding to do it: it gets left on, and it gets forgotten.
 */

const now = new Date("2026-09-08T12:00:00.000Z");
const at = (iso: string): PublicAccess => ({ url: "https://x.trycloudflare.com", requestedAt: "2026-09-08T11:00:00.000Z", expiresAt: iso, requestedBy: "Cory Simms", reason: "building" });

test("an expiry in the future opens the door and one in the past does not", () => {
  assert.equal(isOpen(at("2026-09-08T13:00:00.000Z"), now), true);
  assert.equal(isOpen(at("2026-09-08T11:59:00.000Z"), now), false);
});

test("every uncertain answer is the closed one", () => {
  assert.equal(isOpen(null, now), false);
  assert.equal(isOpen(at("not a date"), now), false);
  assert.equal(isOpen({ ...at("2026-09-08T13:00:00.000Z"), expiresAt: undefined as unknown as string }, now), false);
});

test("the minutes remaining are what the banner promises", () => {
  assert.equal(minutesLeft(at("2026-09-08T12:45:00.000Z"), now), 45);
  assert.equal(minutesLeft(at("2026-09-08T11:00:00.000Z"), now), 0);
  assert.equal(minutesLeft(null, now), 0);
});

test("nothing may be opened for longer than the ceiling, whatever is asked for", () => {
  // "A little while" and "until I remember to turn it off" are the same input.
  assert.equal(expiryFor(24 * 14, now), new Date(now.getTime() + MAX_HOURS * 3_600_000).toISOString());
  assert.equal(expiryFor(2, now), "2026-09-08T14:00:00.000Z");
});

test("a nonsensical duration still ends, and soon", () => {
  assert.equal(expiryFor(0, now), "2026-09-08T12:15:00.000Z");
  assert.equal(expiryFor(-5, now), "2026-09-08T12:15:00.000Z");
});

/*
 * The one that would have wasted a day. Next refuses a server action whose Origin does not match
 * the host it believes it is serving, and a tunnel makes those two different things — so every
 * page renders perfectly and every button silently does nothing.
 */
test("the tunnel's host is named so server actions are not refused", () => {
  assert.deepEqual(allowedOrigins("https://brave-mint-otter.trycloudflare.com"), ["brave-mint-otter.trycloudflare.com"]);
});

test("a port is offered both with and without, because Next matches on host", () => {
  assert.deepEqual(allowedOrigins("https://example.com:8443"), ["example.com:8443", "example.com"]);
});

test("no address means nothing is allowed, rather than everything", () => {
  assert.deepEqual(allowedOrigins(null), []);
  assert.deepEqual(allowedOrigins(""), []);
  assert.deepEqual(allowedOrigins("not a url"), []);
});
