import Link from "next/link";
import { requireUser } from "@/lib/auth";
import { findAnything, KIND_LABEL, type Found, type FoundKind } from "@/lib/find";
import { PageHeader, Card, Empty } from "@/components/ui";

export const dynamic = "force-dynamic";
export const metadata = { title: "Find" };

/**
 * One box, everything in it.
 *
 * The pharmacist-in-charge said the thing that decides this page: he cannot be hunting for where
 * something lives while an inspector is at the counter. A menu is a map you have to have learned.
 * A search box is one you do not — everything he might be asked for has a name, and typing the
 * name should land on it.
 *
 * Results are grouped by what they are rather than mixed by score. Somebody who typed a person's
 * name wants the person; somebody who typed a drug wants the invoice; and a single ranked list
 * makes both of them read past things to find out which they got.
 */
export default async function FindPage({ searchParams }: { searchParams: Promise<{ q?: string }> }) {
  await requireUser();
  const { q } = await searchParams;
  const query = (q ?? "").trim();
  const results = query ? await findAnything(query) : [];

  const grouped = new Map<FoundKind, Found[]>();
  for (const r of results) grouped.set(r.kind, [...(grouped.get(r.kind) ?? []), r]);

  return (
    <>
      <PageHeader
        title="Find anything"
        subtitle="People, licences, forms, policies, documents, invoices and every screen in the site. Type what you would say out loud."
      />

      <Card className="mb-6">
        <form className="flex flex-wrap items-center gap-2">
          <input
            name="q"
            defaultValue={query}
            autoFocus
            placeholder="Nicole, CPR, C-250, oxycodone, recall, 7656147111"
            className="field max-w-lg"
            aria-label="Find anything"
          />
          <button className="btn btn-primary">Find</button>
          {query && <Link href="/find" className="btn">Clear</Link>}
        </form>
        {!query && (
          <div className="mt-4 text-sm text-ink-2">
            <p className="text-xs font-semibold uppercase tracking-wide text-ink-3">Things people look for</p>
            <ul className="mt-2 flex flex-wrap gap-1.5">
              {[
                "technician list",
                "power of attorney",
                "CPR",
                "inventory",
                "temperature log",
                "recall",
                "business associate",
                "privacy",
                "protocol",
              ].map((t) => (
                <li key={t}>
                  <Link href={`/find?q=${encodeURIComponent(t)}`} className="btn btn-sm">{t}</Link>
                </li>
              ))}
            </ul>
          </div>
        )}
      </Card>

      {query && results.length === 0 && (
        <Empty>
          Nothing matches “{query}”. Try one word rather than several — every word you type has to appear, so a
          shorter search finds more.
        </Empty>
      )}

      {[...grouped.entries()].map(([kind, items]) => (
        <Card key={kind} title={KIND_LABEL[kind]} count={items.length} className="mb-4">
          <ul className="rows">
            {items.map((r) => (
              <li key={`${r.kind}-${r.href}-${r.title}`} className="py-2">
                <Link href={r.href} className="text-sm font-medium text-accent hover:underline">
                  {r.title}
                </Link>
                <span className="ml-2 text-xs text-ink-3">{r.where}</span>
                {r.detail && <p className="mt-0.5 text-xs leading-relaxed text-ink-2">{r.detail}</p>}
              </li>
            ))}
          </ul>
        </Card>
      ))}
    </>
  );
}
