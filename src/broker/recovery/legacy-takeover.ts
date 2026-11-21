import type { Store } from '../../storage/store.js';
import type { Peer } from '../../types.js';
import {ownedSocketFile} from '../../ipc/home.js';
import {sameDirectory} from '../../shared/files.js';
import { probeProcesses, liveProcess } from '../../process/process.js';
import { ownedProcesses } from '../../process/owned-processes.js';
import { runtimeFor } from '../../hosts/managed-runtimes.js';
import { nativeOwnershipRecords } from '../../process/owned-native.js';

const migrationKey='legacyTakeoverMigration:v2';
interface LegacyCandidate {sessionId:string;eligible:boolean;nextAt:number;returned?:boolean}
                                           
export function captureLegacyTakeovers(store:Store,home:string):Record<string,LegacyCandidate>{
  const existing=store.setting<Record<string,LegacyCandidate>>(migrationKey);if(existing)return existing;
  const records=ownedProcesses(home).records,values:Record<string,LegacyCandidate>={};
  for(const peer of store.peers().filter(peer=>peer.owner==='user'&&peer.sessionId&&store.pairFor(peer.id))){
    const endpoints=store.endpoints(peer.id),claimed=records.some(record=>record.peerId===peer.id&&record.releasedToUser);
    const fingerprint=peer.host==='codex'&&endpoints.length>0&&endpoints.every(ep=>ep.mode==='app-server'&&!ep.daemon&&ep.runtimeId&&ep.pid&&ep.procStart&&ownedSocketFile(home,ep.address)&&/^cx-/.test(ep.address.split(/[\\/]/).at(-1)!)&&(!runtimeFor(home,{id:ep.runtimeId})||runtimeFor(home,{id:ep.runtimeId})?.value.peerId===peer.id));
    const dedicated=fingerprint&&endpoints.every(ep=>runtimeFor(home,{id:ep.runtimeId!})?.value.peerId===peer.id);
    if(claimed||fingerprint||nativeOwnershipRecords(home).some(record=>record.peerId===peer.id&&record.releasedToUser))values[peer.id]={sessionId:peer.sessionId!,eligible:!!dedicated&&!store.bindings.all().some(binding=>binding.peerId===peer.id),nextAt:0};
  }
  store.setSetting(migrationKey,values);return values;
}

                                                  
export async function returnLegacyTakeover(store:Store,home:string,peer:Peer,probe=probeProcesses):Promise<boolean>{
  const migration=captureLegacyTakeovers(store,home),candidate=migration[peer.id];
  if(!candidate||candidate.returned||candidate.sessionId!==peer.sessionId||candidate.nextAt>Date.now())return false;
  candidate.nextAt=Date.now()+30000;store.setSetting(migrationKey,migration);
  if(peer.owner!=='user'||!peer.sessionId||!store.pairFor(peer.id))return false;
  const endpoints=store.endpoints(peer.id);
  if(!endpoints.length)return false;
  if(endpoints.some(ep=>ep.active&&ep.pid&&liveProcess(ep.pid))){store.setSetting('legacyTakeoverNeedsUser:'+peer.id,null);return false;}
  const pairId=store.pairFor(peer.id)!.id,other=store.peers().filter(value=>value.id!==peer.id&&value.host===peer.host&&value.sessionId===peer.sessionId).flatMap(value=>store.endpoints(value.id).filter(ep=>ep.active&&ep.configHome&&endpoints.some(old=>old.configHome&&sameDirectory(old.configHome,ep.configHome!))));
  const states=await probe([...endpoints,...other].map(ep=>({pid:ep.pid??0,procStart:ep.procStart??''})));if(states.some(state=>state!=='dead')){store.setSetting('legacyTakeoverNeedsUser:'+peer.id,null);return false;}
  if(!candidate.eligible){store.setSetting('legacyTakeoverNeedsUser:'+peer.id,{sessionId:peer.sessionId,user_step:`${peer.host} ${peer.host==='claude'?'--resume':'resume'} ${peer.sessionId}`});return false;}
  if(peer.host!=='codex'||store.bindings.all().some(binding=>binding.peerId===peer.id))return false;
  return store.transaction(()=>{
    if(store.peer(peer.id).owner!=='user'||store.peer(peer.id).sessionId!==peer.sessionId||store.pairFor(peer.id)?.id!==pairId||store.bindings.all().some(binding=>binding.peerId===peer.id))return false;
    if(JSON.stringify(store.endpoints(peer.id))!==JSON.stringify(endpoints))return false;
    store.updatePeer(peer.id,{owner:'nxbridge',state:'offline'});store.deactivate(peer.id);candidate.returned=true;store.setSetting(migrationKey,migration);store.setSetting('legacyTakeoverReturned:'+peer.id,{at:Date.now(),sessionId:peer.sessionId});store.event('takeover.legacy.returned',{peerId:peer.id,sessionId:peer.sessionId});return true;
  });
}
