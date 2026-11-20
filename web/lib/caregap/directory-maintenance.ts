import type {Bindings} from './types';
import {syncActivityProviders} from './activity-providers';
import {syncOfficialMap} from './official-map';
import {enrichFacilityCoordinates} from './facility-geocoding';

// Share the primary facility lease with its normal collector. A separate
// directory run cannot enrich a generation while the primary is replacing it.
export async function syncDirectoryMaintenance(env:Bindings){
  const db=env.DB!,owner=crypto.randomUUID(),now=new Date().toISOString();
  const base=await db.prepare("SELECT active_run_id FROM source_state WHERE source='facilities'").first<{active_run_id:string}>();
  if(!base?.active_run_id)return {source:'directory',status:'already_current',done:true};
  await db.prepare("UPDATE source_state SET lease_owner=?,lease_until=? WHERE source='facilities' AND (lease_until IS NULL OR lease_until<?)").bind(owner,new Date(Date.now()+300000).toISOString(),now).run();
  const held=await db.prepare("SELECT lease_owner,active_run_id FROM source_state WHERE source='facilities'").first<any>();
  if(held?.lease_owner!==owner)return {source:'directory',phase:'facility_maintenance',status:'busy',done:false};
  try{
    const activity=await syncActivityProviders(env);
    if(!activity.done&&!(activity.status==='failed'&&activity.deferred))return activity;
    if(activity.status==='ready')return {source:'directory',phase:'official_map',status:'running',done:false};
    let official=await syncOfficialMap(env,held.active_run_id,true);
    // With 200-statement batches, three live pages fit the request budget
    // when the first has at most 300 matching records; otherwise use two.
    const smallFirst='livePage' in official&&official.livePage&&'pageMatched' in official&&typeof official.pageMatched==='number'&&official.pageMatched<=300;
    if(!official.done&&official.status==='running'&&'pageMatched' in official){official=await syncOfficialMap(env,held.active_run_id,true);if(smallFirst&&!official.done&&official.status==='running'&&'pageMatched' in official)official=await syncOfficialMap(env,held.active_run_id,true);}
    const next=official.status==='ready'?{...official,phase:'facility_geocoding',status:'running',done:false}:official.done?await enrichFacilityCoordinates(env):official;
    const result={...next,source:'directory'};
    return activity.status==='failed'?{...result,...result.done?{status:'failed',done:false}:{},supplementalError:activity.error}:result;
  }finally{await db.prepare("UPDATE source_state SET lease_owner=NULL,lease_until=NULL WHERE source='facilities' AND lease_owner=?").bind(owner).run();}
}
