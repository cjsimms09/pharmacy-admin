import { redirect } from "next/navigation";
import { sql } from "drizzle-orm";
import { db, schema } from "@/db";
import { getCurrentUser, login } from "@/lib/auth";
import { SubmitButton } from "@/components/submit-button";

export const metadata = { title: "Sign in" };

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  const user = await getCurrentUser();
  if (user) redirect("/");
  if ((await db.select({ n: sql<number>`count(*)` }).from(schema.users))[0].n === 0) redirect("/setup");
  const { error } = await searchParams;

  async function action(formData: FormData) {
    "use server";
    const username = String(formData.get("username") ?? "");
    const password = String(formData.get("password") ?? "");
    const r = await login(username, password);
    if (!r.ok) redirect(`/login?error=${encodeURIComponent(r.error)}`);
    redirect("/");
  }

  return (
    <main className="mx-auto flex min-h-screen max-w-sm flex-col justify-center px-4">
      <div className="card">
        <h1 className="text-xl font-bold">Pharmacy Admin</h1>
        <p className="mt-1 text-sm text-ink-2">Sign in to continue.</p>
        {error && <p className="mt-3 rounded-md bg-crit-soft px-3 py-2 text-sm text-crit">{error}</p>}
        <form action={action} className="mt-4 space-y-3">
          <div>
            <label className="label" htmlFor="username">Username</label>
            <input id="username" name="username" className="field" autoComplete="username" required autoFocus />
          </div>
          <div>
            <label className="label" htmlFor="password">Password</label>
            <input id="password" name="password" type="password" className="field" autoComplete="current-password" required />
          </div>
          {/*
            A button that admits it is working, and cannot be pressed twice.

            It was a plain submit, so a sign-in that took twenty seconds looked identical to one
            that did nothing — and he pressed again. Every press had logged him in; each new one
            cancelled the page the last one was opening. Thirteen successful sign-ins in two
            minutes on 15 September, and the report was "I hit sign in and nothing happens".
          */}
          <SubmitButton
            className="btn btn-primary w-full justify-center"
            pendingLabel="Signing in…"
            hint="This can take up to half a minute when the site has just restarted. It is working — there is no need to press again."
          >
            Sign in
          </SubmitButton>
        </form>
      </div>
      <p className="mt-4 text-center text-xs text-ink-3">No patient information is stored in this system.</p>
    </main>
  );
}
