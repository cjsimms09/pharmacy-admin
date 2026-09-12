import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

/**
 * The switched-off area has to be genuinely unreachable, not merely unlinked. A page that still
 * renders when its menu item is gone is worse than one that is visible: it is findable by
 * anyone who bookmarked it, and it looks like part of the daily site again the moment they do.
 */
const PAGES = [
  "payers/page.tsx",
  "payers/[pbm]/page.tsx",
  "claims/page.tsx",
  "plans/page.tsx",
  "purchasing/page.tsx",
  "reports/page.tsx",
  "remits/mtf/page.tsx",
  "payers/sort/page.tsx",
  "purchasing/minimums/page.tsx",
  "purchasing/replay/page.tsx",
  "claims/appeals/page.tsx",
  "payers/routing/page.tsx",
];

/*
 * NADAC is the exception, and the reason is worth stating so nobody "fixes" it back.
 *
 * The weekly collection runs whether or not the reimbursement pages are switched on, because each
 * CMS file carries only the prices in force that week and a month not collected cannot be fetched
 * afterwards at any price. That makes NADAC the one job here whose failure is unrecoverable by
 * noticing later — so it alerts when it goes quiet, and the page that diagnoses and restarts it
 * has to be reachable when that alert is followed. Guarding it made the alert point at a redirect.
 */
const UNGUARDED = ["nadac/page.tsx"];

describe("the one page that stays reachable, and why", () => {
  for (const p of UNGUARDED) {
    test(`${p} is reachable with the area switched off`, () => {
      const src = fs.readFileSync(path.join("src/app/(app)", p), "utf8");
      assert.ok(
        !src.includes("requireReimbursement"),
        `${p} is guarded, so the alert telling somebody their price history has stopped points at a redirect`,
      );
      assert.ok(src.includes("requireUser"), `${p} must still require a signed-in user`);
    });
  }
});

describe("the reimbursement area is guarded, not just unlinked", () => {
  for (const p of PAGES) {
    test(`${p} redirects when the area is off`, () => {
      const src = fs.readFileSync(path.join("src/app/(app)", p), "utf8");
      assert.ok(src.includes("requireReimbursement"), `${p} has no guard`);
      // The guard must run before anything renders or any data is read.
      const guard = src.indexOf("await requireReimbursement()");
      const ret = src.indexOf("return (");
      assert.ok(guard > 0 && (ret < 0 || guard < ret), `${p} guards too late`);
    });
  }
});

describe("compliance pages are never guarded", () => {
  for (const p of ["compliance/page.tsx", "compliance/training/page.tsx", "compliance/register/page.tsx", "page.tsx"]) {
    test(`${p} stays reachable`, () => {
      const src = fs.readFileSync(path.join("src/app/(app)", p), "utf8");
      assert.ok(!src.includes("requireReimbursement"), `${p} must not be behind the switch`);
    });
  }
});
