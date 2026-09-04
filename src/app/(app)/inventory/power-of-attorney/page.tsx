import Link from "next/link";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { eq } from "drizzle-orm";
import { db, schema } from "@/db";
import { requireUser, requireManager } from "@/lib/auth";
import { audit } from "@/lib/audit";
import { newId } from "@/lib/crypto";
import { getSettings } from "@/lib/settings";
import { todayIso, fmt, fmtLong } from "@/lib/dates";
import { PrintFrame } from "@/components/print";
import { Field, Notice } from "@/components/ui";

export const dynamic = "force-dynamic";
export const metadata = { title: "Power of attorney for DEA order forms" };

/**
 * The DEA power of attorney, and its revocation.
 *
 * Reproduced from the model forms in 21 CFR 1305.05 rather than paraphrased, because this is one
 * of the few pieces of pharmacy paperwork whose wording is set out in the regulation itself. A
 * home-written version that says roughly the same thing is exactly the kind of document that gets
 * questioned at the one moment it needs to be unarguable.
 *
 * Three things about it that are easy to get wrong and are stated on the form:
 *
 *   It must be signed by the person who signed the most recent application for registration —
 *   not by whoever happens to be pharmacist-in-charge. For an owner-operated pharmacy those are
 *   usually the same person; where they are not, a power of attorney signed by the wrong one is
 *   void and every order executed under it is unsigned.
 *
 *   It is filed with the executed Forms 222 and kept for as long as any order bearing the
 *   attorney-in-fact's signature — not in a personnel file.
 *
 *   And it stays in force until it is revoked in writing. That is why the revocation notice is
 *   printed on the same page rather than left to be found later: a pharmacist who leaves with a
 *   live power of attorney is the finding, and nobody ever remembers to look for it.
 */
export default async function PowerOfAttorneyPage({
  searchParams,
}: {
  searchParams: Promise<{ to?: string; grantor?: string; mode?: string; ok?: string; error?: string }>;
}) {
  const user = await requireUser();
  const { to, grantor, mode, ok, error } = await searchParams;
  const [s, people, existing] = await Promise.all([
    getSettings(),
    db.query.people.findMany({ orderBy: (p, { asc }) => [asc(p.lastName)] }),
    db.query.credentials.findMany({ where: eq(schema.credentials.type, "controlled_substance_poa") }),
  ]);

  const active = people.filter((p) => p.active);
  const attorney = to ? people.find((p) => p.id === to) : undefined;
  const pic = people.find((p) => p.isPic);
  const grantorName = (grantor ?? "").trim() || (pic ? `${pic.firstName} ${pic.lastName}` : "");
  const revoking = mode === "revoke";

  const registrant = s.pharmacy_name || "________________________________";
  const address =
    [s.pharmacy_address, [s.pharmacy_city, s.pharmacy_state].filter(Boolean).join(", "), s.pharmacy_zip]
      .filter(Boolean)
      .join(", ") || "________________________________";
  const dea = s.pharmacy_dea || "____________________";

  /** Files the signed power of attorney against the person it names. */
  async function record(fd: FormData) {
    "use server";
    const u = await requireManager();
    const personId = String(fd.get("personId") ?? "");
    const signedOn = String(fd.get("signedOn") ?? "").trim();
    const by = String(fd.get("grantedBy") ?? "").trim();
    const here = `/inventory/power-of-attorney?to=${personId}`;
    if (!personId) redirect(`${here}&error=` + encodeURIComponent("Choose who it was granted to."));
    if (!/^\d{4}-\d{2}-\d{2}$/.test(signedOn)) redirect(`${here}&error=` + encodeURIComponent("Put in the date it was signed."));

    await db.insert(schema.credentials).values({
      id: newId(),
      personId,
      type: "controlled_substance_poa",
      issuer: by || null,
      issuedOn: signedOn,
      notes:
        `Power of attorney for DEA order forms, granted by ${by || "the registrant"} on ${signedOn}. ` +
        `Filed with the executed Forms 222. Remains in force until revoked in writing.`,
    });
    await audit({ action: "cs.poa.record", userId: u.id, userName: u.name, entity: "person", entityId: personId });
    revalidatePath("/inventory/power-of-attorney");
    revalidatePath(`/staff/${personId}`);
    revalidatePath("/inspection");
    redirect(
      `${here}&ok=` +
        encodeURIComponent(
          "Recorded. File the signed original with your executed 222 forms — not in a personnel file — and revoke it in writing the day they leave.",
        ),
    );
  }

  return (
    <PrintFrame
      ownDocument
      formTitle={revoking ? "Notice of revocation of power of attorney" : "Power of attorney for DEA order forms"}
      formNumber=""
      revised=""
      backHref="/inventory"
    >
      <div className="no-print mb-4 space-y-3">
        {ok && <Notice kind="ok">{ok}</Notice>}
        {error && <Notice kind="crit">{error}</Notice>}

        <form method="get" className="grid gap-3 sm:grid-cols-3">
          {/* Not restricted to pharmacists. 21 CFR 1305.05 lets the registrant authorise "one or
              more individuals" — a technician who does the ordering is a normal and lawful
              choice, and a dropdown that hid them would have quietly ruled it out. */}
          <Field label="Grant it to" hint="Whoever will sign 222 forms and CSOS orders. Need not be a pharmacist.">
            <select name="to" defaultValue={to ?? ""} className="field">
              <option value="">— choose a person —</option>
              {active.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.firstName} {p.lastName} — {p.role}
                </option>
              ))}
            </select>
          </Field>
          <Field
            label="Signed by"
            hint="Must be whoever signed the most recent DEA registration application — usually the owner, not the PIC."
          >
            <input name="grantor" defaultValue={grantorName} className="field" placeholder="Owner's full name" />
          </Field>
          <Field label="Which document" hint="Print the revocation the day somebody leaves.">
            <select name="mode" defaultValue={mode ?? ""} className="field">
              <option value="">The power of attorney</option>
              <option value="revoke">The notice of revocation</option>
            </select>
          </Field>
          <div className="sm:col-span-3"><button className="btn btn-primary">Fill it in</button></div>
        </form>

        <p className="text-xs text-ink-3">
          Reproduced from the model forms at 21 CFR 1305.05. Verify the wording against the current regulation before
          it is signed — this is here so you have it to hand, not as legal advice. A separate power of attorney is
          needed for each person, and it must be signed by the person who signed the most recent registration
          application; one signed by the wrong person is void, and every order executed under it counts as unsigned.
        </p>
      </div>

      {/* ── The instrument ── */}
      <div className="print-block border-2 border-black p-5">
        <p className="text-center text-sm font-bold uppercase tracking-wide">
          {revoking ? "Notice of revocation" : "Power of attorney for DEA order forms"}
        </p>

        <div className="mt-4 space-y-0.5 text-[12px]">
          <p><b>{registrant}</b></p>
          <p>{address}</p>
          <p>DEA registration number: <b>{dea}</b></p>
        </div>

        {!revoking ? (
          <>
            <p className="mt-5 text-[12px] leading-relaxed">
              I, <Blank value={grantorName} width="18rem" />, the undersigned, who am authorized to sign the current
              application for registration of the above-named registrant under the Controlled Substances Act or the
              Controlled Substances Import and Export Act, have made, constituted, and appointed, and by these presents
              do make, constitute, and appoint{" "}
              <Blank value={attorney ? `${attorney.firstName} ${attorney.lastName}` : ""} width="18rem" />, my true and
              lawful attorney for me in my name, place, and stead, to execute applications for books of official order
              forms and to sign such order forms in requisition for Schedule I and II controlled substances, in
              accordance with 21 U.S.C. 828 and part 1305 of Title 21 of the Code of Federal Regulations. I hereby
              ratify and confirm all that said attorney shall lawfully do or cause to be done by virtue hereof.
            </p>

            <div className="mt-8">
              <div className="border-b border-black" style={{ width: "22rem" }} />
              <p className="mt-1 text-[10px]">Signature of person granting power</p>
            </div>

            <p className="mt-6 text-[12px] leading-relaxed">
              I, <Blank value={attorney ? `${attorney.firstName} ${attorney.lastName}` : ""} width="18rem" />, hereby
              affirm that I am the person named herein as attorney-in-fact and that the signature affixed hereto is my
              signature.
            </p>

            <div className="mt-8">
              <div className="border-b border-black" style={{ width: "22rem" }} />
              <p className="mt-1 text-[10px]">Signature of attorney-in-fact</p>
            </div>
          </>
        ) : (
          <>
            <p className="mt-5 text-[12px] leading-relaxed">
              The foregoing power of attorney, granted to{" "}
              <Blank value={attorney ? `${attorney.firstName} ${attorney.lastName}` : ""} width="18rem" />, is hereby
              revoked by the undersigned, who is authorized to sign the current application for registration of the
              above-named registrant under the Controlled Substances Act or the Controlled Substances Import and Export
              Act. Written notice of this revocation has been given to the attorney-in-fact this same day.
            </p>

            <div className="mt-8">
              <div className="border-b border-black" style={{ width: "22rem" }} />
              <p className="mt-1 text-[10px]">Signature of person revoking power</p>
            </div>
          </>
        )}

        <div className="mt-8">
          <p className="text-[10px] font-semibold uppercase tracking-wide">Witnesses</p>
          <div className="mt-3 grid gap-6 sm:grid-cols-2">
            {[1, 2].map((n) => (
              <div key={n}>
                <div className="border-b border-black" />
                <p className="mt-1 text-[10px]">{n}. Signature</p>
              </div>
            ))}
          </div>
        </div>

        <p className="mt-8 text-[12px]">
          Signed and dated on the __________ day of ____________________, __________, at ____________________________.
        </p>
      </div>

      <div className="print-block mt-4 border border-black p-3 text-[10px] leading-relaxed">
        <p className="font-bold">Where this goes afterwards</p>
        <p className="mt-1">
          File the signed original with the executed Forms 222 and keep it for as long as any order form bearing the
          attorney-in-fact&rsquo;s signature — not in a personnel file, which is where DEA will not look for it and
          where it will not be found.
        </p>
        <p className="mt-1">
          It remains in force until it is revoked in writing. Print the notice of revocation on the day the person
          leaves, have it signed, give them written notice, and file it with the original. A pharmacist who has left
          with a live power of attorney is the finding.
        </p>
        <p className="mt-1">Printed {fmtLong(todayIso())} by {user.name}.</p>
      </div>

      {/* ── Track it, so the site knows it exists ── */}
      <div className="no-print mt-6 rounded-lg border border-line bg-surface p-4">
        <h2 className="text-sm font-semibold">Once it is signed, record it here</h2>
        <p className="mt-1 text-xs text-ink-3">
          The inspection check for &ldquo;who is authorised to sign your 222 forms&rdquo; reads this. Recording it also
          means the site can tell you it is still live when that person leaves.
        </p>
        <form action={record} className="mt-3 grid gap-3 sm:grid-cols-3">
          <Field label="Granted to">
            <select name="personId" defaultValue={to ?? ""} className="field">
              <option value="">— choose —</option>
              {active.map((p) => <option key={p.id} value={p.id}>{p.firstName} {p.lastName}</option>)}
            </select>
          </Field>
          <Field label="Signed on"><input name="signedOn" type="date" defaultValue={todayIso()} className="field" /></Field>
          <Field label="Granted by"><input name="grantedBy" defaultValue={grantorName} className="field" /></Field>
          <div className="sm:col-span-3"><button className="btn btn-primary">Record it</button></div>
        </form>

        {existing.length > 0 && (
          <div className="mt-4 border-t border-line pt-3">
            <h3 className="text-sm font-semibold">Already on file</h3>
            <ul className="mt-1 space-y-1 text-xs">
              {existing.map((c) => {
                const p = people.find((x) => x.id === c.personId);
                return (
                  <li key={c.id} className={p && !p.active ? "text-crit" : "text-ink-2"}>
                    {p ? `${p.firstName} ${p.lastName}` : "someone no longer on file"}
                    {c.issuedOn ? ` — signed ${fmt(c.issuedOn)}` : ""}
                    {p && !p.active && (
                      <>
                        {" — "}
                        <b>this person has left and the power of attorney is still live.</b>{" "}
                        <Link href={`/inventory/power-of-attorney?to=${p.id}&mode=revoke`} className="underline">
                          Print the revocation
                        </Link>
                      </>
                    )}
                  </li>
                );
              })}
            </ul>
          </div>
        )}
      </div>
    </PrintFrame>
  );
}

/** A filled value on a ruled line, or an empty line to write on. */
function Blank({ value, width }: { value: string; width: string }) {
  return (
    <span
      className="inline-block border-b border-black text-center align-bottom"
      style={{ minWidth: width }}
    >
      {value || " "}
    </span>
  );
}
