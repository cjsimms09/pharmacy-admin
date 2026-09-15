/**
 * The ERA (835) enrolment request, built from what a contract actually said.
 *
 * The owner: *"Want to automate request to have 835s sent to this site instead of where they
 * currently go!"* — the remittances go somewhere else today, and every one that does is a payment
 * this site cannot post against the claim it paid.
 *
 * What was already here wrote one letter, to one email address, from the pharmacy's own
 * identifiers. It never read the contract. So a payer whose enrolment is a PDF form, or a portal,
 * or a clearinghouse with a trading-partner id, got a letter asking to be emailed an 835 — which
 * is not how that payer's enrolment works and would be answered, at best, with the form.
 *
 * Session 1's extraction now supplies the three things a request is actually addressed with:
 * `enrollmentFormUrl`, `clearinghouse` and `tradingPartnerId`, beside `enrollmentMethod` and the
 * payment/EFT contacts. This decides from them **how** the request goes, and produces either the
 * letter or the list of fields somebody has to type into a portal the site cannot drive.
 *
 * Two rules run through it:
 *
 * - **Nothing is invented.** A field the contract did not state is listed as missing, by the name
 *   somebody would recognise, with where to get it. A request sent with a guessed NPI or a guessed
 *   trading-partner id is worse than no request: it is answered weeks later with a rejection that
 *   nobody connects back to the guess.
 * - **The site never sends on its own.** This builds; a person presses. Enrolment changes where
 *   money is reported, and a wrong one sent unattended could stop remittances arriving anywhere.
 *
 * Pure: no database, no network, no clock. `era-enrollment.ts` gathers the facts.
 */

/** The pharmacy, as the request has to state it. */
export type Identity = {
  name: string;
  ncpdp: string | null;
  npi: string | null;
  tin: string | null;
  address: string | null;
  phone: string | null;
  /** The mailbox the site reads, which is where the 835 is being asked to go. */
  mailbox: string | null;
};

/** A contact the contract names for payment or EFT/ERA. */
export type PaymentContact = {
  name?: string | null;
  organisation?: string | null;
  email?: string | null;
  phone?: string | null;
  fax?: string | null;
  portalUrl?: string | null;
  postalAddress?: string | null;
};

/**
 * What the contract said about remittance, as `contract-terms.ts` supplies it.
 *
 * Field names are the extraction's own (`terms.remittance`), so nothing is renamed on the way in
 * and a reader can check this against the schema without a translation table.
 */
export type EnrolmentFacts = {
  pbmName: string;
  paidBy?: string | null;
  paymentMethod?: string | null;
  paymentCycle?: string | null;
  eraOffered?: boolean | null;
  enrollmentMethod?: string | null;
  enrollmentFormUrl?: string | null;
  clearinghouse?: string | null;
  tradingPartnerId?: string | null;
  remittanceContact?: string | null;
  payerIdentifiers?: string[];
  contacts?: PaymentContact[];
  /** The document this came from, so the page can say where it read it. Null where nothing was read. */
  readFrom?: string | null;
};

/** How the request has to travel, and why that was decided. */
export type Route =
  | { how: "form"; target: string; why: string }
  | { how: "portal"; target: string | null; why: string }
  | { how: "email"; target: string; why: string }
  | { how: "post"; target: string; why: string }
  | { how: "unknown"; target: null; why: string };

/** Where the site's enrolment stands with one payer. Mirrors `era_enrollments.status`. */
export type EnrolmentState = "not_started" | "requested" | "confirmed" | "receiving" | "declined";

export type RequestField = { label: string; value: string | null; note?: string };

export type EraRequest = {
  pbmName: string;
  route: Route;
  /** What is still needed before this can go, each in words, with where to get it. */
  missing: string[];
  /** True when nothing is missing and there is somewhere to send it. */
  ready: boolean;
  /** The letter, where the route is one a letter serves. Null for a portal the site cannot drive. */
  letter: { title: string; body: string; lines: { text: string; bold?: boolean; size?: number; gapBefore?: number }[] } | null;
  /** What somebody has to type, where the site cannot do the typing. */
  fields: RequestField[];
  /** The one sentence saying what to do next. */
  nextAction: string;
};

const clean = (s: string | null | undefined): string | null => {
  const t = (s ?? "").replace(/\s+/g, " ").trim();
  return t.length > 0 ? t : null;
};

/** Whether a string looks like an address a request could be sent to. Deliberately unfussy. */
const isEmail = (s: string | null | undefined): boolean => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test((s ?? "").trim());
const isUrl = (s: string | null | undefined): boolean => /^https?:\/\/\S+$/i.test((s ?? "").trim());

/**
 * How this payer's enrolment is actually done.
 *
 * Specificity again, and in this order for a reason. A form URL is the most specific thing a
 * contract can say — it is the enrolment, named. A portal comes next. An email is a person, and a
 * person can redirect to the form, so it ranks below the form but is still a real target. Post is
 * last of the real ones because it is the slowest. `enrollmentMethod` is prose and only breaks the
 * tie where no address of any kind was printed.
 *
 * A contract that says no 835 is offered is not "unknown": it is a fact, and the answer to it is a
 * question to the payer rather than an enrolment form. Saying so is the point — the alternative is
 * the pharmacy waiting for a remittance that was never going to come.
 */
export function routeFor(facts: EnrolmentFacts): Route {
  const form = clean(facts.enrollmentFormUrl);
  if (form && isUrl(form)) return { how: "form", target: form, why: "The contract prints the enrolment form's address." };

  const contacts = facts.contacts ?? [];
  const portal = clean(contacts.map((c) => c.portalUrl).find((u) => isUrl(u)) ?? null);
  if (portal) return { how: "portal", target: portal, why: "The contract names a portal for payment or EFT enrolment." };

  const email = clean(contacts.map((c) => c.email).find((e) => isEmail(e)) ?? null) ?? (isEmail(facts.remittanceContact) ? clean(facts.remittanceContact) : null);
  if (email) return { how: "email", target: email, why: "The contract names an address for payment or EFT enrolment." };

  const post = clean(contacts.map((c) => c.postalAddress).find(Boolean) ?? null);
  if (post) return { how: "post", target: post, why: "The contract gives a postal address for payment enrolment and no electronic one." };

  const method = clean(facts.enrollmentMethod);
  if (method && /portal|online|web/i.test(method)) {
    return { how: "portal", target: null, why: `The contract says enrolment is done online — “${method}” — but prints no address for it.` };
  }
  if (facts.eraOffered === false) {
    return { how: "unknown", target: null, why: "The contract says no electronic remittance is offered, so there is no enrolment to make — this needs asking rather than filling in." };
  }
  return { how: "unknown", target: null, why: method ? `The contract says “${method}” and gives no form, portal or address to use.` : "The contract does not say how remittance enrolment is changed." };
}

/**
 * What is still needed, in the words somebody would use, with where to get each.
 *
 * The pharmacy's own four come first because they are the same four every time and they are all
 * one screen away. The payer-specific ones come after, because they need a document read.
 */
export function missingFor(facts: EnrolmentFacts, id: Identity, route: Route): string[] {
  const missing: string[] = [];
  if (!clean(id.ncpdp)) missing.push("the pharmacy's NCPDP number (Settings → Pharmacy)");
  if (!clean(id.npi)) missing.push("the pharmacy's NPI (Settings → Pharmacy)");
  if (!clean(id.tin)) missing.push("the pharmacy's TIN (Settings → Pharmacy)");
  if (!clean(id.mailbox)) missing.push("a mailbox for the site to receive the 835 at (Settings → Email)");
  if (route.how === "unknown") {
    missing.push(
      facts.readFrom
        ? `where ${facts.pbmName} takes an ERA enrolment — its contract was read and did not say, so ask them, or add a payment contact on its payer page`
        : `${facts.pbmName}'s contract has not been read yet, so nothing is known about how it enrols ERA`,
    );
  }
  if (route.how === "portal" && !route.target) {
    missing.push(`the address of ${facts.pbmName}'s enrolment portal — the contract says there is one but does not print it`);
  }
  return missing;
}

/**
 * The fields a person has to type where the site cannot do the typing.
 *
 * A portal is somebody else's website and this will not drive it. What it can do is put every
 * answer on one screen in the order a form asks for them, so the job is copying rather than
 * hunting through Settings, the contract and a bank letter. A value of null is shown as missing
 * rather than blank, because a blank box on a form is how a field gets skipped.
 */
export function fieldsFor(facts: EnrolmentFacts, id: Identity, deliveryTarget: string | null): RequestField[] {
  const fields: RequestField[] = [
    { label: "Pharmacy name", value: clean(id.name) },
    { label: "NPI", value: clean(id.npi) },
    { label: "NCPDP", value: clean(id.ncpdp) },
    { label: "Tax ID (TIN)", value: clean(id.tin) },
    { label: "Address", value: clean(id.address) },
    { label: "Phone", value: clean(id.phone) },
    { label: "Send the 835 to", value: clean(deliveryTarget), note: "The mailbox this site reads. This is the change being asked for." },
  ];
  const ch = clean(facts.clearinghouse);
  if (ch) fields.push({ label: "Clearinghouse / EDI vendor", value: ch, note: `As ${facts.pbmName}'s contract names it.` });
  const tp = clean(facts.tradingPartnerId);
  if (tp) fields.push({ label: "Trading partner ID", value: tp, note: `As printed in ${facts.pbmName}'s contract. Check it against what they have on file before submitting.` });
  const ids = (facts.payerIdentifiers ?? []).map(clean).filter((x): x is string => x !== null);
  if (ids.length) fields.push({ label: `${facts.pbmName} payer ID`, value: ids.join(", "), note: "From the contract. A form usually wants one of these, not the pharmacy's." });
  return fields;
}

/** The request as a letter. Only where a letter is the thing that goes. */
export function letterFor(facts: EnrolmentFacts, id: Identity, deliveryTarget: string, route: Route): EraRequest["letter"] {
  if (route.how !== "email" && route.how !== "post") return null;
  const title = `ERA (835) enrollment request — ${id.name} — ${facts.pbmName}`;
  const via = clean(facts.clearinghouse);
  const tp = clean(facts.tradingPartnerId);
  const paragraphs = [
    `${id.name} requests enrollment for electronic remittance advice (ASC X12 835) for all claims adjudicated by ${facts.pbmName}, delivered to ${deliveryTarget}.`,
    `Pharmacy: ${id.name}${id.address ? `, ${id.address}` : ""}${id.phone ? `, ${id.phone}` : ""}.`,
    `NCPDP ${id.ncpdp ?? "—"} · NPI ${id.npi ?? "—"} · TIN ${id.tin ?? "—"}.`,
    // Named only where the contract named them. Inventing either would have the request rejected
    // by a clearinghouse the pharmacy does not use, weeks later, for a reason nobody traces back.
    via || tp
      ? `Your agreement names ${[via && `${via} as the clearinghouse`, tp && `trading partner ID ${tp}`].filter(Boolean).join(" and ")}. Please confirm this is still where our remittances are routed, and change the delivery point as above.`
      : null,
    facts.paymentCycle ? `We understand remittance is issued ${facts.paymentCycle}.` : null,
    "Please confirm the enrollment, the effective date, and the first remittance cycle it will apply to. If a form or portal enrollment is required instead, please reply with the form or the link and it will be completed the same day.",
    "Thank you.",
  ].filter((p): p is string => p !== null);
  const lines = [
    { text: title, bold: true, size: 14 },
    ...paragraphs
      .flatMap((p) => (p.match(/.{1,110}(\s|$)/g) ?? [p]).map((t) => ({ text: t.trim() })))
      .map((l, i) => (i === 0 ? { ...l, gapBefore: 6 } : l)),
  ];
  return { title, lines, body: paragraphs.join("\n\n") };
}

/**
 * The one sentence telling the owner what to do about this payer next.
 *
 * The state comes first, because "sent three weeks ago and never answered" is a different job from
 * "never asked". The route only decides the wording of the doing.
 */
export function nextActionFor(facts: EnrolmentFacts, route: Route, missing: string[], state: EnrolmentState): string {
  if (state === "receiving") return `Done — 835s from ${facts.pbmName} are arriving here.`;
  if (state === "confirmed") return `${facts.pbmName} has confirmed. Nothing to do until the first 835 arrives; if none comes by the next payment cycle, chase it.`;
  if (state === "declined") return `${facts.pbmName} declined. Its payments will have to be posted from whatever it does send, so keep the remittance it provides coming to the inbox.`;
  if (state === "requested") {
    return route.how === "email"
      ? `Asked, and waiting on ${facts.pbmName}. If there is no answer by the next payment cycle, chase ${route.target}.`
      : `Marked as asked. Waiting on ${facts.pbmName} to confirm.`;
  }
  if (missing.length > 0) return `Not ready: ${missing[0]}${missing.length > 1 ? `, and ${missing.length - 1} more` : ""}.`;
  switch (route.how) {
    case "form":
      return `Open ${facts.pbmName}'s enrolment form, fill it from the answers below, and mark this as asked once it is submitted.`;
    case "portal":
      return `Sign in to ${facts.pbmName}'s portal, type the answers below into its ERA enrolment, and mark this as asked.`;
    case "email":
      return `Ready to send to ${route.target}. Read the letter, then send it.`;
    case "post":
      return `No electronic route: print the letter and post it to ${route.target}.`;
    default:
      return `Ask ${facts.pbmName} how to have the 835 sent here. Nothing on file says how.`;
  }
}

/** Everything above, in one answer, for one payer. */
export function buildEraRequest(
  facts: EnrolmentFacts,
  id: Identity,
  state: EnrolmentState = "not_started",
): EraRequest {
  const route = routeFor(facts);
  const missing = missingFor(facts, id, route);
  const deliveryTarget = clean(id.mailbox);
  return {
    pbmName: facts.pbmName,
    route,
    missing,
    ready: missing.length === 0,
    letter: deliveryTarget ? letterFor(facts, id, deliveryTarget, route) : null,
    fields: fieldsFor(facts, id, deliveryTarget),
    nextAction: nextActionFor(facts, route, missing, state),
  };
}
