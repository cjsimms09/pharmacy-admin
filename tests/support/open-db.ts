/* Run by live-db-guard.test.ts in a child process: opens the database module and says whether it was allowed to. */
import("../../src/db").then(
  () => {
    console.log("OPENED");
    process.exit(0);
  },
  (e) => {
    console.log("STOPPED: " + (e instanceof Error ? e.message : String(e)));
    process.exit(0);
  },
);
