import { redirect } from "next/navigation";
import { getCurrentUser, login } from "@/lib/auth";

export const metadata = { title: "Sign in" };

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  const user = await getCurrentUser();
  if (user) redirect("/");
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
          <button className="btn btn-primary w-full justify-center" type="submit">Sign in</button>
        </form>
      </div>
      <p className="mt-4 text-center text-xs text-ink-3">No patient information is stored in this system.</p>
    </main>
  );
}
