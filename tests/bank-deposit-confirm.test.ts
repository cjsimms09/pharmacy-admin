import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { gateDeposit, matchHeldDeposit, type HeldForBank } from "../src/lib/deposit-gate";

/**
 * A bank statement deposit, and the receipt already banked for the same money.
 *
 * `readBankStatement` banked every deposit line as a new cash receipt with no source key, and the
 * deposit gate banks anything without a source key outright. So the first statement read would have
 * banked a second time every deposit the payer payment report and the Health Mart Atlas EFT notice
 * had already banked — $250,562.16 of September's third-party receipts on 15 September, the day it was
 * found, before any statement had been read.
 *
 * The owner, the same afternoon: "be sure we can handle these properly, are getting everything we
 * need to reconcile payments once we have bank account statement".
 */
const hma = (over: Partial<HeldForBank> = {}): HeldForBank => ({
  id: "r1",
  amountCents: 2_009_128,
  receivedOn: "2026-09-14",
  payer: "Health Mart Atlas",
  reference: "EFT-99000001",
  ...over,
});

describe("a statement line confirms the deposit already banked", () => {
  test("REGRESSION: the same amount within the window confirms the receipt and banks nothing new", () => {
    const m = matchHeldDeposit([hma()], { amountCents: 2_009_128, on: "2026-09-15", payer: "Health Mart Atlas" }, new Set());
    assert.equal(m.kind, "confirms");
    assert.equal(m.kind === "confirms" && m.receipt.id, "r1");
    assert.match(m.kind === "confirms" ? m.why : "", /Nothing new is banked/);
  });

  test("it does not need the bank's words to agree with the receipt's payer", () => {
    /*
     * ProviderPay money is sent by McKesson. The bank line may say MCKESSON, and McKesson is on the
     * supplier register, so the line may have been placed as a rebate. Requiring the names to agree
     * would miss the confirmation and bank the deposit twice.
     */
    for (const payer of ["MCKESSON CORP", "PROVIDERPAY", null]) {
      assert.equal(matchHeldDeposit([hma()], { amountCents: 2_009_128, on: "2026-09-16", payer }, new Set()).kind, "confirms", `payer ${payer}`);
    }
  });

  test("the four days between paid and deposited on Health Mart Atlas money are inside the window", () => {
    // EFT-31434994: paid 2026-09-04, deposited 2026-09-08.
    assert.equal(matchHeldDeposit([hma({ receivedOn: "2026-09-04" })], { amountCents: 2_009_128, on: "2026-09-08", payer: null }, new Set()).kind, "confirms");
  });
});

describe("what it does not confirm", () => {
  test("a different amount, even by a cent, is a different deposit", () => {
    assert.equal(matchHeldDeposit([hma()], { amountCents: 2_009_127, on: "2026-09-15", payer: null }, new Set()).kind, "none");
  });

  test("outside the window is a different deposit", () => {
    assert.equal(matchHeldDeposit([hma()], { amountCents: 2_009_128, on: "2026-09-30", payer: null }, new Set()).kind, "none");
  });

  test("two deposits of the same amount on the statement confirm one receipt, and the second is banked", () => {
    /*
     * The gate's own principle: the bank is the record, and two deposits on the statement means there
     * were two. One-to-one, so the second finds the receipt already claimed.
     */
    const claimed = new Set<string>();
    const first = matchHeldDeposit([hma()], { amountCents: 2_009_128, on: "2026-09-15", payer: null }, claimed);
    assert.equal(first.kind, "confirms");
    if (first.kind === "confirms") claimed.add(first.receipt.id);
    assert.equal(matchHeldDeposit([hma()], { amountCents: 2_009_128, on: "2026-09-15", payer: null }, claimed).kind, "none");
  });

  test("two receipts it cannot tell apart are left for a person, not guessed", () => {
    const held = [hma({ id: "a", payer: "DOMANIRX" }), hma({ id: "b", payer: "ARGUS HEALTH SYS" })];
    const m = matchHeldDeposit(held, { amountCents: 2_009_128, on: "2026-09-15", payer: null }, new Set());
    assert.equal(m.kind, "ambiguous");
    assert.match(m.kind === "ambiguous" ? m.why : "", /needs a person/);
  });

  test("and where the bank line names one of them, that one is confirmed", () => {
    const held = [hma({ id: "a", payer: "DOMANIRX" }), hma({ id: "b", payer: "ARGUS HEALTH SYS" })];
    const m = matchHeldDeposit(held, { amountCents: 2_009_128, on: "2026-09-15", payer: "Argus Health Systems" }, new Set());
    assert.equal(m.kind === "confirms" && m.receipt.id, "b");
  });
});

describe("the statement reader asks before it banks", () => {
  test("REGRESSION: bank.ts matches a credit against receipts on file before calling addCashReceipt", async () => {
    const text = await readFile("src/app/(app)/money/bank.ts", "utf8");
    const loop = text.slice(text.indexOf("for (const { line, placement } of placed)"));
    const match = loop.indexOf("matchHeldDeposit(");
    const add = loop.indexOf("addCashReceipt(");
    assert.ok(match > 0 && add > 0 && match < add, "a deposit line must be matched to the receipts on file before a new receipt is banked");
    assert.match(loop, /placedAs = "confirms_deposit"/);
  });

  test("a receipt an earlier statement already confirmed is not offered again", async () => {
    const text = await readFile("src/app/(app)/money/bank.ts", "utf8");
    assert.match(text, /confirmedAlready/);
  });
});

describe("money the statement banked first, and the feed that arrives after it", () => {
  test("REGRESSION: bank.ts gives a deposit it banks the statement's date", async () => {
    /*
     * Session 2, money map checkpoint 1, case C, proven on a snapshot: a deposit banked from the statement
     * with no date is invisible to the gate's window, so a card batch forwarded afterwards banked again.
     */
    const text = await readFile("src/app/(app)/money/bank.ts", "utf8");
    const call = text.slice(text.indexOf("receiptId = (await addCashReceipt("), text.indexOf("receiptId = (await addCashReceipt(") + 400);
    assert.match(call, /receivedOn: line\.on/);
  });

  test("a card batch forwarded after the statement banked its deposit is refused, not banked twice", () => {
    const fromStatement = { amountCents: 422_927, receivedOn: "2026-09-09", payer: null, sourceKey: null, reference: null, month: "2026-09", createdBy: "u" };
    const v = gateDeposit([fromStatement], { amountCents: 422_927, receivedOn: "2026-09-08", payer: "Card batch", sourceKey: "card-batch|780961413", reference: "780961413" });
    assert.equal(v.bank, false);
  });

  test("REGRESSION: two batches paid in as one deposit are named for a person, not banked as new money", () => {
    /* Case D. */
    const held: HeldForBank[] = [
      { id: "a", amountCents: 221_744, receivedOn: "2026-09-05", payer: "Card batch", reference: "1" },
      { id: "b", amountCents: 50_000, receivedOn: "2026-09-06", payer: "Card batch", reference: "2" },
      { id: "c", amountCents: 461_473, receivedOn: "2026-09-04", payer: "Card batch", reference: "3" },
    ];
    const m = matchHeldDeposit(held, { amountCents: 271_744, on: "2026-09-07", payer: null }, new Set());
    assert.equal(m.kind, "ambiguous");
    assert.deepEqual(m.kind === "ambiguous" ? m.candidates.map((c) => c.id) : [], ["a", "b"]);
    assert.match(m.kind === "ambiguous" ? m.why : "", /Nothing is banked/);
  });

  test("a deposit no combination explains is still new money", () => {
    const held: HeldForBank[] = [{ id: "a", amountCents: 100, receivedOn: "2026-09-05", payer: null }];
    assert.equal(matchHeldDeposit(held, { amountCents: 250, on: "2026-09-06", payer: null }, new Set()).kind, "none");
  });
});
