import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { buildEraRequest, routeFor, missingFor, letterFor, nextActionFor, type EnrolmentFacts, type Identity } from "../src/lib/era-request";

/*
 * What these protect.
 *
 * An ERA enrolment changes where a payer reports the money it has paid. A request sent with a
 * guessed identifier is not a request that fails loudly — it is answered weeks later with a
 * rejection nobody connects back to the guess, while the pharmacy waits for remittances that were
 * never coming. So every test here is either "a fact the contract did not state is never invented"
 * or "the request goes the way this payer actually enrols".
 */

const whole: Identity = {
  name: "West Wichita Family Pharmacy",
  ncpdp: "1712345",
  npi: "1234567893",
  tin: "48-1234567",
  address: "123 Example St, Wichita KS 67212",
  phone: "316-555-0100",
  mailbox: "reports@example-pharmacy.test",
};

const bare = (over: Partial<EnrolmentFacts> = {}): EnrolmentFacts => ({ pbmName: "Example PBM", ...over });

describe("how the request travels is decided by what the contract printed", () => {
  test("a printed enrolment form beats everything else, because it is the enrolment, named", () => {
    const r = routeFor(bare({
      enrollmentFormUrl: "https://pbm.example.invalid/era-form.pdf",
      contacts: [{ email: "eft@pbm.example.invalid", portalUrl: "https://pbm.example.invalid/portal" }],
    }));
    assert.equal(r.how, "form");
    assert.equal(r.target, "https://pbm.example.invalid/era-form.pdf");
  });

  test("a portal beats an email, and an email beats a postal address", () => {
    assert.equal(routeFor(bare({ contacts: [{ portalUrl: "https://p.example.invalid", email: "a@b.test" }] })).how, "portal");
    assert.equal(routeFor(bare({ contacts: [{ email: "a@b.test", postalAddress: "PO Box 1" }] })).how, "email");
    assert.equal(routeFor(bare({ contacts: [{ postalAddress: "PO Box 1" }] })).how, "post");
  });

  test("prose only breaks the tie when nothing printed an address", () => {
    const r = routeFor(bare({ enrollmentMethod: "Through the provider portal" }));
    assert.equal(r.how, "portal");
    assert.equal(r.target, null);
    assert.match(r.why, /prints no address/);
  });

  test("a contract that says no 835 is offered says so, rather than reading as ignorance", () => {
    // These are different jobs. "We do not know" is a document to read; "they do not offer it" is
    // a question to ask — and the pharmacy waiting on a remittance that was never coming is the
    // outcome this exists to prevent.
    const r = routeFor(bare({ eraOffered: false }));
    assert.equal(r.how, "unknown");
    assert.match(r.why, /no electronic remittance is offered/i);
  });

  test("a form URL that is not a URL is not a route", () => {
    assert.equal(routeFor(bare({ enrollmentFormUrl: "see the provider manual" })).how, "unknown");
    assert.equal(routeFor(bare({ contacts: [{ email: "the billing department" }] })).how, "unknown");
  });
});

describe("nothing the contract did not say is invented", () => {
  test("the letter names a clearinghouse and a trading partner only where the contract did", () => {
    const withThem = letterFor(
      bare({ clearinghouse: "Example Clearinghouse", tradingPartnerId: "TP12345", contacts: [{ email: "eft@pbm.example.invalid" }] }),
      whole, whole.mailbox!, { how: "email", target: "eft@pbm.example.invalid", why: "" },
    );
    assert.match(withThem!.body, /Example Clearinghouse as the clearinghouse and trading partner ID TP12345/);

    const without = letterFor(bare({ contacts: [{ email: "eft@pbm.example.invalid" }] }), whole, whole.mailbox!, { how: "email", target: "eft@pbm.example.invalid", why: "" });
    assert.doesNotMatch(without!.body, /clearinghouse|trading partner/i);
  });

  test("the pharmacy's own identifiers appear as they are, and a missing one is a dash not a guess", () => {
    const id: Identity = { ...whole, tin: null };
    const l = letterFor(bare({ contacts: [{ email: "a@b.test" }] }), id, "x@y.test", { how: "email", target: "a@b.test", why: "" });
    assert.match(l!.body, /NCPDP 1712345 · NPI 1234567893 · TIN —/);
  });

  test("there is no letter for a portal, because a letter is not what a portal takes", () => {
    assert.equal(letterFor(bare({}), whole, "x@y.test", { how: "portal", target: "https://p.test", why: "" }), null);
    assert.equal(letterFor(bare({}), whole, "x@y.test", { how: "form", target: "https://f.test", why: "" }), null);
  });
});

describe("what is missing is said in words, with where to get it", () => {
  test("each of the pharmacy's own four is named with the screen it lives on", () => {
    const none: Identity = { name: "P", ncpdp: null, npi: null, tin: null, address: null, phone: null, mailbox: null };
    const m = missingFor(bare({ contacts: [{ email: "a@b.test" }] }), none, { how: "email", target: "a@b.test", why: "" });
    assert.equal(m.length, 4);
    for (const line of m) assert.match(line, /Settings/);
  });

  test("a payer whose contract was read but said nothing reads differently from one never read", () => {
    const readIt = missingFor(bare({ readFrom: "Example PBM agreement 2025.pdf" }), whole, { how: "unknown", target: null, why: "" });
    assert.match(readIt[0], /was read and did not say/);
    const neverRead = missingFor(bare({}), whole, { how: "unknown", target: null, why: "" });
    assert.match(neverRead[0], /has not been read yet/);
  });

  test("a portal the contract mentions but does not print is itself a missing thing", () => {
    const m = missingFor(bare({ enrollmentMethod: "online" }), whole, { how: "portal", target: null, why: "" });
    assert.equal(m.some((x) => /address of .* enrolment portal/.test(x)), true);
  });

  test("ready means nothing missing and somewhere to send it", () => {
    assert.equal(buildEraRequest(bare({ contacts: [{ email: "eft@pbm.example.invalid" }] }), whole).ready, true);
    assert.equal(buildEraRequest(bare({}), whole).ready, false);
    assert.equal(buildEraRequest(bare({ contacts: [{ email: "eft@pbm.example.invalid" }] }), { ...whole, npi: null }).ready, false);
  });
});

describe("the fields somebody has to type", () => {
  test("the delivery target is on the list, because it is the change being asked for", () => {
    const f = buildEraRequest(bare({ contacts: [{ portalUrl: "https://p.test" }] }), whole).fields;
    const target = f.find((x) => x.label === "Send the 835 to");
    assert.equal(target?.value, whole.mailbox);
    assert.match(target?.note ?? "", /This is the change being asked for/);
  });

  test("a clearinghouse and a trading partner appear only when the contract gave them", () => {
    const without = buildEraRequest(bare({ contacts: [{ portalUrl: "https://p.test" }] }), whole).fields.map((x) => x.label);
    assert.equal(without.includes("Trading partner ID"), false);
    const withThem = buildEraRequest(bare({ contacts: [{ portalUrl: "https://p.test" }], clearinghouse: "Availity", tradingPartnerId: "TP1" }), whole).fields;
    assert.equal(withThem.find((x) => x.label === "Trading partner ID")?.value, "TP1");
    assert.match(withThem.find((x) => x.label === "Trading partner ID")?.note ?? "", /Check it against what they have on file/);
  });

  test("a value the pharmacy has not filled in is null, so the page shows it missing rather than blank", () => {
    // A blank box on a form is how a field gets skipped and the enrolment comes back rejected.
    const f = buildEraRequest(bare({ contacts: [{ portalUrl: "https://p.test" }] }), { ...whole, tin: null }).fields;
    assert.equal(f.find((x) => x.label === "Tax ID (TIN)")?.value, null);
  });
});

describe("the next action is one sentence and depends on the state first", () => {
  const facts = bare({ contacts: [{ email: "eft@pbm.example.invalid" }] });
  test("never asked, and ready", () => {
    assert.match(nextActionFor(facts, routeFor(facts), [], "not_started"), /Ready to send to eft@pbm\.example\.invalid/);
  });
  test("never asked, and not ready — the first missing thing is the sentence", () => {
    const m = ["the pharmacy's NPI (Settings → Pharmacy)", "a mailbox (Settings → Email)"];
    const s = nextActionFor(facts, routeFor(facts), m, "not_started");
    assert.match(s, /Not ready: the pharmacy's NPI/);
    assert.match(s, /and 1 more/);
  });
  test("asked and waiting names who to chase", () => {
    assert.match(nextActionFor(facts, routeFor(facts), [], "requested"), /chase eft@pbm\.example\.invalid/);
  });
  test("receiving is done, and says so plainly", () => {
    assert.match(nextActionFor(facts, routeFor(facts), [], "receiving"), /Done/);
  });
  test("declined does not pretend there is nothing to do", () => {
    assert.match(nextActionFor(facts, routeFor(facts), [], "declined"), /keep the remittance it provides coming to the inbox/);
  });
  test("a form says to open the form; a portal says to type into the portal", () => {
    const form = bare({ enrollmentFormUrl: "https://f.test/era.pdf" });
    assert.match(buildEraRequest(form, whole).nextAction, /Open Example PBM's enrolment form/);
    const portal = bare({ contacts: [{ portalUrl: "https://p.test" }] });
    assert.match(buildEraRequest(portal, whole).nextAction, /Sign in to Example PBM's portal/);
  });
});
