import { existsSync, globSync } from 'node:fs';
import path from 'node:path';
import type { Store } from '../../storage/store.js';
import type { BridgeConfig, Peer } from '../../types.js';
import {codexHome,claudeHome} from '../../shared/local-paths.js';
import { pairLoss, type PairLoss } from './pair-loss.js';
import { sessionHistoryPath } from '../recovery/session-history.js';
import {sameDirectory} from '../../shared/files.js';
import { partnerConfigHome } from './partner-home.js';
import { claudeAutoKey, claudeAutoPhaseHolds, type ClaudeAutoFallback } from '../../hosts/claude/claude-auto-mode.js';
import { hostingKey, type HostingRecord } from '../recovery/session-hosting.js';
export { partnerConfigHome } from './partner-home.js';

export type RestoreState='resumable'|'gone'|'unverified';
const histories=new WeakMap<Store,Map<string,RestoreState>>();
export function refreshRestoreObservations(store:Store,unavailableOnly=false):void{
  if(!unavailableOnly){histories.delete(store);return;}
  const cached=histories.get(store);if(cached)for(const [key,state] of cached)if(state!=='resumable')cached.delete(key);
}
                                         
export function restorableOwnedPartner(store:Store,peer:Peer,home=partnerConfigHome(store,peer),fresh=false):boolean{
  if(peer.owner!=='nxbridge'||peer.enabled===false||!['root','fork'].includes(peer.kind)||!peer.sessionId||store.pairFor(peer.id)||store.bindings.current(peer.id)?.transitioning)return false;
  const hosting=store.setting<HostingRecord>(hostingKey(peer.id)),auto=store.setting<ClaudeAutoFallback>(claudeAutoKey(peer.id));
                                    
  if(hosting?.memberId===peer.id&&hosting.sessionId===peer.sessionId&&hosting.released||auto&&(auto.old_session_id===peer.sessionId||auto.session_id===peer.sessionId)&&claudeAutoPhaseHolds(auto.phase)||store.setting('managedSessionConflict:'+peer.id)||store.setting('takeover:'+peer.id))return false;
  if(store.peersForSession(peer.host,peer.sessionId).some(other=>other.id!==peer.id&&store.pairFor(other.id)&&(!home||!partnerConfigHome(store,other)||sameDirectory(home,partnerConfigHome(store,other)!))))return false;
  const endpoint=store.endpoints(peer.id).filter(value=>value.configHome&&home&&sameDirectory(value.configHome,home)).sort((a,b)=>b.seenAt-a.seenAt)[0];
  if(endpoint&&sessionHistoryPath(store,peer,endpoint))return true;
  let cached=histories.get(store);if(!cached){cached=new Map();histories.set(store,cached);}
  const key=JSON.stringify([peer.id,peer.sessionId,home&&path.resolve(home)]);
  if(fresh||!cached.has(key)){cached.set(key,restoreState(peer,home));if(cached.size>256)cached.delete(cached.keys().next().value!);}
  return cached.get(key)==='resumable';
}
const observations=new Map<string,RestoreState>();
export function restoreState(peer:Peer,configHome?:string):RestoreState{
  if(!peer.sessionId)return'gone';
  if(peer.owner==='user')return'unverified';
  if(!configHome||!existsSync(configHome))return'unverified';
                                    
  if(!/^[a-zA-Z0-9_-]+$/.test(peer.sessionId))return'unverified';
  try{
    const patterns=peer.host==='codex'?['sessions/**/rollout-*-'+peer.sessionId+'.jsonl','sessions/'+peer.sessionId+'.jsonl','archived_sessions/**/rollout-*-'+peer.sessionId+'.jsonl']:['projects/**/'+peer.sessionId+'.jsonl'];
    return patterns.some(pattern=>globSync(pattern,{cwd:configHome}).length)?'resumable':'gone';
  }catch{return'unverified';}
}
export function pairLossView(store:Store,peer:Peer,config?:BridgeConfig,fresh=false):(PairLoss&{restore_state:RestoreState})|undefined{
  const loss=pairLoss(store,peer);if(!loss)return;
  const partner=store.getPeer(loss.partner_id);if(!partner)return{...loss,restore_state:'gone'};
  if(loss.reason==='session_deleted'){
    const endpoint=store.endpoint(partner.id)??store.endpoints(partner.id).sort((a,b)=>b.seenAt-a.seenAt)[0];
    return{...loss,restore_state:partner.sessionId===loss.partner_session_id&&endpoint&&sessionHistoryPath(store,partner,endpoint,{fresh})?'resumable':'gone'};
  }
  const home=partnerConfigHome(store,partner,loss.partner_config_home)??(partner.host==='codex'?config?.codexHome??codexHome():config?.claudeHome??claudeHome());
  const key=JSON.stringify([loss.id,partner.sessionId,home]);let state=observations.get(key);
  if(fresh||!state){
    state=partner.owner==='user'||partner.sessionId===loss.partner_session_id?restoreState(partner,path.resolve(home)):'gone';
    observations.set(key,state);if(observations.size>256)observations.delete(observations.keys().next().value!);
  }
  return{...loss,restore_state:state};
}
