import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createClient } from "@libsql/client";
import { scrubCopy, provePrivate } from "../src/lib/backup-scrub";

/**
 * The scrubber is the one piece of this site whose failure would be a disclosure rather than a
 * wrong number, so it is tested against a database built to contain exactly the things it must
 * remove — and, more importantly, against one built to defeat it.
 */
async function fixture(): Promise<string> {
  const file = path.join(os.tmpdir(), `scrub-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
  const db = createClient({ url: `file:${file}` });
  await db.execute("create table claims (id text primary key, rx_number text, ndc11 text, remit_cents integer, raw_json text)");
  await db.execute("create table claim_payments (id text primary key, rx_number text, paid_cents integer)");
  await db.execute("create table people (id text primary key, first_name text not null, last_name text not null, email text)");
  await db.execute("create table users (id text primary key, name text, username text, password_hash text)");
  await db.execute("create table cqi_incidents (id text primary key, description text not null, root_cause_analysis text, rx_numbers_enc text, occurred_on text)");
  await db.execute("create table manual_sections (id text primary key, heading text, body text)");
  await db.execute("create table settings (key text primary key, value text)");
  await db.execute("create table suppliers (id text primary key, name text, sender_emails text)");
  await db.execute("create table sessions (id text primary key, token text)");
  await db.execute("create table nadac_prices (id text primary key, ndc11 text, unit_micros integer, effective_on text)");
  await db.execute("create table supplier_items (id text primary key, description text)");

  await db.execute("insert into claims values ('c1','7412589','00093005001',1234,'{\"patient\":\"a name\"}')");
  await db.execute("insert into claims values ('c2','7412589','00093005001',900,'{}')"); // the coordinated leg
  await db.execute("insert into claims values ('c3','7412590','00093005002',400,'{}')");
  await db.execute("insert into claim_payments values ('p1','7412589',1234)");
  await db.execute("insert into people values ('e1','Jane','Doe','jane.doe@example.com')");
  await db.execute("insert into users values ('u1','Jane Doe','jane','$2a$10$abcdefghijklmnop')");
  await db.execute("insert into cqi_incidents values ('i1','Wrong drug given to Mrs Smith, 316-555-0134','Root cause: the label','encrypted-blob','2026-08-01')");
  await db.execute("insert into manual_sections values ('m1','Contact','Phone: 316-491-6428 DEA: FW8325498')");
  await db.execute("insert into settings values ('mail_password_enc','a-real-secret')");
  await db.execute("insert into settings values ('digest_last_result','sent to owner@example.com: 14 things late')");
  await db.execute("insert into suppliers values ('s1','McKesson','orders.clerk@mckesson.com')");
  await db.execute("insert into sessions values ('sess1','a-live-token')");
  // Two weeks of NADAC for one drug, and a later correction for another.
  await db.execute("insert into nadac_prices values ('n1','00093005001',500000,'2026-08-25')");
  await db.execute("insert into nadac_prices values ('n2','00093005001',510000,'2026-09-01')");
  await db.execute("insert into nadac_prices values ('n3','00093005002',700000,'2026-09-08')");
  // A drug description that an over-eager check called a telephone number and a DEA registration.
  await db.execute("insert into supplier_items values ('i1','OYSCO 500+D TB 500-200 1000')");
  await db.execute("insert into supplier_items values ('i2','BAXT FOIL SEAL TMPIN H93830020')");
  db.close();
  return file;
}

const read = async (file: string, sql: string) => {
  const db = createClient({ url: `file:${file}` });
  try {
    return (await db.execute(sql)).rows;
  } finally {
    db.close();
  }
};

describe("the copy that leaves the building", () => {
  test("prescription numbers are replaced, and the same one reads the same throughout", async () => {
    const file = await fixture();
    const report = await scrubCopy(file);
    const rows = await read(file, "select id, rx_number from claims order by id");
    const pay = await read(file, "select rx_number from claim_payments");

    assert.equal(report.prescriptions, 2, "two distinct prescriptions were seen");
    for (const r of rows) assert.match(String(r.rx_number), /^RX[0-9A-F]{10}$/);
    // The whole basis of the reimbursement figures: a claim billed to a primary and then a
    // secondary is one fill, and it has to stay one fill in the copy.
    assert.equal(rows[0].rx_number, rows[1].rx_number, "the coordinated legs still group");
    assert.notEqual(rows[0].rx_number, rows[2].rx_number, "a different prescription is still different");
    // And the payment still points at the fill it paid for.
    assert.equal(pay[0].rx_number, rows[0].rx_number);
  });

  test("two copies of the same database share no stand-in", async () => {
    // The salt is made fresh each time and never written down, so a copy cannot be lined up
    // against another copy — or against the pharmacy's own records — to undo the replacement.
    const a = await fixture();
    const b = await fixture();
    await scrubCopy(a);
    await scrubCopy(b);
    const ra = (await read(a, "select rx_number from claims where id = 'c1'"))[0].rx_number;
    const rb = (await read(b, "select rx_number from claims where id = 'c1'"))[0].rx_number;
    assert.notEqual(ra, rb);
  });

  test("secrets, names and free text are gone", async () => {
    const file = await fixture();
    await scrubCopy(file);
    assert.equal((await read(file, "select password_hash from users"))[0].password_hash, null);
    assert.equal((await read(file, "select value from settings where key='mail_password_enc'"))[0].value, "");
    assert.equal((await read(file, "select raw_json from claims where id='c1'"))[0].raw_json, null);
    assert.equal((await read(file, "select rx_numbers_enc from cqi_incidents"))[0].rx_numbers_enc, null);
    assert.equal((await read(file, "select root_cause_analysis from cqi_incidents"))[0].root_cause_analysis, null);
    // NOT NULL takes an empty string rather than refusing the whole export, which it once did.
    assert.equal((await read(file, "select description from cqi_incidents"))[0].description, "");
    assert.equal((await read(file, "select body from manual_sections"))[0].body, null);
    assert.equal((await read(file, "select count(*) as n from sessions"))[0].n, 0);
    const person = (await read(file, "select first_name, last_name, email from people"))[0];
    assert.equal(person.first_name, "Staff");
    assert.equal(person.email, null);
  });

  test("an address written into a log line is caught, though no list of key names would name it", async () => {
    const file = await fixture();
    await scrubCopy(file);
    const v = String((await read(file, "select value from settings where key='digest_last_result'"))[0].value);
    assert.doesNotMatch(v, /owner@example\.com/);
    assert.match(v, /14 things late/, "and the rest of the line survives, so the log still reads");
  });

  test("a supplier's mailbox keeps its domain, because that is what the routing matches on", async () => {
    const file = await fixture();
    await scrubCopy(file);
    const v = String((await read(file, "select sender_emails from suppliers"))[0].sender_emails);
    assert.doesNotMatch(v, /orders\.clerk/);
    assert.match(v, /mckesson\.com/);
  });

  test("NADAC keeps the newest price for each drug, not the newest week", async () => {
    // Trimming to the newest date alone kept five rows out of 1.46 million on the real database:
    // CMS restates a handful of drugs after the weekly file, so that date holds the corrections
    // and nothing else. What the site reads is the newest row per NDC.
    const file = await fixture();
    await scrubCopy(file);
    const rows = await read(file, "select id, ndc11, effective_on from nadac_prices order by ndc11");
    assert.equal(rows.length, 2, "one price for each of the two drugs");
    assert.equal(rows.find((r) => r.ndc11 === "00093005001")!.effective_on, "2026-09-01");
    assert.equal(rows.find((r) => r.ndc11 === "00093005002")!.effective_on, "2026-09-08");
  });

  test("and then the copy proves itself", async () => {
    const file = await fixture();
    await scrubCopy(file);
    const proof = await provePrivate(file);
    assert.equal(proof.ok, true, proof.ok ? "" : JSON.stringify(proof.found));
  });

  test("a drug description is not a telephone number or a DEA registration", async () => {
    // The check that cries wolf is the check somebody turns off. Both of these are real rows out
    // of a wholesaler's price file, and 147,725 more of the same shape sit behind them.
    const file = await fixture();
    await scrubCopy(file);
    const proof = await provePrivate(file);
    assert.equal(proof.ok, true);
    const kept = await read(file, "select description from supplier_items order by id");
    assert.equal(kept.length, 2, "and they are still there: the trade text is the point of the copy");
  });

  test("a column the scrubber does not know about stops the copy", async () => {
    /*
     * The test that matters most. The rules are a list somebody wrote, and a list is only as good
     * as its author's memory of the schema. Here is a table added after the list — as one will be
     * — carrying an address, and the proof has to refuse it.
     */
    const file = await fixture();
    const db = createClient({ url: `file:${file}` });
    await db.execute("create table a_new_feature (id text primary key, who text)");
    await db.execute("insert into a_new_feature values ('x','patient.family@example.com')");
    db.close();

    await scrubCopy(file);
    const proof = await provePrivate(file);
    assert.equal(proof.ok, false);
    if (!proof.ok) {
      assert.equal(proof.found[0].table, "a_new_feature");
      assert.equal(proof.found[0].column, "who");
      assert.match(proof.found[0].example, /email/);
    }
  });

  test("a prescription number that escaped replacement stops the copy too", async () => {
    const file = await fixture();
    await scrubCopy(file);
    const db = createClient({ url: `file:${file}` });
    // As if a new table had grown its own prescription column that the replacement never visited.
    await db.execute("create table late_table (id text primary key, rx_number text)");
    await db.execute("insert into late_table values ('x','7412589')");
    db.close();

    const proof = await provePrivate(file);
    assert.equal(proof.ok, false);
    if (!proof.ok) assert.match(proof.found[0].example, /prescription number/);
  });
});

test("the fixtures leave nothing behind", () => {
  // Housekeeping, so a test run does not fill the temporary folder with databases of stand-ins.
  for (const f of fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith("scrub-test-"))) {
    fs.rmSync(path.join(os.tmpdir(), f), { force: true });
  }
  assert.ok(true);
});
