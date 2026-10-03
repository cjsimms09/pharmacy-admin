import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { owedByPayer, daysBetween, isProgrammePayer, type Receivable, type Received } from "../src/lib/payer-owed";

/*
 * What a payer owes, and the three states this page exists to keep apart.
 *
 * The owner asked for it directly: "it should be easy to know how much a payer owes us for a
 * claim." The difficulty is not the arithmetic. It is that on the day it was written, $131,743.31
 * had been billed and nothing at all had been received — so the honest page and the broken page
 * look identical unless the difference is said out loud.
 *
 *   nothing to measure   a cash plan: never sends money, never will
 *   never measured       a real payer that has not remitted yet: unpaid, not late
 *   measured             a payer that has paid before: a balance worth chasing
 */

const TODAY = "2026-09-09";

const bill = (o: Partial<Receivable> = {}): Receivable => ({
  bin: "610011", name: "Caremark", dateFilled: "2026-09-01", cents: 10_000, cashPlan: false, ...o,
});
const paid = (o: Partial<Received> = {}): Received => ({
  bin: "610011", payer: "Caremark", cents: 10_000, receivedOn: "2026-09-08", matched: true, ...o,
});

describe("the three states", () => {
  test("a cash plan is not a debt, however much was billed through it", () => {
    // RxLocal: the copay is the money. Showing $418.22 owed would send somebody chasing nobody.
    const s = owedByPayer([bill({ bin: "028249", name: "RxLocal", cents: 41_822, cashPlan: true })], [], TODAY);
    assert.equal(s.lines[0].state, "cashPlan");
    assert.equal(s.lines[0].outstandingCents, 41_822, "the figure is still shown; it is the meaning that differs");
    assert.match(s.lines[0].says, /Nothing is owed/);
    assert.match(s.lines[0].says, /collected at the counter/);
  });

  test("a payer that has never remitted is unpaid, and is not called late", () => {
    /*
     * The sentence the page is for. No remittance cycle is on file for any payer, so "overdue"
     * would be a deadline this pharmacy invented — the same mistake as the 48 hours in the manual.
     */
    const s = owedByPayer([bill()], [], TODAY);
    assert.equal(s.lines[0].state, "waiting");
    assert.match(s.lines[0].says, /this is not late — it is unpaid, which is a different thing/);
    assert.match(s.lines[0].says, /No remittance cycle for this payer is on file/);
    assert.doesNotMatch(s.lines[0].says, /overdue|late payment|days late/i);
  });

  test("a payer that has paid before is the only one with a balance worth chasing", () => {
    const s = owedByPayer([bill({ cents: 30_000 })], [paid({ cents: 10_000 })], TODAY);
    assert.equal(s.lines[0].state, "owes");
    assert.equal(s.lines[0].outstandingCents, 20_000);
    assert.match(s.lines[0].says, /has remitted before/);
  });

  test("billed and received agreeing is square, and says so in three words", () => {
    const s = owedByPayer([bill()], [paid()], TODAY);
    assert.equal(s.lines[0].state, "settled");
    assert.equal(s.lines[0].outstandingCents, 0);
    assert.equal(s.lines[0].daysWaiting, null, "nothing is waiting, so no age is claimed");
  });

  test("more received than billed is its own state, not a negative debt", () => {
    const s = owedByPayer([bill()], [paid({ cents: 12_000 })], TODAY);
    assert.equal(s.lines[0].state, "overpaid");
    assert.equal(s.lines[0].outstandingCents, 0, "an overpayment must never read as money owed to us");
    assert.match(s.lines[0].says, /more than this pharmacy asked for/);
  });
});

describe("the day nothing has arrived, which is every day so far", () => {
  test("the headline explains the empty column instead of leaving it to look broken", () => {
    const s = owedByPayer(
      [bill({ cents: 100_00 }), bill({ bin: "004336", name: "Express Scripts", cents: 200_00 })],
      [],
      TODAY,
    );
    assert.equal(s.nothingHasArrived, true);
    assert.match(s.says, /nothing received from any of them yet/);
    assert.match(s.says, /not this page failing/);
    assert.match(s.says, /a true nought rather than a missing one/);
  });

  test("one payment from one payer ends that state for the whole page", () => {
    const s = owedByPayer([bill(), bill({ bin: "004336", name: "Express Scripts" })], [paid({ cents: 100 })], TODAY);
    assert.equal(s.nothingHasArrived, false);
    assert.match(s.says, /billed,.*received,.*outstanding/);
  });

  test("cash plans do not count as payers that have failed to pay", () => {
    // Otherwise a pharmacy billing only through its own plan would read as owed a fortune.
    const s = owedByPayer([bill({ bin: "028249", name: "RxLocal", cashPlan: true })], [], TODAY);
    assert.equal(s.nothingHasArrived, false, "there is no real payer here to be waiting on");
    assert.match(s.says, /Nothing is owed by anybody/);
  });

  test("nothing billed at all says so rather than showing an empty table", () => {
    const s = owedByPayer([], [], TODAY);
    assert.match(s.says, /No claims have been billed/);
    assert.equal(s.lines.length, 0);
  });
});

describe("money that belongs to no claim here", () => {
  test("payments matching nothing are counted apart, and named as not an error", () => {
    /*
     * The 24 facilitator payments on file, $5,808.33, for fills between January and August. The
     * claim history starts on 1 September, so they will never match. Counting them against a
     * payer's balance would settle a September debt with an August payment.
     */
    const s = owedByPayer([bill({ cents: 100_00 })], [paid({ cents: 580_833, matched: false })], TODAY);
    assert.equal(s.unattached.count, 1);
    assert.equal(s.unattached.cents, 580_833);
    assert.equal(s.lines[0].receivedCents, 0, "it must not settle anything");
    assert.equal(s.lines[0].outstandingCents, 100_00);
    assert.match(s.says, /this site does not hold/);
    assert.match(s.says, /counted nowhere on this page/);
  });

  test("a matched payment for a payer outside the period does not settle it either", () => {
    // An August payment must not square a September balance for a payer September never billed.
    const s = owedByPayer([bill()], [paid({ bin: "999999", payer: "Somebody else" })], TODAY);
    assert.equal(s.lines.length, 1);
    assert.equal(s.lines[0].receivedCents, 0);
    assert.equal(s.unattached.count, 0, "it matched a claim, so it is not unattached — just not here");
  });
});

describe("grouping and ordering", () => {
  test("payers are grouped on the BIN, which is what a remittance names", () => {
    const s = owedByPayer([bill(), bill({ name: "CAREMARK PCS" })], [], TODAY);
    assert.equal(s.lines.length, 1);
    assert.equal(s.lines[0].claims, 2);
    assert.equal(s.lines[0].billedCents, 20_000);
  });

  test("two payers nothing can name are still two payers", () => {
    const s = owedByPayer([bill({ bin: null, name: "One" }), bill({ bin: null, name: "Two" })], [], TODAY);
    assert.equal(s.lines.length, 2);
  });

  test("the largest outstanding is first, because that is the question being asked", () => {
    const s = owedByPayer(
      [bill({ cents: 100 }), bill({ bin: "004336", name: "Express Scripts", cents: 900_00 })],
      [],
      TODAY,
    );
    assert.equal(s.lines[0].name, "Express Scripts");
  });

  test("the payer's oldest claim is the one aged, not its newest", () => {
    /*
     * Deliberately not "oldest unsettled". Payments are summed per payer rather than matched claim
     * by claim, so nothing here knows which claims a part-payment covered. What is printed is the
     * longest anything of this payer's could have been waiting, which errs towards chasing.
     */
    const s = owedByPayer([bill({ dateFilled: "2026-09-08" }), bill({ dateFilled: "2026-09-01" })], [], TODAY);
    assert.equal(s.lines[0].oldestOn, "2026-09-01");
    assert.equal(s.lines[0].daysWaiting, 8);
  });

  test("days are counted, not guessed at", () => {
    assert.equal(daysBetween("2026-09-01", "2026-09-09"), 8);
    assert.equal(daysBetween(null, "2026-09-09"), null);
    assert.equal(daysBetween("not a date", "2026-09-09"), null);
  });
});

describe("a voucher programme's payment, whichever door it came through", () => {
  /*
   * Found 16 September 2026, unshipped, and due to bite in October.
   *
   * A programme's payment settles the programme's share and never the plan's — that rule was already
   * here. But the store decided which it was by the payment's source, and only `copay_card` counted.
   * RedSail's first remittance arrived the evening before as an ordinary 835 over SFTP, imported as
   * `plan`, naming "RedSail Technologies LLC" rather than the "RedSail Technologies (RAS copay
   * voucher)" the receivable is raised under.
   *
   * Nothing was harmed, because every payment in that file was for an April or May fill and this site
   * holds no claim older than August. For a September fill each one would have settled the plan's
   * receivable: the plan paid when it had paid nothing, the voucher owed for ever, both wrong on the
   * same claim, every figure adding up.
   */
  test("the payer says it is a programme even when the source says plan", () => {
    assert.equal(isProgrammePayer("RedSail Technologies LLC"), true, "the name on their own 835");
    assert.equal(isProgrammePayer("RedSail Technologies (RAS copay voucher)"), true, "the name the receivable is raised under");
    assert.equal(isProgrammePayer("Veridikal (eVoucher)"), true);
    assert.equal(isProgrammePayer("Veridikal (Denial Conversion)"), true);
    assert.equal(isProgrammePayer("VERIDIKAL LLC"), true, "matched on the company, not on one spelling of it");
  });

  test("a plan is never mistaken for a programme", () => {
    for (const plan of ["Caremark", "Express Scripts", "MedImpact", "Prime Therapeutics", "Health Mart Atlas", "ProviderPay", "RelayHealth", null, ""]) {
      assert.equal(isProgrammePayer(plan), false, String(plan));
    }
  });

  test("the voucher line is settled by the voucher money, and the plan still owes its own share", () => {
    /* A $60.00 net carrying a $20.00 RedSail voucher: the plan owes $40.00 and RedSail owes $20.00. */
    const receivables: Receivable[] = [
      { bin: "004336", name: "Caremark", dateFilled: "2026-09-02", cents: 4000, claimId: "c1", portion: "plan", cashPlan: false },
      { bin: null, name: "RedSail Technologies (RAS copay voucher)", dateFilled: "2026-09-02", cents: 2000, claimId: "c1", portion: "programme", cashPlan: false },
    ];
    /* Their 835 pays the voucher, under the name their file prints. */
    const received: Received[] = [{ bin: null, payer: "RedSail Technologies LLC", portion: "programme", claimId: "c1", cents: 2000, receivedOn: "2026-10-05", matched: true, notBilled: false }];
    const owed = owedByPayer(receivables, received, "2026-10-06");
    const plan = owed.lines.find((r) => r.name === "Caremark");
    const programme = owed.lines.find((r) => r.name.toLowerCase().includes("redsail"));
    assert.equal(programme?.outstandingCents, 0, "the voucher is settled by the voucher payment");
    assert.equal(programme?.receivedCents, 2000);
    assert.equal(plan?.outstandingCents, 4000, "and the plan still owes every cent of its own share");
    assert.equal(plan?.receivedCents, 0, "the voucher money never touches the plan's line");
  });
});

describe("a fill billed to two payers, settled one at a time", () => {
  /*
   * The owner, 16 September 2026: "is our logic sound when multiple payors on a claim, can we
   * reconcile one payor and know whats still expected from another?"
   *
   * Measured the same afternoon: 84 September fills went to two payers and one to three, $31,040.33
   * billed across them, with $13,638.95 of that sitting on the secondary rows. So this is not a
   * corner — it is one fill in thirty-eight, and the whole of a secondary's money depends on the two
   * halves never being confused for one another.
   *
   * A fill billed twice is two claim rows, each with its own payer, its own BIN and its own share of
   * the money. Nothing here adds them together: a payment names the claim it settles, and settles
   * that claim alone.
   */
  const primary: Receivable = { bin: "004336", name: "Caremark", dateFilled: "2026-09-08", cents: 7500, claimId: "primary", portion: "plan", cashPlan: false };
  const secondary: Receivable = { bin: "610014", name: "MedImpact", dateFilled: "2026-09-08", cents: 2500, claimId: "secondary", portion: "plan", cashPlan: false };

  test("the primary paying leaves the secondary owing every cent of its own share", () => {
    const owed = owedByPayer([primary, secondary], [{ bin: "004336", payer: "Caremark", portion: "plan", claimId: "primary", cents: 7500, receivedOn: "2026-10-01", matched: true, notBilled: false }], "2026-10-02");
    assert.equal(owed.lines.find((l) => l.name === "Caremark")?.outstandingCents, 0);
    assert.equal(owed.lines.find((l) => l.name === "MedImpact")?.outstandingCents, 2500, "the secondary is still owed, and by name");
    assert.equal(owed.outstandingCents, 2500, "and the fill as a whole is short by exactly the secondary's share");
  });

  test("the secondary paying first leaves the primary owing, which is the same rule the other way up", () => {
    const owed = owedByPayer([primary, secondary], [{ bin: "610014", payer: "MedImpact", portion: "plan", claimId: "secondary", cents: 2500, receivedOn: "2026-10-01", matched: true, notBilled: false }], "2026-10-02");
    assert.equal(owed.lines.find((l) => l.name === "MedImpact")?.outstandingCents, 0);
    assert.equal(owed.lines.find((l) => l.name === "Caremark")?.outstandingCents, 7500);
  });

  test("one payer's money never settles the other's share, however exactly it would fit", () => {
    /*
     * The failure this guards. Summed per fill rather than per claim, $7,500 from the primary and a
     * $2,500 secondary share look like a settled fill — and the secondary, which has paid nothing,
     * disappears off the list of who owes money.
     */
    const both = owedByPayer([primary, secondary], [{ bin: "004336", payer: "Caremark", portion: "plan", claimId: "primary", cents: 10000, receivedOn: "2026-10-01", matched: true, notBilled: false }], "2026-10-02");
    assert.equal(both.lines.find((l) => l.name === "MedImpact")?.outstandingCents, 2500, "an overpaying primary does not settle the secondary");
    assert.ok((both.lines.find((l) => l.name === "Caremark")?.overpaidCents ?? 0) > 0, "it is the primary that has overpaid, and that is said");
  });

  test("both paid is the whole fill settled, to the cent", () => {
    const owed = owedByPayer(
      [primary, secondary],
      [
        { bin: "004336", payer: "Caremark", portion: "plan", claimId: "primary", cents: 7500, receivedOn: "2026-10-01", matched: true, notBilled: false },
        { bin: "610014", payer: "MedImpact", portion: "plan", claimId: "secondary", cents: 2500, receivedOn: "2026-10-09", matched: true, notBilled: false },
      ],
      "2026-10-10",
    );
    assert.equal(owed.outstandingCents, 0);
    assert.equal(owed.billedCents, 10000);
    assert.equal(owed.receivedCents, 10000);
  });
});
