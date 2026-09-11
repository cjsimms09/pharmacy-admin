/**
 * Books the postage confirmations that arrived before anything could read them.
 *
 * Two Endicia Purchase Confirmations reached the mailbox in September, on the 8th and the 10th,
 * $100.00 each. Both were filed as "No attachment on this message" and dropped, because the whole
 * transaction is in the text and the sweep files attachments. $200.00 of real cost that never
 * reached either account.
 *
 * The sweep reads them now. This is for the ones already passed over: it goes back to the mailbox,
 * re-reads every message from a postage sender, and books what it finds. Keyed on the vendor's own
 * order number, so running it twice books nothing twice and running it after the sweep has already
 * caught one does nothing.
 *
 * Run: `tsx scripts/backfill-postage.ts [--dry-run]`
 */
import "dotenv/config";

async function main() {
  const dryRun = process.argv.includes("--dry-run");
  const { ImapFlow } = await import("imapflow");
  const { simpleParser } = await import("mailparser");
  const { getSettings } = await import("../src/lib/settings");
  const { decryptText } = await import("../src/lib/crypto");
  const { readPostageEmail } = await import("../src/lib/postage-email");
  const { bookPostage } = await import("../src/lib/expenses");

  const s = await getSettings();
  if (!s.mail_user || !s.mail_password_enc) throw new Error("No mailbox is configured.");
  const client = new ImapFlow({
    host: s.mail_host || "imap.gmail.com",
    port: Number(s.mail_port || 993),
    secure: true,
    auth: { user: s.mail_user, pass: decryptText(s.mail_password_enc) },
    logger: false,
    socketTimeout: 120_000,
  });

  await client.connect();
  try {
    await client.mailboxOpen("INBOX", { readOnly: true });
    let booked = 0;
    let already = 0;
    let unread = 0;
    /* Every postage sender the reader knows, rather than Endicia alone. */
    for (const domain of ["endicia.com", "stamps.com"]) {
      const uids = (await client.search({ from: domain }, { uid: true })) || [];
      for (const uid of uids) {
        const msg = await client.fetchOne(String(uid), { source: true, envelope: true }, { uid: true });
        if (!msg || typeof msg === "boolean" || !msg.source) continue;
        const parsed = await simpleParser(msg.source);
        const from = parsed.from?.value?.[0]?.address ?? "";
        const subject = parsed.subject ?? "";
        const p = readPostageEmail(from, subject, parsed.text ?? "");
        if (!p) {
          unread++;
          console.log(`  skipped  ${parsed.date?.toISOString().slice(0, 10)} ${subject}`);
          continue;
        }
        if (dryRun) {
          console.log(`  would book  ${p.purchasedOn}  $${(p.amountCents / 100).toFixed(2)}  ${p.says}`);
          booked++;
          continue;
        }
        const r = await bookPostage(p, parsed.messageId ?? null);
        if (r.duplicate) already++;
        else booked++;
        console.log(`  ${r.duplicate ? "already  " : "booked   "} ${p.purchasedOn}  $${(p.amountCents / 100).toFixed(2)}  ${r.says}`);
      }
    }
    console.log(
      `\n${booked} postage purchase${booked === 1 ? "" : "s"} ${dryRun ? "would be booked" : "booked"}, ${already} already on the books, ` +
        `${unread} message${unread === 1 ? "" : "s"} from those senders that carried no purchase.`,
    );
  } finally {
    await client.logout();
  }
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
