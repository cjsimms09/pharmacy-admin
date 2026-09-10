import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { sourceOf, kindWords, storyOf, summarise, type InboxRow } from "../src/lib/inbox-line";

/*
 * What the Inbox says happened to a document.
 *
 * The owner: "I NEED TO BE ABLE TO MAKE SURE IT DID THE RIGHT THING WITH THE DOCUMENT." The line
 * has to be readable without opening anything, and the distinction it must never blur is between
 * recognised-and-loaded and recognised-and-refused. A catalogue turned away for naming the wrong
 * supplier was recognised perfectly well, and a green badge on it says the opposite of the truth.
 */
const row = (over: Partial<InboxRow> = {}): InboxRow => ({
  receivedAt: "2026-09-09T05:02:00.000Z",
  fromAddress: "reports@mckesson.com",
  subject: "Daily catalogue",
  fileName: "MCKCatalog9_9_2026.txt",
  documentId: "doc1",
  status: "stored",
  reason: null,
  routedAs: "pioneer_catalog",
  routeResult: "44,802 rows, 44,251 items updated",
  scanned: true,
  ...over,
});

describe("where it came from", () => {
  test("the three ways in are told apart, because there are three now", () => {
    assert.equal(sourceOf({ fromAddress: "reports@mckesson.com" }).source, "mailbox");
    assert.equal(sourceOf({ fromAddress: "sftp://136.65.188.47/inbox" }).source, "sftp");
    assert.equal(sourceOf({ fromAddress: "balance-on-hand.txt" }).source, "dropped");
  });

  test("the file host is said in words, not as an address", () => {
    // Nobody should have to know that a scheme in the From column means RedSail pushed it.
    assert.match(sourceOf({ fromAddress: "sftp://136.65.188.47/inbox" }).label, /file host/i);
  });

  test("nothing at all in the From column is a file somebody added by hand", () => {
    assert.equal(sourceOf({ fromAddress: null }).source, "dropped");
    assert.equal(sourceOf({ fromAddress: "" }).source, "dropped");
  });
});

describe("what it is, in his words", () => {
  test("the kinds are named the way the pharmacy names them", () => {
    assert.equal(kindWords("rx_transactions"), "Daily claims report");
    assert.equal(kindWords("copay_remit"), "Copay-card voucher remittance");
    assert.equal(kindWords("payer_payments"), "Third-party payments report");
  });

  test("a kind nobody has worded is shown rather than hidden", () => {
    assert.equal(kindWords("some_new_feed"), "some new feed");
    assert.equal(kindWords(null), null);
  });
});

describe("what happened to it", () => {
  test("loaded says what changed, in the loader's own words", () => {
    const s = storyOf(row());
    assert.equal(s.outcome, "loaded");
    assert.equal(s.tone, "ok");
    assert.match(s.headline, /Loaded as wholesaler catalogue/);
    assert.equal(s.changed, "44,802 rows, 44,251 items updated");
  });

  test("recognised and refused is not green, because it is not loaded", () => {
    /*
     * The distinction the old screen blurred. A file the site understood perfectly and then
     * deliberately refused has changed nothing, and colouring it as a success is the one thing
     * this line must never do.
     */
    const s = storyOf(row({ routedAs: "copay_remit", routeResult: "Held, nothing stored: the statement does not balance — its rows net to $177.25 and it says it paid $180.19." }));
    assert.equal(s.outcome, "held");
    assert.equal(s.tone, "crit");
    assert.equal(s.changed, null, "nothing changed, so nothing is claimed to have changed");
    assert.match(s.headline, /held — nothing was stored/);
    assert.match(s.why!, /does not balance/);
  });

  test("the 835 path's wording is caught by the same test as the copay path's", () => {
    const s = storyOf(row({ routedAs: "remittance_835", routeResult: "Held, nothing stored: the remittance does not balance." }));
    assert.equal(s.outcome, "held");
  });

  test("a load whose own sentence merely mentions holding is not mistaken for a refusal", () => {
    // "3 rows held for review" is a good load. A loose test for /held/ would colour it as a refusal.
    const s = storyOf(row({ routeResult: "1,200 items updated, 3 rows held for review" }));
    assert.equal(s.outcome, "loaded");
    assert.equal(s.tone, "ok");
  });

  test("filed with nothing read into any table is amber, and says so plainly", () => {
    const s = storyOf(row({ routeResult: null }));
    assert.equal(s.outcome, "filed_only");
    assert.equal(s.tone, "warn");
    assert.match(s.why!, /nothing was read into the site's tables/);
  });

  test("nothing recognised it at all is its own answer", () => {
    const s = storyOf(row({ routedAs: "unrecognised", routeResult: "A PDF this does not recognise. Filed as a document." }));
    assert.equal(s.outcome, "not_recognised");
    assert.equal(s.tone, "warn");
    assert.equal(s.invitesRerouting, true, "this is exactly where telling it what the document is helps");
  });

  test("refused before storage is a different thing from refused after reading", () => {
    const s = storyOf(row({ status: "rejected", reason: "Larger than the 25 MB limit.", routedAs: null, routeResult: null }));
    assert.equal(s.outcome, "rejected");
    assert.equal(s.invitesRerouting, false, "there is no stored document to re-route");
  });

  test("a message passed over is quiet, because it is not a problem", () => {
    const s = storyOf(row({ status: "ignored", reason: "Sender is not on the allowed list.", documentId: null, routedAs: null, routeResult: null }));
    assert.equal(s.outcome, "ignored");
    assert.equal(s.tone, "muted");
  });
});

describe("the day in one line", () => {
  test("it counts the outcomes rather than the arrivals alone", () => {
    const rows = [
      row(),
      row({ routeResult: null }),
      row({ routedAs: "unrecognised" }),
      row({ status: "rejected", reason: "too big" }),
      row({ routedAs: "copay_remit", routeResult: "Held, nothing stored: it does not balance." }),
    ];
    const s = summarise(rows);
    assert.match(s, /^5 arrivals/);
    assert.match(s, /1 loaded/);
    assert.match(s, /1 held with nothing stored/);
    assert.match(s, /1 filed but not loaded/);
    assert.match(s, /1 not recognised/);
    assert.match(s, /1 refused/);
  });

  test("a good day says only what happened, with no zeroes to read past", () => {
    assert.equal(summarise([row(), row()]), "2 arrivals, 2 loaded.");
  });

  test("nothing at all is said plainly", () => {
    assert.equal(summarise([]), "Nothing has arrived yet.");
  });
});
