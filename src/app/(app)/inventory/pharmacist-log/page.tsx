import Link from "next/link";
import { requireUser } from "@/lib/auth";
import { getSettings } from "@/lib/settings";
import { db, schema } from "@/db";
import { eq } from "drizzle-orm";
import { todayIso, fmtLong } from "@/lib/dates";
import { PrintFrame } from "@/components/print";

export const dynamic = "force-dynamic";
export const metadata = { title: "Daily pharmacist log statement" };

/**
 * The statement that goes in the front of the daily pharmacist log book.
 *
 * This is one of the few places where a pharmacy's paperwork is prescribed almost word for word,
 * and one of the easiest to get wrong by paraphrasing. A pharmacy running an automated system for
 * Schedule III and IV refill information has two ways to satisfy 21 CFR 1306.22(f): produce a
 * daily hard-copy printout of that day's refill data and have every pharmacist involved verify
 * and sign it, or keep a bound log book — or separate file — in which each pharmacist signs a
 * statement each day attesting that the refill information entered that day has been reviewed by
 * them and is correct as shown.
 *
 * Almost every retail pharmacy takes the second route, because the first means printing and
 * signing a stack of paper every single day. The catch is that the log book only counts if the
 * statement being signed actually says what the regulation requires it to say — and a fresh log
 * book bought in January arrives blank. This prints that statement, correctly worded, ready to be
 * pasted inside the cover.
 *
 * The signature sheet is offered alongside because a bound log with no ruled space for the daily
 * signature invites exactly the gaps an inspector looks for: a run of days with nothing on them
 * and nobody able to say whether the review happened.
 */
export default async function PharmacistLogPage({
  searchParams,
}: {
  searchParams: Promise<{ year?: string; sheet?: string; month?: string }>;
}) {
  const user = await requireUser();
  const { year, sheet, month } = await searchParams;
  const s = await getSettings();
  const people = await db.query.people.findMany({ where: eq(schema.people.active, true) });
  const pharmacists = people.filter((p) => p.role === "pharmacist");

  const now = new Date();
  const thisYear = String(now.getFullYear());
  const useYear = /^\d{4}$/.test(year ?? "") ? year! : thisYear;
  const useMonth = /^\d{4}-\d{2}$/.test(month ?? "") ? month! : `${useYear}-${String(now.getMonth() + 1).padStart(2, "0")}`;
  const [my, mm] = useMonth.split("-").map(Number);
  const daysInMonth = new Date(my, mm, 0).getDate();
  const monthName = new Date(my, mm - 1, 1).toLocaleDateString(undefined, { month: "long", year: "numeric" });

  const pharmacy = s.pharmacy_name || "This pharmacy";
  const showSheet = sheet === "1";

  return (
    <PrintFrame
      ownDocument
      formTitle={showSheet ? `Daily pharmacist review log — ${monthName}` : "Daily pharmacist log statement"}
      formNumber=""
      revised=""
      backHref="/inventory"
    >
      {/*
        Printed to fit the binder it lives in.
        
        The log book is 8.5 by 6 inches and the statement is taped inside its front cover, so a
        Letter page is not something to trim afterwards — it is the wrong shape to start with. The
        page box is set to half-letter, which every printer offers, and the statement is drawn
        inside a cut line so it can be trimmed to size and taped in whatever the paper it came out
        on. Everything is a point or two smaller to suit.
      */}
      <style>{`@page { size: 8.5in 5.5in; margin: 0.3in; }`}</style>

      <div className="no-print mb-4 space-y-2">
        <div className="flex flex-wrap gap-1.5">
          <Link href={`/inventory/pharmacist-log?year=${useYear}`} className={`btn btn-sm ${showSheet ? "" : "btn-primary"}`}>
            The statement to paste in
          </Link>
          <Link href={`/inventory/pharmacist-log?sheet=1&month=${useMonth}`} className={`btn btn-sm ${showSheet ? "btn-primary" : ""}`}>
            A month of signature lines
          </Link>
        </div>
        <p className="text-xs text-ink-3">
          A new log book each year arrives blank. Print the statement, cut along the dashed line, tape it inside the
          front cover, and the book becomes the record 21 CFR 1306.22(f) asks for. Verify the wording against the
          current regulation before you rely on it — this is reproduced here so you have it to hand, not as legal
          advice.
        </p>
        <p className="text-xs text-ink-3">
          <b>It prints to fit the 8.5 by 6 inch book.</b> In the print box choose <b>Statement</b> or{" "}
          <b>Half Letter (8.5 × 5.5)</b> if your printer offers it, and set Scale to 100%. On ordinary Letter paper it
          still comes out the right size — cut along the dashed line.
        </p>
      </div>

      {!showSheet ? (
        <>
          <div className="mb-2">
            <p className="text-base font-bold">{pharmacy}</p>
            <p className="text-[10px]">
              {[s.pharmacy_address, [s.pharmacy_city, s.pharmacy_state].filter(Boolean).join(", "), s.pharmacy_zip]
                .filter(Boolean)
                .join(" · ")}
            </p>
            <p className="text-[10px]">
              {s.pharmacy_registration_number ? `Kansas pharmacy registration ${s.pharmacy_registration_number}` : ""}
              {s.pharmacy_dea ? ` · DEA registration ${s.pharmacy_dea}` : ""}
            </p>
          </div>

          {/* ── The thing that gets pasted in ── */}
          {/* The piece that is actually taped in. Dashed, so the scissors have somewhere to go. */}
          <div className="print-block border-2 border-dashed border-black p-3">
            <p className="text-center text-[12px] font-bold uppercase tracking-wide">
              Daily review of controlled substance refill information
            </p>
            <p className="mt-0.5 text-center text-[9px]">
              {pharmacy}
              {s.pharmacy_dea ? ` · DEA ${s.pharmacy_dea}` : ""} · Log book for {useYear}
            </p>

            <p className="mt-2.5 text-[10px] leading-snug">
              This pharmacy uses an automated data processing system for the storage and retrieval of prescription
              refill information for controlled substances in Schedules III and IV. In place of a daily hard-copy
              printout, this bound log book is maintained under 21 CFR 1306.22(f).
            </p>

            <p className="mt-2 text-[10px] font-semibold">By signing below on any given day, the pharmacist states:</p>

            <p className="mt-1.5 border-l-4 border-black pl-2 text-[10.5px] italic leading-snug">
              &ldquo;I have reviewed the controlled substance refill information entered into the automated data
              processing system of this pharmacy on the date shown, and I attest that it is correct as shown.&rdquo;
            </p>

            <p className="mt-2 text-[9.5px] leading-snug">
              Each pharmacist involved in dispensing these refills signs for the day on which that dispensing occurred.
              The signature is made in the same manner as the pharmacist would sign a check or other legal document —
              a full or standard signature, not initials.
            </p>

            <p className="mt-2 text-[9.5px] leading-snug">
              This log book is kept at the pharmacy, is available for inspection and copying by authorized officials,
              and is retained for at least five years, which is the Kansas retention period and longer than the two
              years federal law requires.
            </p>

            <div className="mt-3 border-t border-black pt-2">
              <p className="text-[9.5px]">
                Placed in this log book on ____________________ by ____________________________________,
                pharmacist-in-charge.
              </p>
            </div>
          </div>

          {/*
            Screen only. This explains the choice to the pharmacist-in-charge; it is not part of
            the statement, and on a page cut to fit a binder every line that is not the statement
            is a line taking room from it.
          */}
          <div className="no-print mt-4 rounded-md border border-line bg-ground p-3 text-[11px] leading-relaxed">
            <p className="font-bold">Why this is here</p>
            <p className="mt-1">
              21 CFR 1306.22(f) gives a pharmacy running an automated system two ways to keep Schedule III and IV
              refill records. The first is a daily hard-copy printout of that day&rsquo;s refill data, verified and
              signed by every pharmacist involved, provided within 72 hours. The second — the one almost every retail
              pharmacy uses — is a bound log book or separate file in which each pharmacist signs a statement each day
              attesting that the refill information entered that day has been reviewed and is correct as shown.
            </p>
            <p className="mt-1">
              The log book only satisfies the rule if the statement being signed says what the rule requires. A blank
              book with a column of signatures in it does not, which is why this page exists and why it is reprinted
              each time a new book is opened.
            </p>
            {pharmacists.length > 0 && (
              <p className="mt-1">
                Pharmacists who may sign this log: {pharmacists.map((p) => `${p.firstName} ${p.lastName}`).join(", ")}.
              </p>
            )}
            <p className="mt-1">Printed {fmtLong(todayIso())} by {user.name}.</p>
          </div>
        </>
      ) : (
        <>
          <div className="mb-2">
            <p className="text-base font-bold">{pharmacy}</p>
            <p className="text-[10px]">
              Daily review of controlled substance refill information — {monthName}
              {s.pharmacy_dea ? ` · DEA ${s.pharmacy_dea}` : ""}
            </p>
            <p className="mt-1 text-[8.5px] leading-snug">
              By signing, the pharmacist attests that the controlled substance refill information entered into this
              pharmacy&rsquo;s automated system on that date has been reviewed and is correct as shown. 21 CFR
              1306.22(f). Sign as you would a check or legal document, not with initials.
            </p>
          </div>
          <table className="w-full border-collapse text-[9px]">
            <thead>
              <tr>
                <th className="w-16 border border-black px-2 py-1 text-left">Date</th>
                <th className="border border-black px-2 py-1 text-left">Pharmacist signature</th>
                <th className="w-40 border border-black px-2 py-1 text-left">Printed name</th>
                <th className="w-24 border border-black px-2 py-1 text-left">Notes</th>
              </tr>
            </thead>
            <tbody>
              {Array.from({ length: daysInMonth }, (_, i) => (
                <tr key={i}>
                  <td className="h-[19px] border border-black px-1.5 py-0">
                    {String(mm).padStart(2, "0")}/{String(i + 1).padStart(2, "0")}
                  </td>
                  <td className="border border-black px-1.5 py-0" />
                  <td className="border border-black px-1.5 py-0" />
                  <td className="border border-black px-1.5 py-0" />
                </tr>
              ))}
            </tbody>
          </table>
          <p className="mt-1.5 text-[8.5px]">
            A day on which the pharmacy was closed should say so rather than be left blank — a run of empty rows is
            indistinguishable from a run of days nobody reviewed.
          </p>
        </>
      )}
    </PrintFrame>
  );
}
