/**
 * The shape of the site.
 *
 * Sixty pages under a flat list of twelve is not a menu, it is a memory test — the daily
 * pharmacist log lived three clicks inside "CS inventories" and nobody who had not built it
 * would ever have found it. So the site is grouped the way a pharmacist-in-charge actually
 * thinks: the people, the licences, the controlled substances, the quality programme, the
 * records, the manual, the inspection. Each group names its pages rather than hiding them, and
 * the group you are inside is the one that is open.
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
 *   1. Ten groups, and a hard ceiling of twelve. A sidebar somebody has to scan rather than
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
 */
export type NavItem = { href: string; label: string; blurb?: string };
export type NavGroup = { href: string; label: string; blurb: string; items: NavItem[] };

export const NAV: NavGroup[] = [
  {
    href: "/",
    label: "Today",
    blurb: "What is due, what is late, and what happened while you were not looking.",
    items: [],
  },
  {
    href: "/staff",
    label: "People",
    blurb: "Everyone who works here, what they are qualified to do, and what they still owe.",
    items: [
      { href: "/staff", label: "Staff", blurb: "Licences, certifications and documents, per person" },
      { href: "/staff/new-hire", label: "New employee", blurb: "Everything a new starter has to complete, in one place" },
      { href: "/compliance/training", label: "Training", blurb: "Send it, chase it, record the attestation" },
      { href: "/compliance/training/records", label: "Training file", blurb: "The whole file, signed electronically and printable for an inspector" },
      { href: "/compliance/training/material", label: "Training material", blurb: "What staff are sent, to read or print" },
      { href: "/staff/technician-list", label: "Technician list", blurb: "Form C-900, filed automatically every month" },
      { href: "/staff/rotations", label: "Students on rotation", blurb: "Present for a fixed spell, not staff and not former staff" },
    ],
  },
  {
    href: "/licenses",
    label: "Licences",
    blurb: "Every registration with an expiry date, and the document behind it.",
    items: [
      { href: "/licenses", label: "Pharmacy & DEA", blurb: "Registration, DEA, CSOS, KMAP, insurance, business licence" },
      { href: "/documents", label: "Pharmacy documents", blurb: "Protocols, policies and everything else on file" },
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
      { href: "/inventory/invoices", label: "Supplier invoices", blurb: "Filed by schedule, with the C2s kept apart" },
      // Next to the invoices because that is what it is for: an invoice files itself only if the
      // address it came from is recognised, and this is where the addresses live.
      { href: "/suppliers", label: "Suppliers", blurb: "Who we buy from, and the addresses their invoices arrive from" },
    ],
  },
  {
    href: "/cqi",
    label: "Quality (CQI)",
    blurb: "Every quality-related event, its review, and the summary of each period.",
    items: [
      { href: "/cqi", label: "CQI programme", blurb: "The bimonthly cycle and Form C-550" },
      { href: "/cqi/incidents", label: "Incidents", blurb: "Each event, its analysis and Form C-650" },
    ],
  },
  {
    href: "/temps",
    label: "Temperatures",
    blurb: "Refrigerator and room readings, excursions explained, months signed off.",
    items: [],
  },
  {
    href: "/records",
    label: "Records",
    blurb: "What the pharmacy can produce on request, and where each of it lives.",
    items: [
      { href: "/forms", label: "Forms", blurb: "Every form this pharmacy uses, and what each records" },
      // The word people actually go looking for. Both kinds live where they belong — supplier
      // invoices under controlled substances, the driver's here — and neither of those is where
      // somebody hunting for "invoices" looks first. The question was asked twice, which is the
      // answer.
      { href: "/invoices", label: "Invoices", blurb: "Both kinds: what suppliers bill us, and what we bill for deliveries" },
      { href: "/deliveries", label: "Driver invoices", blurb: "Deliveries per day, and the monthly invoice that sends itself" },
      { href: "/agreements", label: "Agreements", blurb: "Business associates and everyone else with access" },
      { href: "/compliance/attestations", label: "Attestations", blurb: "Every standing duty confirmed, in the wording used" },
      { href: "/inbox", label: "Inbox", blurb: "Reports that arrived by email and what was made of them" },
      { href: "/audit", label: "Activity log", blurb: "Who did what in this system, and when" },
    ],
  },
  {
    href: "/manual",
    label: "P&P manual",
    blurb: "One document. The Word file is an export of it, not the other way round.",
    items: [
      { href: "/manual", label: "The manual", blurb: "Read and edit it by chapter" },
      { href: "/manual/print", label: "Print it", blurb: "Cover, contents and body, straight from the live copy" },
      { href: "/documents/manual", label: "Appendix A on its own", blurb: "For slotting into a paper manual kept elsewhere" },
    ],
  },
  {
    href: "/inspection",
    label: "Inspection",
    blurb: "What you would be asked for, and whether you could produce it this morning.",
    items: [
      { href: "/inspection", label: "Readiness", blurb: "By inspector: Board, DEA, and what each would ask" },
      { href: "/inspection/walk", label: "Walk the pharmacy", blurb: "The self-inspection, item by item, with findings closed" },
      { href: "/compliance", label: "Compliance register", blurb: "Every standing duty, its cadence and its evidence" },
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
      { href: "/settings/connections", label: "Connections", blurb: "Claude, iMonnit and the rest" },
      { href: "/settings/training", label: "Training settings", blurb: "Materials and cadence" },
      { href: "/settings/features", label: "Extra sections", blurb: "Parts of the site that are still being built" },
      { href: "/settings/network", label: "Network", blurb: "How to reach this from another computer" },
      { href: "/settings/updates", label: "Updates", blurb: "What version this is running" },
    ],
  },
];

/** The group a path belongs to — the longest matching group or item wins. */
export function groupFor(pathname: string): NavGroup | undefined {
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
