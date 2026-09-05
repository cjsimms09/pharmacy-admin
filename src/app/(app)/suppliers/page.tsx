import Link from "next/link";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { requireUser, requireManager } from "@/lib/auth";
import { audit } from "@/lib/audit";
import { getSettings } from "@/lib/settings";
import { allSuppliers, addSupplier, updateSupplier, retireSupplier, importLegacyRules, addressesOf, normaliseAddresses } from "@/lib/suppliers-registry";
import { invoices, filingFor, money } from "@/lib/invoices";
import { fmt, todayIso, daysBetween } from "@/lib/dates";
import { PageHeader, Card, Notice, Empty, Field } from "@/components/ui";
import { INVOICE_SCHEDULES, type InvoiceSchedule } from "@/db/schema";

export const dynamic = "force-dynamic";
export const metadata = { title: "Suppliers" };

/**
 * The wholesalers, as records rather than as routing rules.
 *
 * This lived as a line of free text under the email settings — a fragment, an equals sign, a name
 * — which was enough to route a file and nothing else. A supplier is not a routing rule. It is a
 * party the pharmacy has a DEA-registered relationship with, whose invoices are records it must
 * keep for years, and whose silence is itself worth reporting.
 *
 * The addresses they send from are the load-bearing field. An invoice files itself only if the
 * sender is recognised, so a wholesaler who quietly changes their billing address stops being
 * recorded — and the pharmacy goes on believing its archive is complete. That is why the page
 * shows, per supplier, when they last sent something.
 */
export default async function SuppliersPage({
  searchParams,
}: {
  searchParams: Promise<{ edit?: string; ok?: string; error?: string }>;
}) {
  const user = await requireUser();
  const { edit, ok, error } = await searchParams;
  const canManage = user.role !== "staff";

  const [suppliers, all, s] = await Promise.all([allSuppliers(true), invoices(), getSettings()]);
  const legacy = (s.mail_supplier_rules ?? "").trim();
  const editing = edit ? suppliers.find((x) => x.id === edit) : undefined;
  const today = todayIso();

  async function save(fd: FormData) {
    "use server";
    const u = await requireManager();
    const id = String(fd.get("id") ?? "");
    const schedule = String(fd.get("expectedSchedule") ?? "");
    const input = {
      name: String(fd.get("name") ?? ""),
      senderEmails: String(fd.get("senderEmails") ?? ""),
      accountNumber: String(fd.get("accountNumber") ?? ""),
      deaNumber: String(fd.get("deaNumber") ?? ""),
      phone: String(fd.get("phone") ?? ""),
      website: String(fd.get("website") ?? ""),
      expectedSchedule: INVOICE_SCHEDULES.includes(schedule as InvoiceSchedule) ? (schedule as InvoiceSchedule) : null,
      notes: String(fd.get("notes") ?? ""),
    };
    try {
      if (id) await updateSupplier(id, input);
      else await addSupplier(input);
      await audit({ action: id ? "supplier.update" : "supplier.add", userId: u.id, userName: u.name, details: input.name });
      // Setting the address once is the whole job: anything this sender already sent that was
      // filed as an ordinary report is read again now and filed as their invoice.
      const { rereadFromSenders } = await import("@/lib/mailbox");
      const again = await rereadFromSenders(normaliseAddresses(input.senderEmails).split(/[\s,;]+/), { userId: u.id, userName: u.name });
      revalidatePath("/suppliers");
      revalidatePath("/inventory/invoices");
      revalidatePath("/inbox");
      redirect(
        "/suppliers?ok=" +
          encodeURIComponent(
            `${input.name} saved. Invoices from ${addressesFrom(input.senderEmails)} will be filed under their name from now on.` +
              (again.filed ? ` ${again.filed} already received ${again.filed === 1 ? "was" : "were"} filed under their name just now.` : again.read ? ` ${again.read} earlier message${again.read === 1 ? "" : "s"} from them ${again.read === 1 ? "was" : "were"} read again; none was an invoice.` : ""),
          ),
      );
    } catch (e) {
      if (e && typeof e === "object" && "digest" in e) throw e;
      redirect("/suppliers?error=" + encodeURIComponent(e instanceof Error ? e.message : "Could not save that."));
    }
  }

  async function retire(fd: FormData) {
    "use server";
    const u = await requireManager();
    const id = String(fd.get("id") ?? "");
    const active = String(fd.get("active") ?? "") === "yes";
    await retireSupplier(id, active);
    await audit({ action: "supplier.retire", userId: u.id, userName: u.name, details: `${id} active=${active}` });
    revalidatePath("/suppliers");
    redirect(
      "/suppliers?ok=" +
        encodeURIComponent(
          active
            ? "Back in use. Their invoices will be recognised again."
            : "Retired. Every invoice already filed against them is kept — they are records the pharmacy has to produce for years after it stops buying.",
        ),
    );
  }

  async function importOld() {
    "use server";
    const u = await requireManager();
    const set = await getSettings();
    const n = await importLegacyRules(set.mail_supplier_rules ?? "");
    await audit({ action: "supplier.import", userId: u.id, userName: u.name, details: `${n}` });
    revalidatePath("/suppliers");
    redirect(
      "/suppliers?ok=" +
        encodeURIComponent(
          n > 0
            ? `${n} supplier${n === 1 ? "" : "s"} brought across from the old email rules. Check the addresses and add anything else you know about them.`
            : "Nothing new to bring across.",
        ),
    );
  }

  return (
    <>
      <PageHeader
        back={{ href: "/invoices", label: "Invoices" }}
        title="Suppliers"
        subtitle="The wholesalers this pharmacy buys from, and the addresses they send invoices from. An invoice only files itself if the sender is recognised."
        actions={<Link href="/inventory/invoices" className="btn">Supplier invoices</Link>}
      />

      {ok && <Notice kind="ok">{ok}</Notice>}
      {error && <Notice kind="crit">{error}</Notice>}

      {legacy && suppliers.length === 0 && canManage && (
        <Notice kind="warn">
          <b>There are supplier rules in the old email settings that have not been brought across.</b> Typing them
          again is how half of them end up untyped — which here means invoices silently not being filed.
          <form action={importOld} className="mt-2">
            <button className="btn btn-sm btn-primary">Bring them across</button>
          </form>
        </Notice>
      )}

      {suppliers.length === 0 ? (
        <Empty>
          No supplier is recorded, so nothing arriving by email will be filed as an invoice. Add the wholesalers below.
        </Empty>
      ) : (
        <div className="grid gap-4 lg:grid-cols-2">
          {suppliers.map((sup) => {
            const theirs = all.filter((i) => (i.supplier ?? "").toLowerCase().includes(sup.name.toLowerCase().slice(0, 8)));
            const last = theirs.map((i) => i.invoiceDate).filter(Boolean).sort().at(-1) ?? null;
            const quiet = last ? daysBetween(last, today) : null;
            const spend = theirs.reduce((n, i) => n + (i.totalCents ?? 0), 0);

            return (
              <Card
                key={sup.id}
                title={sup.name}
                tone={!sup.active ? undefined : !sup.senderEmails.trim() ? "crit" : quiet !== null && quiet > 21 ? "warn" : undefined}
                className={sup.active ? "" : "opacity-60"}
                actions={
                  canManage && (
                    <Link href={`/suppliers?edit=${sup.id}#edit`} className="btn btn-sm">Edit</Link>
                  )
                }
              >
                {!sup.active && <p className="card-sub">Retired. Their invoices are kept; nothing new is expected.</p>}

                {/*
                  The address is the load-bearing field, so its absence is the loudest thing on the card.
                  A supplier with no address recorded is a supplier whose invoices are quietly not
                  being filed, and nothing else on this page would reveal that.
                */}
                {sup.senderEmails.trim() ? (
                  <p className="text-xs text-ink-2">
                    Sends from{" "}
                    {addressesOf(sup).map((a) => (
                      <code key={a} className="mr-1 rounded bg-ground px-1">{a}</code>
                    ))}
                  </p>
                ) : (
                  <p className="text-xs text-crit">
                    No sending address recorded, so their invoices will not be recognised or filed.
                  </p>
                )}

                <dl className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1 text-xs">
                  {sup.accountNumber && (
                    <>
                      <dt className="text-ink-3">Account</dt>
                      <dd className="font-mono">{sup.accountNumber}</dd>
                    </>
                  )}
                  {sup.deaNumber && (
                    <>
                      <dt className="text-ink-3">Their DEA</dt>
                      <dd className="font-mono">{sup.deaNumber}</dd>
                    </>
                  )}
                  {sup.phone && (
                    <>
                      <dt className="text-ink-3">Phone</dt>
                      <dd>{sup.phone}</dd>
                    </>
                  )}
                  <dt className="text-ink-3">Expected to send</dt>
                  <dd>{sup.expectedSchedule ? filingFor(sup.expectedSchedule).label : "not stated"}</dd>
                  <dt className="text-ink-3">Invoices held</dt>
                  <dd>
                    <Link href={`/inventory/invoices?q=${encodeURIComponent(sup.name)}`} className="text-accent hover:underline">
                      {theirs.length}
                    </Link>
                    {spend > 0 ? ` · ${money(spend)}` : ""}
                  </dd>
                  <dt className="text-ink-3">Last invoice</dt>
                  <dd className={quiet !== null && quiet > 21 ? "text-warn" : ""}>
                    {last ? `${fmt(last)}${quiet !== null && quiet > 21 ? ` — ${quiet} days ago` : ""}` : "none yet"}
                  </dd>
                </dl>

                {sup.notes && <p className="mt-2 text-xs text-ink-3">{sup.notes}</p>}

                {canManage && (
                  <form action={retire} className="mt-3">
                    <input type="hidden" name="id" value={sup.id} />
                    <input type="hidden" name="active" value={sup.active ? "no" : "yes"} />
                    <button className="text-xs text-ink-3 hover:text-crit hover:underline">
                      {sup.active ? "Retire this supplier" : "Put back in use"}
                    </button>
                  </form>
                )}
              </Card>
            );
          })}
        </div>
      )}

      {canManage && (
        <Card
          id="edit"
          title={editing ? `Edit ${editing.name}` : "Add a supplier"}
          subtitle="The addresses are what matter most: an invoice files itself only if the sender is recognised. A bare domain works as well as a full address, since invoices often come from a different mailbox at the same company each month."
          className="mt-6 scroll-mt-4"
        >
          <form action={save} className="grid gap-3 sm:grid-cols-2">
            {editing && <input type="hidden" name="id" value={editing.id} />}
            <Field label="Name">
              <input name="name" defaultValue={editing?.name ?? ""} required className="field" placeholder="McKesson" />
            </Field>
            <Field label="Our account number with them">
              <input name="accountNumber" defaultValue={editing?.accountNumber ?? ""} className="field" />
            </Field>
            <div className="sm:col-span-2">
              <Field
                label="Addresses they send invoices from — one per line"
                hint="A whole address, or just the domain. Anything a message comes from that contains one of these is treated as an invoice from them."
              >
                <textarea
                  name="senderEmails"
                  rows={3}
                  defaultValue={editing?.senderEmails ?? ""}
                  className="field font-mono text-xs"
                  placeholder={"invoices@mckesson.com\nmckesson.com"}
                />
              </Field>
            </div>
            <Field label="Their DEA registration">
              <input name="deaNumber" defaultValue={editing?.deaNumber ?? ""} className="field font-mono" />
            </Field>
            <Field label="Phone">
              <input name="phone" defaultValue={editing?.phone ?? ""} className="field" />
            </Field>
            <Field label="Website">
              <input name="website" defaultValue={editing?.website ?? ""} className="field" />
            </Field>
            <Field
              label="What they normally send"
              hint="Never used to file anything. Used the other way round — to tell you when they send something they never send."
            >
              <select name="expectedSchedule" defaultValue={editing?.expectedSchedule ?? ""} className="field">
                <option value="">Not stated</option>
                <option value="none">Nothing controlled</option>
                <option value="schedule_3_5">Schedule III-V at most</option>
                <option value="schedule_2">Schedule II and below</option>
              </select>
            </Field>
            <div className="sm:col-span-2">
              <Field label="Anything worth remembering">
                <input name="notes" defaultValue={editing?.notes ?? ""} className="field" />
              </Field>
            </div>
            <div className="sm:col-span-2">
              <button className="btn btn-primary">{editing ? "Save" : "Add supplier"}</button>
              {editing && <Link href="/suppliers" className="btn ml-1.5">Cancel</Link>}
            </div>
          </form>
        </Card>
      )}
    </>
  );
}

function addressesFrom(raw: string): string {
  const list = raw
    .split(/[\n,;]/)
    .map((x) => x.trim())
    .filter(Boolean);
  return list.length === 0 ? "them" : list.join(", ");
}
