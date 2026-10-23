-- Suppliers who publish no catalogue, said once instead of reported for ever.
--
-- The owner: "I NEED AN OPTION ON SUPPLIER OPTIONS TO NOT EXPECT CATALOG!"
--
-- The same fault `no_rebates` was added to fix, in a second place. A supplier with no catalogue reads
-- as "none filed under this supplier" on their card and counts against the catalogue coverage on the
-- health page, for ever, whether or not one is ever coming. Several of his wholesalers simply do not
-- publish a price file — a compounding supplier, a one-line vendor, a co-op that quotes by email —
-- and for those, absence is the answer rather than an outstanding job.
--
-- It changes no arithmetic. Their invoice prices are already read from the invoice itself and their
-- NDCs priced from NADAC. It changes what the site says about them, which is the difference between
-- a list that can be finished and one that cannot.
--
-- Who said so and when, like `no_rebates`, because "nobody has loaded one" and "there is none" are
-- different facts and only the second is somebody's decision.
ALTER TABLE suppliers ADD COLUMN no_catalogue integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE suppliers ADD COLUMN no_catalogue_by text;
--> statement-breakpoint
ALTER TABLE suppliers ADD COLUMN no_catalogue_at text;
