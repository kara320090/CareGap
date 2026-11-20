import type { Region } from './types';
export const regionListUrl='https://www.code.go.kr/stdcode/regCodeL.do';
// Official active-only search, read as text, never execute the returned scripts.
// Stream large HTML to avoid retaining all 20k+ neighbourhood rows in a Worker.
export async function readActiveRegionList(response:Response,date:string):Promise<Region[]>{
  if(!response.ok||!response.body)throw Error('현존 법정동 목록 응답 실패');
  const reader=response.body.getReader(),decoder=new TextDecoder();
  const rows:Region[]=[],ids=new Set<string>();let buffer='',bytes=0,seen=0,total:number|null=null;
  const pair=/<td\b[^>]*>\s*(\d{10})\s*<\/td>\s*<td\b[^>]*>\s*([^<]+?)\s*<\/td>/gi;
  const consume=(done:boolean)=>{
    if(total===null){const m=buffer.match(/var\s+cnt\s*=\s*(\d+)\s*;/);if(m)total=Number(m[1]);}
    let match:RegExpExecArray|null,last=0;pair.lastIndex=0;
    while((match=pair.exec(buffer))){
      last=pair.lastIndex;seen++;const id=match[1];if(!id.endsWith('00000'))continue;
      const words=match[2].trim().split(/\s+/);if(words.length===1&&words[0]==='세종특별자치시')words.push('세종시');if(words.length<2)continue;
      if(ids.has(id))throw Error('현존 목록의 지역 코드 중복');ids.add(id);
      rows.push({id,province:words[0],district:words.slice(1).join(' '),source:'mois-active-code-list',source_date:date,verified_current:true});
    }
    // A code/name cell pair is <1KB; bound unparsed carry as well as total bytes.
    buffer=buffer.slice(last||Math.max(0,buffer.length-8192));
    if(done&&buffer.length>8192)buffer=buffer.slice(-8192);
  };
  try{
    while(true){const part=await reader.read();if(part.done)break;bytes+=part.value.length;
      if(bytes>16_000_000)throw Error('현존 목록 응답 크기 검증 실패');
      buffer+=decoder.decode(part.value,{stream:true});consume(false);
    }
    buffer+=decoder.decode();consume(true);
  }finally{reader.releaseLock();}
  if(total===null||total<200||total>30000||seen!==total||rows.length<200||rows.length>1000)throw Error(`현존 목록 완전성 검증 실패 (${seen}/${total??'미확인'})`);
  return rows;
}
export async function activeRegions(date:string):Promise<Region[]>{
  const response=await fetch(regionListUrl,{method:'POST',body:new URLSearchParams({pageSize:'30000',cPage:'1',disuseAt:'0',codeseId:'00002'}),
    headers:{'Content-Type':'application/x-www-form-urlencoded',Referer:regionListUrl},signal:AbortSignal.timeout(30000)});
  return readActiveRegionList(response,date);
}
