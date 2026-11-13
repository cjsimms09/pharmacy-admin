import { test, describe } from "node:test";
import assert from "node:assert/strict";

describe("a TJ array is text too", () => {
  test("a date drawn as a Tj, a TJ array holding its first two digits, and a Tj for the rest reads whole", async () => {
    const { pdfText } = await import("../src/lib/pdf-text");
    const content = "BT\n/F1 9 Tf\n10 100 Td\n(Ship Date: ) Tj\n44.4 0 Td\n[(1)78(1)] TJ\n9.3 0 Td\n(/06/2026) Tj\nET";
    const pdf = Buffer.from(`%PDF-1.4\n1 0 obj\n<< /Length ${content.length} >>\nstream\n${content}\nendstream\nendobj\n%%EOF`, "latin1");
    assert.match(pdfText(pdf), /Ship Date: 11\/06\/2026/);
  });

  test("a wide gap in a TJ array is a space and a small one is kerning", async () => {
    const { pdfText } = await import("../src/lib/pdf-text");
    const content = "BT\n10 100 Td\n[(AB)-400(CD)30(EF)] TJ\nET";
    const pdf = Buffer.from(`%PDF-1.4\n1 0 obj\n<< /Length ${content.length} >>\nstream\n${content}\nendstream\nendobj\n%%EOF`, "latin1");
    assert.match(pdfText(pdf), /AB CDEF/);
  });
});
