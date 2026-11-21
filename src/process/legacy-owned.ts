import path from 'node:path';
import { existsSync, readdirSync } from 'node:fs';
import type { Store } from '../storage/store.js';
import {readJson} from '../shared/files.js';
import { claudeBackgroundHost, matchesProcess, processIdentity } from './process.js';
import { ownedProcesses, recordOwnedProcess, type OwnedProcessRole } from './owned-processes.js';
import type { ClaudeChildRecord } from '../hosts/claude/claude-child.js';
import {describeError} from '../shared/errors.js';
import { managedMarker } from '../install/installation.js';

interface LegacyProof {role:OwnedProcessRole;pid:number;generation:string;peerId?:string;sessionId?:string;configHome?:string;source:'runtime'|'ledger'}
export async function migrateLegacyOwnership(home:string,store:Store):Promise<string[]>{
  if(store.setting('ownedProcessMigrationComplete'))return[];
  let snapshot=store.setting<LegacyProof[]>('ownedProcessMigrationSnapshot');
  if(!snapshot){
    snapshot=[];
    const runtime=path.join(home,'run','codex-runtime.json');
    if(existsSync(runtime)){const saved=readJson<{pid:number;procStart?:string;configHome?:string}>(runtime);if(saved.pid&&saved.procStart)snapshot.push({role:'codex-runtime',pid:saved.pid,generation:saved.procStart,configHome:saved.configHome,source:'runtime'});}
    for(const peer of store.peers().filter(value=>value.owner==='nxbridge'&&value.host==='claude')){
      const endpoint=store.endpoints(peer.id).sort((a,b)=>b.seenAt-a.seenAt)[0];
      if(endpoint?.pid&&endpoint.procStart)snapshot.push({role:'claude-native',pid:endpoint.pid,generation:endpoint.procStart,peerId:peer.id,sessionId:peer.sessionId??undefined,configHome:endpoint.configHome,source:'ledger'});
    }
    const run=path.join(home,'run');
    if(existsSync(run))for(const name of readdirSync(run).filter(value=>/^runtime-.*\.json$/.test(value))){
      const value=readJson<{owner?:string;pid?:number;generation?:string}>(path.join(run,name));
      if(value.owner===managedMarker(home)&&value.pid&&value.generation)snapshot.push({role:'broker',pid:value.pid,generation:value.generation,source:'runtime'});
    }
    if(existsSync(run))for(const name of readdirSync(run).filter(value=>/^claude-child-[a-f0-9]+\.json$/.test(value))){
      const child=readJson<ClaudeChildRecord>(path.join(run,name));
      if(child.version!==1||['user','handoff'].includes(child.phase))continue;
      const peer=store.peers().find(value=>value.id===child.peerId);if(!peer||peer.owner!=='nxbridge')continue;
      for(const [role,identity] of [['claude-worker',child.worker],['claude-child',child.wrapper],['claude-child',child.native]] as const)if(identity)snapshot.push({role,pid:identity.pid,generation:identity.startedAt,peerId:peer.id,sessionId:child.sessionId,configHome:child.configHome,source:'runtime'});
    }
                                            
    store.setSetting('ownedProcessMigrationSnapshot',snapshot);
  }
  const notes:string[]=[],existing=ownedProcesses(home).records;
  for(const proof of snapshot){
    if(proof.peerId&&store.peers().find(value=>value.id===proof.peerId)?.owner!=='nxbridge')continue;
    if(proof.role!=='claude-native'&&existing.some(value=>value.identity.pid===proof.pid&&value.identity.startedAt===proof.generation))continue;
    try{
      const identity=await processIdentity(proof.pid);
      if(!matchesProcess({procStart:proof.generation},identity)&&identity.startedAt!==proof.generation)continue;
      if(proof.role==='codex-runtime'&&!/^codex(?:\.exe)?$/i.test(identity.name))throw Error('旧 App Server 进程身份不符');
      if(proof.role==='claude-native'&&!/^claude(?:\.exe)?$/i.test(identity.name))throw Error('旧 Claude 进程身份不符');
      if(!existing.some(value=>value.identity.pid===identity.pid&&value.identity.startedAt===identity.startedAt&&(proof.role!=='claude-native'||value.role==='claude-native'&&value.peerId===proof.peerId)))existing.push(await recordOwnedProcess(home,{role:proof.role,identity,peerId:proof.peerId,sessionId:proof.sessionId,configHome:proof.configHome,proof:{kind:proof.source==='runtime'?'legacy-runtime':'legacy-ledger'}}));
      if(proof.role==='claude-native'&&proof.source==='ledger'&&proof.sessionId){
                                               
        const parent=await claudeBackgroundHost(identity,proof.sessionId);
        if(parent&&store.peers().find(value=>value.id===proof.peerId)?.owner==='nxbridge'&&!existing.some(value=>value.role==='claude-native'&&value.peerId===proof.peerId&&value.identity.pid===parent.pid&&value.identity.startedAt===parent.startedAt))existing.push(await recordOwnedProcess(home,{role:'claude-native',identity:parent,peerId:proof.peerId,sessionId:proof.sessionId,configHome:proof.configHome,proof:{kind:'legacy-ledger'}}));
      }
    }catch(error){if((error as {code?:string}).code!=='process_missing')notes.push(`旧进程 ${proof.pid} 归属迁移未完成：${describeError(error)}`);}
  }
  if(!notes.length)store.setSetting('ownedProcessMigrationComplete',true);
  return notes;
}
