-- Stage 5 of the rebuild retires the old pages, and its gate (docs/REBUILD.md) is "a month with no visit to a
-- retired page". Nothing had ever counted a visit, so the month could not begin. One row per old page per day,
-- counted from a beacon in the old layout; the new screens are not counted, because they are not up for retirement.
CREATE TABLE `page_visits` (
  `day` text NOT NULL,
  `path` text NOT NULL,
  `count` integer NOT NULL DEFAULT 0,
  `last_at` text NOT NULL,
  PRIMARY KEY (`day`, `path`)
);
