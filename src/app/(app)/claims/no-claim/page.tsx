import { requireUser } from "@/lib/auth";
import { requireReimbursement } from "@/lib/features";
import { untiedPayments } from "@/lib/untied-payments-store";
import { PaymentsWithNoClaim } from "./view";

export const metadata = { title: "Payments with no claim" };
export const dynamic = "force-dynamic";

export default async function PaymentsWithNoClaimPage() {
  await requireReimbursement();
  await requireUser();
  return <PaymentsWithNoClaim r={await untiedPayments()} />;
}
