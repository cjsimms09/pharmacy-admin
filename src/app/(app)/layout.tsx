import Link from "next/link";
import { redirect } from "next/navigation";
import { requireUser, logout } from "@/lib/auth";
import { reimbursementEnabled } from "@/lib/features";
import { noteRequest } from "@/lib/activity";

/**
 * What a pharmacist-in-charge needs to hand every day, and nothing else.
 *
 * The money side — payers, claims, plans, NADAC, purchasing — is real work in progress but it is
 * not usable yet, and six menu items that do nothing are six small irritations every single day.
 * They live under Tools until they earn a place here.
 */
const NAV = [
  { href: "/", label: "Today" },
  { href: "/compliance", label: "Compliance" },
  { href: "/cqi", label: "CQI program" },
  { href: "/staff", label: "Staff" },
  { href: "/documents", label: "Documents" },
  // Where emailed reports land — temperature logs among them, so it belongs in the daily path.
  { href: "/inbox", label: "Inbox" },
  { href: "/inventory", label: "CS inventories" },
  { href: "/settings", label: "Settings" },
];

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  noteRequest();
  const user = await requireUser();
  const showTools = await reimbursementEnabled();
  const nav = showTools ? [...NAV.slice(0, -1), { href: "/tools", label: "Tools" }, NAV[NAV.length - 1]] : NAV;

  async function signOut() {
    "use server";
    await logout();
    redirect("/login");
  }

  return (
    <div className="min-h-screen md:grid md:grid-cols-[220px_1fr]">
      <aside className="no-print border-b border-line bg-surface md:border-b-0 md:border-r">
        <div className="px-4 py-4">
          <Link href="/" className="text-base font-bold tracking-tight">Pharmacy Admin</Link>
          <div className="mt-0.5 text-xs text-ink-3">Compliance desk</div>
        </div>
        <nav className="flex gap-1 overflow-x-auto px-2 pb-2 md:flex-col md:pb-0">
          {nav.map((n) => (
            <Link key={n.href} href={n.href} className="whitespace-nowrap rounded-md px-3 py-2 text-sm text-ink-2 hover:bg-ground hover:text-ink">
              {n.label}
            </Link>
          ))}
        </nav>
        <div className="mt-2 border-t border-line px-4 py-3 text-xs text-ink-3 md:absolute md:bottom-0 md:w-[220px]">
          <div className="truncate text-ink-2">{user.name}</div>
          <div className="capitalize">{user.role}</div>
          <form action={signOut}><button className="mt-1 underline hover:text-ink">Sign out</button></form>
        </div>
      </aside>
      <main className="min-w-0 px-4 py-6 md:px-8">{children}</main>
    </div>
  );
}
