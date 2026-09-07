"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { groupFor, itemFor } from "@/lib/nav";

/**
 * Where you are, in the top bar: the section, then the page.
 *
 * The sidebar already shows this, but the sidebar is at the edge of vision and the top bar is
 * where the eye starts a page. The page's own title is below in the header; this is the address.
 */
export function Crumbs() {
  const pathname = usePathname() || "/";
  const g = groupFor(pathname);
  if (!g) return <div className="crumb"><span className="crumb-here">Pharmacy Admin</span></div>;
  const found = itemFor(pathname);
  const item = found?.item;
  const tab = found?.tab;
  const leaf = tab?.href ?? item?.href ?? g.href;
  const deeper = pathname !== leaf;
  return (
    <div className="crumb">
      <Link href={g.href}>{g.label}</Link>
      {item && (
        <>
          <span className="crumb-sep">/</span>
          {deeper || tab ? <Link href={item.href}>{item.label}</Link> : <span className="crumb-here">{item.label}</span>}
        </>
      )}
      {tab && (
        <>
          <span className="crumb-sep">/</span>
          {deeper ? <Link href={tab.href}>{tab.label}</Link> : <span className="crumb-here">{tab.label}</span>}
        </>
      )}
      {deeper && (
        <>
          <span className="crumb-sep">/</span>
          <span className="crumb-here">{humanise(pathname.slice(leaf.length))}</span>
        </>
      )}
    </div>
  );
}

// The rest of the path as words: "/2026-09/print" → "2026-09 · print".
function humanise(rest: string): string {
  return rest.split("/").filter(Boolean).map((s) => decodeURIComponent(s).replace(/[-_]+/g, " ")).join(" · ") || "";
}
