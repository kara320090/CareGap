import {flattenText,collectionDay} from './domain';
import {physicalFacilityRegion,regionNames,publicFacilityPhone} from './sources';
import {writeFacilities} from './store';
import type {Bindings,Facility} from './types';
import {applyOfficialLocation} from './facility-geocoding';

export const officialMapUrl='https://www.bokjiro.go.kr/ssis-tbu/twatca/wlfcl/wlfclPage.do';
const base='https://www.bokjiro.go.kr/ssis-tbu/twatca/wlfcl/';
const fields='roDeSiDo roDeSiGunGu roDeMyung roDeGuBun siSulFullCnt errorFlag siSulMyungRoDe bkjrMngFaclId bkjrMngFaclDcd srvInstId faclNm bkjrMngFaclTypGrpcd faclRprsvFlnm faclBrno faclHmpgUrl faclEmadr zip faclRdnmadr faclRdnmDtladr faclTelno faclFxno safeInspYn slesYn entcFxcnt entcCurmbrNt empmNope nrtrScstfNt specTchrNt etcNrtrScstfNt nrsrmNt plgrNt bldar fndnYmd faclLa faclLo faclLnmadr atdscCarsOperYn etcCn ctpvNm emdNm faclStdgCd faclTypEtcCn fclhdNope sggNm useYn currentPageIndex pageRowCount totalRowCount viewPageCount addrNm bkjrMngFaclDcdStr bkjrMngFaclTypGrpcdStr daumMapApiKey locFaclLo locFaclLa banKyungVal addrnm bk bkTime bkh bkm searchType ttttt pneuMdlcnstDnm rehabtCertInstDnm bfCertHistSn'.split(' ');
const defaults=Object.fromEntries(fields.map(k=>[k,'']));
const pageSize=1000;
type Area={province:string;district:string};
async function request(path:string,params:Record<string,unknown>){
  const body=new TextEncoder().encode(JSON.stringify({dmParam:{...defaults,...params}}));
  const response=await fetch(base+path,{method:'POST',headers:{'Content-Type':'application/json;charset=UTF-8','Content-Length':String(body.byteLength),Accept:'application/json',Referer:officialMapUrl,'User-Agent':'CareGap/1.0 (+https://caregap-hybon-welfare20.hybonair.chatgpt.site)'},body,signal:AbortSignal.timeout(30000)});
  if(!response.ok)throw Error('복지로 공식 지도 원천 응답 실패 (HTTP '+response.status+')');
  return response;
}

// The map response also includes a full marker dataset. Read only the bounded
// requested page, then cancel the remaining body instead of retaining that dataset.
export async function readOfficialMapPage(response:Response):Promise<{rows:any[];total:number}>{
  if(!response.body)throw Error('복지로 지도 응답이 없습니다.');
  const reader=response.body.getReader(),decoder=new TextDecoder();let buffer='',start=-1,scan=0,depth=0,inString=false,escaped=false;
  try{
    for(;;){
      const part=await reader.read();buffer+=decoder.decode(part.value??new Uint8Array(),{stream:!part.done});
      if(buffer.length>6_000_000)throw Error('복지로 지도 페이지 크기 검증 실패');
      if(start<0){const m=/"dsTsbBkjrMngFaclList"\s*:\s*\[/.exec(buffer);if(m){start=m.index+m[0].length-1;scan=start+1;depth=1;}}
      if(start>=0){
        for(;scan<buffer.length;scan++){
          const c=buffer[scan];
          if(inString){if(escaped)escaped=false;else if(c==='\\')escaped=true;else if(c==='"')inString=false;continue;}
          if(c==='"'){inString=true;continue;}if(c==='['||c==='{')depth++;else if(c===']'||c==='}')depth--;
          if(depth===0){
            const parsed=JSON.parse(buffer.slice(0,scan+1).replace(/^\uFEFF/,'')+'}'),rows=parsed.dsTsbBkjrMngFaclList,count=parsed.dmParam?.totalRowCount;
            if(!Array.isArray(rows)||!/^\d+$/.test(String(count))||rows.length>Number(count))throw Error('복지로 지도 목록·전체 건수 검증 실패');
            return {rows,total:Number(count)};
          }
        }
      }
      if(part.done)throw Error('복지로 지도 응답 형식이 바뀌어 반영을 보류했습니다.');
    }
  }finally{try{await reader.cancel();}catch{}}
}
async function mapPage(area:Area,page:number){
  return readOfficialMapPage(await request('wlfclList.do',{searchType:'002',roDeSiDo:area.province,roDeSiGunGu:area.district,bkjrMngFaclTypGrpcd:'10',currentPageIndex:page,pageRowCount:pageSize,viewPageCount:3,siSulFullCnt:10000,banKyungVal:'001',locFaclLo:126.99103591027158,locFaclLa:37.56178922317575}));
}
async function master(){
  const data:any=await (await request('sidoList.do',{})).json();
  if(!Array.isArray(data.dsSiDoList)||data.dsSiDoList.length<10)throw Error('복지로 지도 시도 목록 검증 실패 (fields='+Object.keys(data).slice(0,8).join(',')+'; status='+String(data.dmMessage?.status??'unknown')+'; code='+String(data.dmMessage?.msgCd??data.dmMessage?.code??'unknown')+')');
  const provinces=[...new Set<string>(data.dsSiDoList.map((r:any)=>flattenText(r.sido)).filter(Boolean))],regions:Area[]=[];let next=0;
  await Promise.all(Array.from({length:4},async()=>{
    while(next<provinces.length){
      const province=provinces[next++],body:any=await (await request('siGunGuList.do',{roDeSiDo:province})).json();
      if(!Array.isArray(body.dsSiGunGuList))throw Error('복지로 지도 시군구 목록 검증 실패');
      const names=[...new Set<string>(body.dsSiGunGuList.map((r:any)=>flattenText(r.sigungu)).filter(Boolean))];
      const leaves=names.filter(d=>!names.some(n=>n!==d&&n.startsWith(d+' ')));
      for(const district of leaves.length?leaves:[''])regions.push({province,district});
    }
  }));
  if(regions.length<100)throw Error('복지로 지도 지역 전체 건수 검증 실패');
  return regions.sort((a,b)=>(a.province+' '+a.district).localeCompare(b.province+' '+b.district,'ko'));
}
export async function inspectOfficialMapSource(){
  const checkedAt=new Date().toISOString();
  try{const response=await request('sidoList.do',{}),data:any=await response.json();return {checkedAt,ok:Array.isArray(data.dsSiDoList)&&data.dsSiDoList.length>=10,httpStatus:response.status,regionCount:Array.isArray(data.dsSiDoList)?data.dsSiDoList.length:null,responseFields:Object.keys(data).slice(0,8),errorCode:data.dmMessage?.msgCd??data.dmMessage?.code??null};}
  catch(error){return {checkedAt,ok:false,error:error instanceof Error?error.message:'공식 지도 연결 확인 실패'};}
}
export function normalizeOfficialMap(raw:any,at=new Date().toISOString()):Facility{
  const sourceId=flattenText(raw.bkjrMngFaclId),serviceId=flattenText(raw.srvInstId),name=flattenText(raw.faclNm);
  if(!sourceId||!serviceId||!name)throw Error('복지로 공식 기관 식별정보 검증 실패');
  const address=flattenText(raw.addrNm)||[flattenText(raw.faclRdnmadr),flattenText(raw.faclRdnmDtladr)].filter(Boolean).join(' ');
  const physical=physicalFacilityRegion(address),region=physical.matched?physical:regionNames(flattenText(raw.ctpvNm),flattenText(raw.sggNm));
  const latitude=Number(raw.faclLa),longitude=Number(raw.faclLo),valid=latitude>=33&&latitude<=39&&longitude>=124&&longitude<=132;
  return {id:'official-map:'+sourceId,source_id:sourceId,source:'official_map',service_institution_id:serviceId,name,address,phone:publicFacilityPhone(raw.faclTelno),province:region.province,district:region.district,latitude:valid?latitude:null,longitude:valid?longitude:null,kind:flattenText(raw.bkjrMngFaclDcdStr)||'사회복지시설',role:'related',service_ids:[],evidence_url:null,source_url:officialMapUrl,source_date:collectionDay(at),collected_at:at,coordinate_source:'bokjiro-map',coordinate_source_url:officialMapUrl,coordinate_checked_at:at,coordinate_validation:'official-record'};
}

export async function applyVerifiedSnapshotLocations(db:D1Database,baseRunId:string,official:Facility[],registry:Map<string,Facility>){
  const updates:Facility[]=[];
  for(const location of official){
    const facility=registry.get('facilities:'+location.service_institution_id);
    if(facility&&applyOfficialLocation(facility,location,true))updates.push(facility);
  }
  if(updates.length)await writeFacilities(db,'facilities',baseRunId,updates);
  return updates.length;
}

export async function syncOfficialMap(env:Bindings,baseRunId:string,refreshLive=false){
  const db=env.DB!,source='official_map',now=new Date().toISOString();
  const row=await db.prepare('SELECT * FROM source_state WHERE source=?').bind(source).first<any>();let meta:any=row?JSON.parse(row.metadata):{};
  const restart=refreshLive&&row?.status==='ready'&&(meta.mode==='official_snapshot'||!row.last_success||collectionDay(row.last_success)!==collectionDay(now));
  if(!restart&&meta.baseRunId===baseRunId&&row?.status==='ready'&&row.last_success)return {source:'facilities' as const,phase:source,status:'already_current' as const,done:true};
  if(meta.baseRunId===baseRunId&&meta.retryAfter&&meta.retryAfter>now&&(meta.snapshotAttempted||Array.isArray(meta.regions)))return {source:'facilities' as const,phase:'official_map_deferred',status:'already_current' as const,done:true};
  try{
    if(restart||meta.baseRunId!==baseRunId||!meta.runId||!Array.isArray(meta.regions)){
      const previous=meta.validated_run_id??null;meta={baseRunId,validated_run_id:previous,usable_run_id:previous};
      let regions:Area[],fallback:any={};
      try{
        const initial=!refreshLive&&!meta.validated_run_id?(await import('./official-location-snapshot')).officialSnapshotManifest():null;
        if(initial&&collectionDay(initial.collected_at)===collectionDay(now)){
          regions=initial.regions;fallback={mode:'official_snapshot',chunkIndex:0,chunks:initial.chunks.length,snapshotCollectedAt:initial.collected_at,snapshotAttempted:true,liveError:row?.last_error??null,expectedTotal:initial.count};
        }else regions=await master();
      }
      catch(error){
        if(refreshLive&&previous)throw error;
        const snapshot=(await import('./official-location-snapshot')).officialSnapshotManifest();
        if(!snapshot || Date.parse(now)-Date.parse(snapshot.collected_at)>7*86400000)throw error;
        regions=snapshot.regions;fallback={mode:'official_snapshot',chunkIndex:0,chunks:snapshot.chunks.length,snapshotCollectedAt:snapshot.collected_at,snapshotAttempted:true,liveError:error instanceof Error?error.message:'공식 지도 연결 실패',expectedTotal:snapshot.count};
      }
      meta={baseRunId,runId:crypto.randomUUID(),regions,regionIndex:0,page:1,regionProcessed:0,regionTotal:null,processed:0,expectedTotal:0,matched:0,validated_run_id:meta.validated_run_id??null,usable_run_id:meta.validated_run_id??null,...fallback};
      await db.batch([
        db.prepare("INSERT INTO sync_runs(id,source,status,checkpoint,processed,total,started_at,updated_at) VALUES(?,?,'running',?,0,NULL,?,?)").bind(meta.runId,source,JSON.stringify(meta),now,now),
        db.prepare("INSERT INTO source_state(source,status,metadata) VALUES(?,'syncing',?) ON CONFLICT(source) DO UPDATE SET status='syncing',metadata=excluded.metadata,last_error=NULL").bind(source,JSON.stringify(meta)),
      ]);
      return {source:'facilities' as const,phase:source,status:'running' as const,done:false,processed:0,total:null};
    }
    const snapshot=meta.mode==='official_snapshot';
    const area=meta.regions[meta.regionIndex] as Area,page= snapshot?await (await import('./official-location-snapshot')).officialSnapshotChunk(meta.chunkIndex):await mapPage(area,meta.page);
    if(snapshot){
      if(page.total!==meta.expectedTotal||!page.rows.length)throw Error('공식 기관 보완본 전체 건수 변경 감지');
    }else{
      if(page.rows.length>pageSize)throw Error('복지로 지도 페이지 상한이 변경되어 반영을 보류했습니다.');
      if(meta.page===1&&meta.regionTotal===null){meta.regionTotal=page.total;meta.expectedTotal+=page.total;}
      if(page.total!==meta.regionTotal||page.rows.length===0&&meta.regionProcessed<page.total)throw Error('복지로 지도 지역 목록이 수집 도중 변경되어 반영을 보류했습니다.');
      if(page.rows.length<pageSize&&meta.regionProcessed+page.rows.length<page.total)throw Error('복지로 지도 응답의 페이지 크기가 달라 누락을 방지했습니다.');
    }
    const candidates=page.rows.filter(r=>flattenText(r.srvInstId)&&flattenText(r.bkjrMngFaclId)&&flattenText(r.faclNm)).map(r=>normalizeOfficialMap(r,snapshot?meta.snapshotCollectedAt:now));
    if(page.rows.length&&!candidates.length)throw Error('복지로 지도 기관 ID 응답 형식 검증 실패');
    const ids=[...new Set(candidates.map(f=>'facilities:'+f.service_institution_id))],found=new Set<string>(),registry=new Map<string,Facility>();
    if(ids.length){
      const result=await db.prepare("SELECT id,payload FROM facilities WHERE source='facilities' AND run_id=? AND id IN (SELECT value FROM json_each(?))").bind(baseRunId,JSON.stringify(ids)).all<{id:string;payload:string}>();
      for(const f of result.results){found.add(f.id);registry.set(f.id,JSON.parse(f.payload));}
    }
    const matched=candidates.filter(f=>found.has('facilities:'+f.service_institution_id));
    await writeFacilities(db,source,meta.runId,matched);
    if(snapshot){
      await applyVerifiedSnapshotLocations(db,baseRunId,matched,registry);meta.appliedDuringCollection=true;
      await db.prepare("UPDATE source_state SET metadata='{}' WHERE source='facility_index'").run();
    }
    meta.processed+=page.rows.length;meta.regionProcessed+=page.rows.length;meta.usable_run_id=meta.runId;meta.retryAfter=null;
    if(snapshot){meta.chunkIndex++;meta.regionIndex=(page as any).regionsDone;}
    else if(meta.regionProcessed===meta.regionTotal){meta.regionIndex++;meta.page=1;meta.regionProcessed=0;meta.regionTotal=null;}else if(meta.regionProcessed<meta.regionTotal)meta.page++;else throw Error('복지로 지도 지역 건수 검증 실패');
    const count=await db.prepare("SELECT count(*) n FROM facilities WHERE source=? AND run_id=?").bind(source,meta.runId).first<{n:number}>();meta.matched=count?.n??0;
    const done=snapshot?meta.chunkIndex>=meta.chunks:meta.regionIndex>=meta.regions.length;if(done){if(meta.processed!==meta.expectedTotal)throw Error('복지로 지도 조회 전체 건수 검증 실패');meta.validated_run_id=meta.runId;}
    meta.updatedAt=new Date().toISOString();
    await db.batch([
      db.prepare('UPDATE source_state SET status=?,last_error=NULL,last_success=CASE WHEN ? THEN ? ELSE last_success END,metadata=? WHERE source=?').bind(done?'ready':'syncing',done?1:0,snapshot?meta.snapshotCollectedAt:now,JSON.stringify(meta),source),
      db.prepare('UPDATE sync_runs SET status=?,checkpoint=?,processed=?,total=?,updated_at=?,finished_at=CASE WHEN ? THEN ? ELSE finished_at END WHERE id=?').bind(done?'succeeded':'running',JSON.stringify(meta),meta.processed,done?meta.expectedTotal:null,meta.updatedAt,done?1:0,now,meta.runId),
    ]);
    if(done){
      const previous=row?JSON.parse(row.metadata).validated_run_id:null,keep=[...new Set([meta.runId,...previous?[previous]:[]])];
      for(const table of ['facilities','facility_entries'])await db.prepare('DELETE FROM '+table+' WHERE source=? AND run_id NOT IN ('+keep.map(()=>'?').join(',')+')').bind(source,...keep).run();
    }
    return {source:'facilities' as const,phase:source,status:done?'ready' as const:'running' as const,done,processed:meta.processed,total:done?meta.expectedTotal:null,matched:meta.matched,pageMatched:matched.length,livePage:!snapshot};
  }catch(e){
    const error=e instanceof Error?e.message:'공식 지도 자료 보완 실패';meta.retryAfter=new Date(Date.now()+300000).toISOString();meta.error=error;meta.snapshotAttempted=true;
    await db.prepare("INSERT INTO source_state(source,status,last_error,metadata) VALUES(?,'failed',?,?) ON CONFLICT(source) DO UPDATE SET status='failed',last_error=excluded.last_error,metadata=excluded.metadata").bind(source,error,JSON.stringify(meta)).run();
    return {source:'facilities' as const,phase:'official_map_retry_later',status:'running' as const,done:false,error};
  }
}
