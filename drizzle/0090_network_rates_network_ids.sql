-- The network reimbursement ids a rate is written for.
--
-- A claim carries one (NCPDP 545-2F); a contract almost never prints one; the PSAO's networks guide
-- prints a crosswalk from id to network. With the id on the rate line, a claim finds its rate by the
-- most specific thing it carries, and "which of Optum's ten networks" ends where the guide ends it.
-- Comma-separated, like bins and group_ids beside it. Null where no document says.
ALTER TABLE `network_rates` ADD COLUMN `network_ids` text;
