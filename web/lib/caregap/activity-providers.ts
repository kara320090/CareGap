import type {Bindings,Facility} from './types';
import {flattenText,collectionDay} from './domain';
import {fetchText,physicalFacilityRegion,publicFacilityPhone} from './sources';
import {writeFacilities,writeChunks} from './store';
import {resolveOfficialAddress} from './facility-geocoding';

export const activitySource={label:'국민연금공단 장애인활동지원 제공기관',url:'https://www.ableservice.or.kr/info/sprtinst/getOHGE0001M0.do'};
const source='activity_support',detailUrl='https://www.ableservice.or.kr/info/sprtinst/getOHGE0001M1.do';
const fetchRevision='identified-v4';
async function activityText(url:string){const response=await fetch(url,{headers:{Accept:'text/html','User-Agent':'CareGap/1.0 (+https://caregap-hybon-welfare20.hybonair.chatgpt.site)',Referer:activitySource.url},signal:AbortSignal.timeout(25000)});if(!response.ok)throw Error('국민연금공단 제공기관 원천 HTTP '+response.status);return response.text();}
const clean=(s:string)=>flattenText(s.replace(/<br\s*\/?\s*>/gi,' '));
export function parseActivityPage(html:string){
  html=html.replace(/<!--[\s\S]*?-->/g,'');
  const count=html.match(/class="total"[^>]*>\s*전체\s*<em>([\d,]+)<\/em>/)?.[1];
  if(!count)throw Error('장애인활동지원 목록 전체 건수 확인 실패 (title='+clean(html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]??'없음').slice(0,60)+'; bytes='+html.length+'; notice='+clean(html).replace(/https?:\/\/[^\s"'<>]+/g,'[URL]').slice(0,180)+')');
  const ids=[...html.matchAll(/dtlBbs\('([A-Za-z0-9_-]+)'\)/g)].map(m=>m[1]);
  const total=Number(count.replace(/,/g,''));
  if(!Number.isInteger(total)||total<300||ids.length!==new Set(ids).size||ids.length<1||ids.length>10)throw Error('장애인활동지원 목록 형식 변경: 기존 자료를 유지합니다.');
  return {ids,total};
}
export function parseActivityDetail(html:string,id:string,at=new Date().toISOString()):Facility|null{
  html=html.replace(/<!--[\s\S]*?-->/g,'');
  const field=(label:string)=>clean(html.match(new RegExp('<th[^>]*>\\s*'+label+'\\s*</th>\\s*<td[^>]*>([\\s\\S]*?)</td>'))?.[1]??'');
  const name=field('기관명'),address=field('주소'),state=field('기관상태'),benefits=field('급여종류');
  if(!name||!state)throw Error('장애인활동지원 기관 상세 형식 검증 실패 ('+id+')');
  if(!/^영업(?:중)?$/.test(state))return null;
  const confirmed=/활동보조|방문목욕|방문간호/.test(benefits);
  const region=physicalFacilityRegion(address),url=detailUrl+'?dasInstSmbl='+encodeURIComponent(id);
  return {id:source+':'+id,source_id:id,source,name,address,phone:publicFacilityPhone(field('전화번호')),province:region.province,district:region.district,latitude:null,longitude:null,
    kind:confirmed?'장애인활동지원 · '+benefits:'활동지원 등록기관 · 제공 급여 확인 필요',provider_status:state,provider_services:benefits,role:confirmed?'provider':'related',service_ids:confirmed?['disability-activity']:[],evidence_url:confirmed?url:null,source_url:url,
    detail_source_url:url,detail_checked_at:at,source_date:collectionDay(at),collected_at:at};
}
async function parallel<T,R>(items:T[],fn:(item:T)=>Promise<R>){let i=0;const out=new Array<R>(items.length);await Promise.all(Array.from({length:Math.min(4,items.length)},async()=>{while(i<items.length){const n=i++;out[n]=await fn(items[n]);}}));return out;}

export async function syncActivityProviders(env:Bindings){
  const db=env.DB!,now=new Date().toISOString(),owner=crypto.randomUUID();
  const response=(status:string,done:boolean,extra:{error?:string;deferred?:boolean;runId?:string;processed?:number;total?:number|null}={})=>({source:'directory',phase:source,status,done,...extra});
  const prior=await db.prepare('SELECT status,last_success,last_error,metadata FROM source_state WHERE source=?').bind(source).first<any>(),priorMeta=prior?JSON.parse(prior.metadata):{};
  if(prior?.status==='ready'&&prior.last_success&&collectionDay(prior.last_success)===collectionDay(now))return response('already_current',true);
  if(prior?.status==='failed'&&priorMeta.fetchRevision===fetchRevision&&priorMeta.retryAfter>now)return response('failed',false,{error:prior.last_error,deferred:true});
  await db.prepare("INSERT OR IGNORE INTO source_state(source,status,metadata) VALUES(?,'not_collected','{}')").bind(source).run();
  await db.prepare('UPDATE source_state SET lease_owner=?,lease_until=? WHERE source=? AND (lease_until IS NULL OR lease_until<?)').bind(owner,new Date(Date.now()+300000).toISOString(),source,now).run();
  const state=await db.prepare('SELECT * FROM source_state WHERE source=?').bind(source).first<any>();
  if(state.lease_owner!==owner)return response('busy',false);
  let run:any;
  try{
    if(state.status==='ready'&&state.last_success&&collectionDay(state.last_success)===collectionDay(now))return response('already_current',true);
    run=await db.prepare("SELECT * FROM sync_runs WHERE source=? AND status IN ('running','failed') ORDER BY started_at DESC LIMIT 1").bind(source).first<any>();
    if(!run){run={id:crypto.randomUUID(),processed:0,checkpoint:JSON.stringify({page:1,phase:'collect',total:null,active:0,excluded:0})};await db.prepare("INSERT INTO sync_runs(id,source,status,checkpoint,processed,started_at,updated_at) VALUES(?,?,'running',?,0,?,?)").bind(run.id,source,run.checkpoint,now,now).run();}
    const m=JSON.parse(run.checkpoint);let done=false;
    await db.prepare("UPDATE source_state SET status='syncing',last_error=NULL WHERE source=?").bind(source).run();
    if(m.phase==='collect'){
      // Two list pages plus twenty detail requests stay within Worker budgets.
      for(let n=0;n<2&&m.phase==='collect';n++){
        const page=parseActivityPage(await activityText(activitySource.url+'?pageIndex='+m.page));
        if(m.total!==null&&m.total!==page.total)throw Error('수집 중 제공기관 전체 건수가 변경됐습니다. 기존 자료를 유지합니다.');
        m.total=page.total;
        const rows=(await parallel(page.ids,async id=>parseActivityDetail(await activityText(detailUrl+'?dasInstSmbl='+id),id))).filter((f):f is Facility=>!!f);
        if(state.active_run_id&&rows.length){
          const previous=(await db.prepare('SELECT id,payload FROM facilities WHERE source=? AND run_id=? AND id IN ('+rows.map(()=>'?').join(',')+')').bind(source,state.active_run_id,...rows.map(f=>f.id)).all<{id:string;payload:string}>()).results;
          const known=new Map(previous.map(r=>[r.id,JSON.parse(r.payload) as Facility]));
          for(const f of rows){const p=known.get(f.id);if(p?.address===f.address&&p.latitude!==null&&p.longitude!==null&&p.coordinate_validation==='building'){for(const k of ['latitude','longitude','coordinate_source','coordinate_source_url','coordinate_checked_at','coordinate_query','coordinate_validation'] as const)(f as any)[k]=p[k];}}
        }
        await writeFacilities(db,source,run.id,rows);run.processed+=page.ids.length;m.active+=rows.length;m.excluded+=page.ids.length-rows.length;m.page++;
        if(run.processed===m.total){m.phase='geocode';m.offset=0;}else if(run.processed>m.total||page.ids.length!==10)throw Error('제공기관 페이지 누락·중복 검증 실패');
      }
    }else{
      const saved=await db.prepare('SELECT count(*) n FROM facilities WHERE source=? AND run_id=?').bind(source,run.id).first<{n:number}>();
      if(saved?.n!==m.active||m.active+m.excluded!==m.total)throw Error('제공기관 고유 건수 검증 실패');
      const rows=(await db.prepare("SELECT f.payload,c.status cached_status,c.latitude cached_latitude,c.longitude cached_longitude,c.checked_at cached_checked_at,c.query cached_query FROM facilities f LEFT JOIN facility_geocodes c ON c.address=json_extract(f.payload,'$.address') WHERE f.source=? AND f.run_id=? ORDER BY f.id LIMIT 20 OFFSET ?").bind(source,run.id,m.offset).all<any>()).results;
      const cache:any[]=[];
      const facilities=await parallel(rows,async row=>{
        const f:Facility=JSON.parse(row.payload);if(f.latitude!==null&&f.longitude!==null||!env.KAKAO_REST_KEY)return f;
        const r=row.cached_status==='confirmed'?{status:'confirmed',latitude:row.cached_latitude,longitude:row.cached_longitude,checked_at:row.cached_checked_at,query:row.cached_query}:await resolveOfficialAddress(env.KAKAO_REST_KEY!,f.address,f.province,f.district);
        if('address' in r)cache.push(r);
        if(r.status==='confirmed')Object.assign(f,{latitude:r.latitude,longitude:r.longitude,coordinate_source:'kakao-address',coordinate_source_url:'https://dapi.kakao.com/v2/local/search/address.json',coordinate_checked_at:r.checked_at,coordinate_query:r.query,coordinate_validation:'building'});
        return f;
      });
      await writeFacilities(db,source,run.id,facilities);
      await writeChunks(db,cache.map(r=>db.prepare('INSERT OR REPLACE INTO facility_geocodes(address,query,status,latitude,longitude,checked_at,reason,source_url) VALUES(?,?,?,?,?,?,?,?)').bind(r.address,r.query,r.status,r.latitude,r.longitude,r.checked_at,r.reason,'https://dapi.kakao.com/v2/local/search/address.json')));
      m.offset+=rows.length;done=m.offset>=m.active;
    }
    await db.prepare("UPDATE sync_runs SET status=?,checkpoint=?,processed=?,total=?,updated_at=?,error=NULL WHERE id=?").bind(done?'succeeded':'running',JSON.stringify(m),run.processed,m.total,now,run.id).run();
    if(done){
      const counts=await db.prepare("SELECT count(*) n,sum(CASE WHEN latitude IS NOT NULL THEN 1 ELSE 0 END) mapped,sum(CASE WHEN role='provider' THEN 1 ELSE 0 END) providers FROM facility_entries WHERE source=? AND run_id=?").bind(source,run.id).first<any>();
      if(counts.n!==m.active)throw Error('제공기관 저장 결과 검증 실패');
      await db.prepare("UPDATE source_state SET active_run_id=?,status='ready',last_success=?,last_error=NULL,metadata=? WHERE source=? AND lease_owner=?").bind(run.id,now,JSON.stringify({count:m.active,officialTotal:m.total,confirmedProviders:counts.providers,unverifiedBenefits:counts.n-counts.providers,excludedNonOperating:m.excluded,coordinates_confirmed:counts.mapped,coordinates_unresolved:counts.n-counts.mapped}),source,owner).run();
      await db.prepare('UPDATE sync_runs SET finished_at=? WHERE id=?').bind(now,run.id).run();
      const keep=[run.id,...state.active_run_id?[state.active_run_id]:[]];
      for(const table of ['facilities','facility_entries','service_facility_relations'])await db.prepare('DELETE FROM '+table+' WHERE source=? AND run_id NOT IN ('+keep.map(()=>'?').join(',')+')').bind(source,...keep).run();
      await db.prepare("UPDATE source_state SET metadata='{}' WHERE source='facility_index'").run();
    }else await db.prepare('UPDATE source_state SET metadata=? WHERE source=?').bind(JSON.stringify({phase:m.phase,listed:run.processed,total:m.total,geocoded:m.offset??0}),source).run();
    return response(done?'ready':'running',done,{runId:run.id,processed:m.phase==='geocode'?m.offset:run.processed,total:m.phase==='geocode'?m.active:m.total});
  }catch(error){const message=error instanceof Error?error.message:'제공기관 갱신 실패';if(run)await db.prepare("UPDATE sync_runs SET status='failed',error=?,updated_at=? WHERE id=?").bind(message,now,run.id).run();await db.prepare("UPDATE source_state SET status='failed',last_error=?,metadata=? WHERE source=?").bind(message,JSON.stringify({...JSON.parse(state.metadata),fetchRevision,retryAfter:new Date(Date.now()+300000).toISOString()}),source).run();return response('failed',false,{error:message});}
  finally{await db.prepare('UPDATE source_state SET lease_owner=NULL,lease_until=NULL WHERE source=? AND lease_owner=?').bind(source,owner).run();}
}
