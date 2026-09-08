import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { recognise, ruleFromCorrection, stableStem, CATEGORIES, categoryFor } from "../src/lib/intake-recognise";
import {
  isUnknownSenderInvoice,
  unknownSenderInvoiceReason,
  printedNameInReason,
  printedSupplierSuggestion,
} from "../src/lib/autoroute";

/*
 * What these protect.
 *
 * The inbox is the one place where a wrong answer is written into the tables everything else reads,
 * unattended, with nobody watching. So the tests here are not about getting the right answer often;
 * they are about never acting on a wrong one. Every test below is a way the recogniser could file a
 * document somewhere wrong and say nothing about it.
 */

describe("nothing is filed on a guess", () => {
  test("a document nothing recognises is never filed, and says so", () => {
    const r = recognise({
      fromAddress: "someone@example.com",
      subject: "FW: see attached",
      fileName: "scan0021.pdf",
      content: { verdict: "unrecognised", why: "A PDF this does not recognise." },
    });
    assert.equal(r.best, null);
    assert.equal(r.mayFile, false);
    assert.equal(r.needsOwner, true);
    assert.match(r.says, /does not look like anything/i);
  });

  test("a file name and a subject line together are never enough to file on", () => {
    const r = recognise({
      fromAddress: "billing@somewholesaler.com",
      fromName: "Some Wholesaler Invoicing",
      subject: "Your invoice is ready",
      fileName: "invoice-2026-09-08.pdf",
      content: null,
    });
    assert.equal(r.best?.category, "supplier_invoice");
    assert.notEqual(r.best?.sure, "certain");
    assert.equal(r.mayFile, false);
    assert.match(r.says, /Not sure enough to file/i);
  });

  test("history alone, however long, never files either", () => {
    const r = recognise({
      fromAddress: "reports@supplier.test",
      fileName: "weekly",
      history: [{ category: "supplier_catalog", count: 40 }],
    });
    assert.equal(r.best?.category, "supplier_catalog");
    assert.equal(r.best?.sure, "likely");
    assert.equal(r.mayFile, false);
  });

  test("a sender the site has seen twice is a coincidence, not a pattern", () => {
    const r = recognise({ fromAddress: "reports@supplier.test", history: [{ category: "supplier_catalog", count: 2 }] });
    assert.equal(r.best, null);
    assert.equal(r.mayFile, false);
  });
});

describe("specificity decides", () => {
  test("a broad sender rule does not turn a supplier's catalogue into an invoice", () => {
    const r = recognise({
      fromAddress: "reports@mckesson.com",
      subject: "Supplier Catalog Item Search Results",
      fileName: "McKesson 2026-09-07",
      content: { verdict: "pioneer_catalog", why: "Begins with PioneerRx's Supplier Catalog header." },
      rules: [{ address: "mckesson.com", category: "supplier_invoice" }],
    });
    assert.equal(r.best?.category, "supplier_catalog");
    assert.equal(r.best?.sure, "certain");
    assert.equal(r.mayFile, true);
  });

  test("a rule naming a file-name fragment beats what the columns said, and says that it did", () => {
    const r = recognise({
      fromAddress: "reports@mckesson.com",
      fileName: "mckesson credits 2026-09-07.csv",
      content: { verdict: "supplier_catalog", why: "Carries an NDC and a cost with no prescription number." },
      rules: [{ address: "mckesson.com", category: "credit_memo", fileName: "credits" }],
    });
    assert.equal(r.best?.category, "credit_memo");
    assert.equal(r.best?.sure, "certain");
    assert.match(r.best?.why[0] ?? "", /named like .credits./);
  });

  test("a rule whose fragment is absent does not fire at all", () => {
    const r = recognise({
      fromAddress: "reports@mckesson.com",
      fileName: "mckesson catalog 2026-09-07.csv",
      rules: [{ address: "mckesson.com", category: "credit_memo", fileName: "credits" }],
    });
    assert.notEqual(r.best?.category, "credit_memo");
  });

  test("a rule for a different sender never fires", () => {
    const r = recognise({
      fromAddress: "reports@parmed.test",
      fileName: "prices.csv",
      rules: [{ address: "mckesson.com", category: "supplier_catalog" }],
    });
    assert.equal(r.best, null);
  });

  test("a broad rule does file when the file's own contents say nothing", () => {
    const r = recognise({
      fromAddress: "data@nadac.test",
      fileName: "weekly.zip",
      content: null,
      rules: [{ address: "data@nadac.test", category: "nadac" }],
    });
    assert.equal(r.best?.category, "nadac");
    assert.equal(r.best?.sure, "likely");
    assert.equal(r.mayFile, false);
  });
});

describe("a split verdict is not a verdict", () => {
  test("two rules of equal standing pointing different ways file nothing", () => {
    const r = recognise({
      fromAddress: "ap@vendor.test",
      subject: "September statement",
      fileName: "vendor september.pdf",
      rules: [
        { address: "vendor.test", category: "supplier_statement", subject: "statement" },
        { address: "ap@vendor.test", category: "expense_invoice", fileName: "vendor" },
      ],
    });
    assert.equal(r.mayFile, false);
    assert.equal(r.needsOwner, true);
    assert.match(r.says, /either .* or .*evidence is split/i);
    assert.equal(r.ranked.length >= 2, true);
  });

  test("but a taught rule outranking the columns is the correction working, not a tie", () => {
    const r = recognise({
      fromAddress: "ap@vendor.test",
      subject: "September statement",
      fileName: "vendor statement sept.pdf",
      content: { verdict: "claims", why: "Carries Rx Number, Date Filled and BIN." },
      rules: [{ address: "ap@vendor.test", category: "supplier_statement", subject: "statement" }],
    });
    assert.equal(r.best?.category, "supplier_statement");
    assert.equal(r.mayFile, true);
  });
});

describe("what it says, it says in words", () => {
  test("a certain answer names the category, the evidence and what happens next", () => {
    const r = recognise({
      fromAddress: "reports@cms.test",
      fileName: "nadac-2026-09.csv",
      content: { verdict: "nadac", why: "Carries a NADAC Per Unit column alongside NDC and Effective Date." },
    });
    assert.equal(r.mayFile, true);
    assert.match(r.says, /NADAC Per Unit/);
    assert.match(r.says, /floor every Kansas commercial claim/);
  });

  test("every guess carries at least one reason", () => {
    const r = recognise({
      fromAddress: "x@y.test",
      subject: "your rebate breakdown",
      fileName: "rebate.pdf",
    });
    for (const g of r.ranked) assert.equal(g.why.length >= 1, true, `${g.category} had no reason`);
  });
});

describe("the correction becomes a rule", () => {
  test("when nothing in the file disagreed, the rule is the whole sender", () => {
    const rule = ruleFromCorrection({ fromAddress: "Data@Nadac.Test", category: "nadac", fileName: "weekly-2026-09-08.zip" });
    assert.deepEqual(rule, { address: "data@nadac.test", category: "nadac", subject: null, fileName: null });
  });

  test("when the file's own columns disagreed, the rule is narrowed to the stable part of the name", () => {
    const rule = ruleFromCorrection({
      fromAddress: "reports@mckesson.com",
      category: "credit_memo",
      fileName: "McKesson Credits 2026-09-08.csv",
      contentDisagreed: true,
    });
    assert.equal(rule?.fileName, "mckesson credits");
    assert.equal(rule?.category, "credit_memo");
  });

  test("a correction to a category nobody keeps is refused rather than stored", () => {
    assert.equal(ruleFromCorrection({ fromAddress: "a@b.test", category: "not_a_category" }), null);
  });

  test("a rule taught for a category is honoured the next time that sender writes", () => {
    const rule = ruleFromCorrection({ fromAddress: "ap@driver.test", category: "expense_invoice" })!;
    const r = recognise({ fromAddress: "ap@driver.test", fileName: "august.pdf", rules: [rule] });
    assert.equal(r.best?.category, "expense_invoice");
  });
});

describe("names that will be the same next week", () => {
  test("run dates come off, so a rule written today matches next Sunday", () => {
    assert.equal(stableStem("McKesson Invoices 2026-09-08.csv"), "mckesson invoices");
    assert.equal(stableStem("parmed_9-8-2026.txt"), "parmed");
    assert.equal(stableStem("catalog_20260908"), "catalog");
  });

  test("a name that is only a date leaves nothing to write a rule against", () => {
    assert.equal(stableStem("2026-09-08.pdf"), "");
    assert.equal(stableStem("00012345.pdf"), "");
  });
});

describe("the list of categories is data", () => {
  test("every category key is unique and every one says what happens to it", () => {
    const keys = new Set<string>();
    for (const c of CATEGORIES) {
      assert.equal(keys.has(c.key), false, `${c.key} appears twice`);
      keys.add(c.key);
      assert.equal(c.label.length > 0, true);
      assert.equal(c.handling.length > 0, true);
    }
  });

  test("no two categories claim the same content verdict, so a detector's answer is never ambiguous", () => {
    const seen = new Map<string, string>();
    for (const c of CATEGORIES) {
      for (const v of c.fromContent ?? []) {
        assert.equal(seen.has(v), false, `${v} is claimed by both ${seen.get(v)} and ${c.key}`);
        seen.set(v, c.key);
      }
    }
  });

  test("every kind the existing content recogniser can return has somewhere to go", () => {
    // The list from autoroute.ts's RouteKind. Imported by hand rather than by import because
    // autoroute is server-only and reaches the file readers; the point of the test is that a kind
    // added there without a category here would silently stop being recognised.
    const kinds = [
      "claims", "rx_transactions", "payer_payments", "accrual_sales", "on_hand", "rxrescue_credit",
      "supplier_catalog", "pioneer_catalog", "rebate_report", "purchase_drilldown", "return_policy", "nadac",
    ];
    const claimed = new Set(CATEGORIES.flatMap((c) => c.fromContent ?? []));
    for (const k of kinds) assert.equal(claimed.has(k), true, `${k} maps to no category`);
  });

  test("categoryFor answers for what is there and refuses what is not", () => {
    assert.equal(categoryFor("nadac")?.label, "A NADAC price file");
    assert.equal(categoryFor("nonsense"), null);
  });
});

/*
 * The unknown-sender invoice notice.
 *
 * Session 2's predicate answers "this reads as a supplier invoice and we do not know whose"; the
 * mailbox writes that as a sentence and the inbox page reads a name back out of it. That pair is
 * what drifts: move a comma in the sentence and the page silently stops offering the supplier's
 * name, with nothing failing anywhere. So the composer and the parser live together and these
 * walk one into the other.
 */
describe("an invoice whose sender nobody has registered", () => {
  test("the sentence the inbox records is recognised as the notice, with a name and without one", () => {
    const withName = unknownSenderInvoiceReason("billing@mckesson.com", "McKesson Drug Company");
    const without = unknownSenderInvoiceReason("billing@mckesson.com", null);
    assert.equal(isUnknownSenderInvoice(withName), true);
    assert.equal(isUnknownSenderInvoice(without), true);
    assert.equal(isUnknownSenderInvoice("Filed only: automatic loading is switched off."), false);
    assert.equal(isUnknownSenderInvoice(null), false);
  });

  test("the printed name survives the round trip, and its absence does not invent one", () => {
    assert.equal(printedNameInReason(unknownSenderInvoiceReason("a@b.test", "McKesson Drug Company")), "McKesson Drug Company");
    assert.equal(printedNameInReason(unknownSenderInvoiceReason("a@b.test", null)), null);
    assert.equal(printedNameInReason("something else entirely"), null);
    assert.equal(printedNameInReason(null), null);
  });

  test("the sentence says the address, so the line explains itself without the column beside it", () => {
    assert.match(unknownSenderInvoiceReason("billing@mckesson.com", null), /billing@mckesson\.com/);
    assert.match(unknownSenderInvoiceReason("billing@mckesson.com", null), /has not been filed as one/);
  });

  test("a header line that ran into an address is not offered as a supplier name", () => {
    // Suggesting it would be worse than suggesting nothing: it is one keystroke from being typed
    // onto the register, and a wrong name there sends every future invoice to the wrong supplier.
    const long = "MCKESSON DRUG COMPANY 6555 STATE HWY 161 IRVING TX 75039 REMIT TO PO BOX 981838";
    assert.equal(printedSupplierSuggestion(long), null);
    assert.equal(printedSupplierSuggestion("M"), null);
    assert.equal(printedSupplierSuggestion("  McKesson   Drug  Company "), "McKesson Drug Company");
    assert.equal(printedNameInReason(unknownSenderInvoiceReason("a@b.test", long)), null);
  });
});
