import "server-only";
import { db } from "@/db";
import { sql } from "drizzle-orm";
import { candidatesFor, type ContractForMatch } from "./claim-contract";
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
  candidates: { documentId: string; documentName: string; counterparty: string | null; networkNames: string[]; why: string }[];
};

/** The contracts, in the shape the matcher wants, with the names the owner recognises them by. */
async function contractsForLinking(): Promise<(ContractForMatch & { networkNames: string[] })[]> {
  const { parseTerms } = await import("./contract-extract");
  const docs = await db.query.contractDocs.findMany();
  const out: (ContractForMatch & { networkNames: string[] })[] = [];
  for (const d of docs) {
    if (d.extractionState !== "done") continue;
    const terms = parseTerms(d.extractionJson);
    if (!terms) continue;
    out.push({
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
  const rows = await db.all<{ network_id: string; claims: number; remit_cents: number; bins: string | null }>(sql`
    select network_id,
           count(*)                              as claims,
           coalesce(sum(remit_cents), 0)         as remit_cents,
           group_concat(distinct bin)            as bins
    from claims
    where network_id is not null and trim(network_id) <> ''
      and (status is null or status <> 'reversed')
    group by network_id
    order by remit_cents desc, claims desc
  `);

  const links = await allPayerLinks();
  const contracts = await contractsForLinking();
  const nameOf = new Map(contracts.map((c) => [c.documentId, c.documentName]));

  // Who a BIN resolves to, from the links already settled — the strongest hint available.
  const payerByBin = new Map<string, string>();
  for (const l of links) if (l.bin && l.pbmName) payerByBin.set(l.bin.trim().toUpperCase(), l.pbmName);

  return rows.map((r) => {
    const networkId = r.network_id.trim();
    const bins = (r.bins ?? "").split(",").map((b) => b.trim()).filter(Boolean);
    const payerName = bins.map((b) => payerByBin.get(b.toUpperCase())).find(Boolean) ?? null;
    const link = links.find((l) => (l.contractId ?? "").trim().toUpperCase() === networkId.toUpperCase() && l.contractDocId);
    const linkedTo = link?.contractDocId
      ? { documentId: link.contractDocId, documentName: nameOf.get(link.contractDocId) ?? "a document no longer on file" }
      : null;
    return {
      networkId,
      claims: Number(r.claims),
      remitCents: Number(r.remit_cents),
      payerName,
      bins,
      linkedTo,
      candidates: linkedTo ? [] : candidatesFor({ networkId, payerName, contracts }),
    };
  });
}
