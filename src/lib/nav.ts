/**
 * The shape of the site.
 *
 * Three questions run the business: am I buying right, am I getting paid right, am I staying
 * compliant. The owner's verdict on 7 September, after the menu had grown to nine groups and
 * fifty pages: "this site has too many tools; I don't understand anything." So the sidebar is
 * the three questions, with Today in front, the books beside, and Settings behind: six entries.
 * Everything else still exists, one click further — under the group's "more" line, on its hub,
 * or linked from the page that needs it — but the menu no longer presents the plumbing as the
 * product.
 *
 * Plain data rather than markup, so the same structure drives the sidebar, the hub pages and
 * anywhere else that needs to know what belongs with what.
 *
 * ── The rules this has to keep obeying as the site grows ──
 *
 *   1. Six groups. A new area of the business earns a group; a new page never does. The test
 *      names them in order.
 *
 *   2. Eight listed items per group, and the list is the pages somebody opens on a normal day. A
 *      page that is opened monthly, or only after something else, is `hidden`: still in the group
 *      for the highlight and the breadcrumb, still on the hub, not in the list.
 *
 *   3. Group by what somebody came to do, not by what the thing is made of. Supplier invoices are
 *      under Buying because that is where the person reading one is, even though they are really
 *      a controlled substance record.
 *
 *   4. A page belongs to exactly one group. Cross-link from anywhere; list it once.
 *
 *   5. If a page is only ever reached from another page — a person's record, one month's
 *      temperatures, one incident — it is not in the menu at all.
 *
 *   6. Pages that are one thing seen from several sides are a family (`families.ts`): listed once
 *      here, by the page somebody opens first, and joined by a row of tabs on every page in it.
 */
import { FAMILIES, type FamilyTab } from "./families";

export type NavItem = {
  href: string;
  label: string;
  blurb?: string;
  /** Behind the "extra sections" flag: the page redirects to Today while it is off, so the link is not shown. */
  gated?: boolean;
  /**
   * In the group but not in the sidebar's list: reached from the group's "more" line, the hub and
   * the pages that need it. The sidebar highlight and the breadcrumb still know where it lives.
   */
  hidden?: boolean;
};
export type NavGroup = { href: string; label: string; blurb: string; items: NavItem[] };

export const NAV: NavGroup[] = [
  {
    href: "/",
    label: "Today",
    blurb: "What is due, what is late, what the money list says, and what happened while you were not looking.",
    items: [],
  },
  {
    /*
     * Am I buying right? The page the owner opens with the McKesson cart open in the other window:
     * what the primary's order would get wrong, and what to add to a secondary to reach its minimum.
     */
    href: "/purchasing",
    label: "Buying",
    blurb: "What the primary's order would get wrong today, and what to add to each secondary to reach its minimum.",
    items: [
      { href: "/purchasing", label: "What to add, what to watch", blurb: "Add-ons per secondary, ranked; which NDC pays; what was bought over NADAC", gated: true },
      { href: "/suppliers", label: "Suppliers and rebates", blurb: "Each wholesaler's minimum, ladder and ratio, and what this month's buying is earning" },
      { href: "/inventory/invoices", label: "Supplier invoices", blurb: "Filed by schedule, with the C2s kept apart" },
      { href: "/purchasing/replay", label: "Which contract", blurb: "A year of dispensing replayed through each wholesaler's catalogue and ladder", gated: true, hidden: true },
      { href: "/inventory/returns", label: "What to send back", blurb: "Return deadlines counted from the invoice, and what each is worth", hidden: true },
      { href: "/purchasing/supplies", label: "Supplies", blurb: "Vials, bags and labels: what is low and what to order", hidden: true },
    ],
  },
  {
    /* Am I getting paid right? The claims, the floor, and the contracts that decide the rest. */
    href: "/claims",
    label: "Getting paid",
    blurb: "Every dispensing and what it made; claims paid under the Kansas floor; the payers and their contracts.",
    items: [
      { href: "/claims", label: "Claims", blurb: "Every dispensing, what it made, and what is still owed on it", gated: true },
      { href: "/claims/floor", label: "Kansas floor", blurb: "Claims paid under NADAC plus the fee, the plans the floor reaches, and the appeals filed", gated: true },
      { href: "/payers", label: "Payers and contracts", blurb: "Every BIN we bill, its contract read once, its appeal route and its 835 routing", gated: true },
      { href: "/payers/performance", label: "Who pays best", blurb: "Every plan ranked by what it actually pays", gated: true, hidden: true },
      { href: "/remits/mtf", label: "Facilitator payments", blurb: "What the Medicare Transaction Facilitator has paid after the claim, and what is still awaited", gated: true, hidden: true },
    ],
  },
  {
    href: "/money",
    label: "Money",
    blurb: "The books: what the pharmacy earned, what reached the bank, what it cost, and what is left.",
    items: [
      { href: "/money", label: "The books", blurb: "The period on both bases, the statement, and how the months are moving" },
      { href: "/expenses", label: "Spending", blurb: "Bills, standing costs, the vendors who send them, and the rules that file them" },
      // Listed, not under "more": the owner enters the day's deliveries every day.
      { href: "/deliveries", label: "Driver invoices", blurb: "Today's deliveries, entered daily, and the monthly invoice that sends itself" },
      { href: "/money/found", label: "Money found", blurb: "Everything worth chasing, ranked, with what to do about each", hidden: true },
    ],
  },
  {
    /*
     * Am I staying compliant? The pharmacy session's pages, under one entry: the duties, the
     * licences, the people, the controlled substances, the inspection and the manual. The rest is
     * a click further, under "more".
     */
    href: "/compliance",
    label: "Compliance",
    blurb: "Every standing duty, the licences, the people, the controlled substances, the inspection, the manual, and the records behind them.",
    items: [
      { href: "/compliance", label: "Register", blurb: "Every standing duty, its cadence and its evidence" },
      { href: "/licenses", label: "Licences", blurb: "Registration, DEA, CSOS, KMAP, insurance, business licence" },
      { href: "/staff", label: "Staff", blurb: "Licences, certifications and documents, per person" },
      { href: "/compliance/training", label: "Training", blurb: "Send it, chase it, record the attestation; the file and the material behind it" },
      { href: "/inventory", label: "Controlled substances", blurb: "The annual count and Form C-250, with the log, the discrepancies and the power of attorney under it" },
      { href: "/inspection", label: "Inspection", blurb: "By inspector: Board, DEA, what each would ask, and the walk round with findings closed" },
      { href: "/manual", label: "P&P manual", blurb: "One document, read and edited by chapter, printed from the live copy" },
      { href: "/records", label: "Records", blurb: "Forms, agreements, attestations and documents, and where each lives" },
      { href: "/cqi", label: "Quality (CQI)", blurb: "Every quality event, its review, and the bimonthly summary", hidden: true },
      { href: "/temps", label: "Temperatures", blurb: "Refrigerator and room readings, excursions explained, months signed off", hidden: true },
      { href: "/staff/new-hire", label: "New employee", blurb: "Everything a new starter has to complete, in one place", hidden: true },
      { href: "/staff/technician-list", label: "Technician list", blurb: "Form C-900, filed automatically every month", hidden: true },
      { href: "/staff/rotations", label: "Students on rotation", blurb: "Present for a fixed spell, not staff and not former staff", hidden: true },
      { href: "/inventory/discrepancies", label: "Discrepancies", blurb: "Anything that did not reconcile, and what was done", hidden: true },
      { href: "/inventory/pharmacist-log", label: "Daily pharmacist log", blurb: "The C-III/IV refill statement and signature sheet", hidden: true },
      { href: "/inventory/power-of-attorney", label: "Power of attorney", blurb: "Who may execute a Form 222 or a CSOS order", hidden: true },
    ],
  },
  {
    href: "/settings",
    label: "Settings",
    blurb: "The pharmacy's own details, every connection and whether each feed is arriving, and the reference data behind the figures.",
    items: [
      { href: "/settings", label: "Pharmacy details", blurb: "Name, registration numbers, address" },
      { href: "/settings/connections", label: "Connections", blurb: "Keys for Claude, iMonnit and the rest, and whether every report is arriving" },
      { href: "/tools/data-health", label: "Data health", blurb: "How complete each feed is, and how much of it links where it must — counted on the real data, with the gaps named" },
      { href: "/settings/email", label: "Email", blurb: "Reading reports in and sending training out" },
      { href: "/inbox", label: "What arrived", blurb: "Reports that came by email, documents dropped in by hand, and what was made of each" },
      { href: "/nadac", label: "NADAC", blurb: "The federal benchmark price, fetched weekly", hidden: true },
      { href: "/reports", label: "Report check", blurb: "What a PioneerRx report can and cannot support, field by field", gated: true, hidden: true },
      { href: "/audit", label: "Activity log", blurb: "Who did what in this system, and when", hidden: true },
      { href: "/settings/backups", label: "Backups", blurb: "Daily, verified, in two places, proved monthly", hidden: true },
      { href: "/settings/training", label: "Training settings", blurb: "Materials and cadence", hidden: true },
      { href: "/settings/features", label: "Extra sections", blurb: "Parts of the site that are still being built", hidden: true },
      { href: "/settings/network", label: "Network", blurb: "How to reach this from another computer", hidden: true },
      { href: "/settings/updates", label: "Updates", blurb: "What version this is running", hidden: true },
    ],
  },
];

/**
 * The group a path belongs to — the longest matching group or item wins.
 *
 * A page listed only through its family (`/plans` under the floor, `/intake` under what arrived)
 * belongs to the group of the page its family is listed by.
 */
export function groupFor(pathname: string): NavGroup | undefined {
  for (const tabs of Object.values(FAMILIES)) {
    if (tabs.some((t) => t.href === pathname || pathname.startsWith(`${t.href}/`))) {
      const listed = tabs.find((t) => NAV.some((g) => g.href === t.href || g.items.some((i) => i.href === t.href)));
      if (listed && !(pathname === listed.href || pathname.startsWith(`${listed.href}/`))) return groupFor(listed.href);
    }
  }
  let best: { g: NavGroup; len: number } | undefined;
  for (const g of NAV) {
    const candidates = [g.href, ...g.items.map((i) => i.href)];
    for (const c of candidates) {
      if (c === "/" ? pathname === "/" : pathname === c || pathname.startsWith(`${c}/`)) {
        if (!best || c.length > best.len) best = { g, len: c.length };
      }
    }
  }
  return best?.g;
}

/**
 * The sidebar item a path lives under, and the family tab it is on when the page itself is not
 * listed. The sidebar highlights the item; the breadcrumb prints both.
 */
export function itemFor(pathname: string): { item: NavItem; tab?: FamilyTab } | undefined {
  const g = groupFor(pathname);
  if (!g || pathname === g.href) return undefined;
  const under = (href: string) => pathname === href || pathname.startsWith(`${href}/`);
  const exact = g.items.find((i) => i.href === pathname);
  if (exact) return { item: exact };
  /*
   * The family before a prefix match: the statement lives at /money/monthly, under the books' own
   * address, and the books' item would otherwise claim it by prefix and print the leaf as "monthly".
   */
  for (const tabs of Object.values(FAMILIES)) {
    const tab = [...tabs].sort((a, b) => b.href.length - a.href.length).find((t) => under(t.href));
    if (!tab) continue;
    const item = g.items.find((i) => tabs.some((t) => t.href === i.href));
    if (item) return item.href === tab.href ? { item } : { item, tab };
  }
  const direct = [...g.items].sort((a, b) => b.href.length - a.href.length).find((i) => under(i.href));
  if (direct) return { item: direct };
  return undefined;
}
