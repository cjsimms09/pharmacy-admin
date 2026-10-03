import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { parseMonnitDate, toTenthsF, periodOf, f } from "../src/lib/imonnit";

/**
 * Pinned against two rows this pharmacy's own account actually returned. Every reading was being
 * discarded before this, and the reason was not guessable from the documentation.
 */
const REAL = [
  {
    DataMessageGUID: "b02b3ff1-29de-4fe8-a05e-546d228f547f",
    SensorID: 478332,
    MessageDate: "/Date(1788449766000)/",
    Data: "6.4",
    DisplayData: "43.5° F",
    PlotValue: "43.52",
    DataValues: "6.4",
    DataTypes: "TemperatureData",
    PlotValues: "43.52",
    PlotLabels: "Fahrenheit",
  },
  {
    MessageDate: "/Date(1788406566000)/",
    Data: "7",
    DisplayData: "44.6° F",
    PlotValue: "44.6",
    DataValues: "7",
    DataTypes: "TemperatureData",
    PlotValues: "44.6",
    PlotLabels: "Fahrenheit",
  },
];

describe("the date format iMonnit actually sends", () => {
  test("ASP.NET epoch milliseconds", () => {
    // Handed straight to Date() this is Invalid Date, which discarded every reading.
    assert.equal(parseMonnitDate("/Date(1788449766000)/"), new Date(1788449766000).toISOString());
  });

  test("with a trailing offset", () => {
    assert.equal(parseMonnitDate("/Date(1788449766000+0000)/"), new Date(1788449766000).toISOString());
  });

  test("ISO and spaced timestamps still work, for accounts shaped differently", () => {
    assert.equal(parseMonnitDate("2026-09-02T18:16:06Z"), "2026-09-02T18:16:06.000Z");
    assert.equal(parseMonnitDate("2026-09-02 18:16:06"), "2026-09-02T18:16:06.000Z");
  });

  test("junk is null rather than a wrong instant", () => {
    for (const v of ["", "   ", "not a date", null, undefined, "/Date()/"]) {
      assert.equal(parseMonnitDate(v), null, `${JSON.stringify(v)} should not parse`);
    }
  });

  test("both real rows parse, and the later one is later", () => {
    const a = parseMonnitDate(REAL[0].MessageDate)!;
    const b = parseMonnitDate(REAL[1].MessageDate)!;
    assert.ok(a && b && a > b);
  });
});

describe("reading the temperature, not the other one", () => {
  test("PlotValue with its PlotLabels unit", () => {
    assert.equal(toTenthsF(REAL[0].PlotValue, REAL[0].PlotLabels), 435);
    assert.equal(f(toTenthsF(REAL[0].PlotValue, REAL[0].PlotLabels)!), "43.5°F");
  });

  test("matches what iMonnit itself displays", () => {
    // DisplayData says "43.5° F" — our conversion has to agree with the vendor's own screen.
    assert.equal(f(toTenthsF(REAL[0].PlotValue, REAL[0].PlotLabels)!), REAL[0].DisplayData.replace("° F", "°F"));
    assert.equal(f(toTenthsF(REAL[1].PlotValue, REAL[1].PlotLabels)!), REAL[1].DisplayData.replace("° F", "°F"));
  });

  test("the raw Data field is Celsius and must never be read as Fahrenheit", () => {
    // Data is 6.4 where PlotValue is 43.52. Taking the wrong one would log a vaccine fridge at
    // 6.4°F — far out of range, and it would read as a catastrophic excursion that never happened.
    const wrong = toTenthsF(REAL[0].Data, undefined);
    assert.equal(wrong, 64, "6.4 with no unit hint reads as Fahrenheit, which is why the field matters");
    assert.notEqual(wrong, toTenthsF(REAL[0].PlotValue, REAL[0].PlotLabels));
  });

  test("a Celsius label converts", () => {
    assert.equal(toTenthsF("6.4", "Celsius"), 435);
    assert.equal(toTenthsF("0", "Celsius"), 320);
  });

  test("a freezer reading survives", () => {
    assert.equal(toTenthsF("-4.2", "Fahrenheit"), -42);
    assert.equal(f(-42), "-4.2°F");
  });
});

describe("readings land in the right month", () => {
  test("from the parsed instant", () => {
    const iso = parseMonnitDate(REAL[0].MessageDate)!;
    assert.match(periodOf(iso), /^\d{4}-\d{2}$/);
  });
});
