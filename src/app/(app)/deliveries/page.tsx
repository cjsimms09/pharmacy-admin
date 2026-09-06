import Link from "next/link";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { requireUser, requireManager } from "@/lib/auth";
import { audit } from "@/lib/audit";
import { todayIso, fmt } from "@/lib/dates";
import { setSetting } from "@/lib/settings";
import {
  monthState,
  monthLabel,
  monthsWithDays,
  allInvoices,
  saveDay,
  clearDay,
  closeMonthIfComplete,
  issueInvoice,
  sendInvoice,
  invoiceParties,
  sendTestInvoice,
  monthIsOurs,
  skipMonth,
  unskipMonth,
  money,
  statusLabel,
  DEFAULT_RATE_CENTS,
} from "@/lib/deliveries";
import { PageHeader, Card, Figure, Notice, Empty } from "@/components/ui";

export const dynamic = "force-dynamic";
export const metadata = { title: "Deliveries" };

/**
 * The delivery driver's month.
 *
 * One number a day, and the invoice takes care of itself. That is the whole design: the person
 * entering it should never have to know what day of the month it is, whether this is the last
 * weekday, what the rate is, what the invoice number should be, or who it goes to. The one thing
 * a human knows and the software cannot — how many deliveries went out — is the only thing asked
 * for.
 *
 * Every weekday of the month is listed whether or not it has an answer, because the alternative
 * is a list of what has been done and no way to see what has not. The missing days are the work,
 * so they are what the page is built around.
 */
export default async function DeliveriesPage({
  searchParams,
}: {
  searchParams: Promise<{ month?: string; ok?: string; error?: string; settings?: string }>;
}) {
  const user = await requireUser();
  const sp = await searchParams;
  const canManage = user.role !== "staff";
  const month = /^\d{4}-\d{2}$/.test(sp.month ?? "") ? sp.month! : todayIso().slice(0, 7);

  const [state, parties, months, invoices, scope] = await Promise.all([
    monthState(month),
    invoiceParties(),
    monthsWithDays(),
    allInvoices(),
    monthIsOurs(month),
  ]);

  // Whose money the round is. Read here so the form shows what the account is actually using.
  const { getSettings } = await import("@/lib/settings");
  const paidBy = ((await getSettings()).driver_paid_by ?? "clinic") === "pharmacy" ? "pharmacy" : "clinic";

  const known = [...new Set([month, todayIso().slice(0, 7), ...months])].sort().reverse().slice(0, 24);
  const here = `/deliveries?month=${month}`;

  async function save(fd: FormData) {
    "use server";
    const u = await requireManager();
    const onDate = String(fd.get("onDate") ?? "");
    try {
      await saveDay(
        onDate,
        {
          deliveries: Number(fd.get("deliveries") ?? 0),
          mailTrips: Number(fd.get("mailTrips") ?? 0),
          note: String(fd.get("note") ?? ""),
        },
        u,
      );
      await audit({ action: "delivery.day", userId: u.id, userName: u.name, details: onDate });

      /*
        The invoice goes the moment the month is finished, from here.

        Not from a screen somebody has to remember to visit on the last working day, because that
        is exactly the step that was failing — the driver was waiting on somebody remembering. So
        the last number entered for the month is also the act of sending the invoice, and the
        confirmation says so rather than leaving it to be discovered.
      */
      const closed = await closeMonthIfComplete(onDate.slice(0, 7), u);
      revalidatePath("/deliveries");
      redirect(
        `/deliveries?month=${onDate.slice(0, 7)}&${closed && !closed.ok ? "error" : "ok"}=` +
          encodeURIComponent(closed ? `${fmt(onDate)} saved. ${closed.message}` : `${fmt(onDate)} saved.`),
      );
    } catch (e) {
      if (e && typeof e === "object" && "digest" in e) throw e;
      redirect(`/deliveries?month=${onDate.slice(0, 7)}&error=` + encodeURIComponent(e instanceof Error ? e.message : "Could not save that."));
    }
  }

  async function clear(fd: FormData) {
    "use server";
    const u = await requireManager();
    const onDate = String(fd.get("onDate") ?? "");
    await clearDay(onDate);
    await audit({ action: "delivery.clear", userId: u.id, userName: u.name, details: onDate });
    revalidatePath("/deliveries");
    redirect(
      `/deliveries?month=${onDate.slice(0, 7)}&ok=` +
        encodeURIComponent(`${fmt(onDate)} is back to having no answer, so the month will wait for it again.`),
    );
  }

  async function sendNow(fd: FormData) {
    "use server";
    const u = await requireManager();
    const m = String(fd.get("month") ?? "");
    try {
      const state = await monthState(m);
      const target = state.invoice && !state.changedSinceSent ? state.invoice : (await issueInvoice(m, u)).invoice;
      const r = await sendInvoice(target.id, u);
      await audit({ action: "delivery.invoice.send", userId: u.id, userName: u.name, details: `${m} ${target.invoiceNumber}` });
      revalidatePath("/deliveries");
      redirect(`/deliveries?month=${m}&${r.ok ? "ok" : "error"}=` + encodeURIComponent(r.message));
    } catch (e) {
      if (e && typeof e === "object" && "digest" in e) throw e;
      redirect(`/deliveries?month=${m}&error=` + encodeURIComponent(e instanceof Error ? e.message : "Could not send that."));
    }
  }

  async function testSend(fd: FormData) {
    "use server";
    const u = await requireManager();
    const m = String(fd.get("month") ?? "");
    try {
      const r = await sendTestInvoice(m, String(fd.get("to") ?? ""), u);
      await audit({ action: "delivery.invoice.test", userId: u.id, userName: u.name, details: m });
      redirect(`/deliveries?month=${m}&${r.ok ? "ok" : "error"}=` + encodeURIComponent(r.message));
    } catch (e) {
      if (e && typeof e === "object" && "digest" in e) throw e;
      redirect(`/deliveries?month=${m}&error=` + encodeURIComponent(e instanceof Error ? e.message : "Could not send that."));
    }
  }

  async function skip(fd: FormData) {
    "use server";
    const u = await requireManager();
    const m = String(fd.get("month") ?? "");
    try {
      await skipMonth(m, String(fd.get("reason") ?? ""));
      await audit({ action: "delivery.month.skip", userId: u.id, userName: u.name, details: m });
      revalidatePath("/deliveries");
      revalidatePath("/");
      redirect(
        `/deliveries?month=${m}&ok=` +
          encodeURIComponent(
            `${monthLabel(m)} is marked as handled outside this site. It will not be chased or invoiced from here, and the reason you gave is the record of why there is no invoice for it.`,
          ),
      );
    } catch (e) {
      if (e && typeof e === "object" && "digest" in e) throw e;
      redirect(`/deliveries?month=${m}&error=` + encodeURIComponent(e instanceof Error ? e.message : "Could not do that."));
    }
  }

  async function unskip(fd: FormData) {
    "use server";
    const u = await requireManager();
    const m = String(fd.get("month") ?? "");
    await unskipMonth(m);
    await audit({ action: "delivery.month.unskip", userId: u.id, userName: u.name, details: m });
    revalidatePath("/deliveries");
    revalidatePath("/");
    redirect(`/deliveries?month=${m}&ok=` + encodeURIComponent(`${monthLabel(m)} is being tracked here again.`));
  }

  async function saveSettings(fd: FormData) {
    "use server";
    const u = await requireManager();
    const dollars = Number(fd.get("rate") ?? 0);
    if (!Number.isFinite(dollars) || dollars <= 0) {
      redirect("/deliveries?settings=1&error=" + encodeURIComponent("The rate has to be an amount in dollars."));
    }
    await setSetting("driver_name", String(fd.get("driverName") ?? "").trim());
    await setSetting("driver_bill_to", String(fd.get("billTo") ?? "").trim());
    await setSetting("driver_invoice_to", String(fd.get("sendTo") ?? "").trim());
    await setSetting("driver_rate_cents", String(Math.round(dollars * 100)));
    await setSetting("driver_payment_terms", String(fd.get("terms") ?? "").trim());
    // Whose money this is. It decides whether the month's invoices are a cost of the pharmacy or
    // somebody else's bill the site merely raises, and the monthly account follows it either way.
    await setSetting("driver_paid_by", fd.get("paidBy") === "pharmacy" ? "pharmacy" : "clinic");
    await setSetting("driver_invoice_auto", fd.get("auto") ? "yes" : "no");
    await audit({ action: "delivery.settings", userId: u.id, userName: u.name });
    revalidatePath("/deliveries");
    redirect(
      "/deliveries?ok=" +
        encodeURIComponent(
          "Saved. The rate applies to invoices raised from now on — anything already sent keeps the rate it was billed at.",
        ),
    );
  }

  const needsSetup = !parties.sendTo || parties.driverName === "the driver";

  return (
    <>
      <PageHeader
        title="Deliveries"
        subtitle={`One number a day and the invoice takes care of itself. Every trip — each delivery and the daily mail run — is ${money(state.rateCents)}.`}
        actions={
          <>
            <Link href="/deliveries?settings=1" className="btn">Driver and rate</Link>
            {state.entered > 0 && (
              /*
                The document itself, not a page that resembles it.

                This is the exact PDF that will be attached to the email, opened in the browser's
                own viewer — so looking at it is looking at what Shelly will get, and the viewer's
                print button is the other half of what was asked for.
              */
              <a href={`/deliveries/${month}/preview`} target="_blank" rel="noreferrer" className="btn btn-primary">
                View and print the invoice
              </a>
            )}
          </>
        }
      />

      {sp.ok && <Notice kind="ok">{sp.ok}</Notice>}
      {sp.error && <Notice kind="crit">{sp.error}</Notice>}

      {needsSetup && (
        <Notice kind="warn">
          <b>Set the driver and the address the invoice goes to before the month ends.</b> Without them the month can be
          filled in but nothing can be sent. <Link href="/deliveries?settings=1" className="underline">Do that now</Link>.
        </Notice>
      )}

      {/* ── Who and how much ─────────────────────────────────────────── */}
      {sp.settings === "1" && canManage && (
        <Card title="Driver, rate, and who the invoice goes to" className="mt-4 mb-6">
          <form action={saveSettings} className="grid gap-3 sm:grid-cols-2">
            <label className="text-xs font-medium text-ink-2">
              Driver — the invoice is raised in this name
              <input name="driverName" defaultValue={parties.driverName === "the driver" ? "" : parties.driverName} className="field mt-1" placeholder="David Swope" />
            </label>
            <label className="text-xs font-medium text-ink-2">
              Billed to
              <input name="billTo" defaultValue={parties.billToName} className="field mt-1" />
            </label>
            <label className="text-xs font-medium text-ink-2">
              Emailed to
              <input name="sendTo" type="email" defaultValue={parties.sendTo} className="field mt-1" placeholder="snelsen@wwfppa.com" />
            </label>
            <label className="text-xs font-medium text-ink-2">
              Who pays the driver
              <select name="paidBy" defaultValue={paidBy} className="field mt-1">
                <option value="clinic">The clinic, direct — the pharmacy only raises the invoice</option>
                <option value="pharmacy">The pharmacy</option>
              </select>
              <span className="mt-1 block font-normal text-ink-3">
                This is the only thing that decides whether the round is a cost of the pharmacy. Raising an invoice
                says nothing about whose money it is, so the monthly account either books it as an operating cost or
                names it as money that is not the pharmacy&rsquo;s — and says which.
              </span>
            </label>
            <label className="text-xs font-medium text-ink-2">
              Paid per trip — each delivery, and each mail run
              <input
                name="rate"
                type="number"
                step="0.01"
                min="0.01"
                defaultValue={(state.rateCents / 100).toFixed(2)}
                className="field mt-1"
              />
            </label>
            <label className="text-xs font-medium text-ink-2 sm:col-span-2">
              How to pay, as it prints on the invoice
              <input name="terms" defaultValue={parties.terms} className="field mt-1" />
            </label>
            <label className="flex items-start gap-2 text-sm sm:col-span-2">
              <input type="checkbox" name="auto" defaultChecked={parties.autoSend} className="mt-0.5" />
              <span>
                Send the invoice on its own, as soon as the last weekday of the month has been entered.
                <span className="block text-xs text-ink-3">
                  Turn this off and the month still adds itself up — you press send yourself. On is what stops the
                  driver waiting for somebody to remember.
                </span>
              </span>
            </label>
            <div className="sm:col-span-2">
              <button className="btn btn-primary">Save</button>
              <Link href={here} className="btn ml-1.5">Done</Link>
            </div>
          </form>
        </Card>
      )}

      {/* ── The month ────────────────────────────────────────────────── */}
      <div className="mt-4 flex flex-wrap items-center gap-2">
        <form className="flex items-center gap-1.5">
          <label className="text-xs font-medium text-ink-2">Month</label>
          <select name="month" defaultValue={month} className="field w-auto py-1 text-sm">
            {known.map((m) => <option key={m} value={m}>{monthLabel(m)}</option>)}
          </select>
          <button className="btn btn-sm">Show</button>
        </form>
      </div>

      <div className="mt-3 grid gap-3 sm:grid-cols-4">
        <Figure
          value={`${state.entered}/${state.weekdays}`}
          label="Weekdays entered"
          sub={state.complete ? "The month is finished" : `${state.missing.length} still to answer`}
          tone={state.complete ? "ok" : state.missing.length ? "warn" : "muted"}
        />
        <Figure value={state.deliveries} label="Deliveries" sub="Prescriptions taken out" tone="muted" />
        <Figure value={state.mailTrips} label="Mail trips" sub="One on a normal weekday" tone="muted" />
        <Figure
          value={money(state.totalCents)}
          label={state.complete ? "Invoiced" : "So far"}
          sub={`${state.trips} trips at ${money(state.rateCents)}`}
          tone={state.complete ? "ok" : "muted"}
        />
      </div>

      {/*
        The state of the invoice, said plainly and in one place.

        Somebody looking at this page wants to know one thing above all: has the driver been paid
        for this month, or is something still owed from me. Everything else on the page serves
        that question.
      */}
      {state.invoice && (
        <Notice kind={state.changedSinceSent ? "warn" : state.invoice.status === "sent" ? "ok" : "warn"}>
          {state.changedSinceSent ? (
            <>
              <b>The figures have moved since invoice {state.invoice.invoiceNumber} was sent.</b> It billed{" "}
              {state.invoice.deliveries} deliveries and {state.invoice.mailTrips} mail trips; the month now says{" "}
              {state.deliveries} and {state.mailTrips}. Send a corrected invoice and the first one is marked replaced —
              the person paying needs to see a second document rather than find the first one changed.
            </>
          ) : (
            <>
              <b>
                Invoice {state.invoice.invoiceNumber} — {money(state.invoice.totalCents)} — {statusLabel(state.invoice.status)}
              </b>
              {state.invoice.sentAt ? ` to ${state.invoice.sentTo} on ${fmt(state.invoice.sentAt.slice(0, 10))}.` : "."}
              {state.invoice.sendError && <> The error was: {state.invoice.sendError}</>}
            </>
          )}
          {canManage && (state.changedSinceSent || state.invoice.status !== "sent") && (
            <form action={sendNow} className="mt-2">
              <input type="hidden" name="month" value={month} />
              <button className="btn btn-sm btn-primary">
                {state.changedSinceSent ? "Send a corrected invoice" : "Send it now"}
              </button>
            </form>
          )}
        </Notice>
      )}

      {!state.invoice && state.complete && canManage && (
        <Notice kind="warn">
          <b>{state.label} is finished and has not been invoiced.</b> {money(state.totalCents)} for {state.trips} trips.
          <form action={sendNow} className="mt-2">
            <input type="hidden" name="month" value={month} />
            <button className="btn btn-sm btn-primary">Raise it and send it</button>
          </form>
        </Notice>
      )}

      {/*
        A month this site was never asked to cover.

        The pharmacy was running before this screen existed, and August was invoiced the old way.
        The site then found twenty-one weekdays with no answer and said so every day — which is
        the alert working exactly as told, against a month nobody intended it to cover. Saying so
        once has to be possible, and the reason given is then the record of why there is no
        invoice here for that month.
      */}
      {!scope.ours ? (
        <Notice kind="ok">
          <b>{state.label} is not tracked here.</b> {scope.why} Nothing about it is chased or invoiced from this site.
          {canManage && (
            <form action={unskip} className="mt-2">
              <input type="hidden" name="month" value={month} />
              <button className="btn btn-sm">Track this month here after all</button>
            </form>
          )}
        </Notice>
      ) : (
        state.missing.length > 0 &&
        canManage && (
          <details className="mt-4">
            <summary className="cursor-pointer text-sm text-ink-3 hover:text-ink">
              Was {state.label} handled outside this site?
            </summary>
            <Card className="mt-2">
              <p className="card-sub">
                If this month was invoiced the old way, say so and the site will stop asking for its {state.missing.length}{" "}
                missing {state.missing.length === 1 ? "day" : "days"}. Nothing is deleted, and the reason you give is
                what explains the gap later.
              </p>
              <form action={skip} className="mt-2 flex flex-wrap items-end gap-2">
                <input type="hidden" name="month" value={month} />
                <label className="text-xs font-medium text-ink-2">
                  Why
                  <input
                    name="reason"
                    defaultValue="Invoiced outside this site before deliveries were recorded here."
                    className="field mt-1 w-96"
                  />
                </label>
                <button className="btn">Stop tracking this month</button>
              </form>
            </Card>
          </details>
        )
      )}

      {/*
        Seeing it and proving it, before anybody outside the pharmacy does.

        Everything about this arrangement is automatic, which is the point and also the risk: the
        first time anybody would otherwise learn whether the mail actually arrives is when the
        driver asks why he has not been paid. So the document can be read on screen at any point
        in the month, and the whole path — same PDF, same attachment, same server — can be proved
        against an address that does not matter.
      */}
      {state.entered > 0 && canManage && (
        <Card
          title="Check it before it goes"
          subtitle={
            state.invoice
              ? "The invoice below is the one that was sent. Opening it shows the exact file that was attached."
              : "The month is not finished, so this is a draft — the same layout and the same figures, without an invoice number. The number is issued when it is raised."
          }
          className="mt-4"
        >
          <div className="flex flex-wrap items-end gap-3">
            <a href={`/deliveries/${month}/preview`} target="_blank" rel="noreferrer" className="btn btn-primary">
              View and print it
            </a>
            <form action={testSend} className="flex flex-wrap items-end gap-2">
              <input type="hidden" name="month" value={month} />
              <label className="text-xs font-medium text-ink-2">
                Or send a test copy to
                <input
                  name="to"
                  type="email"
                  required
                  placeholder="your own address"
                  className="field mt-1 w-56"
                />
              </label>
              <button className="btn">Send the test</button>
            </form>
          </div>
          <p className="mt-2 text-xs text-ink-3">
            Opening it uses your browser&rsquo;s own PDF viewer, so print is the button in there. A test copy goes
            nowhere near {parties.sendTo || "the payer"}, issues no invoice number, and leaves the month exactly as it
            is — it only proves that the mail arrives with the attachment readable.
          </p>
        </Card>
      )}

      <Card
        title={state.label}
        count={`${state.entered} of ${state.weekdays} weekdays`}
        subtitle={
          state.missing.length
            ? "The days with nothing in them are the ones holding the invoice up. A day the pharmacy was shut is entered as zero rather than left blank — that is what tells the month it is finished."
            : state.complete
              ? "Every weekday has an answer, so this month is complete."
              : "Nothing left to answer yet — the rest of the month has not happened."
        }
        className="mt-4"
      >
        {state.slots.length === 0 ? (
          <Empty>That month has no weekdays, which should not be possible. Pick another.</Empty>
        ) : (
          <div className="overflow-x-auto">
            <table className="table">
              <thead>
                <tr><th>Date</th><th>Day</th><th>Deliveries</th><th>Mail</th><th>Trips</th><th>Amount</th><th>Why, if none</th><th></th></tr>
              </thead>
              <tbody>
                {state.slots.map((slot) => {
                  const missing = !slot.day && !slot.future;
                  return (
                    <tr key={slot.onDate} className={missing ? "bg-crit-soft" : undefined}>
                      <td className="whitespace-nowrap text-sm font-medium">{fmt(slot.onDate)}</td>
                      <td className="whitespace-nowrap text-xs text-ink-3">{slot.weekday}</td>
                      {slot.future ? (
                        <td colSpan={6} className="text-xs text-ink-3">Has not happened yet.</td>
                      ) : canManage ? (
                        <>
                          <td colSpan={5}>
                            <form action={save} className="flex flex-wrap items-center gap-1.5">
                              <input type="hidden" name="onDate" value={slot.onDate} />
                              <input
                                name="deliveries"
                                type="number"
                                min="0"
                                max="200"
                                defaultValue={slot.day?.deliveries ?? ""}
                                placeholder="0"
                                aria-label={`Deliveries on ${slot.onDate}`}
                                className="field w-16 py-1 text-sm"
                              />
                              <input
                                name="mailTrips"
                                type="number"
                                min="0"
                                max="10"
                                defaultValue={slot.day?.mailTrips ?? 1}
                                aria-label={`Mail trips on ${slot.onDate}`}
                                className="field w-14 py-1 text-sm"
                              />
                              <span className="w-14 text-sm tabular-nums text-ink-3">
                                {slot.day ? `${slot.trips} trip${slot.trips === 1 ? "" : "s"}` : "—"}
                              </span>
                              <span className="w-16 text-sm font-medium tabular-nums">
                                {slot.day ? money(slot.amountCents) : ""}
                              </span>
                              <input
                                name="note"
                                defaultValue={slot.day?.note ?? ""}
                                placeholder={slot.day && slot.trips === 0 ? "Closed? Say why" : "note"}
                                aria-label={`Note for ${slot.onDate}`}
                                className="field w-40 py-1 text-xs"
                              />
                              <button className="btn btn-sm">{slot.day ? "Update" : "Save"}</button>
                            </form>
                          </td>
                        </>
                      ) : (
                        <>
                          <td className="text-sm tabular-nums">{slot.day?.deliveries ?? "—"}</td>
                          <td className="text-sm tabular-nums">{slot.day?.mailTrips ?? "—"}</td>
                          <td className="text-sm tabular-nums">{slot.day ? slot.trips : "—"}</td>
                          <td className="text-sm tabular-nums">{slot.day ? money(slot.amountCents) : "—"}</td>
                          <td className="text-xs text-ink-3">{slot.day?.note ?? ""}</td>
                        </>
                      )}
                      <td className="whitespace-nowrap text-right">
                        {slot.day && canManage && (
                          <form action={clear}>
                            <input type="hidden" name="onDate" value={slot.onDate} />
                            <button className="text-xs text-ink-3 hover:text-crit hover:underline" title="Put this day back to having no answer">
                              clear
                            </button>
                          </form>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        <p className="mt-3 text-xs text-ink-3">
          The mail box starts at 1 because there is a mail run every weekday. Set it to 0 on a day the pharmacy was
          shut, and put the reason in the note — it prints on the invoice beside that day, so nobody has to ask what
          happened on the 25th.
        </p>
      </Card>

      {/* ── Every invoice ever raised ────────────────────────────────── */}
      <Card
        title="Invoices"
        count={invoices.length}
        subtitle="Every month, kept as it was sent. The totals and the rate are frozen into each one, so a rate change next year cannot rewrite what was billed last year."
        className="mt-6"
      >
        {invoices.length === 0 ? (
          <Empty>Nothing has been invoiced yet. Finish a month and the first one raises itself.</Empty>
        ) : (
          <div className="overflow-x-auto">
            <table className="table">
              <thead>
                <tr><th>Month</th><th>Invoice</th><th>Trips</th><th>Amount</th><th>State</th><th>Sent to</th><th></th></tr>
              </thead>
              <tbody>
                {invoices.map((inv) => (
                  <tr key={inv.id} className={inv.status === "superseded" ? "opacity-60" : undefined}>
                    <td className="whitespace-nowrap text-sm">
                      <Link href={`/deliveries?month=${inv.month}`} className="text-accent hover:underline">
                        {monthLabel(inv.month)}
                      </Link>
                    </td>
                    <td className="font-mono text-xs">{inv.invoiceNumber}</td>
                    <td className="text-sm tabular-nums">{inv.deliveries + inv.mailTrips}</td>
                    <td className="text-sm font-medium tabular-nums">{money(inv.totalCents)}</td>
                    <td>
                      <span
                        className={`badge ${inv.status === "sent" ? "badge-ok" : inv.status === "failed" ? "badge-crit" : "badge-muted"}`}
                      >
                        {statusLabel(inv.status)}
                      </span>
                    </td>
                    <td className="text-xs text-ink-3">
                      {inv.sentTo ?? "—"}
                      {inv.sentAt ? ` · ${fmt(inv.sentAt.slice(0, 10))}` : ""}
                    </td>
                    <td className="whitespace-nowrap">
                      {/*
                        The filed copy where there is one — that is the document that was actually
                        attached to the email, byte for byte. Rebuilding it from the row would be
                        showing today's arithmetic rather than what was sent.
                      */}
                      <a
                        href={inv.documentId ? `/files/${inv.documentId}` : `/deliveries/${inv.month}/preview`}
                        target="_blank"
                        rel="noreferrer"
                        className="btn btn-sm"
                      >
                        Open
                      </a>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <p className="mt-4 text-xs text-ink-3">
        The rate is {money(state.rateCents)} a trip{state.rateCents === DEFAULT_RATE_CENTS ? "" : " (changed from the default)"}, the
        invoice goes to {parties.sendTo || "nobody yet"}, and it is raised in the name of {parties.driverName}.
        {parties.autoSend ? " It sends itself when the last weekday of the month is entered." : " Automatic sending is off, so you press send."}
      </p>
    </>
  );
}
