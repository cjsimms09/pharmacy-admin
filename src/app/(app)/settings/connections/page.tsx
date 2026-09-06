import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { requireManager } from "@/lib/auth";
import { audit } from "@/lib/audit";
import { setSetting, type SettingKey } from "@/lib/settings";
import { CONNECTIONS, connectionState, saveSecret, clearSecret } from "@/lib/connections";
import { PageHeader, Notice, BackLink, Field, Card } from "@/components/ui";

export const metadata = { title: "Connections" };
export const dynamic = "force-dynamic";

export default async function ConnectionsPage({ searchParams }: { searchParams: Promise<{ saved?: string; error?: string }> }) {
  await requireManager();
  const { saved, error } = await searchParams;
  const conns = await connectionState();

  async function save(fd: FormData) {
    "use server";
    const u = await requireManager();
    const id = String(fd.get("id") ?? "") as (typeof CONNECTIONS)[number]["id"];
    const conn = CONNECTIONS.find((c) => c.id === id);
    if (!conn) redirect("/settings/connections?error=" + encodeURIComponent("Unknown connection."));

    // Plain fields first: these save even when no new key is being pasted, so a folder or
    // payee ID can be corrected without re-entering the credential.
    for (const f of conn.fields) {
      const v = fd.get(f.key);
      if (typeof v === "string") await setSetting(f.key as SettingKey, v.trim());
    }

    const secret = String(fd.get("secret") ?? "").trim();
    const secret2 = String(fd.get("secret2") ?? "").trim();
    if (secret || secret2) {
      try {
        await saveSecret(id, secret, secret2);
      } catch (e) {
        redirect("/settings/connections?error=" + encodeURIComponent(e instanceof Error ? e.message : "Could not store that."));
      }
      await audit({ action: "connection.secret.set", userId: u.id, userName: u.name, details: id });
    } else {
      await audit({ action: "connection.update", userId: u.id, userName: u.name, details: id });
    }
    revalidatePath("/settings/connections");
    redirect("/settings/connections?saved=" + encodeURIComponent(conn.name));
  }

  async function remove(fd: FormData) {
    "use server";
    const u = await requireManager();
    const id = String(fd.get("id") ?? "") as (typeof CONNECTIONS)[number]["id"];
    await clearSecret(id);
    await audit({ action: "connection.secret.clear", userId: u.id, userName: u.name, details: id });
    revalidatePath("/settings/connections");
    redirect("/settings/connections?saved=" + encodeURIComponent("Key removed"));
  }

  return (
    <>
      <BackLink href="/settings">Settings</BackLink>
      <PageHeader
        title="Connections"
        subtitle="API keys and credentials for outside services. Everything here is encrypted on this machine and never shown again once saved."
      />

      {saved && <Notice kind="ok">Saved — {saved}.</Notice>}
      {error && <Notice kind="crit">{error}</Notice>}

      <div className="mt-4 space-y-4">
        {conns.map((c) => (
          <section key={c.id} className="rounded-lg border border-line bg-surface p-4">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <h2 className="text-base font-semibold">{c.name}</h2>
              <span className="text-xs">
                {c.hint && (!c.secondSecretKey || c.secondHint) ? (
                  <span className="rounded bg-emerald-50 px-2 py-0.5 text-emerald-800">
                    Stored · {c.hint}{c.secondHint ? ` · ${c.secondHint}` : ""}
                  </span>
                ) : c.hint || c.secondHint ? (
                  <span className="rounded bg-amber-50 px-2 py-0.5 text-amber-900">Only half stored — both parts are needed</span>
                ) : (
                  <span className="rounded bg-amber-50 px-2 py-0.5 text-amber-900">Nothing stored</span>
                )}
              </span>
            </div>
            <p className="mt-1 text-sm text-ink-2">{c.what}</p>
            <p className="mt-1 text-xs text-ink-3">
              <span className="font-medium">Where to get it:</span> {c.where}
            </p>

            <form action={save} className="mt-3 space-y-3">
              <input type="hidden" name="id" value={c.id} />
              <Field
                label={c.hint ? `Replace the ${(c.secretLabel ?? "key").toLowerCase()}` : (c.secretLabel ?? "API key")}
                hint={c.hint ? "Leave blank to keep the one already stored." : undefined}
              >
                <input
                  name="secret"
                  type="password"
                  autoComplete="off"
                  placeholder={c.hint ? "•••••••• (unchanged)" : "Paste it here"}
                  className="w-full rounded-md border border-line px-3 py-2 text-sm"
                />
              </Field>

              {c.secondSecretKey && (
                <Field
                  label={c.secondHint ? `Replace the ${(c.secondSecretLabel ?? "secret").toLowerCase()}` : (c.secondSecretLabel ?? "Secret")}
                  hint={c.secondHint ? "Leave blank to keep the one already stored." : "Both parts are needed."}
                >
                  <input
                    name="secret2"
                    type="password"
                    autoComplete="off"
                    placeholder={c.secondHint ? "•••••••• (unchanged)" : "Paste it here"}
                    className="w-full rounded-md border border-line px-3 py-2 text-sm"
                  />
                </Field>
              )}

              {c.fields.map((f) => (
                <Field key={f.key} label={f.label} hint={f.hint}>
                  <input
                    name={f.key}
                    defaultValue={c.values[f.key] ?? ""}
                    placeholder={f.placeholder}
                    className="w-full rounded-md border border-line px-3 py-2 text-sm"
                  />
                </Field>
              ))}

              <div className="flex gap-2">
                <button className="btn btn-primary">Save</button>
              </div>
            </form>

            {c.more && (
              <p className="mt-3 text-xs">
                <a href={c.more.href} className="underline">{c.more.label} &rarr;</a>
              </p>
            )}

            {c.id === "mtf" && (
              <p className="mt-3 text-xs">
                <a href="/remits/mtf" className="underline">Test the connection and download 835 files →</a>
              </p>
            )}

            {c.hint && (
              <form action={remove} className="mt-2">
                <input type="hidden" name="id" value={c.id} />
                <button className="text-xs text-ink-3 underline hover:text-ink">Remove the stored key</button>
              </form>
            )}
          </section>
        ))}
      </div>

      <Card title="How these are protected" className="mt-8  text-sm">        <ul className="mt-2 list-disc space-y-1 pl-5 text-ink-2">
          <li>Encrypted with AES-256-GCM using <code>APP_ENCRYPTION_KEY</code> from the <code>.env</code> file on this machine.</li>
          <li>Stored in the local database only. Nothing is sent anywhere except to the service the key belongs to.</li>
          <li>Never rendered back to a page — only the last four characters, so you can tell which key is loaded.</li>
          <li>
            If <code>APP_ENCRYPTION_KEY</code> is ever changed or lost, the stored keys become unreadable and have to be
            pasted again. That is by design: the database on its own is not enough to use them.
          </li>
        </ul>
      </Card>
    </>
  );
}
