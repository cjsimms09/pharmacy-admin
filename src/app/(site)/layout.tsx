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
  { href: "/v2/compliance", label: "Compliance" },
  { href: "/v2/documents", label: "Documents" },
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
        <div className="mx-auto flex max-w-6xl flex-nowrap items-center gap-4 px-4 py-3">
          <Link href="/v2/today" className="shrink-0 whitespace-nowrap text-[15px] font-semibold tracking-tight text-ink">
            West Wichita
          </Link>
          <nav className="flex min-w-0 flex-nowrap items-center gap-1 overflow-x-auto text-[14px]">
            {NAV.map((n) => (
              <Link key={n.href} href={n.href} className="whitespace-nowrap rounded-md px-3 py-1.5 text-ink-2 hover:bg-ground hover:text-ink">
                {n.label}
              </Link>
            ))}
          </nav>
          <div className="ml-auto flex shrink-0 items-center gap-2 text-[13px] text-ink-3">
            <Link href="/" className="whitespace-nowrap rounded-md px-2 py-1 hover:bg-ground hover:text-ink" title="Every page of the site you know, untouched, until each one's job is on a new screen">
              Old site
            </Link>
            <Link href="/settings" aria-label="Settings" className="rounded-md px-2 py-1 hover:bg-ground hover:text-ink">
              ⚙
            </Link>
            <span className="hidden whitespace-nowrap md:inline">{user.name}</span>
            <form action={signOut}>
              <button className="whitespace-nowrap rounded-md px-2 py-1 hover:bg-ground hover:text-ink" type="submit">
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
