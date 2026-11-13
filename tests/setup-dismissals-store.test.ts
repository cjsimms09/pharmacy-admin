import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";

/*
 * Whether an answer survives the list being rebuilt.
 *
 * The setup items do not live anywhere: they are computed from the data every time the page opens,
 * so "this does not apply to us" has to be keyed to the item rather than to a row, or it would be
 * forgotten by the next import — which is the one thing the owner asked for by name.
 */
let dismiss: typeof import("../src/lib/setup-dismissals").dismiss;
let restore: typeof import("../src/lib/setup-dismissals").restore;
let dismissals: typeof import("../src/lib/setup-dismissals").dismissals;
let cleanUpDb: (() => void) | null = null;

const owner = { id: "u-owner", name: "Owner" };

before(async () => {
  const { useScratchDb } = await import("./support/scratch-db");
  cleanUpDb = await useScratchDb();
  ({ dismiss, restore, dismissals } = await import("../src/lib/setup-dismissals"));
});

after(() => cleanUpDb?.());

describe("setting items aside", () => {
  test("a whole list goes in one press, which is the shape of the complaint", async () => {
    const keys = ["minimum-Xymogen", "ladder-Xymogen", "feed-xymogen-price"];
    const { set } = await dismiss(keys, "we do not buy from them", owner);
    assert.equal(set, 3);

    const held = await dismissals();
    assert.deepEqual([...held.keys()].sort(), keys.slice().sort());
    assert.equal(held.get("ladder-Xymogen")?.reason, "we do not buy from them");
    assert.equal(held.get("ladder-Xymogen")?.by, "Owner");
  });

  test("REGRESSION: it is keyed by the item, so rebuilding the list from the data does not forget it", async () => {
    /*
     * The items are recomputed on every page load. Reading them back by the same key after nothing
     * has been stored about the items themselves is the whole claim.
     */
    const again = await dismissals();
    assert.ok(again.has("minimum-Xymogen"), "still set aside after the list is built afresh");
  });

  test("saying it twice changes the reason rather than failing", async () => {
    await dismiss(["ladder-Xymogen"], "they are a manufacturer, there is no ladder", owner);
    const held = await dismissals();
    assert.equal(held.size, 3, "no duplicate row");
    assert.equal(held.get("ladder-Xymogen")?.reason, "they are a manufacturer, there is no ladder");
  });

  test("a reason is optional, and its absence is empty rather than the word null", async () => {
    await dismiss(["ks-fee"], "", owner);
    assert.equal((await dismissals()).get("ks-fee")?.reason, "");
  });

  test("nothing ticked changes nothing", async () => {
    const before = (await dismissals()).size;
    assert.deepEqual(await dismiss([], "", owner), { set: 0 });
    assert.deepEqual(await dismiss(["   "], "", owner), { set: 0 });
    assert.equal((await dismissals()).size, before);
  });
});

describe("putting them back", () => {
  test("one comes back on its own", async () => {
    const { restored } = await restore(["ks-fee"], owner);
    assert.equal(restored, 1);
    assert.equal((await dismissals()).has("ks-fee"), false);
  });

  test("and all of them come back together, because a bulk decision needs a bulk undo", async () => {
    const keys = [...(await dismissals()).keys()];
    await restore(keys, owner);
    assert.equal((await dismissals()).size, 0);
  });
});
