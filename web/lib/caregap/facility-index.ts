import {facilityIdentity} from './domain';
import type {Facility} from './types';

export function indexStatement(db:D1Database,source:string,run:string,f:Facility){
 return db.prepare('INSERT OR REPLACE INTO facility_entries(source,run_id,id,identity,province,district,name,address,kind,role,priority,phone,evidence_url,latitude,longitude) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').bind(
  source,run,f.id,source==='official_map'&&f.service_institution_id?'official-srv:'+f.service_institution_id:facilityIdentity(f),f.province,f.district,f.name,f.address,f.kind,f.role,{provider:0,contact:1,related:2}[f.role],f.phone,f.evidence_url,f.latitude,f.longitude);
}
export async function facilityIndexReady(db:D1Database){return !!await db.prepare("SELECT source FROM source_state WHERE source='facility_index' AND status='ready'").first();}
function normalized(v:string){for(const c of [' ','\t','\r','\n','\u00a0','·','ㆍ','・','(',')','（','）','-'])v=`replace(${v},'${c.replaceAll("'","''")}','')`;return `lower(${v})`;}
export async function backfillFacilityIndex(db:D1Database){
 // Bounded, owner-invoked data backfill. Schema changes are handled by migrations.
 const name="json_extract(f.payload,'$.name')",address="coalesce(json_extract(f.payload,'$.address'),'')";
 const identity=`CASE WHEN trim(${address})!='' AND instr(${name},'*')=0 AND instr(${name},'●')=0 AND instr(${name},'○')=0 THEN ${normalized(name)}||'|'||${normalized(address)} ELSE f.source||':'||coalesce(json_extract(f.payload,'$.source_id'),f.id) END`;
 await db.prepare(`INSERT OR REPLACE INTO facility_entries(source,run_id,id,identity,province,district,name,address,kind,role,priority,phone,evidence_url,latitude,longitude)
 SELECT f.source,f.run_id,f.id,${identity},f.province,f.district,${name},${address},coalesce(json_extract(f.payload,'$.kind'),''),json_extract(f.payload,'$.role'),CASE json_extract(f.payload,'$.role') WHEN 'provider' THEN 0 WHEN 'contact' THEN 1 ELSE 2 END,json_extract(f.payload,'$.phone'),json_extract(f.payload,'$.evidence_url'),f.latitude,f.longitude
 FROM facilities f JOIN source_state s ON f.source=s.source AND f.run_id=s.active_run_id
 WHERE NOT EXISTS(SELECT 1 FROM facility_entries e WHERE e.source=f.source AND e.run_id=f.run_id AND e.id=f.id) ORDER BY f.source,f.run_id,f.id LIMIT 2000`).run();
 const row=await db.prepare(`SELECT count(*) total,coalesce(sum(CASE WHEN e.id IS NOT NULL THEN 1 ELSE 0 END),0) processed FROM facilities f JOIN source_state s ON f.source=s.source AND f.run_id=s.active_run_id LEFT JOIN facility_entries e ON e.source=f.source AND e.run_id=f.run_id AND e.id=f.id`).first<{total:number;processed:number}>();
 if(row!.processed===row!.total)await db.prepare("INSERT INTO source_state(source,status,metadata) VALUES('facility_index','ready','{}') ON CONFLICT(source) DO UPDATE SET status='ready'").run();
 return {phase:'facility_index',processed:row!.processed,total:row!.total};
}
