/**
 * Prints the C-650 (the Board's CQI incident form) to a PDF in headless Chrome and counts the pages.
 *
 * The form is two sides of one sheet. A page count cannot be read from the code, only from a print, so this does the
 * print: it renders the real form component with invented data at the fullest the form allows, compiles the site's own
 * stylesheet, and asks Chrome (or Edge) for the PDF. A normal incident must come out at 2 pages; one whose RCA and CAP
 * are too long for the form's boxes must come out at 3, the third being the attached sheet.
 *
 *   npx tsx --tsconfig tsconfig.script.json scripts/check-c650-pages.ts
 *
 * Exits 1 if a case does not print on the pages it should. It reads nothing from the database.
 */
import * as React from "react";
const h = React.createElement;
/* The script tsconfig compiles JSX the classic way, which looks for a global React. */
(globalThis as unknown as { React: typeof React }).React = React;
import { renderToStaticMarkup } from "react-dom/server";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import postcss from "postcss";
import tailwind from "@tailwindcss/postcss";
import type { C650Data } from "../src/components/c650-form";

const BROWSERS = [
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
];

const sentence = "The label was read at the counter and the bag was handed over without a second identifier being checked against the patient. ";
const person = (i: number) => ({ name: `Employee Number${i} Surname`, license: `12-${3400 + i}`, reviewedOn: "10/23/2026", reviewedBy: "Reviewer Surname" });
const base: C650Data = {
  facility: "Example Family Pharmacy",
  registration: "12-3456",
  rx: "1234567, 1234568, 1234569",
  createdOn: "10/23/2026",
  type: "wrong_patient",
  typeOther: "",
  reviewStartedOn: "10/23/2026",
  reviewer: "Reviewer Surname",
  people: [1, 2, 3, 4, 5, 6].map(person),
  pso: false,
  psoName: "",
  psoExpires: "",
  picName: "Pharmacist In Charge",
  completedOn: "10/30/2026",
  rca: null,
  cap: null,
};
/** A text of this many printed lines, each short enough never to wrap, so the count does not depend on the type size. */
const lines = (n: number) => Array.from({ length: n }, (_, i) => `${i + 1}. The label was read at the counter and the bag was handed over without a second check.`).join("\n");

const cases: { label: string; d: C650Data; pages: number }[] = [
  { label: "empty form", d: { ...base, people: base.people.map(() => ({ name: "", license: "", reviewedOn: "", reviewedBy: "" })) }, pages: 2 },
  { label: "short RCA and CAP", d: { ...base, rca: lines(6), cap: lines(6) }, pages: 2 },
  { label: "fills the boxes at the form's own size (19 lines each)", d: { ...base, rca: lines(19), cap: lines(19) }, pages: 2 },
  { label: "needs the middle size (23 lines each)", d: { ...base, rca: lines(23), cap: lines(23) }, pages: 2 },
  { label: "needs the smallest size (25 lines each)", d: { ...base, rca: lines(25), cap: lines(25) }, pages: 2 },
  { label: "too long for the boxes (28 lines each)", d: { ...base, rca: lines(28), cap: lines(28) }, pages: 3 },
];

async function main() {
  const { C650Body } = await import("../src/components/c650-form");
  const { BoardMasthead } = await import("../src/components/print");
  const browser = BROWSERS.find(existsSync);
  if (!browser) throw new Error("No Chrome or Edge found to print with.");
  const css = (await postcss([tailwind()]).process(readFileSync("src/app/globals.css", "utf8"), { from: join(process.cwd(), "src/app/globals.css") })).css;
  const dir = mkdtempSync(join(tmpdir(), "c650-"));
  let bad = 0;
  for (const [i, c] of cases.entries()) {
    const body = renderToStaticMarkup(
      h("div", { className: "mx-auto max-w-[8.5in] bg-white text-black print:max-w-none" },
        h(BoardMasthead, { formTitle: "CQI Incident Report Evaluation", formNumber: "Form C-650" }),
        h(C650Body, { d: c.d }),
        h("footer", { className: "mt-2 flex justify-between text-[10px] text-neutral-700" }, h("span", null, "Page 2 of 2"), h("span", null, "Revised 1/2025"))),
    );
    const html = join(dir, `c${i}.html`);
    const pdf = join(dir, `c${i}.pdf`);
    writeFileSync(html, `<!doctype html><html><head><meta charset="utf-8"><style>${css}</style></head><body>${body}</body></html>`);
    execFileSync(browser, ["--headless=new", "--disable-gpu", "--no-pdf-header-footer", `--print-to-pdf=${pdf}`, `file:///${html.split("\\").join("/")}`], { stdio: "ignore", timeout: 60000 });
    const pages = (readFileSync(pdf).toString("latin1").match(/\/Type\s*\/Page[^s]/g) ?? []).length;
    const ok = pages === c.pages;
    if (!ok) bad++;
    console.log(`${ok ? "ok  " : "FAIL"} ${c.label}: ${pages} pages (expected ${c.pages})`);
  }
  console.log(bad ? `${bad} case(s) print on the wrong number of pages.` : "Every case prints on the expected number of pages.");
  process.exit(bad ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
