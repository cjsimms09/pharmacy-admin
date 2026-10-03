-- Nine reserved placeholder rows, cleared out of the catalogue.
--
-- Both CMS and the wholesalers park an identifier on a row described "TBD DO NOT DELETE OR
-- RELEASE" before the product behind it exists. The description is an instruction to their own
-- staff, not a drug. NADAC has refused them at import since 8 September, but the refusal was
-- written on the NADAC path and the rows were never there: nadac_prices holds none of them and
-- supplier_items held nine, every one McKesson, every one priced at $110.25 a unit against a pack
-- of one, every one flagged "not rebated" and carrying no availability.
--
-- That combination is why they are worth removing rather than ignoring. A plausible-looking unit
-- cost on an NDC nobody can order has no NADAC to contradict it, and "not rebated" is precisely
-- the flag the buy list reads as a reason to source the item somewhere else.
--
-- Both catalogue importers now refuse them on the way in (isPlaceholderRow, catalogue-check.ts),
-- so this clears what was stored before that test existed. The NADAC line is belt and braces: it
-- should match nothing today, and will keep matching nothing.
delete from supplier_items where description like '%DO NOT DELETE OR RELEASE%';
delete from nadac_prices where description like '%DO NOT DELETE OR RELEASE%';
