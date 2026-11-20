import { serviceQuery,facilityQuery,serviceBriefs,facilitySummary,pageInfo } from './sql-queries';
import fallbackRegions from '../../data/regions-current.json';
import { mergeServices, mergeFacilities, supplement, filterFacilities, matchService, locationMatches,facilityLocationMatches } from './domain';
import { displaySources } from './sources';
import type { Region,Service,Facility,Bindings,SourceStatus } from './types';
import {indexStatement} from './facility-index';
import {publishedRead,invalidatePublishedReads} from './published-read-cache';

const generation=(state:SourceStatus[])=>JSON.stringify(state.map(s=>[s.source,s.active_run_id,s.status,s.last_success,s.metadata]));
const queryKey=(url:URL)=>{const p=new URLSearchParams(url.search);p.sort();return p.toString();};

export async function readRegions(db?:D1Database):Promise<Region[]>{
  if(db){const result=await db.prepare('SELECT payload FROM regions ORDER BY province,district').all<{payload:string}>();if(result.results?.length)return result.results.map(r=>JSON.parse(r.payload));}
  return fallbackRegions;
}
export async function activeRecords<T>(db:D1Database|undefined,table:'services'|'facilities'):Promise<T[]>{
  if(!db)return [];
  const {results}=await db.prepare(`SELECT r.payload FROM ${table} r JOIN source_state s ON r.source=s.source AND r.run_id=s.active_run_id`).all<{payload:string}>();
  return results.map(r=>JSON.parse(r.payload));
}
export async function statuses(env:Bindings):Promise<SourceStatus[]>{
  const states=env.DB?(await env.DB.prepare('SELECT * FROM source_state').all<any>()).results:[];
  const runs=env.DB?(await env.DB.prepare('SELECT source,processed,total,status,updated_at FROM sync_runs r WHERE r.id=(SELECT id FROM sync_runs latest WHERE latest.source=r.source ORDER BY started_at DESC LIMIT 1)').all<any>()).results:[];
  return Object.entries(displaySources).map(([source,meta])=>{
    const row=states.find(s=>s.source===source);const keyNeeded=['national','local','facilities'].includes(source)&&!env.DATA_GO_KR_KEY;
    const run=runs.find(r=>r.source===source);
    const geo=source==='facilities'?states.find(s=>s.source==='facility_geocoding'):null;
    const generation=JSON.stringify(states.filter(s=>['activity_support','directory','facilities'].includes(s.source)&&s.active_run_id).sort((a,b)=>a.source.localeCompare(b.source)).map(s=>({source:s.source,active_run_id:s.active_run_id})));
    const geoMeta=geo?JSON.parse(geo.metadata):null;
    const official=source==='facilities'?states.find(s=>s.source==='official_map'):null,om=official?JSON.parse(official.metadata):null;
    return {source,label:meta.label,status:row?.status??(keyNeeded?'needs_key':'not_collected'),last_success:row?.last_success??null,last_error:row?.last_error??null,active_run_id:row?.active_run_id??null,metadata:{...(row?JSON.parse(row.metadata):{}),...(run?{progress:{processed:run.processed,total:run.total,status:run.status,updated_at:run.updated_at}}:{}),...(geo&&geoMeta&&JSON.stringify(geoMeta.sourceVersions??[])===generation?{geocoding:{...geoMeta,status:geo.status,error:geo.last_error}}:{}),...(om?{officialMap:{status:official.status,lastSuccess:official.last_success,error:official.last_error?'공식 원천 조회가 지연되고 있습니다.':null,mode:om.mode??'live',snapshotCollectedAt:om.snapshotCollectedAt??null,liveUnavailable:!!om.liveError,processed:om.processed??null,matched:om.matched??null,regionsDone:om.regionIndex??0,regionTotal:om.regions?.length??null}}:{})}};
  });
}
export async function serviceRecords(env:Bindings){return mergeServices(await activeRecords<Service>(env.DB,'services'));}
export async function facilityRecords(env:Bindings){return mergeFacilities(await activeRecords<Facility>(env.DB,'facilities'));}
export const pagination=pageInfo;
export async function queryServices(env:Bindings,url:URL){
  return {...await serviceQuery(env.DB,url),sources:await statuses(env),curatedCount:supplement.length};
}
export async function queryFacilities(env:Bindings,url:URL){
  const state=await statuses(env),origin=originFrom(url);
  const read=()=>facilityQuery(env.DB,url,origin);
  const result=url.searchParams.has('lat')||url.searchParams.has('lon')||url.searchParams.has('bbox')
    ? await read()
    : await publishedRead(env.DB,'facilities:'+generation(state)+':'+queryKey(url),read);
  return {...result,sourceStatuses:state};
}
export function originFrom(url:URL){
  const p=url.searchParams;if(!p.has('lat')||!p.has('lon'))return undefined;
  const lat=Number(p.get('lat')),lon=Number(p.get('lon')),radius=Number(p.get('radius')??5);
  if(!Number.isFinite(lat)||!Number.isFinite(lon)||lat<33||lat>39||lon<124||lon>132||![2,5,10].includes(radius))throw Error('INVALID_LOCATION');
  return {lat,lon,radius};
}
export async function coverage(env:Bindings,url:URL){
  const state=await statuses(env);
  return publishedRead(env.DB,'coverage:'+generation(state)+':'+queryKey(url),async()=>{
  const [regions,services,facilities]=await Promise.all([readRegions(env.DB),serviceBriefs(env.DB),facilitySummary(env.DB)]);
  const p=url.searchParams;const nationalComplete=state.some(s=>s.source==='national'&&!!s.active_run_id);const localComplete=state.some(s=>s.source==='local'&&!!s.active_run_id);const facilityComplete=state.some(s=>s.source==='facilities'&&!!s.active_run_id);
  const rows=regions.filter(r=>(!p.get('province')||r.province===p.get('province'))&&(!p.get('district')||r.district===p.get('district'))).map(r=>{
    const local=services.filter(s=>s.scope==='local'&&locationMatches(s,r.province,r.district));
    const applicable=services.filter(s=>(!nationalComplete||s.source!=='curated')&&(s.scope==='national'||locationMatches(s,r.province,r.district)));
    const regionFacilities=facilities.groups.filter(f=>facilityLocationMatches(f,r.province,r.district));
    const fs=regionFacilities.reduce((n,g)=>n+g.n,0);
    const unmappedInProvince=facilities.groups.filter(f=>f.province===r.province&&!regions.some(v=>v.province===f.province&&v.district===f.district)).reduce((n,g)=>n+g.n,0);
    const missingCoordinates=regionFacilities.reduce((n,g)=>n+g.missingCoordinates,0),missingAddress=regionFacilities.reduce((n,g)=>n+g.missingAddress,0),missingPhone=regionFacilities.reduce((n,g)=>n+g.missingPhone,0);
    const linkedIds=new Set(facilities.links.filter(f=>facilityLocationMatches(f,r.province,r.district)).map(f=>f.service_id));
    const linked=new Set(applicable.filter(s=>linkedIds.has(s.canonical_id??s.id)).map(s=>s.id));
    const groups=Object.fromEntries([...new Set(local.flatMap(s=>s.needs))].map(n=>[n,local.filter(s=>s.needs.includes(n)).length]));
    return {...r,localServices:localComplete?local.length:null,confirmedFacilities:fs,allFacilities:facilityComplete?fs:null,
      linkedServices:linked.size,knownServices:applicable.length,linkRate:applicable.length?linked.size/applicable.length:null,fields:groups,
      missingCoordinates,missingAddress,missingPhone,unmappedInProvince,informationNeedsReview:!!(missingCoordinates||missingAddress||missingPhone||unmappedInProvince),
      status:localComplete&&facilityComplete?'collected':'incomplete',lastSuccess:state.find(s=>s.source==='local')?.last_success??null};
  });
  return {items:rows,nationalServices:new Set(services.filter(s=>s.scope==='national'&&(!nationalComplete||s.source!=='curated')).map(s=>s.id)).size,
    nationalGuides:nationalComplete?services.filter(s=>s.source==='curated').length:0,
    localServices:localComplete?new Set(services.filter(s=>s.scope==='local').map(s=>s.id)).size:null,
    confirmedFacilities:facilities.groups.reduce((n,g)=>n+g.n,0),unmappedFacilities:facilities.groups.filter(f=>!regions.some(r=>r.province===f.province&&r.district===f.district)).reduce((n,g)=>n+g.n,0),
    sourceStatuses:state,note:'전국 합계는 원천 ID 기준 중복을 제거합니다. 지역별 수를 더한 값과 다를 수 있습니다. 기관 안내는 원천의 기록 기준이며 정원·수혜자 수가 아닙니다. 서로 다른 원천의 동일 기관 여부는 공개 식별정보가 일치할 때만 합치므로 미확인 중복이 남을 수 있습니다.'};
  });
}
export async function writeChunks(db:D1Database,statements:D1PreparedStatement[]){
  for(let i=0;i<statements.length;i+=400){
    const group=[];for(let j=i;j<Math.min(i+400,statements.length);j+=200)group.push(db.batch(statements.slice(j,j+200)));
    const settled=await Promise.allSettled(group),failed=settled.find(r=>r.status==='rejected');
    if(failed?.status==='rejected')throw failed.reason;
  }
}
export async function writeServices(db:D1Database,source:string,run:string,rows:Service[]){
  invalidatePublishedReads(db);
  await writeChunks(db,rows.map(s=>db.prepare('INSERT OR REPLACE INTO services(source,run_id,id,scope,province,district,payload) VALUES(?,?,?,?,?,?,?)').bind(source,run,s.id,s.scope,s.province,s.district,JSON.stringify(s))));
}
export async function writeFacilities(db:D1Database,source:string,run:string,rows:Facility[]){
  invalidatePublishedReads(db);
  await writeChunks(db,rows.flatMap(f=>[db.prepare('INSERT OR REPLACE INTO facilities(source,run_id,id,province,district,latitude,longitude,payload) VALUES(?,?,?,?,?,?,?,?)').bind(source,run,f.id,f.province,f.district,f.latitude,f.longitude,JSON.stringify(f)),indexStatement(db,source,run,f)]));
  await writeChunks(db,rows.filter(f=>f.evidence_url).flatMap(f=>f.service_ids.map(s=>db.prepare('INSERT OR REPLACE INTO service_facility_relations(source,run_id,service_id,facility_id,role,evidence_url,checked_on) VALUES(?,?,?,?,?,?,?)').bind(source,run,s,f.id,f.role,f.evidence_url!,f.source_date))));
}
