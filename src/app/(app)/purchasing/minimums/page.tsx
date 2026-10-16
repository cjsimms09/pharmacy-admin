import { redirect } from "next/navigation";
import { requireReimbursement } from "@/lib/features";

/**
 * Order minimums used to be its own page. It decided a basket for the pharmacist, which is not
 * what they need — what is in the cart at the wholesaler's website is theirs, not the site's — so
 * the job moved onto What to buy as a ranked list per secondary with a running total. Old links
 * land there, behind the same switch.
 */
export default async function Page() {
  await requireReimbursement();
  redirect("/purchasing");
}
