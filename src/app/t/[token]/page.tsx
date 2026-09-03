import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { assignmentByToken, completeAssignment } from "@/lib/training-assignments";
import { TRAINING_LABEL } from "@/lib/labels";
import { getSettings } from "@/lib/settings";
import { fmt } from "@/lib/dates";

export const metadata = { title: "Training" };
export const dynamic = "force-dynamic";

/**
 * What a member of staff sees. No login, no account, works on a phone.
 *
 * Everything on this page is here because leaving it out would weaken the record. The person
 * sees their own name so a forwarded link is obviously wrong. They see the exact words before
 * they sign rather than after. And they type their name rather than tick a box, because a typed
 * name is a deliberate act and a tick is something people do to make a page go away.
 */
export default async function TrainingLinkPage({
  params,
  searchParams,
}: {
  params: Promise<{ token: string }>;
  searchParams: Promise<{ error?: string; done?: string }>;
}) {
  const { token } = await params;
  const { error, done } = await searchParams;
  const found = await assignmentByToken(token);
  const s = await getSettings();
  const pharmacy = s.pharmacy_name || "the pharmacy";

  if (!found || !found.person) {
    return (
      <Shell pharmacy={pharmacy}>
        <h1 className="text-xl font-semibold">This link is not valid</h1>
        <p className="mt-2 text-ink-2">It may have been mistyped. Ask the pharmacist-in-charge to send it again.</p>
      </Shell>
    );
  }

  const { assignment: a, person } = found;

  if (done === "1" || a.completedAt) {
    return (
      <Shell pharmacy={pharmacy}>
        <div className="rounded-lg border border-emerald-300 bg-emerald-50 p-5">
          <h1 className="text-xl font-semibold text-emerald-900">Signed. Thank you.</h1>
          <p className="mt-2 text-emerald-900">
            Your {TRAINING_LABEL[a.type].toLowerCase()} is recorded{a.signedName ? ` in the name of ${a.signedName}` : ""}
            {a.completedAt ? ` on ${fmt(a.completedAt.slice(0, 10))}` : ""}. There is nothing else for you to do, and you
            can close this page.
          </p>
        </div>
      </Shell>
    );
  }

  async function sign(fd: FormData) {
    "use server";
    const h = await headers();
    const r = await completeAssignment(
      token,
      String(fd.get("signedName") ?? ""),
      {
        ip: h.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null,
        agent: h.get("user-agent") ?? null,
      },
    );
    redirect(r.ok ? `/t/${token}?done=1` : `/t/${token}?error=${encodeURIComponent(r.error)}`);
  }

  return (
    <Shell pharmacy={pharmacy}>
      <p className="text-sm text-ink-3">For {person.firstName} {person.lastName}</p>
      <h1 className="mt-1 text-2xl font-semibold">{TRAINING_LABEL[a.type]}</h1>
      <p className="mt-1 text-sm text-ink-2">Due by {fmt(a.dueOn)}.</p>

      {error && <p className="mt-4 rounded-md border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-900">{error}</p>}

      <ol className="mt-6 space-y-4">
        <li className="rounded-lg border border-line bg-surface p-4">
          <h2 className="font-semibold">1. Work through the training</h2>
          {a.materialUrl ? (
            <p className="mt-1 text-sm">
              <a href={a.materialUrl} target="_blank" rel="noreferrer" className="underline">
                Open the training material
              </a>{" "}
              — come back to this page afterwards to sign.
            </p>
          ) : (
            <p className="mt-1 text-sm text-ink-2">
              Use the material {pharmacy} has given you. If you are not sure what that is, ask before you sign —
              signing without doing it helps nobody and is the one thing that makes this record worthless.
            </p>
          )}
        </li>

        <li className="rounded-lg border border-line bg-surface p-4">
          <h2 className="font-semibold">2. Read what you are confirming</h2>
          <p className="mt-2 rounded-md border border-line bg-ground p-3 text-sm italic">&ldquo;{a.statement}&rdquo;</p>
        </li>

        <li className="rounded-lg border border-line bg-surface p-4">
          <h2 className="font-semibold">3. Sign it</h2>
          <form action={sign} className="mt-3">
            <label className="block text-sm">
              Type your full name
              <input
                name="signedName"
                autoComplete="name"
                placeholder={`${person.firstName} ${person.lastName}`}
                className="mt-1 w-full rounded-md border border-line px-3 py-2.5 text-base"
              />
            </label>
            <p className="mt-2 text-xs text-ink-3">
              Typing your name here is your signature. The date, time and this device are recorded with it.
            </p>
            <button className="mt-3 w-full rounded-md bg-ink px-4 py-3 text-base font-medium text-white sm:w-auto">
              Sign and finish
            </button>
          </form>
        </li>
      </ol>
    </Shell>
  );
}

function Shell({ pharmacy, children }: { pharmacy: string; children: React.ReactNode }) {
  return (
    <main className="mx-auto max-w-2xl px-4 py-8">
      <p className="text-xs uppercase tracking-wide text-ink-3">{pharmacy}</p>
      <div className="mt-2">{children}</div>
      <p className="mt-10 text-xs text-ink-3">
        This link is personal. If it was not sent to you, please do not use it.
      </p>
    </main>
  );
}
