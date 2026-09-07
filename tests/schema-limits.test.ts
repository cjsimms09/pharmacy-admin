import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";
import * as ai from "../src/lib/ai";
import * as supplierTerms from "../src/lib/supplier-terms";
import * as contractTerms from "../src/lib/contract-terms";
import * as contractTriage from "../src/lib/contract-triage";

/**
 * The API refuses a schema carrying more than sixteen union-typed parameters.
 *
 * It cost a whole afternoon of refused contract reads to learn, and the refusal names a number
 * rather than a field, so nothing about the message says which schema or which line. `.nullable()`
 * is what produces them — it compiles to a type of ["string", "null"] — and it is the obvious thing
 * to reach for when a field may have no value, so the next one will be written the same way.
 *
 * This walks every schema the site can send and fails before it reaches the API.
 */
const UNION_LIMIT = 16;
/**
 * The second cap, and the one that was missed.
 *
 * Trading every `.nullable()` for `.optional()` took the contract schema from 104 unions to none —
 * and to 111 optional parameters, which is its own refusal with its own number. Both exist because
 * either shape makes the response grammar expensive to compile, so a schema large enough to hit one
 * will hit the other the moment it is rewritten to dodge the first.
 */
const OPTIONAL_LIMIT = 24;

function unionParameters(node: unknown, path = "", out: string[] = []): string[] {
  if (!node || typeof node !== "object") return out;
  const n = node as Record<string, unknown>;
  if (Array.isArray(n.type) || n.anyOf || n.oneOf) out.push(path || "(root)");
  for (const [k, v] of Object.entries(n)) if (v && typeof v === "object") unionParameters(v, `${path}/${k}`, out);
  return out;
}

/** Every property its object does not require. */
function optionalParameters(node: unknown, path = "", out: string[] = []): string[] {
  if (!node || typeof node !== "object") return out;
  const n = node as Record<string, unknown>;
  if (n.type === "object" && n.properties && typeof n.properties === "object") {
    const required = new Set((n.required as string[] | undefined) ?? []);
    for (const k of Object.keys(n.properties as Record<string, unknown>)) if (!required.has(k)) out.push(`${path}/${k}`);
  }
  for (const [k, v] of Object.entries(n)) if (v && typeof v === "object") optionalParameters(v, `${path}/${k}`, out);
  return out;
}

/**
 * Schemas that exist to describe the site's own shape and are never sent to the API.
 *
 * `ContractTerms` is the readable one, with optional fields, that the rest of the site is written
 * against; `ContractTermsWire` is derived from it with nothing optional and is what actually goes.
 * Exempting it by name rather than relaxing the check keeps the sweep meaning what it says: every
 * schema that can reach the API is within both caps.
 */
const NEVER_SENT = new Set(["ContractTerms"]);

/** Every Zod schema a module exports, by name. */
function schemasIn(mod: Record<string, unknown>, file: string): { name: string; file: string; schema: unknown }[] {
  return Object.entries(mod)
    .filter(([, v]) => Boolean(v) && typeof v === "object" && v !== null && "safeParse" in (v as object))
    .map(([name, schema]) => ({ name, file, schema }));
}

describe("what the site is allowed to ask the API for", () => {
  const all = [
    ...schemasIn(ai as unknown as Record<string, unknown>, "ai.ts"),
    ...schemasIn(supplierTerms as unknown as Record<string, unknown>, "supplier-terms.ts"),
    ...schemasIn(contractTerms as unknown as Record<string, unknown>, "contract-terms.ts"),
    ...schemasIn(contractTriage as unknown as Record<string, unknown>, "contract-triage.ts"),
  ];

  test("there are schemas to check, so a rename cannot make this test pass by finding none", () => {
    assert.ok(all.length >= 20, `expected the site's schemas; found ${all.length}`);
  });

  test("no schema carries more union-typed or optional parameters than the API accepts", () => {
    const over: string[] = [];
    for (const { name, file, schema } of all) {
      if (NEVER_SENT.has(name)) continue;
      let json: unknown;
      try {
        const format = zodOutputFormat(schema as never) as unknown as Record<string, unknown>;
        json = format.schema ?? (format.json_schema as Record<string, unknown>)?.schema ?? format;
      } catch {
        continue; // Not usable as an output format; it is never sent as one.
      }
      const u = unionParameters(json).length;
      const o = optionalParameters(json).length;
      if (u > UNION_LIMIT) over.push(`${file} · ${name}: ${u} unions (limit ${UNION_LIMIT})`);
      if (o > OPTIONAL_LIMIT) over.push(`${file} · ${name}: ${o} optionals (limit ${OPTIONAL_LIMIT})`);
    }
    assert.deepEqual(over, [], `over an API limit:\n  ${over.join("\n  ")}\nMake the field required and let a value carry "not stated".`);
  });

  test("the contract schema actually sent carries neither", () => {
    // It had 104 unions, then 111 optionals once the unions were traded away. It is the largest
    // schema here and the one that will grow again, so it is named rather than left to the sweep.
    const format = zodOutputFormat(contractTerms.ContractTermsWire as never) as unknown as Record<string, unknown>;
    const json = format.schema ?? (format.json_schema as Record<string, unknown>)?.schema ?? format;
    assert.deepEqual(unionParameters(json), []);
    assert.deepEqual(optionalParameters(json), []);
  });
});

describe("carrying an unstated term without an optional field", () => {
  test("a number the contract does not give travels as an empty string and comes back null", () => {
    const domain = z.object({ days: z.number().int().optional(), name: z.string().optional() });
    const wire = contractTerms.toWire(domain);
    assert.equal((wire as never as z.ZodObject<never>).safeParse({ days: "", name: "" }).success, true);
    assert.deepEqual(contractTerms.fromWire(domain, { days: "", name: "" }), { days: null, name: null });
    assert.deepEqual(contractTerms.fromWire(domain, { days: "30", name: "Caremark" }), { days: 30, name: "Caremark" });
  });

  test("a figure written with a dollar sign or a comma is still a figure", () => {
    const domain = z.object({ fee: z.number().optional() });
    assert.deepEqual(contractTerms.fromWire(domain, { fee: "$1,250" }), { fee: 1250 });
    assert.deepEqual(contractTerms.fromWire(domain, { fee: "about a dollar" }), { fee: null });
  });

  test("a yes/no that may be absent gets a third answer rather than being left out", () => {
    const domain = z.object({ autoRenews: z.boolean().optional() });
    assert.deepEqual(contractTerms.fromWire(domain, { autoRenews: "yes" }), { autoRenews: true });
    assert.deepEqual(contractTerms.fromWire(domain, { autoRenews: "no" }), { autoRenews: false });
    assert.deepEqual(contractTerms.fromWire(domain, { autoRenews: "not stated" }), { autoRenews: null });
  });

  test("it reaches through arrays and nested objects", () => {
    const domain = z.object({
      rates: z.array(z.object({ fee: z.number().optional(), basis: z.string().optional() })),
      citation: z.object({ quote: z.string(), page: z.number().int().optional() }).optional(),
    });
    assert.deepEqual(contractTerms.fromWire(domain, { rates: [{ fee: "1.5", basis: "" }], citation: { quote: "q", page: "" } }), {
      rates: [{ fee: 1.5, basis: null }],
      citation: { quote: "q", page: null },
    });
  });

  test("a required field is left exactly as it is", () => {
    const domain = z.object({ counterparty: z.string(), confidence: z.number() });
    assert.deepEqual(contractTerms.fromWire(domain, { counterparty: "Caremark", confidence: 0.8 }), {
      counterparty: "Caremark",
      confidence: 0.8,
    });
  });
});
