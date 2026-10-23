/**
 * Reading the message that says the email never arrived.
 *
 * SMTP acceptance is not delivery, and the site was treating them as the same thing. The mail
 * server takes the message, says 250 OK, and the site reports success — then minutes later the
 * receiving end refuses it and a delivery-status notification comes back to the pharmacy's own
 * inbox. That notification is the only thing in the world that knows why the training email never
 * arrived, and it was being dropped: it comes from mailer-daemon, mailer-daemon is not on the
 * allowed-senders list, so the sweep filed it as "ignored" and said nothing.
 *
 * So the pharmacy sat looking at a screen that said the email was sent, while the explanation for
 * why it was not sat unread in its own mailbox.
 *
 * Parsing is kept pure and separate from the mailbox so it can be tested against real bounce
 * shapes rather than only against a live IMAP account.
 */

export type Bounce = {
  /** The address that failed, lower-cased. Null when the report does not name one. */
  recipient: string | null;
  /** What the receiving server actually said, trimmed to something a person can read. */
  diagnostic: string;
  /** 5.x.x — it will never arrive. 4.x.x is a temporary defer and may still land. */
  permanent: boolean;
};

const DAEMON = /(mailer-daemon|postmaster|no-?reply@.*(mail|smtp)|delivery-?(status|subsystem))/i;
const SUBJECT =
  /(undeliverable|undelivered|delivery status notification|delivery (has )?failed|failure notice|returned mail|mail delivery (failed|subsystem)|message not delivered)/i;

/**
 * Whether this message is a bounce rather than a person writing.
 *
 * Deliberately requires more than a suspicious sender: staff do sometimes write from odd
 * addresses, and mistaking a real reply for a bounce would throw away an attestation. A machine
 * report either declares itself in the MIME type or carries the RFC 3464 fields.
 */
export function isBounce(msg: { from: string; subject: string; text: string; headers?: string }): boolean {
  const headers = msg.headers ?? "";
  if (/report-type\s*=\s*"?delivery-status/i.test(headers)) return true;
  const structured = /^\s*Final-Recipient:/im.test(msg.text) || /^\s*Diagnostic-Code:/im.test(msg.text);
  if (structured) return true;
  // Fall back to the pair: a daemon-ish sender AND a subject that says what happened.
  return DAEMON.test(msg.from) && SUBJECT.test(msg.subject);
}

export function parseBounce(msg: { from: string; subject: string; text: string }): Bounce {
  const text = msg.text;

  const recipient =
    pick(text, /^\s*(?:Final|Original)-Recipient:\s*(?:rfc822;)?\s*(.+)$/im) ??
    pick(text, /^\s*(?:X-Failed-Recipients|X-Actual-Recipient):\s*(?:rfc822;)?\s*(.+)$/im) ??
    // Postfix and Gmail both quote the address in angle brackets in the prose part.
    pick(text, /<([^<>@\s]+@[^<>@\s]+)>:?\s*(?:\r?\n)?\s*(?:host|:|\()/i) ??
    null;

  const diagnostic =
    pick(text, /^\s*Diagnostic-Code:\s*(?:smtp;)?\s*([\s\S]*?)(?:\r?\n\S|\r?\n\r?\n|$)/im) ??
    // Postfix and friends put the code mid-line after "said:", wrapped over several indented
    // lines — anchoring on the start of a line missed all of it and fell through to the subject,
    // which says "Undelivered Mail" and explains nothing.
    pick(text, /\bsaid:\s*([\s\S]*?)(?:\r?\n\r?\n|$)/i) ??
    pick(text, /\b(5\d\d[ -][^\r\n]+)/m) ??
    pick(text, /\b(4\d\d[ -][^\r\n]+)/m) ??
    msg.subject ??
    "The receiving server refused the message and gave no reason.";

  const status = pick(text, /^\s*Status:\s*([245])\.\d+\.\d+/im);
  const permanent = status ? status === "5" : /\b5\d\d\b|permanent/i.test(diagnostic);

  return {
    recipient: recipient ? cleanAddress(recipient) : null,
    diagnostic: collapse(diagnostic).slice(0, 400),
    permanent,
  };
}

function pick(text: string, re: RegExp): string | null {
  const m = re.exec(text);
  return m?.[1]?.trim() || null;
}

function collapse(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

function cleanAddress(raw: string): string {
  const inAngles = /<([^<>]+)>/.exec(raw);
  return (inAngles?.[1] ?? raw).trim().replace(/[;,.]+$/, "").toLowerCase();
}

/**
 * The sentence to put in front of the pharmacist-in-charge.
 *
 * Written to name the address, because the most common cause by far is that the address on file is
 * wrong — a typo, or a placeholder that was never replaced — and seeing it spelled out is the
 * whole diagnosis.
 */
export function describeBounce(b: Bounce): string {
  const who = b.recipient ? `to ${b.recipient}` : "to an address the report did not name";
  return b.permanent
    ? `Delivery ${who} failed and will not be retried: ${b.diagnostic}`
    : `Delivery ${who} is being deferred and has not arrived yet: ${b.diagnostic}`;
}
