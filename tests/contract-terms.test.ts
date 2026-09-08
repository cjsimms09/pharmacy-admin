import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { ContractTerms, fillNulls, shapeForPrompt, fromWire, termsFromObject, dropUncited, requireCitations } from "../src/lib/contract-terms";
import { z } from "zod";

/** Every place the generated JSON Schema gives a parameter more than one type. */
function unionParameters(node: unknown, path = "", out: string[] = []): string[] {
  if (!node || typeof node !== "object") return out;
  const n = node as Record<string, unknown>;
  if (Array.isArray(n.type) || n.anyOf || n.oneOf) out.push(path || "(root)");
  for (const [k, v] of Object.entries(n)) if (v && typeof v === "object") unionParameters(v, `${path}/${k}`, out);
  return out;
}

describe("the schema the contract reader sends", () => {
  test("has no union-typed parameters, because sixteen is the API's limit and this had 104", () => {
    // The real error, on the pharmacy's own 150-page agreement:
    //   Schemas contains too many parameters with union types (104 parameters with type arrays or
    //   anyOf). This causes exponential compilation cost. ... (limit: 16 parameters with unions).
    // Every read was refused before it began. `.nullable()` is what produced them: it compiles to
    // a type of ["string", "null"]. `.optional()` says the same thing with one type.
    const format = zodOutputFormat(ContractTerms as never) as unknown as Record<string, unknown>;
    const schema = (format.schema ?? (format.json_schema as Record<string, unknown>)?.schema ?? format) as unknown;
    const found = unionParameters(schema);
    assert.deepEqual(found, [], `the schema must send no unions; found ${found.length}`);
  });

  test("a term the contract does not state may simply be left out", () => {
    /*
     * Which is the whole point: the model omits what it cannot find rather than saying null.
     *
     * The fixture is built from the schema itself — every required field filled with the emptiest
     * value of its type and every optional one left out — so a field added next month does not
     * make this test fail for a reason that has nothing to do with what it is checking.
     */
    const format = zodOutputFormat(ContractTerms as never) as unknown as Record<string, unknown>;
    const schema = (format.schema ?? (format.json_schema as Record<string, unknown>)?.schema ?? format) as {
      properties: Record<string, { type?: string; description?: string }>;
      required?: string[];
    };
    const emptiest = (p: { type?: string; description?: string }): unknown => {
      const firstOfEnum = /enum: \[(.*?)\]/.exec(p.description ?? "");
      if (firstOfEnum) return JSON.parse(`[${firstOfEnum[1]}]`)[0];
      if (p.type === "array") return [];
      if (p.type === "object") return {};
      if (p.type === "number" || p.type === "integer") return 0;
      if (p.type === "boolean") return false;
      return "";
    };
    const minimal: Record<string, unknown> = {};
    for (const key of schema.required ?? []) minimal[key] = emptiest(schema.properties[key] ?? {});

    const r = ContractTerms.safeParse(minimal);
    assert.ok(r.success, r.success ? "" : JSON.stringify(r.error.issues.slice(0, 4)));
    assert.ok((schema.required ?? []).length > 0, "the fixture has to have been built from something");
  });
});

describe("turning an absent term back into a null", () => {
  test("every optional the model left out comes back as null, not missing", () => {
    // The rest of the site was written against nulls and reads them with ?. and != null. The type
    // says null, so the object has to actually carry one.
    const S = z.object({ a: z.string().optional(), n: z.number().optional() });
    assert.deepEqual(fillNulls(S, {}), { a: null, n: null });
    assert.deepEqual(fillNulls(S, { a: "x" }), { a: "x", n: null });
  });

  test("it reaches into nested objects and through arrays", () => {
    const Cite = z.object({ quote: z.string(), page: z.number().optional() });
    const S = z.object({ citation: Cite.optional(), rates: z.array(z.object({ fee: z.number().optional() })) });
    assert.deepEqual(fillNulls(S, { rates: [{}, { fee: 2 }] }), { citation: null, rates: [{ fee: null }, { fee: 2 }] });
    assert.deepEqual(fillNulls(S, { citation: { quote: "q" }, rates: [] }), { citation: { quote: "q", page: null }, rates: [] });
  });

  test("an empty array stays an empty array — 'no transaction fees' is an answer, not a gap", () => {
    const S = z.object({ fees: z.array(z.string()) });
    assert.deepEqual(fillNulls(S, { fees: [] }), { fees: [] });
  });

  test("a field the schema no longer knows about is kept, not discarded", () => {
    // An older draft carrying a since-renamed field is still the pharmacy's read of its contract.
    const S = z.object({ a: z.string().optional() });
    assert.deepEqual(fillNulls(S, { a: "x", retired: "keep me" }), { a: "x", retired: "keep me" });
  });
});

describe("the shape the model is asked for, now that it is words and not a grammar", () => {
  test("it names every top-level term the schema carries", () => {
    // Described rather than compiled: 61 fields, 175 leaves and 24 arrays is too large a grammar,
    // and dropping half the terms to fit would lose the reason the read exists.
    const shape = shapeForPrompt();
    for (const field of ["counterparty", "rates", "gcrTiers", "disputeWindows", "macAppealWindowDays", "remittance", "confidence"])
      assert.match(shape, new RegExp(`"${field}"`), `${field} must be described`);
  });

  test("an enum is offered as its actual choices, so the answer can only be one of them", () => {
    const shape = shapeForPrompt();
    assert.match(shape, /"contractType": "payer_network" \| "wholesaler" \| "psao" \| "unknown"/);
    assert.match(shape, /"autoRenews": "yes" \| "no" \| "not stated"/);
  });

  test("a number that may be absent is asked for as text, matching what fromWire reads", () => {
    // The two have to agree: asking for a number and parsing a string is how a read silently loses
    // every figure it was run for.
    assert.match(shapeForPrompt(), /"terminationNoticeDays": string/);
    assert.deepEqual(fromWire(z.object({ terminationNoticeDays: z.number().int().optional() }), { terminationNoticeDays: "30" }), {
      terminationNoticeDays: 30,
    });
  });
});

/**
 * Three documents were refused whole on 8 September — Capital Rx's base agreement, IQVIA's service
 * agreement, Navitus's Medicare D network — because the reader stated a DIR basis and gave no
 * quote. That lost the counterparty, the networks, the chain codes and every contact on each, for
 * one field. A rate without its words still refuses the read; a single side-figure without its
 * words is dropped and named instead.
 */
describe("an uncited side-figure is dropped, not fatal", () => {
  const base = { counterparty: "Example PBM", documentTitle: "Example Agreement", confidence: 0.9, contractType: "payer_network", documentRole: "base" };

  test("a DIR basis with no quote is removed and the drop is written into unclearOrMissing", () => {
    const t = dropUncited(termsFromObject({ ...base, dirFeeBasis: { value: "2% of ingredient cost" } }));
    assert.equal(t.dirFeeBasis.value, null);
    assert.ok(t.unclearOrMissing.some((s) => /DIR basis/.test(s) && /no quote/.test(s)));
    assert.equal(requireCitations(t).length, 0, "and the read is no longer refused for it");
  });

  test("a MAC appeal window with no quote is treated the same way", () => {
    const t = dropUncited(termsFromObject({ ...base, macAppealWindowDays: { value: 30 } }));
    assert.equal(t.macAppealWindowDays.value, null);
    assert.ok(t.unclearOrMissing.some((s) => /MAC appeal window/.test(s)));
  });

  test("a cited figure is left exactly as it was", () => {
    const t = dropUncited(termsFromObject({ ...base, dirFeeBasis: { value: "2% of ingredient cost", citation: { quote: "A DIR fee of 2% of ingredient cost applies." } } }));
    assert.equal(t.dirFeeBasis.value, "2% of ingredient cost");
    assert.equal(t.unclearOrMissing.length, 0);
  });

  test("a rate without its words still refuses the whole read", () => {
    const t = dropUncited(termsFromObject({ ...base, rates: [{ costSharingTier: "unknown", bins: [], pcns: [], groupIds: [], brandFormula: "AWP-15%" }] }));
    assert.equal(requireCitations(t).length, 1);
  });
});
