CREATE INDEX `claim_payments_received_idx` ON `claim_payments` (`received_on`);--> statement-breakpoint
CREATE INDEX `claims_paid_ndc_date_idx` ON `claims` (`status`,`ndc11`,`date_filled`);