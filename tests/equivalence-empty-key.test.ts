import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { equivalenceKey, substitutable, namesAnIngredient } from "../src/lib/drug-directory";
import { groupProducts } from "../src/lib/product-groups";

/**
 * A key that names no ingredient must group nothing.
 *
 * The FDA product file leaves substances and strength empty on a great many kits — the ingredients
 * are listed on the components, not the package — so every one of them produced the key `||kit|`,
 * and equality made every one of them the same product. 2,094 NDCs across 678 unrelated drugs
 * shared that single key: apixaban, aprepitant, somatropin, temsirolimus, carmustine.
 *
 * It surfaced as buying advice on the owner's front page. He dispenses drospirenone/ethinyl
 * estradiol, NDC 68462072029, a Glenmark kit. The site told him to buy aprepitant 125/80mg instead,
 * NDC 68462011233, another Glenmark kit — and put $25,958.92 a month against doing it.
 *
 *   "the 'worth the most this morning' section is showing drugs I have never ordered for dispensed"
 *   "thats a massive issue"
 *
 * It was. Acting on one of those buys a drug the pharmacy does not stock to replace one it does.
 */
const kit = (substances: string, strength: string, form = "KIT", route = "") => ({ substances, strength, strengthUnit: "", form, route });

describe("an equivalence key that names no ingredient", () => {
  test("is empty rather than a key everything matches", () => {
    assert.equal(equivalenceKey(kit("", "")), "", "the two real kits both produced `||kit|` and matched");
  });

  test("the two drugs that actually collided do not share a key", () => {
    const aprepitant = equivalenceKey(kit("", "", "KIT"));
    const drospirenone = equivalenceKey(kit("", "", "KIT"));
    assert.equal(aprepitant, "");
    assert.equal(drospirenone, "");
    assert.equal(namesAnIngredient(aprepitant), false, "neither may be used to group");
  });

  test("a real key is unaffected", () => {
    const k = equivalenceKey({ substances: "OMEPRAZOLE", strength: "20", strengthUnit: "mg/1", form: "CAPSULE", route: "ORAL" });
    assert.match(k, /omeprazole/);
    assert.equal(namesAnIngredient(k), true);
  });

  /* Keys written before this was fixed are still stored, so the test is applied on the way in too. */
  test("a stored key from before the fix reads as no key", () => {
    assert.equal(namesAnIngredient("||kit|"), false);
    assert.equal(namesAnIngredient("||kit|oral"), false);
    assert.equal(namesAnIngredient("||kit|intravenous"), false);
    assert.equal(namesAnIngredient(null), false);
    assert.equal(namesAnIngredient("omeprazole|20 mg/1|capsule|oral"), true);
  });

  test("nothing is substitutable for anything on an empty key", () => {
    const a = { equivalenceKey: "", teCode: "AB" };
    const b = { equivalenceKey: "", teCode: "AB" };
    assert.equal(substitutable(a, b), false, "equality on emptiness is how 678 drugs became interchangeable");
  });

  test("and a real pair is still substitutable", () => {
    const k = "omeprazole|20 mg/1|capsule, delayed release|oral";
    assert.equal(substitutable({ equivalenceKey: k, teCode: "AB" }, { equivalenceKey: k, teCode: "AB" }), true);
  });
});

describe("grouping falls back to the printed description", () => {
  /*
   * With no usable FDA key the group key comes from what the invoice and catalogue actually call
   * the product, which tells these two apart where the FDA file could not.
   */
  const src = (ndc11: string, description: string) => ({
    ndc11,
    description,
    equivalenceKey: "||kit|",
    teCode: null,
    classification: "G",
    pricingUnit: "EA",
    otc: false,
  });

  test("aprepitant and drospirenone land in different groups", () => {
    const groups = groupProducts([
      src("68462011233", "APREPITANT KIT 125/80MG"),
      src("68462072029", "DROSPIRENONE/EE 3MG/0.02MG"),
    ]);
    const holding = (ndc: string) => [...groups.entries()].find(([, v]) => v.includes(ndc))?.[0] ?? null;
    const a = holding("68462011233");
    const d = holding("68462072029");
    if (a !== null && d !== null) assert.notEqual(a, d, "one group held 678 drugs; these two were in it");
  });

  test("two packages of one product still group together", () => {
    const groups = groupProducts([
      src("68462011233", "APREPITANT KIT 125/80MG"),
      src("68462011299", "APREPITANT KIT 125/80MG"),
    ]);
    const holding = (ndc: string) => [...groups.entries()].find(([, v]) => v.includes(ndc))?.[0] ?? null;
    assert.equal(holding("68462011233"), holding("68462011299"), "the same product by two packages is one buying choice");
  });
});
