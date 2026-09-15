import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { paginate, fit } from "../src/lib/driver-invoice-pdf";
import { textWidth } from "../src/lib/pdf";

/**
 * The invoice has to fit on the paper.
 *
 * This is the only document this system sends to somebody outside the pharmacy, and the failure
 * is invisible from the code: every block is drawn at a position, nothing complains when a
 * position is off the bottom of the sheet, and the first anybody knows is an accounts department
 * looking at an invoice with no total on it.
 *
 * The real months are all 20 to 23 weekdays, so the split never fires in practice. That is exactly
 * why it is tested here rather than by looking at a page — the case that breaks it is the one
 * nobody will ever see until it happens.
 */

// The table starts lower on the first page, which also carries the masthead, the parties and the
// summary; a continuation page has only the masthead above it.
const FIRST = 529;
const CONT = 605;

describe("splitting the days across sheets", () => {
  test("a normal month is one sheet", () => {
    for (const days of [20, 21, 22, 23]) {
      assert.deepEqual(paginate(days, FIRST, CONT), [days], `${days} weekdays`);
    }
  });

  test("every day appears exactly once, whatever the count", () => {
    for (let n = 1; n <= 80; n++) {
      const sizes = paginate(n, FIRST, CONT);
      assert.equal(
        sizes.reduce((a, b) => a + b, 0),
        n,
        `${n} rows split into ${sizes.join("+")}`,
      );
      assert.ok(sizes.every((s) => s > 0), `${n} rows produced an empty sheet: ${sizes.join("+")}`);
    }
  });

  test("no sheet is given more rows than it has room for", () => {
    // The floor a page is measured against differs: the last one also carries the totals and the
    // amount due, so it holds fewer rows than a page that continues overleaf.
    const ROW = 14;
    const LAST_FLOOR = 206;
    const CONT_FLOOR = 148;
    for (let n = 1; n <= 80; n++) {
      const sizes = paginate(n, FIRST, CONT);
      sizes.forEach((rows, i) => {
        const top = i === 0 ? FIRST : CONT;
        const floor = i === sizes.length - 1 ? LAST_FLOOR : CONT_FLOOR;
        const room = Math.floor((top - floor) / ROW) + 1;
        assert.ok(rows <= room, `page ${i + 1} of ${n} rows: ${rows} rows in room for ${room}`);
      });
    }
  });

  test("the last sheet is never left with an orphan row or two", () => {
    // A final page carrying one day and the total reads as a mistake, and invites the reader to
    // wonder what else is missing.
    for (let n = 25; n <= 80; n++) {
      const sizes = paginate(n, FIRST, CONT);
      if (sizes.length > 1) assert.ok(sizes[sizes.length - 1] >= 5, `${n} rows ended with ${sizes.at(-1)}`);
    }
  });

  test("a month with nothing in it still produces a sheet", () => {
    assert.deepEqual(paginate(0, FIRST, CONT), [0]);
  });
});

describe("the note on a day with no trips", () => {
  const WIDTH = 238;

  test("a short reason is left exactly as written", () => {
    assert.equal(fit("Pharmacy closed", 8.5, WIDTH), "Pharmacy closed");
  });

  test("a long one is cut to the room it has, and says it was cut", () => {
    const long = "Pharmacy closed for the Thanksgiving holiday and the whole of the following day as well";
    const out = fit(long, 8.5, WIDTH);
    assert.ok(textWidth(out, 8.5) <= WIDTH, `${textWidth(out, 8.5)} > ${WIDTH}`);
    assert.ok(out.endsWith("…"));
    assert.ok(long.startsWith(out.slice(0, -1).trimEnd()));
  });

  test("a note typed across two lines does not become two lines on the invoice", () => {
    assert.equal(fit("Closed\n  for the day", 8.5, WIDTH), "Closed for the day");
  });

  test("no room means nothing rather than a stray ellipsis over the figures", () => {
    assert.equal(fit("anything", 8.5, 0), "");
  });
});
