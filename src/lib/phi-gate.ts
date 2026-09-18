import "server-only";

/**
 * Ingestion gate: refuse files that carry patient identity data.
 *
 * The pharmacy's PioneerRx reports are built without patient columns on purpose, so a file that
 * has one is a sign the wrong report was scheduled. Rejecting is the safe outcome: nothing is
 * stored, and the owner is told which column looked wrong (never the value).
 */

const IDENTIFYING_HEADERS: { pattern: RegExp; label: string }[] = [
  { pattern: /^(patient|pt)[\s_-]*(first|last|full)?[\s_-]*name$/i, label: "patient name" },
  { pattern: /^(first|last|middle)[\s_-]*name$/i, label: "name" },
  { pattern: /^(patient|pt)[\s_-]*(dob|date[\s_-]*of[\s_-]*birth|birth[\s_-]*date)$/i, label: "date of birth" },
  { pattern: /^(dob|date[\s_-]*of[\s_-]*birth|birth[\s_-]*date)$/i, label: "date of birth" },
  { pattern: /^(patient|pt|home|cell|mobile)?[\s_-]*(phone|telephone)([\s_-]*number)?$/i, label: "phone number" },
  { pattern: /^(patient|pt|home|mailing)?[\s_-]*address([\s_-]*[12])?$/i, label: "address" },
  { pattern: /^(patient|pt)[\s_-]*(email|e-mail)$/i, label: "email address" },
  { pattern: /^(member|cardholder|subscriber)[\s_-]*(id|number|#)$/i, label: "member/cardholder ID" },
  { pattern: /^person[\s_-]*code$/i, label: "person code" },
  { pattern: /^(patient|pt)[\s_-]*(id|number|#)$/i, label: "patient ID" },
  { pattern: /^ssn$|^social[\s_-]*security/i, label: "social security number" },
  { pattern: /^(patient|pt)[\s_-]*(gender|sex)$/i, label: "patient gender" },
];

export type GateResult =
  | { ok: true; scanned: boolean; note?: string }
  | { ok: false; reason: string };

const TEXTUAL = /\.(csv|tsv|txt|tab)$/i;

/** Checks a file before it is stored. Text-based reports are scanned; other types are stored unscanned. */
export function gateFile(fileName: string, buf: Buffer): GateResult {
  if (!TEXTUAL.test(fileName)) {
    return { ok: true, scanned: false, note: "Not a text report, so column names were not machine-checked." };
  }
  const head = buf.subarray(0, 64 * 1024).toString("utf8");
  const firstLine = head.split(/\r?\n/).find((l) => l.trim().length > 0);
  if (!firstLine) return { ok: true, scanned: true };
  const delimiter = firstLine.includes("\t") ? "\t" : firstLine.split(",").length > 1 ? "," : "|";
  const headers = firstLine.split(delimiter).map((h) => h.replace(/^["']|["']$/g, "").trim());
  const hits: string[] = [];
  headers.forEach((h, i) => {
    for (const rule of IDENTIFYING_HEADERS) {
      if (rule.pattern.test(h)) {
        hits.push(`column ${i + 1} “${h}” looks like a ${rule.label}`);
        break;
      }
    }
  });
  if (hits.length > 0) {
    return {
      ok: false,
      reason: `Refused: this report appears to contain patient information (${hits.join("; ")}). Rebuild the report in PioneerRx without patient columns, or send it somewhere other than this mailbox.`,
    };
  }
  return { ok: true, scanned: true };
}
