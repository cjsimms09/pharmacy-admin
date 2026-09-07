"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { NAV, groupFor, itemFor } from "@/lib/nav";
import { Icon, iconFor } from "./icons";

/**
 * The sidebar.
 *
 * Two levels, with only the group you are inside expanded. A flat list of every page would be
 * forty links to read every time; a list that hides everything behind a click is the memory test
 * this replaced. Showing the current group's pages is the middle: you can always see where you
 * are, what else is here, and what the next thing is — without a menu that has to be learnt.
 *
 * Each group has an icon, so it is found by shape from the corner of the eye, and the group you
 * are in carries a rule down its edge as well as its colour.
 */
export function Nav({ tools }: { tools: boolean }) {
  const pathname = usePathname() || "/";
  const active = groupFor(pathname);
  /*
   * A link that lands on Today is worse than no link. The reimbursement pages redirect home while
   * the flag is off, so their entries are dropped rather than left to fail silently; a group whose
   * every page is behind the flag has nowhere to land, so it goes with them.
   */
  const visible = tools ? NAV : NAV.map((g) => ({ ...g, items: g.items.filter((i) => !i.gated) }));
  const groups = visible.filter((g, i) => NAV[i].items.length === 0 || g.items.length > 0 || !NAV[i].items.every((it) => it.gated));
  // The item the page lives under, by the same rule as the breadcrumb — never a prefix, so Staff is not lit on New employee.
  const isOn = (href: string) => pathname === href || itemFor(pathname)?.item.href === href;

  return (
    <nav className="px-2 pb-4" aria-label="Sections">
      {groups.map((g) => {
        const open = active?.href === g.href;
        const here = pathname === g.href;
        return (
          <div key={g.href} className="mb-px">
            <Link href={g.href} className={`side-group ${here || open ? "on" : ""}`} aria-current={here ? "page" : undefined}>
              <Icon name={iconFor(g.href)} />
              <span className="truncate">{g.label}</span>
            </Link>
            {open && g.items.length > 0 && (
              <ul className="mb-2 ml-[1.35rem] mt-0.5 space-y-px border-l border-[color:var(--color-side-line)] pl-2">
                {g.items.filter((i) => !i.hidden).map((i) => (
                  <li key={i.href}>
                    <Link href={i.href} className={`side-item ${isOn(i.href) ? "on" : ""}`} aria-current={isOn(i.href) ? "page" : undefined}>
                      {i.label}
                    </Link>
                  </li>
                ))}
                {/*
                  The rest of the group, folded. Open when the page you are on is one of them, so
                  the highlight is never on a link you cannot see.
                */}
                {g.items.some((i) => i.hidden) && (
                  <li>
                    <details open={g.items.some((i) => i.hidden && isOn(i.href))}>
                      <summary className="side-item cursor-pointer text-[color:var(--color-side-ink-2)]">more</summary>
                      <ul className="space-y-px">
                        {g.items.filter((i) => i.hidden).map((i) => (
                          <li key={i.href}>
                            <Link href={i.href} className={`side-item ${isOn(i.href) ? "on" : ""}`} aria-current={isOn(i.href) ? "page" : undefined}>
                              {i.label}
                            </Link>
                          </li>
                        ))}
                      </ul>
                    </details>
                  </li>
                )}
              </ul>
            )}
          </div>
        );
      })}
    </nav>
  );
}
