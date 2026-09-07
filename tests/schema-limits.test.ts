import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
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
const LIMIT = 16;

function unionParameters(node: unknown, path = "", out: string[] = []): string[] {
  if (!node || typeof node !== "object") return out;
  const n = node as Record<string, unknown>;
  if (Array.isArray(n.type) || n.anyOf || n.oneOf) out.push(path || "(root)");
  for (const [k, v] of Object.entries(n)) if (v && typeof v === "object") unionParameters(v, `${path}/${k}`, out);
  return out;
}

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

  test("no schema carries more union-typed parameters than the API accepts", () => {
    const over: string[] = [];
    for (const { name, file, schema } of all) {
      let json: unknown;
      try {
        const format = zodOutputFormat(schema as never) as unknown as Record<string, unknown>;
        json = format.schema ?? (format.json_schema as Record<string, unknown>)?.schema ?? format;
      } catch {
        continue; // Not usable as an output format; it is never sent as one.
      }
      const n = unionParameters(json).length;
      if (n > LIMIT) over.push(`${file} · ${name}: ${n} unions`);
    }
    assert.deepEqual(over, [], `over the limit of ${LIMIT}:\n  ${over.join("\n  ")}\nUse .optional() rather than .nullable().`);
  });

  test("the contract schema in particular sends none at all", () => {
    // It had 104 and every read was refused. It is the largest schema here and the one that will
    // grow again, so it is named rather than left to the sweep above.
    const format = zodOutputFormat(contractTerms.ContractTerms as never) as unknown as Record<string, unknown>;
    const json = format.schema ?? (format.json_schema as Record<string, unknown>)?.schema ?? format;
    assert.deepEqual(unionParameters(json), []);
  });
});
