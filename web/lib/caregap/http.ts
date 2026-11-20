import { env as bindings } from 'cloudflare:workers';
import { queryServices,queryFacilities,coverage,readRegions,statuses } from './store';
import type { Bindings } from './types';
import { ensureBootstrap } from './bootstrap';
export const env=()=>bindings as Bindings;
export function json(value:unknown,status=200){return Response.json(value,{status,headers:{'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}});}
export async function publicQuery(request:Request,resource:string){
  const e=env(),url=new URL(request.url);
  try{
    await ensureBootstrap(e);
    if(resource==='regions')return json({items:await readRegions(e.DB),sources:await statuses(e)});
    if(resource==='services')return json(await queryServices(e,url));
    if(resource==='facilities')return json(await queryFacilities(e,url));
    if(resource==='facility-source-ids'){
      const rows=e.DB?(await e.DB.prepare("SELECT f.id FROM facility_entries f JOIN source_state s ON f.source=s.source AND f.run_id=s.active_run_id WHERE f.source='facilities' ORDER BY f.id").all<{id:string}>()).results:[];
      return json({source:'facilities',total:rows.length,ids:rows.map(r=>r.id.slice('facilities:'.length))});
    }
    if(resource==='coverage')return json(await coverage(e,url));
    if(resource==='config')return json({kakaoJavaScriptKey:e.KAKAO_JAVASCRIPT_KEY??null,mapReady:!!e.KAKAO_JAVASCRIPT_KEY,geocodingReady:!!e.KAKAO_REST_KEY,publicDataReady:!!e.DATA_GO_KR_KEY,sourceStatuses:await statuses(e),scheduledTime:'06:00 Asia/Seoul',scheduleActive:e.SYNC_SCHEDULE_ACTIVE==='true'});
    return json({error:'찾을 수 없는 API입니다.'},404);
  }catch(error){
    if(error instanceof Error&&error.message==='INVALID_LOCATION')return json({error:'위치 또는 반경이 올바르지 않습니다.'},400);
    console.error('CareGap public read failed',resource,error instanceof Error?error.message:'Unknown read failure');return json({error:'자료를 불러오지 못했습니다. 잠시 후 다시 시도하세요.'},503);
  }
}
