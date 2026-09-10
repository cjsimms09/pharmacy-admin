-- Where a proposal came from, and how well that source settles it.
--
-- A proposal already carried the sentence it was read from. It did not carry which source produced
-- that sentence or how good the source is, so a Part D plan named "Bc/bs Kansas Pdp" in PioneerRx's
-- own plan file and a Part D read out of four letters of a PCN were stored identically and shown
-- identically. Telling a fact from a guess is the entire job of this table, and the register's own
-- proposals had quietly stopped doing it.
--
--   proposed_source     — pioneer_plan_file | pioneer_pharmacy | pcn | bin_listing | payer_name
--   proposed_confidence — "stated" where a record says it in words, "indicated" where a code or a
--                         listing points at it hard enough to be worth offering
--
-- See EvidenceSource and Confidence in src/lib/plan-evidence.ts, which is where both are decided.
--
-- Its own migration rather than part of 0099: 0099 had already been applied when these columns were
-- wanted, and drizzle records a migration by its `when` timestamp, so that slot is spent whatever
-- the file now says.
alter table plan_groups add column proposed_source text;
alter table plan_groups add column proposed_confidence text;
