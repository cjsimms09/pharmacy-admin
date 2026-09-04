import "server-only";
import { and, eq, gte, lte } from "drizzle-orm";
import { db, schema } from "@/db";
import { newId } from "./crypto";
import { todayIso, lastDayOfMonth, monthName, fmtLong } from "./dates";
import { getSettings } from "./settings";
import type { DriverInvoiceStatus } from "@/db/schema";

/**
 * The delivery driver's month, from a number typed at the counter to an invoice in somebody's
 * inbox.
 *
 * He is paid a flat rate for each run: every prescription delivery, and the mail trip that
 * happens every weekday. The invoice was a spreadsheet, which meant that by the time it was
 * written the count for a Tuesday three weeks earlier existed only in somebody's memory, and the
 * person being paid was the person remembering.
 *
 * The whole design turns on one distinction: a weekday with no answer yet and a weekday with no
 * deliveries are different things and must never look the same. A blank is unfinished work; a
 * zero is a fact. Conflating them either sends an invoice short or leaves one that can never be
 * finished, so a day is only counted once somebody has said what happened on it, and a closed
 * day is recorded as closed rather than skipped.
 *
 * Everything else follows from that. The month is finished when every weekday has an answer. The
 * invoice raises itself at that moment and goes, because the alternative — a screen that says
 * "ready to send" — is a screen somebody has to remember to visit.
 */

export const DEFAULT_RATE_CENTS = 900;

export type DeliveryDay = typeof schema.deliveryDays.$inferSelect;
export type DriverInvoice = typeof schema.driverInvoices.$inferSelect;

/** One line of the invoice, frozen into it at issue. */
export type InvoiceLine = {
  onDate: string;
  deliveries: number;
  mailTrips: number;
  trips: number;
  amountCents: number;
  note: string | null;
};

const WEEKDAY = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

/** Monday to Friday. Weekend work is not part of this arrangement and is not invited. */
export function isWeekday(iso: string): boolean {
  const d = new Date(`${iso}T12:00:00Z`).getUTCDay();
  return d >= 1 && d <= 5;
}

export function weekdayName(iso: string): string {
  return WEEKDAY[new Date(`${iso}T12:00:00Z`).getUTCDay()] ?? "";
}

/** Every Monday-to-Friday date in a month, in order. */
export function weekdaysIn(month: string): string[] {
  const [y, m] = month.split("-").map(Number);
  if (!y || !m) return [];
  const last = Number(lastDayOfMonth(y, m).slice(8, 10));
  const out: string[] = [];
  for (let d = 1; d <= last; d++) {
    const iso = `${month}-${String(d).padStart(2, "0")}`;
    if (isWeekday(iso)) out.push(iso);
  }
  return out;
}

export function monthLabel(month: string): string {
  const [y, m] = month.split("-").map(Number);
  return `${monthName(m)} ${y}`;
}

export type DaySlot = {
  onDate: string;
  weekday: string;
  /** Null until somebody has said what happened. Not the same as a day with nothing on it. */
  day: DeliveryDay | null;
  trips: number;
  amountCents: number;
  /** A day that has not happened yet cannot be filled in, and should not read as missing. */
  future: boolean;
};

export type MonthState = {
  month: string;
  label: string;
  slots: DaySlot[];
  weekdays: number;
  entered: number;
  /** Weekdays already past with no answer yet — the work left before the invoice can go. */
  missing: string[];
  deliveries: number;
  mailTrips: number;
  trips: number;
  totalCents: number;
  rateCents: number;
  /** Every weekday in the month has an answer. */
  complete: boolean;
  lastWeekday: string | null;
  invoice: DriverInvoice | null;
  /** Set when the figures have moved since the invoice went out. */
  changedSinceSent: boolean;
};

export async function monthState(month: string): Promise<MonthState> {
  const dates = weekdaysIn(month);
  const [rows, s, invoice] = await Promise.all([
    dates.length
      ? db.query.deliveryDays.findMany({
          where: and(gte(schema.deliveryDays.onDate, dates[0]), lte(schema.deliveryDays.onDate, dates[dates.length - 1])),
        })
      : Promise.resolve([]),
    getSettings(),
    currentInvoice(month),
  ]);

  const rate = Number(s.driver_rate_cents) || DEFAULT_RATE_CENTS;
  const today = todayIso();
  const byDate = new Map(rows.map((r) => [r.onDate, r]));

  const slots: DaySlot[] = dates.map((onDate) => {
    const day = byDate.get(onDate) ?? null;
    const trips = day ? day.deliveries + day.mailTrips : 0;
    return { onDate, weekday: weekdayName(onDate), day, trips, amountCents: trips * rate, future: onDate > today };
  });

  const entered = slots.filter((x) => x.day).length;
  const deliveries = slots.reduce((n, x) => n + (x.day?.deliveries ?? 0), 0);
  const mailTrips = slots.reduce((n, x) => n + (x.day?.mailTrips ?? 0), 0);
  const trips = deliveries + mailTrips;

  return {
    month,
    label: monthLabel(month),
    slots,
    weekdays: dates.length,
    entered,
    missing: slots.filter((x) => !x.day && !x.future).map((x) => x.onDate),
    deliveries,
    mailTrips,
    trips,
    totalCents: trips * rate,
    rateCents: rate,
    complete: dates.length > 0 && entered === dates.length,
    lastWeekday: dates.at(-1) ?? null,
    invoice,
    changedSinceSent: Boolean(
      invoice?.sentAt && (invoice.deliveries !== deliveries || invoice.mailTrips !== mailTrips),
    ),
  };
}

/** The invoice standing for a month — the live one, not a superseded predecessor. */
export async function currentInvoice(month: string): Promise<DriverInvoice | null> {
  const rows = await db.query.driverInvoices.findMany({ where: eq(schema.driverInvoices.month, month) });
  const live = rows.filter((r) => r.status !== "superseded").sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return live[0] ?? null;
}

/**
 * Records what happened on one day.
 *
 * A future date is refused rather than accepted and corrected later: a count entered for a day
 * that has not happened is a guess, and a guess in an invoice is somebody being over- or
 * underpaid. A weekend is refused for the same reason it never appears — it is not part of the
 * arrangement, and a stray Saturday would make a finished month look unfinished for ever.
 */
export async function saveDay(
  onDate: string,
  input: { deliveries: number; mailTrips: number; note?: string | null },
  user: { name: string },
): Promise<void> {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(onDate)) throw new Error("That is not a date.");
  if (!isWeekday(onDate)) throw new Error("Deliveries are only invoiced Monday to Friday, so a weekend cannot be entered.");
  if (onDate > todayIso()) throw new Error("That day has not happened yet.");

  const deliveries = Math.trunc(input.deliveries);
  const mailTrips = Math.trunc(input.mailTrips);
  if (!Number.isFinite(deliveries) || deliveries < 0 || deliveries > 200) throw new Error("Deliveries has to be a number from 0 upwards.");
  if (!Number.isFinite(mailTrips) || mailTrips < 0 || mailTrips > 10) throw new Error("Mail trips has to be a number from 0 upwards.");

  const note = (input.note ?? "").trim() || null;
  const existing = await db.query.deliveryDays.findFirst({ where: eq(schema.deliveryDays.onDate, onDate) });

  if (existing) {
    await db
      .update(schema.deliveryDays)
      .set({ deliveries, mailTrips, note, updatedBy: user.name, updatedAt: new Date().toISOString() })
      .where(eq(schema.deliveryDays.id, existing.id));
    return;
  }
  await db.insert(schema.deliveryDays).values({ id: newId(), onDate, deliveries, mailTrips, note, enteredBy: user.name });
}

/** Puts a day back to having no answer, for one entered against the wrong date. */
export async function clearDay(onDate: string): Promise<void> {
  await db.delete(schema.deliveryDays).where(eq(schema.deliveryDays.onDate, onDate));
}

/**
 * A number nobody has used before, and nobody can predict.
 *
 * The pharmacy asked for a random one each month rather than a sequence. That is the right
 * instinct for an invoice raised on somebody else's behalf: a sequence tells the person paying it
 * how many other invoices exist, and an obviously guessable one invites a duplicate being paid
 * twice.
 */
async function nextInvoiceNumber(): Promise<string> {
  const taken = new Set((await db.query.driverInvoices.findMany()).map((r) => r.invoiceNumber));
  for (let i = 0; i < 200; i++) {
    const n = String(10000 + Math.floor(Math.random() * 90000));
    if (!taken.has(n)) return n;
  }
  // Not reachable in any realistic life of this pharmacy, but a collision must never silently
  // reuse a number that is already on somebody's paid invoice.
  throw new Error("Could not find an unused invoice number.");
}

export type IssueResult = { invoice: DriverInvoice; lines: InvoiceLine[] };

/**
 * Raises the invoice for a finished month.
 *
 * The totals, the rate and every line are copied into the row rather than referenced, because
 * what was sent is a fact about a payment somebody made. Rebuilding it later from the day rows
 * would quietly rewrite history the first time a day was corrected.
 */
export async function issueInvoice(month: string, user: { name: string }): Promise<IssueResult> {
  const state = await monthState(month);
  if (!state.complete) {
    throw new Error(
      `${state.label} is not finished — ${state.missing.length} weekday${state.missing.length === 1 ? "" : "s"} still have no answer.`,
    );
  }
  const s = await getSettings();
  const driverName = (s.driver_name ?? "").trim() || "the driver";

  const lines: InvoiceLine[] = state.slots.map((x) => ({
    onDate: x.onDate,
    deliveries: x.day?.deliveries ?? 0,
    mailTrips: x.day?.mailTrips ?? 0,
    trips: x.trips,
    amountCents: x.amountCents,
    note: x.day?.note ?? null,
  }));

  // A month being invoiced again supersedes what went before rather than editing it. The person
  // paying needs to see that a second document exists and why, not find the first one changed.
  const previous = await currentInvoice(month);
  if (previous) {
    await db.update(schema.driverInvoices).set({ status: "superseded" }).where(eq(schema.driverInvoices.id, previous.id));
  }

  const id = newId();
  await db.insert(schema.driverInvoices).values({
    id,
    month,
    invoiceNumber: await nextInvoiceNumber(),
    driverName,
    rateCents: state.rateCents,
    deliveries: state.deliveries,
    mailTrips: state.mailTrips,
    totalCents: state.totalCents,
    linesJson: JSON.stringify(lines),
    status: "draft",
    issuedBy: user.name,
  });

  const invoice = await db.query.driverInvoices.findFirst({ where: eq(schema.driverInvoices.id, id) });
  return { invoice: invoice!, lines };
}

export function linesOf(invoice: DriverInvoice): InvoiceLine[] {
  try {
    const parsed = JSON.parse(invoice.linesJson);
    return Array.isArray(parsed) ? (parsed as InvoiceLine[]) : [];
  } catch {
    return [];
  }
}

export const money = (cents: number) =>
  `$${(cents / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/** Who it is addressed to and what it says about being paid. */
export async function invoiceParties() {
  const s = await getSettings();
  return {
    driverName: (s.driver_name ?? "").trim() || "the driver",
    billToName: (s.driver_bill_to ?? "").trim() || "West Wichita Family Physicians, PA",
    sendTo: (s.driver_invoice_to ?? "").trim(),
    forWhom: s.pharmacy_name || "the pharmacy",
    terms:
      (s.driver_payment_terms ?? "").trim() ||
      `Payment by bank transfer, or by check made payable to ${(s.driver_name ?? "the driver").trim()}.`,
    autoSend: s.driver_invoice_auto !== "no",
  };
}

export type SendResult = { ok: boolean; message: string };

/**
 * Files the PDF and emails it.
 *
 * Filed first, always. An invoice that was sent and cannot be produced afterwards is a
 * conversation nobody can win, and the document is the only thing that settles what was claimed.
 */
export async function sendInvoice(invoiceId: string, user: { name: string }): Promise<SendResult> {
  const invoice = await db.query.driverInvoices.findFirst({ where: eq(schema.driverInvoices.id, invoiceId) });
  if (!invoice) throw new Error("That invoice no longer exists.");

  const parties = await invoiceParties();
  if (!parties.sendTo) {
    throw new Error("Nobody is set to receive these. Put the address under Deliveries → who it goes to.");
  }

  const { invoicePdf } = await import("./driver-invoice-pdf");
  const pdf = invoicePdf(invoice, linesOf(invoice), parties);
  const fileName = `delivery-invoice-${invoice.month}-${invoice.invoiceNumber}.pdf`;

  // Filed even if the send then fails: the record of what was claimed must not depend on a mail
  // server being reachable.
  let documentId = invoice.documentId;
  if (!documentId) {
    const { storeFile } = await import("./files");
    const stored = await storeFile(new File([new Uint8Array(pdf)], fileName, { type: "application/pdf" }), {
      allowReportTypes: true,
    });
    documentId = newId();
    await db.insert(schema.documents).values({
      id: documentId,
      category: "driver_invoice",
      title: `Delivery invoice ${invoice.invoiceNumber} — ${monthLabel(invoice.month)}`,
      fileName,
      mimeType: stored.mimeType,
      sizeBytes: stored.sizeBytes,
      sha256: stored.sha256,
      storageKey: stored.storageKey,
      effectiveOn: invoice.month + "-01",
      notes: `Delivery invoice for ${parties.driverName}, ${monthLabel(invoice.month)}.`,
      uploadedBy: user.name,
    });
    await db.update(schema.driverInvoices).set({ documentId }).where(eq(schema.driverInvoices.id, invoice.id));
  }

  const { sendMail } = await import("./send-mail");
  const body = [
    "Please find attached the delivery invoice for " + monthLabel(invoice.month) + ".",
    "",
    `Invoice ${invoice.invoiceNumber}`,
    `${invoice.deliveries} deliveries and ${invoice.mailTrips} mail trips, ${invoice.deliveries + invoice.mailTrips} in total at ${money(invoice.rateCents)} each.`,
    `Amount due: ${money(invoice.totalCents)}`,
    "",
    parties.terms,
    "",
    `Raised by ${parties.forWhom} on behalf of ${parties.driverName}.`,
  ].join("\n");

  const r = await sendMail(
    parties.sendTo,
    `Delivery invoice ${invoice.invoiceNumber} — ${monthLabel(invoice.month)} — ${money(invoice.totalCents)}`,
    body,
    [{ filename: fileName, content: pdf, contentType: "application/pdf" }],
  );

  await db
    .update(schema.driverInvoices)
    .set(
      r.ok
        ? { status: "sent", sentAt: new Date().toISOString(), sentTo: parties.sendTo, sendError: null }
        : { status: "failed", sendError: r.error },
    )
    .where(eq(schema.driverInvoices.id, invoice.id));

  return r.ok
    ? {
        ok: true,
        message: `Invoice ${invoice.invoiceNumber} for ${monthLabel(invoice.month)} — ${money(invoice.totalCents)} — accepted for delivery to ${parties.sendTo}. A copy is filed and can be produced later.`,
      }
    : { ok: false, message: `Invoice ${invoice.invoiceNumber} is raised and filed, but could not be emailed: ${r.error}` };
}

/**
 * The moment the month finishes, which is the moment the invoice goes.
 *
 * Called after every day is saved, so nothing has to be remembered on the last working day of the
 * month. A screen that says "ready to send" is a screen somebody has to think to visit, and the
 * whole reason this exists is that the driver was waiting on somebody remembering.
 */
export async function closeMonthIfComplete(month: string, user: { name: string }): Promise<SendResult | null> {
  const state = await monthState(month);
  if (!state.complete) return null;
  const parties = await invoiceParties();
  if (!parties.autoSend) return null;

  // Already invoiced and nothing has moved: there is nothing to do, and re-sending an invoice
  // somebody has already paid is worse than not sending one.
  if (state.invoice && !state.changedSinceSent && state.invoice.status === "sent") return null;

  const target = state.invoice && !state.changedSinceSent && state.invoice.status !== "sent"
    ? state.invoice
    : (await issueInvoice(month, user)).invoice;

  try {
    return await sendInvoice(target.id, user);
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : "The invoice could not be sent." };
  }
}

/** Every invoice ever raised, newest first — the archive the pharmacy asked to keep. */
export async function allInvoices(): Promise<DriverInvoice[]> {
  return db.query.driverInvoices.findMany({ orderBy: (i, { desc }) => [desc(i.month), desc(i.createdAt)] });
}

/** Months that have any day recorded, so the archive can offer real months only. */
export async function monthsWithDays(): Promise<string[]> {
  const rows = await db.query.deliveryDays.findMany();
  return [...new Set(rows.map((r) => r.onDate.slice(0, 7)))].sort().reverse();
}

export type DriverStatus = { status: DriverInvoiceStatus; label: string };

export function statusLabel(s: DriverInvoiceStatus): string {
  return s === "sent" ? "sent" : s === "failed" ? "could not be sent" : s === "superseded" ? "replaced" : "raised, not sent";
}

/** Used by the background job, so a month that finished while nobody was looking still goes out. */
export async function catchUpInvoices(user: { name: string }): Promise<string[]> {
  const done: string[] = [];
  const today = todayIso();
  for (const month of await monthsWithDays()) {
    // Only months that are over. A month still running cannot be complete anyway, and asking is
    // cheaper than a query per month.
    if (month >= today.slice(0, 7)) continue;
    const r = await closeMonthIfComplete(month, user);
    if (r) done.push(`${monthLabel(month)}: ${r.message}`);
  }
  return done;
}

void fmtLong;

/**
 * The invoice for a month, whether or not it has been raised yet.
 *
 * Somebody about to send an invoice to another company's accounts department wants to see the
 * document first. Before it is raised there is no row to read, so a provisional one is built from
 * the month as it stands — the same builder, the same layout, the same figures. The only thing
 * that cannot be shown is the invoice number, because that is issued at the moment of raising and
 * inventing one for a preview would put a number on a page that will never exist.
 *
 * A month already invoiced previews what was actually sent, not a fresh calculation of it. The
 * question being asked is "what did Shelly get", and answering it with today's arithmetic would
 * be answering a different one.
 */
export async function previewInvoice(
  month: string,
): Promise<{ invoice: DriverInvoice; lines: InvoiceLine[]; provisional: boolean } | null> {
  const existing = await currentInvoice(month);
  if (existing) return { invoice: existing, lines: linesOf(existing), provisional: false };

  const state = await monthState(month);
  if (state.entered === 0) return null;

  const parties = await invoiceParties();
  const lines: InvoiceLine[] = state.slots
    .filter((x) => x.day)
    .map((x) => ({
      onDate: x.onDate,
      deliveries: x.day!.deliveries,
      mailTrips: x.day!.mailTrips,
      trips: x.trips,
      amountCents: x.amountCents,
      note: x.day!.note,
    }));

  return {
    provisional: true,
    lines,
    invoice: {
      id: "preview",
      month,
      // Said plainly on the document rather than faked. A number here would be a number that
      // never gets issued, and somebody would quote it.
      invoiceNumber: "DRAFT",
      driverName: parties.driverName,
      rateCents: state.rateCents,
      deliveries: state.deliveries,
      mailTrips: state.mailTrips,
      totalCents: state.totalCents,
      linesJson: JSON.stringify(lines),
      status: "draft",
      sentTo: null,
      sentAt: null,
      sendError: null,
      documentId: null,
      issuedBy: "",
      createdAt: new Date().toISOString(),
    },
  };
}

/** The PDF for a month, built the same way whether it is a draft or the one that was sent. */
export async function invoicePdfFor(month: string): Promise<{ pdf: Buffer; fileName: string } | null> {
  const preview = await previewInvoice(month);
  if (!preview) return null;
  const parties = await invoiceParties();
  const { invoicePdf } = await import("./driver-invoice-pdf");
  return {
    pdf: invoicePdf(preview.invoice, preview.lines, parties),
    fileName: `delivery-invoice-${month}${preview.provisional ? "-draft" : `-${preview.invoice.invoiceNumber}`}.pdf`,
  };
}

/**
 * Sends the invoice to somebody else first, to prove the whole path works.
 *
 * Everything about this arrangement is automatic, which is the point and also the risk: the first
 * time anybody finds out whether the mail actually arrives is when the driver asks why he has not
 * been paid. A test send is the same code as the real one — the same PDF, the same attachment,
 * the same server — addressed somewhere harmless, so the answer is known in advance.
 *
 * It never marks the month as invoiced and never issues a number. A test that changed the state
 * it was testing would be worse than no test.
 */
export async function sendTestInvoice(month: string, to: string, user: { name: string }): Promise<SendResult> {
  const address = to.trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address)) throw new Error("That is not an email address.");

  const built = await invoicePdfFor(month);
  if (!built) throw new Error(`Nothing has been entered for ${monthLabel(month)} yet, so there is nothing to show.`);

  const preview = await previewInvoice(month);
  const parties = await invoiceParties();
  const inv = preview!.invoice;

  const { sendMail } = await import("./send-mail");
  const r = await sendMail(
    address,
    `TEST — delivery invoice ${monthLabel(month)} — ${money(inv.totalCents)}`,
    [
      `This is a test copy of the ${monthLabel(month)} delivery invoice. It has not been sent to ${parties.sendTo || "anybody else"} and the month is not marked as invoiced.`,
      "",
      preview!.provisional
        ? "The month is not finished, so this is a draft and carries no invoice number. The real one is numbered when it is raised."
        : `Invoice ${inv.invoiceNumber}, as it was sent.`,
      `${inv.deliveries} deliveries and ${inv.mailTrips} mail trips, ${inv.deliveries + inv.mailTrips} in total at ${money(inv.rateCents)} each.`,
      `Amount: ${money(inv.totalCents)}`,
      "",
      `Requested by ${user.name}.`,
    ].join("\n"),
    [{ filename: built.fileName, content: built.pdf, contentType: "application/pdf" }],
  );

  return r.ok
    ? {
        ok: true,
        message: `Test copy accepted for delivery to ${address}. If it arrives with the PDF attached and readable, the real one will too — nothing about the path differs. The month is untouched.`,
      }
    : { ok: false, message: `The test could not be sent: ${r.error}. The real invoice would fail the same way, so fix this before the month ends.` };
}
