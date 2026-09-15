import "server-only";
import { refreshStale } from "./held";

/**
 * Warm the readings the day starts with, then refresh whatever is stale. Run by the scheduler when
 * the site is idle, so a person never waits behind it. Each call is a no-op for a reading that is
 * fresh and keyed to the current data.
 */
export async function warmHeld(keepGoing: () => boolean = () => true): Promise<void> {
  const { todayIso } = await import("./dates");
  const steps: (() => Promise<unknown>)[] = [
    async () => (await import("./claims")).allFills(),
    async () => (await import("./product-ledger")).productLedger(),
    async () => {
      const { booksFor } = await import("./ledger-store");
      const { parsePeriod } = await import("./ledger");
      const period = parsePeriod(todayIso().slice(0, 7));
      if (period) await booksFor(period);
    },
    async () => (await import("./money-position")).moneyPosition(),
    async () => (await import("./money-found")).moneyFound(),
    async () => (await import("./shelf")).buyListNow(),
    async () => (await import("./minimum-store")).minimumsNow(),
    async () => (await import("./drug-profit-store")).drugProfitNow(),
    async () => (await import("./over-nadac-store")).overNadacNow(28),
    async () => (await import("./over-nadac-store")).overNadacNow(7),
    async () => (await import("./floor-review")).floorReview(),
    async () => (await import("./shelf")).leanShelfNow(),
    async () => (await import("./ledger-store")).recentMonths(6),
    async () => (await import("./profit-and-loss")).monthlyTrend(12),
    async () => (await import("./products-store")).productsExtrasNow(),
    async () => (await import("./payer-map")).payerMap(),
    async () => (await import("./plans")).planRegister(),
    async () => (await import("./nadac")).nadacCoverage(),
  ];
  for (const step of steps) {
    // A person arriving outranks the warm-up: stop, and the next idle tick picks up where this left off.
    if (!keepGoing()) return;
    try {
      await step();
    } catch {
      // Its page says what it is missing.
    }
  }
  if (keepGoing()) await refreshStale();
}
