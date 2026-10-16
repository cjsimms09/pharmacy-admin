import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { scheduleFromNames } from "../src/lib/controlled-names";
import { parseExpected } from "../src/lib/invoices";

/**
 * Reading the schedule off the drug names, for the supplier who prints none.
 *
 * Two of the pharmacy's three wholesalers mark the schedule on the invoice and this is never
 * consulted for those. The third prints nothing — their only code column means taxed, net priced
 * or web special — so their invoices are twenty lines of drug names and prices and the names have
 * to answer.
 *
 * The Schedule II list is the one that must not miss, because 1304.04(h)(1) is the requirement a
 * miss would breach. These lines are taken from the pharmacy's own invoices, in the abbreviated
 * forms the wholesalers actually print.
 */
describe("what the names say", () => {
  test("a page of ordinary generics is not controlled", () => {
    const v = scheduleFromNames([
      "Amoxicillin/Clav Pot Tabs 500/125mg Auro 65862050220",
      "Benazepril Hcl Tabs 20mg Solc 43547033710",
      "Fluoxetine Tabs 60mg Sci 50228063830",
      "Estradiol Vaginal 10mcg Inserts Auro 59651043918",
      "Ondansetron ODT 8mg Auro 65862039110",
      "Timolol Maleate Oph Sol 0.25% San 61314022605",
    ]);
    assert.equal(v.schedule, "none");
    assert.deepEqual(v.matched, []);
  });

  test("a Schedule II drug is found even in the abbreviation a wholesaler prints", () => {
    for (const line of [
      "OXYCOD+APAP TB 10/325 CAMB500@",
      "MIX AMPHET SLTERCP30MGCAMB100@",
      "LISDEXAMF DIM CP 50MG ALV 100@",
      "METHYLPHEN ER TAB 27MG 100",
      "HYDROMORPH HCL TAB 2MG 100",
      "ADZENYS XR 9.4MG ODT",
    ]) {
      assert.equal(scheduleFromNames([line]).schedule, "schedule_2", line);
    }
  });

  test("one Schedule II line makes the whole invoice a Schedule II record", () => {
    const v = scheduleFromNames([
      "Amoxicillin/Clav Pot Tabs 500/125mg",
      "Alprazolam Tabs 1mg",
      "OXYCOD+APAP TB 10/325",
    ]);
    assert.equal(v.schedule, "schedule_2");
  });

  test("Schedule III to V is found, and does not claim to be Schedule II", () => {
    for (const line of ["ALPRAZOL TAB 1MG ACTA", "BUPRE+NAL HCI DISU 8/2MG", "PREGABALIN CP 75MG", "TESTOS CYP INJ 200MG/1ML"]) {
      assert.equal(scheduleFromNames([line]).schedule, "schedule_3_5", line);
    }
  });

  test("names that merely look alike are not matched", () => {
    // Estradiol is not estazolam; triamterene is not triazolam; fluoxetine is not fluoxymesterone.
    const v = scheduleFromNames([
      "Estradiol Vaginal 10mcg Inserts",
      "Triamterene/Hctz Caps 37.5/25mg",
      "Fluoxetine Tabs 60mg",
      "Norelgest/Est TDS 150/35mcg",
      "Tolterodine Tart Er Caps 2mg",
    ]);
    assert.equal(v.schedule, "none");
  });

  test("a name inside a longer word does not count", () => {
    // "codeine" sits inside "dihydrocodeine" — both controlled, but the boundary rule is what
    // stops a future entry matching the middle of an unrelated drug.
    assert.equal(scheduleFromNames(["DIHYDROCODEINE BITARTRATE"]).schedule, "schedule_2");
  });

  test("promethazine alone is not controlled; with codeine it is", () => {
    assert.equal(scheduleFromNames(["Promethazine Syrup 6.25mg/5ml"]).schedule, "none");
    assert.equal(scheduleFromNames(["Promethazine with Codeine Syrup"]).schedule, "schedule_3_5");
  });
});

/**
 * What a supplier is expected to send — used to raise an alarm, never to file anything.
 */
describe("supplier expectations", () => {
  test("reads the rules the pharmacy writes", () => {
    const r = parseExpected("Independent Pharmacy Cooperative = none\nMcKesson = 2\n# a comment\nIPD = 3-5");
    assert.equal(r.length, 3);
    assert.equal(r[0].expected, "none");
    assert.equal(r[1].expected, "schedule_2");
    assert.equal(r[2].expected, "schedule_3_5");
  });

  test("ignores blank lines and anything that is not a rule", () => {
    assert.deepEqual(parseExpected("\n\nnot a rule\nSupplier = wat\n"), []);
  });

  test("accepts the roman forms people actually type", () => {
    assert.equal(parseExpected("A = II")[0].expected, "schedule_2");
    assert.equal(parseExpected("B = III-V")[0].expected, "schedule_3_5");
  });
});
