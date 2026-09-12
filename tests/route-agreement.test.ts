import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { agreementOf, agreementOfAll, BOOKS_FIGURES, type Route } from "../src/lib/route-agreement";

/**
 * The check none of the others could have made.
 *
 * Everything else in this site compares it to something outside itself. This compares two of its own
 * answers, which is the shape of every fault found on this branch in a week — and in each of them
 * nothing external disagreed, so whichever page you happened to read was the answer you got.
 *
 * The interesting states are four, not two, and most of these tests are about the two in the middle:
 * one route answering is not agreement, and neither answering is not a clean bill.
 */

const books = (figures: Route["figures"]): Route => ({ name: "the books", figures });
const chart = (figures: Route["figures"]): Route => ({ name: "the chart", figures });

describe("two routes, one answer", () => {
  test("agreement is stated with the figure, not just asserted", () => {
    const a = agreementOf("August, accrual", [books({ revenueCents: 10_621_418 }), chart({ revenueCents: 10_621_418 })], [{ key: "revenueCents", what: "Revenue" }]);
    assert.equal(a.state, "agreed");
    assert.match(a.figures[0].says, /2 routes, one answer — \$106,214\.18/);
  });
});

describe("two routes, two answers — the fault this exists to catch", () => {
  test("the real one: the books and the chart differ by the fills carried in from the month before", () => {
    // Measured on seeded rows: a month asked for on its own loads through a narrower window than the
    // same month asked for inside a strip, so the carried-in fills are in one answer and not the other.
    const a = agreementOf(
      "September, accrual",
      [books({ revenueCents: 10_621_418 }), chart({ revenueCents: 10_720_308 })],
      [{ key: "revenueCents", what: "Revenue" }],
    );
    assert.equal(a.state, "disagreed");
    assert.equal(a.figures[0].spreadCents, 98_890);
    assert.match(a.figures[0].says, /the chart says \$107,203\.08 and the books says \$106,214\.18 — \$988\.90 apart/);
    assert.match(a.figures[0].says, /the page you happen to read decides which answer you get/);
  });

  test("one cent apart is a disagreement, because there is nothing here to round", () => {
    const a = agreementOf("A month", [books({ revenueCents: 1 }), chart({ revenueCents: 2 })], [{ key: "revenueCents", what: "Revenue" }]);
    assert.equal(a.state, "disagreed");
    assert.equal(a.figures[0].spreadCents, 1);
  });

  test("three routes, and the spread is between the furthest apart", () => {
    const a = agreementOf(
      "A month",
      [books({ revenueCents: 100 }), chart({ revenueCents: 500 }), { name: "the claims page", figures: { revenueCents: 300 } }],
      [{ key: "revenueCents", what: "Revenue" }],
    );
    assert.equal(a.figures[0].spreadCents, 400);
    assert.equal(a.figures[0].answers.length, 3);
  });
});

describe("one route answering is not agreement", () => {
  test("it is named as unchecked, in those words", () => {
    const a = agreementOf("August", [books({ revenueCents: 500 }), chart({ revenueCents: null })], [{ key: "revenueCents", what: "Revenue" }]);
    assert.equal(a.state, "asked_once");
    assert.match(a.figures[0].says, /only the books answered, so this figure stands unchecked\. One answer is not agreement/);
  });

  test("and the summary never calls that state agreement", () => {
    const a = agreementOf(
      "August",
      [books({ revenueCents: 500, netProfitCents: 100 }), chart({ revenueCents: null, netProfitCents: 100 })],
      [{ key: "revenueCents", what: "Revenue" }, { key: "netProfitCents", what: "The bottom line" }],
    );
    assert.match(a.says, /1 figure was answered by only one route and stands unchecked/);
    assert.doesNotMatch(a.says, /every figure agrees across every route/);
  });

  test("nobody answering is a question nobody asked, not a clean bill", () => {
    const a = agreementOf("August", [books({ revenueCents: null }), chart({ revenueCents: null })], [{ key: "revenueCents", what: "Revenue" }]);
    assert.equal(a.state, "unasked");
    assert.match(a.says, /nothing was asked, so nothing was checked/);
  });
});

describe("the books' figures, and every question at once", () => {
  test("all five figures are watched, so a disagreement anywhere is caught", () => {
    assert.deepEqual(BOOKS_FIGURES.map((f) => f.key), ["revenueCents", "costOfGoodsCents", "grossProfitCents", "netProfitCents", "scripts"]);
  });

  test("the worst question sorts first and is named", () => {
    const fine = agreementOf("July", [books({ revenueCents: 1 }), chart({ revenueCents: 1 })], [{ key: "revenueCents", what: "Revenue" }]);
    const broken = agreementOf("September", [books({ revenueCents: 1 }), chart({ revenueCents: 2 })], [{ key: "revenueCents", what: "Revenue" }]);
    const all = agreementOfAll([fine, broken]);
    assert.equal(all.state, "disagreed");
    assert.equal(all.rows[0].question, "September");
    assert.match(all.says, /1 question the site answers two ways gives two answers: September/);
  });

  test("nothing compared is reported as nothing compared", () => {
    assert.match(agreementOfAll([]).says, /No question has been asked two ways/);
  });
});
