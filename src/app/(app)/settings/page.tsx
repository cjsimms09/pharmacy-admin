import Link from "next/link";
import os from "node:os";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { db, schema } from "@/db";
import { requireManager, createUser } from "@/lib/auth";
import { getSettings, setSetting, SETTING_KEYS, type SettingKey } from "@/lib/settings";
import { audit } from "@/lib/audit";
import { apiKeyHint, clearApiKey, saveApiKey, testConnection, DEFAULT_MODEL } from "@/lib/ai";
import { PageHeader, Notice, Field } from "@/components/ui";

export const metadata = { title: "Settings" };

export default async function SettingsPage({ searchParams }: { searchParams: Promise<{ saved?: string; error?: string; ai?: string }> }) {
  const user = await requireManager();
  const { saved, error, ai } = await searchParams;
  const s = await getSettings();
  const keyHint = await apiKeyHint();
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
    if (!key.startsWith("sk-ant-") || key.length < 30) redirect("/settings?error=" + encodeURIComponent("That doesn't look like an Anthropic API key (they start with sk-ant-)."));
    try {
      await saveApiKey(key);
    } catch (e) {
      redirect("/settings?error=" + encodeURIComponent(e instanceof Error ? e.message : "Could not store the key."));
    }
    await setSetting("ai_model", model);
    await audit({ action: "ai.key.set", userId: u.id, userName: u.name, details: `model=${model}` });
    const t = await testConnection();
    revalidatePath("/settings");
    redirect(t.ok ? "/settings?saved=1" : "/settings?error=" + encodeURIComponent("Key saved, but the test failed: " + t.error));
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

  return (
    <>
      <PageHeader title="Settings" subtitle="Pharmacy details used on printed Board forms, PSO status, Claude, logins, and updates." actions={
        <>
          <Link href="/settings/email" className="btn">Email</Link>
          <Link href="/settings/network" className="btn">Use from another computer</Link>
          <Link href="/settings/updates" className="btn">Updates</Link>
        </>
      } />
      {saved && <Notice>{ai ? `Connected to Claude (${ai}).` : "Saved."}</Notice>}
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
        <h2 className="mt-2 font-semibold sm:col-span-2">Patient Safety Organization</h2>
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
          <Field label={keyHint ? "Replace key" : "API key"} className="sm:col-span-2"><input name="apiKey" type="password" className="field font-mono" placeholder="sk-ant-…" autoComplete="off" required /></Field>
          <Field label="Model" hint="Leave as is unless told otherwise."><input name="ai_model" className="field font-mono" defaultValue={s.ai_model} /></Field>
          <div className="sm:col-span-3"><button className="btn btn-primary">Save and test</button></div>
        </form>
      </section>

      <section className="card max-w-3xl">
        <h2 className="mb-3 font-semibold">Logins</h2>
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

      <section className="card mt-6 max-w-3xl">
        <h2 className="mb-1 font-semibold">Network — other computers in the pharmacy</h2>
        <p className="mb-2 text-sm text-ink-2">On another computer on the same network, open one of these addresses in the browser:</p>
        <ul className="mb-2 space-y-1 font-mono text-sm">
          {lanAddresses().map((a) => <li key={a}>http://{a}:{process.env.PORT ?? "3000"}</li>)}
          {lanAddresses().length === 0 && <li className="font-sans text-ink-3">No network address found on this computer.</li>}
        </ul>
        <p className="text-xs text-ink-3">The first time, Windows must be told to allow it: in the app folder, right-click <b>Allow on network</b> and choose "Run as administrator" (once). Only computers on the pharmacy's own network can reach it; nothing is exposed to the internet. Phone access from outside comes with the hosting step in the plan.</p>
      </section>

      <section className="card mt-6 max-w-3xl">
        <h2 className="mb-1 font-semibold">Backups</h2>
        <p className="text-sm text-ink-2">Everything lives in the <code>data</code> folder inside the app folder (database and uploaded files) plus the <code>.env</code> file (encryption keys). Copy both to the pharmacy's backup drive regularly; the app should be closed while copying. Without the <code>.env</code> keys, prescription numbers in the CQI records cannot be read back.</p>
      </section>
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
