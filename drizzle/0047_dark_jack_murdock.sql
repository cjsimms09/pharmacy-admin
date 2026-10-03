-- Any duplicate (ndc11, effective_on) pairs would make the unique index impossible to build.
-- The loader has always de-duplicated before inserting, so this should delete nothing; it is here
-- so that the migration cannot fail on a database where it once did not.
DELETE FROM `nadac_prices` WHERE `id` NOT IN (SELECT MIN(`id`) FROM `nadac_prices` GROUP BY `ndc11`, `effective_on`);--> statement-breakpoint
DROP INDEX `nadac_ndc_eff_idx`;--> statement-breakpoint
CREATE UNIQUE INDEX `nadac_ndc_eff_idx` ON `nadac_prices` (`ndc11`,`effective_on`);