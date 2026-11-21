import WebSocket from 'ws';
import { backendCodexClient, officialCodexClient } from './codex-client-identity.js';
import net from 'node:net';
import { proxySocket } from '../../ipc/proxy-socket.js';
import {openSync,closeSync,readSync} from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { codexThreadIdle } from './codex-thread-state.js';
import { profileChangeFailure } from '../../broker/profiles/partner-profile.js';
import { createHash, randomUUID } from 'node:crypto';
import { spawnPosixSupervisor, posixSupervisorExit } from '../../process/posix/posix-supervisor.js';
import { RpcClient, clearRpcFaults, type RpcMessage } from '../../ipc/rpc.js';
import {BridgeError,DeliveryError,describeError} from '../../shared/errors.js';
import {DEFAULT_RETENTION} from '../../config/defaults.js';
import {WAKE_NOTICE,type BridgeConfig,type CodexPermissionEvidence,type Endpoint,type Peer,type PeerState,type RegisterInput} from '../../types.js';
import { rotateLog } from '../../storage/logs.js';
import {sameDirectory} from '../../shared/files.js';
import {bridgeHome} from '../../shared/local-paths.js';
import {delay} from '../../shared/time.js';
import {removeOwnedSocket,socketDirectory} from '../../ipc/home.js';
import {spawnCli} from '../../process/host-command.js';
import {processIdentity} from '../../process/process.js';
import { assertCodexRuntimeScope, restartCodexRuntime, type CodexRestartResult } from './codex-restart.js';
import {prepareOwnedLaunch,recordHostLaunch,spawnSelectedHost} from '../host-launch.js';
import { nativeDescendant } from '../../process/process.js';
import { providerRetryInfo } from '../../broker/health/turn-health.js';
import {probeAppServer,probePeerRuntime} from '../../broker/health/probe.js';
import {type RuntimeAvailability} from '../../broker/health/contracts.js';
import {declareOwnedNative,retireDeadOwnedProcess,ownedProcesses,ownedRecordState,prepareProcessRegistry,releaseOwnedProcess,releaseRecordedProcesses,rememberOwnedChild,rememberOwnedHost,type OwnedProcessRecord} from '../../process/owned-processes.js';
import {ownedProcessState} from '../../process/process-stop.js';
import { managedMarker } from '../../install/installation.js';
import { managedRuntimes, runtimeFor, saveManagedRuntime, removeManagedRuntime, managedRuntimeState, managedRuntimeNativeState, managedRuntimeToken,createRuntimeToken,localCodexEndpoint,assertManagedRuntimeEndpoint,type ManagedRuntime, type RuntimeRecord } from '../managed-runtimes.js';
import { launchIndependentWindows } from '../../process/windows/windows-background.js';
import { requireDedicatedCodex, verifyDedicatedCodex, requireRestoreBootstrap, CODEX_RESTORE_BOOTSTRAP } from './codex-isolation.js';
import { selectSessionLaunch } from '../session-launch.js';
import { recordManagedSessionLaunch } from '../launch-profiles.js';
import { restoreState } from '../../broker/pairing/pair-restore.js';
import { backgroundState, requireBackgroundRetry } from '../background-state.js';
import { readCodexHistory, type HistoryCursor, type HistoryEvidence } from './codex-history.js';
import { readCodexThread, readCodexItems } from './codex-evidence.js';
import { classifyCodexPermission, codexRuntimeEvidence } from './codex-permission.js';
import { startOwnedCodex, unloadFailedOwnedCodex } from '../owned-launch-policy.js';
import type { PermissionClass } from '../../types.js';
import { resumeSession, readSessionProfile, sessionFile, verifyResumedSession } from './codex-session-profile.js';
import { codexParent, codexSubagent, codexUserWindow } from './codex-lineage.js';
import { codexThreadState } from './codex-thread-state.js';

export interface CodexThread {
  id:string;cwd:string;name?:string;ephemeral?:boolean;parentThreadId?:string|null;forkedFromId?:string|null;threadSource?:string;path?:string;
  status?:{type:string;activeFlags?:string[]};source?:any;turns?:any[];
  model?:string|null;reasoningEffort?:string|null;progressEvidence?:boolean;
}

export interface CodexContextReceipt {messageId:string;turnId:string;itemId:string}

export function codexContextReceipts(item:any,turnId:unknown):CodexContextReceipt[]{
  if(typeof item?.id!=='string'||!item.id||typeof turnId!=='string'||!turnId)return[];
  let output:any;
  if(item.type==='functionCallOutput'&&item.namespace==='claude'&&item.name==='receive_messages'&&typeof item.output==='string'){
    try{output=JSON.parse(item.output);}catch{return[];}
  }else if(item.type==='mcpToolCall'&&item.server==='claude'&&item.tool==='receive_messages'&&item.status==='completed'&&!item.error){
    const content=item.result?.content;
    if(!Array.isArray(content))return[];
    output={messages:content.flatMap((entry:any)=>{if(entry?.type!=='text'||typeof entry.text!=='string')return[];try{const value=JSON.parse(entry.text);return Array.isArray(value.messages)?value.messages:[];}catch{return[];}})};
  }else return[];
  if(!Array.isArray(output?.messages))return[];
  const ids=new Set<string>();
  for(const message of output.messages)if(typeof message?.message_id==='string'&&message.message_id)ids.add(message.message_id);
  return[...ids].map(messageId=>({messageId,turnId,itemId:item.id}));
}

                                                    
export function codexAgentPath(sessionId:string,agentId:string,transcript:string,parentTranscript:string):string|undefined{
                                                                  
  const metadata=(filename:string)=>{
    const fd=openSync(filename,'r');
    try{
      const bytes=Buffer.allocUnsafe(4096),chunks:Buffer[]=[];let length:number;
      while((length=readSync(fd,bytes,0,bytes.length,null))>0){
        const end=bytes.subarray(0,length).indexOf(10);chunks.push(Buffer.from(bytes.subarray(0,end<0?length:end)));
        if(end>=0)break;
      }
      const record=JSON.parse(Buffer.concat(chunks).toString('utf8'));return record.type==='session_meta'?record.payload:undefined;
    }finally{closeSync(fd);}
  };
  const parent=metadata(parentTranscript),meta=metadata(transcript);
  if(parent?.id!==sessionId||parent?.session_id!==sessionId||meta?.id!==agentId||meta?.session_id!==sessionId)throw new BridgeError('unverified_parent','子代理及根元数据与 hook 身份不符。');
  return typeof meta.agent_path==='string'?meta.agent_path:undefined;
}

export async function connectAppServer(endpoint:string,config:BridgeConfig,bearerToken?:string,home=bridgeHome(),options:{readOnly?:boolean}={}):Promise<RpcClient>{
  return (options.readOnly?backendCodexClient:officialCodexClient)(()=>openAppServerTransport(endpoint,config,bearerToken,home));
}

async function openAppServerTransport(endpoint:string,config:BridgeConfig,bearerToken:string|undefined,home:string):Promise<RpcClient>{
  let proxy:ReturnType<typeof spawnCli>|undefined;
  const launchId=randomUUID();let cleanup:Promise<void>|undefined;
  const stopProxy=()=>{if(!proxy)return;cleanup??=releaseRecordedProcesses(home,record=>record.proof.launchId===launchId).then(notes=>{for(const note of notes)process.stderr.write(note+'\n');}).catch(error=>{process.stderr.write('proxy 回收未完成：'+describeError(error)+'\n');});};
                                           
                                                  
                                     
  const options:WebSocket.ClientOptions&{closeTimeout:number}={handshakeTimeout:5000,closeTimeout:1000,maxPayload:16*1024*1024};
  if(!endpoint.startsWith('unix://')){
    await assertManagedRuntimeEndpoint(home,endpoint);
    const token=bearerToken??managedRuntimeToken(home,endpoint)??(config.codexAuthTokenEnv?process.env[config.codexAuthTokenEnv]:undefined);
    if(config.codexAuthTokenEnv&&!token)throw new BridgeError('token_missing',`缺少环境变量 ${config.codexAuthTokenEnv}，无法认证远程 App Server。`);
    if(token)options.headers={Authorization:`Bearer ${token}`};
  }
  let url=endpoint;
  if(endpoint.startsWith('unix://')){
    const filename=endpoint.slice('unix://'.length);url='ws://localhost';
    if(process.platform==='win32'){
      await prepareProcessRegistry(home);
      proxy=spawnCli('codex',['app-server','proxy','--sock',filename],{stdio:['pipe','pipe','pipe']},config,home);
      proxy.stderr?.on('data',()=>{});
      const stream=proxySocket(proxy);
                                                
      let streamError:Error|undefined;
      stream.on('error',error=>{streamError=error;});
                                           
      options.createConnection=()=>stream.setTimeout(options.handshakeTimeout??0) as unknown as net.Socket;
      try{
        await rememberOwnedHost(home,proxy,'codex','proxy',launchId);
        if(stream.destroyed)throw streamError??stream.errored??new BridgeError('proxy_closed','App Server proxy 在连接建立前已关闭。');
      }catch(error){stream.destroy();stopProxy();if(proxy.exitCode===null&&proxy.signalCode===null)proxy.kill();throw error;}
    }else options.createConnection=()=>net.createConnection({path:filename,timeout:options.handshakeTimeout});
  }else if(!/^wss?:\/\//.test(endpoint))throw new BridgeError('invalid_endpoint','App Server 地址必须是 unix:// 或 ws(s)://。');
  const socket=new WebSocket(url,options);
  await new Promise<void>((resolve,reject)=>{
    socket.once('open',resolve);socket.once('error',error=>{stopProxy();reject(error);});
  });
                                                 
  const rpc=new RpcClient(message=>{if(socket.bufferedAmount>4*1024*1024)throw new BridgeError('rpc_backpressure','原生写入正在积压。');socket.send(JSON.stringify(message));},()=>socket.close(),endpoint);
  let lastInput=Date.now(),misses=0,pongTimer:NodeJS.Timeout|undefined;
  const heartbeat=setInterval(()=>{
    if(rpc.closed||socket.readyState!==WebSocket.OPEN||Date.now()-lastInput<30000||pongTimer)return;
    socket.ping();pongTimer=setTimeout(()=>{pongTimer=undefined;if(++misses>=2){rpc.disconnected('原生心跳连续未确认。','heartbeat_timeout');socket.terminate();}},10000);pongTimer.unref();
  },30000);heartbeat.unref();
  const received=()=>{lastInput=Date.now();misses=0;if(pongTimer){clearTimeout(pongTimer);pongTimer=undefined;}};
  const clean=()=>{clearInterval(heartbeat);if(pongTimer)clearTimeout(pongTimer);};socket.on('pong',received);
  socket.on('message',data=>{received();const at=performance.now();try{const message=JSON.parse(data.toString());rpc.receive(message,{bytes:Buffer.isBuffer(data)?data.length:Buffer.byteLength(data.toString()),parseMs:performance.now()-at});}catch{rpc.disconnected('原生响应不是有效 JSON。','invalid_json');socket.close();}});
  socket.on('close',(code,reason)=>{clean();rpc.disconnected(reason.toString()||'连接已断开。',code===1009?'payload_too_large':'disconnected');stopProxy();});
  socket.on('error',(error:any)=>{clean();rpc.disconnected(error?.code==='WS_ERR_UNSUPPORTED_MESSAGE_LENGTH'?'原生响应超过 16 MiB 大小保护。':'原生连接中断。',error?.code==='WS_ERR_UNSUPPORTED_MESSAGE_LENGTH'?'payload_too_large':'disconnected');});
  return rpc;
}

                                               
async function deliveryStep<T>(work:()=>Promise<T>,signal?:AbortSignal,uncertain:boolean|(()=>boolean)=false):Promise<T>{
  const submitted=()=>typeof uncertain==='function'?uncertain():uncertain;
  if(signal?.aborted)throw new DeliveryError('stopping','协调器正在关闭，已停止等待系统通知。',submitted());
  if(!signal)return work();
  let abort!:()=>void;
  try{return await new Promise<T>((resolve,reject)=>{
    abort=()=>reject(new DeliveryError('stopping','协调器正在关闭，已停止等待系统通知。',submitted()));
    signal.addEventListener('abort',abort,{once:true});
    work().then(resolve,reject);
  });}finally{signal.removeEventListener('abort',abort);}
}

interface CodexRuntimeProfile extends Pick<CodexThread,'model'|'reasoningEffort'> {approvalPolicy?:unknown;approvalsReviewer?:unknown;autoReviewEnabled?:boolean;sandbox?:{type?:string}}

export function threadRegistration(thread:CodexThread,endpoint:string,profile:CodexRuntimeProfile={}):RegisterInput|undefined{
  if(thread.ephemeral)return undefined;
  const parent=codexParent(thread);
  const model=profile.model===undefined?thread.model:profile.model,effort=profile.reasoningEffort===undefined?thread.reasoningEffort:profile.reasoningEffort;
  const evidence:CodexPermissionEvidence=codexRuntimeEvidence(profile);
  return {host:'codex',sessionId:thread.id,cwd:thread.cwd,name:thread.name??'Codex',kind:codexSubagent(thread)?'subagent':thread.forkedFromId?'fork':'root',parentId:parent,
    ...(model===undefined?{}:{model}),...(effort===undefined?{}:{effort}),
    state:codexThreadState(thread),
    endpoint:{mode:'app-server',address:endpoint,epoch:endpoint,pid:null,procStart:null,...(thread.path?{nativeSession:{transcriptPath:thread.path}}:{}),...(Object.keys(evidence).length?{codexPermission:evidence}:{})}};
}

export class CodexAdapter extends EventEmitter {
  modelProfile:(peer:Peer)=>import('../../types.js').ModelProfile=()=>({});
  private disabledMembers=new Set<string>();
  private disabledThreads=new Set<string>();
  setEnabled(peer:Peer,endpoint:Endpoint|undefined,enabled:boolean,disconnect=false):void{
    const key=endpoint?endpoint.address+'|'+peer.sessionId:undefined;
    if(enabled){this.disabledMembers.delete(peer.id);if(key)this.disabledThreads.delete(key);}
    else{this.disabledMembers.add(peer.id);if(key){this.disabledThreads.add(key);this.nativeStates.delete(key);}if(disconnect&&endpoint)this.clients.get(endpoint.address)?.close();}
  }
  private requireMember(id?:string):void{if(id&&this.disabledMembers.has(id))throw new BridgeError('member_disabled','此成员的 nxbridge 已关闭，未访问原生宿主。');}
  private clients=new Map<string,RpcClient>();
  rpcMetrics(){return[...this.clients.values()].reduce((sum,rpc)=>({connections:sum.connections+1,responses:sum.responses+rpc.metrics.responses,bytes:sum.bytes+rpc.metrics.bytes,parseMs:sum.parseMs+rpc.metrics.parseMs,largestBytes:Math.max(sum.largestBytes,rpc.metrics.largestBytes),timeouts:sum.timeouts+rpc.metrics.timeouts,rejected:sum.rejected+rpc.metrics.rejected}),{connections:0,responses:0,bytes:0,parseMs:0,largestBytes:0,timeouts:0,rejected:0});}
  private connecting=new Map<string,Promise<RpcClient>>();
  private attached=new Set<string>();
  private subscriptionOwners=new Map<string,{peer:Peer;endpoint:Endpoint}>();
  private attaching=new Map<string,Promise<RpcClient>>();
  private threadOperations=new Map<string,Promise<unknown>>();
  private verifying=new Set<string>();
  private invalidated=new Set<string>();
  private starting=new Map<string,Promise<string>>();
  private declaredNatives=new Set<string>();
  private restarting=new Map<string,Promise<CodexRestartResult>>();
  private tokens=new Map<string,string>();
  private configHomes=new Map<string,string>();
  private discovering=new Map<string,Promise<void>>();
  private discovered=new Map<string,number>();
  private nativeStates=new Map<string,{state:PeerState;revision:number}>();
  private nativeStateRevision=0;
  private verifiedLineage=new Map<string,CodexThread>();
  constructor(private config:BridgeConfig,private home=bridgeHome()){super();}
  async probe(peer:Peer,endpoint?:Endpoint):Promise<RuntimeAvailability>{
    this.requireMember(peer.id);
    return probePeerRuntime(peer,endpoint,this.home,async()=>{
      if(!endpoint)return false;
      const rpc=this.clients.get(endpoint.address);
      if(rpc&&!rpc.closed){
        try{const result=await rpc.request('thread/read',{threadId:peer.sessionId,includeTurns:false},{timeout:750});return typeof result.thread?.id==='string'?result.thread.id===peer.sessionId:undefined;}
        catch(error){return rpc.closed?false:undefined;}
      }
      const token=this.tokens.get(endpoint.address)??managedRuntimeToken(this.home,endpoint.address)??(this.config.codexAuthTokenEnv?process.env[this.config.codexAuthTokenEnv]:undefined);
      return probeAppServer(endpoint.address,token);
    });
  }
  async connect(endpoint:string,bearerToken?:string):Promise<RpcClient>{
    if(/[\\/]app-server-(?:control|daemon)[\\/]/i.test(endpoint))throw new BridgeError('shared_daemon_read_only','共享 daemon 只能通过只读发现连接访问，不能交给专用投递适配器。');
    if(bearerToken)this.tokens.set(endpoint,bearerToken);
    const existing=this.clients.get(endpoint);if(existing&&!existing.closed)return existing;
    const pending=this.connecting.get(endpoint);if(pending)return pending;
    const ready=(async()=>{
      const rpc=await connectAppServer(endpoint,this.config,this.tokens.get(endpoint),this.home);clearRpcFaults(endpoint);this.clients.set(endpoint,rpc);
      rpc.on('notification',(message:RpcMessage)=>this.notify(endpoint,message));
      try{const value=await rpc.request('config/read',{includeLayers:true},{timeout:3000}),user=value.layers?.find((layer:any)=>layer.name?.type==='user'&&typeof layer.name.file==='string');if(user)this.configHomes.set(endpoint,path.dirname(user.name.file));this.emit('providerRetries',{address:endpoint,budget:providerRetryInfo(value.config)});}catch{}
      rpc.on('request',(message:RpcMessage)=>{
                                   
        this.emit('native',{address:endpoint,message});
        if(message.params?.threadId){this.nativeStates.set(endpoint+'|'+message.params.threadId,{state:'needsHuman',revision:++this.nativeStateRevision});this.emit('state',message.params.threadId,'needsHuman',endpoint);}
      });
      rpc.on('disconnected',()=>{
        if(this.clients.get(endpoint)!==rpc)return;
        this.clients.delete(endpoint);
        for(const key of this.nativeStates.keys())if(key.startsWith(endpoint+'|'))this.nativeStates.delete(key);
        for(const key of new Set([...this.attached,...this.attaching.keys()]))if(key.startsWith(endpoint+'|')){this.attached.delete(key);this.subscriptionOwners.delete(key);this.invalidated.add(key);}
        this.emit('disconnected',endpoint);
      });
      try{await this.discoverLoaded(endpoint,rpc);
      return rpc;}catch(error){rpc.close();throw error;}
    })();
    this.connecting.set(endpoint,ready);try{return await ready;}finally{this.connecting.delete(endpoint);}
  }
  async discoverLoaded(endpoint:string,rpc=this.clients.get(endpoint)):Promise<void>{
    if(!rpc||rpc.closed)return;let cursor:string|undefined;
    for(let page=0;page<10;page++){
      const list=await rpc.request('thread/loaded/list',{limit:100,...(cursor?{cursor}:{})});
      await Promise.all((list.data??[]).map((id:any)=>this.discoverThread(endpoint,typeof id==='string'?id:id.id,rpc)));
      cursor=list.nextCursor??undefined;if(!cursor)return;
    }
  }
  private discoverThread(endpoint:string,id:string,rpc=this.clients.get(endpoint)):Promise<void>{
    const key=endpoint+'|'+id,pending=this.discovering.get(key);if(pending)return pending;
    if(!rpc||rpc.closed||typeof id!=='string'||this.disabledThreads.has(key)||(this.discovered.get(key)??0)>Date.now())return Promise.resolve();
    const revision=this.nativeStateRevision;
    const work=rpc.request('thread/read',{threadId:id,includeTurns:false},{timeout:3000}).then(r=>{if(r.thread?.id===id&&r.thread.status?.type!=='notLoaded'){this.record(r.thread,endpoint,undefined,undefined,revision);this.discovered.set(key,Date.now()+1000);}}).catch(()=>{this.discovered.set(key,Date.now()+1000);}).finally(()=>{this.discovering.delete(key);});
    this.discovering.set(key,work);if(this.discovered.size>256)this.discovered.delete(this.discovered.keys().next().value!);return work;
  }
  private record(thread:CodexThread,endpoint:string,profile?:CodexRuntimeProfile,memberId?:string,readRevision=this.nativeStateRevision):void {
    if(this.verifying.has(endpoint+'|'+thread.id))return;
    if(this.disabledThreads.has(endpoint+'|'+thread.id)||memberId&&this.disabledMembers.has(memberId))return;
    if(thread.status?.type==='notLoaded'){const key=endpoint+'|'+thread.id;this.attached.delete(key);this.subscriptionOwners.delete(key);this.invalidated.add(key);}
    const registration=threadRegistration(thread,endpoint,profile);
                                             
    const nativeState=this.nativeStates.get(endpoint+'|'+thread.id);if(registration&&nativeState&&nativeState.revision>readRevision)registration.state=nativeState.state;
    if(registration){const home=this.configHomes.get(endpoint);if(home)registration.endpoint.configHome=home;const runtime=runtimeFor(this.home,{endpoint})?.value;if(runtime){recordManagedSessionLaunch(this.home,thread.id,thread.cwd,runtime);registration.endpoint.runtimeId=runtime.id;if(runtime.pid&&runtime.procStart){registration.endpoint.pid=runtime.pid;registration.endpoint.procStart=runtime.procStart;}}this.emit('register',registration,memberId);}
  }
  private notify(endpoint:string,message:RpcMessage):void {
    if(this.disabledThreads.has(endpoint+'|'+(message.params?.threadId??message.params?.thread?.id)))return;
    this.emit('native',{address:endpoint,message});
    const p=message.params??{};
    if(message.method==='thread/started'&&p.thread){this.nativeStates.set(endpoint+'|'+p.thread.id,{state:codexThreadState(p.thread),revision:++this.nativeStateRevision});this.record(p.thread,endpoint);}
    if(['thread/closed','thread/archived','thread/unloaded'].includes(message.method??'')&&typeof p.threadId==='string'){
      const key=endpoint+'|'+p.threadId;this.attached.delete(key);this.subscriptionOwners.delete(key);this.invalidated.add(key);
      this.nativeStates.set(key,{state:'offline',revision:++this.nativeStateRevision});this.emit('state',p.threadId,'offline',endpoint);
    }
    if(message.method==='thread/status/changed'){
      if(p.status?.type!=='notLoaded')void this.discoverThread(endpoint,p.threadId);
      if(p.status?.type==='notLoaded'){
        const key=endpoint+'|'+p.threadId;this.attached.delete(key);this.subscriptionOwners.delete(key);this.invalidated.add(key);
      }
      const state=codexThreadState({status:p.status});
      this.nativeStates.set(endpoint+'|'+p.threadId,{state,revision:++this.nativeStateRevision});this.emit('state',p.threadId,state,endpoint);
    }
    if(message.method==='turn/started'){
      this.nativeStates.set(endpoint+'|'+p.threadId,{state:'busy',revision:++this.nativeStateRevision});
      this.emit('turnStarted',p.threadId,endpoint);
                                               
      const revision=this.nativeStateRevision;
      void this.clients.get(endpoint)?.request('thread/read',{threadId:p.threadId,includeTurns:false}).then(r=>{
        if(r.thread){this.record(r.thread,endpoint,undefined,undefined,revision);this.emit('profile',p.threadId,{model:r.thread.model,effort:r.thread.reasoningEffort},endpoint);}
      }).catch(()=>{});
    }
    if(message.method==='turn/completed'&&p.turn?.status==='interrupted'){this.nativeStates.set(endpoint+'|'+p.threadId,{state:'paused',revision:++this.nativeStateRevision});this.emit('interrupted',p.threadId,endpoint,p.turn.id);}
    if(message.method==='item/completed'){
      this.emit('item',p);
      if(typeof p.threadId==='string')for(const receipt of codexContextReceipts(p.item,p.turnId))this.emit('contextObserved',{...receipt,sessionId:p.threadId,address:endpoint});
    }
  }
                                     
  private threadOperation<T>(peer:Peer,endpoint:Endpoint,work:()=>Promise<T>):Promise<T>{
    const key=endpoint.address+'|'+peer.sessionId;
    const next=(this.threadOperations.get(key)??Promise.resolve()).catch(()=>{}).then(work).finally(()=>{if(this.threadOperations.get(key)===next)this.threadOperations.delete(key);});
    this.threadOperations.set(key,next);return next;
  }
  async observe(peer:Peer,endpoint:Endpoint):Promise<void>{
    this.requireMember(peer.id);
    if(endpoint.configHome)this.configHomes.set(endpoint.address,endpoint.configHome);
    const rpc=await this.connect(endpoint.address),revision=this.nativeStateRevision;
    let result:any;
    try{result=await rpc.request('thread/read',{threadId:peer.sessionId,includeTurns:false});}
    catch(error){
      if(peer.kind!=='subagent'||String((error as {code?:unknown}).code)!=='-32600'||describeError(error)!=='thread not loaded: '+peer.sessionId)throw error;
      this.emit('state',peer.sessionId,'offline',endpoint.address);return;
    }
    this.requireMember(peer.id);
    if(result.thread?.id!==peer.sessionId)throw new BridgeError('session_changed','观察返回的线程与目标不符。');
    this.record(result.thread,endpoint.address,undefined,peer.id,revision);
  }
  async observeActive(peer:Peer,endpoint:Endpoint):Promise<void>{
    await this.threadOperation(peer,endpoint,async()=>{
      this.requireMember(peer.id);
      const rpc=await this.connect(endpoint.address),revision=this.nativeStateRevision;
      const result=await rpc.request('thread/read',{threadId:peer.sessionId,includeTurns:false});
      if(result.thread?.id!==peer.sessionId)throw new BridgeError('session_changed','运行中观察返回的线程与目标不符。');
      this.record(result.thread,endpoint.address,undefined,peer.id,revision);
      const native=this.nativeStates.get(endpoint.address+'|'+peer.sessionId);
      if(!codexUserWindow(peer)||codexSubagent(result.thread)||result.thread.status?.type!=='active'||native&&native.revision>revision&&!['busy','needsHuman'].includes(native.state))return;
      await this.attachThread(peer,endpoint);
    });
  }
  async attach(peer:Peer,endpoint:Endpoint,options:{verify?:boolean}={}):Promise<RpcClient>{
    return this.threadOperation(peer,endpoint,()=>this.attachThread(peer,endpoint,options));
  }
  private async attachThread(peer:Peer,endpoint:Endpoint,options:{verify?:boolean}={}):Promise<RpcClient>{
    this.requireMember(peer.id);
    if(endpoint.configHome)this.configHomes.set(endpoint.address,endpoint.configHome);
    const key=endpoint.address+'|'+peer.sessionId;
    const pending=this.attaching.get(key);if(pending)return pending;
    const work=(async()=>{
      const rpc=await this.connect(endpoint.address);
      this.requireMember(peer.id);
      if(this.attached.has(key)&&!options.verify){
        if(!['offline','unknown'].includes(peer.state))return rpc;
                                              
        const revision=this.nativeStateRevision,current=await rpc.request('thread/read',{threadId:peer.sessionId,includeTurns:false});
        this.requireMember(peer.id);this.record(current.thread,endpoint.address,undefined,peer.id,revision);
        if(current.thread?.status?.type!=='notLoaded')return rpc;
      }
      this.invalidated.delete(key);
      let result:any,subscribed=true,revision=this.nativeStateRevision;
      try{
        const runtime=runtimeFor(this.home,{endpoint:endpoint.address})?.value;
        let live:any;
        if(peer.owner==='nxbridge'&&runtime?.kind==='owned'&&runtime.peerId===peer.id)live=(await rpc.request('thread/read',{threadId:peer.sessionId,includeTurns:false})).thread;
        if(peer.owner==='nxbridge'&&runtime?.kind==='owned'&&runtime.peerId===peer.id&&(live?.status?.type==='notLoaded'||runtime.sessionVerification)){
          const original=runtime.sessionVerification?.profile??await readSessionProfile(live?.path??sessionFile(endpoint.configHome??this.configHomes.get(endpoint.address)??'',peer.sessionId!),peer.sessionId!);
          runtime.sessionVerification??={sessionId:peer.sessionId!,profile:original};saveManagedRuntime(this.home,runtime);
          this.emit('sessionVerifying',{memberId:peer.id,sessionId:peer.sessionId,runtimeId:runtime.id,endpoint:endpoint.address});
          this.verifying.add(key);
          try{
            revision=this.nativeStateRevision;
            const restored=live?.status?.type==='notLoaded'?await resumeSession(rpc,peer.sessionId!,{profile:original,file:original.file,home:endpoint.configHome??this.configHomes.get(endpoint.address),cwd:peer.cwd}):await verifyResumedSession(rpc,peer.sessionId!,original);
            delete runtime.sessionVerification;saveManagedRuntime(this.home,runtime);
            result=restored.resumed;this.emit('sessionPolicy',{memberId:peer.id,sessionId:peer.sessionId,runtimeId:runtime.id,policy:restored.policy});
          }catch(error){this.emit('sessionVerificationFailed',{memberId:peer.id,sessionId:peer.sessionId,runtimeId:runtime.id,error:{code:error instanceof BridgeError?error.code:'policy_verification_failed',message:describeError(error)}});throw error;}finally{this.verifying.delete(key);}
        }else{revision=this.nativeStateRevision;result=await rpc.request('thread/resume',{threadId:peer.sessionId,excludeTurns:true});}
      }
      catch(error){
                                                         
                                           
        if(!(error instanceof Error)||!['no rollout found','list_turns is not supported yet'].some(reason=>error.message.includes(reason)))throw error;
        let cursor:string|undefined,loaded=false;
        do{this.requireMember(peer.id);const page=await rpc.request('thread/loaded/list',{limit:100,...(cursor?{cursor}:{})});loaded=(page.data??[]).some((id:any)=>(typeof id==='string'?id:id.id)===peer.sessionId);cursor=page.nextCursor??undefined;}while(cursor&&!loaded);
        if(!loaded)throw error;
        this.requireMember(peer.id);
        revision=this.nativeStateRevision;result=await rpc.request('thread/read',{threadId:peer.sessionId,includeTurns:false});
        subscribed=false;
      }
      const permission=codexPermission(result);if(permission!=='unknown')this.emit('permission',peer.sessionId,permission,endpoint.address);
      if(!this.invalidated.has(key)&&!rpc.closed){
        this.record(result.thread,endpoint.address,result,peer.id,revision);
                                                  
        if(subscribed&&result.thread?.status?.type!=='notLoaded'){this.attached.add(key);this.subscriptionOwners.set(key,{peer:{...peer},endpoint:{...endpoint}});}
      }
      return rpc;
    })();
    this.attaching.set(key,work);try{return await work;}finally{if(this.attaching.get(key)===work)this.attaching.delete(key);}
  }
  async wake(peer:Peer,endpoint:Endpoint,signal?:AbortSignal,beforeSubmit?:()=>Promise<boolean>,message=WAKE_NOTICE):Promise<void>{
    let submitted=false;
    await deliveryStep(()=>this.threadOperation(peer,endpoint,async()=>{
      if(signal?.aborted)return;
      let rpc:RpcClient;
      try{rpc=await this.attachThread(peer,endpoint);}catch(error){if(error instanceof BridgeError&&error.code.startsWith('codex_identity_'))throw error;throw new DeliveryError('attach_failed',describeError(error));}
      if(signal?.aborted||beforeSubmit&&!await beforeSubmit()||signal?.aborted)return;
      this.requireMember(peer.id);submitted=true;
      await rpc.request('turn/start',{threadId:peer.sessionId,input:[{type:'text',text:message}]},{mutation:true});
      if(!this.attached.has(endpoint.address+'|'+peer.sessionId)){
        try{await this.attachThread(peer,endpoint);}catch(error){this.emit('diagnostic','唤醒已提交，后续线程订阅需要重连；正文仍等待正常取件。');}
      }
    }),signal,()=>submitted);
  }
  async reconcile(peer:Peer,endpoint:Endpoint,options:{since?:number}={}):Promise<CodexContextReceipt[]>{
    this.requireMember(peer.id);
    const rpc=await this.connect(endpoint.address);
    this.requireMember(peer.id);
    const thread=await readCodexThread(rpc,peer.sessionId!);
    const receipts:CodexContextReceipt[]=[];
    if(localCodexEndpoint(this.home,endpoint.address)){const history=await readCodexHistory(thread.path,peer.sessionId!,options.since===undefined?{tail:true}:{since:options.since});this.emit('historyCompatibility',{sessionId:peer.sessionId,address:endpoint.address,status:history.status,reason:history.reason});receipts.push(...history.receipts);}
    else for(const entry of (await readCodexItems(rpc,peer.sessionId!)).items){const item=entry.item??entry;receipts.push(...codexContextReceipts(item,entry.turnId??thread.turns?.at(-1)?.id));}
    return receipts;
  }
  async injectionState(peer:Peer,endpoint:Endpoint,options:{cursor?:HistoryCursor;tail?:boolean;since?:number}={}){
    this.requireMember(peer.id);
    const rpc=codexUserWindow(peer)?await this.connect(endpoint.address):await this.attach(peer,endpoint);this.requireMember(peer.id);
    const thread=await readCodexThread(rpc,peer.sessionId!);
    const history:HistoryEvidence=localCodexEndpoint(this.home,endpoint.address)?await readCodexHistory(thread.path,peer.sessionId!,options):{status:'unavailable',receipts:[],calls:[],reason:'远程端点没有本机持久历史证明'};
    this.emit('historyCompatibility',{sessionId:peer.sessionId,address:endpoint.address,status:history.status,reason:history.reason});
    return{thread,history};
  }
  async inject(peer:Peer,endpoint:Endpoint,callId:string,output:string):Promise<void>{
    return this.threadOperation(peer,endpoint,async()=>{
      const rpc=await this.attachThread(peer,endpoint);
      this.requireMember(peer.id);
      await rpc.request('thread/inject_items',{threadId:peer.sessionId,items:[{type:'function_call',call_id:callId,name:'receive_messages',namespace:'claude',arguments:'{}'},{type:'function_call_output',call_id:callId,name:'receive_messages',namespace:'claude',output}]},{mutation:true});
    });
  }
  async continueInjected(peer:Peer,endpoint:Endpoint):Promise<string>{
    return this.threadOperation(peer,endpoint,()=>this.continueThread(peer,endpoint));
  }
  private async continueThread(peer:Peer,endpoint:Endpoint):Promise<string>{
    this.requireMember(peer.id);
    const rpc=await this.attachThread(peer,endpoint);this.requireMember(peer.id);
    const result=await rpc.request('turn/start',{threadId:peer.sessionId,input:[]},{mutation:true});
                                             
    if(!this.attached.has(endpoint.address+'|'+peer.sessionId))try{await this.attachThread(peer,endpoint);}catch(error){this.emit('diagnostic','续跑已提交，线程通知订阅需要重连：'+describeError(error));}
    return result.turn.id;
  }
  async ensureEndpoint(cwd=process.cwd(),peerId?:string,requesterSession?:string,sessionId?:string,configHome?:string,beforeLaunch?:()=>void|Promise<void>,affinity?:Pick<ManagedRuntime,'executable'|'profileId'>):Promise<string>{
    this.requireMember(peerId);
    const key=peerId??'foreground:'+path.resolve(configHome??this.config.codexHome??''),restarting=this.restarting.get(key);if(restarting)return(await restarting).endpoint;
    if(this.config.codexEndpoint){await this.connect(this.config.codexEndpoint);return this.config.codexEndpoint;}
    const pending=this.starting.get(key);if(pending){if(peerId)return pending;await pending;return this.ensureEndpoint(cwd,peerId,requesterSession,sessionId,configHome,beforeLaunch,affinity);}
    const work=this.ensureEndpointInner(cwd,peerId,sessionId,configHome,requesterSession,beforeLaunch,affinity).finally(()=>{this.starting.delete(key);});this.starting.set(key,work);return work;
  }
  async resumeForeground(endpoint:string,configHome:string):Promise<void>{
    this.configHomes.set(endpoint,configHome);await this.connect(endpoint);await this.discoverLoaded(endpoint);
  }
  async restart(peer:Peer,endpoint:Endpoint,guard:()=>void,options:{identityMigration?:boolean;verificationRecovery?:boolean;requesterSession?:string;verifyDelivery?:(thread:CodexThread)=>Promise<void>}={}):Promise<CodexRestartResult>{
    this.requireMember(peer.id);
    if(this.restarting.has(peer.id)||this.starting.has(peer.id))throw new BridgeError('restart_in_progress','目标托管运行时正在启动或重启，请稍后重试。');
    const original=runtimeFor(this.home,{endpoint:endpoint.address})?.value,interrupted=options.verificationRecovery?original:undefined;
    if(options.verificationRecovery&&(peer.owner!=='nxbridge'||!interrupted?.dedicated||interrupted.peerId!==peer.id||interrupted.sessionVerification?.sessionId!==peer.sessionId))throw new BridgeError('unowned_runtime','缺少待核验原线程的独占运行时证明，未停止任何进程。');
    const revision=this.nativeStateRevision;
    const work=restartCodexRuntime({peer,endpoint,home:this.home,connect:address=>this.connect(address),...(interrupted?.sessionVerification?{profile:interrupted.sessionVerification.profile}:{}),verifyDelivery:options.verifyDelivery,onStopped:()=>this.emit('runtimeStopped',endpoint),...(options.identityMigration?{inspect:(address:string)=>connectAppServer(address,this.config,this.tokens.get(address),this.home,{readOnly:true}),observeThread:(thread:CodexThread)=>{const state=threadRegistration(thread,endpoint.address)?.state;if(state)this.emit('state',thread.id,state,endpoint.address);}}:{}),start:()=>this.ensureEndpointInner(peer.cwd,peer.id,peer.sessionId??undefined,endpoint.configHome,options.requesterSession,undefined,original),guard,onVerifying:(runtimeId,address)=>this.emit('sessionVerifying',{memberId:peer.id,sessionId:peer.sessionId,runtimeId,endpoint:address}),onPolicy:(policy,runtimeId)=>this.emit('sessionPolicy',{memberId:peer.id,sessionId:peer.sessionId,runtimeId,policy})});
    this.restarting.set(peer.id,work);
    try{
      const result=await work;
      try{
        this.record(result.resumed.thread,result.endpoint,result.resumed,peer.id,revision);
        this.attached.add(result.endpoint+'|'+peer.sessionId);
        const permission=codexPermission(result.resumed);if(permission!=='unknown')this.emit('permission',peer.sessionId,permission,result.endpoint);
      }catch(error){throw new BridgeError('restart_incomplete','原 ID 已恢复，但宿主状态登记失败；已暂停目标自动投递。原因：'+describeError(error));}
      return result;
    }catch(error){const runtime=runtimeFor(this.home,{peerId:peer.id})?.value;if(runtime?.sessionVerification)this.emit('sessionVerificationFailed',{memberId:peer.id,sessionId:peer.sessionId,runtimeId:runtime.id,error:{code:error instanceof BridgeError?error.code:'policy_verification_failed',message:describeError(error)}});throw error;}finally{this.restarting.delete(peer.id);}
  }
  private async declareRuntimeNative(saved:ManagedRuntime,wrapper?:OwnedProcessRecord){
    if(!wrapper){
      const records=ownedProcesses(this.home).records.filter(value=>value.proof.launchId===saved.id||saved.kind==='legacy'&&value.proof.launchId===saved.endpoint);
      const containers=records.filter(value=>value.windowsJob||value.posixGroup);
      if(containers.length>1)throw new BridgeError('process_launch_unverified','同次启动有多个容器，未声明原生宿主。');
      wrapper=containers[0]??records.find(value=>value.identity.pid===saved.wrapperPid&&value.identity.startedAt===saved.wrapperProcStart);
    }
    const expected=saved.pid&&saved.procStart?{pid:saved.pid,startedAt:saved.procStart}:wrapper?.native;
    const native=expected?await processIdentity(expected.pid):wrapper?await nativeDescendant(wrapper.identity.pid,'codex',saved.createdAt,saved.endpoint,wrapper):undefined;
    if(!native)return;
    if(expected&&native.startedAt!==expected.startedAt)throw new BridgeError('runtime_endpoint_unverified','原后台进程代次已改变，未恢复凭证。');
    const key=saved.id+':'+native.pid+':'+native.startedAt;
    if(wrapper&&!this.declaredNatives.has(key)){await declareOwnedNative(wrapper,native);this.declaredNatives.add(key);}
    if(saved.pid!==native.pid||saved.procStart!==native.startedAt){saved.pid=native.pid;saved.procStart=native.startedAt;if(saved.kind==='owned')saveManagedRuntime(this.home,saved);}
    return native;
  }
  private async ensureEndpointInner(cwd=process.cwd(),peerId?:string,sessionId?:string,configHome?:string,requesterSession?:string,beforeLaunch?:()=>void|Promise<void>,affinity?:Pick<ManagedRuntime,'executable'|'profileId'>):Promise<string>{
    this.requireMember(peerId);
    let records=managedRuntimes(this.home).filter(r=>peerId?r.value.peerId===peerId:!r.value.peerId&&(!configHome||r.value.configHome&&path.resolve(r.value.configHome)===path.resolve(configHome)));
                                        
    for(const record of records)if(await managedRuntimeNativeState(this.home,record.value)==='dead'&&record.value.state!=='failed'){
      this.clients.get(record.value.endpoint)?.close();record.value.state='failed';if(record.value.kind==='owned')saveManagedRuntime(this.home,record.value);
    }
    if(!peerId){
      for(const record of records.filter(r=>r.value.state==='failed'&&r.value.threadUnloadDelaySecs!==0))if(await managedRuntimeNativeState(this.home,record.value)!=='dead')throw new BridgeError('runtime_launch_unconfirmed','旧后台的启动尚未核验结束，保留启动预约，不再创建第二个进程。');
                                                    
      const loaded:RuntimeRecord[]=[];
      if(sessionId&&/^[a-f0-9-]{36}$/i.test(sessionId))for(const record of records.filter(r=>r.value.state!=='failed'&&r.value.threadUnloadDelaySecs!==0)){
        if(await managedRuntimeNativeState(this.home,record.value)==='dead')continue;
        try{
          await this.declareRuntimeNative(record.value);
          const rpc=await this.connect(record.value.endpoint);let cursor:string|undefined;
          do{const page=await rpc.request('thread/loaded/list',{limit:100,...(cursor?{cursor}:{})});if((page.data??[]).some((id:any)=>(typeof id==='string'?id:id.id)===sessionId)){loaded.push(record);break;}cursor=page.nextCursor??undefined;}while(cursor);
        }catch(error){this.emit('diagnostic','旧后台的会话归属尚未确认，新窗口改用当前后台：'+describeError(error));}
      }
      records=loaded.length?loaded:records.filter(r=>r.value.threadUnloadDelaySecs===0);
    }
    const usable=records.filter(r=>r.value.state!=='failed');
    if(usable.length>1)throw new BridgeError('runtime_ambiguous','成员有多个尚未核验结束的运行时，未重复启动。');
    const previous=usable[0]??records.sort((a,b)=>b.value.createdAt-a.value.createdAt)[0];
    if(previous){
      const saved=previous.value;
      if(saved.failureCode==='bootstrap_required')requireBackgroundRetry(this.home);
      if(saved.configHome)this.configHomes.set(saved.endpoint,saved.configHome);
      const state=await managedRuntimeNativeState(this.home,saved);
      if(state==='dead'){
        this.clients.get(saved.endpoint)?.close();
        if(saved.state!=='failed'){saved.state='failed';if(saved.kind==='owned')saveManagedRuntime(this.home,saved);}
        if(await managedRuntimeState(this.home,saved)==='dead'){await removeOwnedSocket(this.home,saved.endpoint);removeManagedRuntime(previous);}
      }
      else{
        const failed=saved.state==='failed';
        try{
                                              
          const native=await this.declareRuntimeNative(saved);
          if(failed&&saved.authenticatedLoopback){
            if(!native)throw new BridgeError('runtime_endpoint_unverified','原后台尚无可核验的原生代次，未恢复凭证。');
            await verifyDedicatedCodex(saved.endpoint,native);this.requireMember(peerId);
            saved.state='starting';saved.dedicated=true;saveManagedRuntime(this.home,saved);
          }
          await this.connect(saved.endpoint);
          if(saved.state!=='ready'){saved.state='ready';delete saved.error;delete saved.failureCode;if(saved.kind==='owned')saveManagedRuntime(this.home,saved);}
          return saved.endpoint;
        }catch(error){
          const containers=ownedProcesses(this.home).records.filter(record=>(record.windowsJob||record.posixGroup)&&(record.proof.launchId===saved.id||saved.kind==='legacy'&&record.proof.launchId===saved.endpoint));
          const undeclared=containers.length===1?containers[0]:undefined;
          if(!saved.pid&&!saved.procStart&&undeclared?.posixGroup&&!undeclared.native&&undeclared.parent&&await ownedProcessState(undeclared.parent)==='dead'){
                                                    
            await releaseOwnedProcess(undeclared);
            removeManagedRuntime(previous);await removeOwnedSocket(this.home,saved.endpoint);
          }else{
            if(failed&&saved.state==='starting'){saved.state='failed';saved.error=describeError(error);saveManagedRuntime(this.home,saved);}
            throw new BridgeError('runtime_launch_unconfirmed',`原运行时${state==='alive'?'仍存活但连接失败':'进程代次尚无法核验且连接失败'}，保留启动预约，不再创建第二个进程。原因：${describeError(error)}`);
          }
        }
      }
    }
    const launch=await prepareOwnedLaunch(await selectSessionLaunch('codex',this.config,{home:this.home,cwd,sessionId,configHome:configHome??previous?.value.configHome,requesterSession,executable:affinity?.executable??previous?.value.executable,profileId:affinity?.profileId??previous?.value.profileId}));
    if(peerId&&sessionId&&restoreState({host:'codex',sessionId,owner:'nxbridge'} as Peer,launch.configHome)==='gone')throw new BridgeError('session_not_found','原配置目录中没有该 Codex 会话，请先恢复原会话文件或在原生窗口恢复。');
    const capabilities=await requireDedicatedCodex(launch),authenticatedLoopback=['linux','win32'].includes(process.platform)&&capabilities.authenticatedWebsocket;
    if(peerId&&sessionId)await requireRestoreBootstrap(launch);
    this.requireMember(peerId);
    for(const note of launch.notes)this.emit('diagnostic',note);
                                                      
    const runtimeId=launch.env.NXBRIDGE_OWNED_LAUNCH!.slice('codex:'.length),directory=await socketDirectory(this.home),endpoint=authenticatedLoopback?await new Promise<string>((resolve,reject)=>{const server=net.createServer();server.once('error',reject);server.listen(0,'127.0.0.1',()=>{const port=(server.address() as net.AddressInfo).port;server.close(error=>error?reject(error):resolve('ws://127.0.0.1:'+port));});}):'unix://'+path.join(directory,'cx-'+createHash('sha256').update(runtimeId).digest('hex').slice(0,16)+'.sock');
    await beforeLaunch?.();
    const saved:ManagedRuntime={id:runtimeId,...(peerId?{peerId}:{}),owner:managedMarker(this.home),kind:'owned',state:'starting',endpoint,configHome:launch.configHome,launchMethod:launch.method,createdAt:Date.now(),bootstrapRevision:backgroundState(this.home)?.revision,executable:launch.executable.command,version:launch.version??launch.profile?.version,profileId:launch.profile?.id,sessionId,threadUnloadDelaySecs:0,...(authenticatedLoopback?{authenticatedLoopback:true}:{})};
    saveManagedRuntime(this.home,saved);
    const logfile=path.join(this.home,'run','codex-'+runtimeId+'.log'),retention={...DEFAULT_RETENTION,...this.config.retention};
    let failure:unknown,spawnAttempted=false,wrapper:OwnedProcessRecord|undefined,child:ReturnType<typeof spawnSelectedHost>|undefined;
    try{
    const authentication=authenticatedLoopback?['--ws-auth','capability-token','--ws-token-file',createRuntimeToken(this.home,saved)]:[];
    const bootstrap=peerId&&sessionId?CODEX_RESTORE_BOOTSTRAP:[];
                                         
    const nativeArgs=['--no-daemon',...bootstrap,'-c','check_for_update_on_startup=false','-c','thread_unload_delay_secs=0','app-server','--listen',endpoint,...authentication];
    rotateLog(logfile,retention.logMaxBytes,retention.logBackups);
    await prepareProcessRegistry(this.home);
    this.requireMember(peerId);
    launch.env.RUST_LOG??='error';
    if(process.platform==='win32'){
      spawnAttempted=true;
      wrapper=await launchIndependentWindows({home:this.home,executable:launch.executable.command,args:[...launch.executable.prefix,...nativeArgs],cwd:launch.cwd,env:launch.env,logfile,role:'codex-runtime',launchId:runtimeId,configHome:launch.configHome,...(peerId?{peerId}:{})});
    }else{
      const fd=openSync(logfile,'a',0o600);
      try{child=spawnPosixSupervisor(launch.executable.command,[...launch.executable.prefix,...nativeArgs],{cwd:launch.cwd,env:launch.env,stdio:['ignore',fd,fd],waitForNative:true});spawnAttempted=true;}
      finally{closeSync(fd);}
      child.on('error',error=>{failure=error;});child.unref();
      wrapper=await rememberOwnedChild(this.home,child,'codex-runtime',{configHome:launch.configHome,posixGroup:true,...(peerId?{peerId}:{})},runtimeId);
    }
    if(wrapper){saved.wrapperPid=wrapper.identity.pid;saved.wrapperProcStart=wrapper.identity.startedAt;saveManagedRuntime(this.home,saved);}
    if(!wrapper)throw new BridgeError('runtime_launch_unconfirmed','未核验启动包装器身份，保留预约。');
    for(let i=0;i<60;i++){
      if(failure)throw failure;await delay(200);
      try{
                                         
        let identity=authenticatedLoopback?await this.declareRuntimeNative(saved,wrapper):undefined;
        await this.connect(endpoint);identity??=await this.declareRuntimeNative(saved,wrapper);
        if(!identity)throw new BridgeError('launch_owner_unverified','未确认本次启动的原生宿主。');
        let dedicated=false;try{await verifyDedicatedCodex(endpoint,identity);dedicated=true;}catch(error){this.emit('diagnostic','后台已连接，但独占性尚无法核验；仅允许非破坏性恢复：'+describeError(error));}
        launch.configHome=this.configHomes.get(endpoint)??launch.configHome;this.configHomes.set(endpoint,launch.configHome);
        Object.assign(saved,{state:'ready',pid:identity.pid,procStart:identity.startedAt,configHome:launch.configHome,dedicated});saveManagedRuntime(this.home,saved);recordHostLaunch(this.home,'codex-app-server',launch,identity.pid);return endpoint;
      }catch(error){
        if(error instanceof BridgeError&&['process_launch_unverified','shared_backend'].includes(error.code))throw error;
        const nativeExit=child?posixSupervisorExit(child):undefined;
        failure=child&&(child.exitCode!==null||child.signalCode!==null||nativeExit&&(nativeExit.code!==0||nativeExit.signal!==null))?error:undefined;
      }
    }
    throw new BridgeError('app_server_start_failed','App Server 启动超时，检查 '+logfile+'。');
    }catch(error){
      this.clients.get(endpoint)?.close();
      const records=ownedProcesses(this.home).records.filter(value=>value.proof.launchId===runtimeId),cleanupErrors:string[]=[];
      wrapper??=records.find(value=>value.role==='codex-runtime');
      if(wrapper&&!saved.wrapperPid){saved.wrapperPid=wrapper.identity.pid;saved.wrapperProcStart=wrapper.identity.startedAt;}
                                               
      for(const record of records.sort((a,b)=>Number(!!(b.windowsJob||b.posixGroup))-Number(!!(a.windowsJob||a.posixGroup))||b.createdAt-a.createdAt))try{await releaseOwnedProcess(record);}catch(cleanup){const note=describeError(cleanup);cleanupErrors.push(note);this.emit('diagnostic','App Server 启动失败后的回收未完成：'+note);}
      let childStopped=false;
      if(child&&!wrapper)try{
        if(child.exitCode===null&&child.signalCode===null)child.kill();
        const deadline=Date.now()+5000;while(child.exitCode===null&&child.signalCode===null&&Date.now()<deadline)await delay(25);
        childStopped=child.exitCode!==null||child.signalCode!==null;
        if(!childStopped)throw new BridgeError('process_stop_pending','本次创建的启动监督进程尚未退出。');
      }catch(cleanup){cleanupErrors.push(describeError(cleanup));}
      saved.state='failed';saved.error=describeError(error)+(cleanupErrors.length?'；启动清理未完成：'+cleanupErrors.join('；'):'');saved.failureCode=error instanceof BridgeError?error.code:undefined;
      saved.launchSettled=cleanupErrors.length===0&&(!spawnAttempted||records.length>0||childStopped||error instanceof BridgeError&&error.code==='bootstrap_required');saveManagedRuntime(this.home,saved);throw error;
    }
  }
  async create(peer:Peer,requesterSession?:string,beforeLaunch?:()=>void|Promise<void>,sourcePermission:PermissionClass='unknown',beforeCreate?:()=>void|Promise<void>):Promise<RegisterInput>{
    const endpoint=await this.ensureEndpoint(peer.cwd,peer.id,requesterSession,undefined,undefined,beforeLaunch),rpc=await this.connect(endpoint);
    const result=await startOwnedCodex(rpc,peer.cwd,sourcePermission,()=>{this.requireMember(peer.id);return beforeLaunch?.();},beforeCreate,this.modelProfile(peer)),thread=result.thread;
    try{await rpc.request('thread/name/set',{threadId:thread.id,name:peer.name},{mutation:true});}
    catch(error){await unloadFailedOwnedCodex(rpc,thread.id,error);throw error;}
    this.attached.add(endpoint+'|'+thread.id);
    const registration={...threadRegistration({...thread,name:peer.name},endpoint,result)!,permission:codexPermission(result)};registration.endpoint.configHome=this.configHomes.get(endpoint);const runtime=runtimeFor(this.home,{endpoint})?.value;if(runtime){recordManagedSessionLaunch(this.home,thread.id,thread.cwd,runtime);registration.endpoint.runtimeId=runtime.id;registration.endpoint.pid=runtime.pid??null;registration.endpoint.procStart=runtime.procStart??null;}return registration;
  }
                                       
  async setProfile(peer:Peer,endpoint:Endpoint,profile:import('../../types.js').ModelProfile,guard:()=>void):Promise<import('../../types.js').ModelProfile>{
    let submitted=false,accepted=false;
    return this.threadOperation(peer,endpoint,async()=>{
      guard();this.requireMember(peer.id);
      const runtime=runtimeFor(this.home,{endpoint:endpoint.address})?.value;
      if(peer.owner!=='nxbridge'||endpoint.daemon||runtime?.kind!=='owned'||runtime.peerId!==peer.id)throw new BridgeError('process_owned_by_user','模型切换只支持 nxbridge 自有后台运行时。');
      const rpc=await this.connect(endpoint.address),current=await rpc.request('thread/read',{threadId:peer.sessionId,includeTurns:false});guard();
      if(current.thread?.id!==peer.sessionId)throw new BridgeError('session_changed','模型切换前线程身份已改变。');
      if(!codexThreadIdle(current.thread))throw new BridgeError('session_busy','搭档仍在工作，模型选择将在安全空闲点应用。');
      submitted=true;await rpc.request('thread/settings/update',{threadId:peer.sessionId,...profile},{mutation:true});accepted=true;guard();
      const actual=await rpc.request('thread/read',{threadId:peer.sessionId,includeTurns:false});guard();
      if(actual.thread?.id!==peer.sessionId)throw new BridgeError('session_changed','模型切换返回了不同会话。');
      return{model:actual.thread.model,effort:actual.thread.reasoningEffort};
    }).catch(error=>{throw profileChangeFailure(error,submitted,accepted);});
  }
  async readProfile(peer:Peer,endpoint:Endpoint,guard:()=>void):Promise<import('../../types.js').ModelProfile>{
    return this.threadOperation(peer,endpoint,async()=>{
      guard();this.requireMember(peer.id);const runtime=runtimeFor(this.home,{endpoint:endpoint.address})?.value;
      if(endpoint.daemon||runtime?.kind!=='owned'||runtime.peerId!==peer.id)throw new BridgeError('process_owned_by_user','只能核对自有后台运行时的设置。');
      const rpc=await this.connect(endpoint.address),actual=await rpc.request('thread/read',{threadId:peer.sessionId,includeTurns:false});guard();
      if(actual.thread?.id!==peer.sessionId)throw new BridgeError('session_changed','设置回读返回了不同会话。');
      if(actual.thread.status?.type==='notLoaded')throw new BridgeError('profile_unverified','原会话尚未由已核验的恢复路径加载，设置等待回读。');
      return{model:actual.thread.model,effort:actual.thread.reasoningEffort};
    });
  }
                                                 
  async loadedRuntime(sessionId:string,configHome:string):Promise<ManagedRuntime|undefined>{
    const loaded:ManagedRuntime[]=[];
    for(const {value} of managedRuntimes(this.home)){
      if(value.state!=='ready'||!value.configHome||!sameDirectory(value.configHome,configHome)||!value.pid||!value.procStart)continue;
      if(await ownedProcessState({pid:value.pid,startedAt:value.procStart})!=='alive')continue;
      if(await this.sessionState({sessionId},{address:value.endpoint,configHome:value.configHome})==='alive')loaded.push(value);
    }
    if(loaded.length>1)throw new BridgeError('runtime_ambiguous','同一会话在多个自有后台中加载，请先在原窗口核对。');
    return loaded[0];
  }
  async sessionState(peer:Pick<Peer,'sessionId'>,endpoint:Pick<Endpoint,'address'|'configHome'>):Promise<'alive'|'dead'|'unknown'>{
    let rpc:RpcClient|undefined;
    try{rpc=await connectAppServer(endpoint.address,{...this.config,...(endpoint.configHome?{codexHome:endpoint.configHome}:{})},undefined,this.home,{readOnly:true});let cursor:string|undefined;
      for(let page=0;page<10;page++){const result=await rpc.request('thread/loaded/list',{limit:100,...(cursor?{cursor}:{})},{timeout:2000});if((result.data??[]).some((id:any)=>(typeof id==='string'?id:id.id)===peer.sessionId))return'alive';cursor=result.nextCursor??undefined;if(!cursor)return'dead';}
    }catch{                      }finally{rpc?.close();}return'unknown';
  }
                                          
  async inspectThread(runtime:ManagedRuntime,sessionId:string):Promise<CodexThread|undefined>{
    this.requireMember(runtime.peerId);
    if(runtime.state!=='ready'||!runtime.pid||!runtime.procStart||!localCodexEndpoint(this.home,runtime.endpoint))throw new BridgeError('managed_proof_unverified','自有运行时的原生代次尚未确认存活。');
    const key=JSON.stringify([runtime.id,runtime.endpoint,runtime.pid,runtime.procStart,runtime.configHome,sessionId]),known=this.verifiedLineage.get(key);if(known)return known;
                                          
    if(runtime.endpoint.startsWith('unix://')&&await ownedProcessState({pid:runtime.pid,startedAt:runtime.procStart})!=='alive')throw new BridgeError('managed_proof_unverified','自有运行时的原生代次尚未确认存活。');
    const rpc=await connectAppServer(runtime.endpoint,this.config,undefined,this.home,{readOnly:true});
    try{const {thread}=await rpc.request('thread/read',{threadId:sessionId,includeTurns:false},{timeout:2000});if(thread?.id!==sessionId)return;
                                       
      if(codexSubagent(thread)){if(this.verifiedLineage.size>=256)this.verifiedLineage.delete(this.verifiedLineage.keys().next().value!);this.verifiedLineage.set(key,thread);}return thread;
    }
    finally{rpc.close();}
  }
  async release(peer:Peer,endpoint:Endpoint):Promise<void>{
    return this.threadOperation(peer,endpoint,()=>this.releaseThread(peer,endpoint));
  }
  hasSubscription(peer:Peer,endpoint:Endpoint):boolean{return this.attached.has(endpoint.address+'|'+peer.sessionId);}
  userSubscriptions():{peer:Peer;endpoint:Endpoint}[]{return[...this.subscriptionOwners].filter(([key,value])=>this.attached.has(key)&&codexUserWindow(value.peer)).map(([,value])=>value);}
  async releaseIdle(peer:Peer,endpoint:Endpoint,guard:()=>boolean,closing=false):Promise<'retained'|'released'|'unloaded'|'idle'>{
    const key=endpoint.address+'|'+peer.sessionId;
    if(this.threadOperations.has(key))return'retained';
    return this.threadOperation(peer,endpoint,async()=>{
      const rpc=this.clients.get(endpoint.address);
      if(!codexUserWindow(peer)||!rpc||rpc.closed||!guard())return'retained';
      const revision=this.nativeStateRevision;let result:any;
      try{result=await rpc.request('thread/read',{threadId:peer.sessionId,includeTurns:false},{timeout:2000});}
      catch(error){if(String((error as {code?:unknown}).code)!=='-32600'||!describeError(error).includes('thread not loaded: '+peer.sessionId))throw error;this.attached.delete(key);this.subscriptionOwners.delete(key);return guard()?'unloaded':'retained';}
      if(!guard()||result.thread?.id!==peer.sessionId)return'retained';
      const status=result.thread.status,native=this.nativeStates.get(key);
      if(native&&native.revision>revision&&!['ready','offline',...(closing?['needsHuman']:[])].includes(native.state))return'retained';
      if(status?.type==='notLoaded'){this.attached.delete(key);this.subscriptionOwners.delete(key);return'unloaded';}
      const waiting=status?.activeFlags?.some((flag:string)=>/approval|input/i.test(flag));
      if(!['idle','systemError'].includes(status?.type)&&!(closing&&waiting)||status.activeFlags?.length&&!(closing&&waiting))return'retained';
      if(!this.attached.has(key))return'idle';
      await rpc.request('thread/unsubscribe',{threadId:peer.sessionId});this.attached.delete(key);this.subscriptionOwners.delete(key);return'released';
    });
  }
  private async releaseThread(peer:Peer,endpoint:Endpoint):Promise<void>{
                                                        
    const native=endpoint.native??endpoint;
    if(native.pid&&native.procStart&&await ownedProcessState({pid:native.pid,startedAt:native.procStart})==='dead'){
      this.attached.delete(endpoint.address+'|'+peer.sessionId);this.subscriptionOwners.delete(endpoint.address+'|'+peer.sessionId);return;
    }
    const rpc=await this.connect(endpoint.address);
    try{await rpc.request('thread/unsubscribe',{threadId:peer.sessionId});}
    catch(error){
      let cursor:string|undefined;
      do{const page=await rpc.request('thread/loaded/list',{limit:100,...(cursor?{cursor}:{})});if((page.data??[]).some((value:any)=>(typeof value==='string'?value:value.id)===peer.sessionId))throw error;cursor=page.nextCursor??undefined;}while(cursor);
    }
    this.attached.delete(endpoint.address+'|'+peer.sessionId);
    this.subscriptionOwners.delete(endpoint.address+'|'+peer.sessionId);
  }
  async releaseRuntime(protectedEndpoints:Endpoint[]=[],address?:string,retired:Peer[]=[]):Promise<string|undefined>{
    const notes:string[]=[];
    for(const record of managedRuntimes(this.home).filter(r=>!address||r.value.endpoint===address)){const note=await this.releaseOneRuntime(record,protectedEndpoints,retired);if(note)notes.push(note);}
    return notes.length?notes.join('；'):undefined;
  }
  private async releaseOneRuntime(record:RuntimeRecord,protectedEndpoints:Endpoint[],retired:Peer[]):Promise<string|undefined>{
    const saved=record.value;
    if(protectedEndpoints.some(endpoint=>endpoint.active&&endpoint.address===saved.endpoint))return'托管 App Server 仍被用户窗口引用，保留运行时及归属记录。';
    const owned=ownedProcesses(this.home).records.filter(value=>value.proof.launchId===saved.id||value.proof.launchId===saved.endpoint||value.role==='codex-runtime'&&value.identity.pid===saved.pid);
    if(owned.some(value=>value.releasedToUser))return'托管 App Server 已交给用户窗口，保留运行时及归属记录。';
    if(await managedRuntimeState(this.home,saved)==='dead'){await removeOwnedSocket(this.home,saved.endpoint);for(const value of owned)if(await ownedRecordState(value)==='dead')await retireDeadOwnedProcess(value);removeManagedRuntime(record);this.emit('runtimeStopped',{address:saved.endpoint,pid:saved.pid??null,procStart:saved.procStart??null,runtimeId:saved.id});return;}
    const nativeState=saved.pid&&saved.procStart?await ownedProcessState({pid:saved.pid,startedAt:saved.procStart}):undefined;
    if(nativeState==='unknown')return'无法核验托管 App Server 的进程代次，保留进程。';
    if(nativeState==='alive'){
      try{await verifyDedicatedCodex(saved.endpoint,await processIdentity(saved.pid!));}catch(error){return'无法核验独占原生后台，保留进程：'+describeError(error);}
                                                     
      const allowed=new Set(retired.filter(peer=>saved.kind==='owned'&&peer.id===saved.peerId&&peer.owner==='nxbridge'&&peer.host==='codex').map(peer=>peer.sessionId).filter(Boolean));
      const rpc=await this.connect(saved.endpoint);
      if(allowed.size===1){try{await assertCodexRuntimeScope(rpc,[...allowed][0]!);}catch(error){return'托管 App Server 的线程范围或未完成工作尚未核验，保留运行时：'+describeError(error);}}
      else{const loaded=await rpc.request('thread/loaded/list',{limit:allowed.size+1});if(loaded.nextCursor||(loaded.data??[]).some((value:any)=>!allowed.has(typeof value==='string'?value:value.id)))return'托管 App Server 仍有已加载线程（可能处于宿主卸载宽限期），保留运行时。';}
      rpc.close();
    }
    else if(saved.dedicated!==true)return'原生后台尚无独占性证明，保留仍存活的启动包装器及其后代。';
    if(!owned.length)return'托管运行时的启动归属尚未核验，保留预约和归属记录。';
    for(const value of owned.sort((a,b)=>Number(!!(b.windowsJob||b.posixGroup))-Number(!!(a.windowsJob||a.posixGroup))||b.createdAt-a.createdAt))await releaseOwnedProcess(value);
                                        
    saved.launchSettled=true;if(saved.kind==='owned')saveManagedRuntime(this.home,saved);
    if(await managedRuntimeState(this.home,saved)!=='dead')return'托管运行时仍有无法核验的进程，保留预约和归属记录。';
    await removeOwnedSocket(this.home,saved.endpoint);
    removeManagedRuntime(record);this.emit('runtimeStopped',{address:saved.endpoint,pid:saved.pid??null,procStart:saved.procStart??null,runtimeId:saved.id});
  }
  close():void {for(const rpc of this.clients.values())rpc.close();this.clients.clear();this.nativeStates.clear();this.subscriptionOwners.clear();}
}

export function codexPermission(result:any):Peer['permission']{
  return classifyCodexPermission(codexRuntimeEvidence(result));
}
