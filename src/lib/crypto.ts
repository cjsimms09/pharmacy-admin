import crypto from "node:crypto";

function key(): Buffer {
  const raw = process.env.APP_ENCRYPTION_KEY;
  if (!raw || raw.startsWith("EXAMPLE")) {
    throw new Error("APP_ENCRYPTION_KEY is not set. Copy .env.example to .env and generate a key.");
  }
  const buf = Buffer.from(raw, "base64");
  if (buf.length !== 32) throw new Error("APP_ENCRYPTION_KEY must be 32 bytes, base64-encoded.");
  return buf;
}

/** AES-256-GCM. Output: base64(iv | tag | ciphertext). */
export function encryptText(plain: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key(), iv);
  const enc = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, enc]).toString("base64");
}

export function decryptText(payload: string): string {
  const buf = Buffer.from(payload, "base64");
  const iv = buf.subarray(0, 12);
  const tag = buf.subarray(12, 28);
  const data = buf.subarray(28);
  const decipher = crypto.createDecipheriv("aes-256-gcm", key(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString("utf8");
}

export function newId(): string {
  return crypto.randomUUID();
}

export function sha256(buf: Buffer): string {
  return crypto.createHash("sha256").update(buf).digest("hex");
}

export function randomToken(bytes = 32): string {
  return crypto.randomBytes(bytes).toString("base64url");
}
