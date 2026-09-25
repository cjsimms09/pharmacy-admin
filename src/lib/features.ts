import "server-only";
import { redirect } from "next/navigation";
import { getSettings } from "./settings";

/**
 * Parts of the site that are finished enough to keep but not to look at every day.
 *
 * The reimbursement work — payers, claims, plans, NADAC, purchasing, report checking, MTF — is
 * real and tested, and every one of it is waiting on something that has to arrive from outside:
 * a PioneerRx column that comes through blank, a NADAC download, a contract. Until then they are
 * seven menu items that cannot finish a job, and a pharmacist-in-charge would resent every one
 * of them every morning.
 *
 * So they are switched off rather than deleted. Nothing is lost, the tests still run, and one
 * toggle in Settings brings them back the day the data lands.
 */
export async function reimbursementEnabled(): Promise<boolean> {
  const s = await getSettings();
  return s.feature_reimbursement === "yes";
}

/** Guards a page that belongs to a switched-off area. */
export async function requireReimbursement(): Promise<void> {
  if (!(await reimbursementEnabled())) redirect("/");
}
