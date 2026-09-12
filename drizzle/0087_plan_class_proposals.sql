-- What this plan's class appears to be, and where that came from.
--
-- BACKLOG item 10. Six of 1,054 fills sit on a plan anybody has classified, so the law-first rung
-- in the profit engine — Medicaid pays NADAC plus a fee, the Kansas floor binds or it does not —
-- never fires for 99% of what this pharmacy dispenses. Ninety-odd blank boxes is not a job anyone
-- finishes, so the site offers what it can read and the owner confirms one plan at a time.
--
-- Two columns, and they are deliberately not `classification` itself. A proposal is not a finding:
-- it is stored beside the plan until a person adopts it, and until then nothing downstream may
-- price a claim on it. `classification` stays exactly as it was — "unknown" until somebody says
-- otherwise — so no figure on the site moves because a guess was written into a register.
ALTER TABLE `plan_groups` ADD COLUMN `proposed_classification` text;
--> statement-breakpoint

-- The sentence that produced it, quoting the document it came from: "The BIN listing records this
-- BIN's line of business as 'Medicare Part D'." Stored rather than recomputed, because confirming
-- a proposal is a person adopting a stated reason, and a year later the reason is the only thing
-- that says whether the finding can be defended. A proposal with no source is a guess with a
-- button next to it.
ALTER TABLE `plan_groups` ADD COLUMN `proposed_from` text;
--> statement-breakpoint

CREATE INDEX `plan_groups_proposed_idx` ON `plan_groups` (`proposed_classification`);
