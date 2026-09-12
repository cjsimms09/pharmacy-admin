-- Two facts the readers already had and the tables threw away.
--
-- The on-hand report prints its own record count ("Total Record Count:,1772"); the reader parses it
-- and the import row never kept it, so the strongest check the on-hand family has reached no column.
-- Kept now: stored plus skipped against this number is the nightly proof (SESSION-RULES §1c).
ALTER TABLE `on_hand_imports` ADD COLUMN `reported_count` integer;
--> statement-breakpoint
-- A catalogue import records the document it was read from, so the nightly re-read can open the
-- same file instead of rediscovering it through the inbox by name. Null for imports before this.
ALTER TABLE `supplier_imports` ADD COLUMN `document_id` text;
