"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { NAV, groupFor, itemFor } from "@/lib/nav";

/**
 * The head of the site: six words across the top, and under them the pages of the one you are in.
 *
 * A dark sidebar of fifty links was the thing the owner could not read. This is a bar with six
 * entries, and a second, lighter row that appears only inside a group and holds the pages
 * somebody opens on a normal day; the rest of the group is behind "more". Where you are is the
 * word with the line under it and the pill in the second row.
 */
/*
 * A link that lands on Today is worse than no link. The reimbursement pages redirect home while
 * the flag is off, so their entries are dropped rather than left to fail silently.
 */
const visibleGroups = (tools: boolean) => NAV.map((g) => ({ ...g, items: tools ? g.items : g.items.filter((i) => !i.gated) })).filter((g, i) => NAV[i].items.length === 0 || g.items.length > 0);

/** The six words. */
export function TopNav({ tools }: { tools: boolean }) {
  const pathname = usePathname() || "/";
  const active = groupFor(pathname);
  return (
    <nav className="flex items-center gap-5" aria-label="Sections">
      {visibleGroups(tools).map((g) => (
        <Link key={g.href} href={g.href} className={`nav-group ${active?.href === g.href ? "on" : ""}`} aria-current={pathname === g.href ? "page" : undefined}>
          {g.label}
        </Link>
      ))}
    </nav>
  );
}

/** The second row: the pages of the group you are in, and "more" for the rest. Nothing outside a group. */
export function SubNav({ tools }: { tools: boolean }) {
  const pathname = usePathname() || "/";
  const active = groupFor(pathname);
  const isOn = (href: string) => pathname === href || itemFor(pathname)?.item.href === href;
  const open = visibleGroups(tools).find((g) => g.href === active?.href);
  const listed = open?.items.filter((i) => !i.hidden) ?? [];
  const more = open?.items.filter((i) => i.hidden) ?? [];
  if (!open || open.items.length === 0) return null;
  return (
    <>
      {(
        <div className="nav-sub">
          {/*
            The pills scroll; the menu must not be inside the thing that scrolls.

            "more" is a <details> whose panel is absolutely positioned below the row. It was a child
            of the row itself, and that row carries overflow-x-auto for narrow screens — which
            establishes a clipping box on *both* axes, not just the one named. So the panel opened
            forty-odd pixels down inside a forty-four pixel box and was cut off entirely: the arrow
            turned, nothing appeared, and every group's menu was dead in the same way.

            So the scrolling moved inward, onto the pills alone, and the menu sits outside it.
          */}
          <div className="site-row h-11 gap-1.5">
            <div className="flex min-w-0 flex-1 items-center gap-1.5 overflow-x-auto">
            {listed.map((i) => (
              <Link key={i.href} href={i.href} className={`nav-item ${isOn(i.href) ? "on" : ""}`} aria-current={isOn(i.href) ? "page" : undefined}>
                {i.label}
              </Link>
            ))}
            {/* A hidden page you are on gets a pill of its own, so the highlight is never inside a closed menu. */}
            {more.filter((i) => isOn(i.href)).map((i) => (
              <Link key={i.href} href={i.href} className="nav-item on" aria-current="page">
                {i.label}
              </Link>
            ))}
            </div>
            {more.length > 0 && (
              <details className="nav-more">
                <summary>more ▾</summary>
                <div>
                  {more.map((i) => (
                    <Link key={i.href} href={i.href} className={isOn(i.href) ? "on" : ""}>
                      {i.label}
                    </Link>
                  ))}
                </div>
              </details>
            )}
          </div>
        </div>
      )}
    </>
  );
}
