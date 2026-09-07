import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { countAge } from "../src/lib/count-age";

describe("how old the daily count is", () => {
  test("this morning's count needs nothing said about it", () => {
    const a = countAge("2026-09-07", "2026-09-07");
    assert.equal(a.days, 0);
    assert.equal(a.state, "today");
    assert.equal(a.warns, null);
  });

  test("yesterday's is normal — the report runs overnight and is read in the morning", () => {
    const a = countAge("2026-09-06", "2026-09-07");
    assert.equal(a.state, "yesterday");
    assert.equal(a.warns, null);
  });

  test("two days is where the figures stop being the shelf", () => {
    const a = countAge("2026-09-05", "2026-09-07");
    assert.equal(a.days, 2);
    assert.equal(a.state, "stale");
    assert.match(a.says, /counted 2 days ago/);
    assert.match(a.warns ?? "", /2 days of dispensing/);
    assert.match(a.warns ?? "", /Upload today's count/);
  });

  test("a long gap says how long, because a fortnight is not the same as two days", () => {
    assert.match(countAge("2026-08-24", "2026-09-07").says, /counted 14 days ago/);
  });

  test("a count dated ahead of today is read as today's, not as negative days", () => {
    // The report runs on the pharmacy's clock; a machine an hour behind is not a fact worth showing.
    const a = countAge("2026-09-08", "2026-09-07");
    assert.equal(a.days, 0);
    assert.equal(a.state, "today");
  });
});
