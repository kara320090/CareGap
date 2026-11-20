CREATE TABLE `facilities` (
	`source` text NOT NULL,
	`run_id` text NOT NULL,
	`id` text NOT NULL,
	`province` text NOT NULL,
	`district` text NOT NULL,
	`latitude` real,
	`longitude` real,
	`payload` text NOT NULL,
	PRIMARY KEY(`source`, `run_id`, `id`)
);
--> statement-breakpoint
CREATE INDEX `facilities_location` ON `facilities` (`province`,`district`);--> statement-breakpoint
CREATE TABLE `regions` (
	`id` text PRIMARY KEY NOT NULL,
	`province` text NOT NULL,
	`district` text NOT NULL,
	`source_date` text NOT NULL,
	`payload` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `service_facility_relations` (
	`source` text NOT NULL,
	`run_id` text NOT NULL,
	`service_id` text NOT NULL,
	`facility_id` text NOT NULL,
	`role` text NOT NULL,
	`evidence_url` text NOT NULL,
	`checked_on` text NOT NULL,
	PRIMARY KEY(`source`, `run_id`, `service_id`, `facility_id`)
);
--> statement-breakpoint
CREATE TABLE `services` (
	`source` text NOT NULL,
	`run_id` text NOT NULL,
	`id` text NOT NULL,
	`scope` text NOT NULL,
	`province` text NOT NULL,
	`district` text NOT NULL,
	`payload` text NOT NULL,
	PRIMARY KEY(`source`, `run_id`, `id`)
);
--> statement-breakpoint
CREATE INDEX `services_location` ON `services` (`province`,`district`);--> statement-breakpoint
CREATE TABLE `source_state` (
	`source` text PRIMARY KEY NOT NULL,
	`active_run_id` text,
	`status` text NOT NULL,
	`last_success` text,
	`last_error` text,
	`metadata` text NOT NULL,
	`lease_owner` text,
	`lease_until` text
);
--> statement-breakpoint
CREATE TABLE `sync_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`source` text NOT NULL,
	`status` text NOT NULL,
	`checkpoint` text NOT NULL,
	`total` integer,
	`processed` integer NOT NULL,
	`started_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`finished_at` text,
	`error` text
);
--> statement-breakpoint
CREATE INDEX `sync_runs_source` ON `sync_runs` (`source`,`status`);