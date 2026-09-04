import type { CertificateData } from "@/lib/certificate";
import { fmtLong } from "@/lib/dates";

/**
 * The certificate as it prints.
 *
 * It has to survive two audiences that want opposite things. A person who has just spent twenty
 * minutes on a course wants something that looks like the certificates they have been given
 * before, or it does not feel like it counted. An auditor wants every claim on it to be one the
 * record can actually support, and treats decoration as a warning sign.
 *
 * So: the shape and weight of a real certificate — a ruled border, a seal, centred display type,
 * a signature line — and, below the fold, a plain block of facts including the ones that are
 * inconvenient. It says how the training was delivered, whether the person signed it themselves
 * or the pharmacist-in-charge recorded it for them, which version of the material they were
 * actually sent, and a verification code recomputed on every render. A certificate that omits
 * those is the one that gets picked apart; one that states them is the one that gets accepted.
 */
export function Certificate({ c }: { c: CertificateData }) {
  return (
    <article className="certificate mx-auto max-w-3xl bg-white p-2 text-ink">
      <div className="border-[3px] border-double border-[#0e6b5a] p-8 sm:p-12">
        <header className="text-center">
          <p className="text-[11px] uppercase tracking-[0.35em] text-ink-2">{c.pharmacy.name}</p>
          {c.pharmacy.address && <p className="mt-1 text-[11px] text-ink-3">{c.pharmacy.address}</p>}
          <p className="text-[11px] text-ink-3">
            {c.pharmacy.registration && <>Kansas pharmacy registration {c.pharmacy.registration}</>}
            {c.pharmacy.registration && c.pharmacy.phone ? " · " : ""}
            {c.pharmacy.phone}
          </p>
        </header>

        <div className="mt-8 flex items-center justify-center gap-4">
          <span className="h-px flex-1 bg-line" />
          <p className="whitespace-nowrap text-xs uppercase tracking-[0.4em] text-[#0e6b5a]">
            Certificate of completion
          </p>
          <span className="h-px flex-1 bg-line" />
        </div>

        <p className="mt-10 text-center text-sm text-ink-2">This is to certify that</p>
        <p className="mt-2 text-center font-serif text-4xl leading-tight">{c.personName}</p>
        <p className="mt-1 text-center text-xs uppercase tracking-widest text-ink-3">{c.personRole}</p>

        <p className="mt-8 text-center text-sm text-ink-2">has successfully completed</p>
        <p className="mt-2 text-center font-serif text-2xl leading-snug">{c.courseTitle}</p>

        <p className="mt-6 text-center text-sm">
          on <b>{fmtLong(c.completedOn)}</b>
          {c.minutes ? <> · approximately {c.minutes} minutes of instruction</> : null}
        </p>
        {c.quiz && <p className="mt-1 text-center text-sm text-ink-2">{c.quiz}</p>}
        {c.expiresOn && (
          <p className="mt-3 text-center text-sm text-ink-2">Valid until {fmtLong(c.expiresOn)}, when it falls due again.</p>
        )}

        {/* ── seal and signature ── */}
        <div className="mt-12 flex flex-wrap items-end justify-between gap-8">
          <div className="min-w-[14rem] flex-1">
            <p className="border-t border-ink pt-2 font-serif text-lg">{c.issuedBy.split(",")[0]}</p>
            <p className="text-[11px] uppercase tracking-widest text-ink-3">
              {c.issuedBy.includes(",") ? c.issuedBy.split(",").slice(1).join(",").trim() : "Pharmacist-in-Charge"}
            </p>
          </div>
          <Seal number={c.number} />
        </div>
      </div>

      {/* ── the record behind it ── */}
      <section className="mt-6 border border-line p-6 text-[11px] leading-relaxed">
        <h2 className="text-xs font-semibold uppercase tracking-widest text-ink-2">Record of training</h2>
        <dl className="mt-3 space-y-2">
          {c.authority && <Row term="Requirement addressed" desc={c.authority} />}
          {c.material && <Row term="Material delivered" desc={c.material} />}
          <Row term="How it was delivered" desc={c.how} />
          {c.trainerQualifications && (
            <Row term="Delivered by" desc={`${c.issuedBy.split(",")[0]} — ${c.trainerQualifications}`} />
          )}
          {c.liveQuestions && <Row term="Interactive questions and answers" desc={c.liveQuestions} />}
          {c.provider && <Row term="Provider" desc={c.provider} />}
          {c.statement && <Row term="Attested" desc={<span className="italic">&ldquo;{c.statement}&rdquo;</span>} />}
          {c.signedName && (
            <Row
              term="Signature"
              desc={
                <>
                  Signed electronically as <b>{c.signedName}</b>
                  {c.signedAt ? ` on ${new Date(c.signedAt).toLocaleString()}` : ""}. The typed name, the time and the
                  device were recorded together, which is what makes it a valid electronic signature under the ESIGN
                  Act and the Kansas Uniform Electronic Transactions Act.
                </>
              }
            />
          )}
          <Row
            term="Verification"
            desc={
              <>
                <span className="font-mono">{c.verification}</span> — recomputed from the record every time this is
                produced. A printed copy whose code no longer matches the live record is a copy of something that has
                since changed.
              </>
            }
          />
        </dl>
      </section>
    </article>
  );
}

function Row({ term, desc }: { term: string; desc: React.ReactNode }) {
  return (
    <div className="sm:flex sm:gap-4">
      <dt className="font-semibold sm:w-56 sm:shrink-0">{term}</dt>
      <dd className="text-ink-2">{desc}</dd>
    </div>
  );
}

/**
 * The seal.
 *
 * Drawn rather than an image, so it cannot go missing when the page is printed, saved or emailed,
 * and so it carries the certificate number rather than being pure decoration.
 */
function Seal({ number }: { number: string }) {
  return (
    <div className="relative h-28 w-28 shrink-0">
      <svg viewBox="0 0 100 100" className="h-full w-full" aria-hidden="true">
        <circle cx="50" cy="50" r="47" fill="none" stroke="#0e6b5a" strokeWidth="1.5" />
        <circle cx="50" cy="50" r="41" fill="none" stroke="#0e6b5a" strokeWidth="0.75" />
        {Array.from({ length: 48 }).map((_, i) => {
          const a = (i / 48) * Math.PI * 2;
          return (
            <line
              key={i}
              x1={50 + Math.cos(a) * 47}
              y1={50 + Math.sin(a) * 47}
              x2={50 + Math.cos(a) * 44}
              y2={50 + Math.sin(a) * 44}
              stroke="#0e6b5a"
              strokeWidth="0.6"
            />
          );
        })}
        <text x="50" y="44" textAnchor="middle" fontSize="9" fill="#0e6b5a" letterSpacing="1.5">
          TRAINING
        </text>
        <text x="50" y="56" textAnchor="middle" fontSize="9" fill="#0e6b5a" letterSpacing="1.5">
          RECORD
        </text>
        <line x1="28" y1="62" x2="72" y2="62" stroke="#0e6b5a" strokeWidth="0.6" />
        <text x="50" y="72" textAnchor="middle" fontSize="5.5" fill="#0e6b5a">
          {number.slice(-12)}
        </text>
      </svg>
    </div>
  );
}
