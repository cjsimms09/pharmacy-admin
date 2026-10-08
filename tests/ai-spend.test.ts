import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

/*
 * What blank and zero mean in the monthly ceiling box on Settings, and what saving it tells him.
 *
 * The box said blank meant no ceiling. Blank means "nobody has set one", which falls back to the built-in fifty, so clearing the box to
 * remove the limit put the limit straight back. The page was then corrected, and the message it gives after a save still said the
 * opposite: a blank box was reported as "There is no monthly ceiling any more" while every reader was held to fifty dollars. These run the
 * code that decides the ceiling and the code that words it, not a copy of either. Every figure is invented.
 */
let ai: typeof import("../src/lib/ai-spend");
let setSetting: typeof import("../src/lib/settings").setSetting;
let cleanUpDb: (() => void) | null = null;

before(async () => {
  const { useScratchDb } = await import("./support/scratch-db");
  cleanUpDb = await useScratchDb();
  ai = await import("../src/lib/ai-spend");
  ({ setSetting } = await import("../src/lib/settings"));
});

after(() => cleanUpDb?.());

describe("the ceiling the box holds", () => {
  test("blank is the built-in ceiling, not the absence of one", () => {
    for (const blank of ["", "   ", null, undefined]) {
      assert.deepEqual(ai.ceilingFrom(blank), { cap: ai.DEFAULT_MONTHLY_CAP, isDefault: true });
    }
    assert.equal(ai.DEFAULT_MONTHLY_CAP, 50);
  });

  test("zero is how somebody says no ceiling, deliberately", () => {
    assert.deepEqual(ai.ceilingFrom("0"), { cap: null, isDefault: false });
  });

  test("a number is that number, and is no longer the default", () => {
    assert.deepEqual(ai.ceilingFrom("250"), { cap: 250, isDefault: false });
    assert.deepEqual(ai.ceilingFrom(" 12.5 "), { cap: 12.5, isDefault: false });
  });

  test("nonsense is treated as no ceiling rather than as zero spending allowed, and is said to be", () => {
    assert.equal(ai.ceilingFrom("abc").cap, null);
    assert.equal(ai.ceilingFrom("-5").cap, null);
    assert.match(ai.ceilingSaid("abc").says, /"abc" is not an amount above zero, so there is no monthly ceiling/);
    assert.match(ai.ceilingSaid("-5").says, /"-5" is not an amount above zero/);
  });
});

describe("what saving the box tells him", () => {
  test("a blank box says it is the built-in fifty dollars and never says there is none", () => {
    const { says, logged } = ai.ceilingSaid("");
    assert.equal(says, "The monthly ceiling is the built-in $50.00, because the box is empty.");
    assert.doesNotMatch(says, /no monthly ceiling|any more/);
    assert.equal(logged, "ceiling=$50.00 (built in)");
  });

  test("a zero says there is none, and the audit line says the same", () => {
    const { says, logged } = ai.ceilingSaid("0");
    assert.match(says, /^There is no monthly ceiling/);
    assert.doesNotMatch(says, /built-in/);
    assert.equal(logged, "no ceiling (0 entered)");
  });

  test("a number says that number in dollars and cents, as the refusal does", () => {
    assert.equal(ai.ceilingSaid("250").says, "The monthly ceiling is now $250.00.");
    assert.equal(ai.ceilingSaid("12.5").says, "The monthly ceiling is now $12.50.");
    assert.equal(ai.ceilingSaid("250").logged, "ceiling=$250.00");
  });

  test("what was typed is not trusted into the sentence as a number", () => {
    assert.doesNotMatch(ai.ceilingSaid("50x").says, /now \$/);
    assert.doesNotMatch(ai.ceilingSaid("50x").logged, /^ceiling=/);
  });
});

describe("the ceiling every reader is held to is the one the box says", () => {
  const held = async (typed: string) => {
    await setSetting("ai_monthly_cap", typed);
    return ai.monthlyCap();
  };

  test("an empty box holds every reader to the built-in fifty", async () => {
    const m = await held("");
    assert.equal(m.cap, 50);
    assert.equal(m.isDefault, true);
  });

  test("a zero holds nobody, and a number holds to that number", async () => {
    const none = await held("0");
    assert.equal(none.cap, null);
    assert.equal(none.over, false);
    assert.equal(none.left, Infinity);
    const some = await held("250");
    assert.equal(some.cap, 250);
    assert.equal(some.isDefault, false);
  });

  test("nonsense holds nobody, as the sentence for it says", async () => {
    assert.equal((await held("abc")).cap, null);
    await setSetting("ai_monthly_cap", "");
  });
});

describe("the page says it", () => {
  const page = readFileSync("src/app/(app)/settings/page.tsx", "utf8");

  test("saving reports the ceiling through the one function that words it, and logs it the same way", () => {
    assert.match(page, /const cap = String\(fd\.get\("ai_monthly_cap"\) \?\? ""\)\.trim\(\);\s+await setSetting\("ai_monthly_cap", cap\);\s+const ceiling = ceilingSaid\(cap\);/, "the sentence is worded from the very value that was stored, which is read from the ceiling box and from no other field");
    assert.match(page, /"\/settings\?saved=" \+ encodeURIComponent\(ceiling\.says\)/);
    assert.match(page, /details: `model=\$\{model\}, \$\{ceiling\.logged\}`/);
  });

  test("the hint and the placeholder name the built-in ceiling from the constant, not a figure typed beside it", () => {
    assert.match(page, /DEFAULT_MONTHLY_CAP, DEFAULT_RATE_IN, DEFAULT_RATE_OUT \} from "@\/lib\/ai-spend";/);
    assert.match(page, /hint=\{`Dollars\. Leave blank for the built-in \$\{dollars\(DEFAULT_MONTHLY_CAP\)\} ceiling, or enter 0 for no ceiling at all\. Once the last 31 days reach it, the buttons that use Claude are refused until they fall below it\. A reading already under way can finish, so spending can pass it a little\.`\}/);
    assert.match(page, /placeholder=\{`\$\{DEFAULT_MONTHLY_CAP\} — the built-in ceiling`\}/);
    assert.doesNotMatch(page, /hint="Dollars\. Leave blank for the built-in \$50/, "a typed $50 would go on saying so after the built-in ceiling changed");
    assert.doesNotMatch(page, /placeholder="50 — the built-in ceiling"/);
  });

  test("no sentence on the page decides what a blank box means for itself", () => {
    assert.doesNotMatch(page, /cap \? `The monthly ceiling is now/);
    assert.doesNotMatch(page, /any more/);
    assert.doesNotMatch(page, /" with no ceiling"/);
    assert.doesNotMatch(page, /, no ceiling"/);
  });
});

describe("the card that offers the invoice press says what the ceiling does", () => {
  const card = readFileSync("src/app/(app)/inventory/invoices/page.tsx", "utf8");

  test("it says a zero means no ceiling, and a zero does mean that", () => {
    assert.match(card, /and 0 there means no ceiling at all/);
    assert.equal(ai.ceilingFrom("0").cap, null);
  });

  test("it names the built-in ceiling from the constant, and the constant is what a blank box holds every reader to", () => {
    assert.match(card, /the built-in \{dollarAmount\(DEFAULT_MONTHLY_CAP\)\} unless one was set there/);
    assert.equal(ai.ceilingFrom("").cap, ai.DEFAULT_MONTHLY_CAP);
  });
});
