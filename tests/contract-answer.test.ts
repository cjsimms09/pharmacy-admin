import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { ContractTerms, termsFromAnswer } from "../src/lib/contract-terms";

/** The emptiest answer the schema accepts: null wherever null is allowed, nothing anywhere else. */
function emptiest(schema: unknown, defs: Record<string, unknown>): unknown {
  const s = schema as Record<string, unknown>;
  if (typeof s.$ref === "string") return emptiest(defs[s.$ref.replace("#/$defs/", "")], defs);
  if (Array.isArray(s.anyOf)) {
    const nul = (s.anyOf as Record<string, unknown>[]).find((o) => o.type === "null");
    return nul ? null : emptiest(s.anyOf[0], defs);
  }
  if (s.const !== undefined) return s.const;
  if (Array.isArray(s.enum)) return s.enum[0];
  // The SDK folds an enum into the description ("{enum: [...]}") to keep the grammar small.
  const folded = typeof s.description === "string" ? /^\{enum: (\[.*\])\}$/.exec(s.description) : null;
  if (folded) return (JSON.parse(folded[1]) as unknown[])[0];
  const t = Array.isArray(s.type) ? s.type[0] : s.type;
  if (t === "object") return Object.fromEntries(Object.entries((s.properties ?? {}) as Record<string, unknown>).map(([k, v]) => [k, emptiest(v, defs)]));
  if (t === "array") return [];
  if (t === "string") return "x";
  if (t === "number" || t === "integer") return 0;
  if (t === "boolean") return false;
  return null;
}

/** The reader's answer, held to the schema on this side now that the API's grammar cannot be. */
describe("the answer as terms", () => {
  const fmt = zodOutputFormat(ContractTerms).schema as Record<string, unknown>;
  const sample = { ...(emptiest(fmt, (fmt.$defs ?? {}) as Record<string, unknown>) as Record<string, unknown>), counterparty: "Example PBM" };
  test("a bare object, a fenced one, and one with a sentence in front all parse", () => {
    const json = JSON.stringify(sample);
    for (const text of [json, "```json\n" + json + "\n```", "Here are the terms:\n" + json + "\nDone."]) {
      const t = termsFromAnswer(text);
      assert.equal(t.counterparty, "Example PBM");
      assert.deepEqual(t.rates, []);
    }
  });
  test("a field the schema gained later is filled in as not stated", () => {
    const older: Record<string, unknown> = { ...sample };
    delete older.sections;
    assert.deepEqual(termsFromAnswer(JSON.stringify(older)).sections, []);
  });
  test("no object at all is a thrown reason, not a draft", () => {
    assert.throws(() => termsFromAnswer("I could not read this document."), /no JSON object/);
  });
});
