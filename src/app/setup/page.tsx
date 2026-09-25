import { redirect } from "next/navigation";
import { sql } from "drizzle-orm";
import { db, dbReady, schema } from "@/db";
import { createUser, login } from "@/lib/auth";
import { audit } from "@/lib/audit";
import { Field } from "@/components/ui";

export const metadata = { title: "First-time setup" };
export const dynamic = "force-dynamic";

async function userCount() {
  await dbReady;
  return (await db.select({ n: sql<number>`count(*)` }).from(schema.users))[0].n;
}

/** First run: create the owner login in the browser. Only reachable while no logins exist. */
export default async function SetupPage({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  if ((await userCount()) > 0) redirect("/login");
  const { error } = await searchParams;

  async function create(fd: FormData) {
    "use server";
    if ((await userCount()) > 0) redirect("/login");
    const name = String(fd.get("name") ?? "").trim();
    const username = String(fd.get("username") ?? "").trim().toLowerCase();
    const password = String(fd.get("password") ?? "");
    const confirm = String(fd.get("confirm") ?? "");
    if (!name || !/^[a-z0-9._-]{2,40}$/.test(username)) redirect("/setup?error=" + encodeURIComponent("Enter your name and a username (letters and numbers, no spaces)."));
    if (password.length < 12) redirect("/setup?error=" + encodeURIComponent("Use a password of at least 12 characters."));
    if (password !== confirm) redirect("/setup?error=" + encodeURIComponent("The passwords don't match."));
    const id = await createUser({ name, username, password, role: "owner" });
    await audit({ action: "setup.owner_created", userId: id, userName: name });
    await login(username, password);
    redirect("/settings?saved=1");
  }

  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center px-4">
      <div className="card">
        <h1 className="text-xl font-bold">Welcome to Pharmacy Admin</h1>
        <p className="mt-1 text-sm text-ink-2">Create the owner login. You can add logins for other staff later under Settings.</p>
        {error && <p className="mt-3 rounded-md bg-crit-soft px-3 py-2 text-sm text-crit">{error}</p>}
        <form action={create} className="mt-4 space-y-3">
          <Field label="Your name"><input name="name" className="field" required autoFocus /></Field>
          <Field label="Username" hint="Lowercase, no spaces. You'll type this to sign in."><input name="username" className="field" required autoComplete="username" /></Field>
          <Field label="Password" hint="At least 12 characters. Save it in your password manager."><input name="password" type="password" className="field" required minLength={12} autoComplete="new-password" /></Field>
          <Field label="Confirm password"><input name="confirm" type="password" className="field" required minLength={12} autoComplete="new-password" /></Field>
          <button className="btn btn-primary w-full justify-center" type="submit">Create owner login</button>
        </form>
      </div>
    </main>
  );
}
