-- Three McKesson ladders that never said which ratio measures them, and so never paid.
--
-- Measured on the pharmacy computer, 7 September. The daily purchase report was on file (scrubbed
-- generic compliance 20.32%, generic share 79.8%), all three of McKesson's programmes were in force,
-- and the OneStop ladder's bottom tier pays 15% at a threshold of zero — yet the site computed no
-- rebate rate for McKesson at all, compared 7,165 contract generics at their printed price, and
-- told the drug file "the band it lands in pays nothing on contract generics today."
--
-- The cause is one field. rebate-view.ts selects the figure that drives a ladder from
-- terms.ratioMeasure ("generic_compliance" or "generic_purchase_ratio"), and every stored programme
-- has it null, so no ladder could ever land on a band. The programmes are not silent about the
-- measure: each one's ratioDefinition, written by the owner, says in words which figure it is —
-- "the scrubbed generic compliance rate McKesson prints on the monthly rebate breakdown", "the
-- generic purchase ratio McKesson prints on the monthly rebate breakdown", "the same scrubbed
-- generic compliance rate that sets the generic rebate". So this reads the definition that is
-- already there rather than inferring anything from eligibility, and touches only rows whose
-- definition names one measure and whose field is empty. At 20.32% the OneStop ladder pays 29%
-- and the GPR ladder pays 1%: the site has been overstating what McKesson's contract generics cost
-- by about thirty per cent in every comparison that decides which wholesaler to buy from.
update supplier_rebate_programs
   set terms_json = json_set(terms_json, '$.ratioMeasure', 'generic_compliance')
 where json_extract(terms_json, '$.ratioMeasure') is null
   and lower(json_extract(terms_json, '$.ratioDefinition')) like '%compliance%'
   and lower(json_extract(terms_json, '$.ratioDefinition')) not like '%generic purchase ratio%';
--> statement-breakpoint
update supplier_rebate_programs
   set terms_json = json_set(terms_json, '$.ratioMeasure', 'generic_purchase_ratio')
 where json_extract(terms_json, '$.ratioMeasure') is null
   and lower(json_extract(terms_json, '$.ratioDefinition')) like '%generic purchase ratio%'
   and lower(json_extract(terms_json, '$.ratioDefinition')) not like '%compliance%';
