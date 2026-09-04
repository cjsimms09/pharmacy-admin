"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { NAV, groupFor } from "@/lib/nav";

/**
 * The sidebar.
 *
 * Two levels, with only the group you are inside expanded. A flat list of every page would be
 * forty links to read every time; a list that hides everything behind a click is the memory test
 * this replaced. Showing the current group's pages is the middle: you can always see where you
 * are, what else is here, and what the next thing is — without a menu that has to be learnt.
 *
 * Client-side only because it needs the current path. Everything it renders is static data.
 */
export function Nav({ tools }: { tools: boolean }) {
  const pathname = usePathname() || "/";
  const active = groupFor(pathname);
  const groups = tools
    ? [...NAV.slice(0, -1), { href: "/tools", label: "Tools", blurb: "Work in progress", items: [] }, NAV[NAV.length - 1]]
    : NAV;

  return (
    <nav className="px-2 pb-4">
      {groups.map((g) => {
        const open = active?.href === g.href;
        const here = pathname === g.href;
        return (
          <div key={g.href} className="mb-0.5">
            <Link
              href={g.href}
              className={`block rounded-md px-3 py-1.5 text-sm transition-colors ${
                here || open
                  ? "bg-accent-soft font-semibold text-accent"
                  : "text-ink-2 hover:bg-ground hover:text-ink"
              }`}
            >
              {g.label}
            </Link>
            {open && g.items.length > 0 && (
              <ul className="mb-1 mt-0.5 space-y-px border-l border-line pl-2 ml-3">
                {g.items.map((i) => {
                  const on = pathname === i.href || pathname.startsWith(`${i.href}/`);
                  return (
                    <li key={i.href}>
                      <Link
                        href={i.href}
                        className={`block rounded-md px-2.5 py-1 text-[13px] transition-colors ${
                          on ? "bg-ground font-medium text-ink" : "text-ink-3 hover:bg-ground hover:text-ink-2"
                        }`}
                      >
                        {i.label}
                      </Link>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        );
      })}
    </nav>
  );
}
