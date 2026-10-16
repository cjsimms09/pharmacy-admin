import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { ALLOWED_EXTENSIONS, REPORT_EXTENSIONS, ALLOWED_MIME, extensionOf } from "../src/lib/files";

/**
 * A pharmacist photographing a licence card was told "file type not allowed" — iPhones report
 * image/heif where the list only had image/heic, and a copier scan is image/tiff. A refusal like
 * that is not a small bug: it is the point at which somebody stops using the feature and goes
 * back to a filing cabinet.
 *
 * So the extension decides, and the browser's guess at the type is only a label.
 */
describe("extensionOf", () => {
  test("reads the ending, whatever the case", () => {
    assert.equal(extensionOf("licence.PDF"), "pdf");
    assert.equal(extensionOf("IMG_4821.HEIC"), "heic");
    assert.equal(extensionOf("scan 2026-09-03.tiff"), "tiff");
  });
  test("a name with dots in it still resolves", () => {
    assert.equal(extensionOf("cpr.card.final.jpg"), "jpg");
  });
  test("no extension is empty, not a guess", () => {
    assert.equal(extensionOf("scan"), "");
    assert.equal(extensionOf(""), "");
  });
});

describe("what a pharmacy actually uploads is accepted", () => {
  const shouldPass = [
    ["a photo from an iPhone", "heic"],
    ["the other spelling iPhones use", "heif"],
    ["an ordinary phone photo", "jpg"],
    ["a screenshot", "png"],
    ["a copier scan", "tiff"],
    ["the short spelling of it", "tif"],
    ["a licence PDF", "pdf"],
    ["a Word protocol", "docx"],
  ] as const;
  for (const [what, ext] of shouldPass) {
    test(`${what} (.${ext})`, () => assert.ok(ALLOWED_EXTENSIONS.has(ext), `.${ext} would be refused`));
  }

  test("both spellings of the Apple photo format are in the type list too", () => {
    assert.ok(ALLOWED_MIME.has("image/heic"));
    assert.ok(ALLOWED_MIME.has("image/heif"), "the spelling that actually arrives from an iPhone");
    assert.ok(ALLOWED_MIME.has("image/tiff"));
  });
});

describe("what must still be refused", () => {
  for (const ext of ["exe", "bat", "cmd", "ps1", "js", "html", "svg", "dll", "scr"]) {
    test(`.${ext} is not accepted`, () => {
      assert.ok(!ALLOWED_EXTENSIONS.has(ext), `.${ext} should not be uploadable`);
      assert.ok(!REPORT_EXTENSIONS.has(ext), `.${ext} should not arrive by email either`);
    });
  }
});

describe("emailed reports are a wider set, but only for the mailbox", () => {
  test("spreadsheets and remittances arrive by email", () => {
    for (const ext of ["csv", "xlsx", "835", "edi"]) assert.ok(REPORT_EXTENSIONS.has(ext));
  });
  test("they are not in the ordinary upload set", () => {
    for (const ext of ["csv", "xlsx", "zip"]) assert.ok(!ALLOWED_EXTENSIONS.has(ext));
  });
});
