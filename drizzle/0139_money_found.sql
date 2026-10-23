-- The money list, stored by the engine instead of rebuilt on every open of the dashboard, the books and its own
-- page: seventeen seconds and nine hundred megabytes from cold, measured 2 October 2026, on the computer the
-- pharmacy dispenses from. One row per line of money, in rank order, and one row about the run; the ages and the
-- owner's word on each line stay in recommendation_log, which the page reads beside these.
CREATE TABLE `money_found` (
  `key` text PRIMARY KEY NOT NULL,
  `rank` integer NOT NULL,
  `says` text NOT NULL,
  `todo` text NOT NULL,
  `amount_cents` integer NOT NULL,
  `cadence` text NOT NULL,
  `confidence` text NOT NULL,
  `basis` text NOT NULL,
  `href` text NOT NULL,
  `overlaps_with` text,
  `computed_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `money_found_run` (
  `id` text PRIMARY KEY NOT NULL,
  `computed_at` text NOT NULL,
  `computed_on` text NOT NULL,
  `fingerprint` text NOT NULL,
  `rows` integer NOT NULL,
  `blocked` text NOT NULL,
  `watch` text NOT NULL,
  `ms` integer NOT NULL
);
