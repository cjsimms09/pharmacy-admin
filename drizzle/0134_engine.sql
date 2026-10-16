-- The engine's tables: what the site works out when data lands and every night, kept so that a screen is a lookup.
--
-- The home page of the old site imports thirty modules and runs their queries on every open. Each is right;
-- together they are a page that recomputes the business every time it is looked at, which is why it is slow and
-- why a fault in any one of them takes the whole page down. docs/REBUILD.md, 1 October 2026: a screen shows only
-- what was computed when the data arrived and proven against its source.
--
-- Five tables, each with one writer (src/lib/engine) and one nightly rebuild:
--
--   needs_you     one line per thing a person must answer, ranked by consequence, with the answers that fit it and
--                 the rows behind it. A line answered never returns; a line the data settles resolves itself.
--   feed_state    every expectation judged (expected.ts), so Today reads a row and not a calendar.
--   proof_run     every nightly proof's result, figures and failing rows — the evidence under every number shown.
--   month_status  the month's bank figures, the receipts-to-bank gap named, accrual revenue, AR, and the close state.
--   engine_run    each pass, what it wrote, how long it took, and any error — so a silent engine is visible.
--
-- Additive. Nothing here is a source of truth: every row can be rebuilt from the ledger, and is, every night.
CREATE TABLE `needs_you` (
  `id` text PRIMARY KEY NOT NULL,
  `kind` text NOT NULL,
  `rank` integer NOT NULL,
  `title` text NOT NULL,
  `detail` text,
  `amount_cents` integer,
  `href` text,
  `answers` text,
  `rows_json` text,
  `first_seen` text NOT NULL,
  `last_seen` text NOT NULL,
  `resolved_at` text,
  `resolved_by` text
);
--> statement-breakpoint
CREATE INDEX `needs_you_open_idx` ON `needs_you` (`resolved_at`, `rank`);
--> statement-breakpoint

CREATE TABLE `feed_state` (
  `key` text PRIMARY KEY NOT NULL,
  `name` text NOT NULL,
  `state` text NOT NULL,
  `cadence` text,
  `last_due` text,
  `next_due` text,
  `last_arrived` text,
  `says` text,
  `judged_at` text NOT NULL
);
--> statement-breakpoint

CREATE TABLE `proof_run` (
  `id` text PRIMARY KEY NOT NULL,
  `proof` text NOT NULL,
  `scope` text,
  `run_at` text NOT NULL,
  `passed` integer NOT NULL,
  `figures` text,
  `says` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `proof_run_latest_idx` ON `proof_run` (`proof`, `scope`, `run_at`);
--> statement-breakpoint

CREATE TABLE `month_status` (
  `month` text PRIMARY KEY NOT NULL,
  `bank_opening_cents` integer,
  `bank_in_cents` integer,
  `bank_out_cents` integer,
  `bank_closing_cents` integer,
  `bank_lines` integer NOT NULL DEFAULT 0,
  `bank_open_lines` integer NOT NULL DEFAULT 0,
  `receipts_cents` integer,
  `receipts_gap_cents` integer,
  `receipts_gap_says` text,
  `accrual_revenue_cents` integer,
  `cash_in_cents` integer,
  `cash_out_cents` integer,
  `ar_unpaid_cents` integer,
  `ar_due_cents` integer,
  `close_state` text NOT NULL DEFAULT 'open',
  `closed_at` text,
  `computed_at` text NOT NULL
);
--> statement-breakpoint

CREATE TABLE `engine_run` (
  `id` text PRIMARY KEY NOT NULL,
  `kind` text NOT NULL,
  `started_at` text NOT NULL,
  `finished_at` text,
  `ms` integer,
  `wrote` text,
  `error` text
);
