import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { reasonShown, saidAboutLineRead, tally, type LineReadReport, type OneInvoice } from "../src/lib/invoice-lines-said";

/*
 * What the "Read the lines off the invoices" press tells him it did. The sentence is a pure function of the counts so that a count
 * that is wrong, or a sentence that claims more than the count, can fail a test here. Every figure is invented.
 */
const none: LineReadReport = {
  invoices: 0,
  withLines: 0,
  linesRead: 0,
  unreadable: 0,
  failed: 0,
  short: 0,
  byModel: 0,
  model: { sent: 0, keptUnchecked: 0, refused: 0, whyNotKept: null, whyRefused: null },
};
const report = (over: Partial<Omit<LineReadReport, "model">> & { model?: Partial<LineReadReport["model"]> } = {}): LineReadReport => ({
  ...none,
  ...over,
  model: { ...none.model, ...over.model },
});

describe("what the press says it read", () => {
  test("an ordinary press says how many lines on how many invoices, and is not trouble", () => {
    const r = saidAboutLineRead(report({ invoices: 4, withLines: 4, linesRead: 37 }));
    assert.equal(r.says, "37 item lines read, on 4 of the 4 invoices that had text to read.");
    assert.equal(r.trouble, false);
  });

  test("one line on one invoice is said in the singular", () => {
    assert.equal(saidAboutLineRead(report({ invoices: 1, withLines: 1, linesRead: 1 })).says, "1 item line read, on 1 of the 1 invoice that had text to read.");
  });

  test("a press with nothing to read says so rather than counting nought of nought", () => {
    const r = saidAboutLineRead(report());
    assert.equal(r.says, "No invoice was waiting to have its lines read.");
    assert.equal(r.trouble, false);
  });

  test("lines the rules read that fall short of what the invoice prints are kept, said to be kept, and are not a stopped press", () => {
    const r = saidAboutLineRead(report({ invoices: 3, withLines: 3, linesRead: 20, short: 2 }));
    assert.equal(
      r.says,
      "20 item lines read, on 3 of the 3 invoices that had text to read. 2 invoices were read but did not add up to the amount printed on them. The lines are kept, and each row shows what it is short by.",
    );
    assert.equal(r.trouble, false);
    assert.equal(
      saidAboutLineRead(report({ invoices: 1, withLines: 1, linesRead: 5, short: 1 })).says,
      "5 item lines read, on 1 of the 1 invoice that had text to read. 1 invoice was read but did not add up to the amount printed on it. The lines are kept, and its row shows what it is short by.",
    );
  });
});

describe("what it says about the invoices it sent to Claude", () => {
  test("invoices sent and all kept say so, and say nothing about being sent again or charged", () => {
    const r = saidAboutLineRead(report({ invoices: 2, withLines: 2, linesRead: 11, byModel: 2, model: { sent: 2 } }));
    assert.equal(r.says, "11 item lines read, on 2 of the 2 invoices that had text to read. 2 invoices were sent to Claude, because the rules found no line on them: 2 read and kept.");
    assert.equal(r.trouble, false);
    assert.doesNotMatch(r.says, /charged|sent again|not kept/);
  });

  test("lines kept with no total anywhere to check them against are named, so they are not taken for proved", () => {
    const r = saidAboutLineRead(report({ invoices: 2, withLines: 2, linesRead: 11, byModel: 2, model: { sent: 2, keptUnchecked: 1 } }));
    assert.match(r.says, /: 2 read and kept \(1 of those with no total to add the lines up to\)\.$/);
    assert.equal(r.trouble, false);
  });

  test("an invoice sent and not kept says why, that it will be sent again, and that it is charged for either way", () => {
    const why = "what Claude read did not add up to the invoice's total";
    const r = saidAboutLineRead(report({ invoices: 3, withLines: 1, linesRead: 5, byModel: 1, model: { sent: 3, whyNotKept: why } }));
    assert.equal(
      r.says,
      `5 item lines read, on 1 of the 3 invoices that had text to read. 3 invoices were sent to Claude, because the rules found no line on them: 1 read and kept, 2 not kept (${why}). Those invoices have no lines, so they are sent again the next time this is pressed, and a reading Claude finishes is charged for whether or not it is kept.`,
    );
    assert.equal(r.trouble, true, "money was spent and nothing was kept: that is not a green line");
  });

  test("one invoice sent and not kept is said in the singular, and with its reason", () => {
    const r = saidAboutLineRead(report({ invoices: 1, model: { sent: 1, whyNotKept: "Claude found no line that multiplied out" } }));
    assert.equal(
      r.says,
      "0 item lines read, on 0 of the 1 invoice that had text to read. 1 invoice was sent to Claude, because the rules found no line on it: 0 read and kept, 1 not kept (Claude found no line that multiplied out). That invoice has no lines, so it is sent again the next time this is pressed, and a reading Claude finishes is charged for whether or not it is kept.",
    );
    assert.equal(r.trouble, true);
  });

  test("a reason that was not recorded does not leave empty brackets", () => {
    const r = saidAboutLineRead(report({ invoices: 1, model: { sent: 1 } }));
    assert.doesNotMatch(r.says, /\(\)/);
    assert.match(r.says, /1 not kept\. That invoice/);
  });

  test("more kept than sent cannot be a negative number of invoices not kept", () => {
    const r = saidAboutLineRead(report({ invoices: 3, withLines: 3, linesRead: 9, byModel: 3, model: { sent: 1 } }));
    assert.doesNotMatch(r.says, /not kept|charged/);
    assert.equal(r.trouble, false);
  });

  test("invoices that could not be sent say why, and a press that sent nothing is trouble", () => {
    const r = saidAboutLineRead(report({ invoices: 2, model: { refused: 2, whyRefused: "the monthly ceiling on Claude has been reached." } }));
    assert.equal(r.says, "0 item lines read, on 0 of the 2 invoices that had text to read. 2 invoices could not be sent to Claude: the monthly ceiling on Claude has been reached.");
    assert.equal(r.trouble, true);
    assert.equal(saidAboutLineRead(report({ invoices: 1, model: { refused: 1 } })).says, "0 item lines read, on 0 of the 1 invoice that had text to read. 1 invoice could not be sent to Claude.");
  });
});

describe("what it says about the ones it could not read", () => {
  test("a scan is told apart from a file that failed, and only the failure is trouble", () => {
    const scansOnly = saidAboutLineRead(report({ invoices: 1, withLines: 1, linesRead: 2, unreadable: 3 }));
    assert.equal(scansOnly.says, "2 item lines read, on 1 of the 1 invoice that had text to read. 3 are scans with no text to read.");
    assert.equal(scansOnly.trouble, false);
    const both = saidAboutLineRead(report({ invoices: 2, withLines: 2, linesRead: 6, unreadable: 5, failed: 2 }));
    assert.equal(both.says, "6 item lines read, on 2 of the 2 invoices that had text to read. 3 are scans with no text to read. 2 could not be read at all, and were left as they were.");
    assert.equal(both.trouble, true);
  });

  test("one scan and one failure are said in the singular", () => {
    const r = saidAboutLineRead(report({ invoices: 1, withLines: 1, linesRead: 2, unreadable: 2, failed: 1 }));
    assert.match(r.says, /1 is a scan with no text to read\. 1 could not be read at all, and was left as it was\.$/);
  });

  test("a failure that is every one of the unreadable says nothing about scans", () => {
    const r = saidAboutLineRead(report({ invoices: 1, withLines: 1, linesRead: 2, unreadable: 2, failed: 2 }));
    assert.doesNotMatch(r.says, /scan/);
  });

  test("when every invoice was a scan or would not open, the sentence says no line was read, not that nothing was waiting", () => {
    const scans = saidAboutLineRead(report({ unreadable: 2 }));
    assert.equal(scans.says, "No item line was read. 2 are scans with no text to read.");
    assert.equal(scans.trouble, false);
    const failures = saidAboutLineRead(report({ unreadable: 2, failed: 2 }));
    assert.equal(failures.says, "No item line was read. 2 could not be read at all, and were left as they were.");
    assert.equal(failures.trouble, true);
    assert.doesNotMatch(failures.says, /waiting/);
  });

  test("only a press that found nothing at all says that nothing was waiting", () => {
    assert.match(saidAboutLineRead(report()).says, /waiting/);
    for (const over of [{ invoices: 1 }, { unreadable: 1 }, { unreadable: 1, failed: 1 }]) assert.doesNotMatch(saidAboutLineRead(report(over)).says, /waiting/);
  });
});

describe("the sentence reads as a sentence", () => {
  test("a reason that already ends in a full stop does not double it", () => {
    const r = saidAboutLineRead(
      report({ invoices: 3, withLines: 1, linesRead: 4, byModel: 1, unreadable: 1, failed: 1, model: { sent: 2, refused: 1, whyNotKept: "it did not add up.", whyRefused: "no key is set." } }),
    );
    assert.doesNotMatch(r.says, /\.\./);
    assert.doesNotMatch(r.says, /\.\)/);
    assert.match(r.says, /\.$/);
  });

  test("everything that went wrong in one press is in the one sentence, in the order it happened", () => {
    const r = saidAboutLineRead(
      report({ invoices: 5, withLines: 3, linesRead: 18, short: 1, byModel: 1, unreadable: 3, failed: 1, model: { sent: 2, refused: 1, whyNotKept: "a", whyRefused: "b" } }),
    );
    const parts = ["item lines read", "did not add up to the amount printed", "sent to Claude, because", "could not be sent to Claude", "are scans", "could not be read at all"];
    const at = parts.map((s) => r.says.indexOf(s));
    assert.ok(at.every((i) => i >= 0), `a part of what happened is missing: ${r.says}`);
    assert.deepEqual([...at].sort((a, b) => a - b), at, "the parts are out of order");
    assert.equal(r.trouble, true);
  });
});

describe("the page uses it", () => {
  test("the press builds its message from the report, and sends the red one when anything went wrong", async () => {
    const { readFileSync } = await import("node:fs");
    const page = readFileSync("src/app/(app)/inventory/invoices/page.tsx", "utf8");
    assert.match(page, /saidAboutLineRead\(r\)/);
    assert.match(page, /invoices\?\$\{trouble \? "error" : "ok"\}=\$\{encodeURIComponent\(says\)\}/, "a press that went wrong sends the red message, and the test fails if the two are swapped");
    assert.match(page, /details: `\$\{r\.invoices\} invoices with text to read, \$\{r\.unreadable\} without \(\$\{r\.failed\} would not open\), \$\{r\.linesRead\} lines read, \$\{r\.short\} short of what they print, \$\{r\.model\.sent\} sent to Claude and \$\{r\.byModel\} of them kept, \$\{r\.model\.refused\} stopped before sending`/, "the audit trail carries the same counts the message is built from");
  });

  test("the card that offers the press names the ceiling from the constant the ceiling is built from, not a figure typed beside it", async () => {
    const { readFileSync } = await import("node:fs");
    const page = readFileSync("src/app/(app)/inventory/invoices/page.tsx", "utf8");
    assert.match(page, /import \{ DEFAULT_MONTHLY_CAP, dollars as dollarAmount \} from "@\/lib\/ai-spend";/);
    assert.match(page, /the built-in \{dollarAmount\(DEFAULT_MONTHLY_CAP\)\} unless one was set there/);
    assert.doesNotMatch(page, /\$50/, "a typed $50 would go on saying so after the built-in ceiling changed");
    assert.match(page, /Up to \{noLinesCount\} invoice\{noLinesCount === 1 \? "" : "s"\} could be sent: that count includes any\s+invoice whose page has no text to read or whose file will not open, and those are never sent\./);
    assert.doesNotMatch(page, /a scan is never sent/, "a scan is one of two kinds of invoice the press never sends, the other being a file that will not open, and the count includes both");
    assert.match(page, /is sent again the next time this is pressed, and a reading Claude finishes is charged\s+for whether or not it is kept\./, "the card tells him an unkept reading is still paid for, as the message after the press does");
    assert.match(page, /is checked before each invoice is sent, so the last one sent can take\s+the spending a little past it\./, "the ceiling is read before each call, so the call that reaches it still finishes");
    assert.doesNotMatch(page, /stops at the monthly/, "a check made before each call does not stop at the ceiling");
    assert.doesNotMatch(page, /At most \{noLinesCount\}/, "the bound counts every invoice without lines, scans included, so it is an 'up to', not an 'at most' that a scan would make false");
  });

  test("the writer shows a refusal whole and cuts only what it did not write itself", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync("src/lib/invoices.ts", "utf8");
    assert.match(src, /const refusal = e instanceof AiCapReachedError \|\| e instanceof AiNotConfiguredError \|\| e instanceof NotAsked;/);
    assert.match(src, /model\.why = reasonShown\(describeError\(e\), refusal\);/);
  });

  test("the press counts what is short from the invoice's row after the write, not from what the write returned", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync("src/lib/invoices.ts", "utf8");
    assert.match(src, /columns: \{ linesShortCents: true \} \}\);\s+results\.push\(\{ kind: "read", \.\.\.written, shortCents: after\?\.linesShortCents \?\? 0 \}\);/);
  });
});

describe("a reason as he is shown it", () => {
  const ceiling =
    "Claude has cost $51.00 in the last month, against a ceiling of $50.00 — which nothing here chose deliberately; it is the built-in limit, there so that software spending your money on a computer you are not sitting at cannot run away. Raise it or turn it off under Settings → Claude. Everything already done is saved, and nothing further is sent until then.";

  test("the site's own refusal is shown whole however long it is, because it was written to be read", () => {
    assert.ok(ceiling.length > 240, "the sample has to be longer than the cut for this to prove anything");
    assert.equal(reasonShown(ceiling, true), ceiling);
  });

  test("a short reason is shown whole whoever wrote it, up to the limit itself", () => {
    assert.equal(reasonShown("it did not add up", false), "it did not add up");
    const atLimit = "word ".repeat(48).trimEnd().padEnd(240, "x");
    assert.equal(atLimit.length, 240);
    assert.equal(reasonShown(atLimit, false), atLimit);
  });

  test("anything else that is long is cut between words and the cut is visible", () => {
    const shown = reasonShown(ceiling, false);
    assert.ok(shown.endsWith("…"), "a cut that does not say so reads as the whole message");
    assert.ok(shown.length <= 241);
    const start = shown.slice(0, -1);
    assert.ok(ceiling.startsWith(start), "what is shown is the beginning of what was said");
    assert.match(ceiling[start.length], /\s/, "the cut falls between two words, not inside one");
  });

  test("a long reason with no space in it is cut at the limit rather than lost", () => {
    assert.equal(reasonShown("x".repeat(500), false), "x".repeat(240) + "…");
    assert.equal(reasonShown("x".repeat(241), false), "x".repeat(240) + "…", "one character over the limit is over it");
  });
});

/*
 * The counting that feeds the sentence, on results made by hand. Nothing here can reach Claude: each result is what one invoice
 * would have handed back, so a count that adds the wrong thing, or a reason that leaks from the wrong invoice, fails here.
 */
const noAsk = { sent: false, kept: false, why: null };
const ruleRead = (read: number, reconciles: boolean | null = true, shortCents = 0): OneInvoice => ({ kind: "read", read, reconciles, readBy: "rule", shortCents, model: noAsk });
const kept = (read: number, reconciles: boolean | null = true, why: string | null = null): OneInvoice => ({
  kind: "read",
  read,
  reconciles,
  readBy: "model",
  shortCents: 0,
  model: { sent: true, kept: true, why },
});
const notKept = (why: string | null): OneInvoice => ({ kind: "read", read: 0, reconciles: null, readBy: null, shortCents: 0, model: { sent: true, kept: false, why } });
const stopped = (why: string | null): OneInvoice => ({ kind: "read", read: 0, reconciles: null, readBy: null, shortCents: 0, model: { sent: false, kept: false, why } });

describe("counting what each invoice handed back", () => {
  test("nothing tried is an empty report, not a missing one", () => {
    assert.deepEqual(tally([]), none);
  });

  test("a scan and a file that failed are both unreadable, and only the failure is counted as one", () => {
    const r = tally([{ kind: "scan" }, { kind: "scan" }, { kind: "failed" }]);
    assert.equal(r.unreadable, 3);
    assert.equal(r.failed, 1);
    assert.equal(r.invoices, 0, "neither was read, so neither counts as tried");
    assert.equal(r.withLines, 0);
  });

  test("lines are added up, and only an invoice with a line counts as having lines", () => {
    const r = tally([ruleRead(6), ruleRead(5), ruleRead(0, null)]);
    assert.equal(r.invoices, 3);
    assert.equal(r.linesRead, 11);
    assert.equal(r.withLines, 2);
  });

  test("an invoice is short when its row records a shortfall, whatever the whole-invoice flag said", () => {
    const r = tally([ruleRead(5, false, 11_097), ruleRead(5, true, 3_101), ruleRead(5, null, 2_031)]);
    assert.equal(r.short, 3, "the row is where a half of an invoice falling short is recorded, and it can be short while the whole-invoice flag is true or null");
  });

  test("a shortfall in either direction is a shortfall, because the morning check counts every row that records one", () => {
    assert.equal(tally([ruleRead(5, false, -300)]).short, 1);
  });

  test("an invoice is not short when its row records no shortfall, whatever the whole-invoice flag said", () => {
    const r = tally([ruleRead(5, false, 0), ruleRead(5, true, 0), ruleRead(5, null, 0)]);
    assert.equal(r.short, 0);
  });

  test("an invoice that read no line is never counted short, whatever its row still carries from an earlier read", () => {
    assert.equal(tally([ruleRead(0, false, 11_097), ruleRead(0, null, 500)]).short, 0);
  });

  test("lines the rules read are never counted as Claude's, kept unchecked or not", () => {
    const r = tally([ruleRead(5, null), ruleRead(5, true)]);
    assert.equal(r.byModel, 0);
    assert.equal(r.model.keptUnchecked, 0);
    assert.equal(r.model.sent, 0);
  });

  test("lines Claude read are counted as sent and kept, and the ones with no total to check them against are named", () => {
    const r = tally([kept(4, true), kept(3, null), kept(2, null)]);
    assert.equal(r.byModel, 3);
    assert.equal(r.model.sent, 3);
    assert.equal(r.model.keptUnchecked, 2);
    assert.equal(r.model.whyNotKept, null);
    assert.equal(r.model.refused, 0);
  });

  test("an invoice sent and not kept is sent but not Claude's, and its reason is remembered", () => {
    const r = tally([notKept("it did not add up")]);
    assert.equal(r.model.sent, 1);
    assert.equal(r.byModel, 0);
    assert.equal(r.model.whyNotKept, "it did not add up");
    assert.equal(r.model.refused, 0);
  });

  test("a reason from an invoice that was kept does not become a reason for the ones that were not", () => {
    const r = tally([kept(4, true, "a note on a good reading"), notKept(null)]);
    assert.equal(r.model.whyNotKept, null);
  });

  test("an invoice sent and not kept with no reason recorded leaves no empty reason behind", () => {
    assert.equal(tally([notKept(null), notKept("")]).model.whyNotKept, null);
  });

  test("an invoice stopped before it was sent is refused, not sent, and its reason goes in the other list", () => {
    const r = tally([stopped("no key is set"), notKept("it did not add up")]);
    assert.equal(r.model.refused, 1);
    assert.equal(r.model.sent, 1);
    assert.equal(r.model.whyRefused, "no key is set");
    assert.equal(r.model.whyNotKept, "it did not add up");
  });

  test("an invoice nobody asked Claude about is neither sent nor refused", () => {
    const r = tally([ruleRead(3), stopped(null)]);
    assert.equal(r.model.sent, 0);
    assert.equal(r.model.refused, 0);
    assert.equal(r.model.whyRefused, null);
  });

  test("the same reason on many invoices is said once", () => {
    const r = tally([notKept("it did not add up"), notKept("it did not add up"), notKept("it did not add up")]);
    assert.equal(r.model.sent, 3);
    assert.equal(r.model.whyNotKept, "it did not add up");
  });

  test("at most three different reasons are kept, the first three met, joined by a semicolon", () => {
    const r = tally([notKept("a"), notKept("b"), notKept("a"), notKept("c"), notKept("d"), stopped("w"), stopped("x"), stopped("y"), stopped("z")]);
    assert.equal(r.model.whyNotKept, "a; b; c");
    assert.equal(r.model.whyRefused, "w; x; y");
    assert.equal(r.model.sent, 5);
    assert.equal(r.model.refused, 4);
  });

  test("a mixed press adds up each kind on its own", () => {
    const r = tally([ruleRead(6), ruleRead(5, false, 11_097), kept(3, null), notKept("r"), stopped("s"), { kind: "scan" }, { kind: "failed" }]);
    assert.deepEqual(r, {
      invoices: 5,
      withLines: 3,
      linesRead: 14,
      unreadable: 2,
      failed: 1,
      short: 1,
      byModel: 1,
      model: { sent: 2, keptUnchecked: 1, refused: 1, whyNotKept: "r", whyRefused: "s" },
    });
    const said = saidAboutLineRead(r);
    assert.equal(said.trouble, true);
  });
});
