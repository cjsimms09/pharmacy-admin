import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { triageByText, shouldRead, estimateTriageCost } from "../src/lib/contract-triage";

/** Sorting the folder for free, by a document's own words, before anything is paid for. */
describe("sorting by the text layer", () => {
  const contract = `PHARMACY NETWORK AGREEMENT. This Agreement is made between Example PBM and the participating pharmacy.
    WHEREAS the pharmacy wishes to participate in the network... Reimbursement for generic drugs shall be the lesser of MAC or AWP minus 25% plus a dispensing fee of $1.00.
    Exhibit B sets out the rate schedule. BIN 610455 PCN EXPCN. Effective date January 1, 2026. IN WITNESS WHEREOF the parties have executed this Agreement.`;
  const w9 = `Form W-9 Request for Taxpayer Identification Number and Certification. Give Form to the requester. Do not send to the IRS. Name (as shown on your income tax return). Business name. Check appropriate box for federal tax classification. Address. City, state, and ZIP code. Taxpayer Identification Number. Signature of U.S. person. Date. Purpose of Form. An individual or entity who is required to file an information return with the IRS must obtain your correct taxpayer identification number.`;
  const notice = `IMPORTANT NOTICE. This letter is to inform you of a change to your network reimbursement rates effective March 1, 2026. Generic effective rate changes from AWP-82% to AWP-84%. Please retain this notification for your records. Questions: provider relations.`;
  const newsletter = `Pharmacy Connect Newsletter, Spring edition. Welcome to our quarterly newsletter! In this issue: immunization season tips, a webinar on inventory best practices, staff spotlight, and a message from our president. To unsubscribe from this newsletter reply STOP. Thank you for your continued partnership and support of our community programs throughout the region this year.`;

  test("an agreement with pricing is a contract", () => {
    const t = triageByText(contract, "download(1).pdf")!;
    assert.equal(t.kind, "contract");
    assert.ok(t.confidence >= 0.8);
  });
  test("a W-9 is not relevant, and says why", () => {
    const t = triageByText(w9, "download(7).pdf")!;
    assert.equal(t.kind, "not_relevant");
    assert.match(t.why, /form, statement or mailing/);
  });
  test("a rate-change letter is a notice", () => {
    assert.equal(triageByText(notice, "letter.pdf")!.kind, "notice");
  });
  test("a newsletter is not relevant; a newsletter named like a contract is read anyway", () => {
    assert.equal(triageByText(newsletter, "spring.pdf")!.kind, "not_relevant");
    assert.notEqual(triageByText(newsletter, "Rate Exhibit 2026.pdf")!.kind, "not_relevant", "the file name is evidence too");
  });
  test("a scan has no text to sort by", () => {
    assert.equal(triageByText("", "scan.pdf"), null);
    assert.equal(triageByText("page 1 of 3", "scan.pdf"), null);
  });
  test("only not_relevant is skipped by the read", () => {
    assert.equal(shouldRead("not_relevant"), false);
    assert.equal(shouldRead("unsure"), true);
    assert.equal(shouldRead(null), true);
    assert.equal(shouldRead("contract"), true);
  });
  test("a sort costs a fraction of a read", () => {
    // Twelve pages: 30,000 tokens in at $0.40/M batch is 1.2 cents; the answer is nothing.
    const c = estimateTriageCost(12);
    assert.ok(c > 0.01 && c < 0.02, String(c));
  });
});
