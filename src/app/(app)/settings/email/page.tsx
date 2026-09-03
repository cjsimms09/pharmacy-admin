import Link from "next/link";
import { requireManager } from "@/lib/auth";
import { getSettings } from "@/lib/settings";
import { hasMailPassword } from "@/lib/mailbox";
import { PageHeader, BackLink, Notice, Field } from "@/components/ui";
import { removeMailPassword, saveMailSettings, saveSendingServer, sweepNow, testMailSettings, sendTestMail } from "@/app/(app)/inbox/actions";
import { smtpTargets } from "@/lib/send-mail";

export const metadata = { title: "Email" };
export const dynamic = "force-dynamic";

export default async function EmailSettingsPage({ searchParams }: { searchParams: Promise<{ saved?: string; error?: string; detail?: string }> }) {
  await requireManager();
  const { saved, error, detail } = await searchParams;
  const s = await getSettings();
  const configured = await hasMailPassword();

  return (
    <>
      <BackLink href="/settings">Settings</BackLink>
      <PageHeader
        title="Email"
        subtitle="The app checks a mailbox you set aside for reports, saves the attachments, and refuses anything that looks like it contains patient information."
        actions={configured ? <Link href="/inbox" className="btn">Open inbox</Link> : undefined}
      />
      {saved && <Notice>{detail ? detail : "Saved."}</Notice>}
      {error && <Notice kind="crit">{error}</Notice>}

      <section className="card mb-6 max-w-3xl">
        <h2 className="mb-1 font-semibold">Before you start — getting the app password</h2>
        <p className="mb-2 text-sm text-ink-2">
          Google won't let a program sign in with your normal password. You create a separate 16-character
          “App password” for this app instead. It only reads mail, and you can cancel it any time without
          changing your real password.
        </p>
        <ol className="ml-5 list-decimal space-y-1 text-sm text-ink-2">
          <li>Sign in to that Google account in a browser.</li>
          <li>
            Go straight to <a href="https://myaccount.google.com/apppasswords" target="_blank" rel="noreferrer" className="font-mono text-accent underline">myaccount.google.com/apppasswords</a>.
            {" "}Searching the settings for “app password” often finds nothing — use this address.
          </li>
          <li>Type a name like <b>Pharmacy Admin</b> and click <b>Create</b>.</li>
          <li>Google shows a 16-character code in a yellow box. Copy it and paste it below. Spaces don't matter.</li>
        </ol>

        <details className="mt-3">
          <summary className="cursor-pointer text-sm font-medium text-accent">That page won't let me create one</summary>
          <div className="mt-2 space-y-2 text-sm text-ink-2">
            <p>App passwords are hidden unless the account is set up for them. Work through these in order:</p>
            <ol className="ml-5 list-decimal space-y-1">
              <li>
                <b>2-Step Verification must be fully on.</b> Open{" "}
                <a href="https://myaccount.google.com/signinoptions/twosv" target="_blank" rel="noreferrer" className="font-mono text-accent underline">myaccount.google.com/signinoptions/twosv</a>.
                It has to say <b>On</b> at the top. If you only added a phone number for recovery, that is not the same thing.
              </li>
              <li>
                <b>Sign out of every other Google account first.</b> If you're signed in to two accounts at once,
                the page often opens the wrong one. Use a private/incognito window and sign in only to this mailbox.
              </li>
              <li>
                <b>Passkey-only accounts block it.</b> If you set the account to sign in with “Skip password when possible”
                or passkeys alone, Google hides app passwords. Turn that off in Security → How you sign in.
              </li>
              <li>
                <b>Work/school accounts.</b> If this address ends in a company domain rather than @gmail.com, an
                administrator may have switched app passwords off. They can allow it, or use option B below.
              </li>
              <li>
                <b>Advanced Protection Program.</b> If the account is enrolled, app passwords are permanently blocked.
                Use option B below.
              </li>
            </ol>
            <p className="pt-1">
              <b>Option B — use a different mailbox.</b> The app works with any mail provider that allows a normal
              IMAP sign-in. Set the reports to be sent to a mailbox on the pharmacy's own domain, or a provider like
              Fastmail or Zoho, and enter its server details below. Ask and we'll set the details for you.
            </p>
          </div>
        </details>

        <p className="mt-3 text-xs text-ink-3">
          One more thing for Gmail: IMAP must be switched on. In Gmail, click the gear icon → See all settings →
          Forwarding and POP/IMAP → Enable IMAP → Save Changes.
        </p>
      </section>

      <form action={saveMailSettings} className="card mb-6 grid max-w-3xl gap-4 sm:grid-cols-2">
        <h2 className="font-semibold sm:col-span-2">Mailbox</h2>
        <Field label="Email address" hint="The mailbox the reports are sent to.">
          <input name="mail_user" className="field" defaultValue={s.mail_user} placeholder="wwfrxadmin@gmail.com" autoComplete="off" />
        </Field>
        <Field label={configured ? "Replace app password" : "App password"} hint={configured ? "Leave blank to keep the one already saved." : "The 16-character code from the steps above."}>
          <input name="mail_password" type="password" className="field font-mono" placeholder={configured ? "•••• •••• •••• ••••" : "abcd efgh ijkl mnop"} autoComplete="new-password" />
        </Field>
        <Field
          label="Only accept mail from (optional)"
          hint="Leave this empty to accept mail from anyone — right for a mailbox used only for reports. To restrict it later, put one address per line; a whole domain works too, like @pioneerrx.com. Anything not listed is then left unread and never stored."
          className="sm:col-span-2"
        >
          <textarea name="mail_allowed_senders" className="field font-mono" rows={3} defaultValue={s.mail_allowed_senders} placeholder="Empty = accept from anyone" />
        </Field>
        <div className="sm:col-span-2">
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" name="mail_enabled" defaultChecked={s.mail_enabled === "yes"} />
            Check this mailbox automatically every 30 minutes while the app is running
          </label>
        </div>

        <div className="sm:col-span-2">
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" name="mail_auto_import" value="yes" defaultChecked={s.mail_auto_import === "yes"} />
            Load recognised reports automatically, not just file them
          </label>
          <p className="mt-1 text-xs text-ink-3">
            With this on, a claims export, a supplier price file or a NADAC file that arrives by email is loaded the
            moment it lands, so a scheduled report is usable without anyone opening it. Recognition is done by reading
            the file&rsquo;s own column headings rather than trusting its name, and anything not recognised is filed as
            a document exactly as before. The inbox says what each attachment was taken for and what happened.
          </p>
        </div>

        <Field
          label="Which supplier a price file came from"
          hint={
            "One rule per line, written as: something that appears in the sender or subject, then =, then the supplier name. " +
            "A price file with no matching rule is filed but not loaded — prices under the wrong supplier would make the " +
            "purchasing comparison quietly wrong, and a spreadsheet gives no way to tell."
          }
          className="sm:col-span-2"
        >
          <textarea
            name="mail_supplier_rules"
            className="field font-mono"
            rows={4}
            defaultValue={s.mail_supplier_rules}
            placeholder={"mckesson.com = McKesson\norders@topsecondary = Top Rx\nweekly price file = Value Drug"}
          />
        </Field>
        <details className="sm:col-span-2">
          <summary className="cursor-pointer text-xs text-ink-3">Mail server settings (only change these if you're not using Gmail)</summary>
          <div className="mt-2 grid gap-3 sm:grid-cols-2">
            <Field label="IMAP server"><input name="mail_host" className="field font-mono" defaultValue={s.mail_host} /></Field>
            <Field label="Port"><input name="mail_port" className="field font-mono" defaultValue={s.mail_port} /></Field>
          </div>
        </details>
        <div className="flex flex-wrap gap-2 sm:col-span-2">
          <button className="btn btn-primary" type="submit">Save and test</button>
        </div>
      </form>

      {configured && (
        <section className="card mb-6 max-w-3xl">
          <h2 className="mb-3 font-semibold">Status</h2>
          <dl className="grid gap-2 text-sm sm:grid-cols-2">
            <div><dt className="text-xs uppercase tracking-wide text-ink-2">Automatic checking</dt><dd>{s.mail_enabled === "yes" ? <span className="badge badge-ok">on</span> : <span className="badge badge-muted">off</span>}</dd></div>
            <div><dt className="text-xs uppercase tracking-wide text-ink-2">Last check</dt><dd>{s.mail_last_sweep ? `${s.mail_last_sweep.replace("T", " ").slice(0, 16)} UTC` : "never"}</dd></div>
            <div><dt className="text-xs uppercase tracking-wide text-ink-2">Accepting mail from</dt><dd>{s.mail_allowed_senders.trim() ? `${s.mail_allowed_senders.split(/[\n,;]+/).filter((x) => x.trim()).length} listed sender(s)` : "anyone"}</dd></div>
            <div className="sm:col-span-2"><dt className="text-xs uppercase tracking-wide text-ink-2">Last result</dt><dd>{s.mail_last_result || "—"}</dd></div>
          </dl>
          <div className="mt-4 flex flex-wrap gap-2">
            <form action={testMailSettings}><button className="btn">Test reading</button></form>
            <form action={sweepNow.bind(null, "settings")}><button className="btn btn-primary">Check for new mail now</button></form>
            <form action={removeMailPassword}><button className="btn btn-danger">Remove password</button></form>
          </div>
        </section>
      )}

      <section className="card mb-6 max-w-3xl">
          <h2 className="mb-1 font-semibold">Sending</h2>
          <p className="mb-3 text-sm text-ink-2">
            Reading a mailbox and sending from it are different servers on different ports, so one working says nothing
            about the other. Send yourself a test: if it arrives, training links and reminders will reach people. If it
            does not, the exact reason each server gave appears here rather than the email simply never turning up.
          </p>
          {!configured && (
            <p className="mb-3 rounded-md bg-warn-soft px-3 py-2 text-sm text-warn">
              No app password is saved yet, so nothing can be sent. Fill in the mailbox above first.
            </p>
          )}
          <form action={sendTestMail} className="flex flex-wrap items-end gap-2">
            <Field label="Send a test to" className="min-w-64 flex-1">
              <input name="to" type="email" className="field" defaultValue={s.mail_user} placeholder="you@example.com" />
            </Field>
            <button className="btn btn-primary" disabled={!configured}>Send it</button>
          </form>
          <dl className="mt-4 grid gap-2 text-sm sm:grid-cols-2">
            <div className="sm:col-span-2">
              <dt className="text-xs uppercase tracking-wide text-ink-2">Last send</dt>
              <dd className="break-words">{s.mail_last_send_result || "Nothing has been sent yet."}</dd>
            </div>
            <div className="sm:col-span-2">
              <dt className="text-xs uppercase tracking-wide text-ink-2">Will try, in this order</dt>
              <dd className="font-mono text-xs">
                {smtpTargets(s).map((t) => `${t.host}:${t.port}`).join("  ·  ") || "nothing — set the address first"}
              </dd>
            </div>
          </dl>
          <details className="mt-3">
            <summary className="cursor-pointer text-sm font-medium text-accent">Set the sending server by hand</summary>
            <form action={saveSendingServer} className="mt-3 grid gap-3 sm:grid-cols-2">
              <Field label="SMTP server" hint="Only needed if the list above is wrong. Gmail is smtp.gmail.com; Office 365 is smtp.office365.com.">
                <input name="mail_smtp_host" className="field font-mono" defaultValue={s.mail_smtp_host} placeholder="smtp.gmail.com" />
              </Field>
              <Field label="Port" hint="465 for SSL, 587 for STARTTLS.">
                <input name="mail_smtp_port" className="field font-mono" defaultValue={s.mail_smtp_port} placeholder="465" />
              </Field>
              <div className="sm:col-span-2"><button className="btn">Save the sending server</button></div>
            </form>
          </details>
      </section>

      <section className="card max-w-3xl">
        <h2 className="mb-1 font-semibold">What happens to the mail</h2>
        <ul className="ml-5 list-disc space-y-1 text-sm text-ink-2">
          <li>Only unread messages are opened. If you listed allowed senders, everything else is left alone; with the list empty, mail from anyone is accepted.</li>
          <li>Report attachments (PDF, CSV, Excel, text, images) are saved and listed in the Inbox.</li>
          <li>Text reports are checked column by column first. If one looks like a patient name, date of birth, phone, address, or member ID, the file is <b>refused</b> and never stored — you'll see it marked rejected with the column that caused it.</li>
          <li>Processed messages are marked as read in Gmail so the same report is never handled twice.</li>
          <li>The app password is stored encrypted on this computer and is never shown again.</li>
        </ul>
      </section>
    </>
  );
}
