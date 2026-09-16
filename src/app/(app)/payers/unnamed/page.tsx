import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { requireManager } from "@/lib/auth";
import { familyTabs } from "@/lib/families";
import { unnamedPayerKeys, keyWords } from "@/lib/claims-unnamed";
import { savePayerLink, applyLinksToClaims } from "@/lib/payer-links";
import { SITE_STARTS_ON } from "@/lib/books-start";
import { audit } from "@/lib/audit";
import { fmt } from "@/lib/dates";
import { PageHeader, Card, Notice, Empty } from "@/components/ui";
import { SubmitButton } from "@/components/submit-button";

export const dynamic = "force-dynamic";
export const metadata = { title: "Claims nobody can name" };

const money = (cents: number) => `$${(cents / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/**
 * The claims with no payer name, as the handful of decisions they actually are.
 *
 * The owner, 16 September 2026, when told 63 claims carrying $1,725.59 had no settled payer name:
 * **"I don't know how to fix this"**. He was right, and the fault was in how I put it. Sixty-three
 * unnamed claims is not something anybody can work through; it reads as a mess with no handle.
 *
 * It is twenty-four decisions, and four of them carry most of the money. Each is a BIN with its PCN
 * and group, and a pharmacist reads those the way the rest of us read a name — 004336 is Caremark,
 * 003858 is Express Scripts, 610014 is MedImpact. The site cannot know that. He can, in a second,
 * and that is exactly why this is a page with a box on it rather than another inference: the learner
 * that tried to infer it nearly renamed his claims after their courier.
 *
 * Naming one writes a payer link, which stamps every claim already on file carrying those
 * identifiers and every one that arrives afterwards. So the list is meant to get shorter and stay
 * shorter, and the top of it is worth the most.
 */
export default async function UnnamedPayersPage({ searchParams }: { searchParams: Promise<{ saved?: string }> }) {
  await requireManager();
  const { saved } = await searchParams;
  const tabs = familyTabs("payers", "/payers/unnamed");
  const found = await unnamedPayerKeys(SITE_STARTS_ON);

  async function name(fd: FormData) {
    "use server";
    const u = await requireManager();
    const bin = String(fd.get("bin") ?? "").trim() || null;
    const pcn = String(fd.get("pcn") ?? "").trim() || null;
    const groupNumber = String(fd.get("groupNumber") ?? "").trim() || null;
    const pbmName = String(fd.get("pbmName") ?? "").trim();
    if (!pbmName) redirect("/payers/unnamed?saved=" + encodeURIComponent("Give the payer a name and it will be saved."));
    try {
      await savePayerLink(
        { bin, pcn, groupNumber, contractId: null },
        { pbmName, basis: `Named by hand from the unnamed claims page, on ${new Date().toISOString().slice(0, 10)}` },
        u,
      );
    } catch (e) {
      redirect("/payers/unnamed?saved=" + encodeURIComponent(e instanceof Error ? e.message : "That could not be saved."));
    }
    /* Naming it and leaving the claims unstamped is half a job: the reason to settle who a payer is, is to ask what it pays. */
    const applied = await applyLinksToClaims();
    await audit({ action: "payer.named", userId: u.id, userName: u.name, details: `${keyWords({ bin, pcn, groupNumber })} is ${pbmName} — ${applied.claims} claim(s) stamped` });
    revalidatePath("/payers/unnamed");
    redirect("/payers/unnamed?saved=" + encodeURIComponent(`${pbmName} it is. ${applied.claims} claim${applied.claims === 1 ? "" : "s"} now carry the name, and anything arriving on those identifiers will too.`));
  }

  return (
    <>
      <PageHeader title="Claims nobody can name" subtitle="Every claim with no payer behind it, gathered into the decisions they are." tabs={tabs} />
      {saved && <Notice kind="ok">{saved}</Notice>}

      {found.keys.length === 0 && found.noMoney.length === 0 ? (
        <Empty>Every claim since {fmt(SITE_STARTS_ON)} has a payer against it.</Empty>
      ) : (
        <>
          <Notice kind={found.keys.length > 0 ? "warn" : "ok"}>
            {found.claims} claim{found.claims === 1 ? "" : "s"} carrying {money(found.cents)} have no payer name. That is{" "}
            <b>{found.keys.length} decision{found.keys.length === 1 ? "" : "s"}</b> worth money, largest first — you will
            recognise most of these BINs on sight, and the site never will. Naming one fixes every claim on those
            identifiers, past and future.
          </Notice>

          {found.keys.map((k) => (
            <Card key={`${k.bin}|${k.pcn}|${k.groupNumber}`} className="mt-3">
              <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
                <span className="text-base font-semibold">{keyWords(k)}</span>
                <span className="text-right">
                  <span className="block text-xl font-semibold tabular-nums">{money(k.cents)}</span>
                  <span className="block text-xs text-ink-3">
                    {k.claims} claim{k.claims === 1 ? "" : "s"}, {fmt(k.firstFill)}
                    {k.firstFill === k.lastFill ? "" : ` to ${fmt(k.lastFill)}`}
                  </span>
                </span>
              </div>
              {k.printed && <p className="mt-1 text-sm text-ink-2">The claims print “{k.printed}”.</p>}
              {k.drugs.length > 0 && <p className="mt-1 text-xs text-ink-3">On {k.drugs.join(", ")}.</p>}
              <form action={name} className="mt-2 flex flex-wrap items-end gap-2">
                <input type="hidden" name="bin" value={k.bin ?? ""} />
                <input type="hidden" name="pcn" value={k.pcn ?? ""} />
                <input type="hidden" name="groupNumber" value={k.groupNumber ?? ""} />
                <label className="text-xs text-ink-2">
                  <span className="block">Who is this?</span>
                  <input name="pbmName" className="field mt-1 w-64 py-1 text-sm" placeholder="Caremark" />
                </label>
                <SubmitButton className="btn btn-sm btn-primary" pendingLabel="Saving…">Save the name</SubmitButton>
              </form>
            </Card>
          ))}

          {found.noMoney.length > 0 && (
            <Card className="mt-4">
              <p className="text-sm font-semibold">
                {found.noMoney.reduce((n, k) => n + k.claims, 0)} more claims carry no money at all
              </p>
              <p className="mt-1 text-sm text-ink-2">
                A voucher-only claim, a cash fill, a claim with no BIN on it. Naming these collects nothing, so they are
                here to be seen rather than worked through.
              </p>
              <ul className="mt-2 grid gap-0.5 text-xs text-ink-3">
                {found.noMoney.map((k) => (
                  <li key={`${k.bin}|${k.pcn}|${k.groupNumber}`}>
                    {keyWords(k)} — {k.claims} claim{k.claims === 1 ? "" : "s"}
                  </li>
                ))}
              </ul>
            </Card>
          )}
        </>
      )}
    </>
  );
}
