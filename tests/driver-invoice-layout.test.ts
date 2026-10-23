import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { paginate, fit, draftNoteLines, DRAFT_NOTE_W } from "../src/lib/driver-invoice-pdf";
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

/**
 * What a draft says about how much of the month is in.
 *
 * It sits beside the AMOUNT DUE box, in the blank the layout was already wasting to its left, and
 * that blank is 176 points wide and three lines tall. Two things can go wrong there and neither is
 * visible on the generated page: a sentence longer than the space, silently trimmed to its first
 * three lines, and a sentence wide enough to run under the box.
 *
 * The September 2026 draft did the first. It printed "...it is numbered and sent once the last is"
 * and stopped — on the one document this system sends outside the pharmacy.
 */
describe("the draft's note about the month so far", () => {
  const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

  test("it is never cut off, for any month and any number of days entered", () => {
    for (const name of MONTHS) {
      const month = `${name} 2026`;
      for (let weekdays = 19; weekdays <= 23; weekdays++) {
        for (let entered = 0; entered <= weekdays; entered++) {
          const lines = draftNoteLines(entered, weekdays, month);
          if (lines.length === 0) continue; // left off rather than trimmed: allowed, and tested below
          const sentence = lines.join(" ");
          assert.ok(sentence.endsWith("."), `${month}, ${entered}/${weekdays}: "${sentence}"`);
          assert.ok(lines.length <= 3, `${month}, ${entered}/${weekdays}: ${lines.length} lines`);
        }
      }
    }
  });

  test("every line fits the width it is given, so none can run under the total", () => {
    for (let entered = 0; entered <= 22; entered++) {
      for (const line of draftNoteLines(entered, 22, "September 2026")) {
        assert.ok(textWidth(line, 8) <= DRAFT_NOTE_W + 0.5, `"${line}" is ${textWidth(line, 8).toFixed(1)} wide`);
      }
    }
  });

  test("a full month says so rather than counting nought days still to come", () => {
    const lines = draftNoteLines(22, 22, "September 2026");
    assert.match(lines.join(" "), /^All 22 weekdays/);
    assert.doesNotMatch(lines.join(" "), /still to come/);
  });

  /*
   * The space is too narrow for the sentence, which is what the short form is for. Rather than
   * trim, it steps down; rather than trim the short form, it gives up the note altogether. A draft
   * with no note is quieter; a draft with half a sentence on it is an invoice somebody queries.
   */
  test("a width too small for the full sentence steps down instead of trimming", () => {
    const narrow = draftNoteLines(21, 22, "September 2026", 90);
    assert.ok(narrow.length === 0 || narrow.join(" ").endsWith("."), `"${narrow.join(" ")}"`);
    assert.ok(narrow.length <= 3);
  });

  test("a width too small for either form leaves the note off rather than printing part of one", () => {
    assert.deepEqual(draftNoteLines(21, 22, "September 2026", 24), []);
  });
});
