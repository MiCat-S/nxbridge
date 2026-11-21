import type { Store } from '../storage/store.js';
import type { RegisterInput, Peer } from '../types.js';
import { nativeOwnership, type NativeOwnership } from '../process/owned-native.js';
import {sameDirectory} from '../shared/files.js';
import { managedRecoveryKey } from '../broker/recovery/managed-recovery.js';
import {BridgeError,describeError} from '../shared/errors.js';
import { managedRuntimes, runtimeFor, managedRuntimeState, type ManagedRuntime } from './managed-runtimes.js';
import { ownedProcesses } from '../process/owned-processes.js';
import { processAncestors,probeProcesses } from '../process/process.js';
import { hostingRecord } from '../broker/recovery/session-hosting.js';
import { daemonPermission } from './codex/codex-daemon.js';
import { codexParent, codexSubagent } from './codex/codex-lineage.js';
import {addManagedConflict,clearManagedConflict,clearManagedRuntimeConflict,type ManagedConflict} from '../broker/recovery/managed-conflicts.js';

type ThreadIdentity={id:string;parentThreadId?:string|null;source?:any;threadSource?:string;status?:{type:string}};
export type ManagedThreadLookup=(runtime:ManagedRuntime,sessionId:string)=>Promise<ThreadIdentity|undefined>;
function sameRuntime(a:ManagedRuntime,b:ManagedRuntime|undefined):boolean{
  return !!b&&a.id===b.id&&a.kind===b.kind&&a.peerId===b.peerId&&a.endpoint===b.endpoint&&a.pid===b.pid&&a.procStart===b.procStart&&a.configHome===b.configHome&&a.sessionId===b.sessionId&&a.state===b.state;
}
                                         
async function nativeDescendant(peer:Peer,runtime:ManagedRuntime,thread:ThreadIdentity,read:ManagedThreadLookup):Promise<boolean>{
  const seen=new Set<string>([thread.id]);let current=thread;
  for(let depth=0;depth<32&&codexSubagent(current);depth++){
    const parent=codexParent(current);if(!parent||seen.has(parent))return false;if(parent===peer.sessionId)return true;
    seen.add(parent);const next=await read(runtime,parent);if(next?.id!==parent)return false;current=next;
  }
  return false;
}
export function managedDescendant(store:Store,peer:Peer,input:{kind?:string;parentId?:string}):boolean{
  let parent=input.parentId;const seen=new Set<string>();
  while(parent&&!seen.has(parent)){if(parent===peer.sessionId)return true;seen.add(parent);parent=store.peers().find(row=>row.host==='codex'&&row.sessionId===parent&&row.kind==='subagent'&&row.rootPeerId===peer.id)?.parentId??undefined;}
  return false;
}
export function clearManagedChildConflict(store:Store,peer:Peer,runtimeId:string,input:RegisterInput):void{
  if(managedDescendant(store,peer,input)||input.kind==='subagent'&&!input.parentId)clearManagedConflict(store,peer.id,runtimeId,input.sessionId);
}
                                              
export async function reconcileManagedCodexConflict(store:Store,home:string,peer:Peer,read:ManagedThreadLookup):Promise<void>{
  const key='managedRuntimeConflict:'+peer.id,conflict=store.setting<ManagedConflict>(key);if(!conflict||peer.host!=='codex')return;
  for(const runtimeId of conflict.overflowRuntimeIds??[]){
    const current=store.setting<ManagedConflict>(key);if(!current)break;
    const owned=runtimeFor(home,{peerId:peer.id,id:runtimeId})?.value;
    if(owned){if(await managedRuntimeState(home,owned)==='dead'&&sameRuntime(owned,runtimeFor(home,{peerId:peer.id,id:runtimeId})?.value))clearManagedRuntimeConflict(store,peer.id,runtimeId,current);}
    else{
      const endpoints=store.endpoints(peer.id).filter(endpoint=>endpoint.runtimeId===runtimeId),identities=endpoints.map(endpoint=>endpoint.native??endpoint);
      if(identities.length&&identities.every(identity=>identity.pid&&identity.procStart)&&(await probeProcesses(identities.map(identity=>({pid:identity.pid!,procStart:identity.procStart!})))).every(state=>state==='dead')&&!runtimeFor(home,{peerId:peer.id,id:runtimeId}))clearManagedRuntimeConflict(store,peer.id,runtimeId,current);
    }
  }
  if(JSON.stringify(store.setting(key))!==JSON.stringify(conflict))return;
  const runtime=runtimeFor(home,{peerId:peer.id,id:conflict.runtimeId})?.value;if(!runtime)return;
  const pairId=store.pairFor(peer.id)?.id;let thread:ThreadIdentity|undefined,clear:boolean;
  try{thread=await read(runtime,conflict.sessionId);if(thread?.id!==conflict.sessionId)return;clear=thread.status?.type==='notLoaded'||codexSubagent(thread)&&!codexParent(thread)||await nativeDescendant(peer,runtime,thread,read);}
  catch{return;}                                
  if(!clear||JSON.stringify(store.setting(key))!==JSON.stringify(conflict)||store.peer(peer.id).sessionId!==peer.sessionId||store.pairFor(peer.id)?.id!==pairId||!sameRuntime(runtime,runtimeFor(home,{peerId:peer.id,id:runtime.id})?.value))return;
  clearManagedConflict(store,peer.id,runtime.id,thread.id,conflict);store.event('hosting.conflict.cleared',{peerId:peer.id,runtimeId:runtime.id,sessionId:thread.id,reason:thread.status?.type==='notLoaded'?'unloaded':'native_descendant'});
}

                                                        
export async function managedCodexRegistration(store:Store,home:string,input:RegisterInput,read?:ManagedThreadLookup):Promise<Peer|undefined>{
  if(input.host!=='codex'||!input.endpoint.pid||!input.endpoint.procStart)return;
  const native={pid:input.endpoint.pid,startedAt:input.endpoint.procStart},observedState=input.endpoint.mode==='app-server'?input.state:undefined,records=managedRuntimes(home),owned=ownedProcesses(home).records;
  const identity=(pid:number|undefined,start:string|undefined)=>pid===native.pid&&start===native.startedAt;
  let matches=records.filter(({value:r})=>identity(r.pid,r.procStart)||identity(r.wrapperPid,r.wrapperProcStart)||owned.some(p=>identity(p.identity.pid,p.identity.startedAt)&&(p.proof.launchId===r.id||p.proof.launchId===r.endpoint)));
  if(!matches.length&&records.some(r=>r.value.state==='starting')){
    const chain=await processAncestors(native.pid,12);if(chain[0]?.startedAt!==native.startedAt)throw new BridgeError('managed_proof_unverified','原生登记进程代次已改变。');
    matches=records.filter(({value:r})=>chain.some(p=>p.pid===r.pid&&p.startedAt===r.procStart||p.pid===r.wrapperPid&&p.startedAt===r.wrapperProcStart||owned.some(o=>o.identity.pid===p.pid&&o.identity.startedAt===p.startedAt&&(o.proof.launchId===r.id||o.proof.launchId===r.endpoint))));
  }
  if(matches.length>1)throw new BridgeError('managed_proof_unverified','原生登记同时匹配多个启动记录。');
  const runtime=matches[0]?.value;if(!runtime)return;
  const canonical={pid:runtime.pid??native.pid,procStart:runtime.procStart??native.startedAt};
  input.endpoint={...input.endpoint,mode:'app-server',address:runtime.endpoint,epoch:runtime.endpoint,configHome:runtime.configHome??input.endpoint.configHome,processKind:'app-server',runtimeId:runtime.id,...canonical,native:canonical};
  if(!runtime.peerId)return;
  const peer=store.peer(runtime.peerId),record=hostingRecord(store,peer);
  if(peer.sessionId&&peer.sessionId!==input.sessionId){
    const pairId=store.pairFor(peer.id)?.id;let thread:ThreadIdentity|undefined,child=false,unlinked=false,unverified=false;
    try{thread=read?await read(runtime,input.sessionId):undefined;unverified=!!read&&thread?.id!==input.sessionId;unlinked=!!thread&&codexSubagent(thread)&&!codexParent(thread);child=unlinked||!!thread&&!!read&&await nativeDescendant(peer,runtime,thread,read);}catch{unverified=true;}
    if(store.peer(peer.id).sessionId!==peer.sessionId||store.pairFor(peer.id)?.id!==pairId||!sameRuntime(runtime,runtimeFor(home,{id:runtime.id})?.value))throw new BridgeError('managed_proof_unverified','线程核验期间原会话或运行时代次已改变。');
    if(unverified){addManagedConflict(store,peer.id,runtime.id,input.sessionId);throw new BridgeError('managed_proof_unverified','自有运行时尚未核验登记线程的原生身份，消息暂存等待只读复核。');}
    if(child){
      input.kind='subagent';input.parentId=codexParent(thread!);const registered=store.register(input);store.updatePeer(registered.id,{parentId:input.parentId??null,rootPeerId:unlinked?undefined:peer.id});
      clearManagedConflict(store,peer.id,runtime.id,input.sessionId);
      return store.peer(registered.id);
    }
  }
  if(peer.sessionId&&peer.sessionId!==input.sessionId||runtime.sessionId&&runtime.sessionId!==input.sessionId){addManagedConflict(store,peer.id,runtime.id,input.sessionId);throw new BridgeError('session_conflict','专用运行时加载了其他会话，未将其登记成用户窗口。');}
  if(record?.released)return peer;
  const binding=store.bindings.current(peer.id);if(binding)store.bindings.save({...binding,active:false});
  store.deactivate(peer.id);
  const state=observedState??(['busy','needsHuman','paused','ready'].includes(peer.state)?peer.state:'unknown');
  const result=store.adopt(peer.id,{...input,state,permission:input.endpoint.codexPermission?daemonPermission(input.endpoint.codexPermission):input.permission});store.updatePeer(peer.id,{owner:'nxbridge'});return result;
}

                                             
export async function managedRegistration(store:Store,home:string,input:RegisterInput,read=(id:string)=>nativeOwnership(home,id),corroborate?:(proof:NativeOwnership,input:RegisterInput)=>Promise<NativeOwnership|undefined>):Promise<Peer|undefined>{
  if(input.host!=='claude'||!['root','fork'].includes(input.kind??'root')||!input.endpoint.configHome||!input.endpoint.pid||!input.endpoint.procStart)return;
  const candidates=store.peers().filter(peer=>peer.host===input.host&&peer.sessionId===input.sessionId&&store.pairFor(peer.id));
  const matches:{peer:Peer;proof:NativeOwnership;pairId:string}[]=[];
  let pending=false;
  for(const peer of candidates){
    const pairId=store.pairFor(peer.id)!.id;
    const takeover=store.setting<{adopted?:unknown}>('takeover:'+peer.id);
    if(takeover&&!takeover.adopted)continue;
    let proof:NativeOwnership|undefined;
    try{proof=read(peer.id);}catch(error){pending=true;store.event('context.managed.proof_unverified',{peerId:peer.id,error:describeError(error)});continue;}
    if(!proof||proof.releasedToUser||proof.phase==='failed'||proof.sessionId!==input.sessionId||!sameDirectory(proof.configHome,input.endpoint.configHome!))continue;
    if(proof.native?.pid!==input.endpoint.pid||proof.native.startedAt!==input.endpoint.procStart){pending||=proof.phase==='intent';if(!proof.handle||!corroborate)continue;try{proof=await corroborate(proof,input);}catch(error){pending=true;store.event('context.managed.proof_unverified',{peerId:peer.id,error:describeError(error)});continue;}}
    if(proof?.native?.pid===input.endpoint.pid&&proof.native.startedAt===input.endpoint.procStart)matches.push({peer,proof,pairId});
  }
  if(matches.length!==1){if(!matches.length&&pending)throw new BridgeError('managed_proof_unverified','后台归属尚未核验，当前窗口可登记并由用户选择，未接管原成员。');return;}
  const {peer:previous,proof,pairId}=matches[0]!;
  return store.transaction(()=>{
    const fresh=read(previous.id);if(!fresh||fresh.id!==proof.id||fresh.releasedToUser||fresh.phase==='failed')return;
    if(fresh.native&&(fresh.native.pid!==input.endpoint.pid||fresh.native.startedAt!==input.endpoint.procStart))throw new BridgeError('managed_proof_unverified','核验期间后台代次改变，未接管原成员。');
    if(store.getPeer(previous.id)?.sessionId!==input.sessionId||store.pairFor(previous.id)?.id!==pairId)return;
    const lease=store.setting<{adopted?:unknown}>('takeover:'+previous.id);
    if(lease&&!lease.adopted)return;
    const binding=store.bindings.current(previous.id),sameWindow=binding?.pid===input.endpoint.pid&&binding.procStart===input.endpoint.procStart&&sameDirectory(binding.configHome,input.endpoint.configHome!);
    const changed=!sameWindow||previous.owner!=='nxbridge'||!!lease||!!store.setting('managedSessionConflict:'+previous.id);
    if(!sameWindow){store.deactivate(previous.id);if(binding)store.bindings.save({...binding,active:false});}
    const peer=store.adopt(previous.id,input);store.updatePeer(peer.id,{owner:'nxbridge'});
    if(lease)store.setSetting('takeover:'+peer.id,null);
    store.setSetting('managedAdopted:'+peer.id,null);store.setSetting('managedSessionConflict:'+peer.id,null);
    const incident=store.setting<{state:string}>(managedRecoveryKey(peer.id));
    if(incident&&!['ready','closed'].includes(incident.state))store.setSetting(managedRecoveryKey(peer.id),{...incident,state:'ready'});
    if(changed)store.event('context.managed.rejoined',{peerId:peer.id,sessionId:input.sessionId,provenance:'owned_launch',native:{pid:input.endpoint.pid,procStart:input.endpoint.procStart}});
    return store.peer(peer.id);
  });
}
