CREATE TABLE `mac_appeal_terms` (
	`id` text PRIMARY KEY NOT NULL,
	`pbm_name` text NOT NULL,
	`source_label` text NOT NULL,
	`submission_channel` text,
	`submission_target` text,
	`appeal_window_days` integer,
	`window_basis` text,
	`required_fields` text,
	`invoice_required` text,
	`response_sla_days` integer,
	`adjustment_retroactive` text,
	`escalation_contact` text,
	`notes` text,
	`source_url` text,
	`loaded_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `mac_appeal_terms_pbm_idx` ON `mac_appeal_terms` (`pbm_name`);--> statement-breakpoint
CREATE TABLE `network_rates` (
	`id` text PRIMARY KEY NOT NULL,
	`pbm_name` text NOT NULL,
	`source_label` text NOT NULL,
	`line_of_business` text NOT NULL,
	`network` text NOT NULL,
	`effective_date` text,
	`status` text,
	`days_supply` text,
	`brand_rate` text,
	`generic_rate` text,
	`ber_guardrail` text,
	`ger_guardrail` text,
	`notes` text,
	`source_url` text,
	`loaded_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `network_rates_pbm_idx` ON `network_rates` (`pbm_name`);--> statement-breakpoint
CREATE INDEX `network_rates_lob_idx` ON `network_rates` (`line_of_business`);--> statement-breakpoint
CREATE TABLE `payment_routing` (
	`id` text PRIMARY KEY NOT NULL,
	`pbm_name` text NOT NULL,
	`source_label` text NOT NULL,
	`pays_via` text,
	`payment_method` text,
	`remittance_source` text,
	`payment_cycle` text,
	`on_contract_listing` text,
	`notes` text,
	`source_url` text,
	`loaded_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `payment_routing_pbm_idx` ON `payment_routing` (`pbm_name`);--> statement-breakpoint
CREATE TABLE `pbm_communications` (
	`id` text PRIMARY KEY NOT NULL,
	`pbm_name` text,
	`source_label` text,
	`published_date` text NOT NULL,
	`subject` text NOT NULL,
	`type` text,
	`url` text,
	`source_url` text,
	`loaded_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `pbm_communications_date_idx` ON `pbm_communications` (`published_date`);--> statement-breakpoint
CREATE INDEX `pbm_communications_pbm_idx` ON `pbm_communications` (`pbm_name`);--> statement-breakpoint
CREATE TABLE `pbm_contacts` (
	`id` text PRIMARY KEY NOT NULL,
	`pbm_name` text NOT NULL,
	`source_label` text NOT NULL,
	`contact_type` text NOT NULL,
	`phone` text,
	`email` text,
	`portal_url` text,
	`notes` text,
	`source_url` text,
	`loaded_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `pbm_contacts_pbm_idx` ON `pbm_contacts` (`pbm_name`);