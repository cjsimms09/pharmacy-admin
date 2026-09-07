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
  const days = cash.map((f) => f.dateFilled).sort();
  const months = days.length ? Math.max(0.25, (daysBetween(days[0], days[days.length - 1]) + 1) / 30.4) : 1;
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
