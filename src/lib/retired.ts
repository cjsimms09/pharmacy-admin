/**
 * The pages retired on 2 October 2026, by the owner's scope: "I want compliance, I want invoice organization and
 * storing, temp logs, delivery invoices, accounting, and remits reconciliation and tracking (MTF, Aytu, SFTP).
 * Everything else can go." And: "I get a headache looking at this site and trying to read all the paragraphs and
 * words."
 *
 * Retired, not deleted: the code stays for a month, the data stays for good, and a retired address lands on one
 * sentence that says so (app/retired). What leaves today is the page from the menus and Today, and the computation
 * behind it from the idle warmer — which is most of what made every page slow. Pure, so the menu, the middleware and
 * the tests read one list.
 */
export const RETIRED: { test: RegExp; area: string }[] = [
  /* Not the rebate ladder: "yes keep rebate latter", his words the same day, so /suppliers and its terms pages stay. */
  { test: /^\/purchasing(\/|$)/, area: "buying: what to buy, the shelf, minimums, the catalogue, products, replay, return soon, supplies, bought over NADAC" },
  { test: /^\/nadac(\/|$)/, area: "the NADAC page" },
  { test: /^\/inventory\/returns(\/|$)/, area: "what to send back" },
  { test: /^\/money\/found(\/|$)/, area: "money found" },
  { test: /^\/claims\/(appeals|floor)(\/|$)/, area: "appeals and the Kansas floor" },
  { test: /^\/plans(\/|$)/, area: "plan classification" },
  { test: /^\/payers\/(plans|performance|networks|contracts|sort)(\/|$)/, area: "who pays best, plan classification, networks, contract reading, sort the folder" },
  { test: /^\/tools\/(check|data-health)(\/|$)/, area: "the morning check page, data health" },
  { test: /^\/reports(\/|$)/, area: "report check" },
  { test: /^\/settings\/features(\/|$)/, area: "extra sections" },
  { test: /^\/v2(\/|$)/, area: "the new site's screens" },
];

export function isRetired(pathname: string): boolean {
  return RETIRED.some((r) => r.test.test(pathname));
}

export function retiredArea(pathname: string): string | null {
  return RETIRED.find((r) => r.test.test(pathname))?.area ?? null;
}

/** The six things the site is for, in his words, for the retired page and the handoff. */
export const KEPT = ["compliance", "invoices, stored and organised", "temperature logs", "delivery invoices", "accounting", "remits, reconciled and tracked"] as const;
