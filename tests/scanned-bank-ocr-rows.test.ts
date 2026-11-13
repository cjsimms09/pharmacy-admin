import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readRaw, type ScanItem } from "../src/lib/scanned-bank-statement";

/**
 * Four ways a recognised scan differs from a text layer, each of which refused September 2026's statement.
 *
 * August's statement came from the bank's own download with a text layer; September's was a forwarded scan
 * with none, recognised on this machine (`ocr.ts`). The words came back in the same frame, but recognition
 * wobbles where a text layer does not, and pages a text layer leaves out — the back page, the cheque images
 * — come through as words. Each case below is the shape the real scan produced, with invented figures.
 */

/** A row of cells at one baseline, in PDF points. */
const row = (page: number, y: number, cells: [number, string][]): ScanItem[] => cells.map(([x, text]) => ({ page, x, y, text }));

const heading = (page: number, y: number, words: string) => row(page, y, words.split(" ").map((w, i) => [70 + i * 40, w] as [number, string]));

describe("a recognised scan, read as a statement", () => {
  /*
   * The daily balance table is one page, and the cheque images follow it with no heading. Every scrap on
   * those pages used to land in the balances and the solver refused the month for being unable to put
   * "ANNA NR" in day order.
   */
  test("the balance table ends when its page does, unless the next page carries on with a balance", () => {
    const items = [
      ...heading(10, 700, "Daily Balance Summary"),
      ...row(10, 680, [[75, "9/01"], [156, "100,000.00"], [255, "9/11"], [336, "110,000.00"], [435, "9/22"], [516, "120,000.00"]]),
      ...row(10, 668, [[75, "9/02"], [156, "101,000.00"], [255, "9/14"], [336, "111,000.00"], [435, "9/30"], [516, "130,000.00"]]),
      /* The cheque-image page: no heading, recognised scraps, and one cheque's own date and amount. */
      ...row(11, 700, [[80, "ANNA"], [300, "NR"]]),
      ...row(11, 680, [[80, "SO"], [300, "EMPRISEBANK"]]),
      ...row(11, 660, [[430, "09/30/2026"], [520, "$14.48"]]),
    ];
    const raw = readRaw(items);
    assert.equal(raw.balances.length, 6);
    assert.ok(raw.balances.every((b) => b.page === 10));
  });

  test("a balance table that genuinely wraps keeps its second page", () => {
    const items = [
      ...heading(10, 700, "Daily Balance Summary"),
      ...row(10, 680, [[75, "9/01"], [156, "100,000.00"]]),
      ...row(11, 700, [[75, "9/02"], [156, "101,000.00"]]),
    ];
    assert.equal(readRaw(items).balances.length, 2);
  });

  test("a heading row inside the table is not a balance", () => {
    const items = [...heading(10, 700, "Daily Balance Summary"), ...row(10, 690, [[435, "Date"], [516, "Balance"]]), ...row(10, 680, [[75, "9/01"], [156, "100,000.00"]])];
    assert.equal(readRaw(items).balances.length, 1);
  });

  /*
   * The back page. Emprise prints its terms on the reverse of page one and a scan includes it as page two
   * with no heading, so the credits section ran on through thirty-three rows of prose about forged items.
   */
  test("the statement's back page is skipped whole", () => {
    const items = [
      ...heading(1, 700, "Deposits and Other Credits"),
      ...row(1, 680, [[75, "9/01"], [150, "700.17"], [202, "Deposit"]]),
      ...row(2, 700, [[75, "FOR"], [110, "CONSUMER"], [180, "ACCOUNTS"], [260, "ONLY:"], [300, "Please"], [340, "contact"]]),
      ...row(2, 680, [[75, "Balancing"], [150, "Your"], [190, "Checkbook"]]),
      ...row(2, 660, [[75, "Then:"], [120, "Compare"], [190, "and"], [220, "check"], [260, "off"]]),
      ...row(3, 700, [[75, "9/02"], [150, "800.27"], [202, "Prescription/"], [260, "TRANSFER"]]),
    ];
    const raw = readRaw(items);
    assert.deepEqual(
      raw.lines.map((l) => [l.dateText, l.amountText]),
      [
        ["9/01", "700.17"],
        ["9/02", "800.27"],
      ],
    );
  });

  /*
   * A description that wraps: the bank prints the amount level with the gap between the two lines and the
   * engine attaches it to the second. Read as two half-lines, neither had a date and an amount.
   */
  test("a credit whose amount landed on the row below is one line, with both description halves", () => {
    const items = [
      ...heading(4, 700, "Deposits and Other Credits"),
      ...row(4, 680, [[75, "9/10"], [202, "ACCESS"], [250, "HEALTH/ACCESS"], [330, "HEA"]]),
      ...row(4, 669, [[150, "21,000.87"], [202, "9990001"], [250, "West"], [280, "Wichita"]]),
      ...row(4, 650, [[75, "9/11"], [150, "50.00"], [202, "Deposit"]]),
    ];
    const raw = readRaw(items);
    assert.equal(raw.lines.length, 2);
    assert.equal(raw.lines[0].dateText, "9/10");
    assert.equal(raw.lines[0].amountText, "21,000.87");
    assert.match(raw.lines[0].description, /ACCESS HEALTH\/ACCESS HEA 9990001 West Wichita/);
  });

  test("the same split in the debits, as McKesson's ACH printed it", () => {
    const items = [
      ...heading(7, 700, "Debits and Other Withdrawals"),
      ...row(7, 680, [[75, "9/01"], [202, "MCKESSON"], [260, "DRUG/AUTO"], [320, "ACH"]]),
      ...row(7, 669, [[150, "118,000.72"], [202, "ACH9990001"], [280, "WEST"], [310, "WICHITA"]]),
    ];
    const raw = readRaw(items);
    assert.equal(raw.lines.length, 1);
    assert.equal(raw.lines[0].amountText, "118,000.72");
    assert.equal(raw.lines[0].credit, false);
  });

  test("a held date never completed is kept as a half-line, so the count can say something is missing", () => {
    const items = [...heading(4, 700, "Deposits and Other Credits"), ...row(4, 680, [[75, "9/10"], [202, "ACCESS"], [250, "HEALTH"]]), ...heading(4, 660, "Checks")];
    const raw = readRaw(items);
    assert.equal(raw.lines.length, 1);
    assert.equal(raw.lines[0].amountText, "");
  });

  /*
   * The checks table: a date that slipped five points below its number and amount, just past the four the
   * rows are grouped on. Two cheques dropped, two days that would not balance, and the cheque images at the
   * back of the statement showing both exactly as read here.
   */
  test("a cheque whose date slipped below its row is re-joined, in either column", () => {
    const items = [
      ...heading(7, 700, "Checks"),
      ...row(7, 680, [[79, "9/15"], [149, "9001"], [245, "50.79"], [367, "9/22"], [438, "9004"], [521, "5,000.00"]]),
      ...row(7, 669, [[149, "9002"], [233, "2,600.00"], [367, "9/22"], [438, "9005"], [534, "70.10"]]),
      ...row(7, 664, [[79, "9/04"]]),
      ...row(7, 658, [[149, "9003"], [233, "1,200.00"]]),
      ...row(7, 653, [[79, "9/08"]]),
    ];
    const checks = readRaw(items).lines.filter((l) => l.section === "checks");
    assert.deepEqual(
      checks.map((l) => [l.dateText, l.description, l.amountText]).sort(),
      [
        ["9/04", "CHECK 9002", "2,600.00"],
        ["9/08", "CHECK 9003", "1,200.00"],
        ["9/15", "CHECK 9001", "50.79"],
        ["9/22", "CHECK 9004", "5,000.00"],
        ["9/22", "CHECK 9005", "70.10"],
      ],
    );
  });

  /*
   * A purchase whose amount the scan lost. It used to fold into the previous purchase's description,
   * and the solver then had a day short by an exact figure and no line to put it on.
   */
  test("a card row with a date and a name but no amount is a half-line of its own", () => {
    const items = [
      ...heading(10, 700, "ATM/POS Transactions"),
      ...row(10, 680, [[75, "9/24"], [213, "8,000.00"], [278, "Purch"], [304, "SUPPLIER"]]),
      ...row(10, 669, [[278, "CA"], [292, "*****9999"], [340, "09/23"], [367, "01:49"]]),
      ...row(10, 658, [[75, "9/25"], [278, "Purch"], [304, "ANTHROPIC*"], [362, "CLAUDE"], [399, "SUB"]]),
      ...row(10, 647, [[278, "FRANCISCO"], [330, "CA"], [344, "*****9999"], [392, "09/24"]]),
      ...row(10, 636, [[75, "9/25"], [221, "100.00"], [278, "Purch"], [304, "STAMPS.COM"]]),
    ];
    const card = readRaw(items).lines.filter((l) => l.section === "card");
    assert.deepEqual(
      card.map((l) => [l.dateText, l.amountText]),
      [
        ["9/24", "8,000.00"],
        ["9/25", ""],
        ["9/25", "100.00"],
      ],
    );
    assert.match(card[1].description, /ANTHROPIC\* CLAUDE SUB FRANCISCO CA/);
    assert.doesNotMatch(card[0].description, /ANTHROPIC/);
  });

  /* The address footer on the card page, caught in the withdrawal column beside a date. */
  test("a card row whose amount has no digit is not a purchase", () => {
    const items = [
      ...heading(9, 700, "ATM/POS Transactions"),
      ...row(9, 680, [[75, "9/22"], [221, "100.00"], [278, "Purch"], [304, "STAMPS.COM"]]),
      ...row(9, 660, [[75, "9/25"], [221, "WICHITAKS"], [278, "60000-0000"], [340, "CA"]]),
    ];
    const card = readRaw(items).lines.filter((l) => l.section === "card");
    assert.equal(card.length, 1);
    assert.equal(card[0].amountText, "100.00");
  });
});
