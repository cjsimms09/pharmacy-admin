/**
 * Whether an attachment is a picture that is part of the message's own body: a logo or a signature, not a document.
 *
 * A forwarded newsletter from a buying group arrived on 20 October 2026 with its logo as `image001.png`, and the Inbox
 * showed that logo as a file "Filed, not recognised" and asked what it was. Nobody attached it; the sender's mail program
 * put it there so the message would display.
 *
 * The proof that a picture is part of the body is that the body's HTML points at it (`src="cid:..."`). Size is a second
 * condition, so a photograph of an invoice that happens to be shown inline is still filed: signature art is small.
 * Either condition missing and it is treated as an attachment, which is the safe side: a document filed that was not one is
 * a line to dismiss, and a document passed over that was one is money or a duty nobody sees.
 */
export const EMBEDDED_PICTURE_MAX_BYTES = 150_000;

export function isEmbeddedPicture(
  att: { filename?: string | null; contentType?: string | null; contentId?: string | null; size?: number | null; content?: { length: number } | null },
  html: string | null | undefined,
): boolean {
  const isImage = /^image\//i.test(att.contentType ?? "") || /\.(png|jpe?g|gif|bmp)$/i.test(att.filename ?? "");
  if (!isImage) return false;
  const id = (att.contentId ?? "").replace(/^<|>$/g, "").trim();
  if (!id || !html) return false;
  if (!html.toLowerCase().includes(`cid:${id.toLowerCase()}`)) return false;
  const size = att.size ?? att.content?.length ?? Number.POSITIVE_INFINITY;
  return size <= EMBEDDED_PICTURE_MAX_BYTES;
}
