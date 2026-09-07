import Link from "next/link";
import { redirect } from "next/navigation";
import { requireUser, logout } from "@/lib/auth";
import { reimbursementEnabled } from "@/lib/features";
import { noteRequest } from "@/lib/activity";
import { TopNav, SubNav } from "@/components/nav";
import { SendToClaude } from "@/components/send-to-claude";
import { Crumbs } from "@/components/crumbs";
import { logo } from "@/lib/branding";
import { getSettings } from "@/lib/settings";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  noteRequest();
  const user = await requireUser();
  const [showTools, mark, s] = await Promise.all([reimbursementEnabled(), logo(), getSettings()]);
  const today = new Date().toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", year: "numeric" });

  async function signOut() {
    "use server";
    await logout();
    redirect("/login");
  }

  return (
    <div className="min-h-screen">
      {/*
        The head of the site: the pharmacy's own mark, six words, the search, and the person.

        One bar across the top rather than a column down the side. The column was dark and held
        fifty links; this holds six, and the page has the whole width of the screen under it.
      */}
      <header className="site-head no-print">
        <div className="site-row">
          <Link href="/" className="flex shrink-0 items-center gap-2.5">
            {mark ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={mark.url} alt={s.pharmacy_name || "Pharmacy Admin"} className="h-8 w-auto max-w-[160px] object-contain" />
            ) : (
              <>
                <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-accent text-sm font-bold text-white">Rx</span>
                <span className="text-base font-semibold tracking-tight text-ink">{s.pharmacy_name || "Pharmacy Admin"}</span>
              </>
            )}
          </Link>
          <TopNav tools={showTools} />
          <div className="ml-auto flex shrink-0 items-center gap-3">
            {/*
              On every screen, because the moment it is needed is not a moment for navigating to it:
              the one thing that works when you know what you want and not where it lives.
            */}
            <form action="/find">
              <input name="q" type="search" placeholder="Find anything…" aria-label="Find anything in the site" className="field h-9 w-44 rounded-full" />
            </form>
            {/* The inbox on every page: what arrived is looked at several times a day, from anywhere. */}
            <Link href="/inbox" className="btn btn-sm">Inbox</Link>
            <SendToClaude />
            <div className="hidden text-right text-xs leading-tight text-ink-2 lg:block">
              <div className="font-medium text-ink">{user.name}</div>
              <div className="capitalize">{user.role}</div>
            </div>
            <form action={signOut}><button className="btn btn-sm">Sign out</button></form>
          </div>
        </div>
        <SubNav tools={showTools} />
      </header>
      <main className="page">
        <div className="topbar no-print">
          <Crumbs />
          <div className="hidden items-center gap-3 sm:flex">
            <span className="tabular-nums">{today}</span>
          </div>
        </div>
        {children}
      </main>
    </div>
  );
}
