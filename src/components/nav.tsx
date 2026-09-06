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
            {/*
              The group you are in is marked by a rule down its edge as well as by its colour.
              
              A tinted pill on its own is a weak signal in a column of them — the eye reads the
              block of colour before it reads which block. A bar against the margin says "here"
              from the corner of the eye, which is the only way a sidebar is ever actually read.
            */}
            <Link
              href={g.href}
              className={`relative block rounded-md py-1.5 pl-3 pr-3 text-sm transition-colors ${
                here || open
                  ? "bg-accent-soft font-semibold text-accent before:absolute before:inset-y-1 before:-left-1 before:w-[3px] before:rounded-full before:bg-accent"
                  : "text-ink-2 hover:bg-ground hover:text-ink"
              }`}
            >
              {g.label}
            </Link>
            {open && g.items.length > 0 && (
              <ul className="mb-2 ml-3 mt-1 space-y-px border-l border-line pl-2">
                {g.items.map((i) => {
                  const on = pathname === i.href || pathname.startsWith(`${i.href}/`);
                  return (
                    <li key={i.href}>
                      <Link
                        href={i.href}
                        className={`block rounded-md px-2.5 py-1 text-[13px] transition-colors ${
                          on ? "bg-ground font-semibold text-ink" : "text-ink-3 hover:bg-ground hover:text-ink-2"
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
