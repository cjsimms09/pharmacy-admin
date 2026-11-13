import "server-only";
import { db, schema } from "@/db";

/**
 * Every NDC the site already knows, for settling the ones that arrive ambiguous.
 *
 * A ten-digit code with no hyphens could be any of three products (see ndc.ts). The catalogues
 * and NADAC between them name tens of thousands of real NDCs, and a bare code that matches exactly
 * one of them is that product. This loads the set once per import — thirty thousand short strings,
 * a few megabytes, held for the length of one file — rather than asking the database per row.
 */
export async function heldNdcs(): Promise<Set<string>> {
  const out = new Set<string>();
  const [items, nadac, claims] = await Promise.all([
    db.select({ ndc11: schema.supplierItems.ndc11 }).from(schema.supplierItems),
    db.selectDistinct({ ndc11: schema.nadacPrices.ndc11 }).from(schema.nadacPrices),
    db.selectDistinct({ ndc11: schema.claims.ndc11 }).from(schema.claims),
  ]);
  for (const r of items) out.add(r.ndc11);
  for (const r of nadac) out.add(r.ndc11);
  for (const r of claims) if (r.ndc11) out.add(r.ndc11);
  return out;
}
