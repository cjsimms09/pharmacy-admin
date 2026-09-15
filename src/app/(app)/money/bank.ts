"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { and, eq, gte, inArray, like, lte } from "drizzle-orm";
import { matchHeldDeposit, shiftDays, DEPOSIT_WINDOW_DAYS, type HeldForBank } from "@/lib/deposit-gate";
import { db, schema } from "@/db";
import { requireManager } from "@/lib/auth";
import { audit } from "@/lib/audit";
import { newId } from "@/lib/crypto";
import { storeFile } from "@/lib/files";
import { parseCsv } from "@/lib/reference";
import { lineKey, parseBankStatement, placeLines, type BankLine, type MatchContext } from "@/lib/bank-statement";
import type { SolvedStatement, Unproven } from "@/lib/scanned-bank-solve";
import { readFile } from "@/lib/files";
import { parseCents } from "@/lib/money";
import { addCashReceipt, unpaid, vendors } from "@/lib/expenses";
import { allSuppliers } from "@/lib/suppliers-registry";
import { CARD_STATEMENT_BILL } from "@/lib/card-statement";

/** The two systems spell one wholesaler several ways; compared with the noise removed, as cash-cogs.ts does. */
const fold = (s: string | null | undefined) => (s ?? "").trim().toLowerCase().replace(/[^a-z0-9]/g, "");
const money = (c: number) => `$${(c / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/** What the matcher needs to know about the business, read once per statement. */
async function matchContext(): Promise<MatchContext> {
  const [claims, sup, ven, bills, invoices, receipts] = await Promise.all([
    db.query.claims.findMany({ columns: { pbmName: true, payerLabel: true } }),
    allSuppliers(true),
    vendors(),
    unpaid(),
    db.query.supplierInvoices.findMany({ columns: { id: true, supplierId: true, supplier: true, totalCents: true, invoiceDate: true, paidOn: true } }),
    db.query.cashReceipts.findMany({ columns: { payer: true } }),
  ]);
  const payers = new Set<string>();
  for (const c of claims) for (const n of [c.pbmName, c.payerLabel]) if (n && n.trim().length >= 4) payers.add(n.trim());
  for (const r of receipts) if (r.payer && r.payer.trim().length >= 4) payers.add(r.payer.trim());
  const vendorName = new Map(ven.map((v) => [v.id, v.name]));
  /* The card statement's fee bills no bank line has claimed. Booked already paid, so `unpaid()` never returns them. */
  const claimedBills = new Set((await db.query.bankLines.findMany({ columns: { expenseId: true } })).map((r) => r.expenseId).filter((id): id is string => id !== null));
  const cardFeeBills = (await db.query.expenses.findMany({ where: and(like(schema.expenses.invoiceNumber, `${CARD_STATEMENT_BILL}%`), eq(schema.expenses.status, "confirmed")) }))
    .filter((b) => !claimedBills.has(b.id))
    .map((b) => ({ id: b.id, vendorName: b.vendorId ? vendorName.get(b.vendorId) ?? null : null, amountCents: b.amountCents, invoiceDate: b.invoiceDate }));
  /* The wholesaler's own ledger: what each ACH reference covered. What a McKesson debit is placed by. */
  const statementLines = (await db.query.supplierStatementLines.findMany({ columns: { supplier: true, invoiceNumber: true, checkNumber: true, netCents: true } }))
    .filter((l) => l.checkNumber)
    .filter((l, i, all) => all.findIndex((x) => x.supplier === l.supplier && x.invoiceNumber === l.invoiceNumber && x.checkNumber === l.checkNumber) === i);
  const facilitatorByDay = new Map<string, number>();
  for (const p of await db.query.claimPayments.findMany({ where: eq(schema.claimPayments.source, "mtf"), columns: { receivedOn: true, amountCents: true } })) {
    if (p.receivedOn) facilitatorByDay.set(p.receivedOn, (facilitatorByDay.get(p.receivedOn) ?? 0) + p.amountCents);
  }
  const postageBills = (await db.query.expenses.findMany({ where: and(like(schema.expenses.invoiceNumber, "POSTAGE|%"), eq(schema.expenses.status, "confirmed")), columns: { amountCents: true, paidOn: true, invoiceDate: true } }))
    .map((b) => ({ amountCents: b.amountCents, on: b.paidOn ?? b.invoiceDate }));
  return {
    postageBills,
    facilitatorPaid: [...facilitatorByDay].map(([on, cents]) => ({ on, cents })),
    payers: [...payers],
    suppliers: sup.map((s) => ({ id: s.id, name: s.name })),
    vendors: ven.map((v) => ({ id: v.id, name: v.name })),
    unpaidBills: bills.map((b) => ({ id: b.id, vendorId: b.vendorId, vendorName: b.vendorId ? vendorName.get(b.vendorId) ?? null : null, amountCents: b.amountCents, invoiceDate: b.invoiceDate })),
    cardFeeBills,
    settled: statementLines,
    unpaidInvoices: invoices.filter((v) => !v.paidOn).map((v) => ({ id: v.id, supplierId: v.supplierId, supplier: v.supplier, totalCents: v.totalCents, invoiceDate: v.invoiceDate })),
  };
}

export async function readBankStatement(fd: FormData) {
  const user = await requireManager();
  const back = `/money?period=${encodeURIComponent(String(fd.get("period") ?? ""))}`;
  const file = fd.get("file");
  if (!(file instanceof File) || file.size === 0) redirect(`${back}&error=${encodeURIComponent("Choose the bank's statement.")}`);
  const buf = Buffer.from(await file.arrayBuffer());

  /*
   * The scanned statement Emprise sends: a PDF whose figures are proved against its own daily balances before any
   * line is used. See scanned-bank-solve.ts. Anything the balances cannot prove waits for a person on this page.
   */
  if (/^%PDF/.test(buf.subarray(0, 8).toString("latin1"))) {
    const documentId = await keepStatement(file, "Scanned bank statement", user.id);
    if (!documentId) redirect(`${back}&error=${encodeURIComponent("The statement could not be stored, so it was not read. Nothing was placed.")}`);
    const solved = await solveScanned(buf, {});
    if (!solved.ok) redirect(`${back}&error=${encodeURIComponent(`${solved.why} Nothing was placed.`)}`);
    if (solved.unproven.length > 0) redirect(`${back}&scan=${documentId}`);
    return placeStatementLines(scannedLines(solved), { documentId, fileName: file.name, skipped: 0, user, back, notes: solved.notes });
  }

  const parsed = parseBankStatement(parseCsv(buf.toString("utf8")));
  if (parsed.lines.length === 0) redirect(`${back}&error=${encodeURIComponent(parsed.skipped[0]?.why ?? "Nothing in the file could be read as a bank line.")}`);
  const documentId = await keepStatement(file, `Bank statement ${parsed.lines[0].on} to ${parsed.lines[parsed.lines.length - 1].on}`, user.id);
  return placeStatementLines(parsed.lines, { documentId, fileName: file.name, skipped: parsed.skipped.length, user, back });
}

/** The file itself is kept, as the record the receipts and paid dates point back to. Null where it could not be. */
async function keepStatement(file: File, title: string, userId: string): Promise<string | null> {
  try {
    const stored = await storeFile(file, { allowReportTypes: true });
    const existing = await db.query.documents.findFirst({ where: eq(schema.documents.sha256, stored.sha256), columns: { id: true } });
    if (existing) return existing.id;
    const documentId = newId();
    await db.insert(schema.documents).values({
      id: documentId,
      category: "bank_statement",
      title,
      fileName: file.name.slice(0, 200),
      mimeType: stored.mimeType,
      sizeBytes: stored.sizeBytes,
      sha256: stored.sha256,
      storageKey: stored.storageKey,
      uploadedBy: userId,
    });
    return documentId;
  } catch {
    return null;
  }
}

/**
 * Amounts other feeds already hold, which break ties when the scan's balances say a line was misread: every receipt,
 * every bill, each wholesaler ACH's total, and the facilitator's payments summed by day.
 */
async function knownAmounts(): Promise<number[]> {
  const [receipts, bills, ledger, mtf] = await Promise.all([
    db.query.cashReceipts.findMany({ columns: { amountCents: true } }),
    db.query.expenses.findMany({ columns: { amountCents: true, status: true } }),
    db.query.supplierStatementLines.findMany({ columns: { checkNumber: true, netCents: true } }),
    db.query.claimPayments.findMany({ where: eq(schema.claimPayments.source, "mtf"), columns: { receivedOn: true, amountCents: true } }),
  ]);
  const byCheck = new Map<string, number>();
  for (const l of ledger) if (l.checkNumber) byCheck.set(l.checkNumber, (byCheck.get(l.checkNumber) ?? 0) + l.netCents);
  const byDay = new Map<string, number>();
  for (const p of mtf) if (p.receivedOn) byDay.set(p.receivedOn, (byDay.get(p.receivedOn) ?? 0) + p.amountCents);
  return [
    ...receipts.map((r) => Math.abs(r.amountCents)),
    ...bills.filter((b) => b.status !== "void").map((b) => Math.abs(b.amountCents)),
    ...byCheck.values(),
    ...byDay.values(),
  ].filter((c) => c > 0);
}

async function solveScanned(buf: Buffer, confirmed: Record<number, number>) {
  const { pdfItems } = await import("@/lib/pdf-text");
  const { readRaw } = await import("@/lib/scanned-bank-statement");
  const { solveStatement } = await import("@/lib/scanned-bank-solve");
  return solveStatement(readRaw(pdfItems(buf)), { known: await knownAmounts(), confirmed });
}

function scannedLines(solved: Extract<SolvedStatement, { ok: true }>): BankLine[] {
  return solved.lines.map((l) => ({ on: l.on, description: l.description, amountCents: l.amountCents, key: lineKey(l.on, l.amountCents, l.description) }));
}

/** What the Money page shows for a scanned statement waiting on a person: the stretches the balances could not prove. */
export async function scannedStatementReview(documentId: string): Promise<{ fileName: string; unproven: Unproven[]; why: string | null } | null> {
  await requireManager();
  const doc = await db.query.documents.findFirst({ where: eq(schema.documents.id, documentId) });
  if (!doc || doc.category !== "bank_statement") return null;
  const solved = await solveScanned(await readFile(doc.storageKey), {});
  if (!solved.ok) return { fileName: doc.fileName, unproven: [], why: solved.why };
  return { fileName: doc.fileName, unproven: solved.unproven, why: null };
}

/** A person's figures for the lines the balances could not prove. Re-solved with them fixed; placed only if every day then proves. */
export async function confirmScannedStatement(fd: FormData) {
  const user = await requireManager();
  const period = String(fd.get("period") ?? "");
  const back = `/money?period=${encodeURIComponent(period)}`;
  const documentId = String(fd.get("document") ?? "");
  const doc = await db.query.documents.findFirst({ where: eq(schema.documents.id, documentId) });
  if (!doc || doc.category !== "bank_statement") redirect(`${back}&error=${encodeURIComponent("That statement is no longer on file.")}`);
  const confirmed: Record<number, number> = {};
  for (const [k, v] of fd.entries()) {
    const m = /^fix-(\d+)$/.exec(k);
    const cents = m ? parseCents(String(v)) : null;
    if (m && cents !== null && cents > 0) confirmed[Number(m[1])] = Math.abs(cents);
  }
  const solved = await solveScanned(await readFile(doc!.storageKey), confirmed);
  if (!solved.ok) redirect(`${back}&scan=${documentId}&error=${encodeURIComponent(solved.why)}`);
  if (solved.unproven.length > 0) {
    const u = solved.unproven[0];
    redirect(
      `${back}&scan=${documentId}&error=${encodeURIComponent(
        `With those figures, ${u.from}${u.to === u.from ? "" : ` to ${u.to}`} is still ${money(Math.abs(u.differenceCents))} ${u.differenceCents > 0 ? "short of" : "over"} the bank's balance. Nothing was placed.`,
      )}`,
    );
  }
  return placeStatementLines(scannedLines(solved), { documentId, fileName: doc!.fileName, skipped: 0, user, back, notes: solved.notes });
}

async function placeStatementLines(
  lines: BankLine[],
  o: { documentId: string | null; fileName: string; skipped: number; user: { id: string; name: string }; back: string; notes?: string[] },
) {
  const { documentId, user, back } = o;
  const parsed = { lines };
  const file = { name: o.fileName };

  const held = new Set((await db.query.bankLines.findMany({ where: inArray(schema.bankLines.key, parsed.lines.map((l) => l.key)), columns: { key: true } })).map((r) => r.key));
  const fresh = parsed.lines.filter((l) => !held.has(l.key));
  const placed = placeLines(fresh, await matchContext());

  /*
   * The receipts already banked for the statement's dates, so a deposit line confirms one instead of
   * banking the same money again. See `matchHeldDeposit`: before this, every deposit the payer payment
   * report or the Health Mart Atlas EFT notice had banked would have been banked a second time by the
   * first statement read — $250,562.16 of September's third-party receipts on the day it was found.
   */
  const days = fresh.map((l) => l.on).sort();
  /* A receipt an earlier statement already confirmed is not available to be confirmed again. */
  const confirmedAlready = new Set(
    (await db.query.bankLines.findMany({ columns: { receiptId: true } })).map((r) => r.receiptId).filter((id): id is string => id !== null),
  );
  const heldForBank: HeldForBank[] = days.length
    ? (
        await db.query.cashReceipts.findMany({
          where: and(gte(schema.cashReceipts.receivedOn, shiftDays(days[0], -DEPOSIT_WINDOW_DAYS)), lte(schema.cashReceipts.receivedOn, shiftDays(days[days.length - 1], DEPOSIT_WINDOW_DAYS))),
          columns: { id: true, amountCents: true, receivedOn: true, payer: true, reference: true, sourceKey: true },
        })
      ).filter((r) => !confirmedAlready.has(r.id))
    : [];
  const claimed = new Set<string>();

  let deposits = 0;
  let depositCents = 0;
  let confirmed = 0;
  let confirmedCents = 0;
  let bills = 0;
  let invoices = 0;
  let unplaced = 0;
  for (const { line, placement } of placed) {
    /* What is recorded on the bank line. The placement itself keeps its type; only these are overridden. */
    let placedAs: string = placement.kind;
    let why: string = placement.why;
    let receiptId: string | null = null;
    let expenseId: string | null = null;
    let invoiceId: string | null = null;
    /*
     * A credit to the account is matched before it is classified, for any kind the line was placed
     * as — deposit, rebate, facilitator — because the match does not depend on what the description
     * says. A ProviderPay deposit sent by McKesson may be placed as a rebate; it must still confirm
     * the Health Mart Atlas receipt rather than bank a rebate beside it.
     */
    /*
     * Also a credit the classifier could not place at all. A bank description that names nothing
     * useful is exactly the line most likely to be a deposit a feed already banked, and leaving it on
     * the unplaced pile would hand a person work the receipts on file already answer.
     */
    const isCredit = placement.kind === "deposit" || placement.kind === "card_deposit" || placement.kind === "psao_deposit" || (placement.kind === "unplaced" && line.amountCents > 0);
    const match = isCredit
      ? matchHeldDeposit(
          /* A card deposit confirms only a card batch, never another payer's receipt of the same amount (G-CARD-11). */
          placement.kind === "card_deposit" ? heldForBank.filter((h) => h.sourceKey?.startsWith("card-batch|")) : heldForBank,
          { amountCents: line.amountCents, on: line.on, payer: placement.kind === "deposit" ? placement.payer : placement.kind === "card_deposit" ? "Card batch" : null },
          claimed,
        )
      : { kind: "none" as const };
    if (match.kind === "confirms") {
      claimed.add(match.receipt.id);
      receiptId = match.receipt.id;
      placedAs = "confirms_deposit";
      why = match.why;
      confirmed++;
      confirmedCents += line.amountCents;
    } else if (match.kind === "ambiguous") {
      placedAs = "unplaced";
      why = match.why;
      unplaced++;
    } else if (placement.kind === "psao_deposit") {
      /* Never banked here: the payer payment report and the EFT notice bank PSAO money (G-BANK-1). */
      placedAs = "unplaced";
      why = `${placement.why} No payment on file for exactly this amount, so nothing is banked from the line. The payer payment report or the EFT notice banks it: if neither has arrived, forward it; if this deposit is several payments together, tie it by hand.`;
      unplaced++;
    } else if (placement.kind === "card_deposit") {
      /* Never banked here: the card batch report is the one door for card takings. See `placeLine`. */
      placedAs = "unplaced";
      why = `Card takings with no card batch report on file for exactly this amount. Forward the batch reports for the days just before ${line.on} to the inbox (a batch reaches the bank two to four days after it closes, so a Monday deposit can be the previous Thursday's to Saturday's) — it banks the money and this line will match it. Do not bank this with the form: that counts it twice when the report arrives.`;
      unplaced++;
    } else if (placement.kind === "deposit") {
      receiptId = (await addCashReceipt({ month: line.on.slice(0, 7), kind: placement.receiptKind, amountCents: line.amountCents, payer: placement.payer, notes: `From the bank statement: ${line.description}`, receivedOn: line.on, createdBy: user.id })).id;
      /*
       * `receivedOn` so a feed forwarded after the statement can see this deposit and not bank it again.
       * Without it the deposit gate's window query skipped it: a card batch forwarded after the statement
       * was counted twice (Session 2, money map checkpoint 1, case C, proven on a snapshot).
       */
      deposits++;
      depositCents += line.amountCents;
    } else if (placement.kind === "pays_bill") {
      await db.update(schema.expenses).set({ paidOn: line.on }).where(eq(schema.expenses.id, placement.expenseId));
      expenseId = placement.expenseId;
      bills++;
    } else if (placement.kind === "pays_invoice") {
      await db.update(schema.supplierInvoices).set({ paidOn: line.on }).where(eq(schema.supplierInvoices.id, placement.invoiceId));
      invoiceId = placement.invoiceId;
      invoices++;
    } else if (placement.kind === "settles_ach" && placement.agrees) {
      /*
       * The wholesaler's ACH, tied to its invoices by their own reference and equal to them to the cent. The
       * invoices are marked paid on the bank's date; the money is already the cash cost of goods from the
       * wholesaler's own ledger (cash-cogs.ts), so nothing is booked (Session 2, money map G-MCK-1).
       */
      const numbers = new Set(placement.invoices);
      const open = (await db.query.supplierInvoices.findMany({ columns: { id: true, invoiceNumber: true, supplier: true, paidOn: true } })).filter(
        (v) => !v.paidOn && v.invoiceNumber && numbers.has(v.invoiceNumber) && fold(v.supplier) === fold(placement.supplier),
      );
      for (const v of open) await db.update(schema.supplierInvoices).set({ paidOn: line.on }).where(eq(schema.supplierInvoices.id, v.id));
      invoices += open.length;
      why = `${placement.why} ${open.length} of the ${placement.invoices.length} invoices were on file and are marked paid ${line.on}.`;
    } else {
      if (placement.kind === "settles_ach" || placement.kind === "facilitator_unmatched" || placement.kind === "rebate_part") placedAs = "unplaced";
      unplaced++;
    }
    await db.insert(schema.bankLines).values({
      id: newId(),
      key: line.key,
      on: line.on,
      description: line.description,
      amountCents: line.amountCents,
      placedAs,
      why,
      receiptId,
      expenseId,
      invoiceId,
      documentId,
      createdBy: user.id,
    });
  }
  await audit({
    action: "bank.statement_read",
    userId: user.id,
    userName: user.name,
    entity: "document",
    entityId: documentId ?? undefined,
    details: `${file.name}: ${parsed.lines.length} lines, ${held.size} already held, ${deposits} deposits ${money(depositCents)}, ${confirmed} confirming deposits already banked ${money(confirmedCents)}, ${bills} bills and ${invoices} invoices marked paid, ${unplaced} not placed`,
  });
  for (const p of ["/money", "/money/monthly", "/expenses", "/inventory/invoices"]) revalidatePath(p);
  const said =
    `${parsed.lines.length} lines read` +
    (held.size ? `, ${held.size} already held` : "") +
    `: ${deposits} deposit${deposits === 1 ? "" : "s"} banked (${money(depositCents)}), ${bills} bill${bills === 1 ? "" : "s"} and ${invoices} invoice${invoices === 1 ? "" : "s"} marked paid` +
    (unplaced ? `, ${unplaced} not placed — listed below the receipts` : "") +
    (o.skipped ? `; ${o.skipped} row${o.skipped === 1 ? "" : "s"} could not be read` : "") +
    (o.notes?.length ? ` Read from the scan and proved against its daily balances.` : "") +
    ".";
  redirect(`${back}&ok=${encodeURIComponent(said)}`);
}

/** The statement lines that fall in the period: how many were placed, and the ones that were not. */
export async function lastStatementLines(months: string[]): Promise<{ placed: number; unplaced: { id: string; on: string; description: string; amountCents: number; why: string | null }[] }> {
  const rows = await db.query.bankLines.findMany({ orderBy: (b, { desc }) => [desc(b.on)] });
  const set = new Set(months);
  const mine = rows.filter((r) => set.has(r.on.slice(0, 7)));
  return {
    placed: mine.filter((r) => r.placedAs !== "unplaced").length,
    unplaced: mine.filter((r) => r.placedAs === "unplaced").map((r) => ({ id: r.id, on: r.on, description: r.description, amountCents: r.amountCents, why: r.why })),
  };
}
