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
    /*
     * The bank, beside the books rather than buried under settings.
     *
     * "I need ability in site to go through bank statements and make sure everything is accounted
     * for and categorized!!" It is the only figure in the building that does not come from us, so it
     * belongs next to the accounts it proves — and a page nobody can find is a page nobody has,
     * which this site has now learned twice in one day.
     */
    { href: "/money/bank-review", label: "The bank" },
    { href: "/money/monthly", label: "Statement" },
    { href: "/money/report", label: "Over time" },
  ],
  connections: [
    { href: "/settings/connections", label: "Keys and credentials" },
    { href: "/settings/feeds", label: "Is everything arriving?" },
  ],
  order: [
    { href: "/purchasing", label: "Add to a secondary" },
    { href: "/purchasing/shelf", label: "The shelf" },
    { href: "/purchasing/products", label: "Which NDC pays" },
    { href: "/purchasing/over-nadac", label: "Bought over NADAC" },
    /*
     * The reference table the other four are opinions about.
     *
     * It was reachable only from a supplier's card and from the diagnostics list, so the owner
     * could not find the thing every buying decision is drawn from: "I don't see anyway to view
     * our drug catalog?". It belongs in this family rather than in the menu because it is the
     * same subject seen from another side — every drug under its NDC, rather than one question
     * asked of them.
     */
    { href: "/purchasing/catalog", label: "The drug file" },
  ],
  floor: [
    { href: "/claims/floor", label: "Paid under the floor" },
    { href: "/plans", label: "Which plans it reaches" },
    /*
     * The one that actually gets the plans classified, and nothing in the site linked to it.
     *
     * 17 September 2026, the owner: "We still don't know how to classify all these plans." It had
     * been built — it reads what each plan identifies itself as, offers the class with the sentence
     * behind it, biggest first, one press to confirm — and then no menu entry, no tab and no link
     * anywhere pointed at it. An inventory of every route found exactly one page with no inbound
     * link in the whole site, and it was this one.
     *
     * Beside the register rather than instead of it: /plans is ninety blank boxes to fill in by
     * hand, which is the job nobody finishes, and this is the same job done by confirming. Second
     * in the row because "which plans does the floor reach" is the question the family is about.
     */
    { href: "/payers/plans", label: "Classify by evidence" },
    { href: "/claims/appeals", label: "Appeals filed" },
  ],
  payers: [
    { href: "/payers", label: "Payers" },
    { href: "/payers/owed", label: "What they owe" },
    /*
     * The same question asked of a date that has passed. "What they owe" answers it about now, over
     * a window nobody chose; this answers it as at a month end and stays answered, which is what
     * makes it a document rather than a screen.
     */
    { href: "/payers/ar", label: "Monthly AR report" },
    { href: "/payers/contracts", label: "The contracts" },
    { href: "/payers/sort", label: "Sort the folder" },
    { href: "/payers/networks", label: "Networks to contracts" },
    { href: "/payers/unnamed", label: "Nobody can name" },
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
