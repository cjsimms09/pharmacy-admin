import Link from "next/link";
import { redirect } from "next/navigation";
import { requireUser, logout } from "@/lib/auth";

const NAV = [
  { href: "/", label: "Dashboard" },
  { href: "/staff", label: "Staff & licenses" },
  { href: "/documents", label: "Documents" },
  { href: "/cqi", label: "CQI program" },
  { href: "/inventory", label: "CS inventories" },
  { href: "/settings", label: "Settings" },
  { href: "/audit", label: "Audit log" },
];

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const user = await requireUser();

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
          {NAV.map((n) => (
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
