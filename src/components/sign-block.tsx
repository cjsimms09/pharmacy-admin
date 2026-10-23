import {
  SIGNABLE,
  contentChanged,
  type RecordSignature,
} from "@/lib/record-signatures";

/**
 * The end of a record the pharmacy produces: signed, or waiting to be.
 *
 * One component because every one of these documents ends the same way, and because the parts
 * that make an electronic signature hold up under the ESIGN Act and the Kansas UETA are easy to
 * leave out one page at a time. Written once, they cannot be.
 *
 * On screen, unsigned, it is a box to tick and a name to type — two deliberate acts, because
 * "intent to sign" is exactly what one button labelled Sign fails to establish.
 *
 * Signed, it prints as the signature: the statement that was agreed to, who signed it, when, and
 * from where. That is more than a wet signature carries, and it is what makes the printed copy
 * worth handing over rather than a page with a blank line on it.
 */
export function SignBlock({
  kind,
  recordKey,
  signature,
  content,
  action,
  canSign,
  defaultName,
  backTo,
  earlier = [],
}: {
  kind: string;
  recordKey: string;
  signature: RecordSignature | null;
  /** Signatures made against previous versions of this same record, newest first. */
  earlier?: RecordSignature[];
  /** What the signature is bound to, so a later edit shows up rather than passing silently. */
  content?: string;
  action: (fd: FormData) => void | Promise<void>;
  canSign: boolean;
  defaultName: string;
  backTo: string;
}) {
  const spec = SIGNABLE[kind];
  if (!spec) return null;
  const changed = contentChanged(signature, content);

  const signed = signature ? (
    <div className="print-signature mt-6 border border-black p-3 text-[10px] leading-relaxed">
      <p className="text-[11px] font-bold">Electronically signed</p>
      <p className="mt-1 italic">&ldquo;{signature.statement}&rdquo;</p>
      <dl className="mt-2 grid grid-cols-2 gap-x-6 gap-y-0.5">
        <div className="col-span-2">
          <span className="font-semibold">{signature.signedName}</span>
          {signature.signedRole ? ` — ${signature.signedRole}` : ""}
        </div>
        <div>
          <span className="font-semibold">Signed</span>{" "}
          {new Date(signature.signedAt).toLocaleString()}
        </div>
        <div>
          <span className="font-semibold">From</span>{" "}
          {signature.signedIp ?? "address not recorded"}
        </div>
      </dl>
      <p className="mt-2 text-[9px]">
        Signed electronically under the Electronic Signatures in Global and
        National Commerce Act (15 U.S.C. 7001) and the Kansas Uniform Electronic
        Transactions Act (K.S.A. 16-1601 et seq.). The signature, the exact
        wording agreed to, the time, and the identity of the signer are retained
        in this pharmacy&rsquo;s compliance system and are reproducible on
        request.
      </p>

      {/*
          The one thing a wet signature cannot do: notice that the page changed underneath it.

          The record's own content is fingerprinted at the moment of signing, so a figure edited
          afterwards is visible here rather than leaving a signature standing against a document
          nobody actually signed.
        */}
      {changed && (
        <p className="mt-2 border border-black p-1.5 text-[9px] font-semibold">
          This record has changed since it was signed. The signature above
          stands against the version as it was on{" "}
          {new Date(signature.signedAt).toLocaleDateString()}, and remains a
          true certification of that version. The current version is not yet
          certified.
        </p>
      )}

      {/*
          Earlier certifications of earlier versions.

          Kept and printed rather than replaced, because "certified in February, re-certified in
          March" is the sentence that says the file was under certification the whole time. A
          single latest signature cannot say it.
        */}
      {earlier.length > 0 && (
        <div className="mt-2 border-t border-black pt-1.5 text-[9px]">
          <span className="font-semibold">
            Earlier certifications of earlier versions:
          </span>{" "}
          {earlier
            .map(
              (e) =>
                `${e.signedName} on ${new Date(e.signedAt).toLocaleDateString()}`,
            )
            .join("; ")}
          .
        </div>
      )}
    </div>
  ) : null;

  /*
   * Signed, and then the record moved on.
   *
   * The old behaviour refused a second signature outright, which meant the only route back to a
   * certified current version was to withdraw a signature that was true of the version it covered.
   * That is backwards: nothing about February stopped being true because March happened. So the
   * standing signature stays, and the form comes back — once, and only once the content has
   * actually changed.
   */
  if (signed && !changed) return signed;

  return (
    <>
      {signed}
      <div className={signed ? "no-print mt-4" : "print-signature mt-6"}>
        {/* Printed: the old blank line, for anybody who would rather sign this one in ink. */}
        <div className="hidden print:block text-xs">
          <p>{spec.statement}</p>
          <p className="mt-6">
            {defaultName}, pharmacist-in-charge: ______________________________
            Date: ______________
          </p>
        </div>

        {canSign ? (
          <div className="no-print rounded-lg border border-line bg-ground p-4">
            <h3 className="text-sm font-semibold">
              {signed ? "Certify the current version" : "Sign this record"}
            </h3>
            {signed && (
              <p className="mt-1 text-xs text-ink-3">
                The record has changed since it was last signed. That signature
                stays where it is and stays true of the version it covered —
                this adds a second one against the version on screen now.
              </p>
            )}
            <p className="mt-1 rounded-md border border-line bg-surface p-3 text-sm italic leading-relaxed">
              &ldquo;{spec.statement}&rdquo;
            </p>
            <form action={action} className="mt-3 space-y-3">
              <input type="hidden" name="kind" value={kind} />
              <input type="hidden" name="recordKey" value={recordKey} />
              <input type="hidden" name="back" value={backTo} />
              {content !== undefined && (
                <input type="hidden" name="content" value={content} />
              )}

              {/*
              Two acts, not one.

              A box and a name rather than a single button, because "intent to sign" is the first
              thing the ESIGN Act asks for and a single button is something people press meaning
              "next". Doing two deliberate things is what makes it a signature.
            */}
              <label className="flex items-start gap-2 text-sm">
                <input
                  type="checkbox"
                  name="intent"
                  value="yes"
                  className="mt-0.5"
                />
                <span>
                  I am signing this record, and I agree to the statement above.
                </span>
              </label>
              <label className="block text-sm">
                Type your full name, as you would sign it
                <input
                  name="typedName"
                  defaultValue={defaultName}
                  className="field mt-1 max-w-sm"
                  autoComplete="name"
                />
              </label>
              <button className="btn btn-primary">
                {signed ? "Sign the current version" : "Sign it"}
              </button>
            </form>
            <p className="mt-2 text-xs text-ink-3">
              Your name, the time, and the address you are signing from are
              recorded with the statement. That is what makes this the equal of
              ink under the ESIGN Act and the Kansas UETA — and it is more than
              a signature on paper carries. Print it afterwards and the
              signature prints with it.
            </p>
          </div>
        ) : (
          <p className="no-print text-xs text-ink-3">
            Only the pharmacist-in-charge or a manager may sign this record.
          </p>
        )}
      </div>
    </>
  );
}
