import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { effectOf, leftBehind, willWrite, willWriteShort, isRemovable } from "../src/lib/inbox-undo";

/*
 * What a wrong load left behind.
 *
 * The screen used to say one sentence for all fourteen kinds — "it does not undo what a wrong
 * reading already changed" — which is the same as saying nothing, because the true answer is
 * completely different depending on what the file was read as. The thing these tests protect is
 * that a reassuring sentence is never attached to a kind that moved money.
 */

describe("the four answers", () => {
  test("a catalogue is repriced over by the next one, and says so", () => {
    assert.equal(effectOf("pioneer_catalog")?.reversal, "replaced");
    assert.match(leftBehind("pioneer_catalog"), /until that supplier's next catalogue/);
  });

  test("a returned goods policy stored nothing, so there is nothing to take back", () => {
    assert.equal(effectOf("return_policy")?.reversal, "nothing");
    assert.match(leftBehind("return_policy"), /never stored/);
  });

  test("the two remittances are the two the site can take back out", () => {
    assert.equal(isRemovable("remittance_835"), true);
    assert.equal(isRemovable("copay_remit"), true);
  });

  test("nothing else claims to be removable, because nothing else is", () => {
    for (const k of ["claims", "rx_transactions", "payer_payments", "rxrescue_credit", "on_hand", "nadac", "pioneer_catalog", "supplier_catalog", "rebate_report", "purchase_drilldown", "accrual_sales", "return_policy", "invoice", "supplier_statement"]) {
      assert.equal(isRemovable(k), false, `${k} must not offer an undo the site cannot perform`);
    }
  });
});

describe("the sentences that must not reassure", () => {
  test("a payer payments report says the deposits stay", () => {
    // It banks money and keys on the payer's payment number, so it never double-banks — which is
    // exactly the fact that could be mistaken for "so there is nothing to worry about".
    const s = leftBehind("payer_payments");
    assert.match(s, /stay on the cash account/);
    assert.match(s, /Money/);
  });

  test("a daily claims file admits the half that cannot be guessed back", () => {
    // Reversal rows cancel claims. Nothing can tell a claim this file wrongly cancelled from one
    // that was genuinely reversed, and an undo that quietly un-cancelled both would be worse.
    assert.match(leftBehind("rx_transactions"), /cannot tell a claim this file wrongly reversed/);
  });

  test("NADAC keeps the file itself, which is the part nobody would find", () => {
    const s = leftBehind("nadac");
    assert.match(s, /reference folder/);
    assert.match(s, /read again every time/);
  });

  test("filing an invoice withdrew the document it arrived as", () => {
    assert.match(leftBehind("invoice"), /withdrew the document this arrived as/);
  });
});

describe("what it will not claim to know", () => {
  test("never loaded is not the same as loaded and harmless", () => {
    assert.match(leftBehind(null), /nothing left over/);
    assert.match(leftBehind("unrecognised"), /nothing left over/);
  });

  test("a kind this does not know about is answered as not known, not as nothing", () => {
    /*
     * The failure that matters. A kind added to the loader and not added here must produce a
     * warning, never silence — silence reads as "nothing happened".
     */
    const s = leftBehind("some_new_feed");
    assert.match(s, /cannot say what that left behind/);
    assert.match(s, /Check before you rely on the figures/);
  });

  test("every kind a person can choose has an entry", () => {
    // The re-route form offers exactly these. One with no entry here would be re-routed with the
    // screen saying nothing about what the previous reading left.
    const OFFERED = [
      "rx_transactions", "claims", "on_hand", "pioneer_catalog", "supplier_catalog", "nadac",
      "rebate_report", "purchase_drilldown", "return_policy", "remittance_835", "copay_remit",
      "rxrescue_credit", "payer_payments", "accrual_sales",
    ];
    for (const k of OFFERED) {
      assert.ok(effectOf(k), `${k} is offered on the Inbox and has no entry in inbox-undo`);
      assert.ok(willWrite(k), `${k} must be able to say what choosing it will write`);
      const short = willWriteShort(k)!;
      assert.ok(short, `${k} needs a short form for the picker`);
      // It sits after a label in one line of a select. A clause there is a clause nobody reads.
      assert.ok(short.length <= 30, `${k}: "${short}" is too long for a picker line`);
    }
  });
});
