import Link from "next/link";

/**
 * Page frame that mirrors the Kansas Board of Pharmacy form header so printed output
 * matches the Board's own forms. Use the browser's Print (Ctrl/Cmd+P) → Save as PDF.
 */
export function PrintFrame({
  formTitle,
  formNumber,
  revised,
  backHref,
  children,
  pageLabel,
}: {
  formTitle: string;
  formNumber: string;
  revised: string;
  backHref: string;
  children: React.ReactNode;
  pageLabel?: string;
}) {
  return (
    <div className="mx-auto max-w-[8.5in] bg-white text-black print:max-w-none">
      <div className="no-print mb-4 flex flex-wrap items-center justify-between gap-2 rounded-md border border-line bg-ground px-3 py-2 text-sm">
        <Link href={backHref} className="text-ink-2 hover:text-ink">← Back</Link>
        <span className="text-ink-3">Print with your browser (Ctrl/Cmd + P) to paper or PDF, then sign.</span>
      </div>
      <header className="mb-3 flex items-stretch border border-black">
        <div className="flex w-1/5 items-center justify-center border-r border-black px-2 text-center font-serif text-2xl font-bold">Kansas</div>
        <div className="flex-1 px-2 py-1 text-center text-[11px] leading-tight">
          <div className="text-sm font-bold">STATE BOARD OF PHARMACY</div>
          800 SW Jackson, Suite 1414<br />
          Topeka, Kansas 66612-1244<br />
          www.pharmacy.ks.gov (785) 296-4056<br />
          pharmacy@ks.gov Fax (785) 296-8420
        </div>
        <div className="flex w-[30%] flex-col items-center justify-center border-l border-black bg-rose-200 px-2 text-center print:bg-rose-200">
          <div className="text-sm font-bold">{formTitle}</div>
          <div className="text-sm">{formNumber}</div>
        </div>
      </header>
      {children}
      <footer className="mt-6 flex justify-between text-[10px] text-neutral-700">
        <span>{pageLabel ?? ""}</span>
        <span>Revised {revised}</span>
      </footer>
    </div>
  );
}

export function SignatureLine({ dateLabel = "DATE" }: { dateLabel?: string }) {
  return (
    <div className="mt-8 grid grid-cols-3 gap-6 text-[9px]">
      <div className="border-t border-black pt-1">SIGNATURE</div>
      <div className="border-t border-black pt-1">PRINTED NAME</div>
      <div className="border-t border-black pt-1">{dateLabel}</div>
    </div>
  );
}

export function Check({ on }: { on: boolean }) {
  return <span className="mr-1 inline-block h-3 w-3 border border-black text-center align-middle text-[9px] leading-3">{on ? "✕" : ""}</span>;
}

export function Cell({ label, children, className = "" }: { label: string; children?: React.ReactNode; className?: string }) {
  return (
    <td className={`border border-black px-2 py-1 align-top ${className}`}>
      <span className="block text-[9px] text-neutral-700">{label}</span>
      <span className="text-[11px]">{children}</span>
    </td>
  );
}
