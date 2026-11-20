'use client';
import { useEffect,useRef,useState } from 'react';
import type { Facility } from '../../lib/caregap/types';
declare global {interface Window {kakao:any}}
let sdk:Promise<void>|null=null;
function load(key:string){
  if(window.kakao?.maps?.LatLng)return Promise.resolve();if(sdk)return sdk;
  sdk=new Promise<void>((resolve,reject)=>{const script=document.createElement('script');script.src=`https://dapi.kakao.com/v2/maps/sdk.js?appkey=${encodeURIComponent(key)}&autoload=false`;
    const fail=()=>{clearTimeout(timer);script.remove();sdk=null;reject(Error('지도 연결 실패'));};
    const timer=setTimeout(fail,15000);
    script.onload=()=>window.kakao?.maps?.load?window.kakao.maps.load(()=>{clearTimeout(timer);resolve();}):fail();
    script.onerror=fail;document.head.appendChild(script);});return sdk;
}
export default function FacilityMap({apiKey,items,selected,onSelect,onBounds}:{apiKey:string|null;items:Facility[];selected:string;onSelect:(id:string)=>void;onBounds:(bbox:string)=>void}){
  const element=useRef<HTMLDivElement>(null),map=useRef<any>(null),markers=useRef<any[]>([]);const [error,setError]=useState(''),[loaded,setLoaded]=useState(false);
  const selectRef=useRef(onSelect),boundsRef=useRef(onBounds);selectRef.current=onSelect;boundsRef.current=onBounds;
  useEffect(()=>{if(!apiKey||!element.current)return;let cancelled=false;load(apiKey).then(()=>{if(cancelled||!element.current)return;
    map.current=new window.kakao.maps.Map(element.current,{center:new window.kakao.maps.LatLng(36.5,127.8),level:13});
    window.kakao.maps.event.addListener(map.current,'idle',()=>{const b=map.current.getBounds();boundsRef.current([b.getSouthWest().getLat(),b.getSouthWest().getLng(),b.getNorthEast().getLat(),b.getNorthEast().getLng()].join(','));});setLoaded(true);
  }).catch(()=>!cancelled&&setError('지도를 불러오지 못했습니다. 기관 목록과 외부 길찾기를 이용하세요.'));
    return()=>{cancelled=true;markers.current.forEach(m=>m.setMap(null));map.current=null;};},[apiKey]);
  useEffect(()=>{if(!loaded||!map.current)return;const k=window.kakao;markers.current.forEach(m=>m.setMap(null));markers.current=[];const bounds=new k.maps.LatLngBounds();
    for(const f of items){if(f.latitude===null||f.longitude===null)continue;const pos=new k.maps.LatLng(f.latitude,f.longitude),m=new k.maps.Marker({position:pos,map:map.current,title:f.name});k.maps.event.addListener(m,'click',()=>selectRef.current(f.id));markers.current.push(m);bounds.extend(pos);}if(markers.current.length)map.current.setBounds(bounds);
  },[loaded,items]);
  useEffect(()=>{const f=items.find(i=>i.id===selected);if(map.current&&f&&f.latitude!==null&&f.longitude!==null)map.current.panTo(new window.kakao.maps.LatLng(f.latitude,f.longitude));},[selected,items]);
  return <div className="map-frame"><div ref={element} className="map-canvas" aria-label="현재 목록의 기관 지도" role="region" hidden={!apiKey||!!error}/>
    {(!apiKey||error)&&<div className="map-empty"><span aria-hidden="true">⌖</span><h3>{apiKey?'지도 연결이 원활하지 않습니다':'기관 지도 연계를 준비하고 있습니다'}</h3><p>{error||'확인된 기관의 주소·전화·외부 길찾기는 아래 목록에서 이용할 수 있습니다.'}</p><a className="text-link" href="https://www.bokjiro.go.kr/ssis-tbu/twatca/wlfcl/wlfclPage.do" target="_blank" rel="noreferrer">복지로 공식 복지지도 열기 ↗</a></div>}
    {apiKey&&!error&&!items.length&&<p className="map-caption">현재 목록에서 좌표가 확인된 기관이 없습니다. 주소가 있는 기관은 목록에서 확인하세요.</p>}
    <p className="map-caption">현재 페이지에서 좌표가 확인된 기관만 지도에 표시합니다. 기관 수는 이용 정원이나 수혜자 수를 뜻하지 않습니다.</p></div>;
}
