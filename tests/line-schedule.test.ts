import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { filingDisagrees, lineSchedule } from "../src/lib/line-schedule";

/*
 * What schedule a line's drug is, and who says so. The sources answer different questions and only one of them answers
 * per line, which is the distinction this exists to keep.
 */
describe("which source can answer for a line", () => {
  test("the invoice's own Schedule II half is the strongest answer there is", () => {
    assert.deepEqual(lineSchedule({ sectionControlled: true, directoryCode: "" }), {
      schedule: "schedule_2",
      controlled: true,
      from: "the invoice's own sections",
    });
  });

  test("the FDA directory answers per line, for the lines it lists", () => {
    assert.deepEqual(lineSchedule({ directoryCode: "2" }), { schedule: "schedule_2", controlled: true, from: "the FDA directory" });
    assert.deepEqual(lineSchedule({ directoryCode: "4" }), { schedule: "schedule_3_5", controlled: false, from: "the FDA directory" });
    assert.deepEqual(lineSchedule({ directoryCode: "0" }), { schedule: "none", controlled: false, from: "the FDA directory" });
  });

  test("a device or a front-end item the directory does not list leaves the line unanswered", () => {
    assert.deepEqual(lineSchedule({ directoryCode: null }), { schedule: null, controlled: null, from: null });
    assert.deepEqual(lineSchedule({ directoryCode: "" }), { schedule: null, controlled: null, from: null });
  });
});

describe("PioneerRx's receiving record, which is about the delivery and not the line", () => {
  test("a delivery carrying nothing controlled settles every line on it", () => {
    assert.deepEqual(lineSchedule({ deliveryCodes: ["0"] }), { schedule: "none", controlled: false, from: "PioneerRx's receiving record" });
  });

  test("a delivery carrying a Schedule IV proves this line is not Schedule II, and nothing more", () => {
    /* Which of its lines is the Schedule IV is not in the delivery's own record, so the line's schedule stays unknown. */
    assert.deepEqual(lineSchedule({ deliveryCodes: ["0", "4"] }), { schedule: null, controlled: false, from: "PioneerRx's receiving record" });
  });

  test("a delivery that did carry a Schedule II says nothing about WHICH line, so the line stays unanswered", () => {
    assert.deepEqual(lineSchedule({ deliveryCodes: ["0", "2"] }), { schedule: null, controlled: null, from: null });
  });

  test("but where the invoice puts the line in its other half, that settles it", () => {
    assert.deepEqual(lineSchedule({ sectionControlled: false, deliveryCodes: ["0", "2"] }), {
      schedule: null,
      controlled: false,
      from: "the invoice's own sections",
    });
  });

  test("the line's own drug beats the delivery it came on", () => {
    assert.equal(lineSchedule({ directoryCode: "2", deliveryCodes: ["0"] }).schedule, "schedule_2");
  });
});

describe("a line that contradicts the drawer its invoice is in", () => {
  test("a Schedule II line on an invoice filed as ordinary is the finding that matters", () => {
    assert.match(String(filingDisagrees({ lineSchedule: "schedule_2", invoiceSchedule: "none" })), /Schedule II line on an invoice filed as none/);
    assert.match(String(filingDisagrees({ lineSchedule: "schedule_2", invoiceSchedule: "schedule_3_5" })), /filed as schedule 3_5/);
  });

  test("a Schedule III-V line on an invoice filed as carrying none is a finding too", () => {
    assert.match(String(filingDisagrees({ lineSchedule: "schedule_3_5", invoiceSchedule: "none" })), /Schedule III-V line/);
  });

  test("a line that says nothing contradicts nothing, which is the whole lesson of the null flag", () => {
    assert.equal(filingDisagrees({ lineSchedule: null, invoiceSchedule: "none" }), null);
    assert.equal(filingDisagrees({ lineSchedule: null, invoiceSchedule: "schedule_2" }), null);
  });

  test("an ordinary line inside a Schedule II invoice is not a disagreement: mixed documents are normal", () => {
    assert.equal(filingDisagrees({ lineSchedule: "none", invoiceSchedule: "schedule_2" }), null);
    assert.equal(filingDisagrees({ lineSchedule: "schedule_3_5", invoiceSchedule: "schedule_2" }), null);
  });
});
