import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { isPseudoephedrine, stateScheduleOf, higherSchedule } from "../src/lib/state-schedule";

/** "Yes we treat like schedule 5" — the owner, on pseudoephedrine, 22 September 2026. */
describe("pseudoephedrine is Schedule V in this pharmacy", () => {
  test("found by the directory's ingredients, whatever the brand", () => {
    assert.equal(isPseudoephedrine({ substances: "GUAIFENESIN; PSEUDOEPHEDRINE HYDROCHLORIDE" }), true);
  });

  test("found by the description for store brands the directory has never listed", () => {
    // Each of these is a real line on this pharmacy's invoices.
    for (const d of ["PSE HCI TB 120MG OHM 20@", "PSEUDOEPH TAB 30MG  PERR   24@", "F&T ALLER LORAT-D 24HR TAB 10", "MUCINEX D TAB MAX/STR       24"]) {
      assert.equal(isPseudoephedrine({ description: d }), true, d);
    }
  });

  test("narrowly: vitamin D and the ordinary antihistamines are not caught", () => {
    for (const d of ["VITAMIN D3 TAB 2000IU", "LORATADINE TAB 10MG", "MUCINEX TAB 600MG", "CETIRIZINE TAB 10MG", "DEXCOM G7 SENSOR"]) {
      assert.equal(isPseudoephedrine({ description: d }), false, d);
    }
  });

  test("it puts the line at Schedule III-V", () => {
    assert.equal(stateScheduleOf({ description: "PSE HCI TB 120MG OHM 20@" }), "schedule_3_5");
    assert.equal(stateScheduleOf({ description: "WARFARIN SOD TB 4MG" }), null);
  });
});

describe("the rule only ever raises", () => {
  test("the more controlled schedule wins", () => {
    assert.equal(higherSchedule("none", "schedule_3_5"), "schedule_3_5");
    assert.equal(higherSchedule("schedule_2", "schedule_3_5"), "schedule_2", "a Schedule II line is not lowered to V");
  });

  test("an unknown never outranks a known answer", () => {
    assert.equal(higherSchedule(null, "none"), "none");
    assert.equal(higherSchedule("unknown", "schedule_3_5"), "schedule_3_5");
    assert.equal(higherSchedule(null, null), null);
  });
});
