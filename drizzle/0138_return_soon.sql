-- The return-soon list, stored by the engine instead of rebuilt on every open of the dashboard, the return-soon
-- page and the digest: fifteen seconds and six hundred megabytes from cold, measured 2 October 2026, on the
-- computer the pharmacy dispenses from. One row per line to send back, in rank order, and one row about the run.
CREATE TABLE `return_soon` (
  `key` text PRIMARY KEY NOT NULL,
  `rank` integer NOT NULL,
  `ndc11` text NOT NULL,
  `name` text,
  `on_hand_thousandths` integer NOT NULL,
  `worth_cents` integer,
  `send_back_thousandths` integer NOT NULL,
  `send_back_worth_cents` integer,
  `why` text NOT NULL,
  `reasons` text NOT NULL,
  `deadline_days` integer,
  `supplier` text,
  `invoice_date` text,
  `credit_percent_now` real,
  `drops_to_percent` real,
  `at_risk_cents` integer,
  `urgency` text NOT NULL,
  `says` text NOT NULL,
  `todo` text NOT NULL,
  `computed_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `return_soon_run` (
  `id` text PRIMARY KEY NOT NULL,
  `computed_at` text NOT NULL,
  `computed_on` text NOT NULL,
  `fingerprint` text NOT NULL,
  `rows` integer NOT NULL,
  `totals` text NOT NULL,
  `notes` text NOT NULL,
  `ms` integer NOT NULL
);
