-- What the owner said about a finding on Today's morning check: "this is wrong", or "this is settled".
--
-- On 6 October 2026 five of the morning's alarms were wrong, and the card had no way to be told so: it was put right only when
-- somebody noticed and changed the code. A press on the card is that way, and it has to outlive the next import, because every
-- finding is rebuilt from the data each time Today opens.
--
-- One row per press. A row is never deleted: the count of "wrong" rows is the measure of how many alarms he had to tell the site
-- about, and a mark that vanished when it was put back would make that count lie. It covers one finding as it stood: `fingerprint`
-- is the finding itself, the things it found and where each stands (a clock only as whole days or 30-day steps of age), so the alarm
-- returns the moment what it found changes. `ended_at` says when a mark stopped applying and `ended_how` why ("put back" by him,
-- "passed" because the check came right, "changed" because the finding did, "replaced" by a later press). `answered_at` and `answer`
-- are for whoever fixes the check, so a wrong alarm is open until somebody has said what was done about it.
--
-- The unique index holds one standing mark per finding and verdict, so a double click or a page sent twice is refused here and not
-- counted twice; a mark that has ended is outside it, so pressing again later is a new press.
--
-- Additive. The morning check reads it each time it runs. Until it is applied no marks are read (every failing line is shown), the
-- card says the count of presses is not measured, and a press fails.
CREATE TABLE `check_marks` (
	`id` text PRIMARY KEY NOT NULL,
	`check_key` text NOT NULL,
	`fingerprint` text NOT NULL,
	`verdict` text NOT NULL,
	`what` text NOT NULL,
	`observed` text NOT NULL,
	`note` text,
	`marked_by` text NOT NULL,
	`marked_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`ended_at` text,
	`ended_how` text,
	`ended_by` text,
	`answered_at` text,
	`answer` text
);
--> statement-breakpoint
CREATE INDEX `check_marks_key_idx` ON `check_marks` (`check_key`,`ended_at`);
--> statement-breakpoint
CREATE UNIQUE INDEX `check_marks_one_standing_idx` ON `check_marks` (`check_key`,`fingerprint`,`verdict`) WHERE `ended_at` IS NULL;
