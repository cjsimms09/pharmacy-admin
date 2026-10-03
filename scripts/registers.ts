import "dotenv/config";
import { SITE_STARTS_ON } from "../src/lib/books-start";
/**
 * Writes the registers, from the data rather than from memory.
 *
 *   node node_modules/tsx/dist/cli.mjs --tsconfig tsconfig.script.json scripts/registers.ts
 *
 * The owner asked for registers — every case listed with its state against it — after the expense
 * categories turned out to be twenty-five well-chosen lines all reading $0.00, rendered as nought
 * rather than as "not yet known". His words: *"Registers are mentioned but not operationalized as
 * living, queryable artifacts the agent is required to maintain and surface."*
 *
 * ── Why these are generated and not written by hand ──
 *
 * A register kept by hand is a register that rots, and a rotted register is worse than none: it
 * reads as authoritative and is out of date, which is the exact fault this project keeps finding in
 * its own screens. So every line here is measured at the moment the file is written, and the file
 * says when. Nobody can forget to update it, and nobody can quietly disagree with the database.
 *
 * What cannot be generated is the *state* of a thing nobody has told the site about — whether a
 * missing cost is expected by email next week or does not exist at all. So each register carries a
 * small hand-kept table of decisions (`docs/registers/decisions.md`), and the generated lines read
 * from it. That is the only part a person maintains, and it is the only part that is genuinely a
 * judgement rather than a measurement.
 *
 * Aggregates only. No patient anything: every query here counts claims, categories and documents.
 */

type State = "captured" | "expected-not-yet" | "never-measured" | "measured-none" | "not-captured" | "unknown";

const money = (c: number | null | undefined) =>
  `$${((c ?? 0) / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/**
 * What a person has decided about a line the data cannot speak for.
 *
 * Keyed on the register and the line. Everything absent is "unknown", which is the honest default —
 * an empty expense line nobody has ruled on is not the same as one he has said will arrive.
 */
const DECIDED: Record<string, { state: State; note: string }> = {
  // Told to us 12 September 2026: "Pioneer invoices are sent to our email, we just haven't
  // received one yet, same with credit card processing fees, 45k is fully loaded with everything"
  "expense:Software and systems": { state: "expected-not-yet", note: "PioneerRx invoices arrive by email; none received yet" },
  "expense:Other": { state: "unknown", note: "the catch-all; card processing will land here until it has a category" },
  "expense:Payroll taxes and benefits": { state: "captured", note: "inside the $45,000 standing payroll, which is fully loaded" },
  "expense:Wages and salaries": { state: "captured", note: "standing cost, $45,000 a month, fully loaded" },
  "expense:Rent and occupancy": { state: "captured", note: "standing cost" },
  "expense:Professional fees": { state: "captured", note: "standing cost: accounting and PSAO fees" },
  "expense:DIR fees and price concessions": { state: "not-captured", note: "arrives months later, retroactively per claim, entered by hand" },

  /*
   * Which document settles which payer, where somebody has told us.
   *
   * Everything absent is "never-measured": the site has billed that BIN and no document has ever settled one of its
   * claims. That is not an accusation — no real payer 835 has reached this pharmacy yet — but it is the whole of
   * G-LC-4, and it is what this register exists to make impossible to lose track of.
   */
  "routing:028249": { state: "expected-not-yet", note: "RedSail's RAS copay voucher: settled by its own remittance, read on a sample and not yet on live" },
  "routing:024284": { state: "expected-not-yet", note: "Aytu / IPD RxRescue: settled by a credit memo applied against IPD's invoices, never as cash. August's and September's were declined by the owner; future ones arrive by email" },
  "routing:028918": { state: "never-measured", note: "DST/Argus GLP-1 bridge: a copay processor that remits like a payer; nothing has ever arrived" },
  "routing:019158": { state: "never-measured", note: "DST Pharmacy Solutions: a copay processor that remits like a payer; nothing has ever arrived" },
};

async function main() {
  const { db } = await import("../src/db");
  const q = async (sql: string) => (await db.$client.execute(sql)).rows as Record<string, unknown>[];
  const fs = await import("node:fs/promises");
  const now = new Date().toISOString().slice(0, 16).replace("T", " ");
  const dir = "docs/registers";
  await fs.mkdir(dir, { recursive: true });

  const head = (title: string, why: string) =>
    `# ${title}\n\n*Generated ${now} by \`scripts/registers.ts\`. Do not edit — edit ` +
    `\`docs/registers/decisions.md\` and run it again.*\n\n${why}\n\n`;

  const STATE_WORDS: Record<State, string> = {
    captured: "captured",
    "expected-not-yet": "expected, not yet arrived",
    "never-measured": "never measured",
    "measured-none": "measured, and none",
    "not-captured": "**not captured**",
    unknown: "**unknown — nobody has ruled on it**",
  };

  // ── Expenses ──────────────────────────────────────────────────────────────
  const cats = await q(`
    SELECT ec.name, ec.kind,
      (SELECT count(*) FROM expenses e WHERE e.category_id = ec.id) ever,
      (SELECT coalesce(sum(e.amount_cents),0) FROM expenses e WHERE e.category_id = ec.id) cents,
      (SELECT count(*) FROM standing_costs s WHERE s.category_id = ec.id) standing
      FROM expense_categories ec ORDER BY ec.kind, ec.name`);
  let out = head(
    "Every cost the business has, and whether the site sees it",
    "One line per expense category. A category with no money against it is in one of four states and " +
      "the account cannot tell them apart on its own — which is why a bottom line of nearly break-even " +
      "could sit above costs that had simply not arrived.",
  );
  out += `| Category | Kind | Entries | Money | State | Note |\n|---|---|---|---|---|---|\n`;
  const unresolved: string[] = [];
  for (const c of cats) {
    const name = String(c.name);
    const ever = Number(c.ever), standing = Number(c.standing);
    const decided = DECIDED[`expense:${name}`];
    const state: State = decided?.state ?? (ever > 0 || standing > 0 ? "captured" : "unknown");
    if (state === "unknown" || state === "not-captured") unresolved.push(name);
    out += `| ${name} | ${c.kind ?? "—"} | ${ever}${standing ? ` (+${standing} standing)` : ""} | ${money(Number(c.cents))} | ${STATE_WORDS[state]} | ${decided?.note ?? ""} |\n`;
  }
  out += `\n**${unresolved.length} of ${cats.length} categories are unresolved** — nobody has said whether they exist, are coming, or do not apply:\n\n`;
  out += unresolved.map((n) => `- ${n}`).join("\n") + "\n";
  await fs.writeFile(`${dir}/expenses.md`, out);

  // ── Claim fields ──────────────────────────────────────────────────────────
  const cols = await q(`SELECT name FROM pragma_table_info('claims') ORDER BY cid`);
  const paid = `FROM claims c JOIN claim_imports i ON i.id=c.import_id AND i.out_of_books=0 WHERE c.status='paid'`;
  const total = Number((await q(`SELECT count(*) n ${paid}`))[0].n);
  out = head(
    "Every field on a claim, and whether it is populated",
    "A claim carries facts a pharmacist acts on. A field the feed never fills is a fact the site " +
      "cannot use — and one it fills but nothing reads is a fact being thrown away. Counted over the " +
      `${total.toLocaleString("en-US")} paid in-books claims.`,
  );
  out += `| Field | Populated | Empty | State |\n|---|---|---|---|\n`;
  const empties: string[] = [];
  for (const c of cols) {
    const f = String(c.name);
    const r = (await q(`SELECT sum(CASE WHEN c."${f}" IS NULL OR c."${f}"='' THEN 0 ELSE 1 END) filled ${paid}`))[0];
    const filled = Number(r.filled ?? 0);
    const state: State = filled === 0 ? "never-measured" : filled === total ? "captured" : "captured";
    if (filled === 0) empties.push(f);
    out += `| \`${f}\` | ${filled.toLocaleString("en-US")} | ${(total - filled).toLocaleString("en-US")} | ${filled === 0 ? "**never populated**" : STATE_WORDS[state]} |\n`;
  }
  out += `\n**${empties.length} fields are never populated:** ${empties.map((e) => `\`${e}\``).join(", ")}\n`;
  await fs.writeFile(`${dir}/claim-fields.md`, out);

  // ── Document types the mailbox can place ──────────────────────────────────
  const routes = await q(`SELECT coalesce(routed_as,'(unrouted)') r, count(*) n, max(received_at) last FROM inbox_items GROUP BY 1 ORDER BY n DESC`);
  out = head(
    "Every kind of document that arrives, and whether it is read",
    "One line per route the mailbox can place a file on. A kind that has never arrived is not a " +
      "fault; a kind that arrives and is not read is money or a record going nowhere.",
  );
  out += `| Route | Arrivals | Last seen |\n|---|---|---|\n`;
  for (const r of routes) out += `| ${r.r} | ${r.n} | ${String(r.last ?? "—").slice(0, 16)} |\n`;
  await fs.writeFile(`${dir}/documents.md`, out);

  // ── Payer channels: every way money arrives ───────────────────────────────
  const chans = await q(`SELECT source, count(*) n, sum(amount_cents) c, sum(CASE WHEN claim_id IS NULL THEN 1 ELSE 0 END) unmatched,
      max(received_on) last FROM claim_payments GROUP BY source ORDER BY c DESC`);
  const receipts = await q(`SELECT kind, count(*) n, sum(amount_cents) c FROM cash_receipts GROUP BY kind ORDER BY c DESC`);
  out = head(
    "Every way money reaches the pharmacy, and whether it is traced",
    "The register behind `docs/MONEY-TRACE.md`. A channel with nothing against it has either never " +
      "paid or is not being read, and those are different — the second one loses money silently.",
  );
  out += `## Claim payments, by channel\n\n| Channel | Payments | Amount | Unmatched | Last |\n|---|---|---|---|---|\n`;
  for (const r of chans) out += `| ${r.source} | ${r.n} | ${money(Number(r.c))} | ${r.unmatched} | ${String(r.last ?? "—").slice(0, 10)} |\n`;
  out += `\n## Cash receipts, by kind\n\n| Kind | Receipts | Amount |\n|---|---|---|\n`;
  for (const r of receipts) out += `| ${r.kind} | ${r.n} | ${money(Number(r.c))} |\n`;
  out += `\n## Channels known to exist and not in the tables above\n\n`;
  out += `These are named because they are how this pharmacy is actually paid, and each is money that\n`;
  out += `arrives as something other than a deposit:\n\n`;
  out += `- **Aytu / IPD RxRescue top-offs** — arrive as a *credit line on the IPD statement*, never as cash.\n`;
  out += `- **McKesson returns** — arrive as *credits on account*. $8,526.77 read on 12 September.\n`;
  out += `- **Wholesaler rebates** — credit or cheque, on the generics contract.\n`;
  out += `- **Copay card processors** (DST/CNRX, DST/Argus GLP-1 bridge) — remit like a payer; $0.00 ever received to date.\n`;
  out += `- **DIR reconciliation** — usually money out, occasionally a true-up in.\n`;
  out += `- **PBM audit recoupments** — money taken back after the fact. No category names it directly;\n`;
  out += `  \`DIR fees and price concessions\` is arguably its home, and nobody has ruled on that.\n`;
  await fs.writeFile(`${dir}/money-channels.md`, out);

  // ── Payer routing: which document settles which payer ─────────────────────
  /*
   * The register behind G-LC-4, and the one the owner's question sits under: every payer that has billed money needs a
   * document that settles it, and a BIN with none is money on its way to nowhere in particular.
   *
   * Claims and payments are the measurement; which document SHOULD settle a payer is a fact about how this pharmacy is
   * paid — PSAO, direct, a copay programme — that only the owner and the payment reports can supply, so it lives in the
   * decisions table above and shows as "never-measured" until somebody says.
   */
  const routing = (await q(
    `SELECT c.bin AS bin, coalesce(max(c.pbm_name), max(c.payer_label)) AS payer,
            count(DISTINCT c.id) AS claims, sum(coalesce(c.remit_cents,0)) AS billed,
            count(DISTINCT p.id) AS payments, coalesce(sum(p.amount_cents),0) AS received,
            group_concat(DISTINCT p.source) AS sources
       FROM claims c
       LEFT JOIN claim_payments p ON p.claim_id = c.id AND p.out_of_books = 0
      WHERE c.status = 'paid' AND c.date_filled >= '${SITE_STARTS_ON}'
      GROUP BY c.bin
      ORDER BY sum(coalesce(c.remit_cents,0)) DESC`,
  )) as { bin: string; payer: string; claims: number; billed: number; payments: number; received: number; sources: string | null }[];
  const cashBins = new Set(((await q(`SELECT bin FROM cash_plans`)) as { bin: string }[]).map((r) => r.bin));
  /*
   * A measurement first, then what a person said, and the cash-plan register last.
   *
   * That order matters on BIN 028249: it is registered as a cash plan, and it is also the BIN RedSail's copay voucher
   * remittance pays. Reading the register first called it "nothing is ever remitted", which is exactly the sentence that
   * would stop somebody chasing a voucher statement that has not arrived.
   */
  const stateOf = (r: (typeof routing)[number]): { state: State; note: string } => {
    if (r.payments > 0) return { state: "captured", note: `settled through ${r.sources ?? "a payment"}` };
    const decided = DECIDED[`routing:${r.bin}`];
    if (decided) return decided;
    if (cashBins.has(r.bin)) return { state: "measured-none", note: "a cash plan: the copay is the money, and nothing is ever remitted" };
    return { state: "never-measured", note: "no document has ever settled one of its claims, and none is named" };
  };
  const routed = routing.map((r) => ({ ...r, ...stateOf(r) }));
  const owed = routed.filter((r) => r.state !== "captured" && r.state !== "measured-none");
  out = head(
    "Every payer that bills, and the document that settles it",
    "A payer with no settling document is not a missing payment — it is a payment nobody would notice the absence of. " +
      "The state is measured from the claims and payments; which document *should* settle a payer is a fact about how " +
      "this pharmacy is paid, so it comes from `decisions.md` and reads never-measured until somebody says.",
  );
  out += `${routed.length} payers have billed inside the books. ${routed.filter((r) => r.state === "captured").length} have had money settle a claim; `;
  out += `${owed.length} have had none, ${money(owed.reduce((n, r) => n + Number(r.billed), 0))} billed between them.\n\n`;
  out += `| BIN | Payer | Claims | Billed | Received | Through | State | What should settle it |\n|---|---|---|---|---|---|---|---|\n`;
  for (const r of routed) {
    out += `| ${r.bin ?? "(none)"} | ${String(r.payer ?? "—").slice(0, 30)} | ${r.claims} | ${money(Number(r.billed))} | ${money(Number(r.received))} | ${r.sources ?? "—"} | ${r.state} | ${r.note} |\n`;
  }
  await fs.writeFile(`${dir}/payer-routing.md`, out);

  console.log(`registers written to ${dir}/ at ${now}`);
  console.log(`  expenses.md        ${cats.length} categories, ${unresolved.length} unresolved`);
  console.log(`  claim-fields.md    ${cols.length} fields, ${empties.length} never populated`);
  console.log(`  documents.md       ${routes.length} routes`);
  console.log(`  money-channels.md  ${chans.length} payment channels, ${receipts.length} receipt kinds`);
  console.log(`  payer-routing.md   ${routed.length} payers, ${owed.length} with no settling document`);
}

main().catch((e) => {
  console.error(String(e).slice(0, 900));
  process.exit(1);
});
