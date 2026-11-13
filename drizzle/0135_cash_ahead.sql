-- Cash ahead: what leaves and reaches the bank over the next four weeks, by day, projected from what the site holds.
--
-- The owner, 1 October 2026, on a month whose accrual was positive and whose cash fell: "should I be worried?" The
-- answer lived in the timing — McKesson draws the week after billing, payers pay in two to four weeks, the Wegovy
-- programme in eight — and nothing on any screen showed it ahead of the day it happened. This table does: one row
-- per day from the last proven bank balance forward, the inflows and outflows the engine can see coming, the
-- balance they leave, and the items behind each day. Rebuilt whole on every engine pass; never a source of truth.
CREATE TABLE `cash_ahead` (
  `day` text PRIMARY KEY NOT NULL,
  `inflow_cents` integer NOT NULL DEFAULT 0,
  `outflow_cents` integer NOT NULL DEFAULT 0,
  `balance_cents` integer NOT NULL,
  `items` text,
  `basis` text,
  `computed_at` text NOT NULL
);
