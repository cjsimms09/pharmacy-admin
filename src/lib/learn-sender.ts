/**
 * Learning where a supplier's invoices come from, instead of asking.
 *
 * The owner: "why do I have to put in the email that invoices come from for each supplier? Once we
 * get an invoice from a supplier and I tell the system it's an invoice from that supplier it should
 * automatically save that email as where invoices come from."
 *
 * Exactly so. The pharmacy already has both halves at the moment he files one: the message the
 * attachment arrived on knows the sender, and he has just said which wholesaler it is from. Making
 * him then go to a settings page and type that address in is asking him to tell the site something
 * it watched happen.
 *
 * ── What is and is not learned ──
 *
 * The full address, never the bare domain. A domain is what `supplierForSender` falls back to when
 * a wholesaler mails from a different mailbox each month, and it is a judgement about a company —
 * "anything from mckesson.com is McKesson" — which is the owner's to make and not a guess to be
 * made on his behalf from one message. Learning `ar-billing@mckesson.com` from an invoice that
 * really came from it asserts nothing he has not just confirmed.
 *
 * Nothing is learned from an address already covered, so filing a hundred McKesson invoices adds
 * one line and not a hundred. Nothing is learned from an address another supplier already claims,
 * because two suppliers on one address makes every later message ambiguous and the register should
 * say so rather than quietly pick one.
 *
 * Pure, so it is tested.
 */

export type LearnResult =
  | { learn: true; address: string; senderEmails: string; why: string }
  | { learn: false; why: string };

const clean = (v: string | null | undefined): string => (v ?? "").trim().toLowerCase();

/** The lines a supplier's `senderEmails` field holds, tidied. */
export function senderLines(senderEmails: string | null | undefined): string[] {
  return (senderEmails ?? "")
    .split("\n")
    .map((l) => l.trim().toLowerCase())
    .filter(Boolean);
}

/** The address part of a From header, which may be "Name <addr@host>" or bare. */
export function addressIn(from: string | null | undefined): string | null {
  const raw = clean(from);
  if (!raw) return null;
  const angled = /<([^>]+)>/.exec(raw)?.[1];
  const candidate = (angled ?? raw).trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(candidate)) return null;
  return candidate;
}

export type SupplierSenders = { id: string; name: string; senderEmails: string | null };

/**
 * Whether filing this invoice should teach the supplier a new address, and the field to save.
 *
 * `others` is every other supplier in the register, so an address one of them already claims is
 * left alone rather than being attached to two.
 */
export function learnSender(supplier: SupplierSenders, from: string | null | undefined, others: SupplierSenders[] = []): LearnResult {
  const address = addressIn(from);
  if (!address) return { learn: false, why: "the message carries no readable sender address" };

  const mine = senderLines(supplier.senderEmails);
  /*
   * Already covered counts a domain too. A supplier set to "mckesson.com" is meant to accept every
   * mailbox at McKesson, and adding each one as it appears would turn a deliberate rule into a list
   * that grows for ever and hides the rule underneath it.
   */
  const covered = mine.find((m) => address === m || address.endsWith(`@${m}`) || address.includes(m));
  if (covered) return { learn: false, why: `already filed under ${covered}` };

  const claimed = others.find((o) => o.id !== supplier.id && senderLines(o.senderEmails).some((m) => address === m || address.endsWith(`@${m}`)));
  if (claimed) return { learn: false, why: `${claimed.name} already receives invoices from ${address}, so this was not added to two suppliers` };

  return {
    learn: true,
    address,
    senderEmails: [...mine, address].join("\n"),
    why: `invoices from ${address} will now file themselves as ${supplier.name}`,
  };
}
