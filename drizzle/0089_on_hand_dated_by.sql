-- Where the count's date came from.
--
-- A shelf the report dated itself and a shelf somebody typed a date onto are different claims. The
-- Drug File Print carries no count date in its head, only the print date in its page footer; a
-- pharmacist can type the day instead, and either way the page said "counted on 8 September" with
-- nothing to say which. One of: typed, labelled (a line naming the count date), head (a bare date at
-- the top of the report), footer (the print date). Null on imports filed before this column existed.
ALTER TABLE `on_hand_imports` ADD COLUMN `dated_by` text;
