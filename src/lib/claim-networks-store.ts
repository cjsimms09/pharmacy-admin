import "server-only";
import { db } from "@/db";
import { sql } from "drizzle-orm";
import { candidatesFor, contractFor, type ContractForMatch } from "./claim-contract";
import { allPayerLinks } from "./payer-links";

/**
 * The network ids the claims carry, and which of them still have no contract behind them.
 *
 * Nought of 1,081 insured claims matched a contract. The cause was structural: claims speak in
 * codes and rate exhibits identify themselves by network name and chain code. Across the first 86
 * documents read, 63 carry network names, 39 carry chain codes, 5 carry BINs and **none** carries a
 * network reimbursement id — so no amount of further reading closes it. One person who knows the
 * pharmacy's contracts has to say, once per network id, which agreement priced it. There are 82
 * ids. This is the list that makes those 82 choices possible, ordered so the largest is first,
 * because the id behind a third of the money is worth settling before the one behind two fills.
 *
 * Reading only. Everything that decides anything is pure and lives in `claim-contract.ts`.
 */

export type NetworkToLink = {
  networkId: string;
  claims: number;
  /** What the plans paid on those claims, so the list is ordered by what it is worth settling. */
  remitCents: number;
  /** Who the BIN resolves to, where the site knows. The strongest hint the owner gets. */
  payerName: string | null;
  bins: string[];
  /** Already tied to a document, and to which. */
  linkedTo: { documentId: string; documentName: string } | null;
  candidates: { documentId: string; documentName: string; counterparty: string | null; networkNames: string[]; hasRates: boolean; why: string }[];
};

/** The contracts, in the shape the matcher wants, with the names the owner recognises them by. */
async function contractsForLinking(): Promise<(ContractForMatch & { networkNames: string[]; governsHere: boolean | null; hasRates: boolean })[]> {
  const { parseTerms } = await import("./contract-extract");
  const { governsPharmacy } = await import("./contract-apply");
  const { getSettings } = await import("./settings");
  const st = await getSettings();
  const pharmacy = { chainCode: st.pharmacy_chain_code || null, ncpdp: st.pharmacy_ncpdp || null, npi: st.pharmacy_npi || null };
  const docs = await db.query.contractDocs.findMany();
  const out: (ContractForMatch & { networkNames: string[]; governsHere: boolean | null; hasRates: boolean })[] = [];
  for (const d of docs) {
    if (d.extractionState !== "done") continue;
    const terms = parseTerms(d.extractionJson);
    if (!terms) continue;
    const g = governsPharmacy(terms, pharmacy);
    // Only a document that names a chain code or an NCPDP can be said to be written for this pharmacy; silence is null, not yes.
    const governsHere = terms.chainCodes.length === 0 && terms.pharmacyNcpdps.length === 0 ? null : g.ok;
    out.push({
      governsHere,
      hasRates: (terms.rates ?? []).some((r) => r.brandFormula || r.genericBasis || r.brandDispensingFee != null || r.genericDispensingFee != null),
      documentId: d.id,
      documentName: d.documentName,
      counterparty: terms.counterparty ?? d.pbmName,
      bins: terms.bins ?? [],
      pcns: terms.pcns ?? [],
      groupIds: terms.groupIds ?? [],
      networkReimbursementIds: terms.networkReimbursementIds ?? [],
      networkNames: terms.networkNames ?? [],
      effectiveDate: terms.effectiveDate,
      endDate: terms.endDate,
      rates: [],
    });
  }
  return out;
}

/**
 * Every network id on the claims, with what it is worth and what could price it.
 *
 * The counts come from one grouped query rather than from reading claims into memory: every libsql
 * call blocks the event loop completely, and this page is opened while somebody is dispensing.
 */
export async function networksToLink(): Promise<NetworkToLink[]> {
  const rows = await db.all<{ network_id: string; claims: number; remit_cents: number; bins: string | null; pbm: string | null }>(sql`
    select network_id,
           count(*)                              as claims,
           coalesce(sum(remit_cents), 0)         as remit_cents,
           group_concat(distinct bin)            as bins,
           max(pbm_name)                         as pbm
    from claims
    where network_id is not null and trim(network_id) <> ''
      and (status is null or status <> 'reversed')
    group by network_id
    order by remit_cents desc, claims desc
  `);

  const links = await allPayerLinks();
  const contracts = await contractsForLinking();
  // The BIN listing's other names for a payer: the PBM behind a plan's own name, as the owner states it there.
  const binRows = await db.query.payerBins.findMany({ columns: { bin: true, pbmName: true, aliases: true } });
  const aliasesByBin = new Map<string, string[]>();
  for (const b of binRows) {
    const names = [b.pbmName, ...(b.aliases ?? "").split(/[\n,;]+/)].map((x) => (x ?? "").trim()).filter(Boolean);
    aliasesByBin.set(b.bin.trim().toUpperCase(), names);
  }
  const nameOf = new Map(contracts.map((c) => [c.documentId, c.documentName]));

  /*
   * Learned from the claims themselves — the owner's own idea, 8 September: "If we have bin and
   * group and network id, and we can match bin and group, can't we also then match network id and
   * contract?" A contract that prints its BINs, PCNs and groups governs the claims that carry
   * them; those claims also carry a network id; so the id is that contract's, and every other
   * claim on the same id — different BIN or group, same network — follows. No document prints the
   * id, so this is offered as the top candidate with the count behind it, and the owner links.
   */
  const triples = await db.all<{ network_id: string; bin: string | null; pcn: string | null; group_number: string | null; date_filled: string; n: number }>(sql`
    select network_id, bin, pcn, group_number, max(date_filled) as date_filled, count(*) as n
    from claims
    where network_id is not null and trim(network_id) <> ''
      and (status is null or status <> 'reversed')
    group by network_id, bin, pcn, group_number
  `);
  const learned = new Map<string, Map<string, number>>();
  for (const t of triples) {
    const hit = contractFor(
      { bin: t.bin, pcn: t.pcn, groupNumber: t.group_number, networkId: t.network_id, dateFilled: t.date_filled, daysSupply: null, remitCents: null, awpCents: null, acquisitionCents: null, isBrand: null },
      contracts,
    );
    if (!hit) continue;
    const key = t.network_id.trim().toUpperCase();
    const by = learned.get(key) ?? new Map<string, number>();
    by.set(hit.contract.documentId, (by.get(hit.contract.documentId) ?? 0) + Number(t.n));
    learned.set(key, by);
  }

  // Who a BIN resolves to, from the links already settled — the strongest hint available.
  const payerByBin = new Map<string, string>();
  for (const l of links) if (l.bin && l.pbmName) payerByBin.set(l.bin.trim().toUpperCase(), l.pbmName);

  return rows.map((r) => {
    const networkId = r.network_id.trim();
    const bins = (r.bins ?? "").split(",").map((b) => b.trim()).filter(Boolean);
    /*
     * The settled link first; else the PBM the claims report itself names on the claim. The report
     * names one on 1,302 of 1,304 paid claims, and until 8 September it was ignored here, so every
     * network was offered all 177 read contracts with nothing to rank them. It is a hint, not a
     * finding: the ranking says "is who this network's BIN resolves to", and the owner still links.
     */
    const payerName = bins.map((b) => payerByBin.get(b.toUpperCase())).find(Boolean) ?? (r.pbm ? r.pbm.trim() || null : null);
    const link = links.find((l) => (l.contractId ?? "").trim().toUpperCase() === networkId.toUpperCase() && (l.contractDocId || /^Programme:/.test(l.basis ?? "")));
    /*
     * A settled id is one tied to a document — or one the owner has said is a programme, not a network:
     * "these are loyalty/discount cards.. isn't a formula on loyalty or discount cards" (8 September). A
     * programme has no rate to link to; its money is reconciled as a payment on the claim (BACKLOG 24).
     */
    const programme = link && !link.contractDocId && /^Programme:/.test(link.basis ?? "") ? link.basis! : null;
    const linkedTo = link?.contractDocId
      ? { documentId: link.contractDocId, documentName: nameOf.get(link.contractDocId) ?? "a document no longer on file" }
      : programme
        ? { documentId: "", documentName: programme }
        : null;
    return {
      networkId,
      claims: Number(r.claims),
      remitCents: Number(r.remit_cents),
      payerName,
      bins,
      linkedTo,
      candidates: linkedTo
        ? []
        : withLearned(
            networkId,
            Number(r.claims),
            learned.get(networkId.toUpperCase()) ?? null,
            candidatesFor({ networkId, payerName, payerAliases: bins.flatMap((b) => aliasesByBin.get(b.toUpperCase()) ?? []), contracts }),
            contracts,
          ),
    };
  });
}

/** The contracts the network's own claims matched by BIN and group go first, with the count; the rest follow. */
function withLearned(
  networkId: string,
  claims: number,
  learned: Map<string, number> | null,
  ranked: NetworkToLink["candidates"],
  contracts: (ContractForMatch & { networkNames: string[]; hasRates?: boolean })[],
): NetworkToLink["candidates"] {
  if (!learned || learned.size === 0) return ranked;
  const first = [...learned.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([documentId, n]) => {
      const c = contracts.find((x) => x.documentId === documentId);
      return {
        documentId,
        documentName: c?.documentName ?? "a document no longer on file",
        counterparty: c?.counterparty ?? null,
        networkNames: c?.networkNames ?? [],
        hasRates: c?.hasRates === true,
        why: `${n} of this network's ${claims} claims match it by BIN and group on the contract's own listing — the strongest sign short of the id printed on a document`,
      };
    });
  // A document that prints the id itself outranks what the claims learned: the guide's crosswalk is the one place the id is written down.
  const printed = ranked.filter((c) => /as one of its network reimbursement ids/.test(c.why));
  const seen = new Set([...printed, ...first].map((c) => c.documentId));
  return [...printed, ...first.filter((c) => !printed.some((p) => p.documentId === c.documentId)), ...ranked.filter((c) => !seen.has(c.documentId))];
}

/**
 * Links a network on its own where the documents leave one answer, and says so.
 *
 * The owner, 8 September: "Why do I have to do clicks per network??" He does not, where the paper
 * decides. Two cases decide: a document that prints the network reimbursement id itself; and a
 * payer with exactly one document written for this pharmacy's chain code. A payer with several
 * such documents is not decided here — that is what the PSAO's listing and the backtest are for —
 * and the page still shows the ranking. Every link made here names its reason on the link, and
 * the owner can replace it.
 */
export async function deduceNetworkLinks(user: { name: string }): Promise<{ linked: { networkId: string; documentName: string; why: string; claims: number }[]; undecided: number }> {
  const { savePayerLink } = await import("./payer-links");
  const rows = await networksToLink();
  const linked: { networkId: string; documentName: string; why: string; claims: number }[] = [];
  let undecided = 0;
  for (const r of rows) {
    if (r.linkedTo) continue;
    const top = r.candidates[0];
    if (!top) {
      undecided++;
      continue;
    }
    const prints = /prints .* as one of its network reimbursement ids/.test(top.why);
    const here = r.candidates.filter((c) => /written for this pharmacy's chain code/.test(c.why));
    // Every one of the network's claims matched this document by its own BIN, PCN and group listing: the
    // guide prints the routing where it does not print the id (Optum's crosswalk is keyed that way).
    const learnedAll = /^(\d+) of this network's (\d+) claims match it by BIN and group/.exec(top.why);
    const allMatch = learnedAll !== null && learnedAll[1] === learnedAll[2];
    // The payer the claims name has exactly one document on file that carries rates: SmithRx, Drexi,
    // Rightway — one commercial rate each in the PSAO's guide and nothing else in the folder. The owner,
    // 8 September: "so this should be the SmithRx rate?? this should be done?" It is.
    const priced = r.candidates.filter((c) => c.hasRates && /is who this network's BIN resolves to/.test(c.why));
    const onlyPriced = priced.length === 1 ? priced[0] : null;
    const decided = prints ? top : allMatch ? top : here.length === 1 ? here[0] : onlyPriced;
    if (!decided) {
      undecided++;
      continue;
    }
    const why = prints
      ? `Linked by the site: ${decided.documentName} prints ${r.networkId} as one of its network reimbursement ids.`
      : allMatch
        ? `Linked by the site: every one of this network's ${r.claims} claims matches ${decided.documentName} by the BIN, PCN and group it lists. Replace it if the PSAO's listing says otherwise.`
        : here.length === 0 && onlyPriced
          ? `Linked by the site: the only ${decided.counterparty ?? r.payerName ?? "payer"} document on file that carries rates. Replace it if another document for this payer is loaded.`
      : `Linked by the site: the only ${decided.counterparty ?? r.payerName ?? "payer"} document written for this pharmacy's chain code. Replace it if the PSAO's listing says otherwise.`;
    await savePayerLink(
      { bin: null, pcn: null, groupNumber: null, contractId: r.networkId },
      { pbmName: decided.counterparty ?? r.payerName ?? "unknown", contractDocId: decided.documentId, contractFileName: decided.documentName, basis: why },
      user,
    );
    linked.push({ networkId: r.networkId, documentName: decided.documentName, why, claims: r.claims });
  }
  return { linked, undecided };
}
