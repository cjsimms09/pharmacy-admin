-- The other index from 0099. One statement per file; see 0102 for why.
create index if not exists pioneer_plan_types_source_idx on pioneer_plan_types (source);
