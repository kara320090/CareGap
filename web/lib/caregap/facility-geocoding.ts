import type {Bindings,Facility} from './types';
import {regionNames,physicalFacilityRegion,publicFacilityPhone} from './sources';
import {writeFacilities,writeChunks} from './store';
import {collectionDay} from './domain';

const sourceUrl='https://dapi.kakao.com/v2/local/search/address.json';
const valid=(lat:unknown,lon:unknown):boolean=>typeof lat==='number'&&typeof lon==='number'&&Number.isFinite(lat)&&Number.isFinite(lon)&&lat>=33&&lat<=39&&lon>=124&&lon<=132;
type Cached={status:string;latitude:number|null;longitude:number|null;checked_at:string;query:string;reason:string|null};
type Pick={source:string;id:string;run_id:string;payload:string;official_payload?:string|null;cached_status:string|null;cached_latitude:number|null;cached_longitude:number|null;cached_checked_at:string|null;cached_query:string|null;cached_reason:string|null};
type Result=Cached&{address:string};

export function geocodingAddress(address:string){
  if(!address||/[*●○]|비공개|미공개|주소없음/.test(address))return '';
  const clean=address.replace(/\([^)]*\)/g,' ').replace(/([가-힣])\s+(\d+(?:번)?[로길])/g,'$1$2').replace(/\s+/g,' ').trim();
  const road=clean.match(/^(.+(?:로|길)\s*\d+(?:-\d+)?)(?=$|[\s,\/.]|번지|층|호)/)?.[1];
  if(road)return road.replace(/(로|길)(\d+(?:-\d+)?)$/,'$1 $2').trim();
  return clean.match(/^(.+[동리가]\s+\d+(?:-\d+)?)(?=$|[\s,\/])/)?.[1]??'';
}
const compact=(s:string)=>s.replace(/\s+/g,'');
function sameDistrict(a:string,b:string){a=a.trim().replace(/\s+/g,' ');b=b.trim().replace(/\s+/g,' ');return a===b||a.startsWith(b+' ')||b.startsWith(a+' ');}
function buildingKey(address:string){const q=geocodingAddress(address),m=q.match(/([^\s]+(?:로|길))\s*(\d+)(?:-(\d+))?$/)??q.match(/([^\s]+[동리가])\s+(\d+)(?:-(\d+))?$/);return m?compact(m[1])+':'+Number(m[2])+':'+Number(m[3]||0):'';}
export function applyOfficialLocation(f:Facility,official:Facility,complete:boolean){
  if(f.source!=='facilities'||!f.service_institution_id||f.service_institution_id!==official.service_institution_id||!official.province||f.province&&f.province!==official.province)return false;
  const before=JSON.stringify(f),oldKey=buildingKey(f.address),newKey=buildingKey(official.address),sameAddress=!!oldKey&&oldKey===newKey;
  const fresh=official.source_date>=collectionDay(f.detail_checked_at??f.collected_at),specific=!!newKey,physical=physicalFacilityRegion(official.address);
  const registryIdentity=/^C[A-Za-z0-9_-]+$/.test(f.service_institution_id),canAdopt=complete&&(fresh||!oldKey)&&registryIdentity&&specific&&physical.matched;
  if(canAdopt&&f.address!==official.address){
    f.registry_address??=f.address;
    if(!sameAddress){f.latitude=null;f.longitude=null;delete f.coordinate_source;delete f.coordinate_source_url;delete f.coordinate_checked_at;delete f.coordinate_query;delete f.coordinate_validation;}
    f.address=official.address;f.province=physical.province;f.district=physical.district;
  }
  if(complete&&(canAdopt||sameAddress)){
    if((fresh||!f.phone)&&official.phone&&official.phone!==f.phone){if(f.registry_phone===undefined)f.registry_phone=f.phone;f.phone=official.phone;}
    if(fresh&&/[*●○]/.test(f.name)&&!/[*●○]/.test(official.name)){f.registry_name??=f.name;f.name=official.name;}
  }
  if(specific&&(sameAddress||canAdopt)&&valid(official.latitude,official.longitude)){
    f.latitude=official.latitude;f.longitude=official.longitude;f.coordinate_source='bokjiro-map';f.coordinate_source_url=official.source_url;f.coordinate_checked_at=official.collected_at;f.coordinate_validation=canAdopt?'official-service-id':'official-service-id-and-address';
  }
  if(before!==JSON.stringify(f))f.location_evidence={source:'bokjiro-map',url:official.source_url,record_id:official.source_id,service_id:f.service_institution_id,address:official.address,checked_at:official.collected_at};
  return before!==JSON.stringify(f);
}
function sameBuilding(query:string,doc:any){
  const road=query.match(/([^\s]+(?:로|길))\s*(\d+)(?:-(\d+))?$/);
  if(road){const r=doc.road_address;return !!r&&compact(r.road_name??'')===compact(road[1])&&Number(r.main_building_no)===Number(road[2])&&Number(r.sub_building_no||0)===Number(road[3]||0);}
  const parcel=query.match(/([^\s]+[동리가])\s+(\d+)(?:-(\d+))?$/),a=doc.address;
  return !!parcel&&!!a&&compact(a.region_3depth_name??'')===compact(parcel[1])&&Number(a.main_address_no)===Number(parcel[2])&&Number(a.sub_address_no||0)===Number(parcel[3]||0);
}
export async function resolveOfficialAddress(key:string,address:string,province:string,district:string):Promise<Result>{
  const query=geocodingAddress(address),checked_at=new Date().toISOString();
  const unresolved=(reason:string):Result=>({address,query,status:'unresolved',latitude:null,longitude:null,checked_at,reason});
  if(!query)return unresolved('공개된 도로명·건물번호 또는 지번 확인 필요');
  let response:Response;
  try{response=await fetch(sourceUrl+'?query='+encodeURIComponent(query),{headers:{Authorization:'KakaoAK '+key},signal:AbortSignal.timeout(10000)});}catch{throw Error('주소 좌표 API 연결 실패. 확인된 자료는 유지되며 같은 지점에서 재시도할 수 있습니다.');}
  if(!response.ok)throw Error(response.status===429?'카카오 주소 API 호출 한도에 도달했습니다. 유료 전환 없이 다음 갱신에서 이어갑니다.':'주소 좌표 API 요청 실패 (HTTP '+response.status+'). 기존 자료와 진행 지점을 유지합니다.');
  const body:any=await response.json();if(!Array.isArray(body.documents))throw Error('주소 좌표 API 응답 형식 검증 실패');
  if(body.documents.length!==1)return unresolved(body.documents.length?'주소 결과가 여러 건이라 확정하지 않음':'일치하는 상세 주소 없음');
  const doc=body.documents[0],latitude=Number(doc.y),longitude=Number(doc.x),a=doc.address??doc.road_address;
  if(!Number.isFinite(latitude)||!Number.isFinite(longitude))throw Error('주소 좌표 API 응답 형식 검증 실패');
  if(!valid(latitude,longitude))return unresolved('대한민국 내 좌표 범위 검증 실패');
  if(!a||!a.region_1depth_name||(!a.region_2depth_name&&a.region_1depth_name!=='세종특별자치시')||!(doc.road_address?.main_building_no||doc.address?.main_address_no))return unresolved('건물·지번 단위 응답 확인 필요');
  const region=regionNames(a.region_1depth_name,a.region_2depth_name);
  if(province&&region.province!==province||district&&!sameDistrict(district,region.district))return unresolved('공식 원천의 지역과 주소 결과가 일치하지 않음');
  if(!sameBuilding(query,doc))return unresolved('공식 주소의 도로명·건물번호 또는 지번과 응답이 일치하지 않음');
  return {address,query,status:'confirmed',latitude,longitude,checked_at,reason:null};
}

export async function applyCachedFacilityCoordinates(db:D1Database,run:string){
  await db.batch([
    db.prepare(`UPDATE facilities AS f SET latitude=c.latitude,longitude=c.longitude,payload=json_set(f.payload,'$.latitude',c.latitude,'$.longitude',c.longitude,'$.coordinate_source','kakao-address','$.coordinate_checked_at',c.checked_at,'$.coordinate_query',c.query,'$.coordinate_validation','building')
      FROM facility_geocodes c WHERE f.source='facilities' AND f.run_id=? AND f.latitude IS NULL AND c.address=json_extract(f.payload,'$.address') AND c.status='confirmed' AND c.latitude BETWEEN 33 AND 39 AND c.longitude BETWEEN 124 AND 132`).bind(run),
    db.prepare(`UPDATE facility_entries AS e SET latitude=f.latitude,longitude=f.longitude FROM facilities f WHERE e.source='facilities' AND e.run_id=? AND f.source=e.source AND f.run_id=e.run_id AND f.id=e.id AND f.latitude IS NOT NULL AND e.latitude IS NULL`).bind(run),
  ]);
}

export async function enrichFacilityCoordinates(env:Bindings){
  const db=env.DB!,now=new Date().toISOString(),stateName='facility_geocoding';
  const versions=(await db.prepare("SELECT source,active_run_id FROM source_state WHERE source IN ('activity_support','directory','facilities') AND active_run_id IS NOT NULL ORDER BY source").all<{source:string;active_run_id:string}>()).results;
  const officialState=await db.prepare("SELECT metadata,status FROM source_state WHERE source='official_map'").first<{metadata:string;status:string}>(),officialMeta=officialState?JSON.parse(officialState.metadata):{},officialRun=officialMeta.usable_run_id??officialMeta.validated_run_id??'';
  const officialComplete=officialState?.status==='ready'&&officialMeta.validated_run_id===officialRun;
  const generation=JSON.stringify({versions,officialRun,officialRevision:[officialMeta.processed??0,officialMeta.matched??0]});
  const prior=await db.prepare('SELECT * FROM source_state WHERE source=?').bind(stateName).first<any>();
  let meta:any=prior?JSON.parse(prior.metadata):{};
  if(meta.generation===generation&&prior?.status==='ready')return {source:'facilities' as const,phase:stateName,status:'already_current' as const,done:true,processed:meta.processed,total:meta.total,coordinatesConfirmed:meta.confirmedRecords};
  if(!env.KAKAO_REST_KEY)return {source:'facilities' as const,phase:stateName,status:'needs_key' as const,done:true,error:'좌표 보완에는 서버 카카오 키가 필요합니다. 공식 주소·연락처는 계속 사용할 수 있습니다.'};
  if(meta.generation!==generation){
    const count=await db.prepare("SELECT count(*) n,sum(CASE WHEN f.latitude IS NOT NULL AND f.longitude IS NOT NULL THEN 1 ELSE 0 END) confirmed FROM facilities f JOIN source_state s ON f.source=s.source AND f.run_id=s.active_run_id WHERE f.source IN ('activity_support','directory','facilities')").first<{n:number;confirmed:number}>();
    const skipKnown=officialComplete&&officialMeta.mode==='official_snapshot'&&officialMeta.appliedDuringCollection;
    meta={generation,sourceVersions:versions,runId:crypto.randomUUID(),cursorSource:'',cursorId:'',skipKnown,processed:skipKnown?count?.confirmed??0:0,total:count?.n??0,confirmedRecords:count?.confirmed??0,unresolvedRecords:(count?.n??0)-(count?.confirmed??0)};
    await db.batch([
      db.prepare("INSERT INTO sync_runs(id,source,status,checkpoint,processed,total,started_at,updated_at) VALUES(?,?,'running',?,0,?,?,?)").bind(meta.runId,stateName,JSON.stringify(meta),meta.total,now,now),
      db.prepare("INSERT INTO source_state(source,active_run_id,status,metadata) VALUES(?,?,'syncing',?) ON CONFLICT(source) DO UPDATE SET active_run_id=excluded.active_run_id,status='syncing',metadata=excluded.metadata,last_error=NULL").bind(stateName,meta.runId,JSON.stringify(meta)),
    ]);
  }
  try{
    const negativeAfter=new Date(Date.now()-7*86400000).toISOString();
    const officialJoins=meta.skipKnown?'':`LEFT JOIN facility_entries oe INDEXED BY facility_entries_identity ON oe.source='official_map' AND oe.run_id=? AND oe.identity='official-srv:'||json_extract(f.payload,'$.service_institution_id') AND NOT EXISTS(SELECT 1 FROM facility_entries ox INDEXED BY facility_entries_identity WHERE ox.source=oe.source AND ox.run_id=oe.run_id AND ox.identity=oe.identity AND ox.id<>oe.id) LEFT JOIN facilities o ON o.source=oe.source AND o.run_id=oe.run_id AND o.id=oe.id`;
    const queryArgs=[...(meta.skipKnown?[]:[officialRun]),negativeAfter,meta.skipKnown?1:0,meta.cursorSource,meta.cursorSource,meta.cursorId];
    const rows=(await db.prepare(`SELECT f.source,f.id,f.run_id,f.payload,${meta.skipKnown?'NULL':'o.payload'} official_payload,c.status cached_status,c.latitude cached_latitude,c.longitude cached_longitude,c.checked_at cached_checked_at,c.query cached_query,c.reason cached_reason
      FROM facilities f JOIN source_state s ON f.source=s.source AND f.run_id=s.active_run_id
      ${officialJoins}
      LEFT JOIN facility_geocodes c ON c.address=json_extract(f.payload,'$.address') AND (c.status='confirmed' OR c.checked_at>=?)
      WHERE f.source IN ('activity_support','directory','facilities') AND (?=0 OR f.latitude IS NULL OR f.longitude IS NULL) AND (f.source>? OR (f.source=? AND f.id>?)) ORDER BY f.source,f.id LIMIT 600`).bind(...queryArgs).all<Pick>()).results;
    if(!rows.length&&meta.processed<meta.total)throw Error('좌표 보완 중 원천 구성이 변경됐습니다. 현재 자료를 유지하고 새 원천 기준으로 재개하세요.');
    const picked:{row:Pick;f:Facility;cached:Result|null;regionChanged:boolean}[]=[],pending=new Map<string,Facility>();
    for(const row of rows){
      const f:Facility=JSON.parse(row.payload),originalAddress=f.address,originalPhone=f.phone;f.phone=publicFacilityPhone(f.phone);const phoneChanged=f.phone!==originalPhone;
      if(phoneChanged&&f.source==='facilities'&&f.registry_phone===undefined)f.registry_phone=originalPhone;
      const officialChanged=row.official_payload?applyOfficialLocation(f,JSON.parse(row.official_payload),officialComplete):false;
      let cached=row.cached_status&&originalAddress===f.address?{address:f.address,status:row.cached_status,latitude:row.cached_latitude,longitude:row.cached_longitude,checked_at:row.cached_checked_at!,query:row.cached_query!,reason:row.cached_reason}:null;
      const physical=physicalFacilityRegion(f.address),regionChanged=phoneChanged||officialChanged||physical.matched&&(physical.province!==f.province||physical.district!==f.district);
      if(physical.matched){f.province=physical.province;f.district=physical.district;}
      if(cached?.status!=='confirmed'&&(regionChanged||f.province==='세종특별자치시'&&cached?.reason==='건물·지번 단위 응답 확인 필요'))cached=null;
      const needs=!valid(f.latitude,f.longitude)&&!cached&&!!geocodingAddress(f.address);
      if(needs&&!pending.has(f.address)&&pending.size>=24)break;
      picked.push({row,f,cached,regionChanged});if(needs)pending.set(f.address,f);
    }
    const outcomes=new Map<string,Result>(),failures=new Map<string,string>(),toFetch=[...pending.values()];let next=0;
    await Promise.all(Array.from({length:Math.min(6,toFetch.length)},async()=>{
      while(next<toFetch.length){const f=toFetch[next++];try{outcomes.set(f.address,await resolveOfficialAddress(env.KAKAO_REST_KEY!,f.address,f.province,f.district));}catch(e){failures.set(f.address,e instanceof Error?e.message:'주소 좌표 확인 실패');}}
    }));
    const cacheWrites=new Map(outcomes);const updates=new Map<string,{run:string;source:string;rows:Facility[]}>();
    const save=(row:Pick,f:Facility)=>{const key=row.source+'|'+row.run_id;if(!updates.has(key))updates.set(key,{source:row.source,run:row.run_id,rows:[]});const group=updates.get(key)!;if(!group.rows.some(v=>v.id===f.id))group.rows.push(f);};
    let contiguous=true,advanced=0;
    for(const {row,f,cached,regionChanged} of picked){
      const failed=failures.get(f.address);if(failed)contiguous=false;
      if(contiguous){meta.cursorSource=row.source;meta.cursorId=row.id;advanced++;}
      if(regionChanged)save(row,f);
      if(valid(f.latitude,f.longitude)){
        if(f.address&&!cached&&f.coordinate_source==='kakao-address'&&f.coordinate_validation==='building')cacheWrites.set(f.address,{address:f.address,query:f.coordinate_query??f.address,status:'confirmed',latitude:f.latitude,longitude:f.longitude,checked_at:f.coordinate_checked_at??now,reason:null});
        continue;
      }
      const result=cached??outcomes.get(f.address);if(!result)continue;
      if(result.status==='confirmed'&&valid(result.latitude,result.longitude)){
        Object.assign(f,{latitude:result.latitude,longitude:result.longitude,coordinate_source:'kakao-address',coordinate_checked_at:result.checked_at,coordinate_query:result.query,coordinate_validation:'building'});
        save(row,f);
      }
    }
    await writeChunks(db,[...cacheWrites.values()].map(c=>db.prepare('INSERT OR REPLACE INTO facility_geocodes(address,query,status,latitude,longitude,checked_at,reason,source_url) VALUES(?,?,?,?,?,?,?,?)').bind(c.address,c.query,c.status,c.latitude,c.longitude,c.checked_at,c.reason,sourceUrl)));
    for(const u of updates.values())await writeFacilities(db,u.source,u.run,u.rows);
    meta.processed+=advanced;meta.updatedAt=new Date().toISOString();meta.error=failures.size?[...failures.values()][0]:null;
    const counts=await db.prepare("SELECT count(*) total,sum(CASE WHEN f.latitude IS NOT NULL AND f.longitude IS NOT NULL THEN 1 ELSE 0 END) confirmed,sum(CASE WHEN trim(f.address)!='' THEN 1 ELSE 0 END) with_address,sum(CASE WHEN coalesce(f.phone,'')!='' THEN 1 ELSE 0 END) with_phone FROM facility_entries f JOIN source_state s ON f.source=s.source AND f.run_id=s.active_run_id WHERE f.source IN ('activity_support','directory','facilities')").first<{total:number;confirmed:number;with_address:number;with_phone:number}>();
    meta.confirmedRecords=counts?.confirmed??0;meta.unresolvedRecords=(counts?.total??meta.total)-meta.confirmedRecords;
    meta.recordsWithAddress=counts?.with_address??0;meta.recordsWithPhone=counts?.with_phone??0;
    const done=!failures.size&&meta.processed>=meta.total,status=failures.size?'failed':done?'ready':'syncing';
    await db.batch([
      db.prepare('UPDATE source_state SET status=?,last_error=?,last_success=CASE WHEN ? THEN ? ELSE last_success END,metadata=? WHERE source=?').bind(status,meta.error,done?1:0,now,JSON.stringify(meta),stateName),
      db.prepare('UPDATE sync_runs SET status=?,checkpoint=?,processed=?,updated_at=?,error=?,finished_at=CASE WHEN ? THEN ? ELSE finished_at END WHERE id=?').bind(failures.size?'failed':done?'succeeded':'running',JSON.stringify(meta),meta.processed,meta.updatedAt,meta.error,done?1:0,now,meta.runId),
      ...updates.size?[db.prepare("UPDATE source_state SET metadata='{}' WHERE source='facility_index'")]:[],
    ]);
    return {source:'facilities' as const,phase:stateName,status:failures.size?'failed' as const:done?'ready' as const:'running' as const,done,processed:meta.processed,total:meta.total,coordinatesConfirmed:meta.confirmedRecords,...meta.error?{error:meta.error}:{}};
  }catch(e){
    const error=e instanceof Error?e.message:'기관 좌표 보완 실패';
    await db.prepare("UPDATE source_state SET status='failed',last_error=? WHERE source=?").bind(error,stateName).run();
    return {source:'facilities' as const,phase:stateName,status:'failed' as const,done:false,error};
  }
}

// A fully checked directory refresh can reuse the completed registry audit.
// Recount against the new directory generation instead of hiding valid progress.
export async function reconcileCompletedCoordinates(db:D1Database){
  const state=await db.prepare("SELECT metadata FROM source_state WHERE source='facility_geocoding' AND status='ready'").first<{metadata:string}>();if(!state)return;
  const meta=JSON.parse(state.metadata),versions=(await db.prepare("SELECT source,active_run_id FROM source_state WHERE source IN ('activity_support','directory','facilities') AND active_run_id IS NOT NULL ORDER BY source").all<{source:string;active_run_id:string}>()).results;
  const registry=versions.find(s=>s.source==='facilities');if(!registry||!meta.sourceVersions?.some((s:any)=>s.source===registry.source&&s.active_run_id===registry.active_run_id))return;
  const official=await db.prepare("SELECT metadata FROM source_state WHERE source='official_map'").first<{metadata:string}>(),om=official?JSON.parse(official.metadata):{};
  const count=await db.prepare("SELECT count(*) total,sum(CASE WHEN f.latitude IS NOT NULL AND f.longitude IS NOT NULL THEN 1 ELSE 0 END) confirmed,sum(CASE WHEN trim(f.address)!='' THEN 1 ELSE 0 END) with_address,sum(CASE WHEN coalesce(f.phone,'')!='' THEN 1 ELSE 0 END) with_phone FROM facility_entries f JOIN source_state s ON f.source=s.source AND f.run_id=s.active_run_id WHERE f.source IN ('activity_support','directory','facilities')").first<any>();
  const now=new Date().toISOString();Object.assign(meta,{sourceVersions:versions,generation:JSON.stringify({versions,officialRun:om.usable_run_id??om.validated_run_id??'',officialRevision:[om.processed??0,om.matched??0]}),processed:count.total,total:count.total,confirmedRecords:count.confirmed,unresolvedRecords:count.total-count.confirmed,recordsWithAddress:count.with_address,recordsWithPhone:count.with_phone,updatedAt:now,reconciledDirectoryAt:now});
  await db.batch([
    db.prepare("UPDATE source_state SET metadata=?,last_success=?,last_error=NULL WHERE source='facility_geocoding' AND status='ready'").bind(JSON.stringify(meta),now),
    db.prepare("UPDATE sync_runs SET checkpoint=?,processed=?,total=?,updated_at=? WHERE id=? AND status='succeeded'").bind(JSON.stringify(meta),count.total,count.total,now,meta.runId),
  ]);
}
