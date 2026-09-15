import Link from "next/link";
import os from "node:os";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { db, schema } from "@/db";
import { requireManager, createUser } from "@/lib/auth";
import { getSettings, setSetting, SETTING_KEYS, type SettingKey } from "@/lib/settings";
import { audit } from "@/lib/audit";
import { apiKeyHint, clearApiKey, saveApiKey, testConnection, hasApiKey, DEFAULT_MODEL } from "@/lib/ai";
import { spend, rates, dollars, monthlyCap, DEFAULT_RATE_IN, DEFAULT_RATE_OUT } from "@/lib/ai-spend";
import { logo, saveLogo, clearLogo } from "@/lib/branding";
import { fmt } from "@/lib/dates";
import { Hub } from "@/components/hub";
import { PageHeader, Notice, Field } from "@/components/ui";

export const metadata = { title: "Settings" };

export default async function SettingsPage({ searchParams }: { searchParams: Promise<{ saved?: string; error?: string; ai?: string }> }) {
  const user = await requireManager();
  const { saved, error, ai } = await searchParams;
  const s = await getSettings();
  const keyHint = await apiKeyHint();
  const [used, rate, cap, mark] = await Promise.all([spend(90), rates(), monthlyCap(), logo()]);
  const users = await db.query.users.findMany({ orderBy: (u, { asc }) => [asc(u.name)] });
  const people = await db.query.people.findMany({ orderBy: (p, { asc }) => [asc(p.lastName)] });

  async function save(fd: FormData) {
    "use server";
    const u = await requireManager();
    for (const k of SETTING_KEYS) {
      const v = fd.get(k);
      if (typeof v === "string") await setSetting(k as SettingKey, v.trim());
    }
    await audit({ action: "settings.update", userId: u.id, userName: u.name });
    revalidatePath("/settings");
    redirect("/settings?saved=1");
  }

  async function setKey(fd: FormData) {
    "use server";
    const u = await requireManager();
    const key = String(fd.get("apiKey") ?? "").trim();
    const model = String(fd.get("ai_model") ?? "").trim() || DEFAULT_MODEL;

    /*
     * The ceiling and the key share a form, and the key must not be needed to change the ceiling.
     *
     * A stored key is never rendered back into the page — it is a secret, and that is right — so
     * the box is always empty. Requiring it meant that raising the ceiling, which is the one thing
     * anybody wants to do at the moment everything has stopped, was refused with "that doesn't
     * look like an Anthropic API key" unless the owner went and found the key again. The setting
     * you need when the site has stopped is the setting you could not reach.
     *
     * So a blank box means "leave the key alone" where one is already stored, and only a pharmacy
     * with no key at all is asked for one.
     */
    const hadKey = await hasApiKey();
    if (key === "" && hadKey) {
      // Nothing to save on the key; everything below still saves.
    } else if (!key.startsWith("sk-ant-") || key.length < 30) {
      redirect(
        "/settings?error=" +
          encodeURIComponent(
            hadKey
              ? "That doesn't look like an Anthropic API key (they start with sk-ant-). Leave the box empty to keep the key you already have and change only the settings below it."
              : "That doesn't look like an Anthropic API key (they start with sk-ant-).",
          ),
      );
    } else {
      try {
        await saveApiKey(key);
      } catch (e) {
        redirect("/settings?error=" + encodeURIComponent(e instanceof Error ? e.message : "Could not store the key."));
      }
    }
    await setSetting("ai_model", model);
    await setSetting("ai_price_in", String(fd.get("ai_price_in") ?? "").trim());
    await setSetting("ai_price_out", String(fd.get("ai_price_out") ?? "").trim());
    await setSetting("ai_monthly_cap", String(fd.get("ai_monthly_cap") ?? "").trim());
    const cap = String(fd.get("ai_monthly_cap") ?? "").trim();
    await audit({
      action: key === "" && hadKey ? "ai.settings.set" : "ai.key.set",
      userId: u.id,
      userName: u.name,
      details: `model=${model}${cap ? `, ceiling=$${cap}` : ", no ceiling"}`,
    });
    const t = await testConnection();
    revalidatePath("/settings");
    if (t.ok) {
      redirect(
        "/settings?saved=" +
          encodeURIComponent(cap ? `The monthly ceiling is now $${cap}.` : "There is no monthly ceiling any more."),
      );
    }
    /*
     * Saying "the connection test failed" when the ceiling is what stopped it sends somebody to
     * look at their key and their network, which are both fine. Name the actual cause, and say
     * plainly that the settings were kept — the sentence used to read as though nothing had saved.
     */
    const blockedByCeiling = /ceiling/i.test(t.error ?? "");
    redirect(
      "/settings?error=" +
        encodeURIComponent(
          blockedByCeiling
            ? `Your settings were saved${cap ? ` and the ceiling is now $${cap}` : " with no ceiling"}, but the test itself could not run: ${t.error} If you meant to remove the limit entirely, enter 0 rather than leaving the box empty — empty means the built-in $50.`
            : `Your settings were saved, but the connection test failed: ${t.error}`,
        ),
    );
  }

  async function removeKey() {
    "use server";
    const u = await requireManager();
    await clearApiKey();
    await audit({ action: "ai.key.clear", userId: u.id, userName: u.name });
    revalidatePath("/settings");
    redirect("/settings?saved=1");
  }

  async function testKey() {
    "use server";
    const t = await testConnection();
    redirect(t.ok ? "/settings?saved=1&ai=" + encodeURIComponent(t.model) : "/settings?error=" + encodeURIComponent(t.error));
  }

  async function addUser(fd: FormData) {
    "use server";
    const u = await requireManager();
    if (u.role !== "owner") redirect("/settings?error=Only%20the%20owner%20can%20add%20logins.");
    const name = String(fd.get("name") ?? "").trim();
    const username = String(fd.get("username") ?? "").trim().toLowerCase();
    const password = String(fd.get("password") ?? "");
    const role = String(fd.get("role") ?? "staff") as "owner" | "pic" | "staff";
    const personId = String(fd.get("personId") ?? "") || null;
    if (!name || !username || password.length < 12) redirect("/settings?error=Name%2C%20username%2C%20and%20a%2012%2B%20character%20password%20are%20required.");
    try {
      const id = await createUser({ name, username, password, role, personId });
      await audit({ action: "user.create", userId: u.id, userName: u.name, entity: "user", entityId: id, details: `${username} (${role})` });
    } catch {
      redirect("/settings?error=That%20username%20is%20already%20taken.");
    }
    revalidatePath("/settings");
    redirect("/settings?saved=1");
  }

  async function uploadLogo(fd: FormData) {
    "use server";
    const u = await requireManager();
    try {
      await saveLogo(fd.get("logo") as File, u);
      await audit({ action: "settings.logo", userId: u.id, userName: u.name });
      revalidatePath("/", "layout");
      redirect("/settings?saved=1");
    } catch (e) {
      if (e && typeof e === "object" && "digest" in e) throw e;
      redirect("/settings?error=" + encodeURIComponent(e instanceof Error ? e.message : "That image could not be used."));
    }
  }

  async function removeLogo() {
    "use server";
    const u = await requireManager();
    await clearLogo();
    await audit({ action: "settings.logo.remove", userId: u.id, userName: u.name });
    revalidatePath("/", "layout");
    redirect("/settings?saved=1");
  }

  return (
    <>
      {/*
        The seven buttons that used to sit here are the seven pages the sidebar now lists under
        Settings. Saying the same thing twice on the same screen is not twice as helpful; the
        cards at the foot of the page say what each one is for, which the buttons never did.
      */}
      <PageHeader
        title="Settings"
        subtitle="The pharmacy's own details — these go on every printed Board form — plus the connections, the backups and who can sign in."
      />
      {/* `saved` carries the sentence where there is one to say, so a ceiling change confirms itself. */}
      {saved && <Notice>{ai ? `Connected to Claude (${ai}).` : saved === "1" ? "Saved." : saved}</Notice>}
      {error && <Notice kind="crit">{error}</Notice>}

      <form action={save} className="card mb-6 grid max-w-3xl gap-4 sm:grid-cols-2">
        <h2 className="font-semibold sm:col-span-2">Pharmacy</h2>
        <Field label="Facility name"><input name="pharmacy_name" className="field" defaultValue={s.pharmacy_name} /></Field>
        <Field label="Facility registration number"><input name="pharmacy_registration_number" className="field" defaultValue={s.pharmacy_registration_number} /></Field>
        <Field label="Physical address" className="sm:col-span-2"><input name="pharmacy_address" className="field" defaultValue={s.pharmacy_address} /></Field>
        <Field label="City"><input name="pharmacy_city" className="field" defaultValue={s.pharmacy_city} /></Field>
        <div className="grid grid-cols-3 gap-3">
          <Field label="State"><input name="pharmacy_state" className="field" defaultValue={s.pharmacy_state} /></Field>
          <Field label="Zip"><input name="pharmacy_zip" className="field" defaultValue={s.pharmacy_zip} /></Field>
          <Field label="County"><input name="pharmacy_county" className="field" defaultValue={s.pharmacy_county} /></Field>
        </div>
        <Field label="Phone"><input name="pharmacy_phone" className="field" defaultValue={s.pharmacy_phone} /></Field>
        <Field
          label="Authorizing physician for immunizations"
          hint="Prints on every immunizer's protocol. Held once because they all work under the same one, and a name typed five times is a name spelled four ways."
          className="sm:col-span-2"
        >
          <input name="protocol_physician_name" className="field" defaultValue={s.protocol_physician_name} placeholder="Dr Larry Dircksen" />
        </Field>

        <h2 className="mt-2 font-semibold sm:col-span-2">Identifiers</h2>
        <p className="-mt-2 text-xs text-ink-3 sm:col-span-2">
          These go on every MAC appeal and are how a paid claim is matched back to the contract that governs it.
        </p>
        <Field label="NPI"><input name="pharmacy_npi" className="field font-mono" defaultValue={s.pharmacy_npi} /></Field>
        <Field label="NCPDP / NABP number"><input name="pharmacy_ncpdp" className="field font-mono" defaultValue={s.pharmacy_ncpdp} /></Field>
        {/* The owner, 8 September: "I dont see place to enter our TIN number?" — it was only on the 835 routing page. Every enrolment letter needs it. */}
        <Field label="TIN (tax identification number)" hint="On every 835 enrolment letter and W-9. Digits only."><input name="pharmacy_tin" className="field font-mono" defaultValue={s.pharmacy_tin} inputMode="numeric" /></Field>
        <Field label="DEA registration"><input name="pharmacy_dea" className="field font-mono" defaultValue={s.pharmacy_dea} /></Field>
        <Field
          label="Chain codes"
          hint="The codes your PSAO contracts under, comma-separated — not your own number. Health Mart Atlas signs its agreements for pharmacies bearing 605, 630 and 841, and PBMs print the same code as A605, 00605 or 0000630; those all read as one. A rate exhibit that names a code you are not under is not yours, and this is how the site knows."
        >
          <input name="pharmacy_chain_code" className="field font-mono" defaultValue={s.pharmacy_chain_code} />
        </Field>
        <Field label="PSAO" hint="Your contracting organisation — e.g. Health Mart Atlas. Not the same as the Patient Safety Organization below.">
          <input name="psao_name" className="field" defaultValue={s.psao_name} />
        </Field>
        <Field label="PSAO member number"><input name="psao_member_id" className="field font-mono" defaultValue={s.psao_member_id} /></Field>

        <h2 className="mt-2 font-semibold sm:col-span-2">Patient Safety Organization</h2>
        <p className="-mt-2 text-xs text-ink-3 sm:col-span-2">
          A PSO under the federal patient safety rules — separate from the PSAO above, despite the name.
        </p>
        <Field label="Actively reporting to a PSO?" hint="If yes, RCA and CAP are not required per incident (K.A.R. 68-19-1); keep the membership record 5 years.">
          <select name="pso_member" className="field" defaultValue={s.pso_member || "no"}>
            <option value="no">No</option>
            <option value="yes">Yes</option>
          </select>
        </Field>
        <Field label="PSO name"><input name="pso_name" className="field" defaultValue={s.pso_name} /></Field>
        <Field label="PSO membership expires"><input name="pso_expires_on" type="date" className="field" defaultValue={s.pso_expires_on} /></Field>
        <div className="sm:col-span-2"><button className="btn btn-primary">Save</button></div>
      </form>

      {/*
        The pharmacy's own mark.

        Everything this system produces goes to somebody: an invoice to an accounts department, a
        training certificate to a member of staff, a policy manual to an inspector. Every one of
        them arrived looking like a printout from a database, and a printout is read as a draft.
        A letterhead is not decoration — it is what makes a page read as a record the pharmacy
        keeps rather than something typed up this morning.
      */}
      <section className="card mb-6 max-w-3xl">
        <h2 className="mb-1 font-semibold">Logo</h2>
        <p className="mb-3 text-xs text-ink-3">
          Used on the documents this pharmacy produces — the printed policy manual, its own forms and records, the
          training certificates — and at the top of this site. Deliberately <b>not</b> put on the Kansas Board&rsquo;s
          own forms: a C-550 or a C-900 is the Board&rsquo;s document reproduced faithfully, and adding a logo to one
          would be altering a state form.
        </p>
        {mark ? (
          <div className="mb-3 flex flex-wrap items-center gap-4">
            <span className="inline-flex h-20 items-center rounded-md border border-line bg-white px-4">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={mark.url} alt="The pharmacy logo" className="max-h-14 w-auto max-w-[3in] object-contain" />
            </span>
            <span className="text-xs text-ink-3">{mark.fileName}</span>
            <form action={removeLogo}>
              <button className="btn btn-sm">Remove it</button>
            </form>
          </div>
        ) : (
          <p className="mb-3 text-sm text-ink-3">No logo on file, so documents print with the pharmacy name alone.</p>
        )}
        <form action={uploadLogo} className="flex flex-wrap items-end gap-3" encType="multipart/form-data">
          <Field
            label={mark ? "Replace it" : "Upload one"}
            hint="PNG, JPG, SVG or WebP, under 3 MB. A wide logo with a transparent or white background sits best on a letterhead."
          >
            <input type="file" name="logo" accept="image/png,image/jpeg,image/svg+xml,image/webp" className="field" required />
          </Field>
          <button className="btn btn-primary">Save</button>
        </form>
      </section>

      <section className="card mb-6 max-w-3xl">
        <h2 className="mb-1 font-semibold">Claude</h2>
        <p className="mb-3 text-xs text-ink-3">Used to read scanned CQI packets and draft root cause analyses, corrective action plans, and CAP evaluations for you to review. Get a key at console.anthropic.com → API keys. The key is stored encrypted and never shown again. Prescription numbers and staff names are redacted from text sent for drafting.</p>
        {keyHint ? (
          <div className="mb-3 flex flex-wrap items-center gap-3 text-sm">
            <span className="badge badge-ok">Key on file {keyHint}</span>
            <span className="text-ink-2">Model: <code>{s.ai_model}</code></span>
            <form action={testKey}><button className="btn">Test connection</button></form>
            <form action={removeKey}><button className="btn btn-danger">Remove key</button></form>
          </div>
        ) : (
          <p className="mb-3 text-sm text-warn">No key on file.</p>
        )}
        <form action={setKey} className="grid gap-3 sm:grid-cols-3">
          {/*
            Required only when there is no key. With one on file the box must be optional, or the
            browser refuses to submit the form at all and the ceiling below it cannot be changed
            without going to find a secret — at exactly the moment the ceiling has stopped
            everything and is the thing you came here to raise.
          */}
          <Field
            label={keyHint ? "Replace key" : "API key"}
            hint={keyHint ? "Leave empty to keep the key on file and change only the settings below." : undefined}
            className="sm:col-span-2"
          >
            <input
              name="apiKey"
              type="password"
              className="field font-mono"
              placeholder={keyHint ? "leave empty to keep the current key" : "sk-ant-…"}
              autoComplete="off"
              required={!keyHint}
            />
          </Field>
          <Field label="Model" hint="Leave as is unless told otherwise."><input name="ai_model" className="field font-mono" defaultValue={s.ai_model} /></Field>
          {/*
            The price list, as a setting.

            Anthropic's rates are not this software's to know, and a figure compiled in is wrong
            the first time the list changes with nobody noticing. Typing the two numbers off the
            pricing page makes every estimate and every total on this site correct — including the
            one printed next to the button that spends the money.
          */}
          <Field label="Cost per million input tokens" hint={`Dollars. Blank uses ${DEFAULT_RATE_IN}.`}>
            <input name="ai_price_in" type="number" step="0.01" min="0" className="field" defaultValue={s.ai_price_in} placeholder={String(DEFAULT_RATE_IN)} />
          </Field>
          <Field label="Cost per million output tokens" hint={`Dollars. Blank uses ${DEFAULT_RATE_OUT}.`}>
            <input name="ai_price_out" type="number" step="0.01" min="0" className="field" defaultValue={s.ai_price_out} placeholder={String(DEFAULT_RATE_OUT)} />
          </Field>
          {/*
            A ceiling, so nobody has to watch the buttons.

            The question that produced this was "am I about to pay a fortune in API fees?", and the
            honest answer — about nine dollars a year — is arithmetic, not reassurance. A number the
            pharmacist chooses himself is reassurance. It is enforced at the single point every
            model call passes through, so it covers everything the site does rather than the one
            screen somebody remembered to guard.
          */}
          {/*
            The label has to match the code, and it did not.

            It said blank meant no ceiling. Blank actually means "nobody has set one", which falls
            back to the built-in $50 — so clearing the box to remove the limit put the limit
            straight back, and the next thing the page did was fail against it. Zero is the value
            that means no ceiling, and now the field says so.
          */}
          <Field
            label="Stop spending after, per month"
            hint="Dollars. Leave blank for the built-in $50 ceiling, or enter 0 for no ceiling at all. Nothing is sent to Claude once the last 31 days reach it."
          >
            <input name="ai_monthly_cap" type="number" step="1" min="0" className="field" defaultValue={s.ai_monthly_cap} placeholder="50 — the built-in ceiling" />
          </Field>
          <div className="sm:col-span-3"><button className="btn btn-primary">Save and test</button></div>
        </form>

        {cap.cap !== null && (
          <p className={`mt-2 text-xs ${cap.over ? "text-crit" : "text-ink-3"}`}>
            {cap.over ? (
              <>
                <b>The ceiling has been reached.</b> {dollars(cap.spent)} in the last 31 days against a ceiling of{" "}
                {dollars(cap.cap)}. Nothing is being sent to Claude until the month rolls on or you raise it. Everything
                already done is saved.
              </>
            ) : (
              <>
                {dollars(cap.spent)} of {dollars(cap.cap)} used in the last 31 days — {dollars(cap.left)} left before
                the site stops sending anything to Claude.
              </>
            )}
          </p>
        )}

        {/*
          What it has actually cost.

          Every model call has written its token counts into the audit log since the beginning;
          they were simply never added up. Counted from that log rather than from a separate tally,
          so this cannot drift from what really happened.
        */}
        <div className="mt-4 border-t border-line pt-4">
          <h3 className="text-sm font-semibold">What Claude has cost</h3>
          {used.calls === 0 ? (
            <p className="mt-1 text-xs text-ink-3">Nothing yet — no model call has been made from this computer.</p>
          ) : (
            <>
              <p className="mt-1 text-sm">
                <b>{dollars(used.cost)}</b> over the last 90 days, across {used.calls} call{used.calls === 1 ? "" : "s"}
                {used.since ? ` since ${fmt(used.since.slice(0, 10))}` : ""} — {used.tokensIn.toLocaleString("en-US")} tokens
                in, {used.tokensOut.toLocaleString("en-US")} out, at ${rate.in} and ${rate.out} per million.
              </p>
              <div className="overflow-x-auto">
              <table className="table mt-2">
                <thead><tr><th>What</th><th className="text-right">Calls</th><th className="text-right">Tokens</th><th className="text-right">Cost</th></tr></thead>
                <tbody>
                  {used.byAction.slice(0, 8).map((a) => (
                    <tr key={a.action}>
                      <td className="font-mono text-xs">{a.action.replace(/^ai\./, "")}</td>
                      <td className="text-right text-xs">{a.calls}</td>
                      <td className="text-right text-xs">{(a.tokensIn + a.tokensOut).toLocaleString("en-US")}</td>
                      <td className="text-right text-xs">{dollars(a.cost)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              </div>
            </>
          )}
          <p className="mt-2 text-xs text-ink-3">
            This is Anthropic&rsquo;s charge to your own account, not a charge from this software. Most of what the site
            does costs nothing at all: invoices are filed by reading the item class the wholesaler printed, and a model
            is only asked when that fails.
          </p>
        </div>
      </section>

      <section className="card max-w-3xl">
        <h2 className="mb-3 font-semibold">Logins</h2>
        <div className="overflow-x-auto">
        <table className="table mb-4">
          <thead><tr><th>Name</th><th>Username</th><th>Role</th><th>Linked staff record</th></tr></thead>
          <tbody>
            {users.map((u) => (
              <tr key={u.id}>
                <td>{u.name}{!u.active && <span className="badge badge-muted ml-2">disabled</span>}</td>
                <td className="font-mono text-xs">{u.username}</td>
                <td className="capitalize">{u.role}</td>
                <td className="text-xs text-ink-2">{people.find((p) => p.id === u.personId) ? `${people.find((p) => p.id === u.personId)!.firstName} ${people.find((p) => p.id === u.personId)!.lastName}` : "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
        </div>
        {user.role === "owner" && (
          <details>
            <summary className="cursor-pointer text-sm font-medium text-accent">Add login</summary>
            <form action={addUser} className="mt-3 grid gap-3 sm:grid-cols-2">
              <Field label="Full name"><input name="name" className="field" required /></Field>
              <Field label="Username"><input name="username" className="field" required autoComplete="off" /></Field>
              <Field label="Password" hint="12+ characters; the person should change it after first sign-in (coming later)."><input name="password" type="password" className="field" required minLength={12} autoComplete="new-password" /></Field>
              <Field label="Role" hint="Owner: everything. PIC: compliance and CQI. Staff: only their own record.">
                <select name="role" className="field" defaultValue="staff">
                  <option value="staff">Staff</option>
                  <option value="pic">PIC</option>
                  <option value="owner">Owner</option>
                </select>
              </Field>
              <Field label="Linked staff record" className="sm:col-span-2">
                <select name="personId" className="field" defaultValue="">
                  <option value="">— none —</option>
                  {people.map((p) => <option key={p.id} value={p.id}>{p.lastName}, {p.firstName}</option>)}
                </select>
              </Field>
              <div className="sm:col-span-2"><button className="btn btn-primary">Create login</button></div>
            </form>
          </details>
        )}
      </section>

      {/* Network and Backups are pages of their own, listed below; saying it twice on one screen is not twice as helpful. */}

      <div className="max-w-3xl">
        <h2 className="mb-3 mt-8">Elsewhere in settings</h2>
        <Hub href="/settings" exclude={["/settings"]} />
      </div>
    </>
  );
}

function lanAddresses(): string[] {
  const out: string[] = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const i of list ?? []) {
      if (i.family === "IPv4" && !i.internal) out.push(i.address);
    }
  }
  return out;
}
