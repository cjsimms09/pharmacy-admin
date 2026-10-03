-- How well the source settles it: the other half of 0100.
--
-- "stated" where a record says it in words — a plan the payer's own payer sheet names as commercial,
-- a contract CMS lists as Part D. "indicated" where a code or a listing points at it hard enough to
-- be worth offering but the document itself has not been read. Nothing weaker is ever offered.
--
-- See Confidence in src/lib/plan-evidence.ts.
alter table plan_groups add column proposed_confidence text;
