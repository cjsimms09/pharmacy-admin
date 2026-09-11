import Link from "next/link";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { requireUser, requireManager } from "@/lib/auth";
import { audit } from "@/lib/audit";
import { fmt } from "@/lib/dates";
import {
  invoices,
  awaitingReview,
  invoiceCounts,
  invoiceIssues,
  invoiceSuppliers,
  invoiceMonths,
  setSchedule,
  setInvoiceDate,
  setInvoicePaidOn,
  forwardInvoices,
  recentForwards,
  parseExpected,
  adoptableDocuments,
  adoptAll,
  uploadInvoice,
  filingFor,
  setInvoiceTotal,
  backfillTotals,
  missingTotals,
  backfillInvoiceLines,
  invoicesWithoutLines,
  recordReceipt,
  awaitingReceipt,
  unfileInvoice,
  purgeFromInvoiceFile,
  fileMisfiled,
  misfiledInVault,
  confirmIsInvoice,
  markNotAnInvoice,
  recheckFiledInvoices,
  sumOf,
  money,
  invoicesStillOwed,
  invoicesOnFileTwice,
  settleDeliveriesOnReceipt,
} from "@/lib/invoices";
import { stillToChase, fromBeforeWeWatched } from "@/lib/invoices-owed";
import { checkInvoicePrices } from "@/lib/invoice-price-check";
import { invoiceCompliance, RETENTION_YEARS } from "@/lib/invoice-compliance";
import { setSetting } from "@/lib/settings";
import { getSettings } from "@/lib/settings";
import { allSuppliers, addressesOf, useReceiptAsInvoice } from "@/lib/suppliers-registry";
import { PageHeader, Card, Figure, Notice, Empty, Settled } from "@/components/ui";
import { SubmitButton } from "@/components/submit-button";
import { INVOICE_SCHEDULES, type InvoiceSchedule } from "@/db/schema";

export const dynamic = "force-dynamic";
export const metadata = { title: "Supplier invoices" };

const TABS: { key: InvoiceSchedule | "all"; label: string; blurb: string }[] = [
  {
    key: "schedule_2",
    label: "Schedule II",
    blurb:
      "Kept separately from every other record the pharmacy holds, as 21 CFR 1304.04(h)(1) requires — its own category, its own folder on disk, and this list, which contains nothing else.",
  },
  {
    key: "schedule_3_5",
    label: "Schedule III-V",
    blurb:
      "21 CFR 1304.04(h)(2) allows these to be separate or merely readily retrievable. They are separate, which satisfies the stricter reading of the two.",
  },
  { key: "none", label: "No controlled substances", blurb: "Ordinary business records." },
  { key: "all", label: "Everything", blurb: "Every supplier invoice, whatever it carries." },
];

const MONTH_NAMES = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const monthLabel = (m: string) => `${MONTH_NAMES[Number(m.slice(5, 7)) - 1] ?? m} ${m.slice(0, 4)}`;

/**
 * Every supplier invoice, filed by what it carries and findable by what is on it.
 *
 * The rule people read as "keep paper" is about separation, not medium. Schedule II records are
 * maintained separately from all other records of the registrant; Schedule III-V either
 * separately or readily retrievable. The test an electronic system has to pass is whether
 * somebody can produce every Schedule II invoice for a period, on its own, without sorting
 * through anything — which is the top of this page.
 *
 * Everything below it is the other half: the questions a pharmacist actually asks between
 * inspections. When did we last buy oxycodone. What did McKesson send in March. Send the
 * accountant last quarter. None of those are answerable by an archive that only knows the number
 * on the front of each document, so the item lines are searchable and the invoices can be sent
 * on from here.
 */
export default async function InvoicesPage({
  searchParams,
}: {
  searchParams: Promise<{
    tab?: string;
    q?: string;
    month?: string;
    supplier?: string;
    from?: string;
    to?: string;
    on?: string;
    min?: string;
    max?: string;
    noamount?: string;
    nolines?: string;
    unconfirmed?: string;
    undated?: string;
    unreceipted?: string;
    ok?: string;
    error?: string;
  }>;
}) {
  const user = await requireUser();
  const sp = await searchParams;
  const active = (TABS.find((t) => t.key === sp.tab) ?? TABS[3]).key;
  const canManage = user.role !== "staff";
  const onlyUnconfirmed = sp.unconfirmed === "1";
  const onlyUndated = sp.undated === "1";
  const onlyNoAmount = sp.noamount === "1";
  // The opposite complaint to noamount: these have the money and are missing the goods.
  const onlyNoLines = sp.nolines === "1";
  // An empty box and a zero are different answers, so a blank never becomes a filter.
  const dollars = (v: string | undefined) => (v && v.trim() !== "" && Number.isFinite(Number(v)) ? Number(v) : undefined);

  const [rows, review, counts, issues, suppliers, months, sent, s, adoptable, complianceRows] = await Promise.all([
    invoices({
      schedule: active === "all" ? undefined : active,
      text: sp.q,
      month: sp.month,
      supplier: sp.supplier,
      from: sp.from,
      to: sp.to,
      on: sp.on,
      minAmount: dollars(sp.min),
      maxAmount: dollars(sp.max),
      noAmount: onlyNoAmount || undefined,
      noLines: onlyNoLines || undefined,
      unconfirmed: onlyUnconfirmed || undefined,
    }),
    awaitingReview(),
    invoiceCounts(),
    invoiceIssues(),
    invoiceSuppliers(),
    invoiceMonths(),
    recentForwards(5),
    getSettings(),
    adoptableDocuments(),
    invoiceCompliance(),
  ]);
  /*
   * Rows whose document is gone.
   *
   * An invoice record points at the PDF it was read from. Delete the document without the record —
   * which the old per-page delete paths could do — and what is left is a row that opens nothing,
   * proves nothing to an inspector, still counts as a purchase, and cannot be explained by looking
   * at it. That is the shape of the row that would not go away, and until now the table gave no
   * hint of it: it looked like an ordinary invoice with no date and no amount.
   */
  const { db: database } = await import("@/db");
  const documentIds = new Set((await database.query.documents.findMany({ columns: { id: true } })).map((d) => d.id));
  const orphanRows = rows.filter((r) => !documentIds.has(r.documentId));

  // What is in the invoice folder that is not an invoice. Only an invoice belongs there.
  const misfiled = canManage ? await misfiledInVault() : [];
  // The ones the site can name for itself; the rest need a person and are asked about per row.
  const namedMisfiled = misfiled.filter((m) => m.belongsIn !== null);
  const noAmountCount = await missingTotals();
  const noLinesCount = await invoicesWithoutLines();
  /*
   * What PioneerRx booked in that no invoice covers.
   *
   * The independent count. Every other figure on this page is read off the invoices themselves,
   * so none of them can tell an invoice that never arrived from one that does not exist.
   */
  const owed = await invoicesStillOwed();
  const chase = stillToChase(owed);
  const backlog = fromBeforeWeWatched(owed);
  /*
   * One bill on file twice, which the cash account adds twice.
   *
   * The owner asked for this in September — "there is a duplicate ipd invoice in there and I dont
   * have a way to delete.." — and the missing button was the smaller half of it. Nothing was
   * telling him either: the duplicate check keyed on the invoice number, IPD's carry none, and both
   * rows are the same PDF byte for byte.
   */
  const filedTwice = canManage ? await invoicesOnFileTwice() : [];
  /*
   * Only the ones worth his attention get a row.
   *
   * The owner, after the first run of this put $142,036.21 on the page: "We are going to ignore
   * those alerts for invoices from beginning of this month.. that was just to get them in from
   * before this site was setup." So the pre-setup backlog is one line at the foot rather than
   * seven rows at the top, and what is left is a wholesaler that owes a document, plus the ones he
   * has already settled — those stay visible so the decision can be seen and undone.
   */
  /*
   * Only the ones still waiting on a document.
   *
   * A supplier he has answered for kept its row here so the decision stayed visible and undoable.
   * That was the wrong call. The row still sits under a heading that reads "Delivered, and no
   * invoice for it" with a four-figure sum beside it, and no amount of explanatory text under it
   * changes what a heading and a number say together:
   *
   * > "Jams and xymogen say delivered no invoice, I need way to select no invoice expected to make
   * > them go away. they are now set not to expect invoices so shouldnt have this going forward"
   *
   * They are gone from the list, counted in one line at the foot, and the switch that put them there
   * is on their own card on the Suppliers page — which is where somebody goes to change their mind
   * about a supplier, not a list of things to chase.
   */
  /*
   * What the invoice billed against what the delivery recorded, drug by drug.
   *
   * The same two sources as the list above and the opposite question of them. That one finds a
   * document that never came; this one finds a document that came and does not agree.
   */
  const prices = await checkInvoicePrices();
  const owedRows = owed.filter((l) => l.waiting > 0);
  const settledSuppliers = owed.filter((l) => l.receiptIsTheInvoice);
  const unreceipted = await awaitingReceipt();
  const onlyUnreceipted = sp.unreceipted === "1";
  const compliance = complianceRows;
  const unmet = compliance.filter((c) => c.state === "attention");

  const shown = onlyUndated ? rows.filter((r) => !r.invoiceDate) : rows;
  /*
   * Whether any sender is recognised at all — read from the register, which is where the pharmacy
   * puts them.
   *
   * This asked the old free-text setting under Settings → Email instead, so a pharmacist who had
   * entered IPC's and IPD's addresses on the Suppliers page — the page this banner tells them to
   * use — was still told no sender was named. Two places to record one fact, and the banner
   * watching the one nobody uses.
   */
  const receiptElsewhere = (s.receipt_record_kept_in ?? "").trim();
  const registered = await allSuppliers();
  const withSenders = registered.filter((x) => addressesOf(x).length > 0);
  const noSenders = withSenders.length === 0;
  /*
   * Suppliers whose invoices would be missed for want of an address.
   *
   * Not the ones whose receipt he has said is the invoice. The banner tells him their invoices
   * "will not be recognised", which for Xymogen and JamsRX is true, already known, and exactly
   * what he decided — so it is not news, it is the site arguing with his own setting. He had five
   * things to settle on this page and six of the ten names in that sentence were suppliers he had
   * already answered for.
   */
  const missingSenders = registered.filter((x) => addressesOf(x).length === 0).filter((x) => !x.invoiceFromPioneer);
  const filtered = Boolean(
    sp.q || sp.month || sp.supplier || sp.from || sp.to || sp.on || sp.min || sp.max || onlyUnconfirmed || onlyUndated || onlyNoAmount || onlyNoLines,
  );
  const totals = sumOf(shown);
  const expectations = parseExpected(s.supplier_expected_schedule ?? "");

  async function confirm(fd: FormData) {
    "use server";
    const u = await requireManager();
    const id = String(fd.get("id") ?? "");
    const schedule = String(fd.get("schedule") ?? "") as InvoiceSchedule;
    if (!INVOICE_SCHEDULES.includes(schedule)) {
      redirect("/inventory/invoices?error=" + encodeURIComponent("Pick a schedule."));
    }
    try {
      await setSchedule(id, schedule, u);
      await audit({ action: "invoice.schedule", userId: u.id, userName: u.name, entity: "invoice", entityId: id, details: schedule });
      revalidatePath("/inventory/invoices");
      redirect("/inventory/invoices?ok=" + encodeURIComponent(`Filed under ${filingFor(schedule).label}, and moved out of everything else.`));
    } catch (e) {
      if (e && typeof e === "object" && "digest" in e) throw e;
      redirect("/inventory/invoices?error=" + encodeURIComponent(e instanceof Error ? e.message : "Could not change that."));
    }
  }

  async function dateIt(fd: FormData) {
    "use server";
    const u = await requireManager();
    const id = String(fd.get("id") ?? "");
    try {
      await setInvoiceDate(id, String(fd.get("invoiceDate") ?? ""), u);
      await audit({ action: "invoice.date", userId: u.id, userName: u.name, entity: "invoice", entityId: id });
      revalidatePath("/inventory/invoices");
      redirect("/inventory/invoices?undated=1&ok=" + encodeURIComponent("Dated, so it comes back in a date range now."));
    } catch (e) {
      if (e && typeof e === "object" && "digest" in e) throw e;
      redirect("/inventory/invoices?undated=1&error=" + encodeURIComponent(e instanceof Error ? e.message : "Could not set that date."));
    }
  }

  /*
   * The amount, where the invoice would not say it clearly enough to read.
   *
   * One of this pharmacy's three wholesalers prints subtotals by schedule and no single figure
   * for the invoice, so there is nothing safe to read. Adding the parts up and calling the result
   * the total would put a number the site invented onto a financial record that gets reconciled
   * against a payment — a blank somebody fills in is the honest version of not knowing.
   */
  /*
   * The day the money left, per invoice.
   *
   * The cash account had no cost of goods at all, because this column existed in the database and
   * on no screen. A date typed here is a fact; until it is, the account counts the invoice on its
   * date plus the supplier's terms and says so.
   */
  async function paidIt(fd: FormData) {
    "use server";
    const u = await requireManager();
    const id = String(fd.get("id") ?? "");
    const paidOn = String(fd.get("paidOn") ?? "").trim();
    try {
      await setInvoicePaidOn(id, paidOn, u);
      await audit({ action: "invoice.paid", userId: u.id, userName: u.name, entity: "invoice", entityId: id, details: paidOn || "cleared" });
      revalidatePath("/inventory/invoices");
      revalidatePath("/money");
      revalidatePath("/money/monthly");
      redirect("/inventory/invoices?ok=" + encodeURIComponent(paidOn ? "Payment date recorded; the cash account uses it." : "Payment date cleared."));
    } catch (e) {
      if (e && typeof e === "object" && "digest" in e) throw e;
      redirect("/inventory/invoices?error=" + encodeURIComponent(e instanceof Error ? e.message : "Could not record that date."));
    }
  }

  async function amount(fd: FormData) {
    "use server";
    const u = await requireManager();
    const id = String(fd.get("id") ?? "");
    try {
      await setInvoiceTotal(id, Number(fd.get("dollars") ?? NaN), u);
      await audit({ action: "invoice.total", userId: u.id, userName: u.name, entity: "invoice", entityId: id });
      revalidatePath("/inventory/invoices");
      redirect("/inventory/invoices?noamount=1&ok=" + encodeURIComponent("Amount saved, and counted in the totals from now on."));
    } catch (e) {
      if (e && typeof e === "object" && "digest" in e) throw e;
      redirect("/inventory/invoices?noamount=1&error=" + encodeURIComponent(e instanceof Error ? e.message : "Could not save that amount."));
    }
  }

  /**
   * Reads the amounts off invoices filed before amounts were recorded.
   *
   * The reading happens once, as an invoice is filed, and nothing went back for the ones already
   * on file — so their totals were blank for good, against PDFs that plainly print a figure. That
   * looks like a broken reader rather than a question never asked.
   */
  async function readAmounts() {
    "use server";
    const u = await requireManager();
    const r = await backfillTotals();
    await audit({ action: "invoice.totals.backfill", userId: u.id, userName: u.name, details: `${r.read}` });
    revalidatePath("/inventory/invoices");
    redirect(
      "/inventory/invoices?ok=" +
        encodeURIComponent(
          r.read === 0
            ? `No amount could be read off ${r.stillMissing} invoice${r.stillMissing === 1 ? "" : "s"}. Some wholesalers print subtotals by schedule and no invoice total — those have to be typed in.`
            : `${r.read} amount${r.read === 1 ? "" : "s"} read off the invoices themselves.` +
              (r.stillMissing > 0
                ? ` ${r.stillMissing} still print no total that can be read — type those in below.`
                : " Every invoice now has an amount."),
        ),
    );
  }

  /**
   * Reads the item lines as numbers off every invoice they have not been read from.
   *
   * The lines were kept as text to be searched; what was bought — NDC, quantity, price — is what
   * every purchasing question starts from, and the PDFs are still here to ask.
   */
  async function readLines() {
    "use server";
    const u = await requireManager();
    /*
     * The model is allowed here, and only where the cheap reader found nothing.
     *
     * IPD's invoices come out of text extraction with their columns shredded — every NDC on the
     * page in one run of digits — so no rule can read them, and until now they contributed nothing
     * to any purchasing question. This is a press somebody made deliberately, which is the right
     * place for the one path that costs money.
     */
    const r = await backfillInvoiceLines({ allowModel: true, user: u });
    await audit({ action: "invoice.lines.backfill", userId: u.id, userName: u.name, details: `${r.invoices} invoices, ${r.linesRead} lines, ${r.byModel} by model` });
    revalidatePath("/inventory/invoices");
    revalidatePath("/purchasing");
    const bits = [`${r.linesRead.toLocaleString()} item line${r.linesRead === 1 ? "" : "s"} read off ${r.invoices} invoice${r.invoices === 1 ? "" : "s"}`];
    // Named apart, because they are different problems: a scan has no text at all, while an
    // invoice whose lines do not add up to its printed total was read and deliberately not kept.
    if (r.unreconciled > 0) bits.push(`${r.unreconciled} did not add up to the total printed on them and were left out rather than counted short`);
    if (r.byModel > 0) bits.push(`${r.byModel} ${r.byModel === 1 ? "was" : "were"} in a layout no rule can read — the page itself was read instead, and the figures still had to add up to the printed total`);
    if (r.unreadable > 0) bits.push(`${r.unreadable} ${r.unreadable === 1 ? "is a scan" : "are scans"} with no text to read`);
    redirect("/inventory/invoices?ok=" + encodeURIComponent(bits.join(". ") + "."));
  }

  /**
   * Records that the goods arrived, which is what lets the paper go.
   *
   * The emailed invoice proves what the wholesaler shipped. It does not prove what arrived — that
   * is what the initials and the date on the paper packing slip are, and the moment anybody writes
   * on that paper it becomes the pharmacy's record of receipt under 21 CFR 1304.22(c) rather than
   * a duplicate of the PDF, and cannot be thrown away. Recorded here, it can be.
   */
  async function receipt(fd: FormData) {
    "use server";
    const u = await requireManager();
    const id = String(fd.get("id") ?? "");
    try {
      await recordReceipt(id, { receivedOn: String(fd.get("receivedOn") ?? ""), note: String(fd.get("note") ?? "") }, u);
      await audit({ action: "invoice.receipt", userId: u.id, userName: u.name, entity: "invoice", entityId: id });
      revalidatePath("/inventory/invoices");
      redirect("/inventory/invoices?unreceipted=1&ok=" + encodeURIComponent("Receipt recorded against the invoice, in your name."));
    } catch (e) {
      if (e && typeof e === "object" && "digest" in e) throw e;
      redirect("/inventory/invoices?unreceipted=1&error=" + encodeURIComponent(e instanceof Error ? e.message : "Could not record that."));
    }
  }

  /**
   * Says where receipt is actually recorded, when it is not recorded here.
   *
   * The pharmacy checks totes in against the wholesaler's own ordering system. Recording it here as
   * well is the same fact twice, and the second one would stop being done within a week — leaving a
   * compliance panel permanently red about a record that exists. Naming the system settles the
   * line honestly and stops the asking.
   */
  /*
   * Removes one copy of a bill that is on file twice.
   *
   * The same path the per-row delete uses, so the document, the invoice record and every line read
   * off it go together. A copy left behind with its lines removed would be the worst of both: the
   * money still counted twice and the item lines gone from the one that stayed.
   */
  async function removeCopy(fd: FormData) {
    "use server";
    const u = await requireManager();
    const id = String(fd.get("id") ?? "");
    const { message } = await purgeFromInvoiceFile(id, u);
    revalidatePath("/inventory/invoices");
    redirect("/inventory/invoices?ok=" + encodeURIComponent(message));
  }

  /*
   * Closes what is outstanding today, without settling the supplier for ever.
   *
   * "parmed needs to use receipt as invoice this time but not going forward." Two different
   * decisions, so two different buttons: this one answers for the deliveries on the list now, and
   * the one beside it answers for the supplier from here on.
   */
  async function settleTheseOnes(fd: FormData) {
    "use server";
    const u = await requireManager();
    const id = String(fd.get("id") ?? "");
    const { settled, cents, supplier } = await settleDeliveriesOnReceipt(id, u);
    revalidatePath("/inventory/invoices");
    redirect(
      "/inventory/invoices?ok=" +
        encodeURIComponent(
          settled === 0
            ? "Nothing of theirs was outstanding, so nothing changed."
            : `${supplier}: ${settled} deliver${settled === 1 ? "y" : "ies"} worth ${money(cents)} closed on their PioneerRx receipts. Their next delivery is still expected to bring an invoice.`,
        ),
    );
  }

  /*
   * "there are a couple suppliers where I'd rather just use the pioneers invoice as the invoice."
   *
   * On the line with the problem, because the alternative is the paragraph this project already
   * printed once: go to Suppliers, find them, open terms, tick it, come back.
   */
  async function receiptIsInvoice(fd: FormData) {
    "use server";
    const u = await requireManager();
    const id = String(fd.get("id") ?? "");
    const name = String(fd.get("name") ?? "that supplier");
    const on = String(fd.get("on") ?? "") === "1";
    await useReceiptAsInvoice(id, on);
    await audit({
      action: "supplier.receipt_is_invoice",
      userId: u.id,
      userName: u.name,
      entity: "supplier",
      entityId: id,
      details: on ? `${name}: the PioneerRx receipt is the invoice` : `${name}: waiting for their invoice again`,
    });
    revalidatePath("/inventory/invoices");
    redirect(
      "/inventory/invoices?ok=" +
        encodeURIComponent(
          on
            ? `${name}: their PioneerRx receipt is the invoice. Deliveries still count as purchases — they are no longer chased for a document.`
            : `${name} is on the list again: any delivery of theirs with no invoice will be shown here.`,
        ),
    );
  }

  async function receiptKeptIn(fd: FormData) {
    "use server";
    const u = await requireManager();
    const where = String(fd.get("where") ?? "").trim();
    await setSetting("receipt_record_kept_in", where);
    await audit({ action: "invoice.receipt.location", userId: u.id, userName: u.name, details: where || "recorded here" });
    revalidatePath("/inventory/invoices");
    redirect(
      "/inventory/invoices?unreceipted=1&ok=" +
        encodeURIComponent(
          where
            ? `Recorded: receipt is confirmed in ${where}. The compliance panel says so and will stop asking for it here.`
            : "Receipt will be recorded here again, against each invoice.",
        ),
    );
  }

  async function send(fd: FormData) {
    "use server";
    const u = await requireManager();
    const ids = fd.getAll("pick").map(String).filter(Boolean);
    const back = String(fd.get("back") ?? "/inventory/invoices");
    try {
      const r = await forwardInvoices(ids, String(fd.get("to") ?? ""), String(fd.get("note") ?? ""), u);
      await audit({ action: "invoice.forward", userId: u.id, userName: u.name, details: `${r.sent} to ${r.to}` });
      revalidatePath("/inventory/invoices");
      redirect(`${back}${back.includes("?") ? "&" : "?"}ok=` + encodeURIComponent(r.message));
    } catch (e) {
      if (e && typeof e === "object" && "digest" in e) throw e;
      redirect(`${back}${back.includes("?") ? "&" : "?"}error=` + encodeURIComponent(e instanceof Error ? e.message : "Could not send that."));
    }
  }

  /**
   * Taking a document back out of the invoice file.
   *
   * Every automatic filing rule is going to be wrong about something. A statement of account from
   * IPD matched the words on the front of it and was filed as an invoice, and there was then
   * nothing anybody could do — no correction, no removal, a wrong record with no undo. This is the
   * undo, and it says where the document went rather than only that it left.
   *
   * It shares the surrounding form, so the button carries the invoice's id and the choice is read
   * from the select belonging to that row. Nesting a form inside a form is not something a browser
   * will do.
   */
  async function notAnInvoice(fd: FormData) {
    "use server";
    const u = await requireManager();
    const id = String(fd.get("unfileId") ?? "");
    const back = String(fd.get("back") ?? "/inventory/invoices");
    const choice = String(fd.get(`as_${id}`) ?? "statement");
    /*
     * No document id is passed, and none is wanted.
     *
     * It used to come from a hidden field in this table's one shared form, which meant it was
     * always the first row's — so the fallback that was supposed to finish the job when an invoice
     * record had gone would have finished it on somebody else's document. `unfileInvoice` finds
     * the document from the invoice, and the case where the record has already gone is what the
     * Delete button handles outright.
     */
    try {
      const r = await unfileInvoice(
        id,
        choice === "discard" ? { kind: "discard" } : { kind: choice as "statement" | "rebate_report" | "credit_memo" | "other" },
        u,
      );
      revalidatePath("/inventory/invoices");
      revalidatePath("/documents");
      redirect(`${back}${back.includes("?") ? "&" : "?"}ok=` + encodeURIComponent(r.message));
    } catch (e) {
      if (e && typeof e === "object" && "digest" in e) throw e;
      redirect(`${back}${back.includes("?") ? "&" : "?"}error=` + encodeURIComponent(e instanceof Error ? e.message : "Could not take that out of the invoice file."));
    }
  }

  /**
   * Recording a supplier's sending address from the compliance panel.
   *
   * The same save the Suppliers page does, offered where the shortfall is named — and it re-reads
   * what has already arrived from that address, so setting it once is the whole job rather than
   * the first half of it.
   */
  async function supplierAddress(fd: FormData) {
    "use server";
    const u = await requireManager();
    const supplierId = String(fd.get("supplierId") ?? "");
    const addresses = String(fd.get("senderEmails") ?? "").trim();
    if (!addresses) redirect("/inventory/invoices?error=" + encodeURIComponent("Give an address, or a bare domain.") + "#compliance");
    try {
      const { updateSupplier, allSuppliers, addressesOf } = await import("@/lib/suppliers-registry");
      const rows = await allSuppliers(true);
      const sup = rows.find((x) => x.id === supplierId);
      if (!sup) throw new Error("That supplier is no longer on the register.");
      // Everything else about the supplier is carried across unchanged; only the address is added.
      await updateSupplier(supplierId, {
        name: sup.name,
        senderEmails: [sup.senderEmails, addresses].filter(Boolean).join("\n"),
        catalogName: sup.catalogName ?? "",
        accountNumber: sup.accountNumber ?? "",
        deaNumber: sup.deaNumber ?? "",
        phone: sup.phone ?? "",
        website: sup.website ?? "",
        expectedSchedule: sup.expectedSchedule,
        notes: sup.notes ?? "",
      });
      const { rereadFromSenders } = await import("@/lib/mailbox");
      const back = await rereadFromSenders(addressesOf({ ...sup, senderEmails: addresses }), { userId: u.id, userName: u.name });
      await audit({ action: "supplier.address", userId: u.id, userName: u.name, entity: "supplier", entityId: supplierId, details: addresses });
      revalidatePath("/inventory/invoices");
      revalidatePath("/suppliers");
      redirect(
        "/inventory/invoices?ok=" +
          encodeURIComponent(
            `${sup.name} will now be recognised by that address.` +
              (back.filed ? ` ${back.filed} message${back.filed === 1 ? "" : "s"} already received from it ${back.filed === 1 ? "has" : "have"} been filed.` : ""),
          ) + "#compliance",
      );
    } catch (e) {
      if (e && typeof e === "object" && "digest" in e) throw e;
      redirect("/inventory/invoices?error=" + encodeURIComponent(e instanceof Error ? e.message : "Could not save that.") + "#compliance");
    }
  }

  /**
   * Finds everything already filed as an invoice that never was one, in one press.
   *
   * The recognition rule reads the document rather than the subject line now, but it only runs on
   * arrival — so anything filed before it existed stays wrong, and correcting them one at a time is
   * the software asking a person to do its job.
   */
  async function recheckAll() {
    "use server";
    const u = await requireManager();
    try {
      const r = await recheckFiledInvoices(u, { apply: true });
      await audit({ action: "invoice.recheck", userId: u.id, userName: u.name, details: `${r.moved} moved out of ${r.checked}` });
      revalidatePath("/inventory/invoices");
      revalidatePath("/documents");
      redirect(
        "/inventory/invoices?ok=" +
          encodeURIComponent(
            [
              r.moved === 0
                ? `${r.checked} invoice${r.checked === 1 ? "" : "s"} read again; every one of them is an invoice.${r.unreadable ? ` ${r.unreadable} could not be read as text — those were left alone.` : ""}`
                : `${r.moved} taken out of the invoice file: ${r.found.map((f) => `${f.supplier ?? "a supplier"} ${f.kind === "rebate_report" ? "rebate breakdown" : f.kind === "credit_memo" ? "credit memo" : "statement of account"}`).join(", ")}. They are filed under supplier statements, and everything read off them as purchases is gone.`,
              // Said plainly, because this is the row that nothing on the page could reach.
              r.removedOrphans > 0
                ? `${r.removedOrphans} invoice record${r.removedOrphans === 1 ? " whose document had" : "s whose documents had"} already been deleted ${r.removedOrphans === 1 ? "was" : "were"} removed — ${r.removedOrphans === 1 ? "it was" : "they were"} still counting as purchases with nothing behind ${r.removedOrphans === 1 ? "it" : "them"}.`
                : "",
            ]
              .filter(Boolean)
              .join(" "),
          ),
      );
    } catch (e) {
      if (e && typeof e === "object" && "digest" in e) throw e;
      redirect("/inventory/invoices?error=" + encodeURIComponent(e instanceof Error ? e.message : "Could not re-read those."));
    }
  }

  /**
   * Says of a document in the vault that it is not an invoice, and means it.
   *
   * The adoption list is built from titles and file names, so a rebate breakdown and a returned
   * goods policy both landed on it under a heading saying they had not been filed — with a button
   * offering to file them as invoices and no way to say otherwise. A list of outstanding work that
   * contains finished work cannot be emptied, so it stops being read.
   */
  async function notAnInvoiceDocument(fd: FormData) {
    "use server";
    const u = await requireManager();
    const documentId = String(fd.get("documentId") ?? "");
    try {
      const { db, schema } = await import("@/db");
      const { eq } = await import("drizzle-orm");
      const doc = await db.query.documents.findFirst({ where: eq(schema.documents.id, documentId) });
      if (!doc) redirect("/inventory/invoices?error=" + encodeURIComponent("That document no longer exists."));
      // Filed as a supplier document rather than deleted: the paper still exists, it is just not an
      // invoice, and the category is what keeps this list from offering it again.
      await db
        .update(schema.documents)
        .set({ category: "supplier_statement", notes: [doc!.notes, `Marked as not an invoice by ${u.name}.`].filter(Boolean).join(" ") })
        .where(eq(schema.documents.id, documentId));
      await audit({ action: "invoice.not_an_invoice", userId: u.id, userName: u.name, entity: "document", entityId: documentId, details: doc!.title });
      revalidatePath("/inventory/invoices");
      revalidatePath("/documents");
      redirect(
        "/inventory/invoices?ok=" +
          encodeURIComponent(`“${doc!.title}” is filed under supplier statements and will not be offered as an invoice again.`),
      );
    } catch (e) {
      if (e && typeof e === "object" && "digest" in e) throw e;
      redirect("/inventory/invoices?error=" + encodeURIComponent(e instanceof Error ? e.message : "Could not do that."));
    }
  }

  /**
   * Deletes, whatever the row is.
   *
   * One action behind every Delete on this page. It takes whichever ids the row has — an invoice
   * id, a document id, or both — and removes everything reachable from either. There is deliberately
   * no branch here that works out what the row is first: three delete paths that each began by
   * establishing the case is exactly how deleting one statement failed four times running, each
   * time in a state none of them covered.
   */
  async function destroy(fd: FormData) {
    "use server";
    const u = await requireManager();
    const back = String(fd.get("back") ?? "/inventory/invoices");
    const ids = [String(fd.get("destroyId") ?? ""), String(fd.get("documentId") ?? "")].filter(Boolean);
    try {
      const said: string[] = [];
      let removed = 0;
      for (const id of ids) {
        const r = await purgeFromInvoiceFile(id, u);
        removed += r.removed.invoices + r.removed.documents;
        said.push(r.message);
      }
      revalidatePath("/inventory/invoices");
      revalidatePath("/documents");
      revalidatePath("/purchasing");
      revalidatePath("/money/monthly");
      redirect(
        `${back}${back.includes("?") ? "&" : "?"}ok=` +
          encodeURIComponent(removed > 0 ? said.filter((x) => !x.startsWith("Nothing with")).join(" ") : said[0] ?? "Nothing to delete."),
      );
    } catch (e) {
      if (e && typeof e === "object" && "digest" in e) throw e;
      redirect(`${back}${back.includes("?") ? "&" : "?"}error=` + encodeURIComponent(e instanceof Error ? e.message : "Could not delete that."));
    }
  }

  /**
   * Deletes a document in the vault, and anything filed off the back of it.
   *
   * The same cascade the Documents page uses. Deleting a document while an invoice record still
   * pointed at it is what left a statement that could not be opened, could not be taken out of the
   * invoice file, and went on counting as purchases — the one that would not go away.
   */
  /**
   * A person's answer about a document the site could not name.
   *
   * Two buttons and no typing, because the question is a yes or a no and anything more elaborate is
   * how a row ends up sitting there for a week. Confirming keeps it and stops the asking;
   * the other takes it out along with anything counted as a purchase off it.
   */
  async function callItAnInvoice(fd: FormData) {
    "use server";
    const u = await requireManager();
    const message = await confirmIsInvoice(String(fd.get("documentId") ?? ""), u);
    revalidatePath("/inventory/invoices");
    redirect("/inventory/invoices?ok=" + encodeURIComponent(message));
  }

  async function callItNotAnInvoice(fd: FormData) {
    "use server";
    const u = await requireManager();
    const message = await markNotAnInvoice(String(fd.get("documentId") ?? ""), u);
    revalidatePath("/inventory/invoices");
    revalidatePath("/documents");
    revalidatePath("/purchasing");
    revalidatePath("/money/monthly");
    redirect("/inventory/invoices?ok=" + encodeURIComponent(message));
  }

  /** Files everything in the invoice folder that is not an invoice where it does belong. */
  async function refile() {
    "use server";
    const u = await requireManager();
    const r = await fileMisfiled(u);
    revalidatePath("/inventory/invoices");
    revalidatePath("/documents");
    revalidatePath("/suppliers");
    revalidatePath("/purchasing");
    redirect(
      "/inventory/invoices?ok=" +
        encodeURIComponent(
          r.moved === 0
            ? "Everything in the invoice folder reads as an invoice."
            : `${r.moved} document${r.moved === 1 ? "" : "s"} filed where ${r.moved === 1 ? "it belongs" : "they belong"}: ` +
              r.found.map((f) => f.title).join(", ") +
              ". Anything counted as a purchase off them is gone." +
              (r.ratioRead ? ` ${r.ratioRead}` : ""),
        ),
    );
  }

  async function saveExpected(fd: FormData) {
    "use server";
    const u = await requireManager();
    await setSetting("supplier_expected_schedule", String(fd.get("expected") ?? "").trim());
    await audit({ action: "invoice.expectations", userId: u.id, userName: u.name });
    revalidatePath("/inventory/invoices");
    redirect(
      "/inventory/invoices?ok=" +
        encodeURIComponent(
          "Saved. Nothing is filed differently because of this — it is only used to tell you when a supplier sends something they never send.",
        ),
    );
  }

  async function fileThem() {
    "use server";
    const u = await requireManager();
    const r = await adoptAll({ userId: u.id, userName: u.name });
    await audit({ action: "invoice.adopt", userId: u.id, userName: u.name, details: `${r.filed}` });
    revalidatePath("/inventory/invoices");
    redirect(
      `/inventory/invoices?${r.problems.length ? "error" : "ok"}=` +
        encodeURIComponent(
          [
            r.filed
              ? `${r.filed} document${r.filed === 1 ? "" : "s"} filed as supplier invoices and sorted by schedule`
              : "Nothing could be filed",
            ...r.problems.slice(0, 3),
          ].join(". ") + ".",
        ),
    );
  }

  async function upload(fd: FormData) {
    "use server";
    const u = await requireManager();
    const file = fd.get("file");
    if (!(file instanceof File) || file.size === 0) {
      redirect("/inventory/invoices?error=" + encodeURIComponent("Choose a PDF."));
    }
    try {
      const r = await uploadInvoice(file as File, { userId: u.id, userName: u.name });
      await audit({ action: "invoice.upload", userId: u.id, userName: u.name, details: r.schedule });
      revalidatePath("/inventory/invoices");
      redirect(
        "/inventory/invoices?ok=" +
          encodeURIComponent(
            r.needsReview
              ? "Filed with the Schedule II records until you say what it carries — that is the cautious side, and the only safe one."
              : `Filed under ${filingFor(r.schedule).label}.`,
          ),
      );
    } catch (e) {
      if (e && typeof e === "object" && "digest" in e) throw e;
      redirect("/inventory/invoices?error=" + encodeURIComponent(e instanceof Error ? e.message : "Could not read that file."));
    }
  }

  const here = `/inventory/invoices?${new URLSearchParams(
    Object.entries(sp).filter(([k, v]) => v && k !== "ok" && k !== "error") as [string, string][],
  ).toString()}`;

  return (
    <>
      <PageHeader
        back={{ href: "/purchasing", label: "Ordering" }}
        title="Supplier invoices"
        subtitle="Emailed in by the supplier, read on arrival, and filed by what each one carries. Schedule II invoices are kept apart from everything else, which is what the rule actually asks for."
        actions={
          <>
            <Link href="/suppliers" className="btn">Suppliers</Link>
            <Link href="#compliance" className={`btn ${unmet.length ? "btn-primary" : ""}`}>
              {unmet.length ? `${unmet.length} thing${unmet.length === 1 ? "" : "s"} to settle` : "How this meets the rules"}
            </Link>
          </>
        }
      />

      {sp.ok && <Notice kind="ok">{sp.ok}</Notice>}
      {sp.error && <Notice kind="crit">{sp.error}</Notice>}

      {/*
        Where the receipt record is kept — asked once, not per invoice.

        This sits above the per-invoice list deliberately: for a pharmacy that checks its totes in
        against the wholesaler's own system, the whole list below is the wrong question, and being
        told so first saves the scrolling.
      */}
      {onlyUnreceipted && canManage && (
        <Card
          title="Where receipt is recorded"
          className="mt-4"
          subtitle="21 CFR 1304.22(c) wants a record of what arrived and when. Most pharmacies confirm receipt in the wholesaler's own ordering system as the tote is checked in. If that is what you do, name it here and this stops asking — the compliance panel will say where the record is kept rather than that there is none."
        >
          <form action={receiptKeptIn} className="flex flex-wrap items-end gap-2">
            <label className="text-xs text-ink-3">
              Confirmed in
              <input
                name="where"
                defaultValue={s.receipt_record_kept_in ?? ""}
                placeholder="McKesson Connect, IPD portal"
                className="field w-72 text-sm"
              />
            </label>
            <button className="btn btn-primary">Save</button>
            <span className="text-xs text-ink-3">Leave it empty to go back to recording receipt against each invoice here.</span>
          </form>
          {(s.receipt_record_kept_in ?? "").trim() && (
            <p className="mt-2 text-xs text-ink-3">
              Be able to produce that system&rsquo;s receipt history at the pharmacy during an inspection, printed or on
              screen &mdash; that is what 21 CFR 1304.04(a) asks of a record kept electronically, wherever it is kept.
            </p>
          )}
        </Card>
      )}


      {noSenders ? (
        <Notice kind="warn">
          <b>No sender is named as a supplier yet, so nothing will be filed as an invoice.</b> Add your wholesalers
          on the <Link href="/suppliers" className="underline">Suppliers</Link> page, with the addresses they send
          from, then ask them to email invoices to this mailbox. From then on it happens with nobody doing
          anything.
        </Notice>
      ) : missingSenders.length > 0 ? (
        <Notice kind="warn">
          <b>
            {missingSenders.map((x) => x.name).join(", ")} {missingSenders.length === 1 ? "has" : "have"} no sending
            address recorded, so {missingSenders.length === 1 ? "their" : "their"} invoices will not be recognised.
          </b>{" "}
          Add the address {missingSenders.length === 1 ? "it arrives" : "they arrive"} from on the{" "}
          <Link href="/suppliers" className="underline">Suppliers</Link> page. Everything already in the mailbox from
          that address is read again the moment you save it.
        </Notice>
      ) : null}

      {/*
        What is wrong, before what is here.

        A mail-fed archive fails silently — the supplier changes the address they send from and the
        invoices simply stop, with no error anywhere. Records the pharmacy is required to keep stop
        being kept, and the only symptom is a quiet list. So the failures come first on the page,
        and each says what to do rather than only what is wrong.
      */}
      {issues.length > 0 && (
        <Card
          tone={issues.some((i) => i.severity === "blocking") ? "crit" : "warn"}
          title="Needs attention"
          count={issues.length}
          className="mt-4 mb-6"
        >
          <ul className="rows">
            {issues.map((i) => (
              <li key={i.key} className="flex flex-wrap items-start justify-between gap-2 py-2">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-baseline gap-2">
                    <span className={`badge ${i.severity === "blocking" ? "badge-crit" : "badge-warn"}`}>
                      {i.severity === "blocking" ? "fix this" : "look at"}
                    </span>
                    <span className="text-sm font-medium">{i.title}</span>
                  </div>
                  <p className="mt-0.5 text-xs text-ink-3">{i.detail}</p>
                </div>
                {i.href && (
                  <Link href={i.href} className="btn btn-sm shrink-0">{i.action ?? "Open"}</Link>
                )}
              </li>
            ))}
          </ul>
        </Card>
      )}

      {/*
        One bill, on file twice.

        Above the missing-invoice card deliberately: money the account is counting twice is a wrong
        figure today, and a document that has not arrived is a record to collect. Only one of those
        makes the September numbers wrong.
      */}
      {filedTwice.length > 0 && (
        <Card
          tone="crit"
          title="The same invoice, on file twice"
          count={filedTwice.length}
          className="mt-4 mb-6"
          subtitle="A wholesaler issues one bill once. Two rows carrying it are one purchase counted twice, and the cash account adds both — so this is money out of the month that never left the bank."
        >
          <ul className="rows">
            {filedTwice.map((g) => (
              <li key={g.key} className="py-2">
                <div className="flex flex-wrap items-baseline gap-2">
                  <span className="badge badge-crit tabular-nums">{money(g.overCents)} counted twice</span>
                  <span className="text-sm">{g.says}</span>
                </div>
                <ul className="mt-1 space-y-1">
                  {g.copies.map((c, n) => (
                    <li key={c.id} className="flex flex-wrap items-center justify-between gap-2 text-xs text-ink-3">
                      <span>
                        {n === 0 ? "Keeping" : "Copy"} &middot; {c.invoiceDate ?? "no date"} &middot;{" "}
                        <span className="tabular-nums">{money(c.totalCents ?? 0)}</span> &middot; {c.linesRead ?? 0} item lines
                        {c.sameDocument && n > 0 && " · identical file"}
                      </span>
                      {n > 0 && (
                        <form action={removeCopy}>
                          <input type="hidden" name="id" value={c.id} />
                          <button
                            className="btn btn-sm border-crit text-crit hover:bg-crit-soft"
                            title="Deletes this copy, its document and every line read off it. The one above is kept."
                          >
                            Remove this copy
                          </button>
                        </form>
                      )}
                    </li>
                  ))}
                </ul>
              </li>
            ))}
          </ul>
        </Card>
      )}

      {/*
        Did every invoice actually arrive?

        The owner: "are we using pioneers receipts to make sure we are getting invoices from
        suppliers? If it was received by pioneer than we should be receiving the invoice."

        Nothing else on this page can answer that. Every count above is read off the invoices the
        pharmacy holds, so an invoice that never came is invisible to all of them — the file looks
        complete because it is consistent with itself. PioneerRx booked the delivery in at the
        counter, which makes its purchase list the only independent record of what was billed.
      */}
      {/*
        Nothing outstanding is one line. The check still ran, and still says so.
      */}
      {owedRows.length === 0 && (backlog.invoices > 0 || settledSuppliers.length > 0) && (
        <Settled className="mt-4 mb-6" says="Every delivery PioneerRx recorded has an invoice on file.">
          <p>
            PioneerRx records every delivery booked in at the counter, so anything it holds that the invoice file
            does not is a wholesaler that has not sent one. It is the only check here that does not read the
            invoices to ask about the invoices.
          </p>
          {settledSuppliers.length > 0 && (
            <p className="mt-2">
              {settledSuppliers.map((l) => l.supplier).join(" and ")}{" "}
              {settledSuppliers.length === 1 ? "is" : "are"} not counted: you have said their PioneerRx receipt is
              the invoice. Change that on their card under{" "}
              <Link href="/suppliers" className="underline">Suppliers</Link>.
            </p>
          )}
          {backlog.invoices > 0 && (
            <p className="mt-2">
              {backlog.invoices} deliveries from before this started catching invoices, worth{" "}
              <span className="tabular-nums">{money(backlog.cents)}</span>, are left off. Loading them was how the
              money from before September got counted, and it is counted.
            </p>
          )}
        </Settled>
      )}

      {owedRows.length > 0 && (
        <Card
          tone={chase.invoices > 0 ? "warn" : "ok"}
          title="Delivered, and no invoice for it"
          className="mt-4 mb-6"
          subtitle="PioneerRx records every delivery booked in at the counter. Anything it has that the invoice file has not is a wholesaler that has not sent one — the only check here that does not read the invoices to ask about the invoices."
        >
          <p className="text-sm">
            {chase.invoices === 0 ? (
              <>
                Every delivery PioneerRx has recorded since this started catching invoices has one on file.
              </>
            ) : (
              <>
                <b className="tabular-nums">{money(chase.cents)}</b> was delivered and never invoiced &mdash;{" "}
                {chase.invoices} deliver{chase.invoices === 1 ? "y" : "ies"} from {chase.suppliers} supplier
                {chase.suppliers === 1 ? "" : "s"}. The money is counted either way; what is missing is the document.
              </>
            )}
          </p>
          <ul className="rows mt-2">
            {owedRows.map((l) => (
              <li key={l.supplierId ?? l.supplier} className="flex flex-wrap items-center justify-between gap-2 py-1.5">
                <div className="min-w-0">
                  <span className="text-sm font-medium">{l.supplier}</span>
                  {l.receiptIsTheInvoice ? (
                    <span className="badge ml-2">receipt is the invoice</span>
                  ) : (
                    <span className="badge badge-warn ml-2 tabular-nums">{money(l.waitingCents)}</span>
                  )}
                  <p className="mt-0.5 text-xs text-ink-3">{l.says}</p>
                </div>
                {canManage && l.supplierId && l.waiting > 0 && (
                  <form action={settleTheseOnes} className="shrink-0">
                    <input type="hidden" name="id" value={l.supplierId} />
                    <button
                      className="btn btn-sm"
                      title="Closes the deliveries listed here on their PioneerRx receipts and nothing after them. Their next delivery is still expected to bring an invoice."
                    >
                      Close these on the receipt
                    </button>
                  </form>
                )}
                {canManage && l.supplierId && (
                  <form action={receiptIsInvoice} className="shrink-0">
                    <input type="hidden" name="id" value={l.supplierId} />
                    <input type="hidden" name="name" value={l.supplier} />
                    <input type="hidden" name="on" value={l.receiptIsTheInvoice ? "0" : "1"} />
                    <button
                      className="btn btn-sm"
                      title={
                        l.receiptIsTheInvoice
                          ? "Puts them back on this list, so any delivery of theirs without an invoice is shown."
                          : "For a supplier who never emails one: their PioneerRx receipt becomes the record and they stop being chased. Their deliveries still count as purchases."
                      }
                    >
                      {l.receiptIsTheInvoice ? "Wait for their invoice" : "Their receipt is the invoice"}
                    </button>
                  </form>
                )}
              </li>
            ))}          </ul>
          {settledSuppliers.length > 0 && (
            <p className="mt-2 text-xs text-ink-3">
              {settledSuppliers.map((l) => l.supplier).join(" and ")}{" "}
              {settledSuppliers.length === 1 ? "is" : "are"} not on this list: you have said their PioneerRx receipt is the
              invoice. Change that on their card under{" "}
              <Link href="/suppliers" className="underline">Suppliers</Link>.
            </p>
          )}
          {backlog.invoices > 0 && (
            <p className="mt-2 text-xs text-ink-3">
              {backlog.invoices} deliveries from before this started catching invoices, worth{" "}
              <span className="tabular-nums">{money(backlog.cents)}</span>, are left off this list. Loading them was
              how the money from before September got counted, and it is counted &mdash; they are not something anyone
              needs to chase.
            </p>
          )}
        </Card>
      )}

      {/*
        The other half of the same check, which never had a screen.

        The card above asks whether every delivery has an invoice. This one asks whether the invoice
        agrees with the delivery — the owner's own words, "IS IT MAKING SURE WE GOT ALL THE ONES TO
        EXPECT AND MATCHING PRICE? ITS A GOOD CHECK FOR THE SYSTEM".

        The comparison did exist. The nightly pull ran it, on the totals only, and wrote the answer
        into a setting that nothing on the site ever read. It could have said twenty invoices
        differed every night for a month and nobody would have seen it. That is the whole reason
        this card is here: a check nobody can see is not a check.
      */}
      {prices.checked > 0 && (
        <Card
          tone={prices.disagreements.length > 0 ? "warn" : "ok"}
          title="What you were billed, against what came in"
          className="mt-4 mb-6"
          subtitle="Two systems filled in separately — the wholesaler's invoice, and whoever booked the delivery in at the counter. Where they agree the price is checked. Where only one of them holds a figure, nobody has checked it."
        >
          <p className="text-sm">
            {prices.disagreements.length === 0 ? (
              <>
                All {prices.checked} invoices with a delivery to check against agree — the total, and every one of the{" "}
                {prices.linesCompared} drugs on them.
              </>
            ) : (
              <>
                {prices.agreeing} of {prices.checked} invoices agree throughout, across {prices.linesCompared} drugs.{" "}
                <b>
                  {prices.disagreements.length} thing{prices.disagreements.length === 1 ? "" : "s"}
                </b>{" "}
                {prices.disagreements.length === 1 ? "does" : "do"} not
                {prices.overbilledCents > 0 ? (
                  <>
                    , and <b className="tabular-nums">{money(prices.overbilledCents)}</b> of it is money you were billed
                    above what arrived
                  </>
                ) : (
                  <>, none of it money &mdash; the totals all match; it is which drug the money is against</>
                )}
                .
              </>
            )}
          </p>
          {prices.disagreements.length > 0 && (
            <ul className="rows mt-2">
              {prices.disagreements.slice(0, 12).map((d, i) => (
                <li key={`${d.invoiceNumber}-${d.ndc11 ?? "total"}-${i}`} className="py-1.5">
                  <div className="flex flex-wrap items-baseline gap-2">
                    <span className="badge">
                      {d.kind === "total"
                        ? "the total"
                        : d.kind === "price"
                          ? "the price"
                          : d.kind === "quantity"
                            ? "the count"
                            : d.kind === "misread"
                              ? "which drug"
                              : d.kind === "billed-not-received"
                                ? "billed, not booked in"
                                : "booked in, not billed"}
                    </span>
                    <span className="text-xs text-ink-3">
                      {d.supplier} {d.invoiceNumber}
                      {d.invoiceDate ? ` · ${fmt(d.invoiceDate)}` : ""}
                    </span>
                    {d.differenceCents !== 0 && (
                      <span className="tabular-nums text-sm font-medium">{money(Math.abs(d.differenceCents))}</span>
                    )}
                  </div>
                  <p className="mt-0.5 text-sm">{d.say}</p>
                </li>
              ))}
            </ul>
          )}
          {prices.disagreements.length > 12 && (
            <p className="mt-2 text-xs text-ink-3">
              The first 12 of {prices.disagreements.length} are shown.
            </p>
          )}
          {prices.unchecked.length > 0 && (
            /*
              What the check does not cover, said plainly.

              An invoice with no delivery under its number has no second copy of its prices, so
              nothing here has looked at it. Leaving that out would make the card claim a coverage
              it does not have, which is worse than a smaller number honestly stated.
            */
            <p className="mt-2 text-xs text-ink-3">
              {prices.unchecked.length} invoice{prices.unchecked.length === 1 ? " is" : "s are"} not checked at all:
              no PioneerRx delivery carries {prices.unchecked.length === 1 ? "its" : "their"} number, so there is no
              second copy of {prices.unchecked.length === 1 ? "its" : "their"} prices to compare against.
            </p>
          )}
        </Card>
      )}

      {/*
        Invoices the site already holds but never filed as invoices.

        Everything that arrived before this screen existed went into the document vault as an
        ordinary report, and so did anything from a sender not yet named as a supplier. They are
        in the building and not on this page, which is the worst of both worlds: the pharmacy
        holds Schedule II records it cannot produce on demand and believes it holds none.
      */}
      {/*
        Not an invoice, and in the invoice folder.

        An invoice is a receipt record under 21 CFR 1304.22(c) and its Schedule II copy has to be
        held apart from everything else. A statement records no receipt of anything, and the daily
        purchase report is a summary of what was bought — filed here, the controlled-substance file
        fills with documents that prove nothing, and the one question the folder exists to answer
        stops having a clean answer.
      */}
      {orphanRows.length > 0 && canManage && (
        <Card
          tone="crit"
          title="Invoice records whose document has gone"
          count={orphanRows.length}
          subtitle="Each of these points at a PDF that no longer exists. It opens nothing, proves nothing to an inspector, and still counts as a purchase — and on the table below it looks like an ordinary invoice with no date and no amount, which is why one of them could not be explained by looking at it."
          className="mt-4 mb-6"
        >
          <ul className="rows">
            {orphanRows.map((r) => (
              <li key={r.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                <span className="min-w-0 text-sm">
                  {[r.supplier, r.invoiceNumber, r.invoiceDate ? fmt(r.invoiceDate) : "no date", r.totalCents === null ? "no amount" : money(r.totalCents)]
                    .filter(Boolean)
                    .join(" · ")}
                </span>
                <form action={destroy} className="shrink-0">
                  <button
                    name="destroyId"
                    value={r.id}
                    className="btn btn-sm border-crit text-crit hover:bg-crit-soft"
                    formNoValidate
                  >
                    Delete this record
                  </button>
                </form>
              </li>
            ))}
          </ul>
        </Card>
      )}

      {misfiled.length > 0 && canManage && (
        <Card
          tone="crit"
          title="In the invoice folder, and not invoices"
          count={misfiled.length}
          subtitle="An invoice folder is worth having only if everything in it is an invoice, so the burden is on the document: a PDF listing item lines with NDCs and prices is left alone, and everything else is here. The named ones file themselves — and a purchase drill down has its compliance ratio read while it goes."
          className="mt-4 mb-6"
          actions={
            namedMisfiled.length > 0 ? (
              <form action={refile}>
                <button className="btn btn-sm btn-primary">
                  File the {namedMisfiled.length} {namedMisfiled.length === 1 ? "it can name" : "it can name"}
                </button>
              </form>
            ) : undefined
          }
        >
          <ul className="rows">
            {misfiled.map((m) => (
              <li key={m.id} className="flex flex-wrap items-start justify-between gap-2 py-2">
                <span className="min-w-0">
                  <a href={`/files/${m.id}`} target="_blank" rel="noreferrer" className="text-sm text-accent hover:underline">{m.title}</a>
                  <span className="mt-0.5 block text-xs text-ink-3">{m.why}</span>
                </span>
                <span className="flex shrink-0 flex-wrap items-center gap-1">
                  <span className={`badge ${m.belongsIn ? "badge-warn" : "badge-muted"} self-center`}>
                    {m.kind === "unknown" ? "cannot tell" : m.kind.replace(/_/g, " ")}
                  </span>
                  {/*
                    The site will not move what it cannot name, and will not leave it unanswerable
                    either. These two buttons are the answer, on the row, needing nothing typed.
                  */}
                  {!m.belongsIn && (
                    <>
                      <form action={callItAnInvoice}>
                        <input type="hidden" name="documentId" value={m.id} />
                        <button className="btn btn-sm" formNoValidate title="Keeps it in the invoice folder and stops asking about it.">
                          It is an invoice
                        </button>
                      </form>
                      <form action={callItNotAnInvoice}>
                        <input type="hidden" name="documentId" value={m.id} />
                        <button className="btn btn-sm" formNoValidate title="Files it under supplier statements and takes anything read off it out of purchases.">
                          Not an invoice
                        </button>
                      </form>
                    </>
                  )}
                  <form action={destroy}>
                    <input type="hidden" name="documentId" value={m.id} />
                    <button className="btn btn-sm border-crit text-crit hover:bg-crit-soft" formNoValidate title="Deletes it outright.">Delete</button>
                  </form>
                </span>
              </li>
            ))}
          </ul>
        </Card>
      )}

      {adoptable.length > 0 && canManage && (
        <Card
          tone="warn"
          title="Already received, but not filed as invoices"
          count={adoptable.length}
          subtitle="These arrived by email and went into the document vault before this screen existed, or came from a sender not yet named as a supplier. Filing them reads each one and sorts it by schedule, exactly as an incoming one would be."
          className="mt-4 mb-6"
          actions={
            <form action={fileThem}>
              <button className="btn btn-sm btn-primary">File all {adoptable.length}</button>
            </form>
          }
        >
          <ul className="rows">
            {adoptable.slice(0, 12).map((d) => (
              <li key={d.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                <span className="min-w-0">
                  <a href={`/files/${d.id}`} target="_blank" rel="noreferrer" className="text-sm text-accent hover:underline">
                    {d.title}
                  </a>
                  <span className="mt-0.5 block text-xs text-ink-3">
                    {[d.fileName, d.receivedFrom, d.effectiveOn ? fmt(d.effectiveOn) : ""].filter(Boolean).join(" · ")}
                  </span>
                </span>
                {/*
                  A way off this list for something that is not an invoice.

                  The list is built from a document's title and file name, so anything with a
                  supplier's name on it lands here — and without this, a document that is not an
                  invoice can never leave, and the list can never be emptied.
                */}
                <span className="flex shrink-0 gap-1">
                  <form action={notAnInvoiceDocument}>
                    <input type="hidden" name="documentId" value={d.id} />
                    <button className="btn btn-sm" formNoValidate title="Keeps the document, files it as a supplier statement, and stops offering it here.">
                      Not an invoice
                    </button>
                  </form>
                  <form action={destroy}>
                    <input type="hidden" name="documentId" value={d.id} />
                    <button className="btn btn-sm border-crit text-crit hover:bg-crit-soft" formNoValidate title="Deletes the document outright.">
                      Delete
                    </button>
                  </form>
                </span>
              </li>
            ))}
          </ul>
          {adoptable.length > 12 && (
            <p className="mt-2 text-xs text-ink-3">and {adoptable.length - 12} more — all of them are filed by the one button.</p>
          )}
        </Card>
      )}

      {/*
        Amounts that were never read, offered as one press rather than a filter to discover.
        
        The entry form existed but only appeared behind a query string nobody would guess at, and
        the reason the amounts were blank — that nothing ever went back over invoices filed before
        the column existed — was invisible. Both are said here, where the blanks are seen.
      */}
      {noAmountCount > 0 && canManage && (
        <Card
          tone="warn"
          title={`${noAmountCount} invoice${noAmountCount === 1 ? " has" : "s have"} no amount`}
          subtitle="Anything filed before this system recorded amounts has a blank one, because the reading happens as an invoice is filed and nothing went back over the older ones. The PDFs are still here, so they can be read now."
          className="mt-4 mb-6"
          actions={
            <>
              <form action={readAmounts}>
                <SubmitButton className="btn btn-sm btn-primary" pendingLabel="Reading…">
                  Read them off the invoices
                </SubmitButton>
              </form>
              <Link href="/inventory/invoices?noamount=1" className="btn btn-sm">Type them in</Link>
            </>
          }
        >
          <p className="text-xs text-ink-3">
            Only a labelled total is ever read — net payable, total due, amount due, invoice total, balance due — and
            in that order, because one wholesaler prints both a purchases figure and a payable and only the second is
            what you are billed. An invoice that prints no total at all comes back blank and has to be typed in: that
            is IPD, which shows subtotals by schedule and no single figure. A number assembled from parts would be one
            this system invented, on a record that gets reconciled against a payment.
          </p>
        </Card>
      )}

      {noLinesCount > 0 && canManage && (
        <Card
          tone="warn"
          title={`${noLinesCount} invoice${noLinesCount === 1 ? " has" : "s have"} not had ${noLinesCount === 1 ? "its" : "their"} item lines read as numbers`}
          subtitle="What was bought — NDC, quantity, unit price, extended amount — is kept per line so purchases can be added up by product, checked against the catalogue price, and counted toward a rebate tier. Invoices filed before this existed have only the text."
          className="mt-4 mb-6"
          actions={
            <form action={readLines}>
              <SubmitButton className="btn btn-sm btn-primary" pendingLabel="Reading…">
                Read the lines off the invoices
              </SubmitButton>
            </form>
          }
        >
          <p className="text-xs text-ink-3">
            Every column is read only in a layout this knows, which today is McKesson&apos;s. Other wholesalers&apos; lines are
            read for the NDC and the amount, and marked as partial; nothing is assumed for a quantity or a price the
            page did not print. Each invoice records how many lines were read and how many could not be, so a sum of
            lines is never mistaken for the total of the invoice.
          </p>
        </Card>
      )}

      <div className="mt-4 grid gap-3 sm:grid-cols-5">
        <Figure value={counts.schedule_2} label="Schedule II" sub="Kept apart from everything" href="/inventory/invoices?tab=schedule_2" tone={counts.schedule_2 ? "ok" : "muted"} />
        <Figure value={counts.schedule_3_5} label="Schedule III-V" sub="Also kept apart" href="/inventory/invoices?tab=schedule_3_5" tone="muted" />
        <Figure value={counts.none} label="No controlled lines" sub="Ordinary business records" href="/inventory/invoices?tab=none" tone="muted" />
        <Figure
          value={receiptElsewhere ? counts.schedule_2 + counts.schedule_3_5 : unreceipted.length}
          label={receiptElsewhere ? "Controlled invoices" : "Not confirmed received"}
          sub={receiptElsewhere ? `Receipt confirmed in ${receiptElsewhere}` : unreceipted.length ? "The paper slip is still the record" : "All confirmed"}
          href="/inventory/invoices?unreceipted=1"
          tone={receiptElsewhere ? "muted" : unreceipted.length ? "warn" : "ok"}
        />
        <Figure
          value={counts.review}
          label="Waiting on you"
          sub={counts.review ? "Held with the C2s until confirmed" : "Nothing unread"}
          href="/inventory/invoices?unconfirmed=1"
          tone={counts.review ? "warn" : "ok"}
        />
      </div>

      {review.length > 0 && !filtered && (
        <Card
          tone="warn"
          title="Read but not certain"
          count={review.length}
          subtitle="Each of these is held with the Schedule II records, because assuming the other way is the one mistake that breaks the rule. Say what it carries and it moves."
          className="mt-4 mb-6"
        >
          <ul className="rows">
            {review.slice(0, 8).map((i) => (
              <li key={i.id} className="py-3">
                <div className="flex flex-wrap items-baseline gap-2">
                  <a href={`/files/${i.documentId}`} target="_blank" rel="noreferrer" className="text-sm font-medium text-accent hover:underline">
                    {[i.supplier, i.invoiceNumber].filter(Boolean).join(" · ") || "Invoice"}
                  </a>
                  <span className="text-xs text-ink-3">{i.invoiceDate ? fmt(i.invoiceDate) : "no date read"}</span>
                </div>
                {i.basis && <p className="mt-1 text-xs text-ink-3">{i.basis}</p>}
                {/*
                  What is true now, worked out now.

                  The line above is a record of a decision taken on a day. This is the state of the
                  document today, and the two can no longer disagree, because only one of them is
                  stored.
                */}
                {(i.linesRead ?? 0) === 0 && (i.totalCents ?? 0) > 0 && (
                  <p className="mt-1 text-xs text-warn">
                    The total was read off the page and no item line under it was, so nothing on this invoice reaches
                    the cost of any drug.
                  </p>
                )}
                {i.controlledItems && <p className="mt-1 whitespace-pre-wrap text-xs text-ink-2">{i.controlledItems}</p>}
                {canManage && (
                  <>
                    <form action={confirm} className="mt-2 flex flex-wrap items-center gap-1.5">
                      <input type="hidden" name="id" value={i.id} />
                      <select name="schedule" className="field w-auto py-1 text-xs" defaultValue="">
                        <option value="" disabled>What does it carry?</option>
                        <option value="schedule_2">A Schedule II line</option>
                        <option value="schedule_3_5">Schedule III-V only</option>
                        <option value="none">No controlled substances</option>
                      </select>
                      <button className="btn btn-sm btn-primary">File it</button>
                    </form>
                    {/*
                      The way out, which this queue did not have.

                      Every action here filed the thing as an invoice. A statement of account that
                      landed in the queue could therefore only be confirmed as an invoice or left
                      sitting, and this list is drawn above the table, so it is the first thing
                      seen and the last place anybody would look for a way to remove something. The
                      table below has had these two buttons all along; the queue is where they were
                      needed.
                    */}
                    <form className="mt-1.5 flex flex-wrap items-center gap-1.5">
                      <input type="hidden" name="unfileId" value={i.id} />
                      <input type="hidden" name="back" value="/inventory/invoices" />
                      <input type="hidden" name={`as_${i.id}`} value="statement" />
                      <button
                        formAction={notAnInvoice}
                        formNoValidate
                        className="btn btn-sm text-[11px]"
                        title="Keeps the document, files it under supplier statements, and stops offering it as an invoice."
                      >
                        Not an invoice — it is a statement
                      </button>
                      <button
                        formAction={destroy}
                        formNoValidate
                        name="destroyId"
                        value={i.id}
                        className="btn btn-sm border-crit text-[11px] text-crit hover:bg-crit-soft"
                        title="Deletes the document, this record and every line read off it. Nothing is kept."
                      >
                        Delete it
                      </button>
                    </form>
                  </>
                )}
              </li>
            ))}
          </ul>
          {review.length > 8 && (
            <p className="mt-2 text-xs text-ink-3">
              <Link href="/inventory/invoices?unconfirmed=1" className="underline">and {review.length - 8} more</Link>
            </p>
          )}
        </Card>
      )}

      {/* ── Finding one ──────────────────────────────────────────────── */}
      <Card
        title="Find an invoice"
        subtitle="Search runs over the invoice number, the supplier, the date and every item line — so an invoice number, a drug name or an NDC all find the invoice they belong to. Part of a number is enough."
        className="mt-6"
      >
        <form className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
          <input type="hidden" name="tab" value={active} />
          <label className="text-xs font-medium text-ink-2 lg:col-span-2">
            Anything on it
            <input
              name="q"
              defaultValue={sp.q}
              placeholder="7656147111, oxycodone, an NDC"
              className="field mt-1"
            />
          </label>
          <label className="text-xs font-medium text-ink-2">
            Month
            <select name="month" defaultValue={sp.month ?? ""} className="field mt-1">
              <option value="">Any month</option>
              {months.map((m) => <option key={m} value={m}>{monthLabel(m)}</option>)}
            </select>
          </label>
          <label className="text-xs font-medium text-ink-2">
            Supplier
            <select name="supplier" defaultValue={sp.supplier ?? ""} className="field mt-1">
              <option value="">Any supplier</option>
              {suppliers.map((x) => <option key={x} value={x}>{x}</option>)}
            </select>
          </label>
          <label className="text-xs font-medium text-ink-2">
            On this exact day
            <input type="date" name="on" defaultValue={sp.on} className="field mt-1" />
          </label>
          <label className="text-xs font-medium text-ink-2">
            From
            <input type="date" name="from" defaultValue={sp.from} className="field mt-1" />
          </label>
          <label className="text-xs font-medium text-ink-2">
            To
            <input type="date" name="to" defaultValue={sp.to} className="field mt-1" />
          </label>
          <label className="text-xs font-medium text-ink-2">
            Amount at least
            <input type="number" step="0.01" min="0" name="min" defaultValue={sp.min} placeholder="$" className="field mt-1" />
          </label>
          <label className="text-xs font-medium text-ink-2">
            Amount at most
            <input type="number" step="0.01" min="0" name="max" defaultValue={sp.max} placeholder="$" className="field mt-1" />
          </label>
          <div className="flex flex-wrap items-end gap-3 lg:col-span-2">
            <button className="btn btn-primary">Search</button>
            {filtered && <Link href={`/inventory/invoices?tab=${active}`} className="btn">Clear</Link>}
            <label className="flex items-center gap-1.5 text-xs text-ink-2">
              <input type="checkbox" name="noamount" value="1" defaultChecked={onlyNoAmount} />
              Only ones with no amount read
            </label>
          </div>
          <p className="text-xs text-ink-3 lg:col-span-4">
            A day on its own answers &ldquo;what came in on the 4th&rdquo;. From and To answer a quarter. An exact day
            wins over a range if both are filled in, and a month over either.
          </p>
        </form>
      </Card>

      <div className="mt-4 flex flex-wrap gap-1.5">
        {TABS.map((t) => (
          <Link
            key={t.key}
            href={`/inventory/invoices?${new URLSearchParams({
              ...Object.fromEntries(Object.entries(sp).filter(([k, v]) => v && k !== "ok" && k !== "error" && k !== "tab") as [string, string][]),
              tab: String(t.key),
            }).toString()}`}
            className={`btn btn-sm ${active === t.key ? "btn-primary" : ""}`}
          >
            {t.label}
            {t.key !== "all" && <span className="ml-1.5 opacity-70">{counts[t.key as InvoiceSchedule]}</span>}
          </Link>
        ))}
      </div>

      {/*
        Selecting and sending, as one form around the table.

        The alternative was finding each PDF, then attaching them by hand in a mail client, which
        is how the accountant ends up with the wrong month and nobody can afterwards say what was
        sent. Every send is recorded — who, what, when, and whether Schedule II records were in it,
        because forwarding one of those is a disclosure.
      */}
      <form action={send}>
        <input type="hidden" name="back" value={here} />
        <Card
          title={onlyUndated ? "Invoices with no date" : TABS.find((t) => t.key === active)!.label}
          count={shown.length}
          subtitle={onlyUndated ? "In the archive, but not retrievable by date — which is what an inspector asks for." : TABS.find((t) => t.key === active)!.blurb}
          className="mt-3"
        >
          {/* Inside the table's one form, so the button names its own action rather than opening a second form. */}
          {canManage && (
            <div className="mb-3">
              <SubmitButton className="btn btn-sm" pendingLabel="Reading them again…" formNoValidate formAction={recheckAll}>
                Check these are all really invoices
              </SubmitButton>
              <span className="ml-2 text-xs text-ink-3">
                Reads each filed document again on its own words and takes out anything that turns out to be a statement,
                a rebate breakdown or a credit memo. It only ever moves things out of the invoice file.
              </span>
            </div>
          )}
          {shown.length === 0 ? (
            <Empty>
              {filtered
                ? "Nothing matches that. Clear the search to see everything."
                : "Nothing here yet. Ask the supplier to email invoices to the mailbox this site reads, and they file themselves."}
            </Empty>
          ) : (
            <>
              <div className="overflow-x-auto">
                <table className="table">
                  <thead>
                    <tr>
                      {canManage && <th className="w-8"></th>}
                      <th>Date</th><th>Supplier</th><th>Invoice</th><th className="text-right">Amount</th><th>Paid</th><th>Carries</th><th>Lines</th><th></th>
                    </tr>
                  </thead>
                  <tbody>
                    {shown.map((i) => (
                      <tr key={i.id}>
                        {canManage && (
                          <td className="align-top">
                            <input type="checkbox" name="pick" value={i.id} aria-label={`Select invoice ${i.invoiceNumber ?? ""}`} />
                          </td>
                        )}
                        <td className="whitespace-nowrap align-top text-xs">
                          {i.invoiceDate ? (
                            fmt(i.invoiceDate)
                          ) : canManage ? (
                            <span className="inline-flex flex-col gap-1">
                              <span className="badge badge-crit">no date</span>
                            </span>
                          ) : (
                            "—"
                          )}
                        </td>
                        <td className="align-top text-sm">{i.supplier ?? "—"}</td>
                        <td className="align-top font-mono text-xs">{i.invoiceNumber ?? "—"}</td>
                        <td className="whitespace-nowrap align-top text-right font-mono text-xs">
                          {i.totalCents === null ? (
                            <Link href="/inventory/invoices?noamount=1" className="badge badge-muted">no amount</Link>
                          ) : (
                            money(i.totalCents)
                          )}
                        </td>
                        <td className="whitespace-nowrap align-top text-xs">
                          {canManage ? (
                            <form action={paidIt} className="flex items-center gap-1">
                              <input type="hidden" name="id" value={i.id} />
                              <input type="date" name="paidOn" defaultValue={i.paidOn ?? ""} aria-label="Date paid" className="field w-auto py-0.5 text-xs" />
                              <button className="btn btn-sm">{i.paidOn ? "Save" : "Paid"}</button>
                            </form>
                          ) : i.paidOn ? (
                            fmt(i.paidOn)
                          ) : (
                            <span className="text-ink-3">on terms</span>
                          )}
                        </td>
                        <td className="align-top">
                          <span className={`badge ${i.schedule === "schedule_2" ? "badge-crit" : i.schedule === "schedule_3_5" ? "badge-warn" : "badge-muted"}`}>
                            {filingFor(i.schedule).label}
                          </span>
                          {i.needsReview && !i.reviewedAt && <span className="badge badge-warn ml-1">unconfirmed</span>}
                          {/* A total with nothing under it, said on the row itself.
                              The money is in the archive and none of it reaches the cost of a drug,
                              so this must not read as an ordinary filed invoice. Null and zero are
                              the same answer here: one means nothing ever read the lines, the other
                              that a reading found none, and neither put a figure against an NDC. */}
                          {(i.totalCents ?? 0) > 0 && !i.linesRead && (
                            <span className="badge badge-crit ml-1" title="The total was read off the page and no item line under it was. Until the lines are entered or a readable copy replaces it, nothing on this invoice reaches the cost of any drug.">
                              no item lines
                            </span>
                          )}
                          {/* How much of the invoice is held as numbers, so a blank total on a
                              product-by-product page traces back to this row. */}
                          {i.linesRead !== null && (
                            <span className="mt-1 block text-[11px] text-ink-3">
                              {i.linesRead} line{i.linesRead === 1 ? "" : "s"} as numbers
                              {i.linesUnread ? `, ${i.linesUnread} not read` : ""}
                            </span>
                          )}
                        </td>
                        <td className="max-w-[24rem] align-top whitespace-pre-wrap text-xs text-ink-2">
                          {i.controlledItems || <span className="text-ink-3">no controlled lines</span>}
                        </td>
                        <td className="whitespace-nowrap align-top">
                          <a href={`/files/${i.documentId}`} target="_blank" rel="noreferrer" className="btn btn-sm">Open</a>
                          {canManage && (
                            <details className="mt-1">
                              <summary className="cursor-pointer text-[11px] text-ink-3 hover:text-accent">Not an invoice?</summary>
                              {/*
                                Delete, plainly, without a menu in front of it.

                                The choice below decides where a document goes when it is kept. This
                                is for the case where it should not be kept at all, and burying that
                                behind a select was how somebody ended up going round in circles
                                with a statement that would not leave.
                              */}
                              {/*
                                No hidden field for the document, deliberately.

                                This whole table is one form — the one that emails invoices on — so a
                                hidden input on every row means the form carries one per row and
                                `fd.get("documentId")` returns the FIRST row's, whichever row was
                                pressed. Deleting the third invoice would take the first one's
                                document with it. A submit button's own name and value are the only
                                thing a form sends per-button, so the id travels there and nowhere
                                else; the delete finds the document from the invoice itself.
                              */}
                              <button
                                formAction={destroy}
                                formNoValidate
                                name="destroyId"
                                value={i.id}
                                className="btn btn-sm mt-1 w-full border-crit text-[11px] text-crit hover:bg-crit-soft"
                                title="Deletes the document, this invoice record and every line read off it. Nothing is kept."
                              >
                                Delete it and everything read off it
                              </button>
                              <p className="mt-1 text-[11px] text-ink-3">or say what it actually is:</p>
                              <div className="mt-1 flex flex-col gap-1">
                                <select name={`as_${i.id}`} className="field px-2 py-1 text-[11px]" defaultValue="statement">
                                  <option value="statement">It is a statement of account</option>
                                  <option value="rebate_report">It is a rebate breakdown</option>
                                  <option value="credit_memo">It is a credit memo</option>
                                  <option value="other">Something else — just file it away</option>
                                  <option value="discard">Delete it entirely</option>
                                </select>
                                <button
                                  formAction={notAnInvoice}
                                  /*
                                    The surrounding form is the one that emails invoices on, and its
                                    address box is required — so pressing this asked for an email
                                    address before it would do anything, which is nonsense on a
                                    button about filing. The browser validates the whole form on any
                                    submit unless the button opts out.
                                  */
                                  formNoValidate
                                  name="unfileId"
                                  value={i.id}
                                  className="btn btn-sm text-[11px]"
                                  title="Removes it from the invoice file along with everything read off it, and files the document where it belongs."
                                >
                                  Take it out of the invoice file
                                </button>
                              </div>
                            </details>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                  {/*
                    What the shown invoices come to.
                    It follows the filter rather than the whole archive, so "August, McKesson" is
                    also the answer to "what did we spend with McKesson in August" — which is the
                    question actually asked of an invoice file between inspections.
                  */}
                  <tfoot>
                    <tr className="border-t border-line font-medium">
                      <td colSpan={canManage ? 4 : 3} className="pt-2 text-xs text-ink-2">
                        {shown.length} invoice{shown.length === 1 ? "" : "s"}
                        {filtered ? " matching this search" : ""}
                      </td>
                      <td className="pt-2 text-right font-mono text-sm">{money(totals.total)}</td>
                      <td colSpan={3} className="pt-2 pl-2 text-xs text-ink-3">
                        {totals.missing > 0 && (
                          <>
                            excludes{" "}
                            <Link href="/inventory/invoices?noamount=1" className="underline">
                              {totals.missing} with no amount read
                            </Link>
                          </>
                        )}
                      </td>
                    </tr>
                  </tfoot>
                </table>
              </div>

              {canManage && (
                <div className="mt-4 border-t border-line pt-4">
                  <h3 className="text-sm font-semibold">Send the ones you have ticked</h3>
                  <p className="mt-0.5 text-xs text-ink-3">
                    They go as attachments, with a list of what is in the message. Every send is recorded against your
                    name, and a send containing Schedule II records says so.
                  </p>
                  <div className="mt-2 grid gap-2 sm:grid-cols-3">
                    <label className="text-xs font-medium text-ink-2">
                      To
                      <input name="to" type="email" required placeholder="accountant@example.com" className="field mt-1" />
                    </label>
                    <label className="text-xs font-medium text-ink-2 sm:col-span-2">
                      Anything to say with it
                      <input name="note" placeholder="August invoices, as asked" className="field mt-1" />
                    </label>
                  </div>
                  <button className="btn btn-primary mt-2">Send by email</button>
                </div>
              )}
            </>
          )}

          <p className="mt-3 text-xs text-ink-3">
            Kept for five years, which is the Kansas retention period and longer than the two years 21 CFR 1304.04(a)
            requires. Every one is in the daily backup, and nothing here is deleted when a supplier account closes.
          </p>
        </Card>
      </form>

      {onlyUndated && canManage && shown.length > 0 && (
        <Card title="Put a date on each of these" className="mt-4" subtitle="Taken from the invoice itself — the billing date, not the day it arrived.">
          <ul className="rows">
            {shown.map((i) => (
              <li key={i.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                <a href={`/files/${i.documentId}`} target="_blank" rel="noreferrer" className="text-sm text-accent hover:underline">
                  {[i.supplier, i.invoiceNumber].filter(Boolean).join(" · ") || "Invoice"}
                </a>
                <form action={dateIt} className="flex items-center gap-1.5">
                  <input type="hidden" name="id" value={i.id} />
                  <input type="date" name="invoiceDate" required className="field w-auto py-1 text-xs" />
                  <button className="btn btn-sm">Save</button>
                </form>
              </li>
            ))}
          </ul>
        </Card>
      )}

      {/*
        Confirming the goods arrived, per invoice.

        Deliberately a date and a note rather than a tick: 21 CFR 1304.22(c) asks for the date and
        the quantity, and a short count is exactly the thing somebody writes on the paper slip and
        then cannot throw away. The name comes from whoever is signed in.
      */}
      {onlyUnreceipted && canManage && !(s.receipt_record_kept_in ?? "").trim() && unreceipted.length > 0 && (
        <Card
          title="Confirm what actually arrived"
          count={unreceipted.length}
          className="mt-4"
          subtitle="The invoice proves what the wholesaler shipped. This is the record that it arrived, on what date, and whether it matched — the thing initials on a paper packing slip are for. Once it is here, that slip is a duplicate rather than the record, and does not have to be kept."
        >
          <ul className="rows">
            {unreceipted.slice(0, 25).map((i) => (
              <li key={i.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                <a href={`/files/${i.documentId}`} target="_blank" rel="noreferrer" className="text-sm text-accent hover:underline">
                  {[i.supplier, i.invoiceNumber, i.invoiceDate ? fmt(i.invoiceDate) : null].filter(Boolean).join(" · ") || "Invoice"}
                  <span className={`badge ml-2 ${i.schedule === "schedule_2" ? "badge-crit" : i.schedule === "schedule_3_5" ? "badge-warn" : "badge-muted"}`}>
                    {filingFor(i.schedule).label}
                  </span>
                </a>
                <form action={receipt} className="flex flex-wrap items-center gap-1.5">
                  <input type="hidden" name="id" value={i.id} />
                  <input type="date" name="receivedOn" required defaultValue={new Date().toISOString().slice(0, 10)} className="field w-auto py-1 text-xs" aria-label="Date received" />
                  <input name="note" placeholder="Anything short or damaged?" className="field w-56 py-1 text-xs" />
                  <button className="btn btn-sm">Received</button>
                </form>
              </li>
            ))}
          </ul>
          {unreceipted.length > 25 && (
            <p className="mt-2 text-xs text-ink-3">and {unreceipted.length - 25} more.</p>
          )}
        </Card>
      )}

      {onlyNoAmount && canManage && shown.length > 0 && (
        <Card
          title="Type in the amount for these"
          className="mt-4"
          subtitle="The figure the invoice is billed at. One wholesaler prints subtotals by schedule and no single invoice total, so there is nothing on the page safe to read — adding the parts up would be the site inventing a number that later gets reconciled against a payment."
        >
          <ul className="rows">
            {shown.map((i) => (
              <li key={i.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                <a href={`/files/${i.documentId}`} target="_blank" rel="noreferrer" className="text-sm text-accent hover:underline">
                  {[i.supplier, i.invoiceNumber, i.invoiceDate ? fmt(i.invoiceDate) : null].filter(Boolean).join(" · ") || "Invoice"}
                </a>
                <form action={amount} className="flex items-center gap-1.5">
                  <input type="hidden" name="id" value={i.id} />
                  <input
                    type="number"
                    step="0.01"
                    min="0"
                    name="dollars"
                    required
                    placeholder="0.00"
                    className="field w-32 py-1 text-right text-xs"
                  />
                  <button className="btn btn-sm">Save</button>
                </form>
              </li>
            ))}
          </ul>
        </Card>
      )}

      {/*
        What the pharmacist knows about his own suppliers, used the safe way round.

        He orders Schedule IIs from two of his three wholesalers and never from the third. That is
        real knowledge and worth having here — but never as a reason to file something as
        uncontrolled, because used that way it would suppress the one event most worth catching.
        Used this way it does the opposite: a controlled substance arriving from somewhere it
        never arrives from is either an ordering mistake or something worse, and nothing else
        would notice.
      */}
      {canManage && suppliers.length > 0 && (
        <Card
          title="What each supplier normally sends"
          subtitle="Nothing is filed differently because of this. It is how the site tells you when a supplier ships something they never ship — which is what an ordering mistake, or a diversion problem, looks like from here."
          className="mt-6"
        >
          <form action={saveExpected}>
            <label className="block text-xs font-medium text-ink-2">
              One per line, as <code>Supplier = none</code>, <code>= 3-5</code> or <code>= 2</code>
              <textarea
                name="expected"
                rows={Math.max(3, suppliers.length + 1)}
                defaultValue={s.supplier_expected_schedule ?? ""}
                placeholder={suppliers.map((x) => `${x} = none`).join("\n")}
                className="field mt-1 font-mono text-xs"
              />
            </label>
            <p className="mt-1 text-xs text-ink-3">
              Suppliers that have sent something so far: {suppliers.join(", ")}.
              {expectations.length > 0 && ` Currently set for ${expectations.length} of them.`}
            </p>
            <button className="btn mt-2">Save</button>
          </form>
        </Card>
      )}

      {canManage && (
        <details className="mt-6">
          <summary className="cursor-pointer text-sm font-medium text-accent">Add an invoice by hand</summary>
          <Card className="mt-2">
            <p className="card-sub">
              For one that arrived on paper and was scanned, or came to somebody else&rsquo;s inbox. It is read and
              filed by schedule the same way an emailed one is.
            </p>
            <form action={upload} className="mt-2 flex flex-wrap items-end gap-3" encType="multipart/form-data">
              <input type="file" name="file" accept="application/pdf,.pdf" className="field" />
              <button className="btn">Read it and file it</button>
            </form>
          </Card>
        </details>
      )}

      {/*
        The compliance posture, checked rather than claimed.

        The ask was to make sure invoice storage is compliant, and a paragraph asserting that it
        is would be worth nothing to the person it is written for. This is the list of what each
        rule requires, what this system does about it, and — for the two that depend on how the
        pharmacy has things set up rather than on the code — whether it is actually satisfied
        right now. An inspector can be shown this page; so can an auditor asking where the
        Schedule II records are kept.
      */}
      <Card
        id="compliance"
        title="How this meets the rules"
        subtitle="Each requirement, what it asks for, and what this system does about it. Two of these depend on how the pharmacy is set up rather than on the software, so they are checked rather than asserted."
        tone={unmet.length ? "warn" : undefined}
        count={unmet.length ? `${unmet.length} to settle` : "all met"}
        className="mt-6 scroll-mt-4"
      >
        <ul className="rows">
          {compliance.map((c) => (
            <li key={c.key} className="py-3">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <span className="flex flex-wrap items-baseline gap-2">
                  <span className={`badge ${c.state === "ok" ? "badge-ok" : "badge-warn"}`}>
                    {c.state === "ok" ? "met" : "settle this"}
                  </span>
                  <span className="font-mono text-xs text-ink-3">{c.citation}</span>
                </span>
                {c.href && c.state !== "ok" && (
                  <Link href={c.href} className="btn btn-sm shrink-0">Fix it</Link>
                )}
              </div>
              <p className="mt-1 text-sm">{c.requires}</p>
              <p className="mt-1 text-xs text-ink-2">{c.how}</p>
              {c.fix && <p className="mt-1 text-xs text-warn">{c.fix}</p>}

              {/*
                The fix, where the shortfall is raised.

                Every one of these used to be a sentence and a link to a page with the control
                somewhere on it — the receipt setting at the top of this page, the sending address
                behind an Edit on a supplier card — and the reading, fairly, was that there was no
                way to fix any of them. A finding and its remedy belong in the same place.
              */}
              {canManage && c.state !== "ok" && c.settle?.kind === "receipt_kept_in" && (
                <form action={receiptKeptIn} className="mt-2 flex flex-wrap items-end gap-2 rounded-md border border-line bg-ground p-2">
                  <label className="text-xs text-ink-2">
                    <span className="block">Where receipt is actually recorded</span>
                    <input
                      name="system"
                      className="field mt-1 w-64 py-1 text-xs"
                      defaultValue={c.settle.current}
                      placeholder="McKesson Connect"
                    />
                  </label>
                  <button className="btn btn-sm btn-primary">Save, and stop asking here</button>
                  <span className="text-[11px] text-ink-3">
                    Name the wholesaler&rsquo;s own system if that is where you check totes in. Leave it empty to record
                    receipt against each invoice here instead.
                  </span>
                </form>
              )}

              {canManage && c.state !== "ok" && c.settle?.kind === "supplier_address" && (
                <div className="mt-2 space-y-2 rounded-md border border-line bg-ground p-2">
                  {c.settle.suppliers.map((sup) => (
                    <form key={sup.id} action={supplierAddress} className="flex flex-wrap items-end gap-2">
                      <input type="hidden" name="supplierId" value={sup.id} />
                      <label className="text-xs text-ink-2">
                        <span className="block">The address {sup.name} sends invoices from</span>
                        <input
                          name="senderEmails"
                          className="field mt-1 w-72 py-1 text-xs"
                          placeholder="invoices@mckesson.com, or just mckesson.com"
                        />
                      </label>
                      <button className="btn btn-sm btn-primary">Save</button>
                    </form>
                  ))}
                  <p className="text-[11px] text-ink-3">
                    A bare domain matches every address at it. Anything already received from that address is filed the
                    moment this is saved — you do not have to ask for it to be sent again.
                  </p>
                </div>
              )}
            </li>
          ))}
        </ul>
        <p className="mt-3 text-xs text-ink-3">
          Kept for {RETENTION_YEARS} years, which is the Kansas retention period and longer than the two years
          21 CFR 1304.04(a) requires of these records.
        </p>
      </Card>

      {sent.length > 0 && (
        <Card title="Recently sent on" count={sent.length} className="mt-6" subtitle="What has left the building, and to whom.">
          <ul className="rows">
            {sent.map((f) => (
              <li key={f.id} className="flex flex-wrap items-baseline justify-between gap-2 py-2 text-sm">
                <span>
                  {f.count} invoice{f.count === 1 ? "" : "s"} to <b>{f.toAddress}</b>
                  {f.includedScheduleTwo && <span className="badge badge-crit ml-2">included Schedule II</span>}
                  {f.error && <span className="badge badge-warn ml-2">failed</span>}
                </span>
                <span className="text-xs text-ink-3">{fmt(f.sentAt.slice(0, 10))} · {f.sentBy}</span>
              </li>
            ))}
          </ul>
        </Card>
      )}
    </>
  );
}
