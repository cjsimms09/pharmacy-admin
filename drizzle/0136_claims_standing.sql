-- Claims, stage 3 of the rebuild.
--
-- claim_payments.origin: which kind of document a payment was read from ("835:<trace>", "accesshealth:<EFT>",
-- "providerpay-detail:<remit>", ...). The same money reaches this site by more than one road, and on 1 October 2026
-- 752 payments ($27,732.69) stood twice against their claims — once from the 835 and once from a report — so every
-- one of them read as an over-payment. recordClaimPayment now keeps one row per claim, amount, day and source across
-- different kinds of document; the identity index is what it looks them up by.
--
-- claim_decisions: what a person decided about a claim leg (chase it, wait, it was paid elsewhere, write it off,
-- re-bill it, it is settled, it is not ours), keyed by the leg itself so the decision survives the next claims import.
--
-- claim_standing: one row per claim leg in the books, as the engine last computed it — what was expected, what has
-- been paid (each payment once), the plan group's cycle, the state, the adjustment reasons behind a short payment,
-- and the decision in force. Rebuilt whole on every engine pass; never a source of truth.
ALTER TABLE `claim_payments` ADD `origin` text;
--> statement-breakpoint
CREATE INDEX `claim_payments_identity_idx` ON `claim_payments` (`claim_id`,`amount_cents`,`received_on`,`source`);
--> statement-breakpoint
CREATE TABLE `claim_decisions` (
  `id` text PRIMARY KEY NOT NULL,
  `leg_key` text NOT NULL,
  `rx_number` text NOT NULL,
  `fill_number` integer,
  `date_filled` text NOT NULL,
  `bin` text,
  `decision` text NOT NULL,
  `note` text,
  `decided_by` text NOT NULL,
  `decided_at` text NOT NULL,
  `revisit_on` text,
  `resolved_at` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `claim_decisions_leg_idx` ON `claim_decisions` (`leg_key`);
--> statement-breakpoint
CREATE INDEX `claim_decisions_decision_idx` ON `claim_decisions` (`decision`);
--> statement-breakpoint
CREATE TABLE `claim_standing` (
  `claim_id` text PRIMARY KEY NOT NULL,
  `leg_key` text NOT NULL,
  `rx_number` text NOT NULL,
  `fill_number` integer,
  `date_filled` text NOT NULL,
  `sold_on` text,
  `ndc11` text,
  `item_name` text,
  `payer` text NOT NULL,
  `payer_raw` text,
  `bin` text,
  `pcn` text,
  `group_number` text,
  `route` text,
  `programme` integer NOT NULL DEFAULT 0,
  `expected_cents` integer NOT NULL,
  `paid_cents` integer NOT NULL DEFAULT 0,
  `payments` integer NOT NULL DEFAULT 0,
  `first_paid_on` text,
  `last_paid_on` text,
  `facilitator_expected_cents` integer NOT NULL DEFAULT 0,
  `facilitator_paid_cents` integer NOT NULL DEFAULT 0,
  `state` text NOT NULL,
  `age_days` integer NOT NULL,
  `cycle_days` integer,
  `due_on` text,
  `short_cents` integer NOT NULL DEFAULT 0,
  `reasons` text,
  `decision` text,
  `decision_note` text,
  `computed_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `claim_standing_payer_idx` ON `claim_standing` (`payer`);
--> statement-breakpoint
CREATE INDEX `claim_standing_state_idx` ON `claim_standing` (`state`);
--> statement-breakpoint
CREATE INDEX `claim_standing_filled_idx` ON `claim_standing` (`date_filled`);
--> statement-breakpoint
CREATE INDEX `claim_standing_leg_idx` ON `claim_standing` (`leg_key`);
