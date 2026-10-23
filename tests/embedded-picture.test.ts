import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { isEmbeddedPicture } from "../src/lib/embedded-picture";

const html = '<p>Hello</p><img src="cid:logo123@mail"><p>Thanks</p>';
const logo = { filename: "image001.png", contentType: "image/png", contentId: "<logo123@mail>", size: 6_000 };

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
