import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { CHANGE_IT_LABEL, NOT_A_PROBLEM_LABEL, saidAboutWriteAll, tallyWriteAll, TELL_IT_LABEL, type WriteOutcome } from "../src/lib/write-all-said";

/*
 * The "Write every fix that needs no answer" press, counted and worded from what became of each finding. Nothing here asks Claude for
 * anything: the press itself is never run, so the outcomes are made by hand and the figures are invented.
 */
const wrote = (section = "Recall policy"): WriteOutcome => ({ kind: "wrote", section });
const needs = (section: string, need = ""): WriteOutcome => ({ kind: "needs-fact", section, need });
const failed = (section: string, why = "No API key is set, so nothing can be written. Settings → Claude.", ours = true): WriteOutcome => ({ kind: "failed", section, why, ours });
const read = (file: string) => fs.readFileSync(file, "utf8").replace(/\r\n/g, "\n");
const tally = (outcomes: WriteOutcome[], waiting: number, limit = 6) => tallyWriteAll(outcomes, waiting, limit);

describe("what the press counts from what became of each finding", () => {
  test("every finding asked about is counted, the ones that threw included, and only the ones not asked about are left", () => {
    const r = tally([wrote(), wrote(), needs("A"), failed("B"), failed("C")], 10);
    assert.equal(r.tried, 5);
    assert.equal(r.wrote, 2);
    assert.deepEqual(r.needFacts, [{ section: "A", need: "" }]);
    assert.equal(r.failed.length, 2);
    assert.equal(r.notTried, 5, "ten waited and five were asked about, so five were never reached");
    assert.equal(r.limit, 6);
    assert.equal(tally([], 0, 3).limit, 3, "the report carries the limit the press ran with");
  });

  test("a failure is never counted as a write, and never as progress toward what is left", () => {
    const r = tally([failed("A"), failed("B"), failed("C")], 3);
    assert.equal(r.wrote, 0);
    assert.equal(r.tried, 3);
    assert.equal(r.notTried, 0);
  });

  test("what is left never goes below nothing, even if the list shrank while the press ran", () => {
    assert.equal(tally([wrote(), wrote()], 1).notTried, 0);
  });
});

describe("what it tells him", () => {
  test("nothing was waiting", () => {
    assert.deepEqual(saidAboutWriteAll(tally([], 0)), { says: "No finding was waiting for text.", trouble: false });
  });

  test("everything written and nothing left says only that", () => {
    const r = saidAboutWriteAll(tally([wrote(), wrote(), wrote()], 3));
    assert.equal(r.says, "3 written and waiting for you to read.");
    assert.equal(r.trouble, false);
    assert.equal(saidAboutWriteAll(tally([wrote()], 1)).says, "1 written and waiting for you to read.");
  });

  test("when everything asked about was written, pressing again does carry on, and that is the only time it says so", () => {
    const r = saidAboutWriteAll(tally([wrote(), wrote()], 7));
    assert.equal(r.says, "2 written and waiting for you to read. 5 not tried yet; press again to carry on.");
    assert.equal(r.trouble, false);
    for (const outcome of [needs("A", "Who signs."), failed("A")]) {
      const worse = saidAboutWriteAll(tally([wrote(), outcome], 7));
      assert.doesNotMatch(worse.says, /press again to carry on/, "the one with no text is first in line again, so pressing again does not reach the rest");
      assert.match(
        worse.says,
        /5 not tried yet\. The 1 above still has no text, so it is first in line again: pressing again asks about it again before any of the rest, and a press asks about 6 at most and stops when its time runs out, so the rest are reached only as far as that leaves room\.$/,
      );
      assert.doesNotMatch(worse.says, /answered or set aside/, "answering a finding does not take it out of the line unless the text is then written");
    }
  });

  test("the rest are said to be out of reach only when the ones left without text fill a whole press", () => {
    const six = Array.from({ length: 6 }, (_, i) => needs(`Section ${i + 1}`));
    const full = saidAboutWriteAll(tally(six, 9)).says;
    assert.match(
      full,
      /3 not tried yet\. The 6 above still have no text, so they are first in line again: pressing again asks about them again before any of the rest, and a press asks about 6 at most, so none of the rest is reached until some of them are written or marked "Not a problem"\.$/,
    );
    const fewer = saidAboutWriteAll(tally([wrote(), wrote(), wrote(), ...six.slice(0, 3)], 9)).says;
    assert.doesNotMatch(fewer, /none of the rest is reached/, "three of six slots are left over, so some of the rest can be reached");
    assert.match(fewer, /3 not tried yet\. The 3 above still have no text, so they are first in line again: pressing again asks about them again before any of the rest/);
    assert.ok(full.includes(`"${NOT_A_PROBLEM_LABEL}"`), "the button is quoted by the words on the page");
  });

  test("whether the rest can be reached follows the limit the press ran with, not a number written into the sentence", () => {
    const three = Array.from({ length: 3 }, (_, i) => needs(`Section ${i + 1}`));
    assert.match(saidAboutWriteAll(tally(three, 5, 3)).says, /a press asks about 3 at most, so none of the rest is reached until some of them are written/);
    assert.doesNotMatch(saidAboutWriteAll(tally(three, 5, 6)).says, /none of the rest is reached/);
    const five = Array.from({ length: 5 }, (_, i) => needs(`Section ${i + 1}`));
    assert.doesNotMatch(saidAboutWriteAll(tally(five, 8, 6)).says, /none of the rest is reached/, "one place in the press is still free, so the rest can be reached");
    assert.match(saidAboutWriteAll(tally(three.slice(0, 2), 5, 3)).says, /a press asks about 3 at most and stops when its time runs out/);
    assert.match(
      saidAboutWriteAll(tally([needs("Section 1")], 3, 1)).says,
      /The 1 above still has no text, so it is first in line again: pressing again asks about it again before any of the rest, and a press asks about 1 at most, so none of the rest is reached until that is written or marked "Not a problem"\.$/,
    );
  });

  test("a finding that needs a fact is named, with what it is waiting on and where to give it", () => {
    const r = saidAboutWriteAll(tally([wrote(), needs("Controlled substance delivery", "Who the driver may release a controlled substance to."), needs("Narcotic returns")], 3));
    assert.match(r.says, /^1 written and waiting for you to read\. /);
    assert.match(r.says, /2 need a fact about this pharmacy that it does not have: Controlled substance delivery; Narcotic returns\./);
    assert.doesNotMatch(r.says, /nobody has told it/, "a finding he has already answered can be back here, so nobody having told it is not the reason");
    assert.match(r.says, /Controlled substance delivery is waiting on: Who the driver may release a controlled substance to\./);
    assert.ok(
      r.says.includes(
        `Open each and give the fact in the box under "${TELL_IT_LABEL}", or under "${CHANGE_IT_LABEL}" where you have already answered, and it writes the wording from your answer.`,
      ),
    );
    assert.equal(r.trouble, false, "something was written and nothing broke");
    assert.doesNotMatch(r.says, /each says which, on the finding/, "the batch keeps no note on the finding, so it must not say there is one");
  });

  test("one finding that needs a fact reads in the singular, and with nothing said about what it wants it names only the section", () => {
    const r = saidAboutWriteAll(tally([wrote(), needs("Narcotic returns")], 2));
    assert.match(r.says, /1 needs a fact about this pharmacy that it does not have: Narcotic returns\. Open it and give the fact in the box under/);
    assert.doesNotMatch(r.says, /is waiting on/);
  });

  test("with nothing written the press is red even though nothing broke, because what he asked for did not happen", () => {
    const r = saidAboutWriteAll(tally([needs("A"), needs("B")], 2));
    assert.match(r.says, /^None written\. 2 need a fact/);
    assert.equal(r.trouble, true);
  });

  test("a finding that threw is counted, named with its reason, and makes the press red", () => {
    const r = saidAboutWriteAll(tally([failed("Recall policy"), failed("Returns"), failed("Deliveries")], 3));
    assert.equal(r.says, "None written. 3 could not be written: Recall policy: No API key is set, so nothing can be written. Settings → Claude (and 2 more failed).");
    assert.equal(r.trouble, true);
    const one = saidAboutWriteAll(tally([wrote(), failed("Recall policy")], 2));
    assert.match(one.says, /^1 written and waiting for you to read\. 1 could not be written: Recall policy: No API key is set/);
    assert.doesNotMatch(one.says, /more failed/);
    assert.equal(one.trouble, true, "one written does not make a failure green");
  });

  test("the site's own refusal is shown whole and anything else is cut, with the cut visible", () => {
    const long = "word ".repeat(100).trim();
    assert.ok(saidAboutWriteAll(tally([failed("A", long, true)], 1)).says.includes(long));
    const cut = saidAboutWriteAll(tally([failed("A", long, false)], 1)).says;
    assert.ok(!cut.includes(long));
    assert.match(cut, /word…/);
    const need = saidAboutWriteAll(tally([wrote(), needs("A", long)], 2)).says;
    assert.ok(!need.includes(long));
    assert.match(need, /A is waiting on: word[ word]*…/);
  });

  test("it names six findings that need a fact and counts the rest", () => {
    const eight = Array.from({ length: 8 }, (_, i) => needs(`Section ${i + 1}`));
    const r = saidAboutWriteAll(tally([wrote(), ...eight], 9)).says;
    assert.match(r, /8 need a fact about this pharmacy that it does not have: Section 1; Section 2; Section 3; Section 4; Section 5; Section 6; and 2 more\./);
  });
});

describe("and the places that use it", () => {
  const page = read("src/app/(app)/manual/page.tsx");
  const audit = read("src/lib/manual-audit.ts");
  const start = audit.indexOf("export async function draftAllFindingFixes(");
  const body = audit.slice(start, audit.indexOf("\n}\n", start));

  test("the press goes red when the message says trouble, and says nothing of its own", () => {
    const action = page.slice(page.indexOf("async function writeAllFixesAction()"), page.indexOf("async function dismissFindingAction"));
    assert.ok(action.length > 200, "the action was found");
    assert.match(action, /const said = saidAboutWriteAll\(r\);/);
    assert.match(action, /said\.trouble \? "error" : "ok"/);
    assert.match(action, /encodeURIComponent\(said\.says\)/);
    assert.match(action, /\$\{r\.tried\} asked about, \$\{r\.wrote\} written, \$\{r\.needFacts\.length\} wanting a fact, \$\{r\.failed\.length\} failed, \$\{r\.notTried\} not tried/, "the audit trail carries the same five counts");
    assert.doesNotMatch(action, /press again to carry on|written and waiting/, "the words live in one pure function, which a test can fail");
  });

  test("the card, the button and the message read the same words, in every state the card is in", () => {
    assert.match(page, /f\.answer \? CHANGE_IT_LABEL : TELL_IT_LABEL/);
    assert.match(page, /<button className="btn btn-sm">\{NOT_A_PROBLEM_LABEL\}<\/button>/);
    for (const words of [TELL_IT_LABEL, CHANGE_IT_LABEL, NOT_A_PROBLEM_LABEL]) assert.ok(!page.includes(words), `the page does not carry its own copy of "${words}"`);
  });

  test("the sentence shown when Claude gives no question does not say nobody has supplied a fact, because it is shown just after he has", () => {
    assert.match(audit, /stillNeeded: r\.stillNeeded \?\? "It still turns on a fact about this pharmacy that it does not have\."/);
    assert.doesNotMatch(audit, /nobody has supplied/);
    assert.match(page, /`Recorded\. \$\{r\.stillNeeded \?\? "The text could not be written from it yet\."\}`/, "this is where it is shown, right after the answer is saved");
  });

  test("every finding asked about leaves one outcome, the ones that threw included, and a refusal is told from anything else", () => {
    assert.ok(body.length > 200, "the function was found");
    assert.match(body, /outcomes\.push\(r\.wrote \? \{ kind: "wrote"/);
    assert.match(body, /kind: "needs-fact", section: f\.sectionTitle, need: r\.stillNeeded \?\? ""/, "what the model said it still needs is carried to the message");
    assert.equal((body.match(/section: f\.sectionTitle/g) ?? []).length, 3, "all three outcomes name the section they are about");
    assert.match(body, /catch \(e\) \{[\s\S]*outcomes\.push\(\{ kind: "failed"[\s\S]*why: describeError\(e\)/);
    assert.match(body, /const ours = e instanceof AiCapReachedError \|\| e instanceof AiNotConfiguredError \|\| e instanceof NotAsked;/);
    assert.match(body, /outcomes\.length >= limit/, "the limit counts what was asked about, failures included");
    assert.match(body, /const limit = opts\.limit \?\? \d+;/);
    assert.match(body, /return tallyWriteAll\(outcomes, pending\.length, limit\);/, "the report carries the limit the loop stopped at");
    assert.doesNotMatch(body, /done\+\+|stillNeedFacts|problems/, "the old counts that treated a failure as progress are gone");
  });
});
