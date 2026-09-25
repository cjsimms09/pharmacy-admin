-- What each arrival was actually done with, recovered from what its own reason already said.
--
-- `inbox_items.routed_as` was nullable and the inbox reads an empty one as "not recognised", so a
-- sweep that filed something perfectly well but forgot to set the field turned its own success into
-- a failure on the owner's screen. It did that three times, in one file, to three kinds of arrival:
-- handled training replies, seven McKesson invoices filed at 03:40, and postage receipts
-- deliberately passed over.
--
-- Each row's `reason` said all along what had really happened to it. These read it back.
UPDATE inbox_items SET routed_as = 'invoice'
 WHERE routed_as IS NULL AND reason LIKE 'Supplier invoice,%';
--> statement-breakpoint
UPDATE inbox_items SET routed_as = 'training_reply'
 WHERE routed_as IS NULL AND reason LIKE '%replied about their%';
--> statement-breakpoint
UPDATE inbox_items SET routed_as = 'not_for_filing'
 WHERE routed_as IS NULL
   AND (reason LIKE 'No attachment on this message%'
     OR reason LIKE 'No report attachment%'
     OR reason LIKE 'Nothing on this message was a type this reads%'
     OR reason LIKE 'Sender is not on the allowed list%');
--> statement-breakpoint
UPDATE inbox_items SET routed_as = 'unrecognised' WHERE routed_as IS NULL;
