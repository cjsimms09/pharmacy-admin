import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { SITE_STARTS_ON } from "../src/lib/books-start";
import { owedByPayer, type Receivable, type Received } from "../src/lib/payer-owed";
import {
  AGE_BANDS,
  ageBandOf,
  ageOutstanding,
  arReport,
  arReportCsv,
  arReportText,
  isMonth,
  lastDayOf,
  monthDueOn,
  monthIsReportable,
  monthLabel,
  monthWindow,
  nextMonth,
  previousMonth,
  receivablesAsAt,
  receivedAsAt,
  reportableMonths,
} from "../src/lib/ar-report";

/*
 * The month-end AR report.
 *
 * The owner asked for two things — "do we have an AR report I can print monthly.." and "i should
 * also be able to setup auto email of this report to another email" — and the risk in both is the
 * same one. A report is a document. It leaves the building, it goes in somebody else's file, and it
 * gets reprinted months later to settle an argument. So the two things that must never move are the
 * date everything is pinned to and the rule about what is allowed in at all:
 *
 *   the books begin on 1 September 2026 and nothing from before it is in any figure, because the
 *   owner said so of this report by name — "these are test only and should not show up on any AR
 *   reports or anything";
 *
 *   and a September report printed in January is the September report, not a January one with a
 *   September heading.
 *
 * Those are what these tests are for. The month arithmetic is here because it is what decides both.
 */

const bill = (o: Partial<Receivable> = {}): Receivable => ({
  bin: "610011", name: "Caremark", dateFilled: "2026-09-05", cents: 10_000, cashPlan: false, ...o,
});
const paid = (o: Partial<Received> = {}): Received => ({
  bin: "610011", payer: "Caremark", cents: 10_000, receivedOn: "2026-09-20", matched: true, ...o,
});

describe("month arithmetic", () => {
  test("the last day of a month is the last day of that month", () => {
    assert.equal(lastDayOf("2026-09"), "2026-09-30");
    assert.equal(lastDayOf("2026-10"), "2026-10-31");
    assert.equal(lastDayOf("2026-01"), "2026-01-31");
    assert.equal(lastDayOf("2026-12"), "2026-12-31");
  });

  test("February knows about leap years", () => {
    assert.equal(lastDayOf("2027-02"), "2027-02-28");
    assert.equal(lastDayOf("2028-02"), "2028-02-29", "2028 is a leap year");
    assert.equal(lastDayOf("2100-02"), "2100-02-28", "2100 is not, despite dividing by four");
  });

  test("the step to the month either side crosses the year", () => {
    assert.equal(previousMonth("2027-01"), "2026-12");
    assert.equal(nextMonth("2026-12"), "2027-01");
    assert.equal(previousMonth("2026-10"), "2026-09");
    assert.equal(nextMonth("2026-09"), "2026-10");
  });

  test("a month is four digits, a dash, and a month that exists", () => {
    assert.equal(isMonth("2026-09"), true);
    assert.equal(isMonth("2026-13"), false, "there is no thirteenth month");
    assert.equal(isMonth("2026-00"), false);
    assert.equal(isMonth("2026-9"), false);
    assert.equal(isMonth(""), false);
    assert.equal(isMonth(null), false);
  });

  test("months are named the way somebody says them out loud", () => {
    assert.equal(monthLabel("2026-09"), "September 2026");
    assert.equal(monthLabel("2027-01"), "January 2027");
  });
});

describe("the window a month's report covers", () => {
  test("it begins where the books begin, not on the first of the month", () => {
    /*
     * The difference between an AR report and a month's activity. What Caremark owed on 31 October
     * includes the claim it has not paid from 3 September; a window one month wide would drop every
     * older debt from the document whose entire subject is older debts.
     */
    const w = monthWindow("2026-10", "2026-11-08");
    assert.equal(w.from, SITE_STARTS_ON);
    assert.equal(w.asAt, "2026-10-31");
    assert.equal(w.complete, true);
  });

  test("a month still running is as at today, and says it is not finished", () => {
    const w = monthWindow("2026-09", "2026-09-11");
    assert.equal(w.asAt, "2026-09-11", "it does not claim to know the 30th on the 11th");
    assert.equal(w.complete, false);
  });

  test("the last day of the month is not finished until the day after it", () => {
    // Run on the 30th, September is still open: remittances can still arrive that day.
    assert.equal(monthWindow("2026-09", "2026-09-30").complete, false);
    assert.equal(monthWindow("2026-09", "2026-10-01").complete, true);
  });
});

describe("which months can be reported on at all", () => {
  test("nothing before the books begin, however real the data looks", () => {
    /*
     * The owner pulled April and June remittances to prove the claim matcher works, and said of
     * them: "I do not want to track or keep track of payments from before 09/01.. these are test
     * only and should not show up on any AR reports or anything." He named this report.
     */
    const r = monthIsReportable("2026-06", "2026-09-11");
    assert.equal(r.ok, false);
    assert.match(r.why, /books begin/);
    assert.equal(monthIsReportable("2026-08", "2026-09-11").ok, false, "August is out too, by one day");
    assert.equal(monthIsReportable("2026-09", "2026-09-11").ok, true);
  });

  test("a month that has not happened is refused rather than rendered empty", () => {
    const r = monthIsReportable("2027-03", "2026-09-11");
    assert.equal(r.ok, false);
    assert.match(r.why, /has not happened/);
  });

  test("the list runs from the first month of the books to this one, newest first", () => {
    const months = reportableMonths("2026-12-04");
    assert.deepEqual(months.map((m) => m.month), ["2026-12", "2026-11", "2026-10", "2026-09"]);
    assert.equal(months[0].complete, false, "December is still running on the 4th");
    assert.equal(months[1].complete, true);
  });

  test("on the first day of the books there is exactly one month to pick", () => {
    const months = reportableMonths(SITE_STARTS_ON);
    assert.deepEqual(months.map((m) => m.month), ["2026-09"]);
  });
});

describe("what is allowed into the figures", () => {
  test("a fill from before the books begin never reaches the report", () => {
    /*
     * This is not hypothetical. `allFills` loads a fill if it was either filled or collected inside
     * the window — the account needs that, because revenue follows the day the patient collects —
     * so an August fill picked up on 2 September arrives here with an August fill date. It is not
     * this pharmacy's September receivable and must not be one of its lines.
     */
    const kept = receivablesAsAt(
      [bill({ dateFilled: "2026-08-28" }), bill({ dateFilled: "2026-09-01" }), bill({ dateFilled: "2026-09-30" })],
      "2026-09-30",
    );
    assert.deepEqual(kept.map((r) => r.dateFilled), ["2026-09-01", "2026-09-30"]);
  });

  test("a fill dated after the month end was not owed at the month end", () => {
    const kept = receivablesAsAt([bill({ dateFilled: "2026-10-02" })], "2026-09-30");
    assert.equal(kept.length, 0);
  });

  test("a payment that arrived in October does not settle a September balance", () => {
    /*
     * The rule that makes the document stable. Without it, September's report shrinks every time it
     * is reprinted, and the copy in the accountant's file stops matching the copy on the screen.
     */
    const kept = receivedAsAt([paid({ receivedOn: "2026-09-30" }), paid({ receivedOn: "2026-10-01" })], "2026-09-30");
    assert.deepEqual(kept.map((p) => p.receivedOn), ["2026-09-30"]);
  });

  test("out-of-books money is thrown out here too, not only in the query", () => {
    /*
     * The loader already excludes it in SQL. It is excluded again here because this is the report
     * the owner named, and because a rule enforced in exactly one place is a rule that survives
     * until somebody writes a second query — which is how it came to be in books-start.ts at all.
     */
    const kept = receivedAsAt([paid({ receivedOn: "2026-04-14" }), paid({ receivedOn: "2026-06-02" })], "2026-12-31");
    assert.equal(kept.length, 0);
  });

  test("a payment with no date on it is kept, because it is far more likely to be this month's", () => {
    // The same reading as isOutOfBooks, and for the same reason: the failure that matters is
    // silently dropping money the pharmacy really has.
    const kept = receivedAsAt([paid({ receivedOn: null })], "2026-09-30");
    assert.equal(kept.length, 1);
  });
});

describe("how long it has been waiting", () => {
  test("the bands are measured from the fill date, on the day the report is as at", () => {
    assert.equal(ageBandOf("2026-12-31", "2026-12-31"), "0-30");
    assert.equal(ageBandOf("2026-12-01", "2026-12-31"), "0-30", "30 days is still the first band");
    assert.equal(ageBandOf("2026-11-30", "2026-12-31"), "31-60", "31 is the second");
    assert.equal(ageBandOf("2026-11-01", "2026-12-31"), "31-60", "60 days");
    assert.equal(ageBandOf("2026-10-31", "2026-12-31"), "61-90", "61 days");
    assert.equal(ageBandOf("2026-10-02", "2026-12-31"), "61-90", "90 days");
    assert.equal(ageBandOf("2026-10-01", "2026-12-31"), "91+", "91 days");
  });

  test("only a payer that has never remitted can honestly be aged", () => {
    /*
     * The claim the data cannot support. What arrived is summed against the payer rather than
     * matched claim by claim, so where a payer has part-paid there is no telling which of its
     * prescriptions the money covered — and an ageing column that assumes the oldest was cleared
     * first is a confident answer to a question nothing on file answers.
     */
    const asAt = "2026-12-31";
    const receivables = [
      bill({ dateFilled: "2026-09-05", cents: 10_000 }),
      bill({ dateFilled: "2026-10-20", cents: 20_000 }),
      bill({ bin: "610502", name: "Express Scripts", dateFilled: "2026-09-10", cents: 30_000 }),
      bill({ bin: "028249", name: "RxLocal", dateFilled: "2026-09-12", cents: 5_000, cashPlan: true }),
    ];
    const received = [paid({ bin: "610502", payer: "Express Scripts", cents: 10_000, receivedOn: "2026-11-02" })];
    const summary = owedByPayer(receivables, received, asAt);
    const real = summary.lines.filter((l) => l.state !== "cashPlan");
    const aged = ageOutstanding(receivables, real, asAt);

    assert.equal(aged.bands["91+"], 10_000, "the 5 September claim, 117 days later");
    assert.equal(aged.bands["61-90"], 20_000, "the 20 October claim, 72 days later");
    assert.equal(aged.bands["31-60"], 0);
    assert.equal(aged.bands["0-30"], 0);
    assert.equal(aged.unagedCents, 20_000, "Express Scripts part-paid, so its balance is real and its age is not known");
    assert.equal(aged.unagedPayers, 1);
  });

  test("a cash plan is in no band and in no total: it is not a debt", () => {
    const asAt = "2026-09-30";
    const receivables = [bill({ bin: "028249", name: "RxLocal", cents: 41_822, cashPlan: true })];
    const summary = owedByPayer(receivables, [], asAt);
    const real = summary.lines.filter((l) => l.state !== "cashPlan");
    const aged = ageOutstanding(receivables, real, asAt);
    for (const b of AGE_BANDS) assert.equal(aged.bands[b], 0);
    assert.equal(aged.unagedCents, 0);
  });

  test("the bands and the unaged balance add up to the outstanding total", () => {
    /*
     * The invariant that makes the ageing block readable beside the table. A report whose parts do
     * not sum to its own total is one somebody has to check by hand, which is the same as one
     * nobody checks at all.
     */
    const asAt = "2026-12-31";
    const receivables = [
      bill({ dateFilled: "2026-09-05", cents: 10_000 }),
      bill({ dateFilled: "2026-10-20", cents: 20_000 }),
      bill({ bin: "610502", name: "Express Scripts", dateFilled: "2026-09-10", cents: 30_000 }),
      bill({ bin: "028249", name: "RxLocal", dateFilled: "2026-09-12", cents: 5_000, cashPlan: true }),
    ];
    const received = [paid({ bin: "610502", payer: "Express Scripts", cents: 10_000, receivedOn: "2026-11-02" })];
    const summary = owedByPayer(receivables, received, asAt);
    const r = arReport("2026-12", monthWindow("2026-12", "2027-01-04"), summary);
    r.ageing = ageOutstanding(receivables, r.lines, asAt);

    const banded = AGE_BANDS.reduce((n, b) => n + r.ageing.bands[b], 0);
    assert.equal(banded + r.ageing.unagedCents, r.outstandingCents);
  });
});

describe("the report itself", () => {
  const asAt = "2026-09-30";
  const receivables = [
    bill({ dateFilled: "2026-09-05", cents: 10_000 }),
    bill({ bin: "610502", name: "Express Scripts", dateFilled: "2026-09-10", cents: 30_000 }),
    bill({ bin: "028249", name: "RxLocal", dateFilled: "2026-09-12", cents: 5_000, cashPlan: true }),
  ];
  const build = (received: Received[] = []) => {
    const summary = owedByPayer(receivables, received, asAt);
    const r = arReport("2026-09", monthWindow("2026-09", "2026-10-02"), summary);
    r.ageing = ageOutstanding(receivables, r.lines, asAt);
    return r;
  };

  test("a cash plan is out of every total and named rather than dropped in silence", () => {
    /*
     * On the payer screen its billed figure belongs beside the others — it is money the pharmacy
     * took. On a receivables statement it would be a claim that somebody owes it, and nobody does:
     * the copay was collected at the counter on the day. So it comes out of the totals and is said
     * out loud underneath, because a figure that quietly differs between two documents is found
     * later and assumed to be a bug.
     */
    const r = build();
    assert.equal(r.billedCents, 40_000, "the $50 cash plan is not billed to anybody");
    assert.equal(r.outstandingCents, 40_000);
    assert.equal(r.cashBilledCents, 5_000);
    assert.deepEqual(r.cashPlans.map((l) => l.name), ["RxLocal"]);
    assert.equal(r.lines.length, 2);
  });

  test("nothing is called late, however long it has been", () => {
    // No remittance cycle for any payer is on file. A deadline here would be one this pharmacy
    // invented and then believed, and printing it would not make it true.
    const r = build();
    assert.doesNotMatch(r.says, /\boverdue\b|days late|past due/i);
    assert.match(r.says, /none of this is called late/i, "it denies lateness rather than staying quiet about it");
    assert.match(r.says, /no remittance cycle/i);
    const text = arReportText(r, "West Wichita Family Pharmacy");
    assert.doesNotMatch(text, /\bdays late\b|past due/i);
    assert.match(text, /Nothing here is overdue/, "the one use of the word is the denial");
  });

  test("the printed report says the date it is as at and the day the books begin", () => {
    const r = build();
    const text = arReportText(r, "West Wichita Family Pharmacy");
    assert.match(text, /As at 2026-09-30/);
    assert.match(text, new RegExp(`Counted from ${SITE_STARTS_ON}`));
    assert.match(text, /ACCOUNTS RECEIVABLE — SEPTEMBER 2026/);
    assert.match(text, /West Wichita Family Pharmacy/);
  });

  test("the printed report carries no patient, and says so", () => {
    /*
     * Not a thing the test can prove by absence — it can only prove that nothing on the page is
     * built from a patient. What it can check is that the document tells its reader which axes it
     * is on, so a request for "the same thing by patient" is answered before it is made.
     */
    const r = build();
    const text = arReportText(r, "West Wichita Family Pharmacy");
    assert.match(text, /No patient appears on this report/);
    const csv = arReportCsv(r);
    assert.doesNotMatch(csv.split("\r\n")[0], /patient|birth|member/i);
  });

  test("a month still running is marked as not a month end", () => {
    const summary = owedByPayer(receivables, [], "2026-09-11");
    const r = arReport("2026-09", monthWindow("2026-09", "2026-09-11"), summary);
    assert.equal(r.complete, false);
    assert.match(arReportText(r, "the pharmacy"), /has not finished/);
  });

  test("the spreadsheet holds money as a number an accountant can add up", () => {
    /*
     * The one place on this site that does not use formatCents. A dollar sign and a thousands
     * separator turn the column somebody wants to total into text, and then the total at the foot
     * of their sheet is blank and nobody can see why.
     */
    const r = build();
    const rows = arReportCsv(r).trim().split("\r\n");
    assert.equal(rows[0], "Payer,BIN,Claims,Billed,Received,Outstanding,Oldest claim filled,Days waiting,Where it stands");
    assert.match(rows[1], /,300\.00,/, "$300.00 as 300.00, with no dollar sign and no comma inside it");
    assert.match(rows[rows.length - 1], /^Total,,2,400\.00,0\.00,400\.00,/);
  });

  test("a payer name containing a comma does not split the spreadsheet into the wrong columns", () => {
    const summary = owedByPayer([bill({ bin: null, name: 'Humana, Inc. "Gold"' })], [], asAt);
    const r = arReport("2026-09", monthWindow("2026-09", "2026-10-02"), summary);
    const row = arReportCsv(r).split("\r\n")[1];
    assert.ok(row.startsWith('"Humana, Inc. ""Gold""",'), `quoted and escaped, got: ${row}`);
  });

  describe("the payments tied to no claim, as the accountant's copy prints them", () => {
    /*
     * The printed block is the same sentence the Claims page and the owed page carry (untied-payments.ts), broken into lines
     * because an email body has no layout to wrap it. The figures are invented; what is pinned is that the copy says a payment
     * is tied to no claim and why, and never the old clause that called it nothing to fix.
     */
    const FEED = "2026-09-01";
    const buildWith = (received: Received[]) => {
      const summary = owedByPayer(receivables, received, asAt, FEED);
      const r = arReport("2026-09", monthWindow("2026-09", "2026-10-02"), summary);
      r.ageing = ageOutstanding(receivables, r.lines, asAt);
      return r;
    };
    const blockOf = (text: string): string[] => {
      const lines = text.split("\n");
      const at = lines.indexOf("PAYMENTS TIED TO NO CLAIM");
      assert.ok(at >= 0, "the block is there");
      assert.match(lines[at + 1], /^-+$/, "and underlined like the others");
      const body: string[] = [];
      for (const l of lines.slice(at + 2)) {
        if (l === "") break;
        body.push(l);
      }
      return body;
    };
    const strays = [
      paid({ matched: false, cents: 93_10, cause: "fits_several" }),
      paid({ matched: false, cents: 812_40, cause: "before_feed" }),
    ];

    test("the block carries the sentence the site says, wrapped to a mail window", () => {
      const r = buildWith(strays);
      const body = blockOf(arReportText(r, "West Wichita Family Pharmacy"));
      assert.ok(body.length > 1, "a sentence this long is broken across lines");
      assert.ok(body.every((l) => l.length <= 94 && l.startsWith("  ")), `no line wider than the window: ${body.map((l) => l.length).join(",")}`);
      assert.equal(body.map((l) => l.trim()).join(" "), r.unattachedSays, "nothing lost or reworded in the wrapping");
      assert.match(r.unattachedSays, /^2 payments \(net \$905\.50\) received since Sep 1, 2026 are tied to no claim, so they are in no payer's balance: /);
      assert.match(r.unattachedSays, /1 payment \(\$93\.10\) that fits two or more claims equally/);
      assert.match(r.unattachedSays, /show a balance without it\.$/, "a payment that fits claims on file leaves them looking owed until it is attached");
    });

    test("nothing is printed where nothing is tied to no claim", () => {
      const r = buildWith([paid()]);
      assert.equal(r.unattached.count, 0);
      assert.doesNotMatch(arReportText(r, "the pharmacy"), /PAYMENTS TIED TO NO CLAIM/);
    });

    test("a payment whose reason the loader did not read is counted and not explained", () => {
      const r = buildWith([paid({ matched: false, cents: 1_234_56 })]);
      assert.equal(r.unattachedSays, "1 payment ($1,234.56) received since Sep 1, 2026 is tied to no claim, so it is in no payer's balance.");
      assert.doesNotMatch(arReportText(r, "the pharmacy"), /fits two or more|before the claims feed/);
    });

    test("it never calls such a payment nothing to fix, whatever the reason", () => {
      const causes = ["fits_several", "reversed_sold", "no_claim_yet", "other_fills_only", "not_a_fill", "will_attach", "reversed_not_sold", "cancels_out", "before_feed"] as const;
      const r = buildWith(causes.map((cause, i) => paid({ matched: false, cents: 10_00 + i, cause })));
      const text = arReportText(r, "the pharmacy");
      assert.doesNotMatch(text, /MONEY THAT BELONGS TO NO CLAIM|not an error|nothing to fix|real money|from before its records begin|does not hold/i);
      assert.equal(blockOf(text).map((l) => l.trim()).join(" "), r.unattachedSays);
    });

    test("when nothing had been paid against these claims it says that, and not that no remittance had come", () => {
      // The unattached payment settles nothing, so every received figure is nought; but a remittance did reach the pharmacy.
      const r = buildWith([paid({ matched: false, cents: 812_40, cause: "before_feed" })]);
      assert.equal(r.nothingHasArrived, true);
      assert.match(r.says, /Nothing had been paid against any of these claims by that date/);
      assert.doesNotMatch(r.says, /no remittance has reached|reached the pharmacy/i);
      assert.match(arReportText(r, "the pharmacy"), /Nothing had been paid against any of these claims by that date/);
    });
  });
});

describe("when the monthly copy goes out on its own", () => {
  test("last month's report is due once the new month is a few days old", () => {
    /*
     * Not at one minute past midnight on the 1st. An 835 for September routinely arrives in the
     * first days of October carrying a September remittance date, and a report sent before they
     * land is missing money that is about to be counted in it — so the copy in the accountant's
     * file and the copy on the screen disagree within the week.
     */
    assert.equal(monthDueOn("2026-12-05"), "2026-11");
    assert.equal(monthDueOn("2026-12-28"), "2026-11");
    assert.equal(monthDueOn("2026-12-04"), "2026-10", "before the 5th, November's is not due yet");
  });

  test("the turn of the year does not lose a month", () => {
    assert.equal(monthDueOn("2027-01-06"), "2026-12");
    assert.equal(monthDueOn("2027-01-02"), "2026-11");
  });

  test("nothing is ever due for a month from before the books begin", () => {
    // October 2026, before the 5th, would otherwise ask for August — which is test data.
    assert.equal(monthDueOn("2026-10-02"), null);
    assert.equal(monthDueOn("2026-10-06"), "2026-09");
  });
});
