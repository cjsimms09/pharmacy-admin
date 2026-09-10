-- PioneerRx's own answer to "what kind of plan is this", read into the site.
--
-- PioneerRx has classified some of these plans for years and nothing here has ever looked. Two
-- separate places hold an answer and they are not the same thing, so both are kept and each row
-- says which it came from:
--
--   'plan_file'  ThirdParty.ThirdPartyPlan — the plan reference PioneerRx ships, 1,851 rows of
--                BIN/PCN with a plan name, a processor and a type. Nobody at this pharmacy typed
--                it, so it is the stronger of the two.
--   'pharmacy'   ThirdParty.ThirdParty — the pharmacy's own third-party records, 286 of them, with
--                whatever plan type somebody here set when the payer was first billed.
--
-- Kept as a landing table rather than folded into plan_groups on the way in. The register holds
-- findings a person made; this holds what another system says, unaltered, so the two can never be
-- confused and so a wrong reading can be re-read without losing anybody's decision.
--
-- No patient column is or can be here: src/lib/pioneer-sql.ts refuses a query that names one.
create table if not exists pioneer_plan_types (
  id text primary key,
  bin text not null,
  -- Empty string rather than null, because a plan file row with no PCN stands for the whole BIN and
  -- '' compares where null does not.
  pcn text not null default '',
  source text not null,
  plan_name text,
  processor text,
  carrier_code text,
  -- PioneerRx's word for the type, stored exactly as it prints it: 'Part D', 'Standard',
  -- 'Medicaid', "Worker's Comp", 'Government', 'Cash/AR', 'Medicare Part B', 'Documentary'.
  -- Not translated on the way in. 'Standard' is PioneerRx's default and means nobody answered;
  -- src/lib/plan-evidence.ts is where that is decided, once, with the reasoning beside it.
  plan_type text,
  is_active integer not null default 1,
  read_at text not null
);

create index if not exists pioneer_plan_types_key_idx on pioneer_plan_types (bin, pcn);
create index if not exists pioneer_plan_types_source_idx on pioneer_plan_types (source);
