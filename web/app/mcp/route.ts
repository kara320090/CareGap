import { env,json } from '../../lib/caregap/http';
import { syncSource } from '../../lib/caregap/sync';
import { sources,type Source,apiPage } from '../../lib/caregap/sources';
import { statuses } from '../../lib/caregap/store';
import {inspectOfficialMapSource} from '../../lib/caregap/official-map';
import {syncDirectoryMaintenance} from '../../lib/caregap/directory-maintenance';
export const dynamic='force-dynamic';
const tools=[
  {name:'caregap_sync_status',description:'CareGap 원천별 수집·연결 상태를 확인합니다.',inputSchema:{type:'object',properties:{},additionalProperties:false}},
  {name:'caregap_refresh_source',description:'사이트 소유자 전용. 공식 원천 한 개를 갱신하거나 중단된 수집을 이어갑니다. running이면 같은 source로 다시 호출하고 ready/needs_key에서 종료합니다.',inputSchema:{type:'object',properties:{source:{type:'string',enum:Object.keys(sources)},force:{type:'boolean'}},required:['source'],additionalProperties:false}},
];
export async function POST(request:Request){
  const e=env();const email=request.headers.get('oai-authenticated-user-email');
  let body:any;try{body=await request.json();}catch{return json({error:'올바른 JSON이 필요합니다.'},400);}
  const result=(result:unknown)=>json({jsonrpc:'2.0',id:body.id??null,result});
  if(body.method==='server/discover')return result({supportedVersions:['2026-07-28'],capabilities:{tools:{}}});
  if(body.method==='initialize')return result({protocolVersion:'2026-07-28',capabilities:{tools:{}},serverInfo:{name:'caregap',version:'3.0.0'}});
  if(body.method==='tools/list')return result({tools});
  if(body.method==='notifications/initialized')return new Response(null,{status:204});
  if(body.method==='tools/call'){
    if(!e.SYNC_OWNER_EMAIL||!email||email.toLowerCase()!==e.SYNC_OWNER_EMAIL.toLowerCase())return json({error:'사이트 소유자 인증이 필요합니다.'},403);
    try{
      const name=body.params?.name;let value:unknown;
      if(name==='caregap_sync_status'){
        const state=await statuses(e),facility=state.find(s=>s.source==='facilities');
        if(e.DB&&facility){
          const reasons=(await e.DB.prepare("SELECT coalesce(c.reason,CASE WHEN trim(f.address)='' THEN '공개 주소 없음' ELSE '주소 형식 확인 필요' END) reason,count(*) records FROM facility_entries f JOIN source_state s ON f.source=s.source AND f.run_id=s.active_run_id LEFT JOIN facility_geocodes c ON c.address=f.address WHERE f.latitude IS NULL GROUP BY 1 ORDER BY records DESC").all()).results;
          const examples=(await e.DB.prepare("SELECT f.id,f.name,f.province,f.district,f.address,c.reason FROM facility_entries f JOIN source_state s ON f.source=s.source AND f.run_id=s.active_run_id LEFT JOIN facility_geocodes c ON c.address=f.address WHERE f.latitude IS NULL AND trim(f.address)!='' ORDER BY f.id LIMIT 15").all()).results;
          facility.metadata={...facility.metadata,sourceConnectionCheck:await inspectOfficialMapSource(),missingLocationCheck:{reasons,examples}};
        }
        if(e.DB&&facility?.status==='failed'&&facility.last_error?.includes('고유 레코드')){
          const run=await e.DB.prepare("SELECT id,processed,total,checkpoint FROM sync_runs WHERE source='facilities' ORDER BY started_at DESC LIMIT 1").first<any>();
          if(run){
            const counts=await e.DB.prepare("SELECT count(*) stored,sum(CASE WHEN trim(address)!='' THEN 1 ELSE 0 END) with_address,sum(CASE WHEN coalesce(phone,'')!='' THEN 1 ELSE 0 END) with_phone FROM facility_entries WHERE source='facilities' AND run_id=?").bind(run.id).first();
            const sample=(await e.DB.prepare("SELECT id,name,address,phone FROM facility_entries WHERE source='facilities' AND run_id=? ORDER BY id LIMIT 5").bind(run.id).all()).results;
            const probe=e.DATA_GO_KR_KEY?await apiPage('facilities',e.DATA_GO_KR_KEY,1):null;
            facility.metadata={...facility.metadata,collection_check:{...run,counts,sample,first_page:probe?{total:probe.total,rows:probe.rows.length,unique_facility_codes:new Set(probe.rows.map(r=>r.fcltCd)).size,unique_service_ids:new Set(probe.rows.map(r=>r.srvInstId)).size,identifiers:probe.rows.slice(0,8).map(r=>({fcltCd:r.fcltCd,srvInstId:r.srvInstId,name:r.fcltNm}))}:null}};
          }
        }
        value=state;
      }
      else if(name==='caregap_refresh_source'){
        const source=body.params?.arguments?.source;if(!Object.hasOwn(sources,source))throw Error('지원하지 않는 원천입니다.');
        const primary=await syncSource(e,source as Source,body.params?.arguments?.force===true);
        value=primary;
        if(source==='directory'&&primary.done&&['ready','already_current'].includes(primary.status)&&e.DB){
          value=await syncDirectoryMaintenance(e);
        }
      }else throw Error('지원하지 않는 도구입니다.');
      return result({content:[{type:'text',text:JSON.stringify(value)}]});
    }catch(err){return result({content:[{type:'text',text:err instanceof Error?err.message:'갱신 요청 실패'}],isError:true});}
  }
  return json({jsonrpc:'2.0',id:body.id??null,error:{code:-32601,message:'Method not found'}});
}
