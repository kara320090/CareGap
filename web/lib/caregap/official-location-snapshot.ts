import data from '../../data/official-facility-locations/manifest.json';
type Manifest={source_url:string;collected_at:string;raw_records_checked:number;count:number;unique_service_ids?:boolean;regions:{province:string;district:string}[];chunks:{file:string;rows:number;regionsDone:number}[]};
const manifest=data as Manifest;
// These are dated, validated public business records, never keys or private contacts.
const loaders=import.meta.glob('../../data/official-facility-locations/[0-9]*.json',{import:'default'});
export function officialSnapshotManifest(){
  if (!manifest.count && !manifest.chunks.length && !manifest.collected_at) return null;
  if(manifest.count<1000||!manifest.unique_service_ids||manifest.chunks.reduce((n,p)=>n+p.rows,0)!==manifest.count)throw Error('공식 기관 보완본 전체 건수 검증 실패');
  return manifest;
}
export async function officialSnapshotChunk(index:number){
  const part=manifest.chunks[index],load=part&&loaders['../../data/official-facility-locations/'+part.file];
  if(!load)throw Error('공식 기관 보완본 페이지 확인 필요');
  const rows=await load() as any[];
  if(rows.length!==part.rows)throw Error('공식 기관 보완본 페이지 건수 검증 실패');
  return {rows,total:manifest.count,regionsDone:part.regionsDone};
}
