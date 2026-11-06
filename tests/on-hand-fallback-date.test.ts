import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { useScratchDb } from "./support/scratch-db";

/*
 * A balance-on-hand report the file does not date.
 *
 * The intake page refused one and left it "waiting for you to check" from 8 September to 6 November 2026, with nothing to press that
 * could clear it. A date the file carries, or one he typed, always wins; with neither, the day a person dropped it is used, and the
 * result says it was assumed. This needs a database, so it has one of its own: filing a count prunes the older ones, and run against
 * the live database it deleted five real daily counts on 6 November 2026 (restored from the stored files).
 */
let cleanup: () => void;
before(async () => {
  cleanup = await useScratchDb();
});
after(() => cleanup?.());

const TEXT = ["Inventory On Hand", "NDC\tDescription\tQuantity On Hand", "0093-1056-01\tInvented drug 10 mg tab\t100"].join("\n");

describe("an undated balance-on-hand report", () => {
  test("with nothing to date it by, it is still refused", async () => {
    const { fileOnHand } = await import("../src/lib/shelf");
    const r = await fileOnHand(Buffer.from(TEXT), "undated.txt", { userId: "test" });
    assert.equal(r.ok, false);
  });

  test("with a fallback day it is filed as of that day and says the date was assumed", async () => {
    const { fileOnHand } = await import("../src/lib/shelf");
    const r = await fileOnHand(Buffer.from(TEXT), "undated.txt", { userId: "test" }, { fallbackCountedOn: "2026-12-30" });
    assert.ok(r.ok, JSON.stringify(r));
    if (r.ok) {
      assert.equal(r.countedOn, "2026-12-30");
      assert.equal(r.dateAssumed, true);
    }
  });

  test("a typed date wins over the fallback and is not called assumed", async () => {
    const { fileOnHand } = await import("../src/lib/shelf");
    const r = await fileOnHand(Buffer.from(TEXT), "undated.txt", { userId: "test" }, { countedOn: "2026-12-29", fallbackCountedOn: "2026-12-30" });
    assert.ok(r.ok);
    if (r.ok) {
      assert.equal(r.countedOn, "2026-12-29");
      assert.equal(r.dateAssumed, false);
    }
  });
});
