-- The NOT NULL half of 0106, which did not take.
--
-- 0106 backfilled the rows and rebuilt the table, but its statements were not separated by the
-- `--> statement-breakpoint` markers this project's migrations use, so only the leading UPDATE ran
-- and the rebuild never happened. The column stayed nullable and three rows stayed unset — which I
-- only found by reading the live table's DDL back rather than trusting that "migrations applied
-- successfully" meant the constraint existed.
--
-- The compiler half is already doing the real work: `routedAs` is `.notNull()` in the schema, and
-- that alone caught nine insert sites across two files, including four in sftp-pull.ts that nothing
-- in this investigation would have led anybody to look at. This is the belt to those braces, for a
-- script that writes to the table without going through Drizzle's types.
UPDATE inbox_items SET routed_as = 'unrecognised' WHERE routed_as IS NULL;
--> statement-breakpoint
CREATE TABLE inbox_items_new (
  id text PRIMARY KEY NOT NULL,
  message_id text NOT NULL,
  received_at text NOT NULL,
  from_address text NOT NULL,
  subject text DEFAULT '' NOT NULL,
  file_name text,
  document_id text,
  status text NOT NULL,
  reason text,
  routed_as text NOT NULL,
  route_result text,
  scanned integer DEFAULT false NOT NULL,
  swept_at text DEFAULT (CURRENT_TIMESTAMP) NOT NULL
);
--> statement-breakpoint
INSERT INTO inbox_items_new (id, message_id, received_at, from_address, subject, file_name, document_id, status, reason, routed_as, route_result, scanned, swept_at)
SELECT id, message_id, received_at, from_address, subject, file_name, document_id, status, reason, routed_as, route_result, scanned, swept_at FROM inbox_items;
--> statement-breakpoint
DROP TABLE inbox_items;
--> statement-breakpoint
ALTER TABLE inbox_items_new RENAME TO inbox_items;
--> statement-breakpoint
CREATE INDEX inbox_message_idx ON inbox_items (message_id);
--> statement-breakpoint
CREATE INDEX inbox_swept_idx ON inbox_items (swept_at);
