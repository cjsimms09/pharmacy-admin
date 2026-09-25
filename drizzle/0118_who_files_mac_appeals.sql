-- Who is allowed to file a MAC appeal, and by when.
--
-- The owner asked to automate MAC appeals, and the first question turned out to be whether he may
-- file them at all: "isnt provider pay doing mac appeals for us". Reading all twenty agreements, the
-- answer differs by payer and several say in terms that the PSAO files and the pharmacy does not.
--
--   Blue Eagle: "PSAO (not the individual pharmacy) will bring the MAC price to PBM's attention"
--   DST/Argus:  "PSAO brings the MAC price to Argus' attention"
--   MC-Rx:      "PBM agrees to review individual MAC appeals made by PSAO"
--   PDMI:       "members of a chain, franchise, PSAO or similar organization must direct appeals to
--                their corporate office or third-party administrator"
--   ESI:        "the PSAO submits a weekly list of generic drugs reimbursed below acquisition cost"
--
-- Filing where the contract routes through the PSAO is at best wasted work and at worst duplicates
-- what AccessHealth already does weekly. So `who_files` is the first gate on any automation, ahead
-- of the window.
--
-- The windows are filled in from the contracts' own words, quoted in `notes`. They were empty for
-- eighteen of twenty rows, and an earlier attempt to recover them by pattern-matching numbers out of
-- the prose produced a wrong answer within minutes: it read "seven (7) business days" out of the ESI
-- clause and called it a filing deadline, when the sentence gives ESI seven days to *respond*. That
-- mistake would have had the site reporting appeals as expiring that were not. Hence these are
-- transcribed by hand, and anything the contract does not state stays null rather than being
-- inferred.
ALTER TABLE `mac_appeal_terms` ADD `who_files` text;
--> statement-breakpoint
CREATE INDEX `mac_appeal_terms_who_files_idx` ON `mac_appeal_terms` (`who_files`);
--> statement-breakpoint

-- ── The pharmacy files directly ──────────────────────────────────────────────

-- "Provider must submit MAC appeals within ten (10) calendar days of the initial claim for
-- reimbursement." The tightest window of any payer here, and it runs from the claim rather than the
-- remittance -- so it closes long before an 835 arrives.
UPDATE `mac_appeal_terms`
   SET `who_files` = 'pharmacy', `appeal_window_days` = 10, `window_basis` = 'initial_claim'
 WHERE `pbm_name` = 'CVS Caremark';
--> statement-breakpoint

-- "Network pharmacies have the right to submit a request to appeal ... within 60 calendar days of
-- the initial claim."
UPDATE `mac_appeal_terms`
   SET `who_files` = 'pharmacy', `appeal_window_days` = 60, `window_basis` = 'initial_claim'
 WHERE `pbm_name` LIKE 'Drexi%';
--> statement-breakpoint

-- A channel is given and no window is stated. Null, not guessed.
UPDATE `mac_appeal_terms`
   SET `who_files` = 'pharmacy'
 WHERE `pbm_name` IN ('Prime', 'Medone', 'Citizens Rx, LLC', 'Citizens Rx/LucyRx (Gateway)');
--> statement-breakpoint

-- "within 12 months from the date of service or sixty (60) calendar days after the payment or denial
-- of a timely claim submission, whichever is later". The longer of the two is the one that governs,
-- and 365 is the floor it can never fall below.
UPDATE `mac_appeal_terms`
   SET `who_files` = 'pharmacy', `appeal_window_days` = 365, `window_basis` = 'date_of_service'
 WHERE `pbm_name` LIKE 'Gainwell%';
--> statement-breakpoint

-- ── The PSAO files, and the pharmacy may not ─────────────────────────────────

UPDATE `mac_appeal_terms`
   SET `who_files` = 'psao'
 WHERE `pbm_name` LIKE 'Blue Eagle%'
    OR `pbm_name` = 'DST/Argus'
    OR `pbm_name` LIKE 'MC-21%';
--> statement-breakpoint

-- PDMI: the pharmacy may appeal only if contracted directly, which this one is not - it is a member
-- of a PSAO. "at least 30 business days after a maximum allowable cost update or after an
-- adjudication" is recorded even so, because the PSAO's deadline is still this pharmacy's deadline
-- to get the claim to them.
UPDATE `mac_appeal_terms`
   SET `who_files` = 'psao', `appeal_window_days` = 42, `window_basis` = 'adjudication'
 WHERE `pbm_name` = 'PDMI';
--> statement-breakpoint

-- ESI accepts either, and separately receives a weekly below-cost list from the PSAO. Filing by hand
-- may therefore duplicate what AccessHealth already sends. The 365 days is the portal's own rule:
-- "Claims must be paid and 365 days old or less."
UPDATE `mac_appeal_terms`
   SET `who_files` = 'either', `appeal_window_days` = 365, `window_basis` = 'date_of_service'
 WHERE `pbm_name` = 'Express Scripts';
--> statement-breakpoint

-- ── No MAC appeal route is stated at all ─────────────────────────────────────
--
-- Not the same as "we have not looked". These agreements were read and give no MAC appeal process:
-- OptumRx routes reimbursement disagreements to arbitration, MedImpact's amendment is silent, and
-- Go Mango's only appeal process is for audits.
UPDATE `mac_appeal_terms`
   SET `who_files` = 'none'
 WHERE `pbm_name` IN ('OptumRx', 'MedImpact')
    OR `pbm_name` LIKE 'Pandia%';
--> statement-breakpoint

-- AssistRx has no MAC list; its analogue is an Acquisition Cost Appeal under section 2.14, and batch
-- appeals are accepted. Payment disputes run 60 calendar days from the payment date.
UPDATE `mac_appeal_terms`
   SET `who_files` = 'pharmacy', `appeal_window_days` = 60, `window_basis` = 'payment_date'
 WHERE `pbm_name` LIKE 'AssistRx%';
