import { XMLParser } from 'fast-xml-parser';
import { unzipSync } from 'fflate';
import iconv from 'iconv-lite';
import { Buffer } from 'node:buffer';
import currentRegions from '../../data/regions-current.json';
import { classify, flattenText as text, httpsUrl, normalizeName, regionalCheck, supplement,reviewedService,collectionDay } from './domain';
import type { Service, Facility, Region } from './types';
import {activeRegions} from './region-list';

export const sources={
  regions:{label:'행정안전부 현행 법정동코드',url:'https://www.code.go.kr/stdcodesrch/codeAllDownloadL.do'},
  directory:{label:'노인맞춤돌봄 공식 수행기관',url:'https://www.1661-2129.or.kr/organization/sub01.php?og_type=%EC%A0%84%EC%B2%B4'},
  national:{label:'중앙부처 복지서비스 API',url:'https://www.data.go.kr/data/15090532/openapi.do'},
  local:{label:'지자체 복지서비스 API',url:'https://www.data.go.kr/data/15108347/openapi.do'},
  facilities:{label:'사회복지시설 API',url:'https://www.data.go.kr/data/15001848/openapi.do'},
} as const;
export type Source=keyof typeof sources;
export const displaySources={...sources,activity_support:{label:'국민연금공단 장애인활동지원 제공기관',url:'https://www.ableservice.or.kr/info/sprtinst/getOHGE0001M0.do'}};
const parser=new XMLParser({ignoreAttributes:true,parseTagValue:false,processEntities:true,trimValues:true});
export const asArray=<T,>(v:T|T[]|undefined):T[]=>v===undefined?[]:Array.isArray(v)?v:[v];
export function walk(node:any,key:string):any[]{
  if(!node||typeof node!=='object')return [];
  return Object.entries(node).flatMap(([k,v])=>k===key?asArray(v):walk(v,key));
}
export function parseApi(xml:string){
  if(xml.includes('<!DOCTYPE')||xml.length>12_000_000)throw Error('원천 응답 형식이 올바르지 않습니다.');
  const data=parser.parse(xml);const code=text(walk(data,'resultCode')[0]??walk(data,'returnReasonCode')[0]);
  if(code&&!['00','0','0000','NORMAL_SERVICE','INFO-0'].includes(code))throw Error('공식 API 요청이 거절되었습니다. 활용 승인·인증키·호출 한도를 확인하세요.');
  if(walk(data,'cmmMsgHeader').length||xml.includes('SERVICE_KEY_IS_NOT_REGISTERED'))throw Error('공식 API 인증이 필요합니다.');
  return data;
}
export async function fetchText(url:string){
  const response=await fetch(url,{signal:AbortSignal.timeout(25000),headers:{Accept:'application/xml,text/html,application/json'}});
  if(!response.ok)throw Error(`공식 원천 응답 실패 (HTTP ${response.status})`);
  return response.text();
}
const provinceAliases:Record<string,string>={서울:'서울특별시',부산:'부산광역시',대구:'대구광역시',인천:'인천광역시',대전:'대전광역시',울산:'울산광역시',경기:'경기도',강원:'강원특별자치도',강원도:'강원특별자치도',충북:'충청북도',충남:'충청남도',전북:'전북특별자치도',전라북도:'전북특별자치도',전북자치도:'전북특별자치도',경북:'경상북도',경남:'경상남도',제주:'제주특별자치도',세종:'세종특별자치시',광주:'전남광주통합특별시',광주광역시:'전남광주통합특별시',전남:'전남광주통합특별시',전라남도:'전남광주통합특별시'};
export function regionNames(province:string,district:string,regions:Region[]=currentRegions){
  province=provinceAliases[province]??province;
  if(province==='세종특별자치시')district='세종시';
  return {province,district,matched:regions.some(r=>r.province===province&&r.district===district)};
}
export function parseDirectory(html:string,at=new Date().toISOString()):Facility[]{
  html=html.replace(/<!--[\s\S]*?-->/g,'');
  const rows:Facility[]=[];
  const clean=(s:string)=>text(s.replace(/<br\s*\/?\s*>/gi,' ').replace(/&#(\d+);/g,(_,n)=>String.fromCodePoint(+n)));
  for(const m of html.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)){
    const cells=[...m[1].matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/gi)].map(c=>clean(c[1]));
    if(cells.length!==4||!cells[1]||!/[0-9]{2,4}-[0-9]{3,4}-[0-9]{4}/.test(cells[3]))continue;
    const [district,name,address,phone]=cells;const rawProvince=address.split(' ')[0];
    const physical=physicalFacilityRegion(address),region=physical.matched?physical:regionNames(rawProvince,district.replace(/^\*/,''));
    const id='directory:'+normalizeName(name+address);
    rows.push({id,source_id:id,source:'directory',name,province:region.province,district:region.district,address,phone:publicFacilityPhone(phone),
      latitude:null,longitude:null,kind:district.includes('광역지원')?'광역지원기관':'노인맞춤돌봄 수행기관',source_url:sources.directory.url,
      source_date:collectionDay(at),collected_at:at,role:district.includes('광역지원')?'contact':'provider',service_ids:['daily-care'],evidence_url:sources.directory.url});
  }
  if(rows.length<300)throw Error('수행기관 목록의 형식 또는 건수가 변경되어 반영을 보류했습니다.');
  return [...new Map(rows.map(r=>[r.id,r])).values()];
}
export async function officialRegions():Promise<Region[]>{
  // Follow the official download form: page session, POST body and referer.
  // An HTTP 200 HTML notice is not a valid code archive.
  const landing=await fetch(sources.regions.url,{signal:AbortSignal.timeout(25000)});
  if(!landing.ok)throw Error(`행정코드 안내 응답 실패 (HTTP ${landing.status})`);
  const page=await landing.text();
  const input=page.match(/<input\b[^>]*id=["']codeseId_1["'][^>]*>/i)?.[0];
  const code=input?.match(/value=["']([^"']+)/)?.[1];
  if(!code||!/^\d+$/.test(code))throw Error('행정코드 다운로드 정보를 확인할 수 없습니다.');
  const cookies=(landing.headers as Headers&{getSetCookie?:()=>string[]}).getSetCookie?.()??[landing.headers.get('set-cookie')??''];
  const session=cookies.map(c=>c.split(';')[0]).filter(c=>/^JSESSIONID=/i.test(c)).join('; ');
  const download='https://www.code.go.kr/etc/codeFullDown.do?codeseId='+code;
  const response=await fetch(download,{
    method:'POST',body:new URLSearchParams({codeseId:code}),signal:AbortSignal.timeout(30000),
    headers:{'Content-Type':'application/x-www-form-urlencoded',Referer:sources.regions.url,Accept:'application/zip,application/octet-stream',...session?{Cookie:session}:{}},
  });
  if(!response.ok)throw Error('행정코드 다운로드 실패');
  let bytes=new Uint8Array(await response.arrayBuffer());
  if(bytes[0]!==0x50||bytes[1]!==0x4b){
    const notice=new TextDecoder().decode(bytes).match(/alert\s*\(\s*["']([^"']{0,160})/)?.[1]??'안내 응답';
    console.warn('CareGap region archive rejected',{code,http:response.status,type:response.headers.get('content-type'),bytes:bytes.length,notice});
    // Some origin sessions return a notice. Retry the same published download
    // URL without the session; validate the bytes again before accepting it.
    const retry=await fetch(download,{signal:AbortSignal.timeout(30000),headers:{Referer:sources.regions.url,Accept:'application/octet-stream','Cache-Control':'no-cache','Accept-Encoding':'identity'}});
    if(retry.ok)bytes=new Uint8Array(await retry.arrayBuffer());
    if(bytes[0]!==0x50||bytes[1]!==0x4b){
      const detail=new TextDecoder().decode(bytes).match(/alert\s*\(\s*["']([^"']{0,160})/)?.[1]??notice;
      console.warn('CareGap region retry rejected',{code,bytes:bytes.length,notice:detail});
      // Same official site's active-only list is an independently validated path.
      // Its declared total must match all parsed rows before replacing the master.
      return activeRegions(collectionDay(new Date().toISOString()));
    }
  }
  return parseRegionArchive(bytes,collectionDay(new Date().toISOString()));
}
export function parseRegionArchive(bytes:Uint8Array,date:string):Region[]{
  if(bytes.length>5_000_000)throw Error('행정코드 압축 파일 크기 검증 실패');
  let files:Record<string,Uint8Array>;
  try{files=unzipSync(bytes,{filter:f=>f.name.toLowerCase().endsWith('.txt')&&f.originalSize<=20_000_000});}
  catch{throw Error('행정코드 ZIP 무결성 검증 실패. 기존 확인 목록을 유지합니다.');}
  const entry=Object.keys(files).find(n=>n.toLowerCase().endsWith('.txt'));
  if(!entry)throw Error('행정코드 파일이 없습니다.');
  const raw=iconv.decode(Buffer.from(files[entry]),'cp949');
  if(!raw.split(/\r?\n/)[0].includes('법정동코드'))throw Error('행정코드 열 이름 검증 실패');
  const rows:Region[]=[];
  for(const line of raw.split(/\r?\n/).slice(1)){
    const [id,label,state]=line.split('\t');if(state?.trim()!=='존재'||!/^\d{10}$/.test(id)||!id.endsWith('00000'))continue;
    const words=label.trim().split(/\s+/);if(label.trim()==='세종특별자치시')words.push('세종시');if(words.length<2)continue;
    rows.push({id,province:words[0],district:words.slice(1).join(' '),source:'mois-code-download',source_date:date,verified_current:true});
  }
  if(rows.length<200||rows.length>1000||new Set(rows.map(r=>r.id)).size!==rows.length)throw Error('현행 지역 목록 건수·중복 검증 실패');return rows;
}
export function normalizeService(raw:any,scope:'national'|'local',at=new Date().toISOString()):Service{
  const sourceId=text(raw.servId);const name=text(raw.servNm);if(!sourceId||!name)throw Error('사업 ID 또는 사업명이 없는 응답입니다.');
  const extra=scope==='national'?reviewedService(sourceId,name):undefined;
  const target=[text(raw.sprtTrgtCn??raw.tgtrDtlCn??raw.trgterDtlCn),text(raw.slctCritCn)].filter(Boolean).join(' / 선정기준: ');
  const support=text(raw.alwServCn??raw.servDgst);
  const steps=asArray(raw.applmetList).map((s:any)=>text(s.servSeDetailLink)).filter(Boolean).join(' → ');
  const start=text(raw.aplyMtdCn??raw.aplyMtdNm)||steps;
  const terms=text(raw.intrsThemaNmArray??raw.intrsThemaArray)+' '+name+' '+support;const needs=classify(terms);
  const groupText=text(raw.lifeNmArray??raw.lifeArray)+' '+text(raw.trgterIndvdlNmArray??raw.trgterIndvdlArray);
  const groups=extra?.groups??[['노년',/노년|노인|고령/],['장애',/장애/],['영유아·아동',/영유아|아동|청소년|보육/],['청년·성인',/청년|중장년|성인/]].filter(([,r])=>(r as RegExp).test(groupText+' '+name)).map(([s])=>s as string);
  const region=scope==='local'?regionNames(text(raw.ctpvNm),text(raw.sggNm)):{province:'',district:''};
  const link=httpsUrl(raw.servDtlLink??raw.servSeDetailLink,`https://www.bokjiro.go.kr/ssis-tbu/twataa/wlfareInfo/moveTWAT52011M.do?wlfareInfoId=${encodeURIComponent(sourceId)}`);
  const phone=text(raw.inqplCtadrList??raw.rprsCtadr);
  return {id:extra?.id??scope+':'+sourceId,source_id:sourceId,canonical_id:extra?.id,source:scope,scope,name,province:region.province,district:region.district,
    needs:extra?.needs??needs,groups:groups.length?groups:['가구공통'],channels:extra?.channels??[/온라인|인터넷/.test(start)?'온라인':'',/방문/.test(start)?'방문':'','상담'].filter(Boolean),keywords:extra?.keywords??[],
    target:target||extra?.target||'공식 안내에서 지원대상·선정기준을 확인하세요.',support:support||extra?.support||text(raw.servDgst),
    start:start||extra?.start||'공식 창구에 신청 방법을 문의하세요.',check:extra?.check||'지원 조건과 필요한 서류를 공식 창구에서 확인합니다.',
    process:extra?.process||'공식 조건 확인 → 담당 창구 상담·신청 → 심사·결정',coverage:scope==='national'?'전국 공통 제도':`${region.province} ${region.district} 지역 사업`,
    source_name:scope==='national'?'복지로 중앙부처 복지서비스':'복지로 지자체 복지서비스',source_url:link,action_label:extra?.action_label??'복지로 공식 지원·신청 안내',action_url:extra?.action_url??link,
    checked_on:collectionDay(at),source_date:text(raw.lastModYmd),collected_at:at,
    contact_name:text(raw.bizChrDeptNm??raw.jurMnofNm)||extra?.contact_name||'공식 안내 문의처 확인',contact_phone:phone.match(/\b(?:0\d{1,3}-\d{3,4}-\d{4}|1[568]\d{2}-\d{4}|1\d{2})\b/)?.[0]??null,
    implementation_period:raw.enfcBgngYmd||raw.enfcEndYmd?[text(raw.enfcBgngYmd),text(raw.enfcEndYmd)].join(' ~ '):null,
    application_period:null,application_status:'unknown',checklist:extra?.checklist??['공식 대상·지원 조건을 읽었습니다.','현재 상황과 필요한 도움을 정리했습니다.',regionalCheck],regional_checklist_indices:extra?.regional_checklist_indices??[2],directory:extra?.directory};
}
export const endpoint={
 national:{list:'https://apis.data.go.kr/B554287/NationalWelfareInformationsV001/NationalWelfarelistV001',detail:'https://apis.data.go.kr/B554287/NationalWelfareInformationsV001/NationalWelfaredetailedV001'},
 local:{list:'https://apis.data.go.kr/B554287/LocalGovernmentWelfareInformations/LcgvWelfarelist',detail:'https://apis.data.go.kr/B554287/LocalGovernmentWelfareInformations/LcgvWelfaredetailed'},
 facilities:{list:'https://apis.data.go.kr/B554287/sclWlfrFcltInfoInqirService2/getFcltListInfoInqire2',detail:'https://apis.data.go.kr/B554287/sclWlfrFcltInfoInqirService2/getFcltByBassInfoInqire2'},
};
export async function apiPage(source:'national'|'local'|'facilities',key:string,page:number){
  // The list operation contains jurisdiction and identifiers only. The basic
  // operation is also pageable without a facility filter and supplies public contacts.
  const url=new URL(source==='facilities'?endpoint.facilities.detail:endpoint[source].list);url.searchParams.set('serviceKey',decodeURIComponent(key));url.searchParams.set('numOfRows','100');url.searchParams.set('pageNo',String(page));
  if(source!=='facilities'){url.searchParams.set('callTp','L');url.searchParams.set('srchKeyCode','003');}
  const data=parseApi(await fetchText(url.href));const countText=text(walk(data,'totalCount')[0]);
  if(!/^\d+$/.test(countText))throw Error('원천 전체 건수 항목이 없습니다.');
  const total=Number(countText);
  const rows=source==='national'?walk(data,'servList'):source==='local'?walk(data,'servList'):walk(data,'item');
  if(!Number.isInteger(total)||total<0||(total>0&&!rows.length))throw Error('원천 목록·전체 건수의 응답 형식 검증 실패');
  return {rows,total};
}
export async function serviceDetail(source:'national'|'local',key:string,id:string){
  const url=new URL(endpoint[source].detail);url.searchParams.set('serviceKey',decodeURIComponent(key));url.searchParams.set('servId',id);url.searchParams.set('callTp','D');
  const data=parseApi(await fetchText(url.href));let records=walk(data,'wantedDtl');if(!records.length)records=walk(data,'servDtList');
  const flat=(node:any):any=>{if(!node||typeof node!=='object')return {};if(node.servId)return node;for(const v of Object.values(node)){const r=flat(v);if(r.servId)return r;}return {};};
  const record=records[0]??flat(data);if(!record.servId)throw Error('사업 상세 응답 검증 실패');return record;
}
export function publicFacilityPhone(value:unknown){
  const raw=text(value).replace(/^\+82[\s().-]*(?:0[\s().-]*)?/,'0');
  const match=raw.match(/(?<!\d)(?:0(?:50[2-8]|2|[3-6]\d|[7-9]0|1\d)[\s().-]*\d{3,4}[\s().-]*\d{4}|1[568]\d{2}[\s.-]*\d{4}|1\d{2,3})(?!\d)/);
  if(!match)return null;const digits=match[0].replace(/\D/g,'');
  if(digits.length<=4)return digits;if(!digits.startsWith('0'))return digits.slice(0,4)+'-'+digits.slice(4);
  const prefix=digits.startsWith('02')?2:/^050[2-8]/.test(digits)?4:3;return digits.slice(0,prefix)+'-'+digits.slice(prefix,-4)+'-'+digits.slice(-4);
}
export function physicalFacilityRegion(address:string){const words=address.trim().split(/\s+/);return regionNames(words[0]||'',words.slice(1,words[1]?.endsWith('시')&&words[2]?.endsWith('구')?3:2).join(' '));}
export function normalizeFacility(raw:any,at=new Date().toISOString()):Facility{
  const name=text(raw.fcltNm),serviceId=text(raw.srvInstId),facilityCode=text(raw.fcltCd),id=serviceId||facilityCode;if(!name||!id)throw Error('기관 ID·기관명 응답 검증 실패');
  const parts=[raw.fcltAddr??raw.fcltAddr1,raw.fcltDtl_1Addr??raw.fcltDtlAddr1,raw.fcltDtl_2Addr??raw.fcltAddr2??raw.fcltDtlAddr2].map(text).filter(Boolean);
  const address=parts.reduce((a,b)=>!a?b:a===b||a.endsWith(b)?a:b.startsWith(a)?b:a+' '+b,'');
  const words=(address||text(raw.jrsdSggNm)).trim().split(/\s+/);
  const codeRegion=currentRegions.find(r=>r.id===text(raw.jrsdSggCd));
  const physical=address?physicalFacilityRegion(address):null;
  const region=physical?.matched?physical:regionNames(codeRegion?.province||text(raw.ctpvNm)||words[0]||'',codeRegion?.district||text(raw.sggNm)||words.slice(1,words[1]?.endsWith('시')&&words[2]?.endsWith('구')?3:2).join(' ')||'');
  const number=(v:any,min:number,max:number)=>Number.isFinite(Number(v))&&v!==undefined&&v!==''&&+v>=min&&+v<=max?+v:null;
  return {id:'facilities:'+id,source_id:id,source:'facilities',service_institution_id:serviceId||undefined,registry_facility_code:facilityCode||undefined,name,province:region.province,district:region.district,address,phone:publicFacilityPhone(raw.fcltTelNo)||publicFacilityPhone(raw.fcltTelNo2)||publicFacilityPhone(raw.fcltTelno),
    latitude:number(raw.latitude??raw.lat,33,39),longitude:number(raw.longitude??raw.lot,124,132),kind:text(raw.fcltKindNm)||'사회복지시설',
    source_url:sources.facilities.url,source_date:collectionDay(at),collected_at:at,detail_source_url:endpoint.facilities.detail,detail_checked_at:at,role:'related',service_ids:[],evidence_url:null};
}
