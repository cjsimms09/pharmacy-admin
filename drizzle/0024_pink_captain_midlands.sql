ALTER TABLE `training_assignments` ADD `quiz_correct` integer;--> statement-breakpoint
ALTER TABLE `training_assignments` ADD `quiz_total` integer;--> statement-breakpoint
ALTER TABLE `training_assignments` ADD `live_questions_acknowledged` integer DEFAULT false NOT NULL;