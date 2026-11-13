import Link from "next/link";
import { NAV } from "@/lib/nav";

/**
 * A section's front door.
 *
 * A group in the sidebar with four pages under it needs somewhere to land when you click the
 * group itself, and "the first page in the list" is a guess that is wrong half the time. This
 * shows what is in the section and what each thing is for — read once, then never needed again,
 * which is the correct amount of attention for navigation.
 *
 * Driven from the same NAV data as the sidebar, so a page added to a group appears in both.
 */
export function Hub({ href, exclude = [], items: given }: { href: string; exclude?: string[]; /** Pages to list when the section is not a sidebar group of its own. */ items?: { href: string; label: string; blurb?: string }[] }) {
  const group = NAV.find((g) => g.href === href);
  const items = (given ?? group?.items ?? []).filter((i) => i.href !== href && !exclude.includes(i.href));
  if (items.length === 0) return null;
  return (
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
      {items.map((i) => (
        <Link key={i.href} href={i.href} className="card block transition-colors hover:border-accent">
          <h3>{i.label}</h3>
          {i.blurb && <p className="mt-1 text-xs leading-snug text-ink-3">{i.blurb}</p>}
        </Link>
      ))}
    </div>
  );
}
