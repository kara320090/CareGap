import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { supplement,matchService,mergeServices,mergeFacilities,resetRegionalChecks,filterFacilities,haversine,flattenText,curatedServiceLinks,collectionDay } from '../lib/caregap/domain';
import { ensureBootstrap } from '../lib/caregap/bootstrap';
import { parseDirectory,parseApi,normalizeService,normalizeFacility } from '../lib/caregap/sources';
import { syncSource } from '../lib/caregap/sync';
import {geocodingAddress,applyCachedFacilityCoordinates,resolveOfficialAddress,applyOfficialLocation,enrichFacilityCoordinates} from '../lib/caregap/facility-geocoding';
import {readOfficialMapPage,normalizeOfficialMap,syncOfficialMap,applyVerifiedSnapshotLocations} from '../lib/caregap/official-map';
import {backfillFacilityIndex,facilityIndexReady} from '../lib/caregap/facility-index';
import { activeRecords,coverage,queryServices,queryFacilities,writeFacilities,writeServices } from '../lib/caregap/store';
import type { Service,Facility } from '../lib/caregap/types';
import {parseActivityPage,parseActivityDetail,syncActivityProviders} from '../lib/caregap/activity-providers';
import {syncDirectoryMaintenance} from '../lib/caregap/directory-maintenance';
import {guideFallback,serviceComparisonNotice,hydrateService} from '../lib/caregap/domain';
import {directoryRoute} from '../public/legacy/welfare-search.js';
import {publishedRead,invalidatePublishedReads} from '../lib/caregap/published-read-cache';
import {compareAllocations} from '../public/legacy/model.js';
import {compareCostedAllocations,scaledCosts} from '../public/legacy/cost-model.js';
import {analyzeClusters} from '../public/legacy/clustering.js';
import {parseRegionArchive,officialRegions} from '../lib/caregap/sources';
import {zipSync} from 'fflate';
import iconv from 'iconv-lite';
import {readActiveRegionList} from '../lib/caregap/region-list';

const regionArchive=()=>zipSync({'codes.txt':new Uint8Array(iconv.encode('법정동코드\t법정동명\t폐지여부\r\n'+Array.from({length:270},(_,i)=>`${1100000000+i*100000}\t서울특별시 검증${i}구\t존재`).join('\r\n'),'cp949'))});
test('region update follows the official session POST and validates archive before atomic replacement',async()=>{
  const original=globalThis.fetch,DB=database();let valid=false,calls=0;
  DB.sql.exec("INSERT INTO regions VALUES('old','이전시도','이전군','2026-11-10','{}'); INSERT INTO source_state(source,status,last_success,metadata) VALUES('regions','ready','2026-11-10','{}')");
  globalThis.fetch=async(input,init)=>{
    calls++;
    if(String(input).includes('codeAllDownload'))return new Response('<input id="codeseId_1" value="00002">',{headers:{'set-cookie':'JSESSIONID=fixture-session; Path=/; HttpOnly'}});
    if(String(input).includes('regCodeL.do'))return new Response('잘못된 형식');
    assert.equal(new Headers(init?.headers).get('referer'),'https://www.code.go.kr/stdcodesrch/codeAllDownloadL.do');
    if(init?.method==='POST'){assert.equal(new Headers(init?.headers).get('cookie'),'JSESSIONID=fixture-session');assert.equal(String(init?.body),'codeseId=00002');}
    else assert.equal(new Headers(init?.headers).get('cookie'),null);
    return valid?new Response(regionArchive()):new Response('<html>다운로드 안내</html>');
  };
  try{
    const failed=await syncSource({DB} as any,'regions',true);assert.equal(failed.status,'failed');assert.match(failed.error!,/현존 목록/);
    assert.equal(DB.sql.prepare('SELECT count(*) n FROM regions').get().n,1);
    assert.equal(DB.sql.prepare("SELECT last_success FROM source_state WHERE source='regions'").get().last_success,'2026-11-10');
    valid=true;const ready=await syncSource({DB} as any,'regions',true);assert.equal(ready.status,'ready');assert.equal(ready.processed,270);assert.equal(calls,6);
    assert.equal(DB.sql.prepare('SELECT count(*) n FROM regions').get().n,270);
    assert.equal(DB.sql.prepare("SELECT last_error FROM source_state WHERE source='regions'").get().last_error,null);
  }finally{globalThis.fetch=original;}
});
const activeList=(total=270)=>`<script>var cnt = ${total};</script>`+Array.from({length:270},(_,i)=>`<tr><td>${1100000000+i*100000}</td><td>서울특별시 검증${i}구</td>`).join('');
test('active-only region list validates declared completeness across UTF-8 stream boundaries',async()=>{
  const bytes=new TextEncoder().encode(activeList());let cursor=0;
  const stream=new ReadableStream({pull(controller){if(cursor===bytes.length){controller.close();return;}controller.enqueue(bytes.slice(cursor,cursor+37));cursor=Math.min(bytes.length,cursor+37);}});
  assert.equal((await readActiveRegionList(new Response(stream),'2026-11-13')).length,270);
  await assert.rejects(()=>readActiveRegionList(new Response(activeList(271)),'2026-11-13'),/완전성/);
});
test('ZIP failure activates only a complete official active list, with transparent collection method',async()=>{
  const original=globalThis.fetch,DB=database();
  globalThis.fetch=async(input,init)=>{
    const url=String(input);if(url.includes('codeAllDownload'))return new Response('<input id="codeseId_1" value="00002">');
    if(url.includes('regCodeL.do')){assert.equal(new URLSearchParams(String(init?.body)).get('disuseAt'),'0');return new Response(activeList());}
    return new Response('<script>alert("원천 오류")</script>');
  };
  try{const r=await syncSource({DB} as any,'regions',true);assert.equal(r.status,'ready');assert.equal(r.total,270);
    const state=DB.sql.prepare("SELECT status,metadata,last_error FROM source_state WHERE source='regions'").get();assert.equal(state.status,'ready');assert.equal(state.last_error,null);assert.equal(JSON.parse(state.metadata).collection_method,'mois-active-code-list');
  }finally{globalThis.fetch=original;}
});
test('region archive retries an origin session notice through the same public download URL',async()=>{
  const original=globalThis.fetch;let calls=0;
  globalThis.fetch=async(input,init)=>{calls++;return String(input).includes('codeAllDownload')?new Response('<input id="codeseId_1" value="00002">'):init?.method==='POST'?new Response('<script>alert("원천 안내")</script>'):new Response(regionArchive());};
  try{assert.equal((await officialRegions()).length,270);assert.equal(calls,3);}finally{globalThis.fetch=original;}
});
test('region parser rejects corrupt, duplicate and undersized archives',()=>{
  assert.equal(parseRegionArchive(regionArchive(),'2026-11-13').length,270);
  assert.throws(()=>parseRegionArchive(new Uint8Array([1,2,3]),'2026-11-13'),/ZIP/);
  assert.throws(()=>parseRegionArchive(zipSync({'a.txt':iconv.encode('법정동코드\t법정동명\t폐지여부\n1111000000\t서울특별시 종로구\t존재','cp949')}),'2026-11-13'),/검증/);
});
test('public clustering reports insufficient data/variation, exclusions and repeatable profiles',()=>{
  const flat=Array.from({length:8},(_,i)=>({id:String(i),demand:8,users:4}));
  assert.equal(analyzeClusters(flat.slice(0,3)).status,'INSUFFICIENT_DATA');assert.equal(analyzeClusters(flat).status,'INSUFFICIENT_VARIATION');
  const rows=flat.map((r,i)=>({...r,demand:10+i*20,users:i*10,sourceQuadrant:1}));rows.push({id:'missing',demand:2,users:null} as any);rows.push({id:'above',demand:2,users:4} as any);
  const first=analyzeClusters(rows),again=analyzeClusters(rows);
  assert.deepEqual(first,again);assert.equal(first.status,'OK');assert.equal(first.rows.length,8);assert.equal(first.excluded.length,2);
  assert.ok('profiles' in first);
  assert.equal(first.profiles.reduce((sum:number,profile:{regions:number})=>sum+profile.regions,0),8);assert.equal(analyzeClusters(rows,true).rows.length,9);
});
test('heterogeneous-price fairness matches independent exhaustive objectives and all budgets remain feasible',()=>{
  for(let seed=0;seed<20;seed++){
    const rows=Array.from({length:3},(_,i)=>({id:String(i),demand:8+(seed+i)%8,users:(seed+i)%5})),budget=seed%18;
    const costs=Object.fromEntries(rows.map((r,i)=>[r.id,2+(seed+2*i)%6]));
    let objective=[-1,-1,-Infinity];
    const caps=rows.map(r=>Math.ceil((r.demand-r.users)/4));
    for(let a=0;a<=caps[0];a++)for(let b=0;b<=caps[1];b++)for(let c=0;c<=caps[2];c++){
      const counts=[a,b,c],spent=rows.reduce((s,r,i)=>s+counts[i]*costs[r.id],0);if(spent>budget)continue;
      const extra=rows.map((r,i)=>Math.min(r.demand-r.users,counts[i]*4));const next=[Math.min(...rows.map((r,i)=>Math.floor(10000*(r.users+extra[i])/r.demand))),extra.reduce((s,x)=>s+x,0),-spent];
      if(next[0]>objective[0]||next[0]===objective[0]&&(next[1]>objective[1]||next[1]===objective[1]&&next[2]>objective[2]))objective=next;
    }
    const result=compareCostedAllocations(rows,budget,costs),fair=result.results[0];
    assert.deepEqual([Math.floor(fair.lowest!*10000+1e-8),fair.extra,-fair.spent],objective);
    assert.ok(result.results.every(r=>r.status==='CALCULATED'&&r.spent!<=budget&&r.units.every((n:number)=>Number.isInteger(n)&&n>=0)));
  }
});
test('regional prices distinguish invalid inputs from zero success and scale each entered price before rounding',()=>{
  const rows=[{id:'a',demand:20,users:1}];
  for(const cost of [0,NaN,1.5,-1])assert.ok(compareCostedAllocations(rows,100,{a:cost}).results.every(r=>r.status==='INPUT_ERROR'&&r.extra===null));
  assert.ok(compareCostedAllocations(rows,0,{a:1}).results.every(r=>r.extra===0&&r.spent===0));
  assert.equal(scaledCosts(rows,{a:3},150).a,5);assert.throws(()=>scaledCosts(rows,{a:1},1),/변경 단가/);
  assert.equal(compareCostedAllocations([{id:'u',demand:2,users:null}],0).results[0].status,'NO_DATA');
});

function database(maxBindings=Infinity){
  const sql=new DatabaseSync(':memory:');sql.exec(readFileSync('drizzle/0000_confused_havok.sql','utf8'));
  sql.exec(readFileSync('drizzle/0001_kind_forgotten_one.sql','utf8'));
  sql.exec(readFileSync('drizzle/0002_brainy_black_widow.sql','utf8'));
  sql.exec("INSERT INTO source_state(source,status,metadata) VALUES('facility_index','ready','{}')");
  const reads:{payloadRows:number;rows:number}[]=[];
  const prepared=(query:string,args:unknown[]=[])=>({bind(...values:unknown[]){if(values.length>maxBindings)throw Error('D1 maximum bound parameters exceeded');return prepared(query,values);},async run(){sql.prepare(query).run(...args as any[]);return {success:true};},async first(){return sql.prepare(query).get(...args as any[])??null;},async all(){const results=sql.prepare(query).all(...args as any[]);reads.push({payloadRows:results.filter(r=>'payload' in r).length,rows:results.length});return {results};}});
  let transaction=Promise.resolve<any>(undefined);
  return {prepare:prepared,batch(statements:any[]){const result=transaction.then(async()=>{sql.exec('BEGIN');try{const out=[];for(const s of statements)out.push(await s.run());sql.exec('COMMIT');return out;}catch(e){sql.exec('ROLLBACK');throw e;}});transaction=result.catch(()=>undefined);return result;},sql,reads} as any;
}
const row=(district:string,name:string,address:string)=>`<tr><td>${district}</td><td>${name}</td><td>${address}</td><td>02-123-4567</td></tr>`;
const directory='<table>'+Array.from({length:310},(_,i)=>row('종로구','검증기관'+i,'서울특별시 종로구 공식길 '+i)).join('')+'</table>';
const national=(id:string,name:string)=>`<root><resultCode>00</resultCode><totalCount>1</totalCount><servList><servId>${id}</servId><servNm>${name}</servNm></servList></root>`;
const detail=(id:string,name:string)=>`<root><resultCode>00</resultCode><wantedDtl><servId>${id}</servId><servNm>${name}</servNm><sprtTrgtCn>지원 대상</sprtTrgtCn><alwServCn>공식 지원</alwServCn><lastModYmd>20261110</lastModYmd></wantedDtl></root>`;
const activityDetail=(name:string,state='영업')=>`<table><tr><th>기관명</th><td>${name}</td><th>대표자</th><td>저장하면 안 되는 필드</td></tr><tr><th>주소</th><td>서울특별시 종로구 공식길 10</td></tr><tr><th>전화번호</th><td>02-123-4567</td><th>기관상태</th><td>${state}</td></tr><tr><th>급여종류</th><td>활동보조, 방문목욕</td></tr></table>`;

test('API outage retains searchable reviewed guides without pretending to contain local API programmes',()=>{
  assert.equal(guideFallback().total,20);
  assert.deepEqual(guideFallback('안부').items.map(s=>s.id),['daily-care','safety']);
  assert.deepEqual(guideFallback('안부','','','','all','','',2).items.map(s=>s.id),['daily-care','safety']);
  assert.equal(guideFallback('','','','','local','인천광역시','옹진군').total,0);
  assert.equal(guideFallback('퇴원','주거').total,0);
  assert.ok(guideFallback('','주거','노년','온라인').items.some(s=>s.id==='housing'));
});

test('payment adjustment notice survives official API service names and reviewed canonical IDs',()=>{
  assert.match(serviceComparisonNotice([{id:'official:one',canonical_id:'parent-pay'},{id:'official:two',canonical_id:'childcare'}]),/정산/);
  assert.match(serviceComparisonNotice([{id:'parent-pay'},{id:'childcare'}]),/변경 신청/);
  assert.doesNotMatch(serviceComparisonNotice([{id:'basic-pension'}]),/정산/);
  assert.equal(flattenText('3&sim;5세 &le; 기준 &amp; 조건'),'3∼5세 ≤ 기준 & 조건');
});

test('reviewed and official national pension cards share their comparison and preparation identity while the local programme stays separate',()=>{
  const guide=supplement.find(s=>s.id==='basic-pension')!;
  const national=hydrateService({...guide,id:'national:WLF00001164',source_id:'WLF00001164',source:'national',name:'기초연금 지원',checklist:['다른 수집 서식']});
  const local=hydrateService({...guide,id:'local:TEST',source_id:'TEST',scope:'local',source:'local'});
  assert.equal(national.id,guide.id);
  assert.deepEqual(national.checklist,guide.checklist);
  assert.deepEqual(national.regional_checklist_indices,guide.regional_checklist_indices);
  assert.notEqual(local.id,national.id);
  assert.equal(new Set([guide.id,national.id,local.id]).size,2);
});

test('public allocation distinguishes missing data and invalid budgets from a successful zero-budget calculation',()=>{
  const observed=[{id:'known',demand:276,users:143}];
  const zero=compareAllocations(observed,0);
  assert.equal(zero.results.length,3);
  assert.ok(zero.results.every(r=>r.status==='CALCULATED'&&r.extra===0&&r.spent===0&&r.lowest!==null));
  const missing=compareAllocations([{id:'unknown',demand:67,users:null}],0);
  assert.equal(missing.results.length,3);
  assert.ok(missing.results.every(r=>r.status==='NO_DATA'&&r.extra===null&&r.spent===null));
  assert.ok(compareAllocations(observed,-1).results.every(r=>r.status==='INPUT_ERROR'));
  assert.ok(compareAllocations(observed,Number.NaN).results.every(r=>r.status==='INPUT_ERROR'));
});

test('public result cache isolates query conditions, never caches errors and invalidates completed generations',async()=>{
  const DB={},read=async()=>({items:[{name:'검증'}]});let count=0;
  const load=()=>{count++;return read();};
  const first=await publishedRead(DB,'region-a',load);first.items[0].name='별도 편집';
  assert.equal((await publishedRead(DB,'region-a',load)).items[0].name,'검증');assert.equal(count,1);
  await publishedRead(DB,'region-b',load);assert.equal(count,2);
  invalidatePublishedReads(DB);await publishedRead(DB,'region-a',load);assert.equal(count,3);
  await assert.rejects(publishedRead(DB,'failed',async()=>{throw Error('outage');}));
  assert.equal(await publishedRead(DB,'failed',async()=>42),42);
  await publishedRead(DB,'expired',load,0);await publishedRead(DB,'expired',load);assert.equal(count,5);
});

test('facility summaries preserve authoritative links from duplicate records and react to a newly published generation',async()=>{
  const DB=database(),base=parseDirectory(directory)[0];
  const provider={...base,id:'directory:one',source_id:'one',name:'같은기관',latitude:37.5,longitude:127};
  const duplicate={...provider,id:'facilities:one',source_id:'one',source:'facilities',role:'related',service_ids:[],evidence_url:null} as Facility;
  await writeFacilities(DB,'directory','v1',[provider]);await writeFacilities(DB,'facilities','v1',[duplicate]);
  DB.sql.exec("INSERT INTO source_state(source,active_run_id,status,metadata) VALUES('directory','v1','ready','{}'),('facilities','v1','ready','{}')");
  const url=new URL('https://test/');
  const a=await queryFacilities({DB} as any,url);assert.equal(a.total,1);assert.equal(a.items[0].id,provider.id);
  const report=await coverage({DB} as any,url);assert.equal(report.confirmedFacilities,1);assert.ok(report.items.find((r:any)=>r.province==='서울특별시'&&r.district==='종로구')!.linkedServices>0);
  await writeFacilities(DB,'directory','v2',[{...provider,id:'directory:two',source_id:'two',name:'새기관',address:'서울특별시 종로구 새길 22'}]);
  DB.sql.exec("UPDATE source_state SET active_run_id='v2' WHERE source='directory'");
  const b=await queryFacilities({DB} as any,url);assert.equal(b.total,2);assert.ok(b.items.some(f=>f.name==='새기관'));
});

test('directory maintenance shares the facility collector lease and releases it after a source failure',async()=>{
  const DB=database(),original=globalThis.fetch;DB.sql.exec("INSERT INTO source_state(source,active_run_id,status,metadata) VALUES('facilities','stable','ready','{}')");
  let started!:()=>void,release!:()=>void;const startedPromise=new Promise<void>(r=>{started=r;}),gate=new Promise<void>(r=>{release=r;});
  globalThis.fetch=(async()=>{started();await gate;throw Error('공식 원천 연결 실패');}) as any;
  try{const env={DB,DATA_GO_KR_KEY:'fixture-only'} as any,first=syncDirectoryMaintenance(env);await startedPromise;assert.equal((await syncSource(env,'facilities')).status,'busy');assert.equal((await syncDirectoryMaintenance(env)).status,'busy');release();assert.equal((await first).status,'failed');const saved=DB.sql.prepare("SELECT active_run_id,lease_owner FROM source_state WHERE source='facilities'").get();assert.equal(saved.active_run_id,'stable');assert.equal(saved.lease_owner,null);}finally{release();globalThis.fetch=original;}
});

test('activity providers require official operating status and benefit evidence, and exclude personal fields',()=>{
  const f=parseActivityDetail(activityDetail('검증 활동지원기관'),'12345')!;assert.equal(f.role,'provider');assert.deepEqual(f.service_ids,['disability-activity']);assert.equal(f.phone,'02-123-4567');assert.ok(f.evidence_url?.endsWith('dasInstSmbl=12345'));assert.ok(!JSON.stringify(f).includes('저장하면 안 되는 필드'));
  assert.equal(parseActivityDetail(activityDetail('휴업기관','휴업'),'2'),null);assert.throws(()=>parseActivityDetail('<html>점검 중</html>','2'));
  const noBenefit=parseActivityDetail(activityDetail('급여 미확인 기관').replace('활동보조, 방문목욕',''),'4060045417')!;assert.equal(noBenefit.role,'related');assert.deepEqual(noBenefit.service_ids,[]);assert.equal(noBenefit.evidence_url,null);assert.ok(noBenefit.address);
  const p=parseActivityPage('<span class="total">전체<em>1,280</em>건</span><a href="javascript:dtlBbs(\'12345\');">보기</a><a href="javascript:dtlBbs(\'T000000701\');">보기</a>');assert.equal(p.total,1280);assert.deepEqual(p.ids,['12345','T000000701']);
});

test('Sejong building addresses are rechecked after the empty district response fix, overriding the old negative cache',async()=>{
  const DB=database(),original=globalThis.fetch,f=normalizeFacility({srvInstId:'C-SEJONG',fcltNm:'세종 검증기관',fcltAddr:'세종특별자치시 한누리대로 2107'});let calls=0;
  await writeFacilities(DB,'facilities','sejong',[f]);DB.sql.exec("INSERT INTO source_state(source,active_run_id,status,metadata) VALUES('facilities','sejong','ready','{}')");await readyOfficialMap(DB,'sejong');
  await DB.prepare('INSERT INTO facility_geocodes(address,query,status,latitude,longitude,checked_at,reason,source_url) VALUES(?,?,\'unresolved\',NULL,NULL,?,?,?)').bind(f.address,f.address,new Date().toISOString(),'건물·지번 단위 응답 확인 필요','https://dapi.kakao.com/v2/local/search/address.json').run();
  globalThis.fetch=(async()=>{calls++;return new Response(JSON.stringify({documents:[{x:'127.28',y:'36.48',address:{region_1depth_name:'세종특별자치시',region_2depth_name:''},road_address:{road_name:'한누리대로',main_building_no:'2107'}}]}));}) as any;
  try{const r=await enrichFacilityCoordinates({DB,KAKAO_REST_KEY:'fixture-only'} as any);assert.equal(r.status,'ready');assert.equal(calls,1);const saved=(await activeRecords<Facility>(DB,'facilities'))[0];assert.equal(saved.latitude,36.48);assert.equal(saved.district,'세종시');}finally{globalThis.fetch=original;}
});

test('activity provider collection resumes across pages, activates only complete data and preserves the last successful generation on failure',async()=>{
  const DB=database(100),original=globalThis.fetch;let broken=false;
  globalThis.fetch=(async(input:any)=>{const u=new URL(String(input));if(broken)throw Error('원천 연결 실패');if(u.pathname.includes('getOHGE0001M1'))return new Response(activityDetail('공식 활동지원 '+u.searchParams.get('dasInstSmbl')));const p=Number(u.searchParams.get('pageIndex')),ids=Array.from({length:10},(_,i)=>(p-1)*10+i+1);return new Response('<span class="total">전체<em>300</em>건</span>'+ids.map(id=>`<a href="javascript:dtlBbs('${id}');">보기</a>`).join(''));}) as any;
  try{const env={DB} as any;let r=await syncActivityProviders(env);assert.equal(r.done,false);assert.equal((await activeRecords(DB,'facilities')).length,0);for(let i=0;!r.done&&i<35;i++)r=await syncActivityProviders(env);assert.equal(r.status,'ready');assert.equal((await activeRecords(DB,'facilities')).length,300);const q=await queryFacilities(env,new URL('https://test/?province=서울특별시&district=종로구&serviceId=disability-activity'));assert.equal(q.total,300);assert.equal((await coverage(env,new URL("https://test/"))).confirmedFacilities,300);const id=DB.sql.prepare("SELECT active_run_id FROM source_state WHERE source='activity_support'").get().active_run_id;DB.sql.exec("UPDATE source_state SET last_success='2026-01-01' WHERE source='activity_support'");broken=true;assert.equal((await syncActivityProviders(env)).status,'failed');assert.equal(DB.sql.prepare("SELECT active_run_id FROM source_state WHERE source='activity_support'").get().active_run_id,id);assert.equal((await activeRecords(DB,'facilities')).length,300);}finally{globalThis.fetch=original;}
});

async function readyOfficialMap(DB:any,baseRunId:string){
  await DB.prepare("INSERT OR REPLACE INTO source_state(source,status,last_success,metadata) VALUES('official_map','ready',?,?)").bind(new Date().toISOString(),JSON.stringify({baseRunId,processed:0,matched:0,validated_run_id:null,usable_run_id:null})).run();
}

test('official facility addresses become building queries without losing the original',()=>{
  assert.equal(geocodingAddress('인천광역시 계양구 경명대로980(계산동)5층'),'인천광역시 계양구 경명대로 980');
  assert.equal(geocodingAddress('경기 양주시 화합로1426번길 90 (덕정동) 4층 기관명'),'경기 양주시 화합로1426번길 90');
  assert.equal(geocodingAddress('서울특별시 마포구 만리재로 99 / 2, 3층'),'서울특별시 마포구 만리재로 99');
  assert.equal(geocodingAddress('경상북도 경주시 양정로 251번길 19. 3층'),'경상북도 경주시 양정로251번길 19');
  assert.equal(geocodingAddress('경북 고령군 다산면 호촌길 23-10번지 2층'),'경북 고령군 다산면 호촌길 23-10');
  assert.equal(geocodingAddress('서울특별시 종로구'),'');assert.equal(geocodingAddress('서울특별시 종로구 ***'),'');
  const f=normalizeFacility({fcltCd:'PHYSICAL',fcltNm:'공식 주소 우선 기관',jrsdSggCd:'1114000000',fcltAddr:'부산광역시 중구 중앙대로 1'});
  assert.equal(f.province,'부산광역시');assert.equal(f.district,'중구');
});

test('a frozen official map generation starts a fresh live collection without discarding the last validated data',async()=>{
  const DB=database(),original=globalThis.fetch,previous={baseRunId:'registry',runId:'snapshot',validated_run_id:'snapshot',usable_run_id:'snapshot',mode:'official_snapshot',regions:[]};
  await DB.prepare("INSERT INTO source_state(source,status,last_success,metadata) VALUES('official_map','ready',?,?)").bind(new Date().toISOString(),JSON.stringify(previous)).run();
  globalThis.fetch=(async(input:any)=>new Response(JSON.stringify(String(input).includes('sidoList.do')?{dsSiDoList:Array.from({length:11},(_,i)=>({sido:'공식시도'+i}))}:{dsSiGunGuList:Array.from({length:10},(_,i)=>({sigungu:'공식군'+i}))}))) as any;
  try{assert.equal((await syncOfficialMap({DB} as any,'registry',true)).status,'running');const m=JSON.parse(DB.sql.prepare("SELECT metadata FROM source_state WHERE source='official_map'").get().metadata);assert.equal(m.regions.length,110);assert.equal(m.validated_run_id,'snapshot');assert.equal(m.usable_run_id,'snapshot');assert.notEqual(m.runId,'snapshot');assert.notEqual(m.mode,'official_snapshot');}finally{globalThis.fetch=original;}
});

test('facility coordinate enrichment resumes after quota failure, validates regions and reuses unchanged addresses',async()=>{
  const DB=database(),original=globalThis.fetch;let fail=true,calls=0;
  const rows=Array.from({length:60},(_,i)=>normalizeFacility({fcltCd:'F'+String(i).padStart(3,'0'),fcltNm:'공식 시설 '+i,jrsdSggNm:'서울특별시 종로구',fcltAddr:i===0?'서울특별시 종로구':'서울특별시 종로구 공식길 '+(i+1),fcltTelNo:'02-123-4567'}));
  const known={...parseDirectory(directory)[0],latitude:37.57,longitude:126.98,coordinate_source:'kakao-address',coordinate_validation:'building',coordinate_checked_at:'2026-11-01T00:00:00.000Z'};
  await writeFacilities(DB,'facilities','base-a',rows);await writeFacilities(DB,'directory','dir-a',[known]);
  await DB.prepare("INSERT INTO source_state(source,active_run_id,status,last_success,metadata) VALUES('facilities','base-a','ready',?,'{\"record_format\":\"facility-basic-v2\"}')").bind(new Date().toISOString()).run();
  DB.sql.exec("INSERT INTO source_state(source,active_run_id,status,metadata) VALUES('directory','dir-a','ready','{}')");
  await readyOfficialMap(DB,'base-a');
  globalThis.fetch=(async(input:any)=>{
    const url=new URL(String(input));assert.equal(url.origin,'https://dapi.kakao.com');const query=url.searchParams.get('query')!,n=Number(query.match(/(\d+)$/)?.[1]);calls++;
    if(n===4&&fail)return new Response('{}',{status:429});
    if(n===2)return new Response(JSON.stringify({documents:[{x:'126.98',y:'37.57'},{x:'126.99',y:'37.58'}]}));
    return new Response(JSON.stringify({documents:[{x:String(126.98+n*.000001),y:'37.57',address:{region_1depth_name:n===3?'부산광역시':'서울특별시',region_2depth_name:'종로구',main_address_no:String(n)},road_address:{road_name:'공식길',main_building_no:String(n),sub_building_no:''}}]}));
  }) as any;
  try{
    const env={DB,DATA_GO_KR_KEY:'fixture-only',KAKAO_REST_KEY:'fixture-only'} as any;
    const first=await syncSource(env,'facilities');assert.equal(first.status,'failed');assert.equal(first.phase,'facility_geocoding');assert.equal((await activeRecords(DB,'facilities')).length,61);
    assert.equal(DB.sql.prepare("SELECT active_run_id FROM source_state WHERE source='facilities'").get().active_run_id,'base-a');
    fail=false;let result=await syncSource(env,'facilities');for(let i=0;result.status==='running'&&i<10;i++)result=await syncSource(env,'facilities');
    assert.equal(result.status,'ready');assert.equal(result.coordinatesConfirmed,58);assert.equal(calls,60);
    const found=await queryFacilities(env,new URL('https://test/?pageSize=100'));assert.equal(found.total,61);assert.equal(found.mapItems.length,58);assert.equal(found.missingCoordinates,3);assert.ok(found.items.every(f=>f.phone));
    const saved=(await activeRecords<Facility>(DB,'facilities')).find(f=>f.id==='facilities:F005')!.coordinate_checked_at;
    await writeFacilities(DB,'facilities','base-b',rows);await applyCachedFacilityCoordinates(DB,'base-b');
    DB.sql.exec("UPDATE source_state SET active_run_id='base-b' WHERE source='facilities'");await readyOfficialMap(DB,'base-b');
    const cached=await syncSource(env,'facilities');assert.equal(cached.status,'ready');assert.equal(calls,60);
    assert.equal((await activeRecords<Facility>(DB,'facilities')).find(f=>f.id==='facilities:F005')!.coordinate_checked_at,saved);
    const changed=rows.map(f=>({...f}));changed[5].address='서울특별시 종로구 공식길 999';await writeFacilities(DB,'facilities','base-c',changed);await applyCachedFacilityCoordinates(DB,'base-c');DB.sql.exec("UPDATE source_state SET active_run_id='base-c' WHERE source='facilities'");await readyOfficialMap(DB,'base-c');
    assert.equal((await syncSource(env,'facilities')).status,'ready');assert.equal(calls,61);
    assert.equal((await activeRecords<Facility>(DB,'facilities')).find(f=>f.id==='facilities:F005')!.coordinate_query,'서울특별시 종로구 공식길 999');
  }finally{globalThis.fetch=original;}
});

test('official map page streaming preserves quoted Unicode and discards the large marker payload',{timeout:2000},async()=>{
  const rows=[{faclNm:'복지관 "온기" [본관] \\ 별관'},{faclNm:'두 번째 기관'}],prefix=JSON.stringify({dmParam:{totalRowCount:2},dsTsbBkjrMngFaclList:rows}).slice(0,-1)+',"dsTsbBkjrMngFaclFullList":[';
  let cancelled=false;const bytes=new TextEncoder().encode(prefix),stream=new ReadableStream({start(c){for(let i=0;i<bytes.length;i+=7)c.enqueue(bytes.slice(i,i+7));},cancel(){cancelled=true;}});
  const result=await readOfficialMapPage(new Response(stream));assert.equal(result.total,2);assert.deepEqual(result.rows,rows);assert.equal(cancelled,true);
  await assert.rejects(readOfficialMapPage(new Response('{"dmParam":{},"dsTsbBkjrMngFaclList":[]}')));
});

test('official map supplements match service IDs, stay outside resident counts and recover after an outage',async()=>{
  const DB=database(),original=globalThis.fetch;let outage=true;
  const a=normalizeFacility({srvInstId:'C-A',fcltCd:'SHARED',fcltNm:'공식기관 A',fcltAddr:'서울특별시 중구 공식길 1',fcltTelNo:'02-111-1111'});
  const b=normalizeFacility({srvInstId:'C-B',fcltCd:'SHARED',fcltNm:'공식기관 B',jrsdSggNm:'부산광역시 중구'});
  await writeFacilities(DB,'facilities','registry',[a,b]);
  await DB.prepare("INSERT INTO source_state(source,active_run_id,status,last_success,metadata) VALUES('facilities','registry','ready',?,'{"+'"record_format":"facility-basic-v2"'+"}')").bind(new Date().toISOString()).run();
  const meta={baseRunId:'registry',runId:'official-run',regions:[{province:'서울특별시',district:'중구'},{province:'부산광역시',district:'중구'}],regionIndex:0,page:1,regionProcessed:0,regionTotal:null,processed:0,expectedTotal:0,matched:0,validated_run_id:null,usable_run_id:null};
  await DB.prepare("INSERT INTO source_state(source,status,metadata) VALUES('official_map','syncing',?)").bind(JSON.stringify(meta)).run();
  await DB.prepare("INSERT INTO sync_runs(id,source,status,checkpoint,processed,started_at,updated_at) VALUES('official-run','official_map','running',?,0,?,?)").bind(JSON.stringify(meta),new Date().toISOString(),new Date().toISOString()).run();
  globalThis.fetch=(async(input:any,init:any)=>{
    assert.equal(new URL(String(input)).hostname,'www.bokjiro.go.kr');assert.ok(!JSON.stringify(init).includes('fixture-only'));
    const p=JSON.parse(typeof init.body==='string'?init.body:new TextDecoder().decode(init.body)).dmParam;
    if(p.roDeSiDo==='부산광역시'&&outage)return new Response(JSON.stringify({dmMessage:{status:'ERROR'}}));
    const items=p.roDeSiDo==='서울특별시'?[{bkjrMngFaclId:'M1',srvInstId:'C-A',faclNm:'공식기관 A',addrNm:a.address,faclTelno:'(02)-999-9999',faclLa:'37.56',faclLo:'126.99',faclRprsvFlnm:'저장하지 않는 개인 필드'},{bkjrMngFaclId:'M0',srvInstId:'C-UNREGISTERED',faclNm:b.name,addrNm:a.address,faclLa:'37.56',faclLo:'126.99'}]:[{bkjrMngFaclId:'M2',srvInstId:'C-B',faclNm:b.name,addrNm:'부산광역시 중구 새길 2',faclTelno:'051-222-2222',faclLa:'35.1',faclLo:'129.03'}];
    return new Response(JSON.stringify({dmParam:{totalRowCount:items.length},dsTsbBkjrMngFaclList:items,dsTsbBkjrMngFaclFullList:[]}));
  }) as any;
  try{
    const env={DB,DATA_GO_KR_KEY:'fixture-only',KAKAO_REST_KEY:'fixture-only'} as any;
    assert.equal((await syncOfficialMap(env,'registry')).status,'running');assert.equal((await syncOfficialMap(env,'registry')).phase,'official_map_retry_later');
    assert.equal((await activeRecords<Facility>(DB,'facilities')).length,2);assert.equal(DB.sql.prepare("SELECT count(*) n FROM facilities WHERE source='official_map'").get().n,1);
    assert.ok(!DB.sql.prepare("SELECT payload FROM facilities WHERE source='official_map'").get().payload.includes('저장하지 않는 개인 필드'));
    assert.equal((await syncSource(env,'facilities')).status,'ready');let found=await queryFacilities(env,new URL('https://test/?pageSize=100'));assert.equal(found.total,2);assert.equal(found.mapItems.length,1);assert.equal(found.items.find(f=>f.id===b.id)!.latitude,null);
    const m=JSON.parse(DB.sql.prepare("SELECT metadata FROM source_state WHERE source='official_map'").get().metadata);m.retryAfter=null;await DB.prepare("UPDATE source_state SET metadata=? WHERE source='official_map'").bind(JSON.stringify(m)).run();outage=false;
    assert.equal((await syncOfficialMap(env,'registry')).status,'ready');assert.equal((await syncSource(env,'facilities')).status,'ready');
    found=await queryFacilities(env,new URL('https://test/?pageSize=100'));assert.equal(found.total,2);assert.equal(found.mapItems.length,2);assert.ok(found.items.every(f=>f.role==='related'&&f.service_ids.length===0));
    const fb=found.items.find(f=>f.id===b.id)!;assert.equal(fb.address,'부산광역시 중구 새길 2');assert.equal(fb.phone,'051-222-2222');assert.equal(fb.registry_address,'');assert.equal(fb.registry_phone,null);assert.equal(fb.location_evidence?.record_id,'M2');
  }finally{globalThis.fetch=original;}
});

test('official location corrections preserve missing original contacts and reject another province',()=>{
  const f=normalizeFacility({srvInstId:'C-EXACT',fcltNm:'기관',fcltAddr:'서울특별시 중구 옛길 1'},'2026-11-10T22:00:00.000Z');
  const other=normalizeOfficialMap({bkjrMngFaclId:'WRONG',srvInstId:'C-EXACT',faclNm:'기관',addrNm:'부산광역시 중구 새길 2',faclTelno:'051-222-2222',faclLa:'35.1',faclLo:'129.03'},'2026-11-10T22:30:00.000Z');
  assert.equal(other.source_date,'2026-11-11');assert.equal(applyOfficialLocation(f,other,true),false);assert.equal(f.phone,null);
  const point=normalizeOfficialMap({bkjrMngFaclId:'RIGHT',srvInstId:'C-EXACT',faclNm:'기관',addrNm:'서울특별시 중구 새길 2',faclTelno:'(02)-222-2222',faclLa:'37.56',faclLo:'126.99'},'2026-11-10T22:30:00.000Z');
  assert.equal(applyOfficialLocation(f,point,true),true);assert.equal(f.registry_phone,null);point.phone='02-333-3333';applyOfficialLocation(f,point,true);assert.equal(f.registry_phone,null);assert.equal(f.phone,'02-333-3333');
});

test('an optional map initialization failure backs off so official-address geocoding can continue',async()=>{
  const DB=database(),original=globalThis.fetch;DB.batch=async()=>{throw Error('Fixture storage unavailable');};globalThis.fetch=(async()=>{throw Error('Fixture map source unavailable');}) as any;
  try{const env={DB} as any,first=await syncOfficialMap(env,'fixture-base');assert.equal(first.phase,'official_map_retry_later');assert.equal(first.done,false);const retry=await syncOfficialMap(env,'fixture-base');assert.equal(retry.done,true);assert.equal(retry.phase,'official_map_deferred');}finally{globalThis.fetch=original;}
});

test('a directory point without provenance is rechecked and the completed registry summary follows the new directory',async()=>{
  const DB=database(),original=globalThis.fetch,rows=parseDirectory(directory).map((f,i)=>({...f,latitude:37.57,longitude:126.98,...i?{coordinate_source:'kakao-address',coordinate_validation:'building',coordinate_checked_at:'2026-11-10T00:00:00Z'}:{}})),registry=normalizeFacility({srvInstId:'C-STABLE',fcltNm:'기존 기관',fcltAddr:'서울특별시 종로구 공식길 999'});
  await writeFacilities(DB,'directory','old-directory',rows);await writeFacilities(DB,'facilities','base',[registry]);
  DB.sql.exec("INSERT INTO source_state(source,active_run_id,status,metadata) VALUES('directory','old-directory','ready','{}'),('facilities','base','ready','{}')");
  await DB.prepare("INSERT INTO source_state(source,status,metadata) VALUES('facility_geocoding','ready',?)").bind(JSON.stringify({runId:'old-audit',sourceVersions:[{source:'directory',active_run_id:'old-directory'},{source:'facilities',active_run_id:'base'}],processed:311,total:311})).run();
  let lookups=0;globalThis.fetch=(async(input:any)=>{if(String(input).includes('dapi.kakao.com')){lookups++;return new Response(JSON.stringify({documents:[{x:'126.98',y:'37.57',address:{region_1depth_name:'서울특별시',region_2depth_name:'종로구',main_address_no:'0'},road_address:{road_name:'공식길',main_building_no:'0'}}]}));}return new Response(directory);}) as any;
  try{assert.equal((await syncSource({DB,KAKAO_REST_KEY:'fixture-only'} as any,'directory',true)).status,'ready');assert.equal(lookups,1);}finally{globalThis.fetch=original;}
  const active=(await activeRecords<Facility>(DB,'facilities')).find(f=>f.id===rows[0].id)!;assert.equal(active.coordinate_source,'kakao-address');assert.ok(active.coordinate_checked_at);
  const status=await DB.prepare("SELECT metadata FROM source_state WHERE source='facility_geocoding'").first(),meta=JSON.parse(status.metadata);assert.equal(meta.processed,311);assert.equal(meta.confirmedRecords,310);assert.ok(meta.sourceVersions.some((s:any)=>s.source==='directory'&&s.active_run_id!=='old-directory'));
});

test('a unique geocoder result at the wrong building is left unresolved',async()=>{
  const original=globalThis.fetch;globalThis.fetch=(async()=>new Response(JSON.stringify({documents:[{x:'126.98',y:'37.57',address:{region_1depth_name:'서울특별시',region_2depth_name:'종로구',main_address_no:'99'},road_address:{road_name:'공식길',main_building_no:'99'}}]}))) as any;
  try{const r=await resolveOfficialAddress('fixture-only','서울특별시 종로구 공식길 1','서울특별시','종로구');assert.equal(r.status,'unresolved');assert.equal(r.latitude,null);}finally{globalThis.fetch=original;}
});

test('validated snapshot updates the existing registry and skips already confirmed geometry during fallback',async()=>{
  const DB=database(),a=normalizeFacility({srvInstId:'C-SNAPSHOT',fcltNm:'공식 기관',jrsdSggNm:'서울특별시 중구'}),b=normalizeFacility({srvInstId:'C-MISSING',fcltNm:'주소 비공개 기관',jrsdSggNm:'서울특별시 중구'});
  await writeFacilities(DB,'facilities','base',[a,b]);
  await DB.prepare("INSERT INTO source_state(source,active_run_id,status,last_success,metadata) VALUES('facilities','base','ready',?,'{\"record_format\":\"facility-basic-v2\"}')").bind(new Date().toISOString()).run();
  const location=normalizeOfficialMap({srvInstId:'C-SNAPSHOT',bkjrMngFaclId:'M-SNAPSHOT',faclNm:a.name,addrNm:'서울특별시 중구 공식길 1',faclTelno:'02-123-4567',faclLa:'37.56',faclLo:'126.99'});
  assert.equal(await applyVerifiedSnapshotLocations(DB,'base',[location],new Map([[a.id,a]])),1);
  await DB.prepare("INSERT INTO source_state(source,status,last_success,metadata) VALUES('official_map','ready',?,?)").bind(new Date().toISOString(),JSON.stringify({baseRunId:'base',mode:'official_snapshot',appliedDuringCollection:true,processed:1,matched:1})).run();
  const original=globalThis.fetch;globalThis.fetch=(async()=>{throw Error('No remote lookup is necessary for a verified point or a withheld address');}) as any;
  try{const result=await syncSource({DB,DATA_GO_KR_KEY:'fixture-only',KAKAO_REST_KEY:'fixture-only'} as any,'facilities');assert.equal(result.status,'ready');assert.equal(result.processed,2);assert.equal(result.coordinatesConfirmed,1);}finally{globalThis.fetch=original;}
  const found=await queryFacilities({DB} as any,new URL('https://test/'));assert.equal(found.total,2);assert.equal(found.mapItems.length,1);assert.equal(found.items.find(f=>f.id===a.id)!.registry_phone,null);
});

test('bundled official records have unique registry IDs, complete pages and business fields only',()=>{
  const root='data/official-facility-locations/',manifest=JSON.parse(readFileSync(root+'manifest.json','utf8')),seen=new Set<string>();let total=0;
  if (manifest.count === 0) {
    assert.equal(manifest.collected_at, '');
    assert.equal(manifest.raw_records_checked, 0);
    assert.deepEqual(manifest.chunks, []);
    return;
  }
  const allowed=new Set('bkjrMngFaclId srvInstId faclNm faclRdnmadr faclRdnmDtladr addrNm faclTelno faclLa faclLo ctpvNm sggNm bkjrMngFaclDcdStr'.split(' '));
  assert.ok(manifest.unique_service_ids);assert.equal(manifest.raw_records_checked,165990);
  for(const chunk of manifest.chunks){const rows=JSON.parse(readFileSync(root+chunk.file,'utf8'));assert.equal(rows.length,chunk.rows);assert.ok(rows.length<=500);for(const r of rows){assert.ok(!seen.has(r.srvInstId));seen.add(r.srvInstId);assert.ok(/^C/.test(r.srvInstId));assert.ok(Object.keys(r).every(k=>allowed.has(k)));}total+=rows.length;}
  assert.equal(total,manifest.count);assert.equal(seen.size,manifest.count);assert.ok(total>30000);
});

test('same-named districts require a province, parent municipality includes child districts',()=>{
  const base={...supplement[0],scope:'local',province:'부산광역시',district:'중구'} as Service;
  assert.equal(matchService(base,'','','','','all','서울특별시','중구'),false);
  assert.equal(matchService(base,'','','','','all','부산광역시','중구'),true);
  assert.equal(matchService({...base,province:'경기도',district:'수원시 장안구'},'','','','','all','경기도','수원시'),true);
});
test('national guides apply everywhere; whitespace search and filters remain available',()=>{
  assert.equal(supplement.filter(s=>matchService(s,'노인 맞춤 돌봄','','','','national','부산광역시','중구')).length,1);
  assert.equal(supplement.filter(s=>matchService(s,'','양육·교육','영유아·아동','온라인')).length,6);
  assert.equal(supplement.filter(s=>matchService(s,'없는서비스XYZ')).length,0);
});
test('all services lose only regional confirmations, including hidden services',()=>{
  const result=resetRegionalChecks({'daily-care':[0,1,2],'integrated-care':[0,1,2],'senior-job':[0,1,2],'birth-voucher':[0,1,2]},supplement);
  assert.deepEqual(result,{'daily-care':[0,1],'integrated-care':[0],'senior-job':[0],'birth-voucher':[0,1]});
});
test('official IDs merge with reviewed supplements once, not by region counts',()=>{
  const imported=normalizeService({servId:'WLF-TEST',servNm:'첫만남이용권',enfcBgngYmd:'20260101',enfcEndYmd:'20261231'},'national');
  const merged=mergeServices([imported]);assert.equal(merged.length,20);assert.equal(merged.filter(s=>s.name==='첫만남이용권').length,1);
  assert.equal(mergeServices([...supplement,imported]).length,20);assert.equal(imported.id,'birth-voucher');
  assert.equal(imported.application_status,'unknown');assert.equal(imported.application_period,null);assert.ok(imported.implementation_period);
});
test('geographic origin ignores application region without changing it; unknown coordinates excluded',()=>{
  const base=parseDirectory(directory)[0];const point={...base,latitude:37.57,longitude:126.98};
  assert.ok(haversine(37.57,126.98,37.57,126.98)<.001);
  const found=filterFacilities([base,point],'부산광역시','중구','daily-care',{lat:37.57,lon:126.98,radius:5});assert.equal(found.length,1);assert.equal(found[0].distance_km,0);
  assert.equal(point.province,'서울특별시');
});
test('provider relationships require an authoritative directory; ordinary facilities are not inferred',()=>{
  const result=parseDirectory(directory);assert.equal(result.length,310);assert.equal(result[0].role,'provider');assert.equal(result[0].latitude,null);assert.deepEqual(result[0].service_ids,['daily-care']);assert.ok(result[0].evidence_url);
  assert.throws(()=>parseDirectory('<html>일시 점검 중</html>'));assert.throws(()=>parseApi('<!DOCTYPE x><root/>'));
});
test('missing credentials are distinguishable from confirmed zero',async()=>{
  const DB=database();const result=await syncSource({DB} as any,'local');assert.equal(result.status,'needs_key');
  const report=await coverage({DB} as any,new URL('https://test/api/coverage?province=서울특별시&district=종로구'));
  assert.equal(report.localServices,null);assert.equal(report.items[0].localServices,null);assert.equal(report.items[0].status,'incomplete');
});
test('failed refresh preserves the active version and checkpoint resumes',async()=>{
  const DB=database();const original=globalThis.fetch;let broken=false;
  globalThis.fetch=(async()=>new Response(broken?'maintenance':directory)) as any;
  try{
    const first=await syncSource({DB} as any,'directory');assert.equal(first.status,'ready');assert.equal((await activeRecords(DB,'facilities')).length,310);
    broken=true;const failed=await syncSource({DB} as any,'directory',true);assert.equal(failed.status,'failed');assert.equal((await activeRecords(DB,'facilities')).length,310);
    broken=false;const recovered=await syncSource({DB} as any,'directory',true);assert.equal(recovered.status,'ready');assert.equal((await activeRecords(DB,'facilities')).length,310);
  }finally{globalThis.fetch=original;}
});
test('a concurrent job respects the source lease',async()=>{
  const DB=database();await DB.prepare("INSERT INTO source_state(source,status,metadata,lease_owner,lease_until) VALUES('directory','syncing','{}','another',?)").bind(new Date(Date.now()+60000).toISOString()).run();
  assert.equal((await syncSource({DB} as any,'directory')).status,'busy');
});
test('valid empty collection publishes zero; malformed collection never erases data',async()=>{
  const DB=database();const original=globalThis.fetch;
  try{
    globalThis.fetch=(async()=>new Response('<root><resultCode>00</resultCode><totalCount>0</totalCount></root>')) as any;
    assert.equal((await syncSource({DB,DATA_GO_KR_KEY:'fixture-only'} as any,'local')).status,'ready');
    assert.equal((await coverage({DB} as any,new URL('https://test/'))).localServices,0);
    globalThis.fetch=(async()=>new Response('<html>일시 점검</html>')) as any;
    assert.equal((await syncSource({DB,DATA_GO_KR_KEY:'fixture-only'} as any,'local',true)).status,'failed');
    assert.equal((await coverage({DB} as any,new URL('https://test/'))).localServices,0);
  }finally{globalThis.fetch=original;}
});
test('API list and detail produce a single complete published generation',async()=>{
  const DB=database();const original=globalThis.fetch;
  globalThis.fetch=(async(input:any)=>new Response(String(input).includes('detailed')?detail('WLF-TEST','첫만남이용권'):national('WLF-TEST','첫만남이용권'))) as any;
  try{assert.equal((await syncSource({DB,DATA_GO_KR_KEY:'fixture-only'} as any,'national')).status,'ready');assert.equal((await queryServices({DB} as any,new URL('https://test/?q=첫만남'))).total,1);}finally{globalThis.fetch=original;}
});

test('live national field names preserve conditions, steps and representative phone',()=>{
  const s=normalizeService({servId:'WLF00000022',servNm:'실응답 검증',tgtrDtlCn:'공식 대상 조건',slctCritCn:'공식 선정기준',rprsCtadr:'1588-0075',intrsThemaArray:'안전·위기',applmetList:[{servSeCode:'070',servSeDetailLink:'기관에서 신청'}]},'national');
  assert.equal(s.target,'공식 대상 조건 / 선정기준: 공식 선정기준');assert.equal(s.start,'기관에서 신청');assert.equal(s.contact_phone,'1588-0075');
});

test('masked facilities without addresses remain separate and retain official jurisdiction',()=>{
  const raw={fcltCd:'B0489',fcltNm:'공개명****',jrsdSggCd:'1123000000',jrsdSggNm:'서울특별시 동대문구'};
  const a=normalizeFacility(raw),b=normalizeFacility({...raw,fcltCd:'B0490'});
  assert.equal(a.province,'서울특별시');assert.equal(a.district,'동대문구');assert.equal(a.address,'');assert.equal(a.latitude,null);assert.equal(a.role,'related');
  assert.equal(mergeFacilities([a,b]).length,2);
});
test('facility pagination and visible map markers are from the same page',async()=>{
  const DB=database();const original=globalThis.fetch;globalThis.fetch=(async()=>new Response(directory)) as any;
  try{await syncSource({DB} as any,'directory');const d=await queryFacilities({DB} as any,new URL('https://test/?province=서울특별시&district=종로구&page=2'));assert.equal(d.total,310);assert.equal(d.items.length,20);assert.equal(d.mapItems.length,0);assert.equal(d.missingCoordinates,310);}finally{globalThis.fetch=original;}
});

test('exact institution duplicates retain evidence, and parent counts match resident lists',async()=>{
  const f={...parseDirectory(directory)[0],province:'경기도',district:'수원시 장안구',address:'경기도 수원시 장안구 검증길 1'};
  const related={...f,id:'registry:123',source:'facilities',source_id:'123',role:'related',service_ids:[],evidence_url:null,latitude:37.3,longitude:127.0,coordinate_source:'bokjiro-map',coordinate_source_url:'https://www.bokjiro.go.kr/',coordinate_checked_at:'2026-11-10T00:00:00Z'} as Facility;
  const merged=mergeFacilities([related,f]);assert.equal(merged.length,1);assert.equal(merged[0].role,'provider');assert.equal(merged[0].source_records!.length,2);assert.deepEqual(merged[0].service_ids,['daily-care']);
  assert.equal(merged[0].latitude,37.3);assert.equal(merged[0].coordinate_source,'bokjiro-map');assert.equal(merged[0].coordinate_checked_at,related.coordinate_checked_at);
  const DB=database();await DB.prepare("INSERT INTO source_state(source,active_run_id,status,metadata) VALUES('directory','fixture','ready','{}')").run();
  await DB.prepare('INSERT INTO facilities(source,run_id,id,province,district,payload) VALUES(?,?,?,?,?,?)').bind('directory','fixture',f.id,f.province,f.district,JSON.stringify(f)).run();
  const url=new URL('https://test/?province=경기도&district=수원시');
  assert.equal((await queryFacilities({DB} as any,url)).total,(await coverage({DB} as any,url)).items[0].confirmedFacilities);
});

test('regional pages of 100 institutions respect the hosted D1 binding limit',async()=>{
  const DB=database(100),rows=Array.from({length:125},(_,i)=>normalizeFacility({srvInstId:'LIMIT-'+i,fcltNm:'기관 '+i,fcltAddr:'서울특별시 중구 공식길 '+(i+1)}));
  await writeFacilities(DB,'facilities','limit-fixture',rows);
  await DB.prepare("INSERT INTO source_state(source,active_run_id,status,metadata) VALUES('facilities','limit-fixture','ready','{}')").run();
  const result=await queryFacilities({DB} as any,new URL('https://test/?province=서울특별시&district=중구&pageSize=100'));
  assert.equal(result.total,125);assert.equal(result.items.length,100);assert.equal(new Set(result.items.map(f=>f.id)).size,100);
});

test('same-source duplicate addresses use the same representative in SQL and merged payloads',async()=>{
  const DB=database(),a=normalizeFacility({srvInstId:'C-Z',fcltNm:'중복 기관',fcltAddr:'서울특별시 중구 공식길 1'}),b={...a,id:'facilities:C-A',source_id:'C-A'};
  await writeFacilities(DB,'facilities','duplicates',[a,b]);
  await DB.prepare("INSERT INTO source_state(source,active_run_id,status,metadata) VALUES('facilities','duplicates','ready','{}')").run();
  assert.equal(mergeFacilities([a,b])[0].id,b.id);
  const result=await queryFacilities({DB} as any,new URL('https://test/?province=서울특별시&district=중구'));
  assert.equal(result.total,1);assert.equal(result.items[0].id,b.id);assert.equal(result.items[0].source_records?.length,2);
});

test('bootstrap repairs an unactivated state without replacing successful generations',async()=>{
  const DB=database();await DB.prepare("INSERT INTO source_state(source,status,metadata) VALUES('directory','failed','{}')").run();
  await Promise.all([ensureBootstrap({DB} as any),ensureBootstrap({DB} as any),ensureBootstrap({DB} as any)]);const state=await DB.prepare("SELECT active_run_id FROM source_state WHERE source='directory'").first();
  const directory=JSON.parse(readFileSync('data/directory-snapshot.json','utf8'));
  assert.equal(state.active_run_id,directory.items.length?'snapshot-2026-11-10':null);
  assert.equal((await activeRecords(DB,'facilities')).length,directory.items.length);
  const curated=await DB.prepare("SELECT active_run_id FROM source_state WHERE source='curated'").first();
  assert.equal(curated.active_run_id,'snapshot-2026-11-10');
});

test('partial API generations resume after thirty-five records and duplicates cannot be activated',async()=>{
  const DB=database();const original=globalThis.fetch;
  const list='<root><resultCode>00</resultCode><totalCount>40</totalCount>'+Array.from({length:40},(_,i)=>`<servList><servId>W${i}</servId><servNm>테스트${i}</servNm></servList>`).join('')+'</root>';
  globalThis.fetch=(async(input:any)=>{const u=new URL(String(input));return new Response(u.pathname.includes('detailed')?detail(u.searchParams.get('servId')!,'테스트'+u.searchParams.get('servId')):list);}) as any;
  try{
    assert.equal((await syncSource({DB,DATA_GO_KR_KEY:'fixture-only'} as any,'national')).status,'running');assert.equal((await activeRecords(DB,'services')).length,0);
    assert.equal((await syncSource({DB,DATA_GO_KR_KEY:'fixture-only'} as any,'national')).status,'ready');assert.equal((await activeRecords(DB,'services')).length,40);
    globalThis.fetch=(async(input:any)=>new Response(String(input).includes('detailed')?detail('DUP','중복'):list.replace(/W\d+/g,'DUP'))) as any;
    await syncSource({DB,DATA_GO_KR_KEY:'fixture-only'} as any,'national',true);
    assert.equal((await syncSource({DB,DATA_GO_KR_KEY:'fixture-only'} as any,'national',true)).status,'failed');assert.equal((await activeRecords(DB,'services')).length,40);
  }finally{globalThis.fetch=original;}
});

test('nationwide queries page payloads and agree with coverage at 42,000 densely mapped facilities and 4,828 local services',async()=>{
  const DB=database(),base=parseDirectory(directory)[0];
  DB.sql.exec("INSERT INTO source_state(source,active_run_id,status,metadata) VALUES('facilities','fixture','ready','{}'),('local','fixture','ready','{}'); BEGIN");
  const facility=DB.sql.prepare('INSERT INTO facilities(source,run_id,id,province,district,latitude,longitude,payload) VALUES(?,?,?,?,?,?,?,?)');
  for(let i=0;i<42000;i++){
    const province=i%2?'부산광역시':'서울특별시';const latitude=i%10!==0?37.57:null,longitude=latitude===null?null:126.98;
    const f={...base,id:'facilities:TEST'+i,source_id:'TEST'+i,source:'facilities',name:'공개명****',province,district:'중구',address:'',phone:null,latitude,longitude,role:'related',service_ids:[],evidence_url:null};
    facility.run('facilities','fixture',f.id,province,'중구',latitude,longitude,JSON.stringify(f));
  }
  const service=DB.sql.prepare('INSERT INTO services(source,run_id,id,scope,province,district,payload) VALUES(?,?,?,?,?,?,?)');
  for(let i=0;i<4828;i++){
    const province=i%2?'부산광역시':'서울특별시';const s={...supplement[0],id:'local:TEST'+i,source:'local',source_id:'TEST'+i,canonical_id:undefined,scope:'local',province,district:'중구',name:'지역지원'+i,needs:['생활비·위기']};
    service.run('local','fixture',s.id,'local',province,'중구',JSON.stringify(s));
  }
  DB.sql.exec('COMMIT');
  DB.sql.exec("DELETE FROM source_state WHERE source='facility_index'");
  let indexed=await backfillFacilityIndex(DB);assert.equal(indexed.processed,2000);assert.equal(await facilityIndexReady(DB),false);
  while(!await facilityIndexReady(DB))indexed=await backfillFacilityIndex(DB);
  assert.equal(indexed.processed,42000);
  const url=new URL('https://test/?province=서울특별시&district=중구');
  const a=await queryFacilities({DB} as any,url);assert.equal(a.total,21000);assert.equal(a.items.length,20);
  const b=await queryFacilities({DB} as any,new URL(url+'&page=2'));assert.equal(new Set([...a.items,...b.items].map(f=>f.id)).size,40);
  const near=await queryFacilities({DB} as any,new URL('https://test/?province=부산광역시&lat=37.57&lon=126.98&radius=5'));assert.equal(near.total,37800);assert.equal(near.items.length,20);assert.equal(near.mapItems.length,20);
  const nationwide=await queryFacilities({DB} as any,new URL('https://test/'));assert.equal(nationwide.total,42000);assert.equal(nationwide.missingCoordinates,4200);assert.equal(nationwide.items.length,20);
  const found=await queryServices({DB} as any,new URL(url+'&scope=local&need='+encodeURIComponent('생활비·위기')));assert.equal(found.total,2414);assert.equal(found.items.length,20);
  const report=await coverage({DB} as any,url);assert.equal(report.items[0].confirmedFacilities,a.total);assert.equal(report.items[0].localServices,found.total);assert.equal(report.confirmedFacilities,42000);assert.equal(report.localServices,4828);
  const unlinked=await queryFacilities({DB} as any,new URL(url+'&serviceId=daily-care'));assert.equal(unlinked.total,0);
  assert.ok(DB.reads.every((r:{payloadRows:number})=>r.payloadRows<=20),'full facility/service payloads must stay in the database until pagination');
});

test('SQL pagination merges exact duplicates with proof and coordinate fallback',async()=>{
  const DB=database(),base=parseDirectory(directory)[0];
  const provider={...base,id:'dir:one',source_id:'one',name:'공식 기관',address:'서울특별시 종로구 검증길 1'};
  const registered={...provider,id:'fac:one',source_id:'two',source:'facilities',role:'related',service_ids:[],evidence_url:null,latitude:37.57,longitude:126.98} as Facility;
  await writeFacilities(DB,'directory','fixture',[provider]);await writeFacilities(DB,'facilities','fixture',[registered]);
  DB.sql.exec("INSERT INTO source_state(source,active_run_id,status,metadata) VALUES('directory','fixture','ready','{}'),('facilities','fixture','ready','{}')");
  const result=await queryFacilities({DB} as any,new URL('https://test/?province=서울특별시&district=종로구&serviceId=daily-care'));
  assert.equal(result.total,1);assert.equal(result.items[0].id,'dir:one');assert.equal(result.items[0].source_records!.length,2);assert.equal(result.mapItems.length,1);assert.equal(result.missingCoordinates,0);
  const report=await coverage({DB} as any,new URL('https://test/?province=서울특별시&district=종로구'));assert.equal(report.items[0].confirmedFacilities,1);assert.equal(report.items[0].linkedServices,1);
});

test('facility bulk collection follows capped 100-row pages and resumes after ten pages',async()=>{
  const DB=database(),original=globalThis.fetch,pages:number[]=[];
  globalThis.fetch=(async(input:any)=>{
    const u=new URL(String(input));assert.equal(u.searchParams.get('numOfRows'),'100');const page=Number(u.searchParams.get('pageNo'));pages.push(page);
    assert.ok(u.pathname.endsWith('/getFcltByBassInfoInqire2'),'collect pageable basic information rather than the identifier-only list');
    const start=(page-1)*100,count=Math.max(0,Math.min(100,1105-start));
    const items=Array.from({length:count},(_,i)=>`<item><fcltCd>FIX${start+i}</fcltCd><fcltNm>검증기관${start+i}</fcltNm><jrsdSggNm>서울특별시 종로구</jrsdSggNm></item>`).join('');
    return new Response(`<response><header><resultCode>00</resultCode></header><body><items>${items}</items><totalCount>1105</totalCount><numOfRows>100</numOfRows><pageNo>${page}</pageNo></body></response>`);
  }) as any;
  try{
    const a=await syncSource({DB,DATA_GO_KR_KEY:'fixture-only'} as any,'facilities');assert.equal(a.status,'running');assert.equal(a.processed,1000);assert.equal((await activeRecords(DB,'facilities')).length,0);
    const b=await syncSource({DB,DATA_GO_KR_KEY:'fixture-only'} as any,'facilities');assert.equal(b.status,'ready');assert.equal(b.processed,1105);assert.equal((await activeRecords(DB,'facilities')).length,1105);
    assert.deepEqual(pages,Array.from({length:12},(_,i)=>i+1));
  }finally{globalThis.fetch=original;}
});

test('official basic facility fields preserve full address and public phone by source ID',()=>{
  const f=normalizeFacility({fcltCd:'OFFICIAL123',fcltNm:'동일명 복지관',jrsdSggCd:'1114000000',fcltAddr:'서울특별시 중구',fcltDtl_1Addr:'다산로6길 11',fcltDtl_2Addr:'2층',fcltTelNo:'',fcltTelNo2:'02-2234-3515'});
  assert.equal(f.id,'facilities:OFFICIAL123');assert.equal(f.address,'서울특별시 중구 다산로6길 11 2층');assert.equal(f.phone,'02-2234-3515');
  assert.equal(f.province,'서울특별시');assert.equal(f.district,'중구');assert.equal(f.role,'related');assert.deepEqual(f.service_ids,[]);
  assert.ok(f.detail_source_url?.endsWith('getFcltByBassInfoInqire2'));assert.ok(f.detail_checked_at);
  assert.equal(normalizeFacility({fcltCd:'DUP',fcltNm:'중복주소',fcltAddr:'서울특별시 중구 다산로6길 11',fcltDtl_1Addr:'서울특별시 중구 다산로6길 11'}).address,'서울특별시 중구 다산로6길 11');
  const a=normalizeFacility({fcltCd:'SHARED',srvInstId:'SERVICE-A',fcltNm:'기관 A'}),b=normalizeFacility({fcltCd:'SHARED',srvInstId:'SERVICE-B',fcltNm:'기관 B'});
  assert.notEqual(a.id,b.id);assert.equal(a.registry_facility_code,b.registry_facility_code);assert.equal(a.service_institution_id,'SERVICE-A');
});

test('verified source IDs replace title variants while umbrella guides stay outside API counts',async()=>{
  const DB=database();
  // Exercise records saved before the source-ID mapping existed as well as new imports.
  const records=Object.entries(curatedServiceLinks).map(([id,sourceId])=>({
    ...supplement.find(s=>s.id===id)!,id:'national:'+sourceId,canonical_id:undefined,
    source:'national',source_id:sourceId,name:id==='parent-pay'?'부모급여 지원':'공식 명칭 '+id,
    support:'공식 지원&#13;조건 &lsquo;확인&rsquo;',keywords:[],action_url:'https://www.bokjiro.go.kr/'
  } as Service));
  await writeServices(DB,'national','fixture',records);
  DB.sql.exec("INSERT INTO source_state(source,active_run_id,status,metadata) VALUES('national','fixture','ready','{}')");
  const found=await queryServices({DB} as any,new URL('https://test/?pageSize=100'));
  assert.equal(found.total,20);assert.equal(found.serviceCount,16);assert.equal(found.guideCount,4);
  assert.equal(found.items.filter(s=>s.id==='parent-pay').length,1);
  const keyword='활동보조';
  const keywordResults=await queryServices({DB} as any,new URL('https://test/?q='+encodeURIComponent(keyword)));
  assert.ok(keywordResults.items?.some(s=>s.id==='disability-activity'&&s.keywords.includes(keyword)));
  const birth=found.items.find(s=>s.id==='birth-voucher')!;
  assert.equal(birth.action_url,supplement.find(s=>s.id==='birth-voucher')!.action_url);
  assert.equal(birth.support,'공식 지원 조건 ‘확인’');assert.equal(birth.record_kind,'service');
  const umbrella=found.items.find(s=>s.id==='long-term-care')!;assert.equal(umbrella.record_kind,'guide');
  assert.equal(curatedServiceLinks['long-term-care'],undefined);
  const report=await coverage({DB} as any,new URL('https://test/'));
  assert.equal(report.nationalServices,16);assert.equal(report.nationalGuides,4);
  assert.equal(report.items[0].knownServices,16);
});

test('official response entities become readable text without rendering markup',()=>{
  assert.equal(flattenText('지원&#13;내용 &amp; &lsquo;안내&rsquo; &lt;br&gt; 확인'),'지원 내용 & ‘안내’ 확인');
  assert.equal(flattenText('&#x1F4DE; &amp;#13; 문의'),'📞 문의');
});

test('daily refresh uses Korean dates and retains only current and previous payload generations',async()=>{
  assert.equal(collectionDay('2026-11-10T21:00:00Z'),'2026-11-11');
  assert.equal(collectionDay('2026-11-11T00:00:00Z'),'2026-11-11');
  const DB=database(),original=globalThis.fetch;globalThis.fetch=(async()=>new Response(directory)) as any;
  try{
    const runs=[];for(let i=0;i<3;i++)runs.push(await syncSource({DB} as any,'directory',true));
    const saved=await DB.prepare('SELECT DISTINCT run_id FROM facilities ORDER BY run_id').all();
    assert.deepEqual(saved.results.map((r:any)=>r.run_id).sort(),runs.slice(1).map(r=>r.runId).sort());
    assert.equal((await DB.prepare('SELECT count(*) n FROM sync_runs').first()).n,3);
    assert.equal((await activeRecords(DB,'facilities')).length,310);
  }finally{globalThis.fetch=original;}
});

test('verified contacts lead the regional list and missing details stay visible in coverage',async()=>{
  const DB=database(),base=parseDirectory(directory)[0];
  const provider={...base,id:'dir:z',source_id:'z',name:'하단 이름 공식기관'};
  const related={...base,id:'fac:a',source_id:'a',source:'facilities',name:'가나다 시설',address:'',phone:null,role:'related',service_ids:[],evidence_url:null} as Facility;
  await writeFacilities(DB,'directory','fixture',[provider]);await writeFacilities(DB,'facilities','fixture',[related]);
  DB.sql.exec("INSERT INTO source_state(source,active_run_id,status,metadata) VALUES('directory','fixture','ready','{}'),('facilities','fixture','ready','{}')");
  const url=new URL('https://test/?province=서울특별시&district=종로구');
  const found=await queryFacilities({DB} as any,url);assert.equal(found.items[0].id,'dir:z');assert.equal(found.total,2);
  const r=(await coverage({DB} as any,url)).items[0];
  assert.equal(r.missingAddress,1);assert.equal(r.missingPhone,1);assert.equal(r.missingCoordinates,2);assert.equal(r.informationNeedsReview,true);
  DB.sql.exec("UPDATE source_state SET active_run_id='next-empty-generation' WHERE source='facilities'");
  const refreshed=(await coverage({DB} as any,url)).items[0];assert.equal(refreshed.confirmedFacilities,1);assert.equal(refreshed.missingAddress,0);
});

test('unknown facility districts stay at province level while province-wide benefits remain applicable',async()=>{
  const DB=database(),base=parseDirectory(directory)[0];
  const unknown={...base,id:'fac:unknown',source_id:'unknown',source:'facilities',district:'',address:'',phone:null,role:'related',service_ids:[],evidence_url:null} as Facility;
  await writeFacilities(DB,'directory','fixture',[base]);await writeFacilities(DB,'facilities','fixture',[unknown]);
  DB.sql.exec("INSERT INTO source_state(source,active_run_id,status,metadata) VALUES('directory','fixture','ready','{}'),('facilities','fixture','ready','{}')");
  const district=new URL('https://test/?province=서울특별시&district=종로구');
  assert.equal((await queryFacilities({DB} as any,district)).total,1);
  assert.equal((await queryFacilities({DB} as any,new URL('https://test/?province=서울특별시'))).total,2);
  const row=(await coverage({DB} as any,district)).items[0];assert.equal(row.confirmedFacilities,1);assert.equal(row.unmappedInProvince,1);
  assert.equal(matchService({...supplement[0],scope:'local',province:'서울특별시',district:''},'','','','','all','서울특별시','종로구'),true);
});

test('geocoding resumes in bounded concurrent batches, reuses unchanged coordinates and preserves good data on failure',async()=>{
  const DB=database(),original=globalThis.fetch;let html=directory,broken=false,active=0,maxActive=0,calls=0;
  globalThis.fetch=(async(input:any)=>{
    const u=new URL(String(input));if(u.hostname!=='dapi.kakao.com')return new Response(html);
    calls++;active++;maxActive=Math.max(maxActive,active);await Promise.resolve();active--;
    if(broken)return Response.json({unexpected:'response'});
    const n=Number(u.searchParams.get('query')!.match(/ (\d+)$/)![1]);
    const point={x:'126.98',y:'37.57',address:{region_1depth_name:'서울특별시',region_2depth_name:'종로구',main_address_no:String(n)},road_address:{road_name:'공식길',main_building_no:String(n)}};
    return Response.json({documents:n===0?[]:n===1?[{x:'0',y:'0'}]:n===2?[point,point]:[point]});
  }) as any;
  const env={DB,KAKAO_REST_KEY:'fixture-only'} as any;
  try{
    let result=await syncSource(env,'directory');assert.equal(result.processed,8);assert.equal(calls,8);assert.equal((await activeRecords(DB,'facilities')).length,0);
    while(result.status==='running'){const before=calls;result=await syncSource(env,'directory');assert.ok(calls-before<=24);}
    assert.equal(result.status,'ready');assert.equal(result.coordinatesConfirmed,307);assert.equal(calls,310);assert.ok(maxActive>1&&maxActive<=4);
    const known=(await activeRecords<Facility>(DB,'facilities')).find(f=>f.name==='검증기관3')!;assert.equal(known.coordinate_source,'kakao-address');assert.ok(known.coordinate_checked_at);
    let before=calls;const cached=await syncSource(env,'directory',true);assert.equal(cached.status,'ready');assert.equal(calls-before,3);
    assert.equal((await activeRecords<Facility>(DB,'facilities')).find(f=>f.id===known.id)!.coordinate_checked_at,known.coordinate_checked_at);
    html=html.replace('공식길 10</td>','공식길 900</td>');before=calls;assert.equal((await syncSource(env,'directory',true)).status,'ready');assert.equal(calls-before,4);
    const previous=(await DB.prepare("SELECT active_run_id FROM source_state WHERE source='directory'").first()).active_run_id;
    broken=true;assert.equal((await syncSource(env,'directory',true)).status,'failed');assert.equal((await DB.prepare("SELECT active_run_id FROM source_state WHERE source='directory'").first()).active_run_id,previous);
    assert.equal((await activeRecords<Facility>(DB,'facilities')).filter(f=>f.latitude!==null).length,307);
    broken=false;assert.equal((await syncSource(env,'directory')).status,'ready');
  }finally{globalThis.fetch=original;}
});

test('coordinate warnings follow the service/search filter and map bounds remain independent of application region',async()=>{
  const DB=database(),base=parseDirectory(directory)[0];
  const known={...base,id:'dir:known',source_id:'known',name:'좋은기관',latitude:37.57,longitude:126.98};
  const unknown={...base,id:'dir:unknown',source_id:'unknown',name:'확인기관',address:'서울특별시 종로구 별도길 2'};
  const related={...unknown,id:'fac:related',source_id:'related',source:'facilities',name:'관련시설',role:'related',service_ids:[],evidence_url:null} as Facility;
  await writeFacilities(DB,'directory','fixture',[known,unknown]);await writeFacilities(DB,'facilities','fixture',[related]);
  DB.sql.exec("INSERT INTO source_state(source,active_run_id,status,metadata) VALUES('directory','fixture','ready','{}'),('facilities','fixture','ready','{}')");
  const query='https://test/?province=서울특별시&district=종로구';
  const all=await queryFacilities({DB} as any,new URL(query));assert.equal(all.total,3);assert.equal(all.missingCoordinates,2);
  const providers=await queryFacilities({DB} as any,new URL(query+'&serviceId=daily-care'));assert.equal(providers.total,2);assert.equal(providers.missingCoordinates,1);
  const named=await queryFacilities({DB} as any,new URL(query+'&serviceId=daily-care&q=좋은기관'));assert.equal(named.total,1);assert.equal(named.missingCoordinates,0);
  const bounds=await queryFacilities({DB} as any,new URL('https://test/?province=부산광역시&district=중구&bbox=37.56,126.97,37.58,126.99'));
  assert.equal(bounds.total,1);assert.equal(bounds.items[0].id,known.id);assert.equal(bounds.missingCoordinates,0);
});


test('provider directory follows the service and province even if facility lookup returns no rows',()=>{
  const guide=(id:string)=>supplement.find(s=>s.id===id)!;
  const [,incheon]=directoryRoute(guide('daily-care'),'인천광역시');
  assert.equal(new URL(incheon).searchParams.get('og_type'),'인천광역시');
  const [,disability]=directoryRoute(guide('disability-activity'),'인천광역시');
  assert.equal(new URL(disability).hostname,'www.ableservice.or.kr');
  assert.equal(directoryRoute(guide('safety'),'인천광역시')[1],guide('safety').action_url);
});

test('unknown official modification dates stay unknown, and the collection day uses Korean time',()=>{
  const raw={servId:'WLF-TEST',servNm:'지역 도움'};
  const at='2026-11-18T16:00:00.000Z';
  const service=normalizeService(raw,'local',at);
  assert.equal(service.source_date,'');
  assert.equal(service.checked_on,'2026-11-19');
  assert.equal(service.collected_at,at);
  assert.equal(normalizeService({...raw,lastModYmd:'20261031'},'local',at).source_date,'20261031');
});


test('location-specific facility responses bypass the shared public read cache',async()=>{
  const DB=database();
  const url=new URL('https://test/?lat=37.57&lon=126.98&radius=2');
  await queryFacilities({DB} as any,url);
  const first=DB.reads.length;
  await queryFacilities({DB} as any,url);
  assert.equal(DB.reads.length-first,first);
});
