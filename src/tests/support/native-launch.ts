import { randomUUID } from 'node:crypto';
import type { Store } from '../../storage/store.js';
import type { Peer } from '../../types.js';
import { ownedProcesses, rememberOwnedDescendants, releaseRecordedProcesses, type OwnedProcessRecord } from '../../process/owned-processes.js';
import { saveNativeOwnership } from '../../process/owned-native.js';

                                         
export async function releaseNativeTestLaunches(home:string,include:(record:OwnedProcessRecord)=>boolean=record=>record.role==='codex-runtime'):Promise<string[]>{
  const roots=ownedProcesses(home).records.filter(include),launches=new Set(roots.flatMap(record=>record.proof.launchId?[record.proof.launchId]:[]));
  for(const record of roots)if(record.proof.launchId)await rememberOwnedDescendants(home,record.identity,record.proof.launchId);
  return releaseRecordedProcesses(home,record=>include(record)||!!record.proof.launchId&&launches.has(record.proof.launchId));
}

                                         
export function recordFixtureLaunch(store:Store,home:string,peer:Peer):void{
  const configHome=store.endpoints(peer.id).find(endpoint=>endpoint.configHome)?.configHome??home;
  if(peer.host==='claude')saveNativeOwnership({version:1,id:randomUUID(),home,peerId:peer.id,configHome,phase:'bound',sessionId:peer.sessionId!,createdAt:Date.now()});
  else store.setSetting('managedLaunchProof:'+peer.id,{sessionId:peer.sessionId,runtimeId:randomUUID(),configHome});
}
