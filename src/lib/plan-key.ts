/**
 * The natural key of a plan, and which register row governs a claim.
 *
 * Kept apart from the register because the floor review must run with nothing behind it: this
 * file reaches no database and imports nothing that does.
 */
/**
 * A plan is BIN, PCN and group together.
 *
 * The BIN says which processor; the PCN says which processor and, almost always, which line of
 * business under it; the group says which employer or plan sponsor. On one day of this pharmacy's
 * claims three BIN-and-group pairs carried two PCNs each — a commercial contract and a Part D one
 * under the same BIN — and a key without the PCN classified them as one plan and read them as one
 * formula. Group alone never identifies a plan: group numbers repeat across processors.
 */
const norm = (v: string | null | undefined) => (v ?? "").trim().toUpperCase();
export const planKey = (bin: string | null, pcn: string | null, groupNumber: string | null) => `${norm(bin)}|${norm(pcn)}|${norm(groupNumber)}`;

/**
 * Which register row governs a claim.
 *
 * The row for the exact BIN, PCN and group first, where somebody has decided it. Then the row
 * with no PCN for that BIN and group — the register as it was kept before the PCN was known, so a
 * decision already made is not lost — and last the exact row even if still undecided, so the page
 * can show that it exists. Built once per set of rows, then asked per claim.
 */
export function planLookup<T extends { bin: string | null; pcn?: string | null; groupNumber: string | null; classification: string | null }>(rows: T[]): (c: { bin: string | null; pcn?: string | null; groupNumber: string | null }) => T | undefined {
  const exact = new Map<string, T>();
  const anyPcn = new Map<string, T>();
  for (const r of rows) {
    if (norm(r.pcn) === "") anyPcn.set(`${norm(r.bin)}|${norm(r.groupNumber)}`, r);
    else exact.set(planKey(r.bin, r.pcn ?? null, r.groupNumber), r);
  }
  return (c) => {
    const e = exact.get(planKey(c.bin, c.pcn ?? null, c.groupNumber));
    if (e && e.classification !== "unknown") return e;
    const a = anyPcn.get(`${norm(c.bin)}|${norm(c.groupNumber)}`);
    return a ?? e;
  };
}

