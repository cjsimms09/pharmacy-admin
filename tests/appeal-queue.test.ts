import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { buildQueue, rateFor, emailTarget, packetLines, type QueueClaim } from "../src/lib/appeal-queue";
import type { AppealTerms } from "../src/lib/appeal-packet";

/**
 * Which claims get an appeal packet, worked by hand.
 *
 * Example PBM pays generics at NADAC plus 10% plus $1.00. A 30-tablet claim with NADAC at $0.20 a
 * tablet should pay $6.00 + $0.60 + $1.00 = $7.60. Paid $3.10, it is $4.50 short and appealable
 * within 14 days of the fill; the pharmacy holds the invoice at $0.18 a tablet.
 */
const terms: AppealTerms = {
  pbmName: "Example PBM",
  submissionChannel: "email",
  submissionTarget: "macappeals@example.invalid",
  appealWindowDays: 14,
  windowBasis: "date_of_fill",
  requiredFields: "claim number, NDC, invoice",
  invoiceRequired: "yes",
  responseSlaDays: 10,
};

const claim = (over: Partial<QueueClaim> = {}): QueueClaim => ({
  claimId: "c1",
  rxNumber: "100001",
  fillNumber: 0,
  dateFilled: "2026-09-01",
  ndc11: "00000000001",
  drugName: "Amlodipine 5 mg",
  quantityThousandths: 30_000,
  bin: "610455",
  pcn: "EXPCN",
  groupNumber: "KS1",
  pbmName: "Example PBM",
  paidCents: 310,
  ingredientPaidCents: 210,
  networkId: "PREF01",
  classification: "G",
  awpTotalCents: null,
  nadacUnitMicros: 200_000,
  ...over,
});

const rates = [
  { pbmName: "Example PBM", network: "Preferred (PREF01)", lineOfBusiness: "commercial", brandRate: "AWP - 16%, plus $0.50", genericRate: "NADAC + 10%, plus $1.00" },
  { pbmName: "Example PBM", network: "Standard", lineOfBusiness: "commercial", brandRate: null, genericRate: "NADAC + 5%, plus $0.75" },
];

describe("the appeal queue", () => {
  test("the rate row is the claim's network id's where named", () => {
    assert.equal(rateFor(rates, { pbmName: "Example PBM", networkId: "PREF01" })?.network, "Preferred (PREF01)");
    assert.equal(rateFor(rates, { pbmName: "Example PBM", networkId: null }), null, "two rows and no id: no guess");
    assert.equal(rateFor(rates, { pbmName: "Example PBM", networkId: "Standard" })?.network, "Standard");
    assert.equal(rateFor(rates, { pbmName: "Other", networkId: null }), null);
  });

  test("a claim paid under the contract figure, with the invoice, inside the window, is ready", () => {
    const q = buildQueue({
      claims: [claim()],
      rates,
      terms: new Map([["example pbm", terms]]),
      invoices: new Map([["c1", { supplier: "McKesson", invoiceNumber: "INV1", invoiceDate: "2026-08-28", unitCostMicros: 180_000, packUnits: 90 }]]),
      today: "2026-09-06",
      pharmacy: { name: "Scratch Pharmacy", ncpdp: "1234567", npi: null },
      appealed: new Set(),
    });
    assert.equal(q.ready.length, 1);
    const r = q.ready[0];
    assert.equal(r.packet.shortfallCents, 760 - 310);
    assert.equal(r.packet.deadline, "2026-09-15");
    assert.equal(r.packet.daysLeft, 9);
    assert.equal(r.rateNetwork, "Preferred (PREF01)");
    assert.equal(q.readyCents, 450);
    assert.match(r.packet.narrative, /acquisition cost was \$0\.1800 a unit/);
  });

  test("paid to rate is counted, an already-appealed claim is skipped, and the unpriceable are counted", () => {
    const q = buildQueue({
      claims: [claim({ paidCents: 760 }), claim({ claimId: "c2" }), claim({ claimId: "c3", pbmName: "Nobody" }), claim({ claimId: "c4", nadacUnitMicros: null })],
      rates,
      terms: new Map([["example pbm", terms]]),
      invoices: new Map(),
      today: "2026-09-06",
      pharmacy: { name: "P", ncpdp: null, npi: null },
      appealed: new Set(["c2"]),
    });
    assert.equal(q.paidToRate, 1);
    assert.equal(q.unpriced, 2);
    assert.equal(q.ready.length + q.held.length, 0);
  });

  test("held packets say why, and the reasons are counted with the money behind them", () => {
    const q = buildQueue({
      claims: [claim(), claim({ claimId: "c5", dateFilled: "2026-08-01" })],
      rates,
      terms: new Map([["example pbm", terms]]),
      invoices: new Map(),
      today: "2026-09-06",
      pharmacy: { name: "P", ncpdp: null, npi: null },
      appealed: new Set(),
    });
    assert.equal(q.ready.length, 0);
    assert.equal(q.held.length, 2);
    assert.ok(q.reasons.some((r) => /requires the invoice/.test(r.reason) && r.claims === 2 && r.cents === 900), JSON.stringify(q.reasons));
    assert.ok(q.reasons.some((r) => /window closed/.test(r.reason) && r.claims === 1));
  });

  test("an email target is only an email when the channel allows it", () => {
    assert.equal(emailTarget("email", "Send to macappeals@example.invalid with the invoice"), "macappeals@example.invalid");
    assert.equal(emailTarget("portal", "appeals@example.invalid"), null);
    assert.equal(emailTarget(null, "https://portal.example.invalid/appeals"), null);
  });

  test("the packet lays out as a page", () => {
    const q = buildQueue({
      claims: [claim()],
      rates,
      terms: new Map([["example pbm", terms]]),
      invoices: new Map([["c1", { supplier: "McKesson", invoiceNumber: "INV1", invoiceDate: "2026-08-28", unitCostMicros: 180_000, packUnits: 90 }]]),
      today: "2026-09-06",
      pharmacy: { name: "P", ncpdp: null, npi: null },
      appealed: new Set(),
    });
    const lines = packetLines(q.ready[0].packet, "MAC appeal");
    assert.equal(lines[0].text, "MAC appeal");
    assert.ok(lines.some((l) => l.text.startsWith("Shortfall: $4.50")));
    assert.ok(lines.some((l) => /Appeal window closes 2026-09-15/.test(l.text)));
  });
});

describe("a rate row is only used on the days it is in force", () => {
  test("the claim's fill date picks between an old exhibit and its successor, and a superseded row prices nothing", () => {
    const rates = [
      { pbmName: "Example PBM", network: "Standard", lineOfBusiness: "Commercial", brandRate: "AWP-15% + $1.00", genericRate: "MAC + $1.00", effectiveDate: "2025-01-01", effectiveTo: "2025-12-31" },
      { pbmName: "Example PBM", network: "Standard", lineOfBusiness: "Commercial", brandRate: "AWP-17% + $1.50", genericRate: "MAC + $1.50", effectiveDate: "2026-01-01", effectiveTo: null },
      { pbmName: "Example PBM", network: "Old", lineOfBusiness: "Commercial", brandRate: "AWP-10%", genericRate: null, status: "superseded" },
    ];
    assert.equal(rateFor(rates, { pbmName: "Example PBM", networkId: null, dateFilled: "2025-06-01" })?.brandRate, "AWP-15% + $1.00");
    assert.equal(rateFor(rates, { pbmName: "Example PBM", networkId: null, dateFilled: "2026-03-01" })?.brandRate, "AWP-17% + $1.50");
    assert.equal(rateFor(rates, { pbmName: "Example PBM", networkId: "Old", dateFilled: "2026-03-01" })?.network, "Standard", "the superseded row is never the match");
    assert.equal(rateFor(rates, { pbmName: "Example PBM", networkId: null, dateFilled: "2024-06-01" }), null, "before any row was in force");
  });
});
