import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { requireManager, requireUser } from "@/lib/auth";
import { requireReimbursement } from "@/lib/features";
import { tieByHand, untieByHand } from "@/lib/tie-by-hand";
import { handTied, untiedPayments } from "@/lib/untied-payments-store";
import { PaymentsWithNoClaim } from "./view";

export const metadata = { title: "Payments with no claim" };
export const dynamic = "force-dynamic";

/** Back to the page with a message. At module scope, so a server action references it rather than captures it. */
function back(msg: string, kind: "ok" | "error" = "ok"): never {
  redirect(`/claims/no-claim?${kind}=${encodeURIComponent(msg)}`);
}

export default async function PaymentsWithNoClaimPage({ searchParams }: { searchParams: Promise<{ ok?: string; error?: string }> }) {
  await requireReimbursement();
  const user = await requireUser();
  const { ok, error } = await searchParams;

  async function attach(fd: FormData) {
    "use server";
    const u = await requireManager();
    let said: string;
    try {
      said = await tieByHand(String(fd.get("payment") ?? ""), String(fd.get("claim") ?? ""), u);
    } catch (e) {
      return back(e instanceof Error ? e.message : String(e), "error");
    }
    revalidatePath("/claims/no-claim");
    revalidatePath("/claims");
    back(said);
  }

  async function detach(fd: FormData) {
    "use server";
    const u = await requireManager();
    let said: string;
    try {
      said = await untieByHand(String(fd.get("payment") ?? ""), u);
    } catch (e) {
      return back(e instanceof Error ? e.message : String(e), "error");
    }
    revalidatePath("/claims/no-claim");
    revalidatePath("/claims");
    back(said);
  }

  const [r, byHand] = await Promise.all([untiedPayments(), handTied()]);
  return <PaymentsWithNoClaim r={r} byHand={byHand} mayChoose={user.role === "owner" || user.role === "pic"} attach={attach} detach={detach} ok={ok} error={error} />;
}
