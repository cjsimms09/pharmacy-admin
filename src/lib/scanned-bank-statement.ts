/**
 * Emprise Bank's monthly statement, read from the scan it arrives as.
 *
 * The owner, 15 September 2026: the bank cannot export a CSV, a QFX or an OFX. The statement is a scanned
 * PDF with an optical-recognition text layer, and it is the only proof of cash the pharmacy has.
 *
 * ── Why this cannot trust any single figure ──
 *
 * The August statement's text layer turns letters into digits and digits into letters — "t4,642.54",
 * "22s.22", "8/0s", "qa4" — and it also turns digits into other digits. Its summary reads withdrawals of
 * $552,649.93, perfectly clean, and they are $662,649.93: the opening $322,820.45 and deposits of $681,761.07
 * reach the closing $341,931.59 only with that. A figure that looks clean is not therefore right. (An earlier
 * note here blamed the deposits figure; the lines, proved day by day, showed it was the withdrawals.)
 *
 * So nothing here is read; it is solved. The statement says the same money four ways — every line, the
 * section counts and totals in the summary, a closing balance for every day that had activity, and the
 * opening and closing balances — and a reading is accepted only where they agree. What the scan leaves
 * genuinely undecided is listed for a person, with the page and the characters the scan printed.
 *
 * This file is the geometry: rows rebuilt from where each word sits, and the statement's sections found.
 * Pure.
 */

export type ScanItem = { page: number; x: number; y: number; text: string };
export type ScanRow = { page: number; y: number; cells: { x: number; text: string }[] };

export type SectionName = "summary" | "credits" | "checks" | "debits" | "card" | "balances";

export type RawLine = {
  section: Exclude<SectionName, "summary" | "balances">;
  page: number;
  /** As the scan printed them. */
  dateText: string;
  amountText: string;
  /** Card purchases have deposits and withdrawals in separate columns; everything else by section. */
  credit: boolean;
  description: string;
};

export type RawBalance = { page: number; column: number; dateText: string; balanceText: string };

export type RawSummary = {
  beginningText: string | null;
  endingText: string | null;
  creditsCountText: string | null;
  creditsText: string | null;
  debitsCountText: string | null;
  debitsText: string | null;
  statementDateText: string | null;
};

export type RawStatement = { lines: RawLine[]; balances: RawBalance[]; summary: RawSummary };

/** Words on one printed line: the same page, within a few points of the same height. */
export function rowsOf(items: ScanItem[]): ScanRow[] {
  const rows: ScanRow[] = [];
  const pages = [...new Set(items.map((i) => i.page))].sort((a, b) => a - b);
  for (const page of pages) {
    const list = items.filter((i) => i.page === page && i.text.trim()).sort((a, b) => b.y - a.y || a.x - b.x);
    let current: ScanRow | null = null;
    for (const it of list) {
      if (!current || Math.abs(current.y - it.y) > 4) {
        current = { page, y: it.y, cells: [] };
        rows.push(current);
      }
      current.cells.push({ x: it.x, text: it.text.trim() });
    }
    for (const r of rows) if (r.page === page) r.cells.sort((a, b) => a.x - b.x);
  }
  return rows;
}

const squash = (r: ScanRow) => r.cells.map((c) => c.text).join("").replace(/\s+/g, "");
const between = (r: ScanRow, from: number, to: number) => r.cells.filter((c) => c.x >= from && c.x < to).map((c) => c.text).join("");
const words = (r: ScanRow, from: number, to = Infinity) => r.cells.filter((c) => c.x >= from && c.x < to).map((c) => c.text).join(" ");

/*
 * Section headings as the scan spells them: "DeposiB and Other Credits", "Daily Salance Summary". Matched on
 * the squashed row, loosely, and only a row that is nothing but the heading.
 */
function headingOf(r: ScanRow): SectionName | null {
  const s = squash(r).toLowerCase();
  if (s.length > 40) return null;
  if (/^summaryofactivity/.test(s)) return "summary";
  if (/^depos.{0,3}and.?other.?c/.test(s)) return "credits";
  if (/^checks$/.test(s)) return "checks";
  if (/^debit.{0,3}and.?other.?w/.test(s)) return "debits";
  if (/^atm\/?pos.?trans/.test(s)) return "card";
  if (/^daily.?.alance.?summary/.test(s)) return "balances";
  return null;
}

/** A column-heading row, a page header or footer: nothing to read. */
function isFurniture(r: ScanRow): boolean {
  const s = squash(r).toLowerCase();
  return (
    /^date(amount|check|deposi|balance|activity)/.test(s) ||
    /^amount$/.test(s) ||
    /^page\d*of/.test(s) ||
    /account.?n.mber/.test(s) ||
    /^(west|82o|wichita|w.chita|wrch|wich|tiich)/.test(s) && !/^\S*\d{1,2}\S?\d{2}/.test(s) && r.cells[0].x > 180 ||
    /notice.?see.?reverse/.test(s) ||
    /indicates.?a.?break/.test(s)
  );
}

/**
 * The statement's rows sorted into its sections, every figure still as the scan printed it.
 *
 * Column boundaries are the August statement's, measured: dates start near x=70, line amounts end before
 * x=190, descriptions start near x=197. Card purchases put deposits near x=128 and withdrawals near x=210.
 */
export function readRaw(items: ScanItem[]): RawStatement {
  const rows = rowsOf(items);
  const lines: RawLine[] = [];
  const balances: RawBalance[] = [];
  const summary: RawSummary = { beginningText: null, endingText: null, creditsCountText: null, creditsText: null, debitsCountText: null, debitsText: null, statementDateText: null };
  let section: SectionName | null = null;
  /** The page the daily balance table is on, once it has started. See the balances branch. */
  let balancesPage: number | null = null;
  let pendingAmountWithoutDate: RawLine | null = null;
  /** A credit or debit row whose amount is printed on the row below. See the credits branch. */
  let heldDate: RawLine | null = null;
  /** A cheque whose date slipped below its number and amount, per column of the checks table. */
  const heldCheck: [RawLine | null, RawLine | null] = [null, null];
  /* A held row never completed is a half-line, kept so the count against the summary can say so. */
  const flushHeld = () => {
    if (heldDate) lines.push(heldDate);
    heldDate = null;
  };

  /*
   * The statement's back page is not part of the statement.
   *
   * Emprise prints its terms on the reverse of page one — "FOR CONSUMER ACCOUNTS ONLY", the chequebook
   * worksheet — and a scan includes it as page two with no heading of its own. The section in force
   * at the foot of page one, credits, carried on through thirty-three rows of prose about forged
   * items and investigation periods, each read as a credit with no date and no amount, and the solver
   * refused the whole statement for them. A page carrying that heading is skipped whole.
   */
  const boilerplate = new Set(rows.filter((r) => /forconsumeraccounts|balancingyourcheckbook/.test(squash(r).toLowerCase())).map((r) => r.page));

  for (const r of rows) {
    if (boilerplate.has(r.page)) continue;
    const h = headingOf(r);
    if (h) {
      section = h;
      continue;
    }
    const s = squash(r);
    if (!summary.statementDateText && /^Date:/i.test(r.cells.find((c) => c.x > 400)?.text ?? "")) {
      const after = r.cells.filter((c) => c.x > 500).map((c) => c.text).join("");
      if (after) summary.statementDateText = after;
    }
    if (!section || isFurniture(r)) continue;

    if (section === "summary") {
      const label = words(r, 0, 290).toLowerCase().replace(/\s+/g, "");
      const figure = between(r, 390, 470);
      const count = between(r, 300, 380);
      if (/^beginning/.test(label)) summary.beginningText = figure;
      else if (/^ending/.test(label) || /^\*+ending/.test(label)) summary.endingText = figure;
      else if (/^depos/.test(label)) {
        summary.creditsCountText = count;
        summary.creditsText = figure;
      } else if (/^withdraw/.test(label)) {
        summary.debitsCountText = count;
        summary.debitsText = figure;
      }
      continue;
    }

    if (section === "balances") {
      /*
       * The table ends when the page does, unless the next page carries on with a balance row.
       *
       * September 2026's statement prints the daily balances on page 10 and the images of the month's
       * cheques on pages 11 and 12. No heading opens the image pages, so the section stayed "balances" and
       * swept their recognised scraps in — "ANNA NR", "SO EMPRISEBANK", a cheque's own "09/30/2026 $14.48"
       * — forty-eight rows of nothing after a perfect twenty-one, and the solver, asked to put them in day
       * order, refused the whole statement. A table that genuinely wraps starts its next page with a
       * date and a balance, which is the one case the page turn is allowed to pass.
       */
      if (balancesPage !== null && r.page !== balancesPage) {
        const continues = r.cells.some((c) => /^\d{1,2}\/\d{2}$/.test(c.text)) && r.cells.some((c) => /\d[\d,]*\.\d{2}$/.test(c.text));
        if (!continues) {
          section = null;
          continue;
        }
      }
      balancesPage = r.page;
      /* Three date/balance pairs to a row. A balance with no digit in it is a heading or a scrap, not a figure. */
      ([[0, 140, 240], [240, 320, 420], [420, 500, 640]] as const).forEach(([d0, d1, b1], column) => {
        const dateText = between(r, d0, d1);
        const balanceText = between(r, d1, b1);
        if (dateText && balanceText && /\d/.test(balanceText)) balances.push({ page: r.page, column, dateText, balanceText });
      });
      continue;
    }

    if (section === "checks") {
      /*
       * Two date/number/amount columns to a row — and a date that slipped below its row.
       *
       * On September 2026's scan the engine placed "9/04" five points under "2454 2,625.00" and "9/08"
       * under "2455 1,278.00", just past the four points `rowsOf` groups on, so each cheque arrived
       * as a number and an amount with no date, then a date with nothing. Both were dropped, the
       * withdrawals came to $3,903.00 less than the summary printed, and two days would not balance.
       * The cheque images at the back of the statement show both cheques exactly as read here.
       *
       * So a column that yields a number and an amount without a date is held, and the next row's
       * lone date in that column completes it. A row that is only a date, with nothing held, is a
       * scrap and is passed over.
       */
      ([[0, 110, 200, 340], [340, 400, 490, 640]] as const).forEach(([d0, n0, a0, end], column) => {
        const dateText = between(r, d0, n0);
        const number = between(r, n0, a0);
        const amountText = between(r, a0, end);
        const held = heldCheck[column];
        if (dateText && amountText) {
          heldCheck[column] = null;
          lines.push({ section: "checks", page: r.page, dateText, amountText, credit: false, description: `CHECK ${number}` });
        } else if (!dateText && amountText && /\d/.test(amountText)) {
          heldCheck[column] = { section: "checks", page: r.page, dateText: "", amountText, credit: false, description: `CHECK ${number}` };
        } else if (dateText && !amountText && held && held.page === r.page) {
          held.dateText = dateText;
          lines.push(held);
          heldCheck[column] = null;
        }
      });
      continue;
    }

    const dateText = between(r, 0, 105);
    if (section === "card") {
      /*
       * An amount has a digit in it. The address footer at the foot of the card page — "WICHITA KS
       * 67212-9503" — lands in the withdrawal column on a row that also caught a date, and was read
       * as a $WICHITAKS purchase on the 25th. Without a digit it is not a figure, whatever column it
       * is in, and the row is a continuation of the purchase above it or nothing.
       */
      const digits = (t: string) => (/\d/.test(t) ? t : "");
      const depositText = digits(between(r, 105, 190));
      const withdrawalText = digits(between(r, 190, 265));
      const description = words(r, 265);
      if (dateText && !depositText && !withdrawalText && pendingAmountWithoutDate) {
        /* The scan put a purchase's date on the line below its amount. */
        pendingAmountWithoutDate.dateText = dateText;
        lines.push(pendingAmountWithoutDate);
        pendingAmountWithoutDate = null;
        continue;
      }
      if (depositText || withdrawalText) {
        const line: RawLine = { section: "card", page: r.page, dateText, amountText: depositText || withdrawalText, credit: Boolean(depositText), description };
        if (dateText) lines.push(line);
        else pendingAmountWithoutDate = line;
        continue;
      }
      const last = pendingAmountWithoutDate ?? lines[lines.length - 1];
      if (last && last.section === "card" && description) last.description = `${last.description} ${description}`.trim();
      continue;
    }

    /* Credits and debits: date, amount, description, and the description's second line below. */
    const amountText = between(r, 105, 190);
    const description = words(r, 190);
    if (dateText && amountText) {
      flushHeld();
      lines.push({ section, page: r.page, dateText, amountText, credit: section === "credits", description });
    } else if (dateText && !amountText && description) {
      /*
       * The date and the name on this row, the amount on the next.
       *
       * Where a description wraps to two lines the bank prints the amount level with the gap between
       * them, and the engine attaches it to the second line: "9/10 ACCESS HEALTH/ACCESS HEA" and then
       * "21,094.87 1722734 West Wichita Family Ph". Read as two half-lines, neither has a date and an
       * amount, and the solver refuses the statement. September 2026 had six of these in the credits
       * and McKesson's $118,085.72 in the debits. The card section already re-joins the mirror case
       * (amount first, date below); this is the other half of it. Held, and completed by the next row.
       */
      flushHeld();
      heldDate = { section, page: r.page, dateText, amountText: "", credit: section === "credits", description };
    } else if (!dateText && amountText && heldDate && heldDate.page === r.page && heldDate.section === section) {
      heldDate.amountText = amountText;
      heldDate.description = `${heldDate.description} ${description}`.trim();
      lines.push(heldDate);
      heldDate = null;
    } else if (!dateText && !amountText && description) {
      const last = heldDate ?? lines[lines.length - 1];
      if (last && last.section === section) last.description = `${last.description} ${description}`.trim();
    } else if (s) {
      /* Half a line: kept so the count against the summary can say something is missing. */
      flushHeld();
      lines.push({ section, page: r.page, dateText, amountText, credit: section === "credits", description });
    }
  }
  flushHeld();
  return { lines, balances, summary };
}
