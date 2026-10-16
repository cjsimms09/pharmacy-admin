import { test, describe, before } from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { HandTied, UntiedLine, UntiedPayments } from "../src/lib/untied-payments-store";
import * as pure from "../src/lib/untied-payments";
import type { ClaimBeside, UntiedCause, UntiedPayment } from "../src/lib/untied-payments";

/*
 * The payments-with-no-claim page as a person is shown it. The one press on it is the choice of the claim a payment that fits several claims paid
 * (tie-by-hand.ts); it is offered beside each claim that payment fits, to the owner and the pharmacist in charge, for no other group of payments,
 * and the payments chosen are listed with the name of who chose and the press that takes the choice back. Every value is invented.
 */
let PaymentsWithNoClaim: typeof import("../src/app/(app)/claims/no-claim/view").PaymentsWithNoClaim;

before(async () => {
  /* The project compiles JSX the classic way, which reads a global React the view does not import. */
  (globalThis as unknown as { React: typeof React }).React = React;
  ({ PaymentsWithNoClaim } = await import("../src/app/(app)/claims/no-claim/view"));
});

const BOOKS = "2026-09-01";
const noop = async () => {};
const beside = (id: string, o: Partial<ClaimBeside> = {}): ClaimBeside => ({ id, payerLabel: "Plan C", itemName: "Drug One", status: "paid", fillNumber: 1, dateFilled: "2026-09-05", remitCents: 5_000, soldOn: null, ...o });
const paid = (id: string, rxNumber: string, o: Partial<UntiedPayment> = {}): UntiedPayment => ({ id, source: "plan", payer: "A Plan", receivedOn: "2026-09-20", amountCents: 5_500, rxNumber, fillNumber: 1, dateFilled: "2026-09-05", ndc11: "00093000022", reference: null, ...o });
const lineOf = (p: UntiedPayment, cause: UntiedCause, claims: ClaimBeside[] = []): UntiedLine => ({ ...p, cause, claims, partner: null });
const handOf = (p: UntiedPayment, tiedBy: string, claim: ClaimBeside | null): HandTied => ({ ...p, tiedBy, claim });

function reading(lines: UntiedLine[]): UntiedPayments {
  const each = lines.map((l) => ({ cause: l.cause, amountCents: l.amountCents, source: l.source, receivedOn: l.receivedOn, dateFilled: l.dateFilled }));
  const tally = pure.tallyUntied(each);
  return {
    booksFrom: BOOKS,
    feedFrom: BOOKS,
    total: { count: lines.length, cents: lines.reduce((n, l) => n + l.amountCents, 0) },
    tally,
    beforeFeed: [],
    each,
    lines,
    headline: pure.untiedHeadline(tally, BOOKS, BOOKS),
  };
}

type Extra = { byHand?: HandTied[]; mayChoose?: boolean; ok?: string; error?: string };
const render = (r: UntiedPayments, o: Extra = {}) => renderToStaticMarkup(React.createElement(PaymentsWithNoClaim, { r, byHand: [], mayChoose: true, attach: noop, detach: noop, ...o }));
const times = (html: string, text: string) => html.split(text).length - 1;
const PRESS = "This is the claim it paid";

const several = lineOf(paid("pay-several", "940001"), "fits_several", [beside("claim-one"), beside("claim-two", { payerLabel: "Plan D", remitCents: 6_000 })]);
const soldAfterReversal = lineOf(paid("pay-reversed", "940002", { amountCents: 6_000 }), "reversed_sold", [beside("claim-rev", { status: "reversed", soldOn: "2026-09-06" })]);
const noClaim = lineOf(paid("pay-none", "940003", { dateFilled: "2026-09-08" }), "no_claim_yet");
const others = lineOf(paid("pay-others", "940004", { dateFilled: "2026-09-02" }), "other_fills_only", [beside("claim-other", { fillNumber: 2 })]);
const everyCause = reading([several, soldAfterReversal, noClaim, others]);

describe("the press on the payments-with-no-claim page", () => {
  test("a payment that fits several claims has a press beside each claim it fits, and no other payment has one", () => {
    const html = render(everyCause);
    assert.equal(times(html, PRESS), 2, "one press for each of the two claims");
    for (const claim of ["claim-one", "claim-two"]) assert.ok(html.includes(`name="payment" value="pay-several"/><input type="hidden" name="claim" value="${claim}"/>`), `the press beside ${claim} names this payment and this claim`);
    for (const other of ["pay-reversed", "pay-none", "pay-others"]) assert.equal(html.includes(`name="payment" value="${other}"`), false, `${other} has nothing to press`);
    for (const other of ["claim-rev", "claim-other"]) assert.equal(html.includes(`value="${other}"`), false, `a claim beside another group is not offered`);
  });

  test("a person who may not choose is shown the claims and told who can", () => {
    const html = render(everyCause, { mayChoose: false });
    assert.equal(times(html, PRESS), 0);
    assert.equal(html.includes('name="payment"'), false, "no form at all");
    assert.equal(times(html, "Only the owner or the pharmacist in charge can choose."), 1, "said once, for the one payment it is said of");
    assert.ok(html.includes("Plan C") && html.includes("Plan D"), "the claims are still listed");
  });

  test("the group says what it asks of him, in the words the matcher and the other screens use", () => {
    const html = render(everyCause);
    const asks = pure.causeInfo("fits_several", BOOKS).asks;
    assert.ok(html.includes(`<b>${pure.needsSays("decide")}.</b> ${asks}`));
    assert.match(asks, /^Pick the claim each one paid, on the Payments with no claim page\./);
    assert.equal(html.includes("Nothing on this page changes anything"), false);
    assert.equal(html.includes("cannot yet attach"), false);
    assert.ok(html.includes("The one thing to press here is the claim a payment that fits several claims paid"));
  });

  test("a result and a refusal are shown where he is looking, and not otherwise", () => {
    const quiet = render(everyCause);
    assert.equal(quiet.includes("border-crit bg-crit-soft"), false);
    const said = render(everyCause, { ok: "Attached the $55.00 received Sep 20, 2026 to the claim you chose.", error: "That claim is not one of the claims this payment fits." });
    assert.ok(said.includes("Attached the $55.00 received Sep 20, 2026 to the claim you chose."));
    assert.ok(said.includes("That claim is not one of the claims this payment fits."));
    assert.equal(times(said, "border-crit bg-crit-soft"), 1, "the refusal is the only red notice");
  });
});

describe("the payments attached by hand", () => {
  const rows = [
    handOf(paid("hand-one", "940010"), "Test Owner", beside("claim-ten", { payerLabel: "Plan D" })),
    handOf(paid("hand-two", "940011", { amountCents: 4_000, receivedOn: "2026-09-22" }), "Test Pharmacist", null),
  ];

  test("each is listed with the claim it was put on, who put it there, and a press that takes it back", () => {
    const html = render(everyCause, { byHand: rows });
    assert.ok(html.includes('id="by_hand"'));
    assert.ok(html.includes("2 payments · net $95.00"));
    assert.ok(html.includes("Test Owner") && html.includes("Test Pharmacist"));
    assert.ok(html.includes("The claim it was attached to is no longer on file."), "a claim that has gone from the site is said to have gone");
    assert.equal(times(html, "Take it back"), 2);
    for (const id of ["hand-one", "hand-two"]) assert.ok(html.includes(`<input type="hidden" name="payment" value="${id}"/>`));
  });

  test("a person who may not choose sees them and cannot take one back", () => {
    const html = render(everyCause, { byHand: rows, mayChoose: false });
    assert.ok(html.includes("Test Owner"));
    assert.equal(times(html, "Take it back"), 0);
  });

  test("with none attached there is no such card", () => {
    assert.equal(render(everyCause).includes('id="by_hand"'), false);
  });

  test("with nothing left to ask about, the page says so and still lists what he chose", () => {
    const nothing = reading([]);
    const bare = render(nothing);
    assert.ok(bare.includes("Every payment received since Sep 1, 2026 is tied to a claim."));
    assert.equal(bare.includes('id="by_hand"'), false);
    const kept = render(nothing, { byHand: rows });
    assert.ok(kept.includes("Every payment received since Sep 1, 2026 is tied to a claim."));
    assert.ok(kept.includes('id="by_hand"') && times(kept, "Take it back") === 2);
    assert.equal(kept.includes(pure.needsSays("decide")), false, "no group of payments is waiting for him");
  });
});
