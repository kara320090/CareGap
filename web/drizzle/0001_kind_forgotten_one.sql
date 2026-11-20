CREATE TABLE `facility_entries` (
	`source` text NOT NULL,
	`run_id` text NOT NULL,
	`id` text NOT NULL,
	`identity` text NOT NULL,
	`province` text NOT NULL,
	`district` text NOT NULL,
	`name` text NOT NULL,
	`address` text NOT NULL,
	`kind` text NOT NULL,
	`role` text NOT NULL,
	`priority` integer NOT NULL,
	`phone` text,
	`evidence_url` text,
	`latitude` real,
	`longitude` real,
	PRIMARY KEY(`source`, `run_id`, `id`)
);
--> statement-breakpoint
CREATE INDEX `facility_entries_region` ON `facility_entries` (`province`,`district`);--> statement-breakpoint
CREATE INDEX `facility_entries_identity` ON `facility_entries` (`identity`,`priority`,`source`,`id`);