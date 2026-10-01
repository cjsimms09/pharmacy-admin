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
import { lineKey, parseBankStatement, placeLines, OPENING_TAKINGS_DAYS, type BankLine, type MatchContext } from "@/lib/bank-statement";
import { SITE_STARTS_ON } from "@/lib/books-start";
import type { SolvedStatement, Unproven } from "@/lib/scanned-bank-solve";
import { readFile } from "@/lib/files";
import { parseCents } from "@/lib/money";
import { addCashReceipt, categories, saveExpense, saveVendor, seedCategories, unpaid, vendors } from "@/lib/expenses";
import { allSuppliers } from "@/lib/suppliers-registry";
import { CARD_STATEMENT_BILL } from "@/lib/card-statement";
import { readBankDescriptor } from "@/lib/bank-descriptors";
import { paymentFromBankDebit } from "@/lib/supplier-payments";
import { matchContext } from "@/lib/bank-match-context";

/** The two systems spell one wholesaler several ways; compared with the noise removed, as cash-cogs.ts does. */
const fold = (s: string | null | undefined) => (s ?? "").trim().toLowerCase().replace(/[^a-z0-9]/g, "");
const money = (c: number) => `$${(c / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

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
    const kept = await db.query.documents.findFirst({ where: eq(schema.documents.id, documentId), columns: { id: true, storageKey: true } });
    if (!kept) redirect(`${back}&error=${encodeURIComponent("The statement was stored and could not be read back. Nothing was placed.")}`);
    const solved = await solveScanned(kept, {});
    if (!solved.ok) redirect(`${back}&error=${encodeURIComponent(`${solved.why} Nothing was placed.`)}`);
    if (solved.unproven.length > 0) redirect(`${back}&scan=${documentId}`);
    await placeStatementLines(scannedLines(solved), { documentId, fileName: file.name, skipped: 0, user, back, notes: solved.notes });
  }

  const parsed = parseBankStatement(parseCsv(buf.toString("utf8")));
  if (parsed.lines.length === 0) redirect(`${back}&error=${encodeURIComponent(parsed.skipped[0]?.why ?? "Nothing in the file could be read as a bank line.")}`);
  const documentId = await keepStatement(file, `Bank statement ${parsed.lines[0].on} to ${parsed.lines[parsed.lines.length - 1].on}`, user.id);
  await placeStatementLines(parsed.lines, { documentId, fileName: file.name, skipped: parsed.skipped.length, user, back });
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

/*
 * The statement's words come from its text layer where it has one, and from recognition where it does not.
 *
 * August's statement, the bank's own download, carries a text layer and `pdfItems` reads it. September's
 * arrived as a forwarded scan — thirteen pages of JPEG, no text at all — and `pdfItems` returned nothing,
 * so the Money page had nothing to show and the owner was told the file could not be read. It can:
 * `ocr.ts` recognises the pages on this machine and hands back words in the same frame, cached per
 * document so the half-minute is paid once. The reader and the solver downstream see no difference.
 */
async function solveScanned(doc: { id: string; storageKey: string }, confirmed: Record<number, number>) {
  const { pdfItems } = await import("@/lib/pdf-text");
  const { readRaw } = await import("@/lib/scanned-bank-statement");
  const { solveStatement } = await import("@/lib/scanned-bank-solve");
  const buf = await readFile(doc.storageKey);
  let items = pdfItems(buf);
  if (items.length === 0) {
    const { scanItemsForDocument } = await import("@/lib/ocr");
    items = await scanItemsForDocument(doc.id, buf);
  }
  return solveStatement(readRaw(items), { known: await knownAmounts(), confirmed });
}

function scannedLines(solved: Extract<SolvedStatement, { ok: true }>): BankLine[] {
  return solved.lines.map((l) => ({ on: l.on, description: l.description, amountCents: l.amountCents, key: lineKey(l.on, l.amountCents, l.description) }));
}

/** What the Money page shows for a scanned statement waiting on a person: the stretches the balances could not prove. */
export async function scannedStatementReview(documentId: string): Promise<{ fileName: string; unproven: Unproven[]; why: string | null } | null> {
  await requireManager();
  const doc = await db.query.documents.findFirst({ where: eq(schema.documents.id, documentId) });
  if (!doc || doc.category !== "bank_statement") return null;
  const solved = await solveScanned(doc, {});
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
  const solved = await solveScanned(doc!, confirmed);
  if (!solved.ok) redirect(`${back}&scan=${documentId}&error=${encodeURIComponent(solved.why)}`);
  if (solved.unproven.length > 0) {
    const u = solved.unproven[0];
    redirect(
      `${back}&scan=${documentId}&error=${encodeURIComponent(
        `With those figures, ${u.from}${u.to === u.from ? "" : ` to ${u.to}`} is still ${money(Math.abs(u.differenceCents))} ${u.differenceCents > 0 ? "short of" : "over"} the bank's balance. Nothing was placed.`,
      )}`,
    );
  }
  await placeStatementLines(scannedLines(solved), { documentId, fileName: doc!.fileName, skipped: 0, user, back, notes: solved.notes });
}

async function placeStatementLines(
  lines: BankLine[],
  o: { documentId: string | null; fileName: string; skipped: number; user: { id: string; name: string }; back: string; notes?: string[]; quiet?: boolean },
): Promise<string | never> {
  const { documentId, user, back } = o;
  /*
   * Two lines alike in date, amount and description are two lines. They shared one key, the key is unique, and the
   * second insert threw — aborting the read there and leaving the rest unplaced (Session 2, money map G-BANK-4). A
   * repeat within the statement is numbered; reading the same statement again numbers it the same way.
   */
  const seenKeys = new Map<string, number>();
  lines = lines.map((l) => {
    const n = (seenKeys.get(l.key) ?? 0) + 1;
    seenKeys.set(l.key, n);
    return n === 1 ? l : { ...l, key: `${l.key}#${n}` };
  });
  const parsed = { lines };
  const file = { name: o.fileName };

  /*
   * A line already on file is not read again. By its key, and also by its date and amount counted line for line: a
   * second scan of the same paper statement reads a description a character differently, gets a new key, and booked the
   * El Segundo postage bill a second time on a rehearsal (Session 2, money map G-POST-2) — as it would have banked any
   * deposit taken from the line. Two genuine lines of one date and amount are two: the count keeps both.
   */
  const heldKeys = new Set((await db.query.bankLines.findMany({ where: inArray(schema.bankLines.key, parsed.lines.map((l) => l.key)), columns: { key: true } })).map((r) => r.key));
  const onFile = new Map<string, number>();
  for (const r of await db.query.bankLines.findMany({ where: inArray(schema.bankLines.on, [...new Set(parsed.lines.map((l) => l.on))]), columns: { on: true, amountCents: true, key: true } })) {
    const k = `${r.on}|${r.amountCents}`;
    onFile.set(k, (onFile.get(k) ?? 0) + 1);
  }
  const held = new Set<string>();
  const fresh: BankLine[] = [];
  for (const l of parsed.lines) {
    const k = `${l.on}|${l.amountCents}`;
    if (heldKeys.has(l.key) || (onFile.get(k) ?? 0) > 0) {
      held.add(l.key + "|" + held.size);
      if (!heldKeys.has(l.key)) onFile.set(k, onFile.get(k)! - 1);
      else if ((onFile.get(k) ?? 0) > 0) onFile.set(k, onFile.get(k)! - 1);
      continue;
    }
    fresh.push(l);
  }
  const ctx = await matchContext([...new Set(fresh.map((l) => l.on.slice(0, 7)))]);
  const placed = placeLines(fresh, ctx);
  /* The pharmacy's own account number with each supplier, which is how two wholesalers of the same name are told apart. */
  const supplierAccounts = Object.fromEntries(ctx.suppliers.map((s) => [s.name, s.accountNumber ?? null]));

  /*
   * The receipts already banked for the statement's dates, so a deposit line confirms one instead of
   * banking the same money again. See `matchHeldDeposit`: before this, every deposit the payer payment
   * report or the Health Mart Atlas EFT notice had banked would have been banked a second time by the
   * first statement read — $250,562.16 of September's third-party receipts on the day it was found.
   */
  const days = fresh.map((l) => l.on).sort();
  /* A receipt an earlier statement already confirmed is not available to be confirmed again. */
  const confirmedAlready = new Set([
    ...(await db.query.bankLines.findMany({ columns: { receiptId: true } })).map((r) => r.receiptId).filter((id): id is string => id !== null),
    ...(await db.query.bankLineReceipts.findMany({ columns: { receiptId: true } })).map((r) => r.receiptId),
  ]);
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
    /* Every receipt this line confirms; the first goes in the column, all of them in bank_line_receipts. */
    const receiptIds: string[] = [];
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
          /*
           * A card deposit confirms only card takings, never another payer's receipt of the same amount (G-CARD-11).
           * Card takings are banked by the emailed batch report, or by the register's day where no batch was
           * forwarded (`register-card|`, register.ts) — the register banked every day of September 2026 and the
           * processor's deposits, two business days behind it, were refused as "no card batch report on file".
           */
          placement.kind === "card_deposit" ? heldForBank.filter((h) => h.sourceKey?.startsWith("card-batch|") || h.sourceKey?.startsWith("register-card|")) : heldForBank,
          { amountCents: line.amountCents, on: line.on, payer: placement.kind === "deposit" ? placement.payer : placement.kind === "card_deposit" ? "Card batch" : null },
          claimed,
        )
      : { kind: "none" as const };
    if (match.kind === "confirms") {
      claimed.add(match.receipt.id);
      receiptId = match.receipt.id;
      receiptIds.push(match.receipt.id);
      placedAs = "confirms_deposit";
      why = match.why;
      confirmed++;
      confirmedCents += line.amountCents;
    } else if (match.kind === "confirms_many") {
      /* Several receipts paid in as one deposit. The line keeps the first; `why` names them all. */
      for (const r of match.receipts) claimed.add(r.id);
      receiptId = match.receipts[0].id;
      receiptIds.push(...match.receipts.map((r) => r.id));
      placedAs = "confirms_deposit";
      why = match.why;
      confirmed++;
      confirmedCents += line.amountCents;
    } else if (match.kind === "ambiguous") {
      placedAs = "unplaced";
      why = match.why;
      unplaced++;
    } else if (placement.kind === "confirms_rebate") {
      claimed.add(placement.receiptId);
      receiptId = placement.receiptId;
      receiptIds.push(placement.receiptId);
      placedAs = "confirms_deposit";
      why = placement.why;
      confirmed++;
      confirmedCents += line.amountCents;
    } else if (placement.kind === "banks_remits") {
      /*
       * One receipt per remittance, under the remittance's own payment number and the 835 feed's own key shape, so
       * the payment report's copy of the same money is refused by the gate when it arrives (deposit-gate.ts).
       */
      for (const r of placement.remits) {
        const made = await addCashReceipt({
          month: line.on.slice(0, 7),
          kind: "third_party",
          amountCents: r.amountCents,
          payer: r.payer,
          notes: `From the bank statement line of ${line.on} (${line.description.replace(/\s+/g, " ").trim()}), tied to remittance ${r.remitNumber} of ${r.remitOn}.`,
          receivedOn: line.on,
          reference: r.paymentNumber ?? r.remitNumber,
          sourceKey: `835|${r.payer.trim().toLowerCase()}|${r.paymentNumber ?? r.remitNumber}|${r.remitOn}`,
          documentId,
          createdBy: user.id,
        });
        if (made.id && !receiptId) receiptId = made.id;
      }
      placedAs = "banks_remits";
      deposits++;
      depositCents += line.amountCents;
    } else if (placement.kind === "before_books") {
      placedAs = "before_books";
    } else if (placement.kind === "noted") {
      placedAs = "noted";
      why = `${placement.category}: ${placement.why}`;
    } else if (placement.kind === "facilitator_late") {
      /* The remittance already counts the payment; only the interest is new money. */
      placedAs = "already_counted";
      await addCashReceipt({ month: line.on.slice(0, 7), kind: "other", amountCents: placement.interestCents, payer: "Medicare Transaction Facilitator (interest)", notes: `Interest on the facilitator's remittance of ${placement.day} (${money(placement.remitCents)}), paid ${line.on}.`, receivedOn: line.on, sourceKey: `bank-mtf-interest|${line.key}`, documentId, createdBy: user.id });
    } else if (placement.kind === "confirms_run") {
      for (const id of placement.receiptIds) claimed.add(id);
      receiptId = placement.receiptIds[0];
      receiptIds.push(...placement.receiptIds);
      placedAs = "confirms_deposit";
      why = placement.why;
      confirmed++;
      confirmedCents += line.amountCents;
      /* The cents the counter and the register disagree by, booked so the cash account still equals the bank. */
      if (placement.overShortCents > 0) {
        await addCashReceipt({ month: line.on.slice(0, 7), kind: "other", amountCents: placement.overShortCents, payer: "Cash over", notes: `The counter deposit of ${line.on} was this much more than the register's days ${placement.from} to ${placement.to}.`, receivedOn: line.on, sourceKey: `bank-overshort|${line.key}`, documentId, createdBy: user.id });
      } else if (placement.overShortCents < 0) {
        await seedCategories();
        const category = (await categories(true)).find((c) => c.name === "Cash over and short");
        await saveExpense({ vendorId: null, categoryId: category?.id ?? null, invoiceNumber: `BANK|${line.key}|short`, invoiceDate: line.on, paidOn: line.on, amountCents: -placement.overShortCents, description: `Cash short: the counter deposit of ${line.on} against the register's days ${placement.from} to ${placement.to}`, notes: placement.why, documentId, status: "confirmed", source: "manual", createdBy: user.id });
      }
    } else if (placement.kind === "unplaced" && line.amountCents > 0 && /^deposit\b/i.test(line.description.trim()) && line.on <= shiftDays(SITE_STARTS_ON, OPENING_TAKINGS_DAYS)) {
      /* The counter paying in the last days of August, which the books never had. */
      placedAs = "before_books";
      why = `A counter deposit on ${line.on}: the drawers' cash and cheques from the days before the books began on ${SITE_STARTS_ON}. No register day was ever going to be on file for it; nothing is banked.`;
    } else if (placement.kind === "card_deposit" && line.on <= shiftDays(SITE_STARTS_ON, OPENING_TAKINGS_DAYS)) {
      /* The processor paying in the last days of August, which the books never had. */
      placedAs = "before_books";
      why = `Card takings paid in on ${line.on}, two business days behind the register — the days before the books began on ${SITE_STARTS_ON}. No receipt was ever going to be on file for them; nothing is banked.`;
    } else if (placement.kind === "books_bill") {
      /* A cost whose only record is this line. Keyed by the line, so a statement read twice books it once. */
      const key = `BANK|${line.key}`;
      const existing = await db.query.expenses.findFirst({ where: eq(schema.expenses.invoiceNumber, key), columns: { id: true } });
      if (existing) expenseId = existing.id;
      else {
        await seedCategories();
        const category = (await categories(true)).find((c) => c.name === placement.category);
        const vendor = (await vendors(true)).find((v) => v.name.toLowerCase().includes(placement.vendor.toLowerCase()));
        /* A fixed monthly payee with no vendor yet is made, so the bill files under a name and not under nobody. */
        const vendorId = vendor?.id ?? (await saveVendor({ name: placement.vendor, categoryId: category?.id ?? null, cadence: "monthly", notes: `Made from the bank statement on ${line.on}: ${placement.why}` }));
        expenseId = await saveExpense({ vendorId, categoryId: category?.id ?? null, invoiceNumber: key, invoiceDate: line.on, paidOn: line.on, amountCents: -line.amountCents, description: line.description, notes: placement.why, documentId, status: "confirmed", source: "manual", createdBy: user.id });
      }
      bills++;
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
    } else if (placement.kind === "pays_invoices") {
      /*
       * One debit settling several invoices, which is how every daily biller pays.
       *
       * Each invoice in the set is marked paid on the bank's date, exactly as the single-invoice
       * case does — the difference is only how many. The bank line keeps the FIRST of them in its
       * `invoice_id`, because the column holds one and the set is already named in `why`; losing
       * the rest from the line would be worse than holding one and saying so.
       *
       * Nothing is booked. These are wholesaler invoices already counted as cost of goods when they
       * were filed; this says when they were paid, which is the cash side and not a second cost.
       */
      for (const id of placement.invoiceIds) {
        await db.update(schema.supplierInvoices).set({ paidOn: line.on }).where(eq(schema.supplierInvoices.id, id));
      }
      invoiceId = placement.invoiceIds[0] ?? null;
      invoices += placement.invoiceIds.length;
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
      /*
       * A debit to a wholesaler with no payment on file, offered to the invoices' own due dates.
       *
       * Parmed takes one ACH for a fortnight of invoices, so no invoice equals the debit and this line could only ever
       * sit unplaced. The invoices print the day they are due (invoice-due-date.ts) and the bank prints the money, so
       * where the invoices due that day come to the debit exactly, `paymentFromBankDebit` writes the payment with its
       * allocations and this line confirms it. Where they do not, it writes nothing and says what it saw: the supplier's
       * own payment page settles it. A supplier whose ledger the site reads is refused there, because that ledger
       * already says what each ACH covered.
       */
      const meaning = placement.kind === "unplaced" && line.amountCents < 0 ? readBankDescriptor(line.description, line.amountCents, { supplierAccounts }) : null;
      const supplierPaid = meaning && (meaning.kind === "wholesaler_payment" || meaning.kind === "wholesaler_ach") ? meaning.counterparty : null;
      const made = supplierPaid
        ? await paymentFromBankDebit({ supplier: supplierPaid, on: line.on, amountCents: -line.amountCents, bankLineKey: line.key, reference: meaning?.matchTo?.reference ?? null }, { name: user.name, id: user.id })
        : null;
      if (made?.ok) {
        placedAs = "already_counted";
        why = made.says;
        invoices++;
      } else {
        if (placement.kind === "settles_ach" || placement.kind === "facilitator_unmatched" || placement.kind === "rebate_part") placedAs = "unplaced";
        if (made && !made.ok) why = `${why} ${made.why}.`;
        unplaced++;
      }
    }
    const lineId = newId();
    await db.insert(schema.bankLines).values({
      id: lineId,
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
    if (receiptIds.length) await db.insert(schema.bankLineReceipts).values(receiptIds.map((rid) => ({ lineId, receiptId: rid }))).onConflictDoNothing();
  }
  await audit({
    action: "bank.statement_read",
    userId: user.id,
    userName: user.name,
    entity: "document",
    entityId: documentId ?? undefined,
    details: `${file.name}: ${parsed.lines.length} lines, ${held.size} already held, ${deposits} deposits ${money(depositCents)}, ${confirmed} confirming deposits already banked ${money(confirmedCents)}, ${bills} bills and ${invoices} invoices marked paid, ${unplaced} not placed`,
  });
  const said =
    `${parsed.lines.length} lines read` +
    (held.size ? `, ${held.size} already held` : "") +
    `: ${deposits} deposit${deposits === 1 ? "" : "s"} banked (${money(depositCents)}), ${bills} bill${bills === 1 ? "" : "s"} and ${invoices} invoice${invoices === 1 ? "" : "s"} marked paid` +
    (unplaced ? `, ${unplaced} not placed — listed below the receipts` : "") +
    (o.skipped ? `; ${o.skipped} row${o.skipped === 1 ? "" : "s"} could not be read` : "") +
    (o.notes?.length ? ` Read from the scan and proved against its daily balances.` : "") +
    ".";
  /*
   * Called from a page, this ends in a redirect that carries the sentence. Called from the sweep or a
   * script there is no page to go to and no request to revalidate, so the sentence is returned instead —
   * `revalidatePath` outside a request throws, and `redirect` outside one is a thrown error nobody catches.
   */
  if (o.quiet) return said;
  for (const p of ["/money", "/money/monthly", "/expenses", "/inventory/invoices"]) revalidatePath(p);
  redirect(`${back}&ok=${encodeURIComponent(said)}`);
}

/**
 * A scanned statement solved and placed with no browser in the loop: for the sweep, and for a script.
 *
 * The same reading and the same placing the Money page does, as the named user, with the figures a
 * person has confirmed passed in by line index exactly as the page's form passes them. The one thing
 * it will not do is place a statement the balances cannot prove: an unproven stretch is returned as a
 * question, as the page would show it, and nothing is written.
 */
export async function storeScannedStatement(
  documentId: string,
  confirmed: Record<number, number>,
  user: { id: string; name: string },
): Promise<{ ok: true; said: string } | { ok: false; why: string; unproven: Unproven[] }> {
  const doc = await db.query.documents.findFirst({ where: eq(schema.documents.id, documentId) });
  if (!doc || doc.category !== "bank_statement") return { ok: false, why: "That document is not filed as a bank statement.", unproven: [] };
  const solved = await solveScanned(doc, confirmed);
  if (!solved.ok) return { ok: false, why: solved.why, unproven: [] };
  if (solved.unproven.length > 0) {
    const u = solved.unproven[0];
    return { ok: false, why: `${u.from}${u.to === u.from ? "" : ` to ${u.to}`} is ${money(Math.abs(u.differenceCents))} ${u.differenceCents > 0 ? "short of" : "over"} the bank's balance. Nothing was placed.`, unproven: solved.unproven };
  }
  const said = await placeStatementLines(scannedLines(solved), { documentId, fileName: doc.fileName, skipped: 0, user, back: "/money", notes: solved.notes, quiet: true });
  return { ok: true, said: said ?? "" };
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

/**
 * Places again the lines nothing could place, after the matcher has learned something.
 *
 * "Reader improves, nothing re-reads" is the fault that left eighty-nine of September 2026's lines "unmatched" while
 * the register, the remittances and the rebate receipt that explain them were on file. An unplaced line created
 * nothing — no receipt, no bill, no paid mark — so it can be dropped and read afresh with no trace; a line that was
 * placed is never touched here. Keyed the same way, so a line that still cannot be placed comes back as itself.
 */
export async function replaceUnplaced(months: string[], user: { id: string; name: string }): Promise<{ tried: number; said: string }> {
  const rows = (await db.query.bankLines.findMany({ where: eq(schema.bankLines.placedAs, "unplaced") })).filter((r) => months.includes(r.on.slice(0, 7)));
  if (rows.length === 0) return { tried: 0, said: "Nothing was unplaced." };
  const lines: BankLine[] = rows.map((r) => ({ on: r.on, description: r.description, amountCents: r.amountCents, key: r.key }));
  const documentId = rows.find((r) => r.documentId)?.documentId ?? null;
  await db.delete(schema.bankLines).where(inArray(schema.bankLines.id, rows.map((r) => r.id)));
  const said = await placeStatementLines(lines, { documentId, fileName: `re-placing ${months.join(", ")}`, skipped: 0, user, back: "/money", quiet: true });
  return { tried: rows.length, said };
}

/**
 * What a person says a line is — the one-press answer the register promised and the Money page never had.
 *
 * The owner, on the cheques: "the rest of the checks should allow me to categorize." A cheque carries no payee, so
 * the site can only ever name it from what repeats; the first time, he says. Three answers: it predates the books;
 * it is a cost, under a category and a payee, booked from the line; or it is money in from a named payer. Each is
 * recorded on the line in his words, and a cost becomes a bill keyed to the line so a statement read twice books it
 * once. A line already placed is refused: this is for the ones nothing could place.
 */
export async function decideBankLine(
  lineId: string,
  decision:
    | { kind: "before_books"; note: string }
    | { kind: "books_bill"; category: string; vendor: string; note: string }
    | { kind: "deposit"; payer: string; receiptKind: "third_party" | "patient" | "other"; note: string }
    /** Named and set aside: what it is, booked nowhere, so it stops asking. For a purchase whose own invoice is still to come. */
    | { kind: "noted"; category: string; note: string }
    /** The counter paying in the register's days from..to, with whatever the drawers and the bank disagree by booked as cash over and short. */
    | { kind: "confirms_run"; from: string; to: string; note: string },
  user: { id: string; name: string },
): Promise<{ ok: true; said: string } | { ok: false; why: string }> {
  const line = await db.query.bankLines.findFirst({ where: eq(schema.bankLines.id, lineId) });
  if (!line) return { ok: false, why: "No such bank line." };
  if (line.placedAs !== "unplaced") return { ok: false, why: `That line is already placed as ${line.placedAs}; undo that first.` };
  const by = `${user.name}, ${new Date().toISOString().slice(0, 10)}`;
  if (decision.kind === "before_books") {
    await db.update(schema.bankLines).set({ placedAs: "before_books", why: `${decision.note} (${by})` }).where(eq(schema.bankLines.id, lineId));
  } else if (decision.kind === "noted") {
    await db.update(schema.bankLines).set({ placedAs: "noted", why: `${decision.category}: ${decision.note} Nothing is booked from the line. (${by})` }).where(eq(schema.bankLines.id, lineId));
  } else if (decision.kind === "confirms_run") {
    if (line.amountCents <= 0) return { ok: false, why: "A payment is not a counter deposit." };
    const confirmedAlready = new Set((await db.query.bankLines.findMany({ columns: { receiptId: true } })).map((r) => r.receiptId).filter((id): id is string => id !== null));
    const run = (await db.query.cashReceipts.findMany({ where: and(like(schema.cashReceipts.sourceKey, "register|%"), gte(schema.cashReceipts.receivedOn, decision.from), lte(schema.cashReceipts.receivedOn, decision.to)) })).filter((r) => !confirmedAlready.has(r.id));
    if (run.length === 0) return { ok: false, why: `No unconfirmed register days between ${decision.from} and ${decision.to}.` };
    const sum = run.reduce((n, r) => n + r.amountCents, 0);
    const diff = line.amountCents - sum;
    if (diff > 0) {
      await addCashReceipt({ month: line.on.slice(0, 7), kind: "other", amountCents: diff, payer: "Cash over", notes: `The counter deposit of ${line.on} was ${money(diff)} more than the register's days ${decision.from} to ${decision.to}. ${decision.note} (${by})`, receivedOn: line.on, sourceKey: `bank-overshort|${line.key}`, documentId: line.documentId, createdBy: user.id });
    } else if (diff < 0) {
      await seedCategories();
      const category = (await categories(true)).find((c) => c.name === "Cash over and short");
      const key = `BANK|${line.key}|short`;
      const existing = await db.query.expenses.findFirst({ where: eq(schema.expenses.invoiceNumber, key), columns: { id: true } });
      if (!existing) await saveExpense({ vendorId: null, categoryId: category?.id ?? null, invoiceNumber: key, invoiceDate: line.on, paidOn: line.on, amountCents: -diff, description: `Cash short: the counter deposit of ${line.on} against the register's days ${decision.from} to ${decision.to}`, notes: `${decision.note} (${by})`, documentId: line.documentId, status: "confirmed", source: "manual", createdBy: user.id });
    }
    await db.insert(schema.bankLineReceipts).values(run.map((r) => ({ lineId, receiptId: r.id }))).onConflictDoNothing();
    await db.update(schema.bankLines).set({ placedAs: "confirms_deposit", receiptId: run[0].id, why: `The counter paying in the register's ${run.length} days ${decision.from} to ${decision.to} (${money(sum)})${diff === 0 ? ", to the cent." : `, ${money(Math.abs(diff))} ${diff > 0 ? "over" : "short"} — booked as cash over and short.`} ${decision.note} (${by})` }).where(eq(schema.bankLines.id, lineId));
  } else if (decision.kind === "books_bill") {
    if (line.amountCents >= 0) return { ok: false, why: "A deposit cannot be booked as a cost." };
    await seedCategories();
    const category = (await categories(true)).find((c) => c.name === decision.category);
    if (!category) return { ok: false, why: `No category named "${decision.category}".` };
    const vendor = (await vendors(true)).find((v) => v.name.toLowerCase() === decision.vendor.toLowerCase());
    const vendorId = vendor?.id ?? (await saveVendor({ name: decision.vendor, categoryId: category.id, notes: `Made from the bank statement on ${line.on}: ${decision.note}` }));
    const key = `BANK|${line.key}`;
    const existing = await db.query.expenses.findFirst({ where: eq(schema.expenses.invoiceNumber, key), columns: { id: true } });
    const expenseId = existing?.id ?? (await saveExpense({ vendorId, categoryId: category.id, invoiceNumber: key, invoiceDate: line.on, paidOn: line.on, amountCents: -line.amountCents, description: line.description, notes: `${decision.note} (${by})`, documentId: line.documentId, status: "confirmed", source: "manual", createdBy: user.id }));
    await db.update(schema.bankLines).set({ placedAs: "books_bill", expenseId, why: `${decision.note} Booked under ${decision.category}, payee ${decision.vendor} (${by}).` }).where(eq(schema.bankLines.id, lineId));
  } else {
    if (line.amountCents <= 0) return { ok: false, why: "A payment cannot be banked as a deposit." };
    const made = await addCashReceipt({ month: line.on.slice(0, 7), kind: decision.receiptKind, amountCents: line.amountCents, payer: decision.payer, notes: `${decision.note} From the bank statement: ${line.description} (${by})`, receivedOn: line.on, sourceKey: `bank-decided|${line.key}`, documentId: line.documentId, createdBy: user.id });
    if (!made.id) return { ok: false, why: made.duplicate ? made.why : "The receipt could not be banked." };
    await db.update(schema.bankLines).set({ placedAs: "deposit", receiptId: made.id, why: `${decision.note} Banked from ${decision.payer} (${by}).` }).where(eq(schema.bankLines.id, lineId));
  }
  await audit({ action: "bank.line_decided", userId: user.id, userName: user.name, entity: "bank_line", entityId: lineId, details: `${line.on} ${money(line.amountCents)} ${line.description.slice(0, 60)}: ${decision.kind} — ${decision.note}` });
  return { ok: true, said: `${line.on} ${money(line.amountCents)}: ${decision.kind.replace("_", " ")}.` };
}
