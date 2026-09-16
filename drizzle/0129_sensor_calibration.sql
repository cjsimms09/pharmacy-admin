-- The data logger's calibration, held rather than remembered.
--
-- The annual vaccine storage obligation asks the pharmacist-in-charge to attest that "the data
-- logger is within its calibration period". Nothing in this system held a calibration certificate,
-- an expiry, or even the make of the logger: 0 documents and 0 settings mentioned calibration on
-- 16 September 2026, while the attestation had been on the list since it was written. So the
-- statement rested on somebody's memory of a certificate in a drawer, which is precisely the kind
-- of sentence an inspector asks to see behind.
--
-- The CDC toolkit and the VFC programme both want a certified logger with a current, traceable
-- certificate, re-certified on the interval the certificate itself names. That interval is the
-- fact worth holding: it is what turns "I believe it is in calibration" into a date the site can
-- check, warn about before it lapses, and produce the certificate for.
--
-- Nothing here decides whether the logger is good. It records what the certificate says, and the
-- certificate is filed as a document like any other.
ALTER TABLE `temp_sensors` ADD COLUMN `model` text;
--> statement-breakpoint
ALTER TABLE `temp_sensors` ADD COLUMN `serial` text;
--> statement-breakpoint
ALTER TABLE `temp_sensors` ADD COLUMN `calibrated_on` text;
--> statement-breakpoint
ALTER TABLE `temp_sensors` ADD COLUMN `calibration_expires_on` text;
--> statement-breakpoint
ALTER TABLE `temp_sensors` ADD COLUMN `calibration_document_id` text;
