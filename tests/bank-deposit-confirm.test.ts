import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { section } from "./support/fixtures";
import { readFile } from "node:fs/promises";
import { gateDeposit, matchHeldDeposit, type HeldForBank } from "../src/lib/deposit-gate";
import { placeLine } from "../src/lib/bank-statement";

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
    assert.match(m.kind === "ambiguous" ? m.why : "", /nothing needs banking, and banking it with the form would count it twice/);
  });

  test("a deposit no combination explains is still new money", () => {
    const held: HeldForBank[] = [{ id: "a", amountCents: 100, receivedOn: "2026-09-05", payer: null }];
    assert.equal(matchHeldDeposit(held, { amountCents: 250, on: "2026-09-06", payer: null }, new Set()).kind, "none");
  });
});

describe("card takings have one door: the card batch report", () => {
  const ctx = { payers: [], suppliers: [], vendors: [], unpaidBills: [], unpaidInvoices: [] };
  test("REGRESSION: every scanned Heartland spelling on a credit is a card deposit, not retail money to bank", () => {
    /* Session 2, money map G-CARD-8: "HRTLAND PMT SYST TXNS" missed the RETAIL rule and was left for a person to bank by hand. */
    for (const d of ["HEARTLAND PAYMENT SYS", "HRTLAND PMT SYST TXNS", "HRTI-AND PMT SYS/TXNS"]) {
      assert.equal(placeLine({ on: "2026-09-09", description: d, amountCents: 422_927, key: d }, ctx).kind, "card_deposit", d);
    }
  });

  test("REGRESSION: bank.ts never banks a card deposit", async () => {
    const text = await readFile("src/app/(app)/money/bank.ts", "utf8");
    const branch = section(text, `placement.kind === "card_deposit") {`, `placement.kind === "deposit") {`);
    assert.doesNotMatch(branch, /addCashReceipt/);
  });

  test("REGRESSION: a batch forwarded after the same deposit was typed by hand is refused", () => {
    /* G-CARD-8, H2. The typed receipt has only a month. */
    const typed = { amountCents: 422_927, receivedOn: null, payer: "Heartland", sourceKey: null, month: "2026-09" };
    const v = gateDeposit([typed], { amountCents: 422_927, month: "2026-09", receivedOn: "2026-09-08", payer: "Card batch", sourceKey: "card-batch|780961413", reference: "780961413" });
    assert.equal(v.bank, false);
    assert.match(v.bank ? "" : v.why, /typed in by hand/);
  });

  test("REGRESSION: the form asks before typing money a feed already banked", async () => {
    /* G-CARD-8, H1. */
    const text = await readFile("src/app/(app)/money/page.tsx", "utf8");
    const action = section(text, "async function bankIt", "async function unbank");
    assert.ok(action.indexOf("automaticReceiptsLike(") > 0 && action.indexOf("automaticReceiptsLike(") < action.indexOf("addCashReceipt("));
    assert.doesNotMatch(text, /A deposit here is banked with the form above/);
  });
});

describe("the edges Session 2 found after the card fix (G-CARD-9, -10, -11)", () => {
  test("REGRESSION: a batch closed on 30 September is refused beside the same deposit typed under October", () => {
    const typed = { amountCents: 53_535, receivedOn: null, payer: "Heartland", sourceKey: null, month: "2026-10" };
    const v = gateDeposit([typed], { amountCents: 53_535, month: "2026-09", receivedOn: "2026-09-30", payer: "Card batch", sourceKey: "card-batch|1", reference: "1" });
    assert.equal(v.bank, false);
  });

  test("two batches together are found for the form's check, and one explanation is told from several", async () => {
    const { receiptsSummingTo } = await import("../src/lib/deposit-gate");
    assert.deepEqual(receiptsSummingTo([{ amountCents: 7_007 }, { amountCents: 8_008 }, { amountCents: 999 }], 15_015).map((c) => c.map((r) => r.amountCents)), [[7_007, 8_008]]);
    assert.equal(receiptsSummingTo([{ amountCents: 100 }, { amountCents: 200 }], 250).length, 0);
  });

  test("REGRESSION: a card deposit is offered only card batch receipts", async () => {
    const text = await readFile("src/app/(app)/money/bank.ts", "utf8");
    assert.match(text, /placement\.kind === "card_deposit" \? heldForBank\.filter\(\(h\) => h\.sourceKey\?\.startsWith\("card-batch\|"\)\)/);
  });
});

describe("two payments of the same amount from the same payer", () => {
  test("REGRESSION: the same feed's differently numbered payments both bank (DomaniRx, August, G-PP-1)", () => {
    const first = { amountCents: 90_400, receivedOn: "2026-08-26", payer: "DOMANIRX", sourceKey: "payer-payment|domanirx|1234538", reference: "1234538" };
    const v = gateDeposit([first], { amountCents: 90_400, receivedOn: "2026-08-28", payer: "DOMANIRX", sourceKey: "payer-payment|domanirx|9872227", reference: "9872227" });
    assert.equal(v.bank, true);
  });

  test("REGRESSION: an 835 whose payer name differs from the report's is refused at the same amount (G-835-1)", () => {
    const report = { amountCents: 549_012, receivedOn: "2026-08-26", payer: "ARGUS HEALTH SYS", sourceKey: "payer-payment|argus health sys|4401122", reference: "4401122" };
    const v = gateDeposit([report], { amountCents: 549_012, receivedOn: "2026-08-25", payer: "ProviderPay", sourceKey: "835|providerpay|1TRACE889900|2026-08-25", reference: "1TRACE889900" });
    assert.equal(v.bank, false);
  });

  test("REGRESSION: a ProviderPay remittance posts its claims and banks nothing (G-835-1)", async () => {
    const text = await readFile("src/lib/claim-payments.ts", "utf8");
    assert.ok(text.includes("const throughProviderPay = "));
    assert.ok(text.includes("if (opts.bank && !throughProviderPay &&"));
  });

  test("across feeds, one deposit under two numbers is still refused", () => {
    const fromPortal = { amountCents: 90_400, receivedOn: "2026-08-26", payer: "DOMANIRX", sourceKey: "payer-payment|domanirx|1234538", reference: "1234538" };
    const v = gateDeposit([fromPortal], { amountCents: 90_400, receivedOn: "2026-08-25", payer: "DOMANIRX", sourceKey: "835|domanirx|555000111|20260825", reference: "555000111" });
    assert.equal(v.bank, false);
  });
});

describe("the wholesaler's ACH and the facilitator's unexplained credit (G-MCK-1, G-MTF-2)", () => {
  test("REGRESSION: the statement reader gives the matcher the wholesaler's ledger, and marks an agreeing ACH's invoices paid", async () => {
    const text = await readFile("src/app/(app)/money/bank.ts", "utf8");
    assert.ok(text.includes("settled: statementLines,"));
    assert.ok(text.includes(`placement.kind === "settles_ach" && placement.agrees`));
  });

  test("REGRESSION: a facilitator credit nothing explains is not offered to the receipt match", async () => {
    const text = await readFile("src/app/(app)/money/bank.ts", "utf8");
    const isCredit = text.slice(text.indexOf("const isCredit ="), text.indexOf("\n", text.indexOf("const isCredit =")));
    assert.ok(isCredit.length > 0);
    assert.ok(!isCredit.includes("facilitator_unmatched"));
    assert.ok(isCredit.includes(`placement.kind === "unplaced"`));
  });
});

test("REGRESSION: a remittance's second identical claim line posts on the first read (G-835-3)", async () => {
  /* Paid, taken back and paid again for the same amount inside one EFT: $15,001.38 across nine real reports was skipped. */
  const text = await readFile("src/lib/claim-payments.ts", "utf8");
  assert.ok(text.includes("const heldCount = new Map<string, number>();"));
  assert.ok(!text.includes("seen.add(`${reference}|${p.rxNumber}|${p.paidCents}`)"));
});

test("REGRESSION: a re-scanned statement whose descriptions read differently places nothing twice (G-POST-2)", async () => {
  /* The line key carries the scan's text; a line is also on file when its date and amount are, counted line for line. */
  const text = await readFile("src/app/(app)/money/bank.ts", "utf8");
  const block = text.slice(text.indexOf("const heldKeys"), text.indexOf("const placed = placeLines(fresh"));
  assert.ok(block.includes("onFile"));
  assert.ok(block.indexOf("fresh.push(l)") > block.indexOf("(onFile.get(k) ?? 0) > 0"));
});

test("REGRESSION: two identical lines in one statement get their own keys (G-BANK-4)", async () => {
  const text = await readFile("src/app/(app)/money/bank.ts", "utf8");
  assert.ok(text.includes("key: `${l.key}#${n}`"));
  assert.ok(text.indexOf("seenKeys") < text.indexOf("const heldKeys"));
});
