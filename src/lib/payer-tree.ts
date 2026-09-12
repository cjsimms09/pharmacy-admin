/**
 * The payer hierarchy: who we contract with, how their claims are routed, and which terms govern each.
 *
 *   Payer                     CVS Caremark — the organisation the contract is with
 *    └─ BIN                   004336, 610591 — a processor's routing number; a payer has many
 *        └─ PCN               ADV, MEDD — the line of business inside that BIN
 *            └─ Group         RX1234 — the employer or plan sponsor
 *                └─ Contract  attaches at whichever level it was negotiated for
 *                    └─ Claim carries BIN + PCN + Group, and resolves up the tree
 *
 * ── The one place it is not a tree ──
 *
 * A BIN is not owned exclusively by a payer. The same routing number can appear under two of them,
 * which is why `payer_bins` carries a `collides` flag whose note reads "never resolve on BIN alone".
 * So the leaf is not the BIN — it is the plan key, BIN + PCN + Group, and that is what resolves to
 * a payer. Everything above the leaf is a convenience for reading; everything that decides money
 * hangs off the leaf.
 *
 * ── Where a contract attaches ──
 *
 * At whichever level it names. A network agreement naming three BINs governs every group on them;
 * an employer addendum naming one group governs that group only, and beats the network agreement it
 * sits inside. That is why matching is by specificity rather than by walking down from the payer:
 * the contract that names the most of the triple is the one negotiated for this plan.
 *
 * ── Two joins, not one ──
 *
 * This hierarchy answers "what were we owed". It does not answer "what arrived", because a
 * remittance does not carry BIN, PCN or group — an 835 identifies a payment by the pharmacy's own
 * prescription reference, which is what `splitReference` in x12-835.ts reads. The two meet at the
 * payer and nowhere below it:
 *
 *   what we were owed   BIN + PCN + Group + the fill date  ->  the contract
 *   what arrived        Rx number + fill number            ->  the claim
 *
 * Keeping them separate is the point. Trying to match a remittance on the routing triple finds
 * nothing, and trying to price a contract off a remittance reference finds the wrong terms.
 */

export type PlanKey = { bin: string | null; pcn: string | null; groupNumber: string | null };

export type PlanNode = {
  key: PlanKey;
  /** How it is labelled on the claims themselves. */
  payerLabel: string | null;
  sponsorName: string | null;
  classification: string;
  claims: number;
  remitCents: number;
  /** The contract that governs this plan, where one does. */
  contract: { documentName: string; counterparty: string | null; matchedOn: string } | null;
};

export type BinNode = {
  bin: string;
  /** True where this BIN appears under more than one payer, so it never resolves on its own. */
  shared: boolean;
  plans: PlanNode[];
  claims: number;
  remitCents: number;
};

export type PayerNode = {
  payer: string;
  bins: BinNode[];
  claims: number;
  remitCents: number;
  /** Plans under this payer with no contract governing them: the gap worth closing. */
  plansWithoutContract: number;
  contracts: { documentName: string; attachesTo: string }[];
};

const norm = (s: string | null | undefined) => {
  const t = (s ?? "").trim().toUpperCase();
  return t === "" ? null : t;
};

/** How a contract's reach reads, for a person deciding whether it is attached at the right level. */
export function describeReach(c: { bins: string[]; pcns: string[]; groupIds: string[] }): string {
  const bits: string[] = [];
  if (c.bins.length) bits.push(`${c.bins.length} BIN${c.bins.length === 1 ? "" : "s"}`);
  if (c.pcns.length) bits.push(`${c.pcns.length} PCN${c.pcns.length === 1 ? "" : "s"}`);
  if (c.groupIds.length) bits.push(`${c.groupIds.length} group${c.groupIds.length === 1 ? "" : "s"}`);
  if (bits.length === 0) return "nothing routable — it names no BIN, PCN or group, so no claim can be matched to it";
  return bits.join(", ");
}

/**
 * Assembles the tree from the plans the claims have actually used.
 *
 * Built from the claims rather than from the register, because the register is what somebody has
 * got round to describing and the claims are what the pharmacy was actually paid on. A plan the
 * claims use and the register has never heard of is exactly the row worth seeing.
 */
export function buildPayerTree(a: {
  claims: { bin: string | null; pcn: string | null; groupNumber: string | null; pbmName: string | null; payerLabel: string | null; remitCents: number | null }[];
  register: { bin: string | null; pcn: string | null; groupNumber: string | null; pbmName: string | null; sponsorName: string | null; classification: string }[];
  bins: { bin: string; pbmName: string; collides: boolean }[];
  /** For each plan key, the contract that governs it, already decided by specificity. */
  contractFor: (key: PlanKey) => { documentName: string; counterparty: string | null; matchedOn: string } | null;
  contracts: { documentName: string; counterparty: string | null; bins: string[]; pcns: string[]; groupIds: string[] }[];
}): PayerNode[] {
  const keyOf = (k: PlanKey) => `${norm(k.bin) ?? ""}|${norm(k.pcn) ?? ""}|${norm(k.groupNumber) ?? ""}`;

  const registerBy = new Map<string, (typeof a.register)[number]>();
  for (const r of a.register) registerBy.set(keyOf(r), r);
  const binOwner = new Map<string, { pbmName: string; collides: boolean }>();
  for (const b of a.bins) binOwner.set(norm(b.bin) ?? "", { pbmName: b.pbmName, collides: b.collides });

  // One row per plan the claims actually used.
  const plans = new Map<string, PlanNode & { payer: string; bin: string }>();
  for (const c of a.claims) {
    const key: PlanKey = { bin: c.bin, pcn: c.pcn, groupNumber: c.groupNumber };
    const k = keyOf(key);
    const reg = registerBy.get(k);
    const bin = norm(c.bin) ?? "(no BIN)";
    /*
     * Whose plan this is, in the order the answers can be trusted.
     *
     * What the claim itself resolved to first, then the BIN register, then the label the claim was
     * written with. A plan nobody has identified is grouped under that label rather than being
     * dropped: the pharmacy was paid on it either way, and it is the row most worth chasing.
     */
    const payer = c.pbmName ?? reg?.pbmName ?? binOwner.get(bin)?.pbmName ?? c.payerLabel ?? "Not identified";
    let node = plans.get(k);
    if (!node) {
      node = {
        key,
        payerLabel: c.payerLabel,
        sponsorName: reg?.sponsorName ?? null,
        classification: reg?.classification ?? "unknown",
        claims: 0,
        remitCents: 0,
        contract: a.contractFor(key),
        payer,
        bin,
      };
      plans.set(k, node);
    }
    node.claims++;
    node.remitCents += c.remitCents ?? 0;
  }

  const byPayer = new Map<string, PayerNode>();
  for (const p of plans.values()) {
    let payerNode = byPayer.get(p.payer);
    if (!payerNode) {
      payerNode = { payer: p.payer, bins: [], claims: 0, remitCents: 0, plansWithoutContract: 0, contracts: [] };
      byPayer.set(p.payer, payerNode);
    }
    let binNode = payerNode.bins.find((b) => b.bin === p.bin);
    if (!binNode) {
      binNode = { bin: p.bin, shared: binOwner.get(p.bin)?.collides ?? false, plans: [], claims: 0, remitCents: 0 };
      payerNode.bins.push(binNode);
    }
    const { payer: _p, bin: _b, ...plan } = p;
    binNode.plans.push(plan);
    binNode.claims += p.claims;
    binNode.remitCents += p.remitCents;
    payerNode.claims += p.claims;
    payerNode.remitCents += p.remitCents;
    if (!p.contract) payerNode.plansWithoutContract++;
  }

  // Contracts hang under the payer they name, so a contract read but attached to nothing is visible.
  for (const c of a.contracts) {
    const payer = c.counterparty ?? "Not identified";
    const node = byPayer.get(payer) ?? { payer, bins: [], claims: 0, remitCents: 0, plansWithoutContract: 0, contracts: [] };
    node.contracts.push({ documentName: c.documentName, attachesTo: describeReach(c) });
    byPayer.set(payer, node);
  }

  for (const p of byPayer.values()) {
    p.bins.sort((x, y) => y.remitCents - x.remitCents);
    for (const b of p.bins) b.plans.sort((x, y) => y.remitCents - x.remitCents);
  }
  return [...byPayer.values()].sort((a2, b2) => b2.remitCents - a2.remitCents);
}
