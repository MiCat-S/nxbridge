import {createReadStream,existsSync} from 'node:fs';
import { createInterface } from 'node:readline';
import { readSessionProfile, resumeSession, snapshotLiveSession, type SessionPolicy, type SessionProfile } from './codex-session-profile.js';
import {BridgeError,describeError} from '../../shared/errors.js';
import {type Endpoint,type Peer} from '../../types.js';
import {readJson} from '../../shared/files.js';
import {removeOwnedSocket} from '../../ipc/home.js';
import { liveProcess, processIdentity } from '../../process/process.js';
import type { RpcClient } from '../../ipc/rpc.js';
import { readCodexThread } from './codex-evidence.js';
import { ownedProcessState, stopOwnedProcess } from '../../process/process-stop.js';
import { retireDeadOwnedProcess, ownedProcesses, ownedRecordState, releaseOwnedProcess } from '../../process/owned-processes.js';
import { runtimeFor, removeManagedRuntime, saveManagedRuntime } from '../managed-runtimes.js';
import type { TargetSelector } from '../../broker/pairing/admin-target.js';
import { verifyDedicatedCodex } from './codex-isolation.js';
import { codexThreadIdle } from './codex-thread-state.js';
import { codexParent, codexSubagent } from './codex-lineage.js';
import type { CodexThread } from './adapter.js';

export interface CodexRestartResult {endpoint:string;oldPid:number;pid:number;resumed:any;notes?:string[]}
export interface RestartSelector extends TargetSelector {partner?:true}
interface Runtime {endpoint:string;pid:number;procStart?:string}

export function restartArguments(args:string[]):RestartSelector{
  if(args.length===2&&args[0]==='codex'&&args[1]==='--partner')return{partner:true};
  const flags={'--session':'session_id','--member':'peer_id','--pair':'pair_id'} as const,key=flags[args[1] as keyof typeof flags];
  if(args[0]!=='codex'||![1,3].includes(args.length)||(args.length===3&&(!key||!args[2]||args[2].startsWith('-'))))throw new BridgeError('invalid_arguments','用法：nxbridge restart codex [--partner | --session <会话ID> | --member <成员ID> | --pair <配对ID>]；--partner 仅供当前 Claude 窗口重启自己的托管搭档。');
  return args.length===3?{[key!]:args[2]}:{};
}

export function manualCodexRestart(peer:Peer,platform:NodeJS.Platform=process.platform):string{
                                          
  const quote=(value:string)=>"'"+value.replace(/'/g,platform==='win32'?"''":"'\"'\"'")+"'";
  const args=['codex','--no-daemon','--cd',quote(peer.cwd),...(peer.model?['--model',quote(peer.model)]:[]),...(peer.effort!==undefined?['-c',quote('model_reasoning_effort='+JSON.stringify(String(peer.effort)))]:[]),'resume',quote(peer.sessionId!)];
  return `会话 ${peer.sessionId} 由用户窗口管理，未执行重启。\n等待任务、问题和审批结束后，在原窗口输入 /quit，再在终端执行：\n${args.join(' ')}\n此命令用独立原生运行时恢复原 ID；请勿同时打开原会话的两个窗口。`;
}

function idle(thread:any,allowUnloaded=false):void{
  if(!codexThreadIdle(thread)&&!(allowUnloaded&&thread.status?.type==='notLoaded'&&!thread.status.activeFlags?.length&&!thread.turns?.some((turn:any)=>turn.status==='inProgress')))throw new BridgeError('session_busy','目标仍在运行或等待输入/审批，未执行重启；请在空闲后重试。');
}

                                      
export async function assertCodexRuntimeScope(rpc:RpcClient,id:string):Promise<void>{
  const loaded=new Set<string>(),threads=new Map<string,CodexThread>();let cursor:string|undefined;
  const unverified=()=>new BridgeError('restart_verification_failed','无法完整核验宿主子线程的身份或状态，未执行重启。');
  for(let pageIndex=0;pageIndex<10;pageIndex++){
    const page=await rpc.request('thread/loaded/list',{limit:100,...(cursor?{cursor}:{})});
    if(!Array.isArray(page.data))throw unverified();
    for(const value of page.data){const threadId=typeof value==='string'?value:value?.id;if(typeof threadId!=='string'||!threadId)throw unverified();loaded.add(threadId);}
    cursor=page.nextCursor??undefined;if(!cursor)break;
  }
  if(cursor)throw unverified();
                                          
  const read=async(threadId:string)=>{let thread=threads.get(threadId);if(!thread){const result=await rpc.request('thread/read',{threadId,includeTurns:false});if(result.thread?.id!==threadId)throw unverified();thread=result.thread as CodexThread;threads.set(threadId,thread);}return thread;};
  for(const threadId of loaded){
    if(threadId===id)continue;
    const metadata=await read(threadId),seen=new Set<string>();let current=metadata,verified=false;
    for(let depth=0;depth<64;depth++){
      if(seen.has(current.id))throw unverified();seen.add(current.id);
      if(!codexSubagent(current))throw new BridgeError('shared_runtime','这个后台还运行着另一个 Codex 会话，未执行重启。');
      const parent=codexParent(current);if(!parent)throw unverified();
      if(parent===id){verified=true;break;}current=await read(parent);
    }
    if(!verified)throw unverified();
    const thread=metadata.ephemeral?metadata:await readCodexThread(rpc,threadId);
    if(!codexThreadIdle(thread)&&!(thread.status?.type==='notLoaded'&&!thread.status.activeFlags?.length&&!thread.turns?.some(turn=>turn.status==='inProgress')))
      throw new BridgeError('subagent_active','Codex 还有子代理在运行，未执行重启；等它们结束后再试一次。');
    await assertNoPendingCodexWork(rpc,threadId,{allowUnloaded:thread.status?.type==='notLoaded'});
    if(!thread.ephemeral&&thread.turns?.length)await durable(thread);
  }
}

export async function assertNoPendingCodexWork(rpc:RpcClient,id:string,options:{allowUnloaded?:boolean}={}):Promise<void>{
  const [queue,terminals]=await Promise.all([
    rpc.request('thread/queue/list',{threadId:id,limit:1}),
    rpc.request('thread/backgroundTerminals/list',{threadId:id,limit:1}).catch(error=>{
      if(options.allowUnloaded&&error instanceof BridgeError&&error.message==='thread not found: '+id)return{unloaded:true};
      throw error;
    }),
  ]);
  if(queue.data?.length)throw new BridgeError('delivery_unsettled','原生线程还有排队输入，未执行重启；请先处理队列。');
  if(terminals.data?.length)throw new BridgeError('session_busy','目标还有后台终端任务，未执行重启；请先等待任务结束。');
  if(terminals.unloaded){
                                              
    const thread=(await rpc.request('thread/read',{threadId:id,includeTurns:false})).thread;
    if(thread?.id!==id||thread.status?.type!=='notLoaded'||thread.status.activeFlags?.length)throw new BridgeError('session_busy','线程已重新加载或状态无法核验，未停止运行时。');
    let cursor:string|undefined;
    do{
      const page=await rpc.request('thread/loaded/list',{limit:100,...(cursor?{cursor}:{})});
      if((page.data??[]).some((value:any)=>(typeof value==='string'?value:value.id)===id))throw new BridgeError('session_busy','线程在核验期间重新加载，未停止运行时。');
      cursor=page.nextCursor??undefined;
    }while(cursor);
  }
}

async function durable(thread:any):Promise<void>{
  const last=thread.turns?.at(-1);
  if(!last||!['completed','failed','interrupted'].includes(last.status)||!thread.path||!existsSync(thread.path))throw new BridgeError('history_not_persisted','目标没有可核验的完整持久历史，未执行重启。');
                                            
  const stream=createReadStream(thread.path,{encoding:'utf8'}),lines=createInterface({input:stream,crlfDelay:Infinity});
  try{
    for await(const line of lines){
      let record:any;try{record=JSON.parse(line);}catch{continue;}
      if(record.type==='event_msg'&&['task_complete','turn_complete','turn_aborted'].includes(record.payload?.type)&&record.payload.turn_id===last.id)return;
    }
  }finally{lines.close();stream.destroy();}
  throw new BridgeError('history_not_persisted','末轮结束记录尚未落盘，未执行重启；请稍后重试。');
}

export async function restartCodexRuntime(options:{
  peer:Peer;endpoint:Endpoint;home:string;connect:(address:string)=>Promise<RpcClient>;
  start:()=>Promise<string>;guard:()=>void;profile?:SessionProfile;inspect?:(address:string)=>Promise<RpcClient>;verifyDelivery?:(thread:any)=>Promise<void>;observeThread?:(thread:any)=>void;onStopped?:()=>void;onVerifying?:(runtimeId:string,endpoint:string)=>void;onPolicy?:(policy:SessionPolicy,runtimeId:string,endpoint:string)=>void;
}):Promise<CodexRestartResult>{
  const stopped=await stopCodexRuntime(options),id=options.peer.sessionId!;
  try{
    const address=await options.start(),fresh=await options.connect(address);
    const pending=runtimeFor(options.home,{endpoint:address});if(!pending)throw new BridgeError('runtime_missing','新运行时缺少启动记录。');
    pending.value.sessionVerification={sessionId:id,profile:stopped.profile};saveManagedRuntime(options.home,pending.value);
    options.onVerifying?.(pending.value.id,address);
    const restored=await resumeSession(fresh,id,{profile:stopped.profile,home:options.endpoint.configHome,cwd:options.peer.cwd});
    const runtime=runtimeFor(options.home,{endpoint:address});if(!runtime?.value.pid)throw new BridgeError('runtime_missing','新运行时缺少已核验的进程记录。');
    delete runtime.value.sessionVerification;saveManagedRuntime(options.home,runtime.value);
    options.onPolicy?.(restored.policy,runtime.value.id,address);
    return{endpoint:address,oldPid:stopped.oldPid,pid:runtime.value.pid,resumed:restored.resumed,notes:stopped.notes};
  }catch(error){throw new BridgeError('restart_incomplete',`旧托管进程已停止，但原会话 ${id} 未完整恢复；已暂停自动投递。原因：`+describeError(error));}
}

                                              
export async function stopCodexRuntime(options:{
  peer:Peer;endpoint:Endpoint;home:string;connect:(address:string)=>Promise<RpcClient>;guard:()=>void;
  profile?:SessionProfile;inspect?:(address:string)=>Promise<RpcClient>;verifyDelivery?:(thread:any)=>Promise<void>;observeThread?:(thread:any)=>void;onStopped?:()=>void;
}):Promise<{oldPid:number;notes:string[];profile:SessionProfile}>{
  const {peer,endpoint,home,connect,guard}=options,id=peer.sessionId!,record=runtimeFor(home,{endpoint:endpoint.address});
  if(!record)throw new BridgeError('unowned_runtime','没有 nxbridge 托管运行时记录，未执行重启；用户 daemon 或远程宿主需要原生重载。');
  const filename=record.file,saved=record.value;
  if(saved.pid&&saved.procStart&&await ownedProcessState({pid:saved.pid,startedAt:saved.procStart})==='alive')await verifyDedicatedCodex(saved.endpoint,await processIdentity(saved.pid));
  if(ownedProcesses(home).records.some(r=>r.releasedToUser&&(r.identity.pid===saved.pid||r.proof.launchId===saved.id||r.proof.launchId===saved.endpoint)))throw new BridgeError('shared_runtime','这个 App Server 还有你的窗口在用，nxbridge 不会重启它。请在对应的 Codex 窗口里退出后重新打开。');
  const verify=async()=>{
    const current=existsSync(filename)?readJson<Runtime>(filename):undefined;
    if(!current||current.pid!==saved.pid||current.procStart!==saved.procStart||current.endpoint!==saved.endpoint)throw new BridgeError('runtime_changed','运行时归属记录已经变化，未执行重启。');
    if(saved.endpoint!==endpoint.address||!saved.pid||!saved.procStart||!liveProcess(saved.pid))throw new BridgeError('unowned_runtime','目标不是当前可核验的 nxbridge 托管进程，未执行重启。');
    const identity=await processIdentity(saved.pid);
    if(identity.startedAt!==saved.procStart||!/^codex(?:\.exe)?$/i.test(identity.name))throw new BridgeError('unowned_runtime','无法核验托管 App Server 的进程代次，未执行重启。');
  };
  await verify();const rpc=await(options.inspect??connect)(endpoint.address);
  try{
  const inspectThread=(thread:any,allowUnloaded=false)=>{options.observeThread?.(thread);idle(thread,allowUnloaded);};
  await assertCodexRuntimeScope(rpc,id);
                                                  
  const live={thread:await readCodexThread(rpc,id)};inspectThread(live.thread,true);await durable(live.thread);
  const profile=options.profile??(codexThreadIdle(live.thread)?await snapshotLiveSession(rpc,id,live.thread.path!):await readSessionProfile(live.thread.path,id));
  if(!profile.verified||!profile.complete)throw new BridgeError('profile_unavailable','无法核验原会话完整持久设置，未停止原运行时。');
  const unloaded=live.thread.status?.type==='notLoaded';
  await verify();await assertNoPendingCodexWork(rpc,id,{allowUnloaded:unloaded});
  const verified=await readCodexThread(rpc,id);inspectThread(verified,true);
  if(unloaded&&verified.status?.type!=='notLoaded')throw new BridgeError('session_busy','已卸载线程在停止核验期间重新加载，未停止运行时。');
  if(options.verifyDelivery){await durable(verified);await options.verifyDelivery(verified);}guard();
  let stopSubmitted=false;
  try{
    await assertCodexRuntimeScope(rpc,id);
    inspectThread(await readCodexThread(rpc,id),true);
    guard();
    stopSubmitted=true;
    await stopOwnedProcess({pid:saved.pid!,startedAt:saved.procStart!},{timeout:15000});
    options.onStopped?.();
    rpc.close();
    const current=readJson<Runtime>(filename);
    if(current.pid!==saved.pid||current.procStart!==saved.procStart||current.endpoint!==saved.endpoint)throw new BridgeError('runtime_changed','运行时记录已被其他操作更新，停止自动恢复；原会话 ID 保留。');
    const notes:string[]=[];
    try{await removeOwnedSocket(home,saved.endpoint);}catch(error){notes.push('旧 socket 清理未完成：'+describeError(error));}
    for(const proof of ownedProcesses(home).records.filter(value=>value.proof.launchId===saved.id||value.proof.launchId===saved.endpoint||value.role==='codex-runtime'&&value.identity.pid===saved.pid).sort((a,b)=>Number(!!(b.windowsJob||b.posixGroup))-Number(!!(a.windowsJob||a.posixGroup))||b.createdAt-a.createdAt))if(await ownedRecordState(proof)==='dead')await retireDeadOwnedProcess(proof);else await releaseOwnedProcess(proof);
    removeManagedRuntime(record);
    return{oldPid:saved.pid!,notes,profile};
  }catch(error){if(!stopSubmitted)throw error;throw new BridgeError('restart_incomplete',`旧托管进程已收到停止请求，但原会话 ${id} 未完整恢复；已暂停目标自动投递，请检查原宿主后再恢复。原因：`+describeError(error));}
  }finally{if(options.inspect)await rpc.close();}
}
