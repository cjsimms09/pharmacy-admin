import Link from "next/link";
import { redirect } from "next/navigation";
import { requireUser, logout } from "@/lib/auth";
import { noteRequest } from "@/lib/activity";

/**
 * The new site's frame: five screens and a gear, nothing else.
 *
 * docs/REBUILD.md. Today is the first screen built; until the others exist, their links reach the old pages that
 * do their job, so nothing he needs is ever further than one press away while the rest is built.
 */
const NAV = [
  { href: "/v2/today", label: "Today" },
  { href: "/v2/money", label: "Money" },
  { href: "/v2/claims", label: "Claims" },
  { href: "/compliance", label: "Compliance" },
  { href: "/inbox", label: "Documents" },
];

export default async function SiteLayout({ children }: { children: React.ReactNode }) {
  noteRequest();
  const user = await requireUser();

  async function signOut() {
    "use server";
    await logout();
    redirect("/login");
  }

  return (
    <div className="min-h-screen bg-ground text-ink">
      <header className="border-b border-line bg-surface">
        <div className="mx-auto flex max-w-6xl items-center gap-6 px-4 py-3">
          <Link href="/v2/today" className="text-[15px] font-semibold tracking-tight text-ink">
            West Wichita
          </Link>
          <nav className="flex items-center gap-1 text-[14px]">
            {NAV.map((n) => (
              <Link key={n.href} href={n.href} className="rounded-md px-3 py-1.5 text-ink-2 hover:bg-ground hover:text-ink">
                {n.label}
              </Link>
            ))}
          </nav>
          <div className="ml-auto flex items-center gap-3 text-[13px] text-ink-3">
            <Link href="/settings" aria-label="Settings" className="rounded-md px-2 py-1 hover:bg-ground hover:text-ink">
              ⚙
            </Link>
            <span>{user.name}</span>
            <form action={signOut}>
              <button className="rounded-md px-2 py-1 hover:bg-ground hover:text-ink" type="submit">
                Sign out
              </button>
            </form>
          </div>
        </div>
      </header>
      <main className="mx-auto max-w-6xl px-4 py-6">{children}</main>
    </div>
  );
}
