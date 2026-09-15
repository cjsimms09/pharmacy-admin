import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";

/*
 * Which contract a payer's enrolment facts are read from.
 *
 * Not a pure function, and that is the point: the bug this pins is a selection over rows, and the
 * two ways of getting it wrong are both invisible to a pure test. Taking the newest document and
 * stopping loses the base agreement's remittance terms the moment any later document is read, so a
 * payer that has been read shows as never read. Merging documents invents a third answer no
 * document gave. Nothing here is imported at the top, because `src/db` opens its connection on
 * first import and would fix the database before the hook could point it somewhere safe.
 */
let enrolmentFactsByPbm: typeof import("../src/lib/era-enrollment").enrolmentFactsByPbm;
let db: typeof import("../src/db").db;
let schema: typeof import("../src/db").schema;
let cleanUpDb: (() => void) | null = null;
let withEmpties: typeof import("../src/lib/contract-terms").withEmpties;
let ContractTerms: typeof import("../src/lib/contract-terms").ContractTerms;

/**
 * An extraction as the reader would have stored it, from only the fields a test cares about.
 *
 * `ContractTerms` has some sixty required members, and writing them out here would bury the two
 * lines each test is actually about — and would need editing every time session 1 adds a field.
 * `withEmpties` is what the real reader uses to fill "not stated" at every depth, so building the
 * fixture through it means these tests exercise the same shape the site stores rather than a
 * hand-made approximation of it.
 */
function extraction(counterparty: string, remittance: Record<string, unknown> | null, contacts: Record<string, unknown>[] = []): string {
  return JSON.stringify(
    withEmpties(ContractTerms, {
      counterparty,
      documentTitle: `${counterparty} document`,
      contractType: "payer_network",
      documentRole: "base",
      confidence: 0.9,
      contacts,
      ...(remittance ? { remittance } : {}),
    }),
  );
}

const doc = (id: string, pbmName: string, documentName: string, effectiveYear: number, json: string) => ({
  id, pbmName, documentName, effectiveYear, extractionState: "done" as const, extractionJson: json, priority: false,
});

before(async () => {
  const { useScratchDb } = await import("./support/scratch-db");
  cleanUpDb = await useScratchDb();
  ({ enrolmentFactsByPbm } = await import("../src/lib/era-enrollment"));
  ({ db, schema } = await import("../src/db"));
  ({ withEmpties, ContractTerms } = await import("../src/lib/contract-terms"));
});

after(() => cleanUpDb?.());

describe("which document a payer's enrolment facts come from", () => {
  test("the newest contract that says something about remittance, not simply the newest", async () => {
    // A payer's library is a base agreement plus amendments. An amendment about rates is silent on
    // remittance — it does not supersede terms it never mentions. Taking the newest and stopping
    // would lose the agreement's enrolment route and report the payer as never read.
    await db.insert(schema.contractDocs).values([
      doc("a1", "Example PBM", "2024 network agreement", 2024, extraction("Example PBM", {
        payerNamesOnRemittance: [], payerIdentifiers: [],
        enrollmentFormUrl: "https://pbm.example.invalid/era-form.pdf", eraOffered: true,
      })),
      doc("a2", "Example PBM", "2026 rate amendment", 2026, extraction("Example PBM", null)),
    ]);

    const facts = await enrolmentFactsByPbm();
    const it = facts.get("Example PBM");
    assert.equal(it?.enrollmentFormUrl, "https://pbm.example.invalid/era-form.pdf");
    assert.equal(it?.readFrom, "2024 network agreement", "should name the document the answer came from");
  });

  test("where two documents both speak, the newer one wins outright and nothing is merged", async () => {
    // A merged answer is a third answer no document gave, and it would be the one a request is
    // addressed with.
    await db.insert(schema.contractDocs).values([
      doc("b1", "Older PBM", "2023 agreement", 2023, extraction("Older PBM", {
        payerNamesOnRemittance: [], payerIdentifiers: [],
        clearinghouse: "Old Clearinghouse", tradingPartnerId: "OLD1", eraOffered: true,
      })),
      doc("b2", "Older PBM", "2025 restated agreement", 2025, extraction("Older PBM", {
        payerNamesOnRemittance: [], payerIdentifiers: [],
        clearinghouse: "New Clearinghouse", eraOffered: true,
      })),
    ]);

    const it = (await enrolmentFactsByPbm()).get("Older PBM");
    assert.equal(it?.clearinghouse, "New Clearinghouse");
    assert.equal(it?.readFrom, "2025 restated agreement");
    // The old trading partner is NOT carried across from the superseded document.
    assert.equal(it?.tradingPartnerId, null);
  });

  test("a payer whose every read document is silent on remittance is absent, not blank", async () => {
    // Absent means "nothing read says how they enrol", which the page words differently from a
    // payer whose contract has not been read at all. A blank entry would collapse the two.
    await db.insert(schema.contractDocs).values([
      doc("c1", "Silent PBM", "2025 agreement", 2025, extraction("Silent PBM", null)),
      doc("c2", "Silent PBM", "2024 agreement", 2024, extraction("Silent PBM", null)),
    ]);
    assert.equal((await enrolmentFactsByPbm()).has("Silent PBM"), false);
  });

  test("a document that was never read is never consulted, however new it is", async () => {
    await db.insert(schema.contractDocs).values([
      { id: "d1", pbmName: "Unread PBM", documentName: "2030 agreement", effectiveYear: 2030, extractionState: "none" as const, extractionJson: null, priority: false },
    ]);
    assert.equal((await enrolmentFactsByPbm()).has("Unread PBM"), false);
  });

  test("only the payment or EFT contacts come across, not every contact in the contract", async () => {
    await db.insert(schema.contractDocs).values([
      doc("e1", "Contact PBM", "2025 agreement", 2025, extraction("Contact PBM",
        { payerNamesOnRemittance: [], payerIdentifiers: [], eraOffered: true },
        [
          { purpose: "mac_appeals", email: "appeals@pbm.example.invalid" },
          { purpose: "payment_or_eft", email: "eft@pbm.example.invalid" },
        ])),
    ]);
    const it = (await enrolmentFactsByPbm()).get("Contact PBM");
    assert.equal(it?.contacts?.length, 1);
    assert.equal(it?.contacts?.[0]?.email, "eft@pbm.example.invalid");
  });
});
