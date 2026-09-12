import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { dispensingPack, claimQuantityAgrees, packForClaim, costPerUnitMicros } from "../src/lib/pack-size";

/*
 * How many dispensing units are in one package, and what unit those are.
 *
 * Every string below is verbatim from this pharmacy's own `drug_directory`, and every claim quantity
 * is the one on a real September fill. That is deliberate: the four copies this replaced were all
 * plausible against a tidied example and all wrong against the real text.
 *
 * The old reading, in all four places, was `/^\s*([\d.]+)\s+[A-Z]/` — the first number in the
 * description. Each test below states what that gave as well as what is right, because the size of
 * the error is the reason the function exists.
 */

/** What every previous copy did: the outermost count, whatever it was counting. */
const oldReading = (desc: string): number | null => {
  const m = /^\s*([\d.]+)\s+[A-Z]/i.exec(desc);
  const n = m ? Number(m[1]) : NaN;
  return Number.isFinite(n) && n > 0 ? n : null;
};

describe("the pack size a cost per unit divides by", () => {
  test("Wegovy: four syringes of half a millilitre is 2 mL, and the claim says 2", () => {
    /*
     * NDC 00169450514, on five September fills. The claim quantity is 2 — millilitres — and the
     * description's first number is 4. Dividing a package price by 4 instead of 2 halves the cost
     * per unit, and comparing that against the claim's own per-unit cost manufactured a
     * "$34,363 of overstated cost" finding twice in one session.
     */
    const row = {
      packageDescription: "4 SYRINGE, PLASTIC in 1 CARTON (0169-4505-14)  / .5 mL in 1 SYRINGE, PLASTIC (0169-4505-01)",
      form: "INJECTION, SOLUTION",
    };
    const read = dispensingPack(row);
    assert.equal(read.ok, true);
    assert.ok(read.ok);
    assert.equal(read.pack.units, 2);
    assert.equal(read.pack.unit, "ML");
    assert.equal(read.pack.containers, 4, "four pens, and the trap that the old reading fell into");

    assert.equal(oldReading(row.packageDescription), 4);
    assert.equal(oldReading(row.packageDescription)! / read.pack.units, 2, "the old reading was exactly a factor of two");

    /* The claim's 2 is one whole package, which is what proves the millilitre reading. */
    const forClaim = packForClaim(row, 2000);
    assert.ok(forClaim.ok);
    assert.equal(forClaim.packages, 1);
    assert.equal(forClaim.exact, true);
  });

  test("estradiol vaginal cream: one tube of 42.5 g is 42.5 g, and the claim says 42.5", () => {
    /*
     * NDC 45802009735, on four September fills at a claim quantity of 42.5 grams. The first number
     * in the description is 1, so the old reading made a $11.90 tube cost $11.90 a gram — against
     * an invoice per-unit of $7.86 that is a 28x artefact, and the appeal plan's 2% agreement check
     * then threw the claim away. The drug with the worst reading was the drug that never got
     * appealed, which is why this fault hid for so long.
     */
    const row = { packageDescription: "1 TUBE in 1 CARTON (45802-097-35)  / 42.5 g in 1 TUBE", form: "CREAM" };
    const read = dispensingPack(row);
    assert.ok(read.ok);
    assert.equal(read.pack.units, 42.5);
    assert.equal(read.pack.unit, "GM");

    assert.equal(oldReading(row.packageDescription), 1);
    assert.equal(read.pack.units / oldReading(row.packageDescription)!, 42.5);

    const forClaim = packForClaim(row, 42_500);
    assert.ok(forClaim.ok);
    assert.equal(forClaim.packages, 1);
  });

  test("a hundred-tablet bottle is a hundred tablets, and a 90-count off it is part of one", () => {
    /* NDC 42806008701, estradiol 0.5 mg; the September claim is 90 tablets out of a bottle of 100. */
    const row = { packageDescription: "100 TABLET in 1 BOTTLE (42806-087-01)", form: "TABLET" };
    const read = dispensingPack(row);
    assert.ok(read.ok);
    assert.deepEqual({ units: read.pack.units, unit: read.pack.unit }, { units: 100, unit: "EA" });

    /* The safe case: the old reading was right here, which is why the fault was never obvious. */
    assert.equal(oldReading(row.packageDescription), 100);

    const forClaim = packForClaim(row, 90_000);
    assert.ok(forClaim.ok);
    assert.equal(forClaim.exact, false, "a partial bottle, and entirely ordinary");
  });

  test("a blister nest multiplies out to tablets", () => {
    const read = dispensingPack({
      packageDescription: "3 BLISTER PACK in 1 CARTON (0555-9043-58) / 28 TABLET in 1 BLISTER PACK",
      form: "TABLET",
    });
    assert.ok(read.ok);
    assert.deepEqual({ units: read.pack.units, unit: read.pack.unit }, { units: 84, unit: "EA" });
  });

  test("the September solid-dose claims: a 30-count is thirty tablets", () => {
    /* rx 337350 mirabegron ER 50 mg and rx 337115 doxepin 3 mg, the two certain overstatements. */
    for (const form of ["TABLET, EXTENDED RELEASE", "TABLET, FILM COATED"]) {
      const read = dispensingPack({ packageDescription: "30 TABLET in 1 BOTTLE (0093-1234-30)", form });
      assert.ok(read.ok, form);
      assert.equal(read.pack.units, 30);
      assert.equal(read.pack.unit, "EA");
    }
  });
});

describe("the form decides the unit, not the innermost level", () => {
  test("a lidocaine patch is thirty patches, not twenty-one grams", () => {
    /*
     * NDC 00603188016, claim quantity 30. The description states the drug's mass per pouch, and
     * reading that as the billing unit gives 30 x 0.7 = 21 GM — a reading that divides, looks
     * entirely plausible, and is wrong by 1.43x. The form is what tells them apart.
     */
    const row = { packageDescription: "30 POUCH in 1 CARTON (0603-1880-16)  / .7 g in 1 POUCH (0603-1880-10)", form: "PATCH" };
    const read = dispensingPack(row);
    assert.ok(read.ok);
    assert.equal(read.pack.units, 30);
    assert.equal(read.pack.unit, "EA");
    assert.match(read.pack.source, /what one holds, not a count/);

    const forClaim = packForClaim(row, 30_000);
    assert.ok(forClaim.ok);
    assert.equal(forClaim.packages, 1);
  });

  test("the same shape of text, a cream, is grams", () => {
    /* "1 TUBE / 42.5 g in 1 TUBE" and "30 POUCH / .7 g in 1 POUCH" differ only in the form. */
    const read = dispensingPack({ packageDescription: "1 TUBE in 1 CARTON (21922-025-07)  / 60 g in 1 TUBE", form: "CREAM" });
    assert.ok(read.ok);
    assert.deepEqual({ units: read.pack.units, unit: read.pack.unit }, { units: 60, unit: "GM" });
  });

  test("an estradiol patch's wear time is not a count", () => {
    /* NDC 00378462326, claim quantity 8. Reading the 3.5 d would give 28. */
    const read = dispensingPack({
      packageDescription: "8 POUCH in 1 CARTON (0378-4623-26)  / 1 PATCH in 1 POUCH (0378-4623-16)  / 3.5 d in 1 PATCH",
      form: "PATCH",
    });
    assert.ok(read.ok);
    assert.equal(read.pack.units, 8);
    assert.equal(read.pack.unit, "EA");
  });

  test("a Dotti patch states only a day per pouch, and is still eight patches", () => {
    /* NDC 65162099708. One September claim is 24 — three cartons of eight, not a unit mismatch. */
    const row = { packageDescription: "8 POUCH in 1 CARTON (65162-997-08)  / 1 d in 1 POUCH (65162-997-04)", form: "PATCH, EXTENDED RELEASE" };
    const read = dispensingPack(row);
    assert.ok(read.ok);
    assert.equal(read.pack.units, 8);
    const forClaim = packForClaim(row, 24_000);
    assert.ok(forClaim.ok);
    assert.equal(forClaim.packages, 3);
  });

  test("insulin in vials is millilitres, and forty is four vials", () => {
    const row = { packageDescription: "1 VIAL, GLASS in 1 CARTON (0169-7501-11)  / 10 mL in 1 VIAL, GLASS", form: "INJECTION, SOLUTION" };
    const read = dispensingPack(row);
    assert.ok(read.ok);
    assert.deepEqual({ units: read.pack.units, unit: read.pack.unit }, { units: 10, unit: "ML" });
    const forClaim = packForClaim(row, 40_000);
    assert.ok(forClaim.ok);
    assert.equal(forClaim.packages, 4);
  });

  test("a litre is a thousand millilitres and a milligram is a thousandth of a gram", () => {
    const l = dispensingPack({ packageDescription: "3.78 L in 1 BOTTLE, PLASTIC (71925-301-41)", form: "SOLUTION" });
    assert.ok(l.ok);
    assert.deepEqual({ units: l.pack.units, unit: l.pack.unit }, { units: 3780, unit: "ML" });
  });
});

describe("what it refuses, and why refusing is the point", () => {
  test("a metered inhaler: the claim is in grams the FDA never states", () => {
    /*
     * NDC 68180096301, albuterol HFA, on eleven September fills at a claim quantity of 8.5 — the
     * canister's net fill weight in grams. The description counts 200 actuations and states that
     * weight nowhere. The old reading answered 1 (the canister); reading the actuations answers
     * 200. The truth is 8.5 and it is not in the text, so there is no answer to give.
     */
    const read = dispensingPack({
      packageDescription: "1 CANISTER in 1 CARTON (68180-963-01)  / 200 AEROSOL, METERED in 1 CANISTER",
      form: "AEROSOL, METERED",
    });
    assert.equal(read.ok, false);
    assert.ok(!read.ok);
    /*
     * Refused on the form, which names this one before the description is even reached. The noun
     * check below it would catch the same product on its own, and does for a form that says only
     * "POWDER" — two independent reasons for one refusal, which is the right way round.
     */
    assert.match(read.why, /net fill/);
  });

  test("a dry-powder inhaler is refused too, and by the description rather than the form", () => {
    /* Trelegy: the claim says 60 and the description says 30. POWDER as a form is not the tell. */
    const read = dispensingPack({
      packageDescription: "1 TRAY in 1 CARTON (0173-0893-10)  / 1 INHALER in 1 TRAY / 30 POWDER in 1 INHALER",
      form: "POWDER",
    });
    assert.ok(!read.ok);
    assert.match(read.why, /doses the device delivers/);
  });

  test("nystatin powder in a bottle is grams, because the description states grams", () => {
    /* The other half of form POWDER, and the reason the refusal lives on the noun not the form. */
    const read = dispensingPack({ packageDescription: "60 g in 1 BOTTLE, PLASTIC (68382-370-03)", form: "POWDER" });
    assert.ok(read.ok);
    assert.deepEqual({ units: read.pack.units, unit: read.pack.unit }, { units: 60, unit: "GM" });
  });

  test("an oral contraceptive kit: the claim says 84 and the text's only number is 3", () => {
    /*
     * NDC 70700011985 and its family, on several September fills at 28 and 84. "1 KIT in 1 BLISTER
     * PACK" parses perfectly and means nothing — nowhere does the description say 28. The old
     * reading answered 3, which is a factor of 28: the standing brief's "silent factor of 25",
     * living in this pharmacy's real data.
     */
    const row = { packageDescription: "3 BLISTER PACK in 1 CARTON (70700-119-85)  / 1 KIT in 1 BLISTER PACK", form: "KIT" };
    const read = dispensingPack(row);
    assert.ok(!read.ok);
    assert.equal(oldReading(row.packageDescription), 3, "and the claim is 84");
  });

  test("a kit with components joined by a star has no single dispensing unit", () => {
    const read = dispensingPack({
      packageDescription: "1 KIT in 1 CARTON (70748-311-01)  *  1 mL in 1 VIAL (70748-309-01)  *  1 mL in 1 SYRINGE (70748-310-01)",
      form: "KIT",
    });
    assert.ok(!read.ok);
    assert.match(read.why, /kit/i);
  });

  test("a description that stops at a container counts boxes, and says so", () => {
    const read = dispensingPack({ packageDescription: "3 BLISTER PACK in 1 CARTON (0555-9043-58)", form: "TABLET" });
    assert.ok(!read.ok);
    assert.match(read.why, /count of containers/);
  });

  test("a bulk form whose description never states a volume is refused", () => {
    const read = dispensingPack({ packageDescription: "60 APPLICATOR in 1 JAR (45802-263-37)", form: "SOLUTION" });
    assert.ok(!read.ok);
    assert.match(read.why, /never states a volume or a mass/);
  });

  test("a solid dose described only by its drug mass has no count to give", () => {
    /*
     * NDC 72603021301, dexamethasone 0.75 mg, form TABLET, described as "100 mg in 1 BOTTLE" — the
     * bottle's total drug mass where every other row states a tablet count. Skipping the milligrams
     * is right, and it leaves nothing counted; answering "1 EA" made a bottle of tablets look like
     * one tablet, and the claim of 10 divided by it perfectly. A hundred-fold error that confirmed
     * itself, which is exactly what this file exists to refuse.
     */
    const row = { packageDescription: "100 mg in 1 BOTTLE (72603-213-01)", form: "TABLET" };
    const read = dispensingPack(row);
    assert.ok(!read.ok);
    assert.match(read.why, /what the package holds rather than how many units/);
    assert.equal(packForClaim(row, 10_000).ok, false);
  });

  test("a form this cannot place is refused rather than assumed countable", () => {
    const read = dispensingPack({ packageDescription: "100 WIDGET in 1 BOTTLE (1-1-1)", form: "SOMETHING NEW" });
    assert.ok(!read.ok);
    assert.match(read.why, /not one this can say a billing unit for/);
  });

  test("no description and no form give nothing rather than a guess", () => {
    assert.equal(dispensingPack({ packageDescription: null, form: "TABLET" }).ok, false);
    assert.equal(dispensingPack({ packageDescription: "", form: "TABLET" }).ok, false);
    assert.equal(dispensingPack({ packageDescription: "100 TABLET in 1 BOTTLE (1-1-1)", form: null }).ok, false);
    assert.equal(dispensingPack({ packageDescription: "something the FDA never wrote", form: "TABLET" }).ok, false);
  });
});

describe("whether the claim's quantity is in the pack's unit", () => {
  /*
   * `claims.quantity_unit` is null on all 3,370 rows this pharmacy has imported, so the unit can
   * never be read off the claim. The arithmetic is the only check there is.
   */
  test("the unit-dose trap: sixty single-use vials of 0.4 mL against a claim of 60", () => {
    /*
     * Restasis, NDC 00023916360. The package is 24 mL and is also 60 things, and the claim quantity
     * of 60 means the second. A per-millilitre cost taken from the volume reading would be 2.5
     * times wrong — and it would divide cleanly and look fine, which is the whole danger.
     */
    const row = { packageDescription: "60 VIAL, SINGLE-USE in 1 TRAY (0023-9163-60)  / .4 mL in 1 VIAL, SINGLE-USE", form: "EMULSION" };
    const read = dispensingPack(row);
    assert.ok(read.ok);
    assert.equal(read.pack.units, 24);
    assert.equal(read.pack.containers, 60);

    const agreement = claimQuantityAgrees(read.pack, 60_000);
    assert.equal(agreement.agrees, false);
    assert.ok(!agreement.agrees);
    assert.equal(agreement.kind, "container");
    assert.match(agreement.why, /counting containers/);
    assert.equal(packForClaim(row, 60_000).ok, false, "and the one-call form refuses it too");
  });

  test("a partial across several packages is not proved, and must not reach a payer", () => {
    /* 56 buprenorphine films out of 30-film cartons: probably right, not provable. */
    const row = { packageDescription: "30 POUCH in 1 CARTON (47781-355-03)  / 1 FILM in 1 POUCH (47781-355-11)", form: "FILM" };
    const strict = packForClaim(row, 56_000);
    assert.equal(strict.ok, false);
    assert.ok(!strict.ok);
    assert.match(strict.why, /neither a whole number of packages nor part of one/);

    /* A caller totalling the month's margin may take it, and is made to ask for it. */
    const loose = packForClaim(row, 56_000, true);
    assert.ok(loose.ok);
    assert.equal(loose.exact, false);
  });

  test("a reversal is the same fill with the sign turned round", () => {
    const pack = { units: 42.5, unit: "GM" as const, source: "test", containers: null };
    const agreement = claimQuantityAgrees(pack, -42_500);
    assert.ok(agreement.agrees);
    assert.equal(agreement.packages, 1);
  });

  test("no quantity is refused rather than read as nought packages", () => {
    const pack = { units: 30, unit: "EA" as const, source: "test", containers: null };
    assert.equal(claimQuantityAgrees(pack, 0).agrees, false);
    assert.equal(claimQuantityAgrees(pack, null).agrees, false);
  });
});

describe("the division itself", () => {
  test("a per-package price over the pack is the per-unit cost, in micros", () => {
    /*
     * The methylphenidate case, as arithmetic. $73.79 a bottle of 30 is $2.46 a tablet; divided by
     * 1 — which is what a description stopping at a container used to give — it is $73.79.
     */
    const pack = { units: 30, unit: "EA" as const, source: "test", containers: null };
    assert.equal(costPerUnitMicros(7_379, pack), 2_459_667);
    assert.equal(costPerUnitMicros(7_379, { ...pack, units: 1 }), 73_790_000);
  });
});
