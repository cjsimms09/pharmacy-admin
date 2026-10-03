-- What the site last measured about its own data.
--
-- BACKLOG item 9. Every figure on this site is defined only on the rows that linked: a margin
-- exists for a fill whose NDC found a catalogue row with a pack size, a reimbursement formula for
-- a claim that matched a contract. Where the link fails the figure is not wrong, it is absent, and
-- an absent figure looks exactly like a good month.
--
-- Held in a table rather than recomputed on view, and that is not a cache for speed alone. Every
-- libsql call blocks the Node event loop — 200,000 rows is 1.7 seconds during which the web server
-- answers nothing — so a page that recounted on every view would take the site down while telling
-- somebody how healthy it is. Counting is an explicit act; the page reads what was counted.
--
-- One row per measurement key, replaced each time it is measured. The keys are defined in
-- data-health.ts (SPECS) and a row whose key is not there is ignored rather than guessed at.
CREATE TABLE `data_health_counts` (
  `key` text PRIMARY KEY NOT NULL,
  -- How many linked, and how many there were to link. Kept as two numbers rather than a
  -- percentage: the percentage is how a row is scanned, the count is what somebody acts on, and a
  -- stored percentage could not be re-derived into "29 NDCs to chase".
  `numerator` integer NOT NULL,
  `denominator` integer NOT NULL,
  -- The worst gaps, already in words, one per line. "29 dispensed NDCs have no NADAC — 2 are
  -- devices, 27 are repackager labels".
  `gaps` text DEFAULT '' NOT NULL,
  -- Why the figure is what it is, where the number alone would send somebody the wrong way. A
  -- measured zero nearly always needs one: 0 of 1,081 claims match a contract because the matcher
  -- reads BIN, PCN and group while the contracts name networks and chain codes, which is a
  -- different problem, and a different fix, from "nobody has filed a contract".
  `note` text,
  -- When this count was taken. NOT NULL because a row only exists once it has been measured:
  -- "never measured" is the absence of the row, never a row with a null date, so that a
  -- measurement nobody took can never be read as a measurement of zero.
  `measured_at` text NOT NULL,
  -- How long the count took, so a measurement that is becoming expensive says so before it starts
  -- blocking the site for a noticeable time.
  `took_ms` integer
);
--> statement-breakpoint

CREATE INDEX `data_health_counts_measured_idx` ON `data_health_counts` (`measured_at`);
