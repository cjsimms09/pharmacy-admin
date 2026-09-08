-- The invoice lines are read by date range on every books page, every dashboard and every report,
-- and there was no index on the column they are ranged over: a full scan of the table each time.
--
-- Measured on a scratch database at a year's scale for this pharmacy (45,782 lines, six suppliers),
-- the index is the smaller half of that fix — about a fifth off a month's read, where reading the
-- month once instead of once per supplier is eleven times. It is here because the table only grows:
-- a scan that costs a fifth extra today is the whole cost once there are three years in it.
CREATE INDEX IF NOT EXISTS `invoice_lines_date_idx` ON `invoice_lines` (`invoice_date`);
