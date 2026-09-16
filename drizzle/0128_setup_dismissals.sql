-- The answer the setup list never had: "this does not apply to me".
--
-- The owner, 16 September 2026, pasting forty-five of them: "these are all irrelevant, i dont have
-- them or they arent relevant, need system to leave me alone about them".
--
-- Every item on that list says "something is wrong until this is done" and there was no third
-- answer — only do it, or read it again tomorrow. A list that cannot be told it is wrong only
-- grows, and the cost is not the noise: it is that he stops reading the list, and the items that
-- genuinely stop something go unread with the rest.
--
-- So an item can be set aside, with a reason, by name, and put back. It is recorded rather than
-- hidden: the page shows the count and every one of them is one press from returning. Keyed by the
-- item's own key, so it survives the next import — which is the whole point, because the item is
-- rebuilt from the data every time the page is opened.
CREATE TABLE `setup_dismissals` (
	`key` text PRIMARY KEY NOT NULL,
	`reason` text,
	`dismissed_by` text NOT NULL,
	`dismissed_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL
);
