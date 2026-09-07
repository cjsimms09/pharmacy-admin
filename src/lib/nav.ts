/**
 * The shape of the site.
 *
 * Sixty pages under a flat list of twelve is not a menu, it is a memory test — the daily
 * pharmacist log lived three clicks inside "CS inventories" and nobody who had not built it
 * would ever have found it. So the site is grouped the way the owner actually works: the money,
 * the ordering, the claims, then compliance, the people, the controlled substances,
 * the tools and the settings. Each group names its pages rather than hiding them, and the group
 * you are inside is the one that is open.
 *
 * Plain data rather than markup, so the same structure drives the sidebar, the hub pages and
 * anywhere else that needs to know what belongs with what.
 *
 * ── The rules this has to keep obeying as the site grows ──
 *
 * Everything built so far is compliance. What is coming is not — the schedule, the money side,
 * purchasing, the patient-facing work — and a menu grows badly by accident rather than by
 * decision. Adding a thirteenth group and a ninth item to four of them is never a choice anybody
 * makes; it is what happens when nobody wrote the rule down. So:
 *
 *   1. Nine groups, and a hard ceiling of twelve. A sidebar somebody has to scan rather than
 *      recognise has stopped being navigation. A new area of the business earns a group; a new
 *      page almost never does.
 *
 *   2. Eight items per group. Past that, the group is really two groups, or some of its pages
 *      belong one level down inside a page that already exists. The test enforces both numbers,
 *      so exceeding them is a decision somebody has to make deliberately.
 *
 *   3. Group by what somebody came to do, not by what the thing is made of. "Invoices" is in
 *      Records because that is the word people go looking for, even though supplier invoices are
 *      really a controlled substance record. The word wins.
 *
 *   4. A page belongs to exactly one group. Cross-link from anywhere; list it once. Two homes
 *      means neither is the home, and the sidebar highlight goes wrong.
 *
 *   5. If a page is only ever reached from another page — a person's record, one month's
 *      temperatures, one incident — it is not in the menu at all. The menu lists starting points.
 *
 *   6. Pages that are one thing seen from several sides — the books, the statement and the
 *      trend; the buy list, the shelf and the minimums — are a family (`families.ts`): listed once
 *      here, by the page somebody opens first, and joined by a row of tabs on every page in it.
 *      A one-page group is not a group; it is a page that belongs somewhere.
 */
import { FAMILIES, type FamilyTab } from "./families";

export type NavItem = {
  href: string;
  label: string;
  blurb?: string;
  /** Behind the "extra sections" flag: the page redirects to Today while it is off, so the link is not shown. */
  gated?: boolean;
};
export type NavGroup = { href: string; label: string; blurb: string; items: NavItem[] };

export const NAV: NavGroup[] = [
  {
    href: "/",
    label: "Today",
    blurb: "What is due, what is late, and what happened while you were not looking.",
    items: [],
  },
  {
    /*
     * The money, first among the business groups because it is what the owner opens first.
     *
     * The books lead: what the period earned, what reached the bank, and the gap between them.
     * Everything that decides or explains a figure on the books is one level down.
     */
    href: "/money",
    label: "Money",
    blurb: "The books: what the pharmacy earned, what reached the bank, what it cost, and what is left.",
    items: [
      { href: "/money", label: "The books", blurb: "The period on both bases, the statement, and how the months are moving" },
      { href: "/money/found", label: "Money found", blurb: "Everything worth chasing, ranked, with what to do about each" },
      { href: "/expenses", label: "Spending", blurb: "Bills, standing costs, the vendors who send them, and the rules that file them" },
      { href: "/deliveries", label: "Driver invoices", blurb: "Deliveries per day, and the monthly invoice that sends itself" },
    ],
  },
  {
    href: "/purchasing",
    label: "Ordering",
    blurb: "What to buy, from whom, at what it really costs after the rebate, and what is on the shelf.",
    items: [
      { href: "/purchasing", label: "What to buy", blurb: "Today's order by supplier, the shelf behind it, and each supplier's minimum", gated: true },
      { href: "/purchasing/replay", label: "Which contract", blurb: "A year of dispensing replayed through each wholesaler's catalogue and ladder", gated: true },
      { href: "/suppliers", label: "Suppliers and rebates", blurb: "The ladders, the ratio, and what this month's buying is earning" },
      { href: "/inventory/invoices", label: "Supplier invoices", blurb: "Filed by schedule, with the C2s kept apart" },
      { href: "/inventory/returns", label: "What to send back", blurb: "Return deadlines counted from the invoice, and what each is worth" },
      { href: "/purchasing/supplies", label: "Supplies", blurb: "Vials, bags and labels: what is low and what to order" },
    ],
  },
  {
    href: "/claims",
    label: "Claims",
    blurb: "Every dispensing, what it made, who priced it, and what it should have been paid.",
    items: [
      { href: "/claims", label: "Claims", blurb: "Every dispensing, what it made, and what is still owed on it", gated: true },
      { href: "/claims/floor", label: "Kansas floor", blurb: "Claims paid under NADAC plus the fee, the plans the floor reaches, and the appeals filed", gated: true },
      { href: "/payers", label: "Payers", blurb: "Every BIN we bill, its contract, its appeal route and its payment routing", gated: true },
      { href: "/payers/contracts", label: "Contracts", blurb: "Every agreement, read once, with the contract's own words beside each figure", gated: true },
      { href: "/payers/performance", label: "Who pays best", blurb: "Every plan ranked by what it actually pays", gated: true },
      { href: "/remits/mtf", label: "Facilitator payments", blurb: "What the Medicare Transaction Facilitator has paid after the claim, and what is still awaited", gated: true },
    ],
  },
  {
    href: "/compliance",
    label: "Compliance",
    blurb: "Every standing duty, the licences, the inspection, the manual, and the records behind them.",
    items: [
      { href: "/compliance", label: "Register", blurb: "Every standing duty, its cadence and its evidence" },
      { href: "/licenses", label: "Licences", blurb: "Registration, DEA, CSOS, KMAP, insurance, business licence" },
      { href: "/inspection", label: "Inspection", blurb: "By inspector: Board, DEA, what each would ask, and the walk round with findings closed" },
      { href: "/manual", label: "P&P manual", blurb: "One document, read and edited by chapter, printed from the live copy" },
      { href: "/cqi", label: "Quality (CQI)", blurb: "Every quality event, its review, and the bimonthly summary" },
      { href: "/temps", label: "Temperatures", blurb: "Refrigerator and room readings, excursions explained, months signed off" },
      { href: "/records", label: "Records", blurb: "Forms, agreements, attestations and documents, and where each lives" },
    ],
  },
  {
    href: "/staff",
    label: "People",
    blurb: "Everyone who works here, what they are qualified to do, and what they still owe.",
    items: [
      { href: "/staff", label: "Staff", blurb: "Licences, certifications and documents, per person" },
      { href: "/staff/new-hire", label: "New employee", blurb: "Everything a new starter has to complete, in one place" },
      { href: "/compliance/training", label: "Training", blurb: "Send it, chase it, record the attestation; the file and the material behind it" },
      { href: "/staff/technician-list", label: "Technician list", blurb: "Form C-900, filed automatically every month" },
      { href: "/staff/rotations", label: "Students on rotation", blurb: "Present for a fixed spell, not staff and not former staff" },
    ],
  },
  {
    href: "/inventory",
    label: "Controlled substances",
    blurb: "The count, the log, the authority to order, and anything that did not add up.",
    items: [
      { href: "/inventory", label: "Inventories", blurb: "The annual count and Form C-250" },
      { href: "/inventory/discrepancies", label: "Discrepancies", blurb: "Anything that did not reconcile, and what was done" },
      { href: "/inventory/pharmacist-log", label: "Daily pharmacist log", blurb: "The C-III/IV refill statement and signature sheet" },
      { href: "/inventory/power-of-attorney", label: "Power of attorney", blurb: "Who may execute a Form 222 or a CSOS order" },
    ],
  },
  {
    href: "/tools",
    label: "Tools",
    blurb: "The feeds and the reference data behind every figure, and the log of who did what.",
    items: [
      { href: "/inbox", label: "What arrived", blurb: "Reports that came by email, documents dropped in by hand, and what was made of each" },
      { href: "/nadac", label: "NADAC", blurb: "The federal benchmark price, fetched weekly" },
      { href: "/reports", label: "Report check", blurb: "What a PioneerRx report can and cannot support, field by field", gated: true },
      { href: "/audit", label: "Activity log", blurb: "Who did what in this system, and when" },
    ],
  },
  {
    href: "/settings",
    label: "Settings",
    blurb: "The pharmacy's own details, the connections, and the backups.",
    items: [
      { href: "/settings", label: "Pharmacy details", blurb: "Name, registration numbers, address" },
      { href: "/settings/backups", label: "Backups", blurb: "Daily, verified, in two places, proved monthly" },
      { href: "/settings/email", label: "Email", blurb: "Reading reports in and sending training out" },
      { href: "/settings/connections", label: "Connections", blurb: "Keys for Claude, iMonnit and the rest, and whether every report is arriving" },
      { href: "/settings/training", label: "Training settings", blurb: "Materials and cadence" },
      { href: "/settings/features", label: "Extra sections", blurb: "Parts of the site that are still being built" },
      { href: "/settings/network", label: "Network", blurb: "How to reach this from another computer" },
      { href: "/settings/updates", label: "Updates", blurb: "What version this is running" },
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
