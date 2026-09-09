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
    assert.equal(isReadOnlySelect("select top 5 * from Rx").ok, true);
    assert.equal(isReadOnlySelect("with x as (select 1 a) select * from x;").ok, true);
    assert.equal(isReadOnlySelect("-- a note\nselect 1").ok, true);
    assert.equal(isReadOnlySelect("delete from Rx").ok, false);
    assert.equal(isReadOnlySelect("select 1; drop table Rx").ok, false);
    assert.equal(isReadOnlySelect("select * into Copy from Rx").ok, false);
    assert.equal(isReadOnlySelect("exec sp_who").ok, false);
    assert.equal(isReadOnlySelect("").ok, false);
  });
});
