import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { dueDateFrom } from "../src/lib/invoice-due-date";

/*
 * The day an invoice says it will be paid. Parmed's layout, with every number invented: the terms line and the due date
 * sit beside the invoice date, and only the date after the DUE DATE label is the answer.
 */
const parmed = [
  "ParMed Pharmaceuticals                          INVOICE",
  "INVOICE NO   7480000001      INVOICE DATE   09/11/2026",
  "PAYMENT TERMS : Semi mthly 15/EOM Due 10/25 NM",
  "DUE DATE     10/10/2026",
  "TOTAL DUE                                        86.87",
].join("\n");

describe("the due date an invoice prints", () => {
  test("Parmed's invoice names the day, and that is what is read", () => {
    assert.equal(dueDateFrom(parmed), "2026-10-10");
  });

  test("the terms line is not a date: 'Semi mthly 15/EOM Due 10/25' names no year and is not read", () => {
    const termsOnly = parmed.split("\n").filter((l) => !/^DUE DATE/.test(l)).join("\n");
    assert.equal(dueDateFrom(termsOnly), null);
  });

  test("the invoice date beside it is never taken as the due date", () => {
    assert.notEqual(dueDateFrom(parmed), "2026-09-11");
  });

  test("an invoice that prints no due date says nothing, which is not 'due now'", () => {
    assert.equal(dueDateFrom("INVOICE 123\nTOTAL DUE 100.00\n"), null);
  });

  test("the label is read however it is spelled and spaced", () => {
    assert.equal(dueDateFrom("Due Date: 3/5/2027"), "2027-03-05");
    assert.equal(dueDateFrom("DATE DUE   12-31-2026"), "2026-12-31");
    assert.equal(dueDateFrom("Due date 2026-11-02"), "2026-11-02");
  });

  test("a two-digit year is this century", () => {
    assert.equal(dueDateFrom("DUE DATE 10/10/26"), "2026-10-10");
  });

  test("a date that does not exist is a misread of the columns, not a due date", () => {
    assert.equal(dueDateFrom("DUE DATE 09/31/2026"), null);
    assert.equal(dueDateFrom("DUE DATE 13/01/2026"), null);
  });

  test("a year outside these books is refused rather than stored", () => {
    assert.equal(dueDateFrom("DUE DATE 10/10/1926"), null);
    assert.equal(dueDateFrom("DUE DATE 10/10/2126"), null);
  });

  test("a value on the next line is read: a PDF's text layer breaks one printed line into runs", () => {
    // How Parmed's invoices actually extract. Requiring the same line read nothing off any of the six.
    assert.equal(dueDateFrom("DUE DATE\n10/10/2026"), "2026-10-10");
    assert.equal(dueDateFrom("DUE DATE   \r\n   10/10/2026   "), "2026-10-10");
  });

  test("anything but spacing between the label and a date means the date belongs to another column", () => {
    assert.equal(dueDateFrom("DUE DATE   SHIP DATE   09/11/2026"), null);
    assert.equal(dueDateFrom("DUE DATE\nTOTAL 86.87\n10/10/2026"), null);
  });
});
