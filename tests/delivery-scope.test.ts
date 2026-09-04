import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { parseSkipped } from "../src/lib/deliveries";

/**
 * Months this site was never asked to cover.
 *
 * The pharmacy was running before the delivery screen existed, and August was invoiced the old
 * way. The site then found twenty-one weekdays with no answer and reported them every day — the
 * alert doing exactly what it was told, against a month nobody intended it to cover.
 *
 * A system that demands you back-fill its own history before it will stop complaining is a system
 * people turn off, and then it is not there for the month that does matter.
 */
describe("months handled outside the site", () => {
  test("reads a month and the reason given for it", () => {
    const r = parseSkipped("2026-08 = Invoiced the old way before we started here.");
    assert.equal(r.length, 1);
    assert.equal(r[0].month, "2026-08");
    assert.match(r[0].reason, /old way/);
  });

  test("a month with no reason still gets one, because a bare skip explains nothing later", () => {
    assert.match(parseSkipped("2026-08")[0].reason, /outside this site/i);
    assert.match(parseSkipped("2026-08 =")[0].reason, /outside this site/i);
  });

  test("several months, and comments, and blank lines", () => {
    const r = parseSkipped("# before we started\n2026-07 = old way\n\n2026-08 = old way\n");
    assert.deepEqual(r.map((x) => x.month), ["2026-07", "2026-08"]);
  });

  test("anything that is not a month is ignored rather than half-read", () => {
    assert.deepEqual(parseSkipped("August = old way\n2026-13 = nonsense\nnot a line"), []);
  });

  test("nothing configured is not an error", () => {
    assert.deepEqual(parseSkipped(""), []);
  });
});
