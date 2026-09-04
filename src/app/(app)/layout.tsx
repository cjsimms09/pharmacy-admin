import Link from "next/link";
import { redirect } from "next/navigation";
import { requireUser, logout } from "@/lib/auth";
import { reimbursementEnabled } from "@/lib/features";
import { noteRequest } from "@/lib/activity";
import { Nav } from "@/components/nav";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  noteRequest();
  const user = await requireUser();
  const showTools = await reimbursementEnabled();

  async function signOut() {
    "use server";
    await logout();
    redirect("/login");
  }

  return (
    <div className="min-h-screen md:grid md:grid-cols-[228px_1fr]">
      {/*
        The sidebar sticks and scrolls on its own. It got taller when the pages under each group
        became visible, and a footer pinned to the bottom of a column that now overflows is a
        sign-out button you cannot reach.
      */}
      <aside className="no-print border-b border-line bg-surface md:sticky md:top-0 md:flex md:h-screen md:flex-col md:border-b-0 md:border-r">
        <div className="shrink-0 px-4 py-4">
          <Link href="/" className="text-base font-bold tracking-tight">Pharmacy Admin</Link>
          <div className="mt-0.5 text-xs text-ink-3">Compliance desk</div>
        </div>
        <div className="md:min-h-0 md:flex-1 md:overflow-y-auto">
          <Nav tools={showTools} />
        </div>
        <div className="shrink-0 border-t border-line px-4 py-3 text-xs text-ink-3">
          <div className="truncate text-ink-2">{user.name}</div>
          <div className="capitalize">{user.role}</div>
          <form action={signOut}><button className="mt-1 underline hover:text-ink">Sign out</button></form>
        </div>
      </aside>
      <main className="min-w-0 px-4 py-6 md:px-8">{children}</main>
    </div>
  );
}
