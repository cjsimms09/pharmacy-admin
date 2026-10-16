/**
 * Writes fixtures/contracts/proving-agreement.pdf from the pages in contract-proving.ts.
 *
 * A plain PDF with one text object a page in Helvetica, no library: the site is expected to keep
 * working when nothing can be installed, and a proving document that needs a package to
 * regenerate is a proving document nobody regenerates. Run with `npx tsx scripts/make-proving-pdf.ts`.
 */
import fs from "node:fs";
import path from "node:path";
import { PROVING_PAGES } from "../src/lib/contract-proving";

const esc = (s: string) => s.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");

function page(lines: string[]): string {
  const ops = ["BT", "/F1 11 Tf", "13 TL", "54 740 Td"];
  for (const l of lines) ops.push(`(${esc(l)}) Tj T*`);
  ops.push("ET");
  return ops.join("\n");
}

const objects: string[] = [];
const add = (body: string) => { objects.push(body); return objects.length; };
const font = add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>");
const pageIds: number[] = [];
const contentIds: number[] = [];
for (const lines of PROVING_PAGES) {
  const stream = page(lines);
  contentIds.push(add(`<< /Length ${Buffer.byteLength(stream, "latin1")} >>\nstream\n${stream}\nendstream`));
  pageIds.push(objects.length + 1);
  objects.push(""); // placeholder for the page, filled once the Pages id is known
}
const pagesId = add(`<< /Type /Pages /Kids [${pageIds.map((i) => `${i} 0 R`).join(" ")}] /Count ${pageIds.length} >>`);
pageIds.forEach((id, i) => {
  objects[id - 1] = `<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 ${font} 0 R >> >> /Contents ${contentIds[i]} 0 R >>`;
});
const catalog = add(`<< /Type /Catalog /Pages ${pagesId} 0 R >>`);
const info = add("<< /Title (Proving agreement) /Producer (pharmacy-admin make-proving-pdf) >>");

let out = "%PDF-1.4\n%âãÏÓ\n";
const offsets: number[] = [];
objects.forEach((body, i) => {
  offsets.push(Buffer.byteLength(out, "latin1"));
  out += `${i + 1} 0 obj\n${body}\nendobj\n`;
});
const xref = Buffer.byteLength(out, "latin1");
out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
for (const o of offsets) out += `${String(o).padStart(10, "0")} 00000 n \n`;
out += `trailer\n<< /Size ${objects.length + 1} /Root ${catalog} 0 R /Info ${info} 0 R >>\nstartxref\n${xref}\n%%EOF\n`;

const file = path.join(process.cwd(), "fixtures", "contracts", "proving-agreement.pdf");
fs.mkdirSync(path.dirname(file), { recursive: true });
fs.writeFileSync(file, Buffer.from(out, "latin1"));
console.log(`wrote ${file}: ${PROVING_PAGES.length} pages, ${Buffer.byteLength(out, "latin1")} bytes`);
