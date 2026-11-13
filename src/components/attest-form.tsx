/**
 * Signing off a compliance duty for a period.
 *
 * One component, used by both the dashboard and the compliance screen, because these two places
 * were drifting apart — and because the parts that make an electronic signature hold up under the
 * ESIGN Act and the Kansas UETA are easy to leave out one page at a time.
 *
 * The wording comes first and in full. It is the evidence: "on 3 September I signed in to K-TRACS
 * and reviewed the submission status for August, all dispensings for that period had been
 * submitted, and any error file was corrected and resubmitted" is a sentence a pharmacist stands
 * behind and an inspector can read three years later. A tick in a box proves somebody clicked.
 *
 * Then two deliberate acts rather than one. A box and a typed name, not a single button — "intent
 * to sign" is the first thing the ESIGN Act asks for, and a lone button is something people press
 * meaning "next". It is a few seconds more, and it is the difference between a record and a log
 * entry.
 */
export function AttestForm({
  action,
  obligationId,
  periodKey,
  statement,
  back,
  defaultName,
  minutes,
}: {
  action: (fd: FormData) => void | Promise<void>;
  obligationId: string;
  periodKey: string;
  statement: string;
  back: string;
  defaultName: string;
  minutes?: number | null;
}) {
  return (
    <form action={action} className="mt-3">
      <input type="hidden" name="obligationId" value={obligationId} />
      <input type="hidden" name="periodKey" value={periodKey} />
      <input type="hidden" name="statement" value={statement} />
      <input type="hidden" name="back" value={back} />

      <p className="rounded-md border border-line bg-ground p-3 text-sm italic text-ink-2">&ldquo;{statement}&rdquo;</p>

      <label className="mt-3 flex items-start gap-2 text-sm">
        <input type="checkbox" name="intent" value="yes" className="mt-0.5" />
        <span>I am signing this, and the statement above is true.</span>
      </label>
      <label className="mt-2 block text-sm">
        Type your full name, as you would sign it
        <input name="typedName" defaultValue={defaultName} className="field mt-1 max-w-sm" autoComplete="name" />
      </label>

      <div className="mt-3 flex flex-wrap items-center gap-3">
        <button className="btn btn-primary">Sign and record</button>
        <span className="text-xs text-ink-3">
          Kept word for word with your name, the time and the address you signed from
          {minutes ? ` · about ${minutes} minute${minutes === 1 ? "" : "s"} of work` : ""}.
        </span>
      </div>
    </form>
  );
}
