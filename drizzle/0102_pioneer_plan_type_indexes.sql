-- One of the two indexes 0099 asked for and did not get.
--
-- Drizzle's libsql migrator here runs ONE statement per file, `--> statement-breakpoint` markers
-- notwithstanding: everything after the first statement is dropped with no error at all. 0099
-- created pioneer_plan_types and lost both its indexes that way, and 0100 lost proposed_confidence.
-- Neither slot can be reused, because drizzle records an applied migration by its `when` timestamp
-- and a slot that has ever run is spent whatever the file now says.
--
-- So: one statement per migration file in this repository, and the second index is 0103.
create index if not exists pioneer_plan_types_key_idx on pioneer_plan_types (bin, pcn);
