import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { chooseClaimForRemittance, type ClaimCandidate } from "../src/lib/match-remittance";
import { claimShares, isProgrammePayer, owedByPayer, type Receivable, type Received } from "../src/lib/payer-owed";
import { VERIDIKAL_CLAIM_FEE_CENTS, VERIDIKAL_CONVERSION_FEE_CENTS, VERIDIKAL_PAYER } from "../src/lib/veridikal-report";
import { COPAY_PAYER } from "../src/lib/copay-remit";

/**
 * The whole voucher chain, tested on the shapes these two companies actually send.
 *
 * The owner, 16 September 2026: "we should still be able to test our logic.. we know what we get from
 * claims, know what we get on veridikal and redsail... does our logic make snese.. we should still be
 * able to test this".
 *
 * He is right, and the objection it answers was mine. Nothing on file has matched a claim yet — all
 * 149 voucher payments the site holds are for fills between 30 April and 25 August, and these books
 * begin on 1 September — so I had been saying the chain was unproved until a September remittance
 * arrives in late October. But waiting for the data is not the same as being unable to test, and the
 * two halves are both known: PioneerRx gives the claim its voucher columns, and the two programmes'
 * own files give the payment rows. What happens between them is ours, and it is testable today.
 *
 * So each case below walks a claim the whole way:
 *
 *   1. the claim as PioneerRx hands it over, with its voucher columns;
 *   2. `claimShares` splitting it into what the plan owes and what the programme owes;
 *   3. the row that programme actually sends, built to the shape of the files now on file;
 *   4. `chooseClaimForRemittance` finding the claim from that row;
 *   5. `owedByPayer` settling the right side and leaving the other owed.
 *
 * The figures are this pharmacy's real arrangements — RedSail's voucher inside the net, Veridikal's
 * $2.50 claim fee, the conversion's $0.50 that nobody pays — on invented prescription numbers.
 */

const claim = (over: Partial<ClaimCandidate> = {}): ClaimCandidate => ({
  id: "claim-1",
  fillNumber: 0,
  dateFilled: "2026-09-08",
  ndc11: "00093721410",
  bin: "004336",
  remitCents: 6000,
  ...over,
});

describe("a RedSail voucher, end to end", () => {
  /*
   * The commonest of the three and the only one September has: 53 fills, the plans owing $21,464.58
   * of them and RedSail $9,565.58 (measured 16 September 2026). PioneerRx puts RedSail's amount in
   * `evoucher_cents`, and the plan pays the net less the voucher.
   */
  const remitCents = 6000;
  const voucherCents = 2000;

  test("the claim splits into the plan's share and the programme's, and the two add back to the net", () => {
    const s = claimShares({ remitCents, evoucherCents: voucherCents, evoucherMessageCents: 0, evoucherProgramme: "RedSail" });
    assert.equal(s.kind, "redsail_voucher");
    assert.equal(s.programme, COPAY_PAYER);
    assert.equal(s.programmeCents, voucherCents);
    assert.equal(s.planCents, remitCents - voucherCents);
    assert.equal(s.planCents + s.programmeCents + s.unpaidFeeCents, remitCents, "nothing is invented and nothing is lost");
  });

  test("their 835 line finds the claim", () => {
    /* The shape of the file that arrived 15 September: prescription, service date, NDC, amount. */
    const chosen = chooseClaimForRemittance([claim()], { fillNumber: null, dateFilled: "2026-09-08", ndc11: "00093721410", amountCents: voucherCents, bin: null });
    assert.equal(chosen.claim?.id, "claim-1");
    assert.equal(chosen.ambiguous, null);
  });

  test("and settles the voucher, leaving the plan owing every cent of its own share", () => {
    const receivables: Receivable[] = [
      { bin: "004336", name: "Caremark", dateFilled: "2026-09-08", cents: remitCents - voucherCents, claimId: "claim-1", portion: "plan", cashPlan: false },
      { bin: null, name: COPAY_PAYER, dateFilled: "2026-09-08", cents: voucherCents, claimId: "claim-1", portion: "programme", cashPlan: false },
    ];
    /* Their own 835 names them "RedSail Technologies LLC", which is not the name the receivable carries. */
    const received: Received[] = [{ bin: null, payer: "RedSail Technologies LLC", portion: "programme", claimId: "claim-1", cents: voucherCents, receivedOn: "2026-10-05", matched: true, notBilled: false }];
    const owed = owedByPayer(receivables, received, "2026-10-06");
    const plan = owed.lines.find((l) => l.name === "Caremark");
    const programme = owed.lines.find((l) => isProgrammePayer(l.name));
    assert.equal(programme?.receivedCents, voucherCents);
    assert.equal(programme?.outstandingCents, 0);
    assert.equal(plan?.receivedCents, 0, "the voucher money never touches the plan's line");
    assert.equal(plan?.outstandingCents, remitCents - voucherCents);
  });
});

describe("a Veridikal eVoucher, end to end", () => {
  /*
   * PioneerRx puts Veridikal's amount in the message column, not `evoucher_cents`, and Veridikal pays
   * the voucher plus a $2.50 claim fee. So the programme's share is the message amount plus the fee,
   * and the plan owes the rest — which is exactly what their eVoucher summary prints as
   * `thirdPartyDue`.
   */
  const remitCents = 6000;
  const messageCents = 2000;
  const programmeCents = messageCents + VERIDIKAL_CLAIM_FEE_CENTS;

  test("the split carries the claim fee on the programme's side, where it is paid from", () => {
    const s = claimShares({ remitCents, evoucherCents: 0, evoucherMessageCents: messageCents, evoucherProgramme: "Veridikal" });
    assert.equal(s.kind, "veridikal_evoucher");
    assert.equal(s.programme, VERIDIKAL_PAYER.evoucher);
    assert.equal(s.programmeCents, programmeCents);
    assert.equal(s.planCents, remitCents - programmeCents);
    assert.equal(s.planCents + s.programmeCents + s.unpaidFeeCents, remitCents);
  });

  test("their summary row finds the claim even when it dates the fill a day out", () => {
    /*
     * Their row counts the day the claim was billed and the claim counts the day it was filled, and
     * the two differ by a day often enough to matter. Three days is allowed; a month is another fill
     * and is refused, which is the rule that stopped 709 payments attaching to the wrong refill.
     */
    const near = chooseClaimForRemittance([claim()], { fillNumber: null, dateFilled: "2026-09-09", ndc11: "00093721410", amountCents: programmeCents, bin: "004336" });
    assert.equal(near.claim?.id, "claim-1");
    const nextMonth = chooseClaimForRemittance([claim()], { fillNumber: null, dateFilled: "2026-10-08", ndc11: "00093721410", amountCents: programmeCents, bin: "004336" });
    assert.equal(nextMonth.claim, null, "a month out is a different fill, not a late remittance");
  });

  test("and settles Veridikal's side alone", () => {
    const receivables: Receivable[] = [
      { bin: "004336", name: "Caremark", dateFilled: "2026-09-08", cents: remitCents - programmeCents, claimId: "claim-1", portion: "plan", cashPlan: false },
      { bin: null, name: VERIDIKAL_PAYER.evoucher, dateFilled: "2026-09-08", cents: programmeCents, claimId: "claim-1", portion: "programme", cashPlan: false },
    ];
    const received: Received[] = [{ bin: null, payer: VERIDIKAL_PAYER.evoucher, portion: "programme", claimId: "claim-1", cents: programmeCents, receivedOn: "2026-10-27", matched: true, notBilled: false }];
    const owed = owedByPayer(receivables, received, "2026-10-28");
    assert.equal(owed.lines.find((l) => l.name === VERIDIKAL_PAYER.evoucher)?.outstandingCents, 0);
    assert.equal(owed.lines.find((l) => l.name === "Caremark")?.outstandingCents, remitCents - programmeCents);
  });
});

describe("a Veridikal denial conversion, end to end", () => {
  /*
   * The plan pays nothing at all: the message names RelayHealth as the primary payer and the
   * manufacturer funds the whole net less a $0.50 fee that nobody pays. The plan's share must be
   * nought, or the site spends the next year chasing a plan that was never going to pay.
   */
  const remitCents = 6000;

  test("the plan owes nothing and the unpaid fee is owed by nobody", () => {
    const s = claimShares({ remitCents, evoucherCents: 0, evoucherMessageCents: remitCents, evoucherProgramme: "Veridikal conversion" });
    assert.equal(s.kind, "veridikal_conversion");
    assert.equal(s.planCents, 0);
    assert.equal(s.programme, VERIDIKAL_PAYER.denial_conversion);
    assert.equal(s.unpaidFeeCents, VERIDIKAL_CLAIM_FEE_CENTS - VERIDIKAL_CONVERSION_FEE_CENTS, "the 50 cents nobody pays");
    assert.equal(s.programmeCents + s.unpaidFeeCents, remitCents);
  });

  test("their payment clears the claim outright", () => {
    const s = claimShares({ remitCents, evoucherCents: 0, evoucherMessageCents: remitCents, evoucherProgramme: "Veridikal conversion" });
    const receivables: Receivable[] = [
      { bin: "004336", name: "Caremark", dateFilled: "2026-09-08", cents: 0, claimId: "claim-1", portion: "plan", cashPlan: false },
      { bin: null, name: VERIDIKAL_PAYER.denial_conversion, dateFilled: "2026-09-08", cents: s.programmeCents, claimId: "claim-1", portion: "programme", cashPlan: false },
    ];
    const received: Received[] = [{ bin: null, payer: VERIDIKAL_PAYER.denial_conversion, portion: "programme", claimId: "claim-1", cents: s.programmeCents, receivedOn: "2026-10-27", matched: true, notBilled: false }];
    const owed = owedByPayer(receivables, received, "2026-10-28");
    assert.equal(owed.outstandingCents, 0, "nothing is left owed by anybody");
  });
});

describe("the cases that go wrong, and have to go wrong visibly", () => {
  test("a fill billed to two payers is not guessed at", () => {
    /*
     * One prescription, two claims, same day and drug — a coordinated fill. Where neither the BIN nor
     * the amount singles one out, attaching the money makes two claims wrong at once, so it attaches
     * to neither and says why.
     */
    const two = [claim({ id: "primary", bin: "004336", remitCents: 6000 }), claim({ id: "secondary", bin: "610014", remitCents: 6000 })];
    const blind = chooseClaimForRemittance(two, { fillNumber: null, dateFilled: "2026-09-08", ndc11: "00093721410", amountCents: null, bin: null });
    assert.equal(blind.claim, null);
    assert.ok(blind.ambiguous, "a refusal that says nothing is indistinguishable from a bug");
    /* With the BIN their file prints, it is not a guess at all. */
    const named = chooseClaimForRemittance(two, { fillNumber: null, dateFilled: "2026-09-08", ndc11: "00093721410", amountCents: null, bin: "610014" });
    assert.equal(named.claim?.id, "secondary");
  });

  test("a prescription the site has never seen finds nothing, rather than the nearest thing", () => {
    assert.equal(chooseClaimForRemittance([], { fillNumber: null, dateFilled: "2026-09-08", ndc11: "00093721410", amountCents: 2000, bin: null }).claim, null);
  });

  test("a voucher larger than the claim's net is capped, never billed beyond it", () => {
    const s = claimShares({ remitCents: 1000, evoucherCents: 4000, evoucherMessageCents: 0, evoucherProgramme: "RedSail" });
    assert.equal(s.programmeCents, 1000);
    assert.equal(s.planCents, 0);
    assert.equal(s.planCents + s.programmeCents + s.unpaidFeeCents, 1000);
  });

  test("a claim with no voucher is untouched by any of this", () => {
    const s = claimShares({ remitCents: 6000, evoucherCents: 0, evoucherMessageCents: 0, evoucherProgramme: null });
    assert.equal(s.kind, "none");
    assert.equal(s.programme, null);
    assert.equal(s.planCents, 6000, "the plan owes the whole net, as it always did");
  });
});
