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
  "nadac/page.tsx",
  "purchasing/page.tsx",
  "reports/page.tsx",
  "remits/mtf/page.tsx",
  "tools/page.tsx",
];

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
