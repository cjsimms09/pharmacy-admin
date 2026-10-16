-- A month's account on each basis, stored by the engine instead of recomputed on every open of the books, the
-- statement, Over time and the dashboard: five seconds a read, four reads a page, measured 2 October 2026 on the
-- computer the pharmacy dispenses from. The account itself, the inputs it was built from (the double-count register
-- reads them), and the fills behind the scripts count, as JSON; one row per month and basis.
CREATE TABLE `month_accounts` (
  `month` text NOT NULL,
  `basis` text NOT NULL,
  `account` text NOT NULL,
  `inputs` text NOT NULL,
  `fills` text NOT NULL,
  `fingerprint` text NOT NULL,
  `computed_on` text NOT NULL,
  `computed_at` text NOT NULL,
  `ms` integer NOT NULL,
  PRIMARY KEY (`month`, `basis`)
);
