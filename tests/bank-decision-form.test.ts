import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { decisionFromForm } from "../src/lib/bank-decision-form";

/*
 * The owner, 2 October 2026: "easy way to reconcile bank statements (tell site things it cant match)". The reading of
 * the form on a bank line, pinned: every blank is a refusal with a reason, a cheque is a cost said as a cheque, money
 * in cannot be a cost, and the register run needs its two days.
 */
describe("naming a bank line from the row", () => {
  const said = "The owner, on the bank page, 2026-10-02.";

  test("a cheque becomes a cost under a category, to a payee, said as a cheque", () => {
    const r = decisionFromForm({ what: "cheque", category: "Professional fees", vendor: "The accountant" }, -5_800_00, said);
    assert.ok(r.ok);
    assert.deepEqual(r.decision, { kind: "books_bill", category: "Professional fees", vendor: "The accountant", note: `A cheque to The accountant. ${said}` });
  });

  test("blanks refuse with a reason, never default", () => {
    assert.deepEqual(decisionFromForm({}, -100, said), { ok: false, why: "Say what the line was for." });
    assert.deepEqual(decisionFromForm({ what: "cost", vendor: "X" }, -100, said), { ok: false, why: "Pick the category it goes under." });
    assert.deepEqual(decisionFromForm({ what: "cost", category: "Other" }, -100, said), { ok: false, why: "Say who was paid." });
    assert.deepEqual(decisionFromForm({ what: "standing" }, -100, said), { ok: false, why: "Pick which standing cost it is." });
    assert.deepEqual(decisionFromForm({ what: "deposit", receiptKind: "patient" }, 100, said), { ok: false, why: "Name the payer." });
    assert.deepEqual(decisionFromForm({ what: "deposit", payer: "Drexi" }, 100, said), { ok: false, why: "Say whether it is a plan, a patient, or something else." });
    assert.deepEqual(decisionFromForm({ what: "register_run", from: "2026-09-10", to: "2026-09-08" }, 100, said), { ok: false, why: "The last day is before the first." });
    assert.deepEqual(decisionFromForm({ what: "noted" }, -100, said), { ok: false, why: "Say what it is, as a category, so the cash account can place it." });
  });

  test("money in cannot be a cost; a deposit names its payer and kind; a register run names its days", () => {
    assert.deepEqual(decisionFromForm({ what: "cost", category: "Other", vendor: "X" }, 100, said), { ok: false, why: "Money in cannot be a cost." });
    const d = decisionFromForm({ what: "deposit", payer: "Drexi", receiptKind: "third_party", note: "their first payment" }, 2_400_00, said);
    assert.deepEqual(d, { ok: true, decision: { kind: "deposit", payer: "Drexi", receiptKind: "third_party", note: "their first payment" } });
    const run = decisionFromForm({ what: "register_run", from: "2026-09-08", to: "2026-09-10" }, 1_604_82, said);
    assert.deepEqual(run, { ok: true, decision: { kind: "confirms_run", from: "2026-09-08", to: "2026-09-10", note: said } });
  });

  test("before the books, and noted under a category, on either side", () => {
    assert.deepEqual(decisionFromForm({ what: "before_books" }, -1_278_00, said), { ok: true, decision: { kind: "before_books", note: said } });
    assert.deepEqual(decisionFromForm({ what: "noted", category: "Drug purchases (OTC)", note: "invoice to come" }, -842_88, said), { ok: true, decision: { kind: "noted", category: "Drug purchases (OTC)", note: "invoice to come" } });
  });
});
