import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { createZip } from "../src/lib/zip";
import { parseDocx, outline, gaps } from "../src/lib/manual-store";
import { FORMS, appendixReference } from "../src/lib/manual";
import type { Section } from "../src/lib/manual-store";

/**
 * The manual is the one document an inspector reads end to end, so the two ways this could go
 * wrong are both silent.
 *
 * Import can lose text — a paragraph that belongs to no heading, or a heading style the splitter
 * does not recognise — and nobody notices until a policy that used to be in the manual is not.
 * And the "headings with nothing under them" list can cry wolf by counting chapter headings,
 * which teaches the reader to skip the list that exists to catch the real hole.
 */

/** A .docx is a zip with a document.xml in it. This builds the smallest one Word would accept. */
function docx(paragraphs: { style?: string; text: string }[]): Buffer {
  const body = paragraphs
    .map(
      (p) =>
        `<w:p w:rsidR="00"><w:pPr>${p.style ? `<w:pStyle w:val="${p.style}"/>` : ""}</w:pPr>` +
        `<w:r><w:t xml:space="preserve">${p.text}</w:t></w:r></w:p>`,
    )
    .join("");
  return createZip([
    {
      name: "word/document.xml",
      data: Buffer.from(
        `<?xml version="1.0"?><w:document xmlns:w="x"><w:body>${body}</w:body></w:document>`,
        "utf8",
      ),
    },
  ]);
}

const row = (o: Partial<Section> & { id: string; title: string; level: number }): Section =>
  ({
    sourceKey: null,
    source: "pharmacy",
    body: "",
    position: 0,
    reviewedOn: null,
    reviewedBy: null,
    retiredOn: null,
    updatedBy: null,
    createdAt: "",
    updatedAt: "",
    ...o,
  }) as Section;

describe("parseDocx", () => {
  test("splits on Word's own heading styles", () => {
    const out = parseDocx(
      docx([
        { style: "Heading1", text: "Pharmacy Policies" },
        { style: "Heading2", text: "Dress code" },
        { text: "Staff wear a lab coat." },
        { style: "Heading2", text: "Telephone" },
        { text: "Answered within three rings." },
      ]),
    );
    assert.deepEqual(
      out.map((s) => [s.level, s.title]),
      [
        [1, "Pharmacy Policies"],
        [2, "Dress code"],
        [2, "Telephone"],
      ],
    );
    assert.equal(out[1].body, "Staff wear a lab coat.");
  });

  test("text before the first heading is kept, not dropped", () => {
    const out = parseDocx(docx([{ text: "Effective January 2026." }, { style: "Heading1", text: "Chapter one" }]));
    assert.equal(out[0].title, "Front matter");
    assert.equal(out[0].body, "Effective January 2026.");
  });

  test("paragraphs under one heading are joined, not overwritten", () => {
    const out = parseDocx(
      docx([{ style: "Heading1", text: "CQI" }, { text: "First." }, { text: "Second." }]),
    );
    assert.equal(out[0].body, "First.\n\nSecond.");
  });

  test("the table of contents is a map of the document, not part of it", () => {
    const out = parseDocx(
      docx([
        { style: "TOCHeading", text: "Contents" },
        { style: "TOC1", text: "Pharmacy Policies" },
        { style: "TOC2", text: "Dress code" },
        { style: "Heading1", text: "Pharmacy Policies" },
        { text: "Real text." },
      ]),
    );
    assert.deepEqual(out.map((s) => s.title), ["Pharmacy Policies"]);
    assert.equal(out[0].body, "Real text.");
  });

  test("headings deeper than three stay with the section above them", () => {
    const out = parseDocx(
      docx([
        { style: "Heading1", text: "Chapter" },
        { style: "Heading4", text: "A sub-sub-sub point" },
        { text: "Detail." },
      ]),
    );
    assert.equal(out.length, 1);
    assert.match(out[0].body, /A sub-sub-sub point/);
    assert.match(out[0].body, /Detail\./);
  });

  test("an empty heading is imported, so that it is visible as empty", () => {
    const out = parseDocx(docx([{ style: "Heading1", text: "Pharmacy Forms" }]));
    assert.deepEqual(out, [{ title: "Pharmacy Forms", level: 1, body: "" }]);
  });

  test("XML entities come back as the characters they stand for", () => {
    const out = parseDocx(docx([{ style: "Heading1", text: "Fraud, Waste &amp; Abuse" }]));
    assert.equal(out[0].title, "Fraud, Waste & Abuse");
  });

  test("a file that is not a Word document says so rather than importing nothing", () => {
    assert.throws(() => parseDocx(createZip([{ name: "hello.txt", data: Buffer.from("hi") }])), /Word document/);
  });
});

describe("outline", () => {
  const rows = [
    row({ id: "a", title: "Pharmacy Policies", level: 1 }),
    row({ id: "b", title: "Dress code", level: 2 }),
    row({ id: "c", title: "Exceptions", level: 3 }),
    row({ id: "d", title: "Telephone", level: 2 }),
    row({ id: "e", title: "Controlled Substances", level: 1 }),
  ];

  test("numbers sections the way the contents page does", () => {
    assert.deepEqual(outline(rows).map((s) => s.number), ["1", "1.1", "1.1.1", "1.2", "2"]);
  });

  test("every section knows which chapter it is in", () => {
    assert.deepEqual(outline(rows).map((s) => s.chapterId), ["a", "a", "a", "a", "e"]);
  });

  test("a heading with sections under it is marked as having children", () => {
    assert.deepEqual(outline(rows).map((s) => s.hasChildren), [true, true, false, false, false]);
  });

  test("a skipped level is closed up, so no section is numbered 3.0.1", () => {
    const skipped = [
      row({ id: "a", title: "Employee Policy and Procedures", level: 1 }),
      row({ id: "b", title: "Equal Opportunity Policy", level: 3 }),
      row({ id: "c", title: "Termination", level: 3 }),
      row({ id: "d", title: "Employee Safety", level: 2 }),
      row({ id: "e", title: "Workplace Violence", level: 3 }),
    ];
    assert.deepEqual(outline(skipped).map((s) => s.number), ["1", "1.1", "1.2", "1.3", "1.3.1"]);
  });

  test("a manual that opens on a Heading 2 still opens on chapter one", () => {
    const odd = [row({ id: "a", title: "Hours", level: 2 }), row({ id: "b", title: "Staffing", level: 2 })];
    assert.deepEqual(outline(odd).map((s) => s.number), ["1", "2"]);
    assert.deepEqual(outline(odd).map((s) => s.chapterId), ["a", "b"]);
  });
});

describe("gaps", () => {
  test("a chapter heading with no prose is not a hole in the manual", () => {
    const rows = [
      row({ id: "a", title: "Pharmacy Policies", level: 1, body: "" }),
      row({ id: "b", title: "Dress code", level: 2, body: "Staff wear a lab coat." }),
    ];
    assert.deepEqual(gaps(rows), []);
  });

  test("a heading that promises a policy and delivers none is", () => {
    const rows = [
      row({ id: "a", title: "Pharmacy Forms", level: 1, body: "" }),
      row({ id: "b", title: "Controlled Substances", level: 1, body: "We follow 21 CFR 1304." }),
    ];
    assert.deepEqual(gaps(rows).map((s) => s.title), ["Pharmacy Forms"]);
  });

  test("whitespace is not a policy", () => {
    assert.deepEqual(gaps([row({ id: "a", title: "Emergency refills", level: 1, body: "   \n  " })]).length, 1);
  });

  test("a generated section is never chased — the software fills it, not the reader", () => {
    assert.deepEqual(gaps([row({ id: "a", title: "Appendix A", level: 1, body: "", source: "site" })]), []);
  });
});

describe("appendixReference", () => {
  test("names the form, says where the current version comes from, and files no blank copy", () => {
    const body = appendixReference("Pharmacy technician list (Form C-900)");
    assert.match(body, /Form C-900/);
    assert.match(body, /compliance system/);
    assert.match(body, /No blank copy is filed/);
  });

  test("every form the appendix lists can be pointed at", () => {
    for (const f of FORMS) assert.ok(appendixReference(f.name).length > 100, f.name);
  });

  test("a heading that names something the system does not produce cannot be filled in this way", () => {
    assert.throws(() => appendixReference("Medicare Prescription Drug Coverage and Your Rights"), /not a form/);
  });
});
