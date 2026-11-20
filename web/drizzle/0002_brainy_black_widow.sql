CREATE TABLE `facility_geocodes` (
	`address` text PRIMARY KEY NOT NULL,
	`query` text NOT NULL,
	`status` text NOT NULL,
	`latitude` real,
	`longitude` real,
	`checked_at` text NOT NULL,
	`reason` text,
	`source_url` text NOT NULL
);
