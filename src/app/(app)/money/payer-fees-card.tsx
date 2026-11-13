import { Card, Settled } from "@/components/ui";
import { SubmitButton } from "@/components/submit-button";
import type { PayerFees } from "@/lib/payer-fees";
import { feesView, type FeeRow } from "@/lib/payer-fees-view";
import { decidePayerFee } from "./fee-decisions";

/**
 * What the payers took off the remittances, line by line, with the means to count a line, leave it out or give it back to the
 * rule: one press each, kept across every import (payer-fees-store.ts). The words are payer-fees-view.ts's, so that they can be
 * tested; this lays them out. Where nothing waits for a person it is one line, with the lines behind a tap.
 */

function Presses({ row, period }: { row: FeeRow; period: string }) {
  return (
    <div className="flex flex-wrap items-center justify-end gap-1">
      {row.presses.map((p) => (
        <form key={p.to} action={decidePayerFee}>
          <input type="hidden" name="period" value={period} />
          <input type="hidden" name="key" value={row.key} />
          <input type="hidden" name="to" value={p.to} />
          <SubmitButton pendingLabel="Saving…" className="btn btn-sm">
            {p.label}
          </SubmitButton>
        </form>
      ))}
    </div>
  );
}

function Lines({ title, rows, period, canDecide }: { title: string; rows: FeeRow[]; period: string; canDecide: boolean }) {
  if (!rows.length) return null;
  return (
    <details className="mt-3 text-xs">
      <summary className="cursor-pointer text-ink-3">
        {title} ({rows.length})
      </summary>
      <div className="mt-2 overflow-x-auto">
        <table className="table text-xs">
          <tbody>
            {rows.map((r, i) => (
              <tr key={`${i}|${r.key}`}>
                <td>
                  <div className="text-ink-2">{r.says}</div>
                  <div className="text-ink-3">{r.note}</div>
                </td>
                <td className="whitespace-nowrap text-ink-3">{r.source}</td>
                <td>{canDecide && r.presses.length > 0 && <Presses row={r} period={period} />}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </details>
  );
}

export function PayerFeesCard({ fees, period, canDecide }: { fees: PayerFees; period: { key: string; label: string; months: string[] }; canDecide: boolean }) {
  const v = feesView(fees, period.months, period.label);
  if (v.empty) return <p className="mt-4 text-xs text-ink-3">{v.headline}</p>;
  const behind = (
    <>
      <Lines title="Counted" rows={v.counted} period={period.key} canDecide={canDecide} />
      <Lines title="Left out" rows={v.leftOut} period={period.key} canDecide={canDecide} />
      <Lines title="Not fees" rows={v.notFees} period={period.key} canDecide={canDecide} />
      <Lines title="Already counted once, from a better record" rows={v.keptOut} period={period.key} canDecide={canDecide} />
    </>
  );
  if (!v.waiting.length && !v.differ.length) {
    return (
      <Settled className="mt-4" id="payer-fees" says={`Payer fees on remittances. ${v.headline}`}>
        {behind}
      </Settled>
    );
  }
  return (
    <Card className="mt-4" id="payer-fees" tone="warn" title="Payer fees on remittances" count={v.waiting.length ? `${v.waiting.length} waiting` : undefined}>
      <p className="text-sm">{v.headline}</p>
      {v.differ.map((d) => (
        <p key={d} className="mt-2 rounded border-l-[3px] border-warn bg-warn-soft px-3 py-2 text-xs text-warn">
          {d}
        </p>
      ))}
      {v.waiting.length > 0 && (
        <ul className="rows mt-3">
          {v.waiting.map((r, i) => (
            <li key={`${i}|${r.key}`} className="row">
              <div className="min-w-0">
                <div className="row-title">
                  {r.says}
                  <span className="badge badge-muted ml-2" title="The record this line is read from">
                    {r.source}
                  </span>
                </div>
                <p className="row-why">{r.note}</p>
              </div>
              {canDecide && <Presses row={r} period={period.key} />}
            </li>
          ))}
        </ul>
      )}
      {behind}
    </Card>
  );
}
