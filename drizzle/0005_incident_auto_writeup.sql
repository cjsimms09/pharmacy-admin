ALTER TABLE `cqi_incidents` ADD `ai_state` text DEFAULT 'idle' NOT NULL;--> statement-breakpoint
ALTER TABLE `cqi_incidents` ADD `ai_error` text;--> statement-breakpoint
ALTER TABLE `cqi_incidents` ADD `supersedes_incident_id` text;