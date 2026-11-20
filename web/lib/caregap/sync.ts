import { sources, type Source, officialRegions, fetchText, parseDirectory, apiPage, serviceDetail, normalizeService, normalizeFacility } from './sources';
import { writeServices,writeFacilities } from './store';
import type { Bindings,Service,Facility } from './types';
import { collectionDay } from './domain';
import {backfillFacilityIndex,facilityIndexReady} from './facility-index';
import {facilitySummary} from './sql-queries';
import {enrichFacilityCoordinates,applyCachedFacilityCoordinates,reconcileCompletedCoordinates,resolveOfficialAddress} from './facility-geocoding';
import {syncOfficialMap} from './official-map';

export type SyncResult={source:Source;status:'needs_key'|'busy'|'already_current'|'running'|'ready'|'failed';done:boolean;processed?:number;total?:number|null;runId?:string;error?:string;phase?:string;coordinatesConfirmed?:number};
export async function syncSource(env:Bindings,source:Source,force=false):Promise<SyncResult>{
  const db=env.DB;if(!db)throw Error('D1 데이터베이스가 연결되지 않았습니다.');
  const now=new Date().toISOString(),owner=crypto.randomUUID();
  await db.prepare("INSERT OR IGNORE INTO source_state(source,status,metadata) VALUES(?,'not_collected','{}')").bind(source).run();
  if(['national','local','facilities'].includes(source)&&!env.DATA_GO_KR_KEY){
    await db.prepare("UPDATE source_state SET status='needs_key',last_error=? WHERE source=?").bind('공공데이터 API 활용 승인·인증키가 필요합니다.',source).run();
    return {source,status:'needs_key',done:true,processed:0};
  }
  await db.prepare('UPDATE source_state SET lease_owner=?,lease_until=? WHERE source=? AND (lease_until IS NULL OR lease_until<?)').bind(owner,new Date(Date.now()+300000).toISOString(),source,now).run();
  const state=await db.prepare('SELECT * FROM source_state WHERE source=?').bind(source).first<any>();
  if(state.lease_owner!==owner)return {source,status:'busy',done:false};
  let run:any;
  try{
    if(source==='facilities'&&!await facilityIndexReady(db))return {source,status:'running',done:false,...await backfillFacilityIndex(db)};
    if(!force&&state.last_success&&collectionDay(state.last_success)===collectionDay(now)&&state.status==='ready'&&(source!=='facilities'||JSON.parse(state.metadata).record_format==='facility-basic-v2')){
      if(source==='facilities'){
        const official=await syncOfficialMap(env,state.active_run_id);
        if(!official.done)return official;
        if(official.status==='ready')return {source,status:'running',done:false,phase:'facility_geocoding',processed:official.processed,total:official.total};
        return await enrichFacilityCoordinates(env);
      }
      return {source,status:'already_current',done:true};
    }
    run=await db.prepare("SELECT * FROM sync_runs WHERE source=? AND status IN ('running','failed') ORDER BY started_at DESC LIMIT 1").bind(source).first<any>();
    if(source==='facilities'&&run&&JSON.parse(run.checkpoint).mode!=='basic-v2'){
      await db.prepare("UPDATE sync_runs SET status='abandoned' WHERE id=?").bind(run.id).run();run=null;
    }
    if(force&&run?.status==='failed'){
      await db.prepare("UPDATE sync_runs SET status='abandoned' WHERE id=?").bind(run.id).run();run=null;
    }
    if(!run){
      run={id:crypto.randomUUID(),checkpoint:'{"page":1,"offset":0}',processed:0};
      await db.prepare("INSERT INTO sync_runs(id,source,status,checkpoint,processed,started_at,updated_at) VALUES(?,?,'running',?,0,?,?)").bind(run.id,source,run.checkpoint,now,now).run();
    }
    await db.prepare("UPDATE source_state SET status='syncing' WHERE source=?").bind(source).run();
    await db.prepare("UPDATE sync_runs SET status='running',error=NULL WHERE id=?").bind(run.id).run();
    let checkpoint=JSON.parse(run.checkpoint);let processed=run.processed;let total:number|null=null;let done=false;let coordinates:number|undefined;
    if(source==='regions'){
      const rows=await officialRegions();
      checkpoint={...checkpoint,collection_method:rows[0]?.source};
      // D1 batch executes atomically: never expose a half-replaced region master.
      await db.batch([db.prepare('DELETE FROM regions'),...rows.map(r=>db.prepare('INSERT INTO regions(id,province,district,source_date,payload) VALUES(?,?,?,?,?)').bind(r.id,r.province,r.district,r.source_date,JSON.stringify(r)))]);
      processed=rows.length;total=rows.length;done=true;
    }else if(source==='directory'){
      let rows:Facility[];
      if(checkpoint.phase==='geocode'){
        rows=(await db.prepare('SELECT payload FROM facilities WHERE source=? AND run_id=? ORDER BY id').bind(source,run.id).all<{payload:string}>()).results.map(r=>JSON.parse(r.payload));
      }else{
        rows=parseDirectory(await fetchText(sources.directory.url));
        const previous=(await db.prepare("SELECT f.id,f.latitude,f.longitude,json_extract(f.payload,'$.address') address,json_extract(f.payload,'$.coordinate_source') coordinate_source,json_extract(f.payload,'$.coordinate_checked_at') coordinate_checked_at,json_extract(f.payload,'$.coordinate_validation') coordinate_validation,json_extract(f.payload,'$.coordinate_query') coordinate_query FROM facilities f JOIN source_state s ON f.source=s.source AND f.run_id=s.active_run_id WHERE f.source='directory'").all<any>()).results;
        const byId=new Map(previous.map(f=>[f.id,f]));
        for(const f of rows){const p=byId.get(f.id);if(p?.address===f.address&&validCoordinates(p.latitude,p.longitude)&&p.coordinate_source&&p.coordinate_validation==='building'){f.latitude=p.latitude;f.longitude=p.longitude;f.coordinate_source=p.coordinate_source;f.coordinate_checked_at=p.coordinate_checked_at??undefined;f.coordinate_validation=p.coordinate_validation;f.coordinate_query=p.coordinate_query??undefined;}}
        await writeFacilities(db,source,run.id,rows);checkpoint={phase:'geocode',offset:0};
      }
      // Use the same order before and after checkpoint recovery.
      rows.sort((a,b)=>a.id.localeCompare(b.id,'en'));
      // Address geocoding is optional. Without a key, publish verified addresses and keep coordinates unknown.
      if(env.KAKAO_REST_KEY){
        const pending:Facility[]=[];let end=checkpoint.offset;
        // Initial seeding has a larger D1 write budget. Later calls can resolve 24
        // addresses while staying below the Worker's connection/subrequest limits.
        const limit=run.processed===0&&checkpoint.offset===0?8:24;
        while(end<rows.length&&pending.length<limit){const f=rows[end++];if(!validCoordinates(f.latitude,f.longitude))pending.push(f);}
        await concurrent(pending,4,async f=>{
          const result=await resolveOfficialAddress(env.KAKAO_REST_KEY!,f.address,f.province,f.district);
          if(result.status==='confirmed'){f.latitude=result.latitude;f.longitude=result.longitude;f.coordinate_source='kakao-address';f.coordinate_checked_at=result.checked_at;f.coordinate_query=result.query;f.coordinate_validation='building';f.coordinate_source_url='https://dapi.kakao.com/v2/local/search/address.json';}
        });
        if(pending.length)await writeFacilities(db,source,run.id,pending);
        checkpoint.offset=end;done=end>=rows.length;
      }else done=true;
      coordinates=rows.filter(f=>validCoordinates(f.latitude,f.longitude)).length;
      processed=done?rows.length:checkpoint.offset;total=rows.length;
    }else if(source==='facilities'){
      const records:Facility[]=[];let nextPage=checkpoint.page;
      // The provider caps list responses at 100 rows. Fetch contiguous pages;
      // never advance a cursor using the originally requested page size.
      const first=await apiPage(source,env.DATA_GO_KR_KEY!,nextPage);
      const extra=Math.min(9,Math.max(0,Math.ceil((first.total-processed-first.rows.length)/100)));
      const pages=[first,...await concurrent(Array.from({length:extra},(_,i)=>nextPage+i+1),3,page=>apiPage(source,env.DATA_GO_KR_KEY!,page))];
      for(const page of pages){
        if(total!==null&&total!==page.total)throw Error('수집 중 원천 건수가 변경되어 반영을 보류했습니다.');
        total=page.total;if(!page.rows.length&&processed<total)throw Error('시설 목록이 끝나기 전에 빈 페이지를 반환했습니다.');
        records.push(...page.rows.map(r=>normalizeFacility(r)));processed+=page.rows.length;nextPage++;
        if(processed>=total){done=true;break;}
      }
      await writeFacilities(db,source,run.id,records);checkpoint={page:nextPage,offset:0,mode:'basic-v2'};
      await applyCachedFacilityCoordinates(db,run.id);
      const saved=await db.prepare("SELECT count(*) n FROM facilities WHERE source='facilities' AND run_id=?").bind(run.id).first<{n:number}>();
      if(saved?.n!==processed)throw Error('서비스기관 ID의 고유 레코드 수가 수집 건수와 다릅니다 ('+(saved?.n??0)+'/'+processed+'). 기존 자료를 유지합니다.');
    }else{
      const page=await apiPage(source,env.DATA_GO_KR_KEY!,checkpoint.page);total=page.total;
      const end=Math.min(page.rows.length,checkpoint.offset+35);
      const pending=page.rows.slice(checkpoint.offset,end);
      let records:(Service|Facility)[];
      {
        const ids=pending.map(r=>String(r.servId));
        const previous=ids.length?(await db.prepare(`SELECT r.payload FROM services r JOIN source_state s ON r.source=s.source AND r.run_id=s.active_run_id WHERE r.source=? AND json_extract(r.payload,'$.source_id') IN (${ids.map(()=>'?').join(',')})`).bind(source,...ids).all<{payload:string}>()).results.map(r=>JSON.parse(r.payload) as Service):[];
        const previousById=new Map(previous.map(s=>[s.source_id,s]));
        records=await concurrent(pending,6,async raw=>{
          const existing=previousById.get(raw.servId);
          return existing&&raw.lastModYmd&&existing.source_date===raw.lastModYmd?{...existing,collected_at:new Date().toISOString()}:normalizeService({...raw,...await serviceDetail(source,env.DATA_GO_KR_KEY!,raw.servId)},source);
        });
      }
      await writeServices(db,source,run.id,records as Service[]);
      processed+=records.length;checkpoint.offset=end;
      if(end===page.rows.length){checkpoint.page++;checkpoint.offset=0;done=processed>=total;}
      if(total===0)done=true;
    }
    await db.prepare('UPDATE sync_runs SET checkpoint=?,processed=?,total=?,updated_at=? WHERE id=?').bind(JSON.stringify(checkpoint),processed,total,new Date().toISOString(),run.id).run();
    if(done){
      if(['national','local','facilities'].includes(source)){
        const table=source==='facilities'?'facilities':'services';
        const saved=await db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE source=? AND run_id=?`).bind(source,run.id).first<{n:number}>();
        if(saved?.n!==total)throw Error('전체 건수와 저장된 고유 레코드 수가 달라 반영을 보류했습니다.');
      }
      // The active version changes only after the full source has been validated and saved.
      // Keep the previous successful generation for recovery; remove older payloads,
      // while retaining the collection history and checkpoint records.
      const keep=[run.id,...state.active_run_id&&state.active_run_id!==run.id?[state.active_run_id]:[]];
      const prune=source==='regions'?[]:['service_facility_relations',...source==='national'||source==='local'?['services']:['facilities','facility_entries']].map(table=>
        db.prepare(`DELETE FROM ${table} WHERE source=? AND run_id NOT IN (${keep.map(()=>'?').join(',')})`).bind(source,...keep));
      await db.batch([
        db.prepare("UPDATE sync_runs SET status='succeeded',finished_at=?,error=NULL WHERE id=?").bind(new Date().toISOString(),run.id),
        db.prepare("UPDATE source_state SET active_run_id=?,status='ready',last_success=?,last_error=NULL,metadata=? WHERE source=? AND lease_owner=?").bind(run.id,new Date().toISOString(),JSON.stringify({count:processed,collection_method:source==='regions'?checkpoint.collection_method:undefined,record_format:source==='facilities'?'facility-basic-v2':undefined,coordinate_status:source==='directory'?(!env.KAKAO_REST_KEY?'needs_key':coordinates===total?'ready':'partial'):undefined,coordinates_confirmed:coordinates,coordinates_unresolved:coordinates===undefined?undefined:total!-coordinates}),source,owner),
        ...prune,
      ]);
      if(source==='directory')await reconcileCompletedCoordinates(db);
      if(source==='facilities'||source==='directory')try{await facilitySummary(db);}catch{console.warn('CareGap facility summary refresh delayed');}
    }
    if(done&&source==='facilities'&&env.KAKAO_REST_KEY)return {source,status:'running',done:false,phase:'facility_geocoding',processed,total,runId:run.id};
    return {source,status:done?'ready':'running',done,processed,total,runId:run.id,...coordinates===undefined?{}:{coordinatesConfirmed:coordinates}};
  }catch(error){
    const message=error instanceof Error?error.message:'갱신 실패';
    if(run)await db.prepare("UPDATE sync_runs SET status='failed',error=?,updated_at=? WHERE id=?").bind(message,new Date().toISOString(),run.id).run();
    await db.prepare("UPDATE source_state SET status='failed',last_error=? WHERE source=?").bind(message,source).run();
    return {source,status:'failed',done:false,error:message};
  }finally{await db.prepare('UPDATE source_state SET lease_owner=NULL,lease_until=NULL WHERE source=? AND lease_owner=?').bind(source,owner).run();}
}

function validCoordinates(lat:unknown,lon:unknown){return typeof lat==='number'&&typeof lon==='number'&&Number.isFinite(lat)&&Number.isFinite(lon)&&lat>=33&&lat<=39&&lon>=124&&lon<=132;}

async function concurrent<T,R>(items:T[],limit:number,fn:(item:T)=>Promise<R>):Promise<R[]>{
  const output=new Array<R>(items.length);let next=0,failed=false,error:unknown;
  await Promise.all(Array.from({length:Math.min(limit,items.length)},async()=>{
    while(!failed){const index=next++;if(index>=items.length)return;try{output[index]=await fn(items[index]);}catch(e){failed=true;error=e;}}
  }));
  if(failed)throw error;return output;
}
