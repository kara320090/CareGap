import currentRegions from '../../data/regions-current.json';
import directory from '../../data/directory-snapshot.json';
import { supplement } from './domain';
import { writeServices,writeFacilities,writeChunks } from './store';
import type { Bindings,Facility } from './types';

const bootstrapped=new WeakSet<D1Database>();
// Trusted, versioned public snapshots only. Never accept content or source URLs from a visitor.
// Concurrent cold starts may repeat INSERT OR IGNORE, but cannot replace an activated sync generation.
export async function ensureBootstrap(env:Bindings){
  if(!env.DB)return;
  if(bootstrapped.has(env.DB))return;
  // Worker requests cannot await another request's pending I/O. Each cold
  // request performs its own idempotent check; only completion is cached.
  await seed(env.DB);bootstrapped.add(env.DB);
}
async function seed(db:D1Database){
  const states=(await db.prepare('SELECT source,active_run_id FROM source_state').all<{source:string;active_run_id:string|null}>()).results;
  const exists=(source:string)=>states.some(s=>s.source===source&&s.active_run_id);
  const version='snapshot-2026-11-10';
  if(!exists('curated')){
    await writeServices(db,'curated',version,supplement);
    await db.prepare("INSERT OR IGNORE INTO source_state(source,active_run_id,status,last_success,metadata) VALUES('curated',?,'ready',?,?) ON CONFLICT(source) DO UPDATE SET active_run_id=excluded.active_run_id,status=excluded.status,last_success=excluded.last_success,metadata=excluded.metadata WHERE source_state.active_run_id IS NULL AND source_state.lease_owner IS NULL").bind(version,'2026-11-10',JSON.stringify({count:supplement.length,type:'reviewed_guides'})).run();
  }
  if(!exists('directory') && directory.items.length > 0){
    await writeFacilities(db,'directory',version,directory.items as Facility[]);
    await db.prepare("INSERT OR IGNORE INTO source_state(source,active_run_id,status,last_success,metadata) VALUES('directory',?,'ready',?,?) ON CONFLICT(source) DO UPDATE SET active_run_id=excluded.active_run_id,status=excluded.status,last_success=excluded.last_success,metadata=excluded.metadata WHERE source_state.active_run_id IS NULL AND source_state.lease_owner IS NULL").bind(version,directory.collected_at,JSON.stringify({count:directory.items.length,type:'official_snapshot',coordinate_status:'needs_key'})).run();
  }
  if(!exists('regions')){
    await writeChunks(db,currentRegions.map(r=>db.prepare('INSERT OR IGNORE INTO regions(id,province,district,source_date,payload) VALUES(?,?,?,?,?)').bind(r.id,r.province,r.district,r.source_date,JSON.stringify(r))));
    await db.prepare("INSERT OR IGNORE INTO source_state(source,active_run_id,status,last_success,metadata) VALUES('regions',?,'ready',?,?) ON CONFLICT(source) DO UPDATE SET active_run_id=excluded.active_run_id,status=excluded.status,last_success=excluded.last_success,metadata=excluded.metadata WHERE source_state.active_run_id IS NULL AND source_state.lease_owner IS NULL").bind(version,'2026-11-10',JSON.stringify({count:currentRegions.length,type:'official_download'})).run();
  }
}
