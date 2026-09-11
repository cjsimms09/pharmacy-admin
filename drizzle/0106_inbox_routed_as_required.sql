-- Every arrival must say what was done with it. Silence is not an answer.
--
-- `inbox_items.routed_as` was nullable, and the inbox reads an empty one as "not recognised". So an
-- insert that simply forgot to set it turned a success into a failure on the owner's screen — and it
-- has now done that three separate times, in one file, to three different kinds of arrival:
--
--   * handled training replies, where seven attestations had been closed and the reply filed;
--   * seven McKesson invoices read, classified and filed at 03:40, which he saw as "file not
--     recognized" and reported as the feed being broken;
--   * postage receipts deliberately passed over, which is a decision and not a failure to understand.
--
-- Each time the fix was to set the field at that one call site. There are ten inserts in mailbox.ts
-- and seven of them set it, which is exactly the shape of a rule nobody can enforce by remembering.
--
-- The owner, on the third occurrence: "if you fixed it, why did it happen again?"
--
-- Because a nullable column asks politely. This one stops asking: NOT NULL with no default, so an
-- insert that does not say what happened to an arrival fails to compile rather than lying about it.
-- "unrecognised" stays a perfectly good value — it means the reader looked and could not place it,
-- which is a real outcome and quite different from nobody having said.
--
-- The rows already on disk are answered from what their own `reason` records, which said all along
-- what had actually happened to them.
UPDATE inbox_items SET routed_as = 'invoice'
 WHERE routed_as IS NULL AND reason LIKE 'Supplier invoice,%';

UPDATE inbox_items SET routed_as = 'training_reply'
 WHERE routed_as IS NULL AND reason LIKE '%replied about their%';

UPDATE inbox_items SET routed_as = 'not_for_filing'
 WHERE routed_as IS NULL
   AND (reason LIKE 'No attachment on this message%'
     OR reason LIKE 'No report attachment%'
     OR reason LIKE 'Nothing on this message was a type this reads%'
     OR reason LIKE 'Sender is not on the allowed list%');

UPDATE inbox_items SET routed_as = 'unrecognised' WHERE routed_as IS NULL;

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

INSERT INTO inbox_items_new (id, message_id, received_at, from_address, subject, file_name, document_id, status, reason, routed_as, route_result, scanned, swept_at)
SELECT id, message_id, received_at, from_address, subject, file_name, document_id, status, reason, routed_as, route_result, scanned, swept_at FROM inbox_items;

DROP TABLE inbox_items;
ALTER TABLE inbox_items_new RENAME TO inbox_items;
CREATE INDEX inbox_message_idx ON inbox_items (message_id);
CREATE INDEX inbox_swept_idx ON inbox_items (swept_at);
