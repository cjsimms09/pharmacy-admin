-- One MAC appeal per claim, enforced by the database rather than only by the code that writes it.
--
-- The owner, of the whole money side of this system: "make sure we are not duplicating!!!!! cant
-- stress this enough". Of appeals specifically: "it also should record once filed so that it doesnt
-- duplicate request or alerts".
--
-- The queue already refuses a claim that has an appeal, by loading the appealed ids and skipping
-- them. That is correct and it is not enough: it holds only while every future caller remembers to
-- pass that set. A second path into this table -- a retry after a portal timeout, two people
-- pressing the button, an automated run overlapping a manual one -- files the claim twice, and the
-- PBM sees a duplicate submission from a pharmacy arguing it was underpaid.
--
-- Partial, on two counts:
--
--   `claim_id IS NOT NULL`, because a floor complaint covers many claims and carries its ids in
--   `claim_ids` instead. Those rows have no single claim and must not collide with each other.
--
--   `kind = 'mac_appeal'`, because a claim can legitimately appear in both a MAC appeal to the PBM
--   and a floor complaint to the Insurance Department. They are different arguments to different
--   people, and neither is a duplicate of the other.
--
-- Withdrawn and lost appeals still occupy the slot, deliberately. Re-filing a claim a PBM has
-- already rejected is how a pharmacy becomes the one whose appeals get ignored; where a genuine
-- re-file is wanted, the old row is the thing to update.
CREATE UNIQUE INDEX `appeals_one_per_claim_idx`
    ON `appeals` (`claim_id`)
 WHERE `claim_id` IS NOT NULL AND `kind` = 'mac_appeal';
