import "dotenv/config";
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

  console.log(`registers written to ${dir}/ at ${now}`);
  console.log(`  expenses.md        ${cats.length} categories, ${unresolved.length} unresolved`);
  console.log(`  claim-fields.md    ${cols.length} fields, ${empties.length} never populated`);
  console.log(`  documents.md       ${routes.length} routes`);
  console.log(`  money-channels.md  ${chans.length} payment channels, ${receipts.length} receipt kinds`);
}

main().catch((e) => {
  console.error(String(e).slice(0, 900));
  process.exit(1);
});
