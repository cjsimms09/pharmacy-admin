/**
 * Real identifiers, found before they reach git.
 *
 * The repository is public, and real prescription numbers, invoice numbers and ACH references have reached it more than
 * once — each time found by somebody reading a file rather than by anything that would have stopped it. The rule the
 * owner set is "code only, never data", and a rule with nothing enforcing it is a rule that holds until the day somebody
 * is in a hurry.
 *
 * ── What this refuses, and why each shape ──
 *
 *   a 10-digit number beginning 76 or 748   McKesson and Parmed invoice numbers, the shape that was committed twice
 *   CKACH or ACH followed by six digits      a wholesaler's own payment reference, which names the pharmacy's bank
 *   a zero-padded 12-digit number            how a copay statement prints a prescription number: the shape that hid in
 *                                            fixtures/copay-remit-redsail.txt behind six digits of padding
 *   a valid NPI                              ten digits with the health-industry check digit, so ordinary numbers pass
 *   a DEA number                             two letters and seven digits with its own check digit
 *   an 11-digit NDC beside a prescription    a drug and a prescription together is a patient, whatever else is removed
 *
 * ── What it deliberately does not do ──
 *
 * It does not refuse every long number: an amount in cents, a date, a test id and a line number are all long numbers,
 * and a check that cries wolf is turned off within a week. Each shape above is either checksummed or distinctive enough
 * to name. Every invented number this repository's own fixtures use is allowed by name, because a check that fires on
 * its own fixtures teaches people to pass `--no-verify`.
 *
 * Pure, so the rule can be tested against the real shapes without a file anywhere near it.
 */

export type Finding = { line: number; shape: string; what: string; why: string };

/** The invented numbers this repository's fixtures and tests use. A check that fires on these would be turned off. */
const ALLOWED = new Set([
  // Supplier invoices and ACH references, session 1's replacements (8b74190).
  ...Array.from({ length: 11 }, (_, i) => String(7000000001 + i)),
  ...Array.from({ length: 3 }, (_, i) => `CKACH0000000${i + 1}`),
  ...Array.from({ length: 5 }, (_, i) => `ACH0000000${i + 1}`),
  // The published test NPI, used in documentation everywhere.
  "1234567893",
  // The fixtures' own DEA stand-in.
  "XX0000000",
]);

/**
 * A DEA number every fixture in this repository uses: the documented test digits, and a row of noughts.
 *
 * Both satisfy the check digit, which is the point of them. A scanner that fired on its own fixtures' placeholders would
 * be turned off inside a week, and the placeholders are exactly what a fixture SHOULD carry.
 */
const PLACEHOLDER_DEA = /^[A-Z]{2}(1234563|0{7})$/;

const allowed = (token: string): boolean => {
  if (ALLOWED.has(token)) return true;
  /* Padding is part of how these are printed, and an invented number stays invented with zeros in front of it. */
  const digits = token.replace(/\D/g, "").replace(/^0+/, "");
  /* The 990xxx and 99000xxxx prescription series, and the 7000001+ / 8000001+ invoice series the fixtures use. */
  if (/^9{2}0\d{3}$/.test(digits) || /^99000\d{3,4}$/.test(digits)) return true;
  if (/^(7|8)00000\d{1,2}$/.test(digits)) return true;
  /* The 900xxx and 999xxx series the fixtures and doc comments use as example prescription numbers. */
  if (/^999\d{3}$/.test(digits) || /^900\d{3}$/.test(digits)) return true;
  /* An invented ACH reference: the 999 series, which no wholesaler's own numbering reaches. */
  if (/^(CK)?ACH999\d{4}$/.test(token)) return true;
  /* A memo id of the shape the IPD fixture uses: 5000 and a date. */
  if (/^5000(20\d{6})$/.test(digits)) return true;
  return false;
};

/** The NPI check digit: Luhn over the number prefixed with 80840, which is what makes an NPI tellable from any ten digits. */
function isNpi(ten: string): boolean {
  if (!/^[12]\d{9}$/.test(ten)) return false;
  const digits = `80840${ten.slice(0, 9)}`.split("").map(Number);
  let sum = 0;
  for (let i = digits.length - 1, double = true; i >= 0; i--, double = !double) {
    const d = double ? digits[i] * 2 : digits[i];
    sum += d > 9 ? d - 9 : d;
  }
  return (10 - (sum % 10)) % 10 === Number(ten[9]);
}

/**
 * A DEA number: a registrant letter, a surname initial, then seven digits whose last is the check digit.
 *
 * The first letter is what a registration can actually begin with (A, B, F, G, M, P, R or X). Without that, any two
 * letters in front of seven digits is a DEA number one time in ten — a part number, a batch code, a column heading.
 */
function isDea(token: string): boolean {
  const m = /^([ABFGMPRX][A-Z])(\d{7})$/.exec(token);
  if (!m || PLACEHOLDER_DEA.test(token)) return false;
  const d = m[2].split("").map(Number);
  const check = ((d[0] + d[2] + d[4]) + 2 * (d[1] + d[3] + d[5])) % 10;
  return check === d[6];
}

/**
 * Every real identifier this text appears to carry.
 *
 * `path` only decides how loudly a prescription-shaped number is read: a fixture is where they hide, and a migration
 * full of column names is where false alarms come from.
 */
export function findIdentifiers(text: string, path = "", own: string[] = []): Finding[] {
  const out: Finding[] = [];
  const lines = text.split(/\r?\n/);
  /*
   * The pharmacy's own numbers — its NPI, its NCPDP, its DEA — are passed in rather than written here, because writing
   * them here would put them in the public repository this exists to keep them out of. The runner reads them from the
   * site's settings at the moment it runs.
   */
  const ours = own.map((x) => x.trim()).filter((x) => x.length >= 5);
  const say = (line: number, shape: string, what: string, why: string) => {
    if (allowed(what)) return;
    out.push({ line: line + 1, shape, what, why });
  };

  lines.forEach((raw, i) => {
    /* A line that says what it is testing is not evidence: "an invoice number like 7656141694" is the same string. */
    const line = raw;

    for (const mine of ours) {
      if (line.includes(mine)) {
        out.push({ line: i + 1, shape: "this pharmacy's own identifier", what: `${mine.slice(0, 2)}…${mine.slice(-2)}`, why: "one of this pharmacy's own registered numbers, as the site holds it in its settings" });
      }
    }

    for (const m of line.matchAll(/\b(76\d{8}|748\d{7})\b/g)) {
      say(i, "supplier invoice number", m[1], "the shape of a McKesson or Parmed invoice number, which names a real purchase");
    }
    for (const m of line.matchAll(/\b(CKACH\d{6,}|ACH\d{6,})\b/g)) {
      say(i, "ACH reference", m[1], "a wholesaler's own payment reference, which identifies this pharmacy's bank movements");
    }
    /*
     * Twelve digits, padded, with something real inside them: how a copay statement prints a prescription number, and
     * the shape that hid in a fixture behind six noughts. A run of noughts on its own is a column of zeros, a schema
     * snapshot or a version string, and firing on those is how a check gets switched off.
     */
    for (const m of line.matchAll(/\b(0{3,}\d{3,})\b/g)) {
      const core = m[1].replace(/^0+/, "");
      if (m[1].length !== 12 || core.length < 4 || /^0+$/.test(core)) continue;
      say(i, "padded prescription number", m[1], "how a copay statement prints a prescription number; the padding is what hid the last one");
    }
    for (const m of line.matchAll(/\b([12]\d{9})\b/g)) {
      if (isNpi(m[1])) say(i, "NPI", m[1], "a valid National Provider Identifier");
    }
    for (const m of line.matchAll(/\b([A-Z]{2}\d{7})\b/g)) {
      if (isDea(m[1])) say(i, "DEA number", m[1], "a valid DEA registration number");
    }
    /* A prescription number and a drug code on one line is a dispensing, however much else has been changed. */
    if (/\b\d{11}\b/.test(line) && /\brx\s*(#|number|no)?\b/i.test(line) && !/fixtures?|invented|test/i.test(path)) {
      const ndc = /\b(\d{11})\b/.exec(line)![1];
      say(i, "NDC beside a prescription", ndc, "a drug and a prescription on one line is a patient's dispensing");
    }
  });
  return out;
}

/** One line per finding, for a hook or a report. Empty when there is nothing to say. */
export function sayFindings(path: string, findings: Finding[]): string[] {
  return findings.map((f) => `${path}:${f.line}  ${f.shape} "${f.what}" — ${f.why}`);
}
