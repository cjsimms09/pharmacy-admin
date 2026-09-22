import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { scheduleLookup } from "../src/lib/drug-directory-store";
import { directoryCodeOf, lineSchedule } from "../src/lib/line-schedule";

/**
 * The directory's two silences, carried all the way to the answer a line gets.
 *
 * Tested as the chain and not as its parts, because the parts were each correct and the chain
 * never worked: `directoryCodeOf` turned a blank into "not controlled", and nothing ever handed it
 * a blank, because the directory stores an uncontrolled drug as NULL and the lookup turned that
 * NULL into the same `null` it gives for a drug it has never seen. 134 invoice lines the FDA lists
 * as uncontrolled sat unanswered for as long as the backfill existed.
 */
const DIRECTORY = [
  { ndc11: "00000000001", deaSchedule: null }, // listed, uncontrolled — how the FDA file actually stores it
  { ndc11: "00000000002", deaSchedule: "CII" },
  { ndc11: "00000000003", deaSchedule: "CIV" },
];

const answer = (ndc11: string) =>
  lineSchedule({ directoryCode: directoryCodeOf(scheduleLookup(DIRECTORY)(ndc11)) });

describe("what the FDA directory says about an invoice line", () => {
  test("a drug the directory lists with no schedule is answered as not controlled", () => {
    const a = answer("00000000001");
    assert.equal(a.schedule, "none");
    assert.equal(a.from, "the FDA directory");
  });

  test("a drug the directory has never heard of stays unanswered", () => {
    // The other silence. Calling this uncontrolled would file an unknown Schedule II as ordinary,
    // which is the one mistake the whole schedule column exists to prevent.
    const a = answer("99999999999");
    assert.equal(a.schedule, null);
    assert.equal(a.from, null);
  });

  test("a scheduled drug is answered with its schedule", () => {
    assert.equal(answer("00000000002").schedule, "schedule_2");
    assert.equal(answer("00000000003").schedule, "schedule_3_5");
  });

  test("the lookup keeps listed and unlisted apart", () => {
    const look = scheduleLookup(DIRECTORY);
    assert.equal(look("00000000001"), "", "listed with no schedule is a blank, not a null");
    assert.equal(look("99999999999"), null, "never seen is null");
  });
});
