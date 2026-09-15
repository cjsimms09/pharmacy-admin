import "server-only";
import { cashPricing, type CashPricing } from "./cash-pricing";
import { allFills } from "./claims";
import { nadacNow } from "./nadac-latest";
import { getSettings } from "./settings";
import { SB20_MIN_DISPENSING_FEE_CENTS } from "./reimbursement-rules";
import { daysBetween } from "./dates";

/** Cash fills from the claims held, priced against their cost and the Kansas floor. */
export async function cashPricingNow(): Promise<CashPricing & { months: number }> {
  const { held } = await import("./held");
  return held("cash-pricing", loadCashPricing);
}

async function loadCashPricing(): Promise<CashPricing & { months: number }> {
  const [fills, nadac, s] = await Promise.all([allFills(), nadacNow(), getSettings()]);
  const cash = fills.filter((f) => f.cashPlan && f.ndc11);
  const ksFee = Number(s.ks_medicaid_dispensing_fee_cents ?? "") || null;
  const feeCents = Math.max(SB20_MIN_DISPENSING_FEE_CENTS, ksFee ?? 0);
  /*
   * A month is measured over the period watched, not the gap between the events.
   *
   * This divided by the span of the cash fills themselves. Contrave went out three times between
   * the 1st and the 9th of September, so the span was nine days, and three fills over nine days
   * scaled to ten a month — $4,904.74 against one product, seventy-two per cent of the whole
   * cash-pricing row and near a third of everything the front page called recoverable.
   *
   * Nothing was dispensed on the other twenty-seven days the site was also watching, and those days
   * are evidence too. Two fills a day apart would have implied fifteen a month by the old sum: the
   * rarer the event, the larger the exaggeration, which is exactly backwards.
   *
   * So the denominator is the whole claims window. Under a week there is nothing to annualise from
   * at all, and what was seen is reported as it stands rather than multiplied up — understating,
   * which is the safe direction for a figure somebody is going to act on.
   */
  const watched = fills.map((f) => f.dateFilled).filter(Boolean).sort();
  const spanDays = watched.length ? daysBetween(watched[0], watched[watched.length - 1]) + 1 : 0;
  const months = spanDays >= 7 ? spanDays / 30.4 : 1;
  const materialityCents = Number(s.floor_materiality_cents ?? "") || 500;
  const out = cashPricing({
    fills: cash.map((f) => ({
      key: f.key,
      ndc11: f.ndc11 as string,
      name: f.itemName,
      dateFilled: f.dateFilled,
      quantityThousandths: f.quantityThousandths,
      chargedCents: f.patientPaidCents,
      acquisitionCents: f.acquisitionCents,
    })),
    nadacMicros: new Map(nadac.map((n) => [n.ndc11, n.unitMicros])),
    feeCents,
    months,
    materialityCents,
  });
  return { ...out, months };
}
