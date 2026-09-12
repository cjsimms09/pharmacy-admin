import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { requireManager } from "@/lib/auth";
import { requireReimbursement } from "@/lib/features";
import { familyTabs } from "@/lib/families";
import { networksToLink } from "@/lib/claim-networks-store";
import { savePayerLink } from "@/lib/payer-links";
import { audit } from "@/lib/audit";
import { PageHeader, Card, Notice, Empty, Figure } from "@/components/ui";
import { SubmitButton } from "@/components/submit-button";

export const dynamic = "force-dynamic";
export const metadata = { title: "Networks to contracts" };

const money = (cents: number) => `$${(cents / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/**
 * Tying each network the claims arrive on to the contract that priced it.
 *
 * Nought of 1,081 insured claims matched a contract, and no amount of further reading would have
 * fixed it. Claims speak in codes — PioneerRx's network id is on 95.3% of them, across 82 distinct
 * values. Rate exhibits identify themselves by network name and chain code: of the first 86
 * documents read, 63 carry a network name, 39 a chain code, 5 a BIN and **none** a network
 * reimbursement id. Neither side carries the other's key, so nothing computed can join them.
 *
 * What can join them is one person who knows the pharmacy's contracts, once per network id. That is
 * 82 choices, made once, after which every claim on that network prices itself and the whole
 * reimbursement side of the site starts working. This page exists to make each of those choices one
 * click: the id, what it is worth, who its BIN resolves to, and the documents worth considering
 * with the network names the owner would recognise them by.
 *
 * Ordered by money, because the id behind a third of the remittances is worth settling before the
 * one behind two fills — and because nobody finishes a list of 82 in one sitting.
 */
export default async function NetworksPage({ searchParams }: { searchParams: Promise<{ ok?: string; error?: string }> }) {
  await requireReimbursement();
  await requireManager();
  const [rows, notice] = await Promise.all([networksToLink(), searchParams]);

  const unlinked = rows.filter((r) => !r.linkedTo);
  const linked = rows.filter((r) => r.linkedTo);
  const unlinkedCents = unlinked.reduce((n, r) => n + r.remitCents, 0);
  const allCents = rows.reduce((n, r) => n + r.remitCents, 0);

  async function link(fd: FormData) {
    "use server";
    const u = await requireManager();
    const networkId = String(fd.get("networkId") ?? "").trim();
    const documentId = String(fd.get("documentId") ?? "").trim();
    const pbmName = String(fd.get("pbmName") ?? "").trim() || networkId;
    if (!networkId || !documentId) {
      redirect("/payers/networks?error=" + encodeURIComponent("Choose a contract before saving."));
    }
    /*
     * The document's name is read back from the document, not carried in a hidden field.
     *
     * A name posted by the browser is a name the browser could have been wrong about, and this one
     * goes into the audit line and into the reason the link exists. Reading it here also proves the
     * document is still on file before anything is tied to it.
     */
    const { db } = await import("@/db");
    const { eq } = await import("drizzle-orm");
    const { schema } = await import("@/db");
    const doc = await db.query.contractDocs.findFirst({ where: eq(schema.contractDocs.id, documentId) });
    if (!doc) {
      redirect("/payers/networks?error=" + encodeURIComponent("That contract is no longer on file. Reload the page and choose again."));
    }
    const documentName = doc.documentName;
    /*
     * Written as a link on the network id alone, with no BIN, PCN or group.
     *
     * The id is what the claim carries and what the owner is answering about. Narrowing the link
     * with a BIN would make it stop matching the moment a plan moved processors, which is the
     * failure this page exists to end rather than repeat.
     */
    await savePayerLink(
      { bin: null, pcn: null, groupNumber: null, contractId: networkId },
      { pbmName, contractDocId: documentId, basis: `Tied to ${documentName} on the networks page` },
      u,
    );
    await audit({ action: "payer_link.network_tied", userId: u.id, userName: u.name, details: `${networkId} → ${documentName}` });
    revalidatePath("/payers/networks");
    redirect("/payers/networks?ok=" + encodeURIComponent(`${networkId} is now priced under ${documentName}. Every claim on that network follows.`));
  }

  return (
    <>
      <PageHeader
        title="Networks to contracts"
        subtitle="Each network the claims arrive on, tied once to the agreement that priced it. Nothing else can join the two."
        tabs={familyTabs("payers", "/payers/networks")}
      />
      {notice.ok ? <Notice kind="ok">{notice.ok}</Notice> : null}
      {notice.error ? <Notice kind="crit">{notice.error}</Notice> : null}

      <Card
        className="mb-6"
        title="Why this has to be answered by a person"
        subtitle="It is not a reading problem, and no further document will settle it."
      >
        <p className="text-sm text-ink-2">
          A claim says which network paid it — PioneerRx prints a network id on almost every one. A rate exhibit says
          which network it prices, but in words: <b>&ldquo;Prime AccessOne Network&rdquo;</b>, with a chain code and no
          BIN. Of the first 86 contract documents read, 63 name a network, 39 give a chain code, 5 give a BIN and{" "}
          <b>none</b> gives the network id the claims carry. Neither side holds the other&rsquo;s key.
        </p>
        <p className="mt-2 text-sm text-ink-2">
          Matching them on how alike the names look would be a wrong contract applied to a real claim — a shortfall
          that looks genuine and an appeal that gets withdrawn. So the site refuses to guess, and asks instead. One
          choice per network, made once.
        </p>
        <div className="mt-3 flex flex-wrap gap-6 border-t border-line pt-3">
          <Figure label="Networks still to tie" value={String(unlinked.length)} />
          <Figure label="Remittances behind them" value={money(unlinkedCents)} />
          <Figure label="Already tied" value={`${linked.length} of ${rows.length}`} />
          <Figure label="Share of all remittances settled" value={allCents > 0 ? `${Math.round(((allCents - unlinkedCents) / allCents) * 100)}%` : "—"} />
        </div>
      </Card>

      {rows.length === 0 ? (
        <Empty>
          No claim carries a network id yet. Import a transaction report on the Claims page and every network the
          pharmacy bills will be listed here.
        </Empty>
      ) : null}

      {unlinked.map((r) => (
        <Card
          key={r.networkId}
          className="mb-4"
          title={r.networkId}
          subtitle={`${r.claims.toLocaleString()} claim${r.claims === 1 ? "" : "s"} · ${money(r.remitCents)} remitted${r.payerName ? ` · its BIN resolves to ${r.payerName}` : ""}${r.bins.length ? ` · BIN ${r.bins.join(", ")}` : ""}`}
          tone={r.remitCents > 0 ? "warn" : undefined}
        >
          {r.candidates.length === 0 ? (
            <p className="text-sm text-ink-2">
              No contract on file is in force and plausible for this network. File the agreement on the Contracts page
              first — there is nothing here to choose between.
            </p>
          ) : (
            <form action={link} className="flex flex-wrap items-end gap-3">
              <input type="hidden" name="networkId" value={r.networkId} />
              <input type="hidden" name="pbmName" value={r.payerName ?? ""} />
              <label className="grow">
                <span className="label">Which agreement priced this network?</span>
                <select name="documentId" className="field" required defaultValue="">
                  <option value="" disabled>
                    Choose the contract…
                  </option>
                  {r.candidates.map((c) => (
                    <option key={c.documentId} value={c.documentId}>
                      {c.documentName}
                      {c.counterparty ? ` — ${c.counterparty}` : ""}
                      {c.networkNames.length ? ` (${c.networkNames.slice(0, 3).join("; ")})` : ""}
                    </option>
                  ))}
                </select>
              </label>
              <SubmitButton className="btn btn-primary" pendingLabel="Tying…">Tie it</SubmitButton>
              <p className="w-full text-xs text-ink-3">
                Best guess first: {r.candidates[0].why}. The order is a convenience — the answer is yours, and every
                claim on this network follows it.
              </p>
            </form>
          )}
        </Card>
      ))}

      {linked.length > 0 && (
        <Card className="mb-6" title="Already tied" subtitle="Each of these prices every claim on its network.">
          <ul className="space-y-1 text-sm">
            {linked.map((r) => (
              <li key={r.networkId} className="flex flex-wrap items-baseline gap-2">
                <code className="rounded bg-ground px-1.5 py-0.5 text-xs">{r.networkId}</code>
                <span className="text-ink-2">→ {r.linkedTo!.documentName}</span>
                <span className="text-xs text-ink-3">
                  {r.claims.toLocaleString()} claim{r.claims === 1 ? "" : "s"} · {money(r.remitCents)}
                </span>
              </li>
            ))}
          </ul>
        </Card>
      )}
    </>
  );
}
