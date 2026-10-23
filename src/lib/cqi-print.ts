/**
 * How much of the C-650's second side the root cause analysis and corrective action plan may take.
 *
 * The Board's form is two sides of one sheet. The two boxes grow with what is written in them, so a long analysis pushed
 * the certification onto a third sheet. Up to a length that fits, the type steps down to keep it on side two; past
 * that, the boxes point to an attached sheet (the form says "Attach additional pages, if necessary") and the full text
 * prints there, so nothing is cut and the form itself stays two sides.
 *
 * The lengths are an estimate for letter paper at the default margins, each line break counted as a wasted line; they are
 * not measured against a printer.
 */
export function fitRcaCap(rca: string | null, cap: string | null): { cls: string; attach: boolean } {
  const size = [rca, cap].reduce((n, t) => n + (t ? t.length + 100 * (t.split("\n").length - 1) : 0), 0);
  if (size <= 2800) return { cls: "text-[11px]", attach: false };
  if (size <= 4400) return { cls: "text-[9.5px] leading-snug", attach: false };
  return { cls: "text-[11px]", attach: true };
}
