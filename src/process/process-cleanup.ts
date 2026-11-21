import path from 'node:path';
import { existsSync, readdirSync, rmdirSync, statSync, unlinkSync } from 'node:fs';
import { Store } from '../storage/store.js';
import { CodexAdapter } from '../hosts/codex/adapter.js';
import { ClaudeAdapter } from '../hosts/claude/adapter.js';
import { ownedProcessState } from './process-stop.js';
import { forgetOwnedProcess, ownedProcesses, ownedRecordState, processRegistryDirectory, processRegistryRoot, releaseOwnedProcess, transferOwnedPeerToUser, retireDeadOwnedProcess, migrateRetiredCompletions } from './owned-processes.js';
import { forgetNativeOwnership, nativeOwnershipRecords, saveNativeOwnership } from './owned-native.js';
import { migrateLegacyOwnership } from './legacy-owned.js';
import { managedRuntimes, managedRuntimeNativeState, removeManagedRuntime } from '../hosts/managed-runtimes.js';
import {describeError} from '../shared/errors.js';
import {type BridgeConfig,type Endpoint} from '../types.js';

                                                    
export async function retireUnconfirmedContainers(home:string,options:{peerId?:string;protectedPeers?:string[];protectedEndpoints?:Endpoint[];guard?:(peerIds:string[],endpoints:string[])=>void}={}):Promise<{notes:string[];peerIds:string[]}>{
  const initial=ownedProcesses(home).records,initialRuntimes=managedRuntimes(home),notes:string[]=[],affected=new Set<string>();
  const protectedPeer=new Set(options.protectedPeers??[]),groups=new Map<string,typeof initial>();
  const unchanged=(before:{id:string}[],after:{id:string}[])=>before.length===after.length&&before.every(record=>JSON.stringify(after.find(value=>value.id===record.id))===JSON.stringify(record));
  for(const record of initial.filter(record=>(record.windowsJob||record.posixGroup)&&(!options.peerId||record.peerId===options.peerId||initialRuntimes.some(runtime=>runtime.value.peerId===options.peerId&&runtime.value.id===record.proof.launchId)))){
    const key=record.proof.launchId??record.id,group=groups.get(key)??[];group.push(record);groups.set(key,group);
  }
  for(const [launchId,original] of groups){
    const snapshot=ownedProcesses(home).records,runtimes=managedRuntimes(home),bindings=nativeOwnershipRecords(home);
    const containers=snapshot.filter(record=>(record.windowsJob||record.posixGroup)&&(record.proof.launchId===launchId||original.some(value=>value.id===record.id)));
    const relatedRuntimes=runtimes.filter(record=>record.value.id===launchId||record.value.kind==='legacy'&&record.value.endpoint===launchId),relatedBindings=bindings.filter(binding=>binding.id===launchId);
    const peers=new Set([...containers.map(record=>record.peerId),...relatedRuntimes.map(record=>record.value.peerId),...relatedBindings.map(binding=>binding.peerId)].filter((id):id is string=>!!id));
    const related=snapshot.filter(record=>record.proof.launchId===launchId||containers.some(container=>container.id===record.id)||record.peerId&&peers.has(record.peerId));
    const peerBindings=bindings.filter(binding=>binding.id===launchId||peers.has(binding.peerId)),peerRuntimes=runtimes.filter(record=>relatedRuntimes.includes(record)||record.value.peerId&&peers.has(record.value.peerId));
    if(related.some(record=>record.releasedToUser)||peerBindings.some(binding=>binding.releasedToUser)||[...peers].some(id=>protectedPeer.has(id))||peerRuntimes.some(record=>(options.protectedEndpoints??[]).some(endpoint=>endpoint.active&&endpoint.address===record.value.endpoint)))continue;
    const containerStates=await Promise.all(containers.map(ownedRecordState));
    if(containerStates.includes('alive'))continue;
    const unconfirmed=containers.filter((_,index)=>containerStates[index]==='unknown');if(!unconfirmed.length)continue;
    const identities=related.flatMap(record=>[record.identity,...(record.native?[record.native]:[])]).concat(peerBindings.flatMap(binding=>binding.native?[binding.native]:[]),peerRuntimes.flatMap(record=>record.value.wrapperPid!==undefined?[{pid:record.value.wrapperPid,startedAt:record.value.wrapperProcStart??''}]:[]));
    if((await Promise.all(identities.map(ownedProcessState))).some(state=>state!=='dead'))continue;
                                                                
    const nativeRuntimes=peerRuntimes.filter(({value:runtime})=>runtime.pid!==undefined||snapshot.some(record=>record.native&&(record.proof.launchId===runtime.id||runtime.kind==='legacy'&&record.proof.launchId===runtime.endpoint))||peerBindings.some(binding=>binding.native&&binding.id===runtime.id));
    if((await Promise.all(nativeRuntimes.map(record=>managedRuntimeNativeState(home,record.value)))).some(state=>state!=='dead'))continue;
                                                
    const retired=new Set<string>();
    for(const record of related.filter(record=>record.proof.launchId===launchId&&!unconfirmed.some(container=>container.id===record.id)))if(await ownedRecordState(record)==='dead'){await retireDeadOwnedProcess(record);retired.add(record.id);}
                                                     
    const current=ownedProcesses(home).records.filter(record=>record.proof.launchId===launchId||containers.some(container=>container.id===record.id)||record.peerId&&peers.has(record.peerId));
    const currentBindings=nativeOwnershipRecords(home).filter(binding=>binding.id===launchId||peers.has(binding.peerId)),currentRuntimes=managedRuntimes(home).filter(record=>record.value.id===launchId||record.value.kind==='legacy'&&record.value.endpoint===launchId||record.value.peerId&&peers.has(record.value.peerId));
    if(!unchanged(related.filter(record=>!retired.has(record.id)),current)||!unchanged(peerBindings,currentBindings)||!unchanged(peerRuntimes.map(record=>record.value),currentRuntimes.map(record=>record.value)))continue;
    options.guard?.([...peers],peerRuntimes.map(record=>record.value.endpoint));
    const undeclared=!containers.some(record=>record.native)&&!relatedRuntimes.some(record=>record.value.pid!==undefined)&&!relatedBindings.some(binding=>binding.native);
    for(const record of unconfirmed){forgetOwnedProcess(record,'explicit-unknown-retirement');notes.push(`已按显式请求撤销未知容器 ${record.identity.pid}/${record.identity.startedAt} 的归属记录；未向该容器发送信号，也未确认组内进程全部退出。`+(undeclared?'此容器未登记原生宿主身份，未声明的 App Server 可能仍在运行；以后重新配对前请核对原宿主。':''));}
    for(const runtime of relatedRuntimes){removeManagedRuntime(runtime);if(runtime.value.peerId)affected.add(runtime.value.peerId);}
    for(const binding of relatedBindings){forgetNativeOwnership(binding);affected.add(binding.peerId);}
    for(const id of peers)affected.add(id);
  }
  const remaining=ownedProcesses(home).records,remainingRuntimes=managedRuntimes(home),remainingBindings=nativeOwnershipRecords(home);
  return{notes,peerIds:[...affected].filter(id=>!remaining.some(record=>record.peerId===id)&&!remainingRuntimes.some(record=>record.value.peerId===id)&&!remainingBindings.some(binding=>binding.peerId===id))};
}

                                     
export async function releaseOwnedOffline(home:string,config:BridgeConfig):Promise<string[]>{
  return(await releaseOwnedOfflineStatus(home,config)).notes;
}
export async function releaseOwnedOfflineStatus(home:string,config:BridgeConfig,options:{purge?:boolean}={}):Promise<{notes:string[];pending:boolean}>{
  const notes:string[]=[],information:string[]=[],filename=path.join(home,'nxbridge.db');let store:Store|undefined;
  if(existsSync(filename))try{store=new Store(filename);}catch(error){notes.push('配对账本无法读取，保留原文件；仅按可核验的外部归属处理：'+describeError(error));}
  const codex=new CodexAdapter(config,home),claude=new ClaudeAdapter(config,home);
  try{
    if(store)notes.push(...await migrateLegacyOwnership(home,store));
    for(const record of ownedProcesses(home).records.filter(value=>value.role==='broker'))try{await releaseOwnedProcess(record);}catch(error){notes.push('broker 回收未完成：'+describeError(error));}
    if((await Promise.all(ownedProcesses(home).records.filter(value=>value.role==='broker').map(value=>ownedRecordState(value)))).some(state=>state!=='dead'))return{notes,pending:true};
    const peers=store?.peers()??[];
    let bindings:ReturnType<typeof nativeOwnershipRecords>=[];
    try{bindings=nativeOwnershipRecords(home,(_peerId,note)=>notes.push(note));}catch(error){notes.push('原生后台归属无法完整读取：'+describeError(error));}
    for(const binding of bindings)if(!peers.some(value=>value.id===binding.peerId))peers.push({id:binding.peerId,host:'claude',sessionId:binding.sessionId??null,cwd:process.cwd(),name:'原生后台 Claude',kind:'root',parentId:null,owner:binding.releasedToUser?'user':'nxbridge',state:'offline',permission:'unknown',updatedAt:binding.createdAt});
    for(const peer of peers.filter(value=>value.owner==='user')){
      transferOwnedPeerToUser(home,peer.id);
      const binding=peer.host==='claude'?bindings.find(value=>value.peerId===peer.id):undefined;
      if(binding&&!binding.releasedToUser)saveNativeOwnership({...binding,releasedToUser:true});
    }
    const retired=options.purge?await retireUnconfirmedContainers(home,{protectedPeers:peers.filter(peer=>peer.owner==='user').map(peer=>peer.id),protectedEndpoints:peers.filter(peer=>peer.owner==='user').flatMap(peer=>store?.endpoints(peer.id)??[])}):{notes:[],peerIds:[]};information.push(...retired.notes);
    if(store)for(const pair of store.pairs())store.unpair(pair.id);
    for(const peer of peers.filter(value=>value.owner==='nxbridge'))try{
      if(retired.peerIds.includes(peer.id)){store?.deactivate(peer.id);store?.updatePeer(peer.id,{state:'offline'});continue;}
      if(peer.host==='claude'){
        const known=ownedProcesses(home).records.some(value=>value.peerId===peer.id)||bindings.some(value=>value.peerId===peer.id);
        if(known)await claude.release(peer);
      }else{const endpoint=store?.endpoint(peer.id)??store?.endpoints(peer.id).filter(value=>value.mode==='app-server').sort((a,b)=>b.seenAt-a.seenAt)[0];if(endpoint)await codex.release(peer,endpoint);}
      store?.deactivate(peer.id);store?.updatePeer(peer.id,{state:'offline'});
    }catch(error){notes.push(`${peer.name} 回收未完成：${describeError(error)}`);}
    try{const note=await codex.releaseRuntime(peers.filter(value=>value.owner==='user').flatMap(value=>store?.endpoints(value.id)??[]),undefined,peers.filter(value=>value.owner==='nxbridge'));if(note)notes.push(note);}catch(error){notes.push('托管 App Server 回收未完成：'+describeError(error));}
    for(const record of ownedProcesses(home).records.filter(value=>!value.releasedToUser&&['host-control','proxy','claude-worker','claude-child','test-daemon'].includes(value.role)&&(!value.peerId||!peers.some(peer=>peer.id===value.peerId&&peer.owner==='user'))))try{await releaseOwnedProcess(record);}catch(error){notes.push(`自有进程 ${record.identity.pid} 回收未完成：${describeError(error)}`);}
    const remaining=ownedProcesses(home);notes.push(...remaining.notes);
    for(const record of remaining.records)if(!record.releasedToUser&&await ownedRecordState(record)!=='dead')notes.push(`保留进程 ${record.identity.pid}/${record.identity.startedAt}：归属证据位于 ${processRegistryDirectory(home)}，请从外部终端重试卸载。`);
  }finally{codex.close();claude.close();store?.close();}
  return{notes:[...information,...notes],pending:notes.length>0};
}

export async function pruneProcessOwnership(home:string,purge=false):Promise<{directory:string;removed:boolean;notes:string[];orphanReceiptsRemoved:number}>{
  const directory=processRegistryDirectory(home),snapshot=ownedProcesses(home),notes=[...snapshot.notes];
  let orphanReceiptsRemoved=0;
  for(const record of snapshot.records){
    try{
    if(await ownedRecordState(record)==='dead')await retireDeadOwnedProcess(record);
    else if(purge&&record.releasedToUser)forgetOwnedProcess(record);
    else notes.push(`保留 ${record.identity.pid}/${record.identity.startedAt} 的归属记录：进程尚未核验退出${record.releasedToUser?'，已交给用户窗口':''}。`);
    }catch(error){notes.push(`进程 ${record.identity.pid} 的归属清理未完成：${describeError(error)}`);}
  }
  let bindings:ReturnType<typeof nativeOwnershipRecords>=[];
  try{bindings=nativeOwnershipRecords(home,(_peerId,note)=>notes.push(note));}catch(error){notes.push('原生后台归属无法完整读取，保留证据：'+describeError(error));}
  for(const binding of bindings){
    try{
    const records=ownedProcesses(home).records.filter(value=>value.peerId===binding.peerId);
    if(!records.length&&(binding.releasedToUser&&purge||binding.phase==='bound'&&binding.native&&await ownedProcessState(binding.native)==='dead'))forgetNativeOwnership(binding);
    else notes.push(`保留 Claude ${binding.peerId} 的启动归属：${binding.phase==='intent'?'启动结果尚未核验':'仍有对应进程或用户窗口'}。`);
    }catch(error){notes.push(`Claude ${binding.peerId} 的归属清理未完成：${describeError(error)}`);}
  }
  try{migrateRetiredCompletions(home);}catch(error){notes.push('已退出容器的完成凭据迁移未完成：'+describeError(error));}
  if(purge)try{
    const normalize=(file:string)=>process.platform==='win32'?path.resolve(file).toLowerCase():path.resolve(file),references=new Set(ownedProcesses(home).records.flatMap(record=>record.completionFile?[normalize(record.completionFile)]:[]));
                                                  
    for(const entry of existsSync(directory)?readdirSync(directory,{withFileTypes:true}):[]){
      const match=/^([a-f0-9-]{36})\.json\.done$/.exec(entry.name);if(!match||!entry.isFile())continue;
      const file=path.join(directory,entry.name);
      if(existsSync(path.join(directory,match[1]+'.json'))||references.has(normalize(file)))continue;
      try{if(statSync(file).size===0){unlinkSync(file);orphanReceiptsRemoved++;}}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')notes.push('孤立容器凭据清理未完成：'+describeError(error));}
    }
  }catch(error){notes.push('孤立容器凭据清理未完成：'+describeError(error));}
  if(!notes.length&&existsSync(directory)&&readdirSync(directory).length)notes.push('归属目录存在无法核验的文件，未删除。');
  if(!notes.length){
    const root=processRegistryRoot(),emptyParents=process.env.NXBRIDGE_PROCESS_REGISTRY?[]:[path.dirname(root)];
                                                      
    for(const target of [directory,root,...emptyParents])try{if(!readdirSync(target).length)rmdirSync(target);}catch(error){if(!['ENOENT','ENOTEMPTY','EEXIST'].includes((error as NodeJS.ErrnoException).code??''))throw error;}
  }
  return{directory,removed:!existsSync(directory),notes,orphanReceiptsRemoved};
}
