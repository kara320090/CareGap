// Exact finite dynamic programming for the public model's disclosed bounds.
// Variable regional prices; productivity 4 and cap 15 remain explicit assumptions.
import { unitCost, gainPerUnit } from './model.js';
const scale=10000,cap=15,names=['형평성 우선','수요 비례','부족분 우선'];
const gain=(a,x)=>Math.min(a.demand-a.base,x*gainPerUnit);
const capacity=a=>Math.min(cap,Math.ceil((a.demand-a.base)/gainPerUnit));
const validCost = value => Number.isSafeInteger(value) && value >= 1 && value <= 10_000_000_000;
export const unavailableAllocation = (status, reason) => ({
  areas: [], limit: 0, results: names.map(name => ({name,status,reason,units:[],lowest:null,extra:null,spent:null})),
});
export function alternativeRanks(results) {
  if (results.some(result => result.status !== "CALCULATED")) return results.map(() => "미확정");
  const compare = (left,right) => right.lowestUnits-left.lowestUnits || right.extra-left.extra || left.spent-right.spent;
  return results.map(result => {
    const rank = 1 + results.filter(other => compare(other,result) < 0).length;
    const tied = results.filter(other => compare(other,result) === 0).length > 1;
    return (tied ? "공동 " : "") + rank + "위";
  });
}
export function scaledCosts(rows,costs,percent){
  if(!Number.isFinite(percent)||percent<1||percent>1000)throw Error('단가 배율은 1~1,000% 범위여야 합니다.');
  return Object.fromEntries(rows.filter(row => row.users !== null && row.demand > 0).map(row => {
    const original = costs[row.id] ?? unitCost;
    if (!validCost(original)) throw Error(row.id + ' 기준 단가는 1~10,000,000,000원 정수여야 합니다.');
    const value = Math.round(original * percent / 100);
    if (!validCost(value)) throw Error(row.id + ' 변경 단가는 1~10,000,000,000원 정수여야 합니다.');
    return [row.id, value];
  }));
}
function fair(areas,budget){
  const minimum=target=>areas.map(a=>Math.max(0,Math.ceil((Math.ceil(target*a.demand/scale)-a.base)/gainPerUnit)));
  let low=0,high=scale;
  while(low<high){const m=Math.ceil((low+high)/2),needed=minimum(m);
    if(needed.every((x,i)=>x<=capacity(areas[i]))&&needed.reduce((s,x,i)=>s+x*areas[i].cost,0)<=budget)low=m;else high=m-1;}
  const lowers=minimum(low),maxGain=areas.reduce((s,a)=>s+gain(a,capacity(a)),0);
  let costs=new Float64Array(maxGain+1);costs.fill(Infinity);costs[0]=0;
  const trace=[];let previousMax=0;
  areas.forEach((a,i)=>{
    const next=new Float64Array(maxGain+1);next.fill(Infinity);const choice=new Uint8Array(maxGain+1);
    const upper=capacity(a),newMax=previousMax+gain(a,upper);
    for(let total=0;total<=previousMax;total++)if(costs[total]<=budget){
      for(let x=lowers[i];x<=upper;x++){
        const extra=total+gain(a,x),spent=costs[total]+x*a.cost;
        if(spent<=budget&&spent<next[extra]){next[extra]=spent;choice[extra]=x;}
      }
    }
    costs=next;trace.push(choice);previousMax=newMax;
  });
  let best=maxGain;while(best>0&&!Number.isFinite(costs[best]))best--;
  return trace.reduceRight((units,choice,i)=>{units[i]=choice[best];best-=gain(areas[i],units[i]);return units;},[]);
}
function proportional(areas,budget){
  const demand=areas.reduce((s,a)=>s+a.demand,0);
  // Match the local baseline's demand share of budget, then unit shortfall.
  const targets=areas.map(a=>{const denom=demand*a.cost,numer=budget*a.demand;return {floor:Math.floor(numer/denom),remainder:numer%denom,denom};});
  let remaining=budget;
  const units=areas.map((a,i)=>{const n=Math.min(capacity(a),targets[i].floor,Math.floor(remaining/a.cost));remaining-=n*a.cost;return n;});
  while(true){let best=-1;
    areas.forEach((a,i)=>{if(units[i]>=capacity(a)||a.cost>remaining)return;
      if(best<0||units[i]-targets[i].floor<units[best]-targets[best].floor||
        (units[i]-targets[i].floor===units[best]-targets[best].floor&&targets[i].remainder/targets[i].denom>targets[best].remainder/targets[best].denom))best=i;});
    if(best<0)break;units[best]++;remaining-=areas[best].cost;
  }
  return units;
}
function gap(areas,budget){
  const units=areas.map(()=>0),order=areas.map((_,i)=>i).sort((a,b)=>(areas[b].demand-areas[b].base)-(areas[a].demand-areas[a].base)||a-b);
  for(const i of order){units[i]=Math.min(capacity(areas[i]),Math.floor(budget/areas[i].cost));budget-=units[i]*areas[i].cost;}return units;
}
export function compareCostedAllocations(rows,budget,costs={}){
  const unavailable=unavailableAllocation;
  if(!Number.isSafeInteger(budget)||budget<0||budget>200_000_000)return unavailable('INPUT_ERROR','예산은 0~2억원의 정수여야 합니다.');
  if(!Array.isArray(rows)||new Set(rows.map(r=>r.id)).size!==rows.length||rows.some(r=>!Number.isSafeInteger(r.demand)||r.demand<0||(r.users!==null&&(!Number.isSafeInteger(r.users)||r.users<0))))return unavailable('INPUT_ERROR','원본 수요·이용자·지역 키를 확인하세요.');
  const areas=rows.filter(r=>r.users!==null&&r.demand>0).map(r=>({...r,base:Math.min(r.users,r.demand),cost:costs[r.id]??unitCost})).sort((a,b)=>a.id<b.id?-1:a.id>b.id?1:0);
  if(areas.some(a=>!validCost(a.cost)))return unavailable('INPUT_ERROR','지역별 단가는 1~10,000,000,000원 정수여야 합니다.');
  if(!areas.length)return unavailable('NO_DATA','이용값이 확인되고 수요가 양수인 지역이 없습니다.');
  return {areas,limit:Math.floor(budget/Math.min(...areas.map(a=>a.cost))),results:[fair,proportional,gap].map((fn,i)=>{
    const units=fn(areas,budget),extras=areas.map((a,j)=>gain(a,units[j])),spent=areas.reduce((s,a,j)=>s+a.cost*units[j],0);
    if(spent>budget||units.some((x,j)=>!Number.isInteger(x)||x<0||x>capacity(areas[j])))return {name:names[i],status:'MODEL_INVALID',reason:'결과 제약 검사 실패',units:[],lowest:null,extra:null,spent:null};
    return {name:names[i],status:'CALCULATED',reason:i===0?'0.01%p 해상도에서 최저 비율 → 추가 인원 → 비용 순으로 계산·제약 검사했습니다.':'같은 지역별 단가와 공개 생산성·상한 가정으로 계산했습니다.',units,lowest:Math.min(...areas.map((a,j)=>(a.base+extras[j])/a.demand)),lowestUnits:Math.min(...areas.map((a,j)=>Math.floor(scale*(a.base+extras[j])/a.demand))),extra:extras.reduce((s,x)=>s+x,0),spent};
  })};
}
