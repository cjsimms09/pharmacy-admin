/**
 * Products McKesson leaves out of both sides of its compliance ratio, and, as its own statements show, out of the brand
 * purchases its 1 per cent factor is paid on.
 *
 * McKesson's August 2026 statement paid the brand factor on $136,293 of brand purchases. The site counted every
 * prescription line not marked as a contract generic, $408,191 in September, and of that $265,497 was GLP-1s. With the
 * GLP-1s left out the September figure is $143,648, which is the August figure's size. The programme text says the same:
 * "Certain products — GLP-1s among them — are excluded". Flu, dropship and specialty are the other exclusions the report
 * prints; they cannot be told from an invoice line's description and are not handled here.
 */
const GLP1 =
  /ozempic|wegovy|mounjaro|zepbound|trulicity|victoza|saxenda|rybelsus|bydureon|byetta|adlyxin|soliqua|xultophy|semaglutide|tirzepatide|dulaglutide|liraglutide|exenatide|lixisenatide/i;

export function isGlp1(description: string | null | undefined): boolean {
  return !!description && GLP1.test(description);
}
