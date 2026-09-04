import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { classifyInvoiceText } from "../src/lib/invoices";

/**
 * Reading the schedule the wholesaler already printed.
 *
 * These lines are in the shape a McKesson invoice actually prints — the pharmacy's own three
 * sample invoices were used to get the columns right, and the item classes here are the ones
 * those invoices carried: R against ordinary legend drugs, X against every Schedule II, and B, D
 * or E against the Schedule III to V lines. Drug names and numbers are invented; the layout is
 * not.
 *
 * The point of doing this with a rule rather than a model is that the answer is the same every
 * time and can be pinned here. The point of the tests is the asymmetry: the only outcome that
 * actually matters is that a Schedule II invoice is never filed as anything else.
 */

const head = [
  "Billing No.:7656147106",
  "Billing Date:09/04/2026",
  "Invoice",
  "MCKESSON CORPORATION DC#8165Phone:  855/625-7385",
  "AWP ORRUNITIEXTENDED   H",
  "NDC/UPC/UDI#ITEM#DEL DOC#QTYUM    ITEM DESCRIPTIONRETAIL XPRICEDAMOUNT   M",
].join("\n");

const line = (ndc: string, desc: string, awp: string, cls: string) =>
  `${ndc}257-9894973485930            1 EA ${desc}      ${awp} ${cls}      739.11        739.11 `;

const invoice = (...lines: string[]) => [head, ...lines, "SUMMARY"].join("\n");

describe("an invoice with no controlled substances", () => {
  const text = invoice(
    line("00002-1436-11", "EMGALITY INJ PEN 120MG/ML 1", "916.73", "R"),
    line("24208-0463-25", "LATANOPROST OPH.005% B&L2.5ML@", "24.38", "R"),
    line("00169-6339-10", "NOVOLOG F/PEN PREF SYR 3ML   5", "167.65", "R"),
  );

  test("is filed as ordinary business records", () => {
    const v = classifyInvoiceText(text);
    assert.equal(v.schedule, "none");
    assert.equal(v.confident, true);
  });

  test("and its supplier, number and date are read off it", () => {
    const v = classifyInvoiceText(text);
    assert.match(v.supplier ?? "", /MCKESSON/i);
    assert.equal(v.invoiceNumber, "7656147106");
    assert.equal(v.invoiceDate, "2026-09-04");
  });
});

describe("an invoice carrying Schedule III to V only", () => {
  const text = invoice(
    line("00228-2031-96", "ALPRAZOL TAB 1MG    ACTA 1000@", "1,079.00", "D"),
    line("62756-0970-83", "BUPRE+NAL HCI DISU 8/2MGSUN30@", "312.64", "B"),
    line("69238-1312-09", "PREGABALIN CP 75MG AMN 90@", "758.47", "E"),
    line("00002-1436-11", "EMGALITY INJ PEN 120MG/ML 1", "916.73", "R"),
  );

  test("is filed apart, but not with the Schedule IIs", () => {
    const v = classifyInvoiceText(text);
    assert.equal(v.schedule, "schedule_3_5");
    assert.equal(v.confident, true);
  });

  test("and lists the controlled lines, so nobody has to reopen the PDF", () => {
    const v = classifyInvoiceText(text);
    assert.equal(v.controlledItems.length, 3);
    assert.match(v.controlledItems.join(" "), /ALPRAZOL/);
    assert.ok(!v.controlledItems.join(" ").includes("EMGALITY"));
  });
});

describe("an invoice carrying a Schedule II line", () => {
  const text = invoice(
    line("70010-0029-01", "AMPHET MIX SLT ERCP5MGGRAN100@", "720.00", "X"),
    line("00406-0522-01", "OXYCOD+ACE TB 7.5/325 SGX 100@", "271.54", "X"),
  );

  test("goes to the Schedule II records", () => {
    const v = classifyInvoiceText(text);
    assert.equal(v.schedule, "schedule_2");
    assert.equal(v.confident, true);
  });

  test("one Schedule II line among many is still a Schedule II invoice", () => {
    const mixed = invoice(
      line("00002-1436-11", "EMGALITY INJ PEN 120MG/ML 1", "916.73", "R"),
      line("00228-2031-96", "ALPRAZOL TAB 1MG    ACTA 1000@", "1,079.00", "D"),
      line("00406-0522-01", "OXYCOD+ACE TB 7.5/325 SGX 100@", "271.54", "X"),
    );
    assert.equal(classifyInvoiceText(mixed).schedule, "schedule_2");
  });
});

describe("everything the rule refuses to decide", () => {
  test("an item class it does not recognise is never read as uncontrolled", () => {
    const v = classifyInvoiceText(invoice(line("00002-1436-11", "SOMETHING NEW 10MG", "916.73", "Q")));
    assert.equal(v.schedule, "unknown");
    assert.equal(v.confident, false);
  });

  test("a document with no readable item lines is unknown, not empty", () => {
    const v = classifyInvoiceText("a scanned page with nothing on it that parses");
    assert.equal(v.schedule, "unknown");
    assert.equal(v.confident, false);
  });

  test("a CSOS order number with nothing marked controlled is a disagreement, and goes to a person", () => {
    const text = invoice(
      line("00002-1436-11", "EMGALITY INJ PEN 120MG/ML 1", "916.73", "R"),
      "CSOS ID - 26X100208                         ",
    );
    const v = classifyInvoiceText(text);
    assert.equal(v.schedule, "unknown");
    assert.equal(v.confident, false);
    assert.match(v.basis, /CSOS/);
  });
});
