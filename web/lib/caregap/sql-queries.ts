import { supplement, mergeFacilities, matchService, haversine,curatedServiceLinks,hydrateService } from './domain';
import type { Service, Facility } from './types';
import {facilityIndexReady} from './facility-index';

const guideJson=JSON.stringify(supplement);
const linkJson=JSON.stringify(curatedServiceLinks);
const servicesCte=`WITH active_services AS (
 SELECT r.* FROM services r JOIN source_state s ON r.source=s.source AND r.run_id=s.active_run_id
), official AS (SELECT * FROM active_services WHERE source!='curated'), guides AS (
 SELECT id,scope,province,district,payload FROM active_services WHERE source='curated'
 UNION ALL SELECT json_extract(value,'$.id'),json_extract(value,'$.scope'),json_extract(value,'$.province'),json_extract(value,'$.district'),value
 FROM json_each(?) WHERE NOT EXISTS(SELECT 1 FROM active_services WHERE source='curated')
), links AS (SELECT key guide_id,value source_id FROM json_each(?)), mapped_official AS (
 SELECT coalesce(l.guide_id,o.id) id,o.scope,o.province,o.district,
 CASE WHEN l.guide_id IS NOT NULL AND g.id IS NOT NULL THEN json_patch(o.payload,json_object(
 'id',l.guide_id,'canonical_id',l.guide_id,'needs',json_extract(g.payload,'$.needs'),'groups',json_extract(g.payload,'$.groups'),
 'channels',json_extract(g.payload,'$.channels'),'keywords',json_extract(g.payload,'$.keywords'),'check',json_extract(g.payload,'$.check'),'checklist',json_extract(g.payload,'$.checklist'),
 'regional_checklist_indices',json_extract(g.payload,'$.regional_checklist_indices'),'directory',json_extract(g.payload,'$.directory'),
 'action_url',json_extract(g.payload,'$.action_url'),'action_label',json_extract(g.payload,'$.action_label'))) ELSE o.payload END payload
 FROM official o LEFT JOIN links l ON o.scope='national' AND json_extract(o.payload,'$.source_id')=l.source_id LEFT JOIN guides g ON g.id=l.guide_id
), selected_services AS (
 SELECT id,scope,province,district,payload FROM mapped_official
 UNION ALL SELECT g.* FROM guides g WHERE NOT EXISTS(
 SELECT 1 FROM mapped_official o WHERE o.scope='national' AND json_extract(o.payload,'$.canonical_id')=g.id)
)`;
function normSql(v:string){for(const c of [' ','\t','\r','\n','\u00a0','·','ㆍ','・','(',')','（','）','-'])v=`replace(${v},'${c.replaceAll("'","''")}','')`;return `lower(${v})`;}
const identity=`CASE WHEN trim(coalesce(json_extract(f.payload,'$.address'),''))!=''
 AND instr(json_extract(f.payload,'$.name'),'*')=0 AND instr(json_extract(f.payload,'$.name'),'●')=0 AND instr(json_extract(f.payload,'$.name'),'○')=0
 THEN ${normSql("json_extract(f.payload,'$.name')")}||'|'||${normSql("json_extract(f.payload,'$.address')")}
 ELSE f.source||':'||coalesce(json_extract(f.payload,'$.source_id'),f.id) END`;
const legacyActive=`SELECT f.source,f.run_id,f.id,f.province,f.district,f.latitude,f.longitude,${identity} identity,json_extract(f.payload,'$.name') name,
 coalesce(json_extract(f.payload,'$.address'),'') address,coalesce(json_extract(f.payload,'$.kind'),'') kind,
 json_extract(f.payload,'$.role') role,json_extract(f.payload,'$.phone') phone,
 CASE json_extract(f.payload,'$.role') WHEN 'provider' THEN 0 WHEN 'contact' THEN 1 ELSE 2 END priority
 FROM facilities f JOIN source_state s ON f.source=s.source AND f.run_id=s.active_run_id`;
const facilityRanking=`, ranked AS (SELECT *,row_number() OVER(PARTITION BY identity ORDER BY priority,source,id) rn FROM active),
 coordinates AS (SELECT identity,latitude,longitude,row_number() OVER(PARTITION BY identity ORDER BY priority,source,id) cn
 FROM active WHERE latitude IS NOT NULL AND longitude IS NOT NULL),
 canonical AS (SELECT r.*,coalesce(r.latitude,c.latitude) eff_lat,coalesce(r.longitude,c.longitude) eff_lon
 FROM ranked r LEFT JOIN coordinates c ON r.identity=c.identity AND c.cn=1 WHERE r.rn=1)`;
async function facilityCte(db:D1Database,province='',district=''){
 const indexed=await facilityIndexReady(db),region=regionWhere(indexed?'e':'f',province,district,false);
 const active=indexed?'SELECT e.* FROM facility_entries e JOIN source_state s ON e.source=s.source AND e.run_id=s.active_run_id':legacyActive;
 if(!indexed)return {sql:`WITH active AS (${active} WHERE ${region.sql})${facilityRanking}`,args:region.args};
 const peer=regionWhere('p',province,district,false);
 const peerFrom="facility_entries p INDEXED BY facility_entries_identity JOIN source_state ps ON p.source=ps.source AND p.run_id=ps.active_run_id";
 // Equality probes use the stored identity index. Avoid materializing and joining
 // two nationwide window partitions every time a visitor opens the map.
 const point=(column:string)=>`SELECT p.${column} FROM ${peerFrom} WHERE p.identity=a.identity AND p.latitude IS NOT NULL AND p.longitude IS NOT NULL AND (${peer.sql}) ORDER BY p.priority,p.source,p.id LIMIT 1`;
 return {sql:`WITH active AS (${active} WHERE ${region.sql}), canonical AS (
   SELECT a.*,coalesce(a.latitude,(${point('latitude')})) eff_lat,coalesce(a.longitude,(${point('longitude')})) eff_lon
   FROM active a WHERE NOT EXISTS(SELECT 1 FROM ${peerFrom} WHERE p.identity=a.identity AND (p.priority,p.source,p.id)<(a.priority,a.source,a.id) AND (${peer.sql})))`,args:[...region.args,...peer.args,...peer.args,...peer.args]};
}
const like=(v:string)=>'%'+v.replace(/[\\%_]/g,'\\$&')+'%';
export function pageInfo(url:URL){const p=url.searchParams;return {page:Math.max(1,Math.min(10000,Math.floor(Number(p.get('page'))||1))),pageSize:Math.max(1,Math.min(100,Math.floor(Number(p.get('pageSize'))||20)))};}
function regionWhere(alias:string,province:string,district:string,provinceWide=true){
 const clauses:string[]=[],args:unknown[]=[];
 if(province){clauses.push(`${alias}.province=?`);args.push(province);}
 if(district){clauses.push(`(${provinceWide?`${alias}.district='' OR `:''}${alias}.district=? OR substr(${alias}.district,1,length(?)+1)=?||' ' OR substr(?,1,length(${alias}.district)+1)=${alias}.district||' ')`);args.push(district,district,district,district);}
 return {sql:clauses.join(' AND ')||'1',args};
}
export async function serviceQuery(db:D1Database|undefined,url:URL){
 const p=url.searchParams,{page,pageSize}=pageInfo(url);
 if(!db){const rows=supplement.filter(s=>matchService(s,p.get('q')??'',p.get('need')??'',p.get('group')??'',p.get('channel')??'',p.get('scope')??'all',p.get('province')??'',p.get('district')??''));return p.has('id')?{item:rows.find(s=>s.id===p.get('id'))??null}:{items:rows.slice((page-1)*pageSize,page*pageSize).map(hydrateService),total:rows.length,guideCount:rows.length,serviceCount:0,page,pageSize};}
 const where:string[]=[],args:unknown[]=[guideJson,linkJson];const r=regionWhere('s',p.get('province')??'',p.get('district')??'');
 where.push(`(s.scope='national' OR (${r.sql}))`);args.push(...r.args);
 if(p.get('scope')&&p.get('scope')!=='all'){where.push('s.scope=?');args.push(p.get('scope'));}
 for(const [param,key] of [['need','needs'],['group','groups'],['channel','channels']])if(p.get(param)){
  where.push(`EXISTS(SELECT 1 FROM json_each(s.payload,'$.${key}') v WHERE v.value=?${param==='group'?" OR v.value='가구공통'":''})`);args.push(p.get(param));
 }
 for(const token of (p.get('q')??'').toLowerCase().split(/\s+/).filter(Boolean)){
  where.push(`lower(coalesce(json_extract(s.payload,'$.name'),'')||' '||coalesce(json_extract(s.payload,'$.target'),'')||' '||coalesce(json_extract(s.payload,'$.support'),'')||' '||coalesce(json_extract(s.payload,'$.keywords'),'')) LIKE ? ESCAPE '\\'`);args.push(like(token));
 }
 if(p.has('id')){where.push('s.id=?');args.push(p.get('id'));const found=await db.prepare(`${servicesCte} SELECT s.payload FROM selected_services s WHERE ${where.join(' AND ')} LIMIT 1`).bind(...args).first<{payload:string}>();return {item:found?hydrateService(JSON.parse(found.payload)):null};}
 const sql=where.join(' AND ');
 const [count,rows]=await Promise.all([
  db.prepare(`${servicesCte} SELECT count(*) n,coalesce(sum(CASE WHEN json_extract(s.payload,'$.source')='curated' THEN 1 ELSE 0 END),0) guides FROM selected_services s WHERE ${sql}`).bind(...args).first<{n:number;guides:number}>(),
  db.prepare(`${servicesCte} SELECT s.payload FROM selected_services s WHERE ${sql} ORDER BY json_extract(s.payload,'$.name'),s.id LIMIT ? OFFSET ?`).bind(...args,pageSize,(page-1)*pageSize).all<{payload:string}>()
 ]);
 return {items:rows.results.map(r=>hydrateService(JSON.parse(r.payload))),total:count?.n??0,guideCount:count?.guides??0,serviceCount:(count?.n??0)-(count?.guides??0),page,pageSize};
}
export type ServiceBrief=Pick<Service,'id'|'canonical_id'|'scope'|'province'|'district'|'needs'|'source'>;
export async function serviceBriefs(db?:D1Database):Promise<ServiceBrief[]>{
 if(!db)return supplement;
 const {results}=await db.prepare(`${servicesCte} SELECT id,scope,province,district,json_extract(payload,'$.source') source,json_extract(payload,'$.canonical_id') canonical_id,json_extract(payload,'$.needs') needs FROM selected_services`).bind(guideJson,linkJson).all<any>();
 return results.map(r=>({...r,needs:JSON.parse(r.needs??'[]')}));
}
type Origin={lat:number;lon:number;radius:number};
type FacilityPick={id:string;identity:string;eff_lat:number|null;eff_lon:number|null;name:string;distance_km?:number};
export async function facilityQuery(db:D1Database|undefined,url:URL,origin?:Origin){
 const p=url.searchParams,{page,pageSize}=pageInfo(url);
 if(!db)return {items:[],total:0,page,pageSize,missingCoordinates:0,mapItems:[],mapTruncated:false,distanceType:'straight_line',origin:origin??null};
 const geographic=!!origin||p.has('bbox');
 const {sql:facilitiesCte,args:cteArgs}=await facilityCte(db,geographic?'':p.get('province')??'',geographic?'':p.get('district')??'');
 const where:string[]=[],args:unknown[]=[],sharedWhere:string[]=[],sharedArgs:unknown[]=[];const region=regionWhere('c',p.get('province')??'',p.get('district')??'',false);
 if(!geographic){where.push(region.sql);args.push(...region.args);}
 if(p.get('serviceId')){sharedWhere.push(`c.identity IN(SELECT a.identity FROM active a JOIN service_facility_relations j ON j.source=a.source AND j.run_id=a.run_id AND j.facility_id=a.id WHERE j.service_id=? AND a.role IN ('provider','contact'))`);sharedArgs.push(p.get('serviceId'));}
 if(p.get('q')){sharedWhere.push(`lower(c.name||' '||c.address||' '||c.kind) LIKE ? ESCAPE '\\'`);sharedArgs.push(like(p.get('q')!.toLowerCase()));}
 where.push(...sharedWhere);args.push(...sharedArgs);
 if(p.has('bbox')){
  const box=p.get('bbox')!.split(',').map(Number);if(box.length!==4||box.some(n=>!Number.isFinite(n))||box[0]>box[2]||box[1]>box[3])throw Error('INVALID_LOCATION');
  where.push('c.eff_lat BETWEEN ? AND ? AND c.eff_lon BETWEEN ? AND ?');args.push(box[0],box[2],box[1],box[3]);
 }
 if(origin){const dy=origin.radius/110.5,dx=origin.radius/(111*Math.cos(origin.lat*Math.PI/180));where.push('c.eff_lat BETWEEN ? AND ? AND c.eff_lon BETWEEN ? AND ?');args.push(origin.lat-dy,origin.lat+dy,origin.lon-dx,origin.lon+dx);}
 const condition=where.join(' AND ')||'1';const projection='c.id,c.identity,c.name,c.eff_lat,c.eff_lon';
 const unfiltered=!origin&&!['province','district','serviceId','q','bbox'].some(k=>p.get(k));
 const summary=unfiltered?await facilitySummary(db):null;
 const missingWhere=[`(${region.sql})`,...sharedWhere,'(c.eff_lat IS NULL OR c.eff_lon IS NULL)'].join(' AND ');
 const missingPromise=summary?Promise.resolve({n:summary.groups.reduce((n,g)=>n+g.missingCoordinates,0)}):db.prepare(`${facilitiesCte} SELECT count(*) n FROM canonical c WHERE ${missingWhere}`).bind(...cteArgs,...region.args,...sharedArgs).first<{n:number}>();
 let selected:FacilityPick[],total:number;
 if(origin){
  // Only compact coordinates cross the Worker boundary; full payloads are fetched for the selected page.
  const {results}=await db.prepare(`${facilitiesCte} SELECT ${projection} FROM canonical c WHERE ${condition}`).bind(...cteArgs,...args).all<FacilityPick>();
  const nearby=results.map(r=>({...r,distance_km:haversine(origin.lat,origin.lon,r.eff_lat!,r.eff_lon!)})).filter(r=>r.distance_km<=origin.radius).sort((a,b)=>a.distance_km-b.distance_km||a.name.localeCompare(b.name,'ko'));
  total=nearby.length;selected=nearby.slice((page-1)*pageSize,page*pageSize);
 }else{
  const [count,rows]=await Promise.all([
   summary?Promise.resolve({n:summary.groups.reduce((n,g)=>n+g.n,0)}):db.prepare(`${facilitiesCte} SELECT count(*) n FROM canonical c WHERE ${condition}`).bind(...cteArgs,...args).first<{n:number}>(),
   db.prepare(`${facilitiesCte} SELECT ${projection} FROM canonical c WHERE ${condition} ORDER BY c.priority,c.name,c.id LIMIT ? OFFSET ?`).bind(...cteArgs,...args,pageSize,(page-1)*pageSize).all<FacilityPick>()
  ]);total=count?.n??0;selected=rows.results;
 }
 let items:Facility[]=[];
 if(selected.length){
   const indexed=await facilityIndexReady(db),payloadRegion=regionWhere('a',geographic?'':p.get('province')??'',geographic?'':p.get('district')??'',false);
  const results:{payload:string}[]=[],chunkSize=Math.max(1,100-cteArgs.length);
  for(let offset=0;offset<selected.length;offset+=chunkSize){
   const chunk=selected.slice(offset,offset+chunkSize);
   // Probe the identity index for this page instead of rebuilding a nationwide
   // canonical partition while loading its twenty full payloads.
   const batch=indexed?await db.prepare(`SELECT f.payload FROM facility_entries a INDEXED BY facility_entries_identity JOIN source_state s ON a.source=s.source AND a.run_id=s.active_run_id JOIN facilities f ON f.source=a.source AND f.run_id=a.run_id AND f.id=a.id WHERE a.identity IN (${chunk.map(()=>'?').join(',')}) AND (${payloadRegion.sql})`).bind(...chunk.map(r=>r.identity),...payloadRegion.args).all<{payload:string}>():await db.prepare(`${facilitiesCte} SELECT f.payload FROM active a JOIN facilities f ON f.source=a.source AND f.run_id=a.run_id AND f.id=a.id WHERE a.identity IN (${chunk.map(()=>'?').join(',')})`).bind(...cteArgs,...chunk.map(r=>r.identity)).all<{payload:string}>();
   results.push(...batch.results);
  }
  const byId=new Map(mergeFacilities(results.map(r=>JSON.parse(r.payload))).map(f=>[f.id,f]));
  items=selected.map(r=>{const f=byId.get(r.id);if(!f)throw Error('기관 병합 결과 확인 실패');return {...f,latitude:r.eff_lat,longitude:r.eff_lon,...(r.distance_km===undefined?{}:{distance_km:r.distance_km})};});
 }
 return {items,total,page,pageSize,missingCoordinates:(await missingPromise)?.n??0,mapItems:items.filter(f=>f.latitude!==null&&f.longitude!==null),mapTruncated:false,distanceType:'straight_line',origin:origin??null};
}
type FacilityGroup={province:string;district:string;n:number;missingCoordinates:number;missingAddress:number;missingPhone:number};
export async function facilitySummary(db?:D1Database){
 if(!db)return {groups:[] as FacilityGroup[],links:[] as {province:string;district:string;service_id:string}[]};
 const [versions,cache]=await Promise.all([
  db.prepare("SELECT source,active_run_id FROM source_state WHERE source IN ('activity_support','directory','facilities') AND active_run_id IS NOT NULL ORDER BY source").all<{source:string;active_run_id:string}>(),
  db.prepare("SELECT metadata,status FROM source_state WHERE source='facility_index'").first<{metadata:string;status:string}>()
 ]);
 const key='facility-summary-v1:'+JSON.stringify(versions.results);
 if(cache?.status==='ready'){const saved=JSON.parse(cache.metadata);if(saved.key===key&&Array.isArray(saved.groups)&&Array.isArray(saved.links))return saved as {groups:FacilityGroup[];links:{province:string;district:string;service_id:string}[]};}
 const {sql:facilitiesCte}=await facilityCte(db);
  const indexed=await facilityIndexReady(db);
  const [groups,links]=await Promise.all([
  db.prepare(`${facilitiesCte} SELECT province,district,count(*) n,sum(CASE WHEN eff_lat IS NULL OR eff_lon IS NULL THEN 1 ELSE 0 END) missingCoordinates,sum(CASE WHEN trim(address)='' THEN 1 ELSE 0 END) missingAddress,sum(CASE WHEN coalesce(phone,'')='' THEN 1 ELSE 0 END) missingPhone FROM canonical GROUP BY province,district`).all<FacilityGroup>(),
   // Relations are sparse. Start from their authoritative source IDs and probe
   // the stored identity index, avoiding active×canonical nationwide expansion.
   db.prepare(indexed?`SELECT DISTINCT representative.province,representative.district,j.service_id
    FROM service_facility_relations j
    JOIN source_state s ON j.source=s.source AND j.run_id=s.active_run_id
    JOIN facility_entries a ON a.source=j.source AND a.run_id=j.run_id AND a.id=j.facility_id
    JOIN facility_entries representative ON representative.rowid=(
      SELECT p.rowid FROM facility_entries p INDEXED BY facility_entries_identity
      JOIN source_state ps ON p.source=ps.source AND p.run_id=ps.active_run_id
      WHERE p.identity=a.identity ORDER BY p.priority,p.source,p.id LIMIT 1)
    WHERE a.role IN ('provider','contact')`:`${facilitiesCte} SELECT DISTINCT c.province,c.district,j.service_id FROM canonical c JOIN active a ON a.identity=c.identity JOIN service_facility_relations j ON j.source=a.source AND j.run_id=a.run_id AND j.facility_id=a.id WHERE a.role IN ('provider','contact')`).all<{province:string;district:string;service_id:string}>()
 ]);
 const result={groups:groups.results,links:links.results};
 if(cache?.status==='ready')try{await db.prepare("UPDATE source_state SET metadata=? WHERE source='facility_index' AND status='ready'").bind(JSON.stringify({key,...result})).run();}catch{console.warn('CareGap facility summary cache write delayed');}
 return result;
}
