import Link from "next/link";
import { redirect } from "next/navigation";
import { requireUser, logout } from "@/lib/auth";
import { reimbursementEnabled } from "@/lib/features";
import { noteRequest } from "@/lib/activity";
import { TopNav, SubNav } from "@/components/nav";
import { SendToClaude } from "@/components/send-to-claude";
import { AddAnything } from "@/components/add-anything";
import { Crumbs } from "@/components/crumbs";
import { logo } from "@/lib/branding";
import { getSettings } from "@/lib/settings";
import { PublicAccessBanner } from "@/components/public-access-banner";

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
      {/* Above everything, including the pharmacy's own name: nothing on this page matters more. */}
      <PublicAccessBanner />
      {/*
        The head of the site: the pharmacy's own mark, six words, the search, and the person.

        One bar across the top rather than a column down the side. The column was dark and held
        fifty links; this holds six, and the page has the whole width of the screen under it.
      */}
      <header className="site-head no-print">
        {/*
          On a phone the bar is two rows: the mark and the three buttons used between patients, then the six words,
          which scroll sideways. It was one row of about a thousand pixels — the mark, six words, a search box, five
          buttons — on a screen of four hundred, so the page slid sideways under his thumb on every screen.
        */}
        <div className="site-row site-row-head">
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
          <div className="nav-scroll">
            <TopNav tools={showTools} />
          </div>
          <div className="ml-auto flex shrink-0 items-center gap-2 sm:gap-3">
            {/*
              On every screen, because the moment it is needed is not a moment for navigating to it:
              the one thing that works when you know what you want and not where it lives.
            */}
            <form action="/find" className="hidden md:block">
              <input name="q" type="search" placeholder="Find anything…" aria-label="Find anything in the site" className="field h-9 w-44 rounded-full" />
            </form>
            {/* The find page has its own box, so on a phone the search is one tap on a button rather than a field that does not fit. */}
            <Link href="/find" className="btn btn-sm md:hidden">Find</Link>
            {/* Add and Inbox on every page: what comes in is the whole of the day's paperwork. Add last, so its panel opens from the screen's edge. */}
            <Link href="/inbox" className="btn btn-sm">Inbox</Link>
            <AddAnything />
            <div className="hidden md:block">
              <SendToClaude />
            </div>
            <div className="hidden text-right text-xs leading-tight text-ink-2 lg:block">
              <div className="font-medium text-ink">{user.name}</div>
              <div className="capitalize">{user.role}</div>
            </div>
            <form action={signOut} className="hidden sm:block"><button className="btn btn-sm">Sign out</button></form>
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
        {/* Sign out has no room in a phone's top bar, so it is at the foot of every page there. */}
        <form action={signOut} className="no-print mt-10 flex items-center justify-between gap-3 border-t border-line pt-4 text-xs text-ink-3 sm:hidden">
          <span>
            Signed in as <b className="font-medium text-ink-2">{user.name}</b>
          </span>
          <button className="btn btn-sm">Sign out</button>
        </form>
      </main>
    </div>
  );
}
