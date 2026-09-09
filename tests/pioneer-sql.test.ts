import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { parseServer, isReadOnlySelect } from "../src/lib/pioneer-sql";

describe("PioneerRx over SQL", () => {
  test("the server is read as RedSail writes it", () => {
    assert.deepEqual(parseServer("PRXSERVER\\PIONEERRX"), { server: "PRXSERVER", instance: "PIONEERRX", port: null });
    assert.deepEqual(parseServer(" 10.0.0.5,1433 "), { server: "10.0.0.5", instance: null, port: 1433 });
    assert.deepEqual(parseServer("prx.example.net"), { server: "prx.example.net", instance: null, port: null });
  });

  test("only one plain SELECT gets through", () => {
    assert.equal(isReadOnlySelect("select top 5 RxNumber from Rx").ok, true);
    assert.equal(isReadOnlySelect("with x as (select 1 a) select a from x;").ok, true);
    assert.equal(isReadOnlySelect("-- a note\nselect 1").ok, true);
    assert.equal(isReadOnlySelect("delete from Rx").ok, false);
    assert.equal(isReadOnlySelect("select 1; drop table Rx").ok, false);
    assert.equal(isReadOnlySelect("select * into Copy from Rx").ok, false);
    assert.equal(isReadOnlySelect("exec sp_who").ok, false);
    assert.equal(isReadOnlySelect("").ok, false);
  });
});

describe("patient columns are refused before the query is sent", () => {
  test("select * is refused whatever the table", () => {
    assert.equal(isReadOnlySelect("select * from Prescription.Claim").ok, false);
    assert.equal(isReadOnlySelect("select c.* from Prescription.Claim c").ok, false);
    assert.equal(isReadOnlySelect("select top 5 * from Item.Item").ok, false);
  });

  test("counting rows is still allowed", () => {
    assert.equal(isReadOnlySelect("select count(*) from Item.Item").ok, true);
    assert.equal(isReadOnlySelect("select count(*) as n from Prescription.Claim where DateFilled >= '2026-09-01'").ok, true);
  });

  test("a named patient column stops the query", () => {
    // These sit in the same row as Bin, Pcn, GroupNumber and NetworkReimbursementID, which are the
    // whole point of reading Transmission. Neighbours, so the rule is enforced rather than recalled.
    for (const col of ["PatientLastName", "PatientSSN", "PatientDateOfBirth", "CardHolderID", "SentEdi", "SuperString"]) {
      const v = isReadOnlySelect(`select Bin, Pcn, ${col} from Prescription.Transmission`);
      assert.equal(v.ok, false, col);
    }
  });

  test("the columns the payer chain actually needs go through", () => {
    const q = "select Bin, Pcn, GroupNumber, NetworkReimbursementID, PlanID, DateFilled from Prescription.Transmission where DateFilled >= '2026-09-01'";
    assert.equal(isReadOnlySelect(q).ok, true);
  });
});
