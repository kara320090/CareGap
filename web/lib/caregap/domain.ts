import curated from '../../data/curated.json';
import serviceLinks from '../../data/curated-service-links.json';
import type { Service, Facility } from './types';

export const supplement=curated as Service[];
export const curatedServiceLinks:Record<string,string>=serviceLinks;
export const regionalCheck='선택 지역의 신청 경로와 대리신청·구비서류를 공식 창구에서 확인합니다.';
export const collectionDay=(iso:string)=>new Date(Date.parse(iso)+9*60*60*1000).toISOString().slice(0,10);
export const normalizeName=(s:string)=>s.replace(/[\s·ㆍ・()（）\-]/g,'').toLowerCase();
export function reviewedService(id:string,name:string){return supplement.find(s=>curatedServiceLinks[s.id]===id||normalizeName(s.name)===normalizeName(name));}
export function hydrateService(value:Service):Service{
  const extra=value.source!=='curated'&&value.scope==='national'?reviewedService(value.source_id,value.name):undefined;
  const s={...value,record_kind:value.source==='curated'?'guide':'service',...(extra?{
    id:extra.id,canonical_id:extra.id,needs:extra.needs,groups:extra.groups,channels:extra.channels,check:extra.check,
    checklist:extra.checklist,regional_checklist_indices:extra.regional_checklist_indices,directory:extra.directory,keywords:extra.keywords,
    action_url:extra.action_url,action_label:extra.action_label
  }: {})} as Service;
  for(const key of ['name','target','support','start','check','process','coverage','contact_name','source_name','action_label'] as const)s[key]=flattenText(s[key]);
  return s;
}
export function locationMatches(item:{province:string;district:string},province='',district='') {
  return (!province || item.province===province) && (!district || !item.district || item.district===district || district.startsWith(item.district+' ') || item.district.startsWith(district+' '));
}
export function matchService(s:Service,q='',need='',group='',channel='',scope='all',province='',district=''){
  const text=[s.name,s.target,s.support,...s.keywords].join(' ').toLocaleLowerCase();
  return (!scope||scope==='all'||s.scope===scope) && (s.scope==='national'||locationMatches(s,province,district)) &&
    (!need||s.needs.includes(need))&&(!group||s.groups.includes(group)||s.groups.includes('가구공통'))&&(!channel||s.channels.includes(channel))&&
    q.toLocaleLowerCase().split(/\s+/).filter(Boolean).every(t=>text.includes(t));
}
export function guideFallback(q='',need='',group='',channel='',scope='all',province='',district='',page=1){
  const matches=supplement.filter(s=>matchService(s,q,need,group,channel,scope,province,district));
  const validPage=Math.min(page,Math.max(1,Math.ceil(matches.length/20)));
  return {items:matches.slice((validPage-1)*20,validPage*20),total:matches.length,guideCount:matches.length,serviceCount:0};
}
export function serviceComparisonNotice(selected:Pick<Service,'id'|'canonical_id'>[]){
  const ids=new Set(selected.map(s=>s.canonical_id??s.id));
  return ids.has('parent-pay')&&ids.has('childcare')
    ?'부모급여와 보육료는 이용 방식에 따른 지급·정산 및 변경 신청 기준을 함께 확인하세요. 비교 선택은 동시 수급 가능 여부를 뜻하지 않습니다.'
    :'중복 이용과 변경 신청 조건은 공식 창구에서 확인하세요. 비교 선택은 동시 수급을 보장하지 않습니다.';
}
export function facilityLocationMatches(item:{province:string;district:string},province='',district=''){
  return (!province||item.province===province)&&(!district||!!item.district&&(item.district===district||district.startsWith(item.district+' ')||item.district.startsWith(district+' ')));
}
export function mergeServices(imported:Service[]) {
  const official=imported.filter(s=>s.source!=='curated');
  const savedGuides=imported.filter(s=>s.source==='curated');
  const guides=savedGuides.length?savedGuides:supplement;
  const canonical=new Set(official.filter(s=>s.scope==='national').map(s=>s.canonical_id).filter(Boolean));
  return [...guides.filter(s=>!canonical.has(s.id)),...official].sort((a,b)=>a.name.localeCompare(b.name,'ko'));
}
export function facilityIdentity(f:Facility){return f.address.trim()&&!/[*●○]/.test(f.name)?normalizeName(f.name)+'|'+normalizeName(f.address):f.source+':'+f.source_id;}
export function mergeFacilities(rows:Facility[]){
  const merged=new Map<string,Facility>();
  const priority={provider:0,contact:1,related:2};
  const binary=(a:string,b:string)=>a<b?-1:a>b?1:0;
  for(const f of [...rows].sort((a,b)=>priority[a.role]-priority[b.role]||binary(a.source,b.source)||binary(a.id,b.id))){
    // Exact normalized name AND full address only; similar facility types never imply a service relationship.
    const key=facilityIdentity(f);
    const origin={source:f.source,source_id:f.source_id,source_url:f.source_url,evidence_url:f.evidence_url,source_date:f.source_date};
    const previous=merged.get(key);
    if(!previous){merged.set(key,{...f,source_records:[origin]});continue;}
    previous.source_records!.push(origin);
    if(f.evidence_url)previous.service_ids=[...new Set([...previous.service_ids,...f.service_ids])];
    if(previous.latitude===null&&f.latitude!==null){
      previous.latitude=f.latitude;previous.longitude=f.longitude;
      for(const key of ['coordinate_source','coordinate_source_url','coordinate_checked_at','coordinate_query','coordinate_validation','location_evidence'] as const){
        if(f[key]!==undefined)(previous as any)[key]=f[key];
      }
    }
    if(!previous.phone)previous.phone=f.phone;
  }
  return [...merged.values()];
}
export function resetRegionalChecks(ready:Record<string,number[]>,services:Service[]){
  return Object.fromEntries(Object.entries(ready).map(([id,indices])=>[id,indices.filter(i=>!(services.find(s=>s.id===id)?.regional_checklist_indices??[2]).includes(i))]));
}
export function haversine(lat:number,lon:number,otherLat:number,otherLon:number){
  const r=Math.PI/180;const a=Math.sin((otherLat-lat)*r/2)**2+Math.cos(lat*r)*Math.cos(otherLat*r)*Math.sin((otherLon-lon)*r/2)**2;
  return 6371*2*Math.atan2(Math.sqrt(a),Math.sqrt(1-a));
}
export function filterFacilities(rows:Facility[],province='',district='',serviceId='',origin?:{lat:number;lon:number;radius:number}){
  return rows.filter(f=>(origin||facilityLocationMatches(f,province,district))&&(!serviceId||f.service_ids.includes(serviceId)))
    .map(f=>origin&&f.latitude!==null&&f.longitude!==null?{...f,distance_km:haversine(origin.lat,origin.lon,f.latitude,f.longitude)}:f)
    .filter(f=>!origin||(f.distance_km!==undefined&&f.distance_km<=origin.radius))
    .sort((a,b)=>origin?(a.distance_km??Infinity)-(b.distance_km??Infinity):a.name.localeCompare(b.name,'ko'));
}
export function httpsUrl(input:unknown,fallback='https://www.bokjiro.go.kr/ssis-tbu/'){
  try{const u=new URL(String(input));return u.protocol==='https:'||u.protocol==='http:'?u.href:fallback;}catch{return fallback;}
}
export function classify(terms:string){
  const rules:[string,RegExp][]=[['일상생활',/돌봄|가사|활동지원/],['안전·안부',/안전|안부|응급/],['요양·통합지원',/요양|통합돌봄/],['생활비·위기',/생계|생활비|연금|긴급|위기|수당/],['주거',/주거|주택|임차/],['양육·교육',/아동|양육|보육|교육|출산/],['일자리',/일자리|취업|구직/],['건강·의료',/의료|건강|치매|검진/]];
  return rules.filter(([,r])=>r.test(terms)).map(([label])=>label);
}
export function flattenText(v:unknown):string{
  if(v===undefined||v===null)return '';
  if(Array.isArray(v))return v.map(flattenText).join(' · ');
  if(typeof v==='object')return Object.values(v).map(flattenText).join(' ');
  const entities:Record<string,string>={nbsp:' ',amp:'&',lt:'<',gt:'>',quot:'"',apos:"'",divide:'÷',times:'×',sim:'∼',le:'≤',ge:'≥',plusmn:'±',deg:'°',lsquo:'‘',rsquo:'’',ldquo:'“',rdquo:'”',middot:'·',bull:'•',hellip:'…',ndash:'–',mdash:'—'};
  let s=String(v);
  for(let i=0;i<2;i++)s=s.replace(/&([a-z]+);/gi,(all,key)=>entities[key.toLowerCase()]??all).replace(/&#(x[0-9a-f]+|\d+);/gi,(_,n)=>{const cp=n[0].toLowerCase()==='x'?parseInt(n.slice(1),16):Number(n);return cp>0&&cp<=0x10ffff&&!(cp>=0xd800&&cp<=0xdfff)?String.fromCodePoint(cp):' ';});
  return s.replace(/<[^>]*>/g,' ').replace(/\s+/g,' ').trim();
}
