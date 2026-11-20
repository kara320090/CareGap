// Browser-local K-means++ / Lloyd. Same features, seeds, 20 starts and candidate
// selection as the Python prototype; no source rows leave the browser.
const seeds = [17, 42, 73];
const sum = a => a.reduce((x,y)=>x+y,0);
const mean = a => sum(a)/a.length;
const median = a => { const b=[...a].sort((x,y)=>x-y),m=b.length>>1; return b.length%2?b[m]:(b[m-1]+b[m])/2; };
const sq = (a,b) => (a[0]-b[0])**2+(a[1]-b[1])**2;
function randomState(seed) {
  const mt=new Uint32Array(624);mt[0]=seed;let index=624;
  for(let i=1;i<624;i++)mt[i]=(Math.imul(1812433253,mt[i-1]^(mt[i-1]>>>30))+i)>>>0;
  const next=()=>{
    if(index===624){for(let i=0;i<624;i++){const y=(mt[i]&0x80000000)|(mt[(i+1)%624]&0x7fffffff);mt[i]=mt[(i+397)%624]^(y>>>1)^((y&1)?0x9908b0df:0);}index=0;}
    let y=mt[index++];y^=y>>>11;y^=(y<<7)&0x9d2c5680;y^=(y<<15)&0xefc60000;y^=y>>>18;return y>>>0;
  };
  return ()=>((next()>>>5)*67108864+(next()>>>6))/9007199254740992;
}
function initialCenters(x,k,random) {
  const centers=[[...x[Math.min(x.length-1,Math.floor(random()*x.length))]]];
  let closest=x.map(p=>sq(p,centers[0]));
  for(let c=1;c<k;c++){
    const potential=sum(closest),trials=2+Math.floor(Math.log(k));let best=null,bestCost=Infinity,bestDistances;
    for(let t=0;t<trials;t++){
      const target=random()*potential;let cumulative=0,id=0;
      while(id<x.length-1&&(cumulative+=closest[id])<target)id++;
      const distances=x.map((p,i)=>Math.min(closest[i],sq(p,x[id]))),cost=sum(distances);
      if(cost<bestCost){best=x[id];bestCost=cost;bestDistances=distances;}
    }
    centers.push([...best]);closest=bestDistances;
  }
  return centers;
}
function fit(x,k,random) {
  let centers=initialCenters(x,k,random),labels=Array(x.length).fill(-1);
  const tolerance=mean([0,1].map(j=>mean(x.map(p=>p[j]**2))))*1e-4;
  for(let iteration=0;iteration<300;iteration++){
    const prior=labels;
    labels=x.map(p=>{let id=0;for(let j=1;j<k;j++)if(sq(p,centers[j])<sq(p,centers[id]))id=j;return id;});
    const counts=Array(k).fill(0),next=Array.from({length:k},()=>[0,0]);
    x.forEach((p,i)=>{counts[labels[i]]++;next[labels[i]][0]+=p[0];next[labels[i]][1]+=p[1];});
    // Relocate an empty center to a farthest point from a cluster with >1 points.
    for(let j=0;j<k;j++)if(!counts[j]){
      let far=-1;
      x.forEach((p,i)=>{if(counts[labels[i]]>1&&(far<0||sq(p,centers[labels[i]])>sq(x[far],centers[labels[far]])))far=i;});
      if(far>=0){const old=labels[far];counts[old]--;next[old][0]-=x[far][0];next[old][1]-=x[far][1];labels[far]=j;counts[j]=1;next[j]=[...x[far]];}
    }
    next.forEach((p,j)=>{if(counts[j]){p[0]/=counts[j];p[1]/=counts[j];}else next[j]=[...centers[j]];});
    const shift=sum(centers.map((p,j)=>sq(p,next[j])));centers=next;
    if(labels.every((l,i)=>l===prior[i])||shift<=tolerance)break;
  }
  labels=x.map(p=>{let id=0;for(let j=1;j<k;j++)if(sq(p,centers[j])<sq(p,centers[id]))id=j;return id;});
  return {labels,inertia:sum(x.map((p,i)=>sq(p,centers[labels[i]])))};
}
function kmeans(x,k,seed) {
  const random=randomState(seed);let best;
  for(let start=0;start<20;start++){const candidate=fit(x,k,random);if(!best||candidate.inertia<best.inertia)best=candidate;}
  return best.labels;
}
function silhouette(x,labels) {
  const groups=[...new Set(labels)],sizes=groups.map(j=>labels.filter(l=>l===j).length);
  return mean(x.map((p,i)=>{
    const own=groups.indexOf(labels[i]);if(sizes[own]===1)return 0;
    const distances=groups.map(()=>0);
    x.forEach((other,j)=>{distances[groups.indexOf(labels[j])]+=Math.sqrt(sq(p,other));});
    const a=distances[own]/(sizes[own]-1),b=Math.min(...distances.filter((_,j)=>j!==own).map((v,j)=>v/sizes.filter((_,j)=>j!==own)[j]));
    return Math.max(a,b)?(b-a)/Math.max(a,b):0;
  }));
}
export function adjustedRand(a,b) {
  if(a.length!==b.length)throw Error('분류 길이 불일치');
  const choose=n=>n*(n-1)/2,table=new Map(),left=new Map(),right=new Map();
  a.forEach((v,i)=>{const key=JSON.stringify([v,b[i]]);table.set(key,(table.get(key)||0)+1);left.set(v,(left.get(v)||0)+1);right.set(b[i],(right.get(b[i])||0)+1);});
  const both=sum([...table.values()].map(choose)),l=sum([...left.values()].map(choose)),r=sum([...right.values()].map(choose)),total=choose(a.length);
  if(!total)return 1;const expected=l*r/total,denom=(l+r)/2-expected;return denom?(both-expected)/denom:1;
}
export function clusterExclusion(row,includeAbove=false) {
  if(row.users===null)return '이용자 수 미상';if(row.demand<=0)return '수요 0';
  if(!includeAbove&&row.users>row.demand)return '원자료 비율 100% 초과';return null;
}
export function analyzeClusters(records,includeAbove=false) {
  const valid=records.filter(r=>!clusterExclusion(r,includeAbove));
  const excluded=records.flatMap(row => {
    const reason = clusterExclusion(row,includeAbove);
    return reason ? [{id:row.id,reason}] : [];
  });
  const incomplete = (status,message) => ({status,message,validCount:valid.length,excluded,rows:[]});
  if(valid.length<4)return incomplete('INSUFFICIENT_DATA','지역 유형 분석에는 유효 지역 4개 이상이 필요합니다.');
  const features=valid.map(r=>[Math.log1p(r.demand),r.users/r.demand]);
  const means=[0,1].map(j=>mean(features.map(p=>p[j]))),std=[0,1].map(j=>Math.sqrt(mean(features.map(p=>(p[j]-means[j])**2)))||1);
  const x=features.map(p=>p.map((v,j)=>(v-means[j])/std[j]));
  const maxK=Math.min(5,valid.length-1,new Set(x.map(p=>JSON.stringify(p))).size);
  if(maxK<2)return incomplete('INSUFFICIENT_VARIATION','서로 다른 특성이 부족해 군집을 만들지 않습니다.');
  const candidates=[],fitted=new Map();
  for(let k=2;k<=maxK;k++){
    const labels=seeds.map(seed=>kmeans(x,k,seed));if(labels.some(a=>new Set(a).size!==k))continue;
    const scores=labels.map(a=>silhouette(x,a));fitted.set(k,labels);
    candidates.push({k,mean_silhouette:mean(scores),scores_by_seed:Object.fromEntries(seeds.map((seed,i)=>[seed,scores[i]]))});
  }
  if(!candidates.length)return incomplete('NO_VALID_CANDIDATE','유효한 군집 후보가 없습니다.');
  const chosen=[...candidates].sort((a,b)=>b.mean_silhouette-a.mean_silhouette||a.k-b.k)[0],labels=fitted.get(chosen.k),first=labels[0];
  const groups=[...new Set(first)].map(label=>({label,indices:first.map((l,i)=>l===label?i:-1).filter(i=>i>=0)}));
  groups.sort((a,b)=>median(a.indices.map(i=>features[i][1]))-median(b.indices.map(i=>features[i][1]))||median(a.indices.map(i=>features[i][0]))-median(b.indices.map(i=>features[i][0]))||valid[a.indices[0]].id.localeCompare(valid[b.indices[0]].id));
  const names=new Map(groups.map((g,i)=>[g.label,`유형 ${i+1}`]));
  return {status:'OK',chosen_k:chosen.k,candidates,seeds,n_init:20,include_above:includeAbove,
    seed_ari:mean([adjustedRand(labels[0],labels[1]),adjustedRand(labels[0],labels[2]),adjustedRand(labels[1],labels[2])]),
    rows:valid.map((r,i)=>({id:r.id,cluster:names.get(first[i]),demand:r.demand,raw_ratio:r.users/r.demand,source_quadrant:r.sourceQuadrant??'원본 분류 미제공'})),
    profiles:groups.map(g=>({cluster:names.get(g.label),regions:g.indices.length,median_demand:median(g.indices.map(i=>valid[i].demand)),median_raw_ratio:median(g.indices.map(i=>features[i][1]))})),
    validCount:valid.length, excluded,
  };
}
