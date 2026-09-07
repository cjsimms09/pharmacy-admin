import Link from "next/link";
import { redirect } from "next/navigation";
import { requireUser, logout } from "@/lib/auth";
import { reimbursementEnabled } from "@/lib/features";
import { noteRequest } from "@/lib/activity";
import { Nav } from "@/components/nav";
import { SendToClaude } from "@/components/send-to-claude";
import { logo } from "@/lib/branding";
import { getSettings } from "@/lib/settings";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  noteRequest();
  const user = await requireUser();
  const [showTools, mark, s] = await Promise.all([reimbursementEnabled(), logo(), getSettings()]);

  async function signOut() {
    "use server";
    await logout();
    redirect("/login");
  }

  return (
    <div className="app-shell min-h-screen md:grid md:grid-cols-[228px_1fr]">
      {/*
        The sidebar sticks and scrolls on its own. It got taller when the pages under each group
        became visible, and a footer pinned to the bottom of a column that now overflows is a
        sign-out button you cannot reach.
      */}
      <aside className="no-print border-b border-line bg-surface md:sticky md:top-0 md:flex md:h-screen md:flex-col md:border-b-0 md:border-r">
        <div className="shrink-0 px-4 py-4">
          {/*
            The pharmacy's own mark, where the product name used to be alone.

            This is one pharmacy's system, on one pharmacy's computer, and the person using it does
            not need reminding what software they are looking at. Their own name at the top is what
            makes it read as theirs — and it is the same image that goes on everything the site
            prints, so the screen and the paper agree.
          */}
          <Link href="/" className="block">
            {mark ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={mark.url} alt={s.pharmacy_name || "Pharmacy Admin"} className="max-h-11 w-auto max-w-full object-contain" />
            ) : (
              <span className="text-base font-bold tracking-tight">Pharmacy Admin</span>
            )}
          </Link>
          {/*
            What this is, in the pharmacy's own terms.

            It said "Compliance desk", which was true when compliance was all it did and is now
            most of the way to an insult: the system runs the claims, the buying, the rebates and
            the month's profit. A tool that describes itself as the smallest thing it does teaches
            its owner to think of it that way.
          */}
          <div className="mt-1 text-xs text-ink-3">{mark ? s.pharmacy_name || "Pharmacy desk" : "Compliance, claims and money"}</div>
          {/*
            On every screen, because the moment it is needed is not a moment for navigating to it.

            A menu is a map somebody has to have learned. This is the one thing on the page that
            works when you know what you want and not where it lives — which is the position the
            pharmacist-in-charge is in when an inspector asks for something by name.
          */}
          <form action="/find" className="mt-3">
            <input
              name="q"
              type="search"
              placeholder="Find anything…"
              aria-label="Find anything in the site"
              className="field w-full py-1.5 text-sm"
            />
          </form>
        </div>
        <div className="md:min-h-0 md:flex-1 md:overflow-y-auto">
          <Nav tools={showTools} />
        </div>
        <div className="shrink-0 border-t border-line px-4 py-3 text-xs text-ink-3">
          <div className="truncate text-ink-2">{user.name}</div>
          <div className="capitalize">{user.role}</div>
          <form action={signOut}><button className="mt-1 underline hover:text-ink">Sign out</button></form>
          {/*
            On every page, in one place that never moves.

            The export was added a page at a time and reached eleven of a hundred and one — and the
            ninety it missed are exactly the ones where something looked wrong and there was no way
            to send it. In the frame it is always there, and it takes the page's own path and
            filters with it so the file answers the question that was on the screen.
          */}
          <SendToClaude />
        </div>
      </aside>
      <main className="min-w-0 px-4 py-6 md:px-8">{children}</main>
    </div>
  );
}
