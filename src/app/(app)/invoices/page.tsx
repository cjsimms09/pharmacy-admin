import { redirect } from "next/navigation";

/**
 * "Invoices" used to be a page of its own: two links, one to the supplier invoices and one to the
 * driver's, with a figure or two beside each. Both pages are in the sidebar under the word
 * somebody would look for, and the search box finds either, so a page whose whole content was
 * the choice between them was one more page to learn. The word still works: it lands on the
 * supplier invoices, which is what it meant nine times in ten, with the driver's one click away.
 */
export default function InvoicesPage() {
  redirect("/inventory/invoices");
}
