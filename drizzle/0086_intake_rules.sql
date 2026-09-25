-- What the owner has said a sender's mail actually is.
--
-- The inbox guesses what an arriving document is; this is what happens when it guesses wrong.
-- A correction made on the inbox page is kept against the sending address so the same file next
-- Sunday needs no correcting. A rule is either the whole sender, or a sender narrowed by a
-- fragment of the subject or the file name — the narrow form exists because one supplier sends
-- invoices and catalogues from the same address, and a broad rule would file the catalogue as an
-- invoice.
--
-- `category` is text rather than a constrained set on purpose: the list of things the pharmacy
-- receives grows, and a new one should be a row in a table in code, not a migration.
CREATE TABLE `intake_rules` (
	`id` text PRIMARY KEY NOT NULL,
	`address` text NOT NULL,
	`category` text NOT NULL,
	`subject_fragment` text,
	`file_name_fragment` text,
	`was_guessed_as` text,
	`note` text,
	`taught_by` text,
	`taught_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `intake_rules_address_idx` ON `intake_rules` (`address`);
