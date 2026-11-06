import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { isEmbeddedPicture } from "../src/lib/embedded-picture";

const html = '<p>Hello</p><img src="cid:logo123@mail"><p>Thanks</p>';
const logo = { filename: "company-logo.png", contentType: "image/png", contentId: "<logo123@mail>", size: 6_000 };

describe("a picture built into the message is not a file that arrived", () => {
  test("a small image the body points at is embedded", () => {
    assert.equal(isEmbeddedPicture(logo, html), true);
  });
  test("an image nothing in the body points at is an attachment", () => {
    assert.equal(isEmbeddedPicture(logo, "<p>No pictures here</p>"), false);
    assert.equal(isEmbeddedPicture({ ...logo, contentId: null }, html), false);
    assert.equal(isEmbeddedPicture(logo, null), false);
  });
  test("a photograph shown inline is still filed, because signature art is small", () => {
    assert.equal(isEmbeddedPicture({ ...logo, size: 2_400_000 }, html), false);
  });
  test("a document is never embedded, however it is referenced", () => {
    assert.equal(isEmbeddedPicture({ filename: "invoice.pdf", contentType: "application/pdf", contentId: "<logo123@mail>", size: 5_000 }, html), false);
  });
  test("the size is read from the content when the parser gives none", () => {
    assert.equal(isEmbeddedPicture({ ...logo, size: null, content: { length: 4_000 } }, html), true);
  });
});

describe("a small picture the mail program named itself", () => {
  const pasted = { filename: "image.png", contentType: "image/png", contentId: null, size: 11_033 };
  test("is part of the message even when the body does not point at it", () => {
    assert.equal(isEmbeddedPicture(pasted, "<p>no cid here</p>"), true);
    assert.equal(isEmbeddedPicture({ ...pasted, filename: "image001.png" }, null), true);
    assert.equal(isEmbeddedPicture({ ...pasted, filename: "Outlook-abc123.png" }, null), true);
  });
  test("a large picture with the same name is still filed, because it could be a page", () => {
    assert.equal(isEmbeddedPicture({ ...pasted, size: 400_000 }, null), false);
  });
  test("a picture named by a scanner or a phone is still filed at any size", () => {
    assert.equal(isEmbeddedPicture({ ...pasted, filename: "scan0042.png", size: 8_000 }, null), false);
    assert.equal(isEmbeddedPicture({ ...pasted, filename: "IMG_2041.jpg", size: 8_000 }, null), false);
  });
  test("a PDF called image.pdf is not a picture", () => {
    assert.equal(isEmbeddedPicture({ filename: "image.pdf", contentType: "application/pdf", contentId: null, size: 8_000 }, null), false);
  });
});
