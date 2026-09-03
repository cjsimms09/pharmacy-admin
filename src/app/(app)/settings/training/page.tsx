import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { requireManager } from "@/lib/auth";
import { audit } from "@/lib/audit";
import { getSettings, setSetting } from "@/lib/settings";
import { parseMaterials, STATEMENTS } from "@/lib/training-assignments";
import { TRAINING_LABEL } from "@/lib/labels";
import { TRAINING_TYPES, type TrainingType } from "@/db/schema";
import { PageHeader, Notice, BackLink, Field } from "@/components/ui";

export const metadata = { title: "Training material" };
export const dynamic = "force-dynamic";

export default async function TrainingMaterialPage({ searchParams }: { searchParams: Promise<{ ok?: string }> }) {
  await requireManager();
  const { ok } = await searchParams;
  const s = await getSettings();
  const current = parseMaterials(s.training_materials ?? "");
  const assignable = TRAINING_TYPES.filter((t) => STATEMENTS[t as TrainingType]);

  async function save(fd: FormData) {
    "use server";
    const u = await requireManager();
    const lines = assignable
      .map((t) => [t, String(fd.get(`url-${t}`) ?? "").trim()] as const)
      .filter(([, url]) => url)
      .map(([t, url]) => `${t} = ${url}`);
    await setSetting("training_materials", lines.join("\n"));
    await audit({ action: "training.materials", userId: u.id, userName: u.name, details: `${lines.length} set` });
    revalidatePath("/settings/training");
    redirect("/settings/training?ok=" + encodeURIComponent("Saved."));
  }

  return (
    <>
      <BackLink href="/settings">Settings</BackLink>
      <PageHeader
        title="Training material"
        subtitle="Where each training lives. Staff are sent straight to it, so they never have to be told separately what to go and do."
      />
      {ok && <Notice kind="ok">{ok}</Notice>}

      <Notice kind="warn">
        Check each link opens before you rely on it. A course that has quietly moved produces staff who cannot do the
        training and a pharmacist-in-charge who finds out when somebody asks — which is why these are yours to set
        rather than built in.
      </Notice>

      <form action={save} className="mt-4 max-w-3xl space-y-3">
        {assignable.map((t) => (
          <Field key={t} label={TRAINING_LABEL[t as TrainingType]}>
            <input
              name={`url-${t}`}
              type="url"
              defaultValue={current[t as TrainingType] ?? ""}
              placeholder="https://…"
              className="field font-mono text-xs"
            />
          </Field>
        ))}
        <button className="rounded-md bg-ink px-3 py-2 text-sm text-white">Save</button>
      </form>

      <section className="mt-8 max-w-3xl rounded-lg border border-line bg-surface p-4 text-sm">
        <h2 className="font-semibold">Where to look</h2>
        <ul className="mt-2 list-disc space-y-2 pl-5 text-ink-2">
          <li>
            <b>Health Mart Atlas first.</b> As your PSAO they very likely provide fraud, waste and abuse and general
            compliance training to members, and it is the one source that is certain to be accepted by the people who
            audit you. One place, one record, no argument.
          </li>
          <li>
            <b>Fraud, waste and abuse and general compliance.</b> CMS publishes free web-based modules through the
            Medicare Learning Network. Worth knowing: a pharmacy already enrolled in Medicare is generally treated as
            having met the FWA training requirement through that enrolment, though general compliance training is
            separate. Confirm how Health Mart Atlas expects you to evidence it before deciding you need a course at all.
          </li>
          <li>
            <b>HIPAA.</b> HHS publishes good free material, but a free course that issues a certificate is harder to
            find than for FWA. If nothing suitable turns up, in-house training against your own policies is perfectly
            acceptable — what the rule asks for is that the workforce is trained, not that a vendor was paid.
          </li>
          <li>
            <b>OSHA bloodborne pathogens and hazard communication.</b> OSHA publishes the standards and training
            material free. These must be specific to this pharmacy — where your sharps container is, where the safety
            data sheets are kept — so a generic course on its own does not discharge them.
          </li>
        </ul>
        <p className="mt-3 text-xs text-ink-3">
          Leave a link blank and staff simply get the attestation without a link, which is right for training you run
          in person. The signature records what they confirmed either way.
        </p>
      </section>
    </>
  );
}
