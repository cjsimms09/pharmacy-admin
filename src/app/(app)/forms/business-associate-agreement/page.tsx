import Link from "next/link";
import { requireUser } from "@/lib/auth";
import { getSettings } from "@/lib/settings";
import { BAA_CLAUSES } from "@/lib/patient-forms";
import { todayIso } from "@/lib/dates";
import { PrintFrame } from "@/components/print";
import { Notice } from "@/components/ui";

export const dynamic = "force-dynamic";
export const metadata = { title: "Business associate agreement" };

/**
 * The contract 45 CFR 164.504(e) requires before anyone outside the pharmacy touches PHI.
 *
 * The manual promised one and had nothing behind the heading, which is the worst of both worlds:
 * a document that says the pharmacy has business associate agreements, and no agreement. Every
 * clause here is one the rule names. What the rule does not supply — who the parties are, what
 * the service is — is left blank, because those are the only parts that make it this pharmacy's
 * agreement rather than a specimen.
 *
 * It links back to the register rather than standing alone: an agreement signed and not recorded
 * is one nobody can produce, and producing it is the entire point.
 */
export default async function BusinessAssociateAgreementPage() {
  await requireUser();
  const s = await getSettings();
  const pharmacy = s.pharmacy_name || "This pharmacy";
  const address =
    [s.pharmacy_address, [s.pharmacy_city, s.pharmacy_state].filter(Boolean).join(", "), s.pharmacy_zip]
      .filter(Boolean)
      .join(", ") || null;

  return (
    <PrintFrame
      ownDocument
      formTitle="Business Associate Agreement"
      formNumber=""
      revised={todayIso()}
      backHref="/forms"
      pageLabel={pharmacy}
    >
      <div className="no-print mb-4">
        <Notice kind="warn">
          <b>Have this reviewed before it is used for anything unusual.</b> It carries every provision 45 CFR
          164.504(e)(2) requires and is fit for the ordinary case — a vendor, a billing service, a shredding company.
          A counterparty who wants their own wording, or a service that involves anything beyond routine handling of
          protected health information, is a conversation with a lawyer rather than a form.
          Record every signed agreement in the <Link href="/agreements" className="underline">register</Link>, or the
          pharmacy cannot show it has one.
        </Notice>
      </div>

      <div className="text-[10.5px] leading-relaxed">
        <p>
          This Business Associate Agreement (&ldquo;Agreement&rdquo;) is entered into between{" "}
          <b>{pharmacy}</b>
          {address ? `, ${address}` : ""} (&ldquo;Covered Entity&rdquo;) and the party identified below
          (&ldquo;Business Associate&rdquo;), and governs Business Associate&rsquo;s handling of protected health
          information in connection with the services described.
        </p>

        <div className="mt-4 border border-black p-3">
          <div className="text-[11px] font-bold">The other party, and what they do</div>
          <div className="mt-3 space-y-4 text-[9px]">
            <div>
              <div className="border-b border-black pb-4" />
              <div className="pt-1 uppercase tracking-wide">Business associate — legal name</div>
            </div>
            <div>
              <div className="border-b border-black pb-4" />
              <div className="pt-1 uppercase tracking-wide">Address</div>
            </div>
            <div>
              <div className="border-b border-black pb-4" />
              <div className="pt-1 uppercase tracking-wide">
                The service performed for the pharmacy, and the protected health information it involves
              </div>
            </div>
          </div>
        </div>

        {BAA_CLAUSES.map((c) => (
          <section key={c.heading} className="mt-4">
            <h2 className="text-[11px] font-bold">{c.heading}</h2>
            {c.body.map((p) => <p key={p} className="mt-1.5">{p}</p>)}
          </section>
        ))}

        <div className="print-signature mt-8 grid grid-cols-2 gap-x-12 gap-y-8 text-[9px]">
          <div>
            <div className="border-b border-black pb-0.5 text-[11px]">{pharmacy}</div>
            <div className="pt-1">Covered entity</div>
          </div>
          <div>
            <div className="mt-5 border-b border-black" />
            <div className="pt-1">Business associate</div>
          </div>
          <div>
            <div className="mt-6 border-b border-black" />
            <div className="pt-1">Signature</div>
          </div>
          <div>
            <div className="mt-6 border-b border-black" />
            <div className="pt-1">Signature</div>
          </div>
          <div>
            <div className="mt-6 border-b border-black" />
            <div className="pt-1">Print name and title</div>
          </div>
          <div>
            <div className="mt-6 border-b border-black" />
            <div className="pt-1">Print name and title</div>
          </div>
          <div>
            <div className="mt-6 border-b border-black" />
            <div className="pt-1">Date</div>
          </div>
          <div>
            <div className="mt-6 border-b border-black" />
            <div className="pt-1">Date</div>
          </div>
        </div>

        <p className="mt-6 text-[9px]">
          Two copies signed; one filed by the pharmacy and one kept by the business associate. The pharmacy&rsquo;s
          copy is recorded in the business associate register and retained for six years after the agreement ends.
          45 CFR 164.504(e); 45 CFR 164.530(j)(2).
        </p>
      </div>
    </PrintFrame>
  );
}
