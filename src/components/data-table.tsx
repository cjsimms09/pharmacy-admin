"use client";

import { useMemo, useState, type ReactNode } from "react";

/**
 * A table with the tools a table needs: sort by any column, a filter box, and a page size, so a
 * list of two thousand NDCs is a screen and not a scroll.
 *
 * The server renders the cells (links, badges, money already formatted) and sends the sort value
 * beside each, so this component never has to know what a cell means: it sorts on the value it
 * was given, filters on the text of every value, and shows the cells as they came. Money is
 * right-aligned by the column, not the cell, because a column of figures is read down.
 *
 * Nothing here changes a number. A page that wants a total puts it in the caption, computed on
 * the server over every row, so the total is the same whatever the filter shows.
 */
export type Column = {
  key: string;
  label: string;
  /** Figures right, words left. */
  align?: "left" | "right";
  /** Sorting off for columns that are not one thing (a list of gaps, a form). */
  sortable?: boolean;
  /** Which way the first click sorts. Figures usually want the largest first. */
  firstSort?: "asc" | "desc";
  /** Narrow columns keep the header from wrapping. */
  className?: string;
};

export type Row = {
  key: string;
  /** What is shown, by column key. */
  cells: Record<string, ReactNode>;
  /** What is sorted and filtered on, by column key. Null sorts last. */
  sort: Record<string, string | number | null>;
  className?: string;
};

export function DataTable({
  columns,
  rows,
  pageSize = 50,
  filter = true,
  caption,
  empty = "Nothing to show.",
  initialSort,
}: {
  columns: Column[];
  rows: Row[];
  pageSize?: number;
  filter?: boolean;
  caption?: ReactNode;
  empty?: ReactNode;
  initialSort?: { key: string; dir: "asc" | "desc" };
}) {
  const [q, setQ] = useState("");
  const [sort, setSort] = useState<{ key: string; dir: "asc" | "desc" } | null>(initialSort ?? null);
  const [shown, setShown] = useState(pageSize);

  const visible = useMemo(() => {
    const needle = q.trim().toLowerCase();
    let out = needle
      ? rows.filter((r) => Object.values(r.sort).some((v) => v !== null && String(v).toLowerCase().includes(needle)))
      : rows;
    if (sort) {
      const { key, dir } = sort;
      const sign = dir === "asc" ? 1 : -1;
      out = [...out].sort((a, b) => {
        const x = a.sort[key];
        const y = b.sort[key];
        if (x === null || x === undefined) return y === null || y === undefined ? 0 : 1;
        if (y === null || y === undefined) return -1;
        if (typeof x === "number" && typeof y === "number") return (x - y) * sign;
        return String(x).localeCompare(String(y), undefined, { numeric: true, sensitivity: "base" }) * sign;
      });
    }
    return out;
  }, [rows, q, sort]);

  const page = visible.slice(0, shown);

  function clickSort(c: Column) {
    if (c.sortable === false) return;
    setSort((s) => {
      if (s?.key !== c.key) return { key: c.key, dir: c.firstSort ?? (c.align === "right" ? "desc" : "asc") };
      return { key: c.key, dir: s.dir === "asc" ? "desc" : "asc" };
    });
  }

  return (
    <div>
      {(filter || caption) && (
        <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
          <div className="text-xs text-ink-3">{caption}</div>
          {filter && rows.length > 8 && (
            <input
              type="search"
              value={q}
              onChange={(e) => { setQ(e.target.value); setShown(pageSize); }}
              placeholder={`Filter ${rows.length.toLocaleString()} rows…`}
              aria-label="Filter rows"
              className="w-56 !py-1.5 text-sm"
            />
          )}
        </div>
      )}
      <div className="overflow-x-auto">
        <table className="table">
          <thead>
            <tr>
              {columns.map((c) => {
                const active = sort?.key === c.key;
                const sortable = c.sortable !== false;
                return (
                  <th
                    key={c.key}
                    scope="col"
                    className={`${c.align === "right" ? "text-right" : ""} ${c.className ?? ""} ${sortable ? "cursor-pointer select-none hover:text-ink" : ""}`}
                    onClick={() => clickSort(c)}
                    aria-sort={active ? (sort!.dir === "asc" ? "ascending" : "descending") : undefined}
                  >
                    {c.label}
                    {active && <span className="ml-1 text-ink-3">{sort!.dir === "asc" ? "▲" : "▼"}</span>}
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {page.length === 0 && (
              <tr>
                <td colSpan={columns.length} className="py-6 text-center text-sm text-ink-3">
                  {rows.length === 0 ? empty : `Nothing matches “${q}”.`}
                </td>
              </tr>
            )}
            {page.map((r) => (
              <tr key={r.key} className={r.className}>
                {columns.map((c) => (
                  <td key={c.key} className={c.align === "right" ? "num" : ""}>{r.cells[c.key]}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {visible.length > shown && (
        <div className="mt-2 flex items-center justify-between text-xs text-ink-3">
          <span>{shown.toLocaleString()} of {visible.length.toLocaleString()}</span>
          <button type="button" className="btn btn-sm" onClick={() => setShown((n) => n + pageSize)}>
            Show {Math.min(pageSize, visible.length - shown)} more
          </button>
        </div>
      )}
    </div>
  );
}
