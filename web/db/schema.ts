import { sqliteTable, text, integer, real, primaryKey, index } from 'drizzle-orm/sqlite-core';

export const regions = sqliteTable('regions', {
  id: text('id').primaryKey(), province: text('province').notNull(), district: text('district').notNull(),
  sourceDate: text('source_date').notNull(), payload: text('payload').notNull(),
});
export const services = sqliteTable('services', {
  source: text('source').notNull(), runId: text('run_id').notNull(), id: text('id').notNull(),
  scope: text('scope').notNull(), province: text('province').notNull(), district: text('district').notNull(),
  payload: text('payload').notNull(),
},t=>[primaryKey({columns:[t.source,t.runId,t.id]}),index('services_location').on(t.province,t.district)]);
export const facilities = sqliteTable('facilities', {
  source: text('source').notNull(), runId: text('run_id').notNull(), id: text('id').notNull(),
  province: text('province').notNull(), district: text('district').notNull(),
  latitude: real('latitude'), longitude: real('longitude'), payload: text('payload').notNull(),
},t=>[primaryKey({columns:[t.source,t.runId,t.id]}),index('facilities_location').on(t.province,t.district)]);
export const relations = sqliteTable('service_facility_relations', {
  source: text('source').notNull(), runId: text('run_id').notNull(), serviceId: text('service_id').notNull(),
  facilityId: text('facility_id').notNull(), role: text('role').notNull(), evidenceUrl: text('evidence_url').notNull(),
  checkedOn: text('checked_on').notNull(),
},t=>[primaryKey({columns:[t.source,t.runId,t.serviceId,t.facilityId]})]);

export const facilityEntries=sqliteTable('facility_entries',{
  source:text('source').notNull(),runId:text('run_id').notNull(),id:text('id').notNull(),identity:text('identity').notNull(),
  province:text('province').notNull(),district:text('district').notNull(),name:text('name').notNull(),address:text('address').notNull(),kind:text('kind').notNull(),
  role:text('role').notNull(),priority:integer('priority').notNull(),phone:text('phone'),evidenceUrl:text('evidence_url'),latitude:real('latitude'),longitude:real('longitude'),
},t=>[primaryKey({columns:[t.source,t.runId,t.id]}),index('facility_entries_region').on(t.province,t.district),index('facility_entries_identity').on(t.identity,t.priority,t.source,t.id)]);
export const syncRuns = sqliteTable('sync_runs', {
  id: text('id').primaryKey(), source: text('source').notNull(), status: text('status').notNull(),
  checkpoint: text('checkpoint').notNull(), total: integer('total'), processed: integer('processed').notNull(),
  startedAt: text('started_at').notNull(), updatedAt: text('updated_at').notNull(),
  finishedAt: text('finished_at'), error: text('error'),
},t=>[index('sync_runs_source').on(t.source,t.status)]);
export const sourceState = sqliteTable('source_state', {
  source: text('source').primaryKey(), activeRunId: text('active_run_id'), status: text('status').notNull(),
  lastSuccess: text('last_success'), lastError: text('last_error'), metadata: text('metadata').notNull(),
  leaseOwner: text('lease_owner'), leaseUntil: text('lease_until'),
});

// Public address results only; no API keys or visitor locations are stored.
export const facilityGeocodes=sqliteTable('facility_geocodes',{
  address:text('address').primaryKey(),query:text('query').notNull(),status:text('status').notNull(),
  latitude:real('latitude'),longitude:real('longitude'),checkedAt:text('checked_at').notNull(),
  reason:text('reason'),sourceUrl:text('source_url').notNull(),
});
