import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { placeLine, type MatchContext } from "../src/lib/bank-statement";

/**
 * The cheque that pays the delivery driver, and the month boundary it lands on.
 *
 * The owner, asked how he pays him: *"We pay driver once monthly, track with the invoice on site
 * then at end of month print that invoice and give driver a check.. so accural should read off
 * invoice and cash will see check. It should know which check is delivery because it will be for
 * exact amount of delivery from previous month."* And then, on the timing: *"It won't clear on exact
 * day, it will clear early in the next month for same amount as delivery."*
 *
 * So the ordinary case is a cheque landing in the first days of the month *after* the trips it pays
 * for. The bank prints no payee on a cheque, so the amount is the only handle — and the round is a
 * different figure every month, which is what makes an exact match trustworthy and why there is
 * deliberately no tolerance.
 *
 * What was wrong: only the drawn month's round was offered as a candidate, so a $522.00 cheque
 * clearing on 30 September matched and the same cheque clearing on 1 October did not. Measured both
 * ways. Since he writes it at month end, the case that failed was the normal one.
 */
const ctx = (standing: { name: string; amountCents: number; paidDay: number | null; month?: string }[]) =>
  ({ standing, receipts: [], expenses: [], suppliers: [], payers: [] }) as unknown as MatchContext;

const cheque = (on: string, cents: number) =>
  ({ on, description: "CHECK #1042", amountCents: -cents }) as Parameters<typeof placeLine>[0];

const round = (month: string, label: string, cents: number) => ({
  name: `The delivery round for ${label}`,
  amountCents: cents,
  paidDay: null,
  month,
});

describe("the delivery cheque, either side of the month it pays for", () => {
  const september = round("2026-09", "September", 52_200);
  const august = round("2026-08", "August", 47_700);

  test("REGRESSION: a cheque clearing early in the next month is placed", () => {
    // The ordinary case, and the one that used to come back unplaced.
    for (const on of ["2026-10-01", "2026-10-03", "2026-10-06"]) {
      const p = placeLine(cheque(on, 52_200), ctx([round("2026-10", "October", 9_900), september]));
      assert.equal(p.kind, "confirms_standing", `cleared ${on}`);
      assert.match((p as { name: string }).name, /September/, `cleared ${on} should name the round it paid`);
    }
  });

  test("and one that happens to clear before the month turns is still placed", () => {
    const p = placeLine(cheque("2026-09-30", 52_200), ctx([september]));
    assert.equal(p.kind, "confirms_standing");
    assert.match((p as { name: string }).name, /September/);
  });

  test("it names which month's round it paid, so a wrong match is visible", () => {
    /*
     * The reason the month is carried on the candidate rather than read off the line. A cheque
     * confirming the wrong month's round asserts a payment that never happened, and the only
     * defence is the sentence saying which one it believes it paid.
     */
    const p = placeLine(cheque("2026-09-02", 47_700), ctx([september, august]));
    assert.equal(p.kind, "confirms_standing");
    assert.match((p as { name: string }).name, /August/);
  });

  test("and a round two months old is not payable by this cheque", () => {
    /*
     * The window is the line's month and the one before it, because that is what his workflow can
     * produce — written at the end of a month, cleared early in the next. An October cheque paying
     * August's round would be two months late, and admitting it would start matching cheques to
     * rounds nobody was paying that late.
     */
    assert.equal(placeLine(cheque("2026-10-02", 47_700), ctx([september, august])).kind, "unplaced");
  });

  test("it books nothing, because the accrual already carries the round", () => {
    /*
     * Both bases see this once. The invoice puts it in the accrual in the month of the trips; the
     * cheque is the cash side. A placement that booked a cost here would count the driver twice.
     */
    const p = placeLine(cheque("2026-10-01", 52_200), ctx([september]));
    assert.equal(p.kind, "confirms_standing");
    assert.match((p as { why: string }).why, /nothing is booked from this line/);
  });

  test("two months at the same figure is refused, not guessed", () => {
    /*
     * The honest failure. If two consecutive rounds came to the same amount, the amount cannot say
     * which cheque this is, and picking one would confirm a payment that may never have happened.
     */
    const p = placeLine(
      cheque("2026-10-01", 52_200),
      ctx([round("2026-10", "October", 52_200), round("2026-09", "September", 52_200)]),
    );
    assert.equal(p.kind, "unplaced");
    assert.match((p as { why: string }).why, /cannot be told from the amount alone/);
  });

  test("an amount matching no round stays unplaced, with no tolerance", () => {
    // A cheque that has changed by forty dollars is worth knowing about, and is exactly what a
    // tolerance would hide.
    assert.equal(placeLine(cheque("2026-10-01", 48_200), ctx([september])).kind, "unplaced");
  });

  test("a standing cost is still matched in any month, because it carries none", () => {
    // Rent is the same every month, so it has no month on it and must not be narrowed by this.
    const p = placeLine(cheque("2026-10-18", 262_544), ctx([{ name: "Rent", amountCents: 262_544, paidDay: 18 }]));
    assert.equal(p.kind, "confirms_standing");
    assert.equal((p as { name: string }).name, "Rent");
  });
});
