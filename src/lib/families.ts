/**
 * Pages that are one thing seen from several sides.
 *
 * The books, the statement and the trend are three views of the same account; the buy list, the
 * shelf and the minimums are three views of today's order; the floor, the plans it reaches and the
 * appeals filed on it are one piece of Kansas law. Each used to be its own line in the sidebar,
 * which is what made the menu read as a list of things somebody happened to build. A family is
 * listed once in the sidebar, by its first page, and every page in it carries the same row of tabs
 * so the others are one click away and the menu stops pretending they are unrelated.
 *
 * A page is in at most one family. The sidebar highlight follows the group, the tabs follow the
 * family, and neither guesses at the other.
 */
export type FamilyTab = { href: string; label: string };

export const FAMILIES = {
  money: [
    { href: "/money", label: "The books" },
    { href: "/money/monthly", label: "Statement" },
    { href: "/money/report", label: "Over time" },
  ],
  order: [
    { href: "/purchasing", label: "Today's order" },
    { href: "/purchasing/shelf", label: "The shelf" },
    { href: "/purchasing/products", label: "Which NDC pays" },
  ],
  floor: [
    { href: "/claims/floor", label: "Paid under the floor" },
    { href: "/plans", label: "Which plans it reaches" },
    { href: "/claims/appeals", label: "Appeals filed" },
  ],
  payers: [
    { href: "/payers", label: "Payers" },
    { href: "/payers/contracts", label: "The contracts" },
    { href: "/payers/sort", label: "Sort the folder" },
    { href: "/payers/routing", label: "835 routing" },
  ],
  training: [
    { href: "/compliance/training", label: "Send and chase" },
    { href: "/compliance/training/records", label: "The training file" },
    { href: "/compliance/training/material", label: "The material" },
  ],
  inspection: [
    { href: "/inspection", label: "By inspector" },
    { href: "/inspection/walk", label: "Walk the pharmacy" },
  ],
  arrivals: [
    { href: "/inbox", label: "By email" },
    { href: "/intake", label: "By hand" },
  ],
} as const satisfies Record<string, readonly FamilyTab[]>;

export type FamilyName = keyof typeof FAMILIES;

/** The tabs for a page: the family it belongs to, with this page marked. */
export function familyTabs(name: FamilyName, here: string): { active: string; items: FamilyTab[] } {
  return { active: here, items: [...FAMILIES[name]] };
}
