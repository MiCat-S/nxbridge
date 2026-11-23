import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import {connectAppServer,type CodexThread,type CodexContextReceipt} from './adapter.js';
import { readCodexHistory, type HistoryCursor } from './codex-history.js';
import { readCodexThread } from './codex-evidence.js';
import { closeHostedWindow } from '../../broker/recovery/session-hosting.js';
import { codexIsManagedDaemon, liveProcess, probeProcesses, processIdentity } from '../../process/process.js';
import { normalizedHome } from '../../integration/hooks/session-bindings.js';
import {codexHome} from '../../shared/local-paths.js';
import {runCli} from '../../process/host-command.js';
import {BridgeError,DeliveryError,describeError} from '../../shared/errors.js';
import {HEALTH_WAKE_NOTICE,type BridgeConfig,type Peer,type RegisterInput,type CodexPermissionEvidence} from '../../types.js';
import { daemonContextChanged, daemonWakeAuthorized, observeDaemonContext } from './daemon-wake.js';
import { classifyCodexPermission, persistedCodexPermission, observeCodexPermission } from './codex-permission.js';
import type { RpcClient } from '../../ipc/rpc.js';
import type { CodexTurnOriginProvider } from './codex-turn-origin.js';
import type { Store } from '../../storage/store.js';
import type { Endpoint, PermissionClass } from '../../types.js';
import { codexParent, codexSubagent } from './codex-lineage.js';
import { captureDaemonLaunch } from '../launch-profiles.js';
import { selectHostLaunch } from '../host-launch.js';

export interface DaemonDomain {configHome:string;pid:number;procStart:string;address:string}
type Connection=DaemonDomain&{rpc:RpcClient;at:number;revision:number;threads:CodexThread[]};
const parent=codexParent;
const interactive=(thread:CodexThread)=>!thread.ephemeral&&!codexSubagent(thread)&&['cli','vscode'].includes(thread.source);
const sameHome=(endpoint:Endpoint,home:string)=>!!endpoint.daemon&&!!endpoint.configHome&&normalizedHome(endpoint.configHome)===normalizedHome(home);
export function daemonPermission(evidence:CodexPermissionEvidence):PermissionClass{
  return classifyCodexPermission(evidence);
}

                                                
export function daemonRegistration(thread:CodexThread,domain:DaemonDomain,rootSessionId?:string):RegisterInput{
  const flags=thread.status?.activeFlags??[],parentId=parent(thread);
  return{host:'codex',sessionId:thread.id,cwd:thread.cwd,name:thread.name??'Codex',kind:codexSubagent(thread)?'subagent':thread.forkedFromId?'fork':'root',...(parentId?{parentId}:{}),
    model:thread.model,effort:thread.reasoningEffort,state:thread.status?.type==='notLoaded'?'offline':flags.some(value=>/approval|input/i.test(value))?'needsHuman':thread.status?.type==='active'?'busy':'ready',
    endpoint:{mode:'embedded',address:domain.address,epoch:JSON.stringify(['daemon',domain.configHome,domain.pid,domain.procStart,thread.id]),pid:domain.pid,procStart:domain.procStart,configHome:domain.configHome,processKind:'app-server',...(thread.path?{nativeSession:{transcriptPath:thread.path}}:{}),
      daemon:{address:domain.address,...(rootSessionId?{rootSessionId}:{}),...(thread.forkedFromId?{forkedFromId:thread.forkedFromId}:{})}}};
}

export class CodexDaemons {
  turnOrigin?:CodexTurnOriginProvider;
  private clients=new Map<string,Connection>();
  private openings=new Map<string,Promise<Connection|undefined>>();
  private scans=new Map<string,{work:Promise<Connection|undefined>;fresh:boolean}>();
  private negative=new Map<string,string>();
  private failures=new Map<string,string>();
  private endedThreads=new Set<string>();
  private threadRevisions=new Map<string,number>();
  private wakeChecks=new Map<string,{scope:string;at:number;ready:boolean}>();
  private closed=false;
  constructor(private store:Store,private config:BridgeConfig,private home:string,private register:(input:RegisterInput)=>Promise<Peer>){}
  private wakeScope(peer:Peer,endpoint:Endpoint):string|undefined{
    const current=this.store.peer(peer.id),active=this.store.endpoint(peer.id),pair=this.store.pairFor(peer.id),binding=this.store.bindings.current(peer.id);
    if(this.closed||!pair||pair.paused||!daemonWakeAuthorized(this.store,pair)||daemonContextChanged(this.store,current,active)||[pair.claude,pair.codex].some(id=>this.store.peer(id).enabled===false)||current.state!=='ready'||current.sessionId!==peer.sessionId||!['root','fork'].includes(current.kind)||!endpoint.daemon||!endpoint.configHome||!endpoint.pid||!endpoint.procStart||!active?.active||active.epoch!==endpoint.epoch||active.bindingEpoch!==endpoint.bindingEpoch||active.pendingContext||!binding?.active||binding.transitioning)return;
    return JSON.stringify([pair.id,peer.sessionId,endpoint.epoch,endpoint.bindingEpoch]);
  }
                                  
  canWake(peer:Peer,endpoint:Endpoint|undefined):boolean{
    if(!endpoint)return false;const scope=this.wakeScope(peer,endpoint),checked=this.wakeChecks.get(peer.id);
    return !!scope&&checked?.scope===scope&&checked.ready&&Date.now()-checked.at<2000;
  }
  async wakeReady(peer:Peer,endpoint:Endpoint):Promise<boolean>{
    const scope=this.wakeScope(peer,endpoint);if(!scope){this.wakeChecks.delete(peer.id);return false;}
    try{
      const {thread}=await this.readTarget(peer,endpoint,false),ready=thread.status?.type==='idle';
      const current=this.wakeScope(peer,endpoint);this.wakeChecks.set(peer.id,{scope,at:Date.now(),ready:ready&&current===scope});return ready&&current===scope;
    }catch{this.wakeChecks.delete(peer.id);return false;}
  }
                                          
  async queueWakeReady(peer:Peer,endpoint:Endpoint):Promise<boolean>{
    const scope=this.wakeScope(peer,endpoint);if(!scope)return false;
    try{const {thread}=await this.readTarget(peer,endpoint,false,true);return thread.status?.type==='idle'&&this.wakeScope(peer,endpoint)===scope;}catch{return false;}
  }
  private async readTarget(peer:Peer,endpoint:Endpoint,includeTurns:boolean,connectedOnly=false){
    if(this.closed||!endpoint.daemon||!endpoint.configHome||!endpoint.pid||!endpoint.procStart||!peer.sessionId)throw new DeliveryError('daemon_wake_unavailable','目标共享 daemon 路由不完整。');
    const connection=connectedOnly?this.clients.get(normalizedHome(endpoint.configHome)):await this.connection(normalizedHome(endpoint.configHome),{pid:endpoint.pid,procStart:endpoint.procStart});
    if(!connection||connection.rpc.closed||connection.pid!==endpoint.pid||connection.procStart!==endpoint.procStart||connection.address!==endpoint.daemon.address)throw new DeliveryError('daemon_identity_changed','共享 daemon 的原生路由已经改变。');
    const thread=includeTurns?await readCodexThread(connection.rpc,peer.sessionId!):(await connection.rpc.request('thread/read',{threadId:peer.sessionId,includeTurns:false},{timeout:5000})).thread as CodexThread;
    if(thread?.id!==peer.sessionId||!interactive(thread)||thread.status?.type==='notLoaded'||this.endedThreads.has(this.threadKey(connection,peer.sessionId)))throw new DeliveryError('daemon_thread_ended','原生主会话已卸载或不再可投递。');
    const permission=await persistedCodexPermission(thread.path,peer.sessionId);
    const active=this.store.endpoint(peer.id);if(permission&&active?.epoch===endpoint.epoch&&this.store.peer(peer.id).sessionId===peer.sessionId){const observed=observeCodexPermission(active,peer.sessionId,permission,'native-rollout');this.store.saveEndpoint(observed);this.store.updatePeer(peer.id,{permission:classifyCodexPermission(permission)});}
    const state=daemonRegistration(thread,connection).state;
    if(this.store.peer(peer.id).state!=='paused'&&state&&state!==this.store.peer(peer.id).state)this.store.updatePeer(peer.id,{state});
    return{connection,thread};
  }
  async injectionState(peer:Peer,endpoint:Endpoint,options:{cursor?:HistoryCursor;tail?:boolean;since?:number}={}){
    const {thread}=await this.readTarget(peer,endpoint,true),history=await readCodexHistory(thread.path,peer.sessionId!,options);
    this.store.setSetting('codexHistoryCompatibility:'+peer.id,{status:history.status,...(history.reason?{reason:history.reason}:{})});
    return{thread,history};
  }
  private async mutationTarget(peer:Peer,endpoint:Endpoint){
    const scope=this.wakeScope(peer,endpoint);if(!scope)throw new DeliveryError('daemon_wake_unavailable','共享 daemon 唤醒授权或当前上下文已改变。');
    let target:Awaited<ReturnType<CodexDaemons['readTarget']>>;
    try{target=await this.readTarget(peer,endpoint,false);}catch(error){throw new DeliveryError((error as BridgeError).code??'daemon_wake_unavailable',describeError(error));}
                                                          
    if(target.thread.status?.type!=='idle'||this.wakeScope(peer,endpoint)!==scope){this.wakeChecks.delete(peer.id);throw new DeliveryError('daemon_wake_unavailable','原生线程不再空闲或唤醒授权已改变，继续等待原生取件。');}
    return target.connection.rpc;
  }
  async inject(peer:Peer,endpoint:Endpoint,callId:string,output:string):Promise<void>{
    const rpc=await this.mutationTarget(peer,endpoint);
    await rpc.request('thread/inject_items',{threadId:peer.sessionId,items:[{type:'function_call',call_id:callId,name:'receive_messages',namespace:'claude',arguments:'{}'},{type:'function_call_output',call_id:callId,name:'receive_messages',namespace:'claude',output}]},{mutation:true});
  }
  async continueInjected(peer:Peer,endpoint:Endpoint):Promise<string>{
    const scope=this.wakeScope(peer,endpoint),rpc=await this.mutationTarget(peer,endpoint),origin=await this.turnOrigin?.(peer,'partner');
    if(this.wakeScope(peer,endpoint)!==scope)throw new DeliveryError('daemon_wake_unavailable','原生唤醒授权或上下文已改变。');
    const result=await rpc.request('turn/start',{threadId:peer.sessionId,input:[],...origin},{mutation:true});
    this.wakeChecks.delete(peer.id);return result.turn.id;
  }
  async wake(peer:Peer,endpoint:Endpoint,beforeSubmit:()=>Promise<boolean>):Promise<string|undefined>{
    const scope=this.wakeScope(peer,endpoint),rpc=await this.mutationTarget(peer,endpoint);
    const origin=await this.turnOrigin?.(peer,'children');
    if(!await beforeSubmit())return;
    if(this.wakeScope(peer,endpoint)!==scope)throw new DeliveryError('daemon_wake_unavailable','共享 daemon 唤醒授权或当前上下文已改变。');
    const result=await rpc.request('turn/start',{threadId:peer.sessionId,input:[{type:'text',text:HEALTH_WAKE_NOTICE}],...origin},{mutation:true});
    this.wakeChecks.delete(peer.id);
    if(typeof result?.turn?.id!=='string'||!result.turn.id)throw new DeliveryError('wake_result_unknown','原生唤醒没有返回可核验的轮次。',true);
    return result.turn.id;
  }
  private threadKey(domain:Pick<DaemonDomain,'configHome'|'pid'|'procStart'>,id:string):string{return JSON.stringify([normalizedHome(domain.configHome),domain.pid,domain.procStart,id]);}
  private async endDead(configHome:string,current?:DaemonDomain):Promise<void>{
    const endpoints=this.store.endpoints().filter(endpoint=>this.store.peer(endpoint.peerId).enabled!==false&&sameHome(endpoint,configHome)&&this.store.bindings.current(endpoint.peerId)?.epoch===endpoint.bindingEpoch&&(!current||endpoint.pid!==current.pid||endpoint.procStart!==current.procStart));
    const states=await probeProcesses(endpoints.map(endpoint=>({pid:endpoint.pid!,procStart:endpoint.procStart!})));
    for(let index=0;index<endpoints.length;index++)if(states[index]==='dead'){
      const endpoint=endpoints[index]!,peer=this.store.peer(endpoint.peerId),pair=this.store.pairFor(peer.id);
      this.store.transaction(()=>{this.endPeer(peer,endpoint.epoch);if(pair)this.store.setSetting('daemonContinuity:'+peer.id,{pairId:pair.id,sessionId:peer.sessionId,configHome:normalizedHome(configHome),generation:endpoint.procStart,losses:[pair.claude,pair.codex].map(id=>this.store.setting<{id:string}>('pairLoss:'+id)?.id)});});
    }
  }
  async scan(configHome:string,expected?:{pid:number;procStart:string},fresh=false):Promise<Connection|undefined>{
    const key=normalizedHome(configHome),pending=this.scans.get(key);
                                            
    if(fresh&&pending&&!pending.fresh){await pending.work;return this.scan(configHome,expected,true);}
    let work=pending?.work;
    if(!work){const scanning=this.scanInner(key,expected,fresh).finally(()=>{if(this.scans.get(key)?.work===scanning)this.scans.delete(key);});work=scanning;this.scans.set(key,{work,fresh});}
    const connection=await work;
    if(connection&&expected&&(connection.pid!==expected.pid||connection.procStart!==expected.procStart))throw new BridgeError('daemon_identity_changed','扫描与调用的 daemon 代次不符。');
                                         
    if(connection&&fresh&&(!connection.at||connection.rpc.closed||this.clients.get(key)!==connection))throw new BridgeError('daemon_snapshot_changed','线程列表核验期间发生变化，当前持有者状态未知。');
    return connection;
  }
  private connection(configHome:string,expected?:{pid:number;procStart:string}):Promise<Connection|undefined>{
    let opening=this.openings.get(configHome);
    if(!opening){
      const work=this.connectInner(configHome).finally(()=>{if(this.openings.get(configHome)===work)this.openings.delete(configHome);});
      opening=work;this.openings.set(configHome,work);
    }
    return opening.then(connection=>{
      if(connection&&expected&&(connection.pid!==expected.pid||connection.procStart!==expected.procStart))throw new BridgeError('daemon_identity_changed','调用与当前 daemon 的进程代次不符。');
      return connection;
    });
  }
  private async connectInner(configHome:string):Promise<Connection|undefined>{
    if(this.closed)return;
    let connection=this.clients.get(configHome);
    const file=path.join(configHome,'app-server-daemon','daemon.pid');let pid:number|undefined,stamp='missing';
    try{const value=JSON.parse(readFileSync(file,'utf8')),stat=statSync(file);pid=Number.isSafeInteger(value.pid)&&value.pid>0?value.pid:undefined;stamp=[stat.mtimeMs,stat.size,pid].join(':');}
    catch(error){if(!['ENOENT','ENOTDIR'].includes((error as NodeJS.ErrnoException).code??''))throw error;}
    if(!pid||!liveProcess(pid)||this.negative.get(configHome)===stamp){this.negative.set(configHome,stamp);if(connection){connection.rpc.close();this.clients.delete(configHome);}await this.endDead(configHome);return;}
                                                   
                                                                    
    if(!connection||connection.pid!==pid||connection.rpc.closed){
      let native:Awaited<ReturnType<typeof processIdentity>>;
      try{native=await processIdentity(pid);}catch(error){if((error as BridgeError).code==='process_missing'){this.negative.set(configHome,stamp);await this.endDead(configHome);return;}throw error;}
      if(!await codexIsManagedDaemon(native)){this.negative.set(configHome,stamp);await this.endDead(configHome);throw new BridgeError('daemon_identity_changed','官方 PID 文件已陈旧，该进程不是共享 daemon。');}
      if(!native.image)throw new BridgeError('daemon_identity_changed','共享 daemon 的程序映像无法核验。');
      const launch=selectHostLaunch('codex',this.config,{home:this.home,configHome,executable:native.image,unobserved:true});
                                               
      launch.executable={command:native.image,prefix:[]};
      launch.configHome=configHome;launch.env.CODEX_HOME=configHome;
      const value=JSON.parse(await runCli('codex',['app-server','daemon','version'],{launch,timeout:5000}));
      if(value.status!=='running'||typeof value.socketPath!=='string')return;
      if(JSON.parse(readFileSync(file,'utf8')).pid!==pid||(await processIdentity(pid)).startedAt!==native.startedAt)throw new BridgeError('daemon_identity_changed','daemon 在连接核验期间改变，未登记旧路由。');
      const address='unix://'+value.socketPath,rpc=await connectAppServer(address,{...this.config,codexHome:configHome},undefined,this.home,{readOnly:true});
      if(this.closed){rpc.close();return;}
      connection?.rpc.close();connection={configHome,pid,procStart:native.startedAt,address,rpc,at:0,revision:0,threads:[]};this.clients.set(configHome,connection);this.negative.delete(configHome);
    }
    return connection;
  }
  private async scanInner(configHome:string,expected?:{pid:number;procStart:string},fresh=false):Promise<Connection|undefined>{
    const connection=await this.connection(configHome,expected);if(!connection)return;
    if(!fresh&&Date.now()-connection.at<2000)return connection;
    const threads:CodexThread[]=[],rpc=connection.rpc,revision=connection.revision,observedBefore=new Map(connection.threads.map(thread=>[thread.id,thread]));let cursor:string|undefined;
    do{
      const result=await rpc.request('thread/loaded/list',{limit:100,...(cursor?{cursor}:{})},{timeout:3000});
      for(const id of result.data??[]){
        const threadId=typeof id==='string'?id:id.id;if(this.store.peersForSession('codex',threadId).some(peer=>peer.enabled===false))continue;
        const value=await rpc.request('thread/read',{threadId:typeof id==='string'?id:id.id,includeTurns:false},{timeout:3000});
        if(value.thread?.status?.type!=='notLoaded')threads.push(value.thread);
      }
      cursor=result.nextCursor??undefined;
    }while(cursor&&!this.closed);
    if(this.closed||rpc.closed)return;
                                          
    if(connection.revision!==revision){connection.at=0;return connection;}
                                               
    for(const observed of connection.threads)if(observedBefore.get(observed.id)!==observed){const index=threads.findIndex(thread=>thread.id===observed.id);if(index<0)threads.push(observed);else threads[index]=observed;}
    const loaded=new Set(threads.map(thread=>this.threadKey(connection!,thread.id)));
    for(const thread of connection.threads){const key=this.threadKey(connection,thread.id);if(!loaded.has(key))this.endedThreads.delete(key);}
    await this.applySnapshot(connection,threads,revision);
    if(connection.revision!==revision){connection.at=0;return connection;}
    connection.threads=threads;connection.at=Date.now();await this.endDead(configHome,connection);return connection;
  }
  async registration(configHome:string,runtime:{pid:number;procStart:string},sessionId:string,contextStart=false):Promise<RegisterInput>{
    if(this.store.peersForSession('codex',sessionId).some(peer=>peer.enabled===false))throw new BridgeError('member_disabled','该 Codex 成员的 nxbridge 已关闭。');
                                                 
    const connection=await this.connection(normalizedHome(configHome),runtime);if(!connection)throw new BridgeError('daemon_unavailable','未找到当前配置目录的共享 daemon。');
    const chain:CodexThread[]=[],seen=new Set<string>(),revisions=new Map<string,number>();let id:string|undefined=sessionId;
    while(id){
      if(seen.has(id))throw new BridgeError('unverified_parent','原生子线程父链存在循环。');seen.add(id);
      const key=this.threadKey(connection,id);if(contextStart&&id===sessionId)this.endedThreads.delete(key);revisions.set(key,this.threadRevisions.get(key)??0);
                                                          
      const thread=(await connection.rpc.request('thread/read',{threadId:id,includeTurns:false},{timeout:2000})).thread as CodexThread;
      if(thread.id!==id||thread.status?.type==='notLoaded'||thread.ephemeral||this.endedThreads.has(key))throw new BridgeError('daemon_thread_ended','原生线程已结束或不属于可配对的持久会话。');
      chain.unshift(thread);id=parent(thread);
    }
    if(!chain[0]||!interactive(chain[0]))throw new BridgeError('unverified_parent','线程父链没有到达已核验的交互主会话。');
    const validate=()=>{if(this.closed||connection.rpc.closed||this.clients.get(normalizedHome(configHome))!==connection||[...revisions].some(([key,revision])=>(this.threadRevisions.get(key)??0)!==revision))throw new BridgeError('daemon_thread_ended','原生线程在核验期间已结束，请在当前线程重新交互。');};validate();
                                            
    if(chain.some(thread=>{const known=connection.threads.find(value=>value.id===thread.id);return!known||known.status?.type==='notLoaded';})){connection.revision++;connection.at=0;}
    for(const thread of chain){const index=connection.threads.findIndex(value=>value.id===thread.id);if(index<0)connection.threads.push(thread);else connection.threads[index]=thread;}
    for(const thread of chain.slice(0,-1)){
      validate();
      await this.register(daemonRegistration(thread,connection,chain[0].id));
    }
    validate();
    return daemonRegistration(chain.at(-1)!,connection,chain[0].id);
  }
  async sync():Promise<void>{
    const homes=new Set([this.config.codexHome??codexHome(),...this.store.endpoints().filter(endpoint=>endpoint.daemon).map(endpoint=>endpoint.configHome)].filter((value):value is string=>!!value));
    await Promise.all([...homes].map(async configHome=>{try{await this.scan(configHome);}catch(error){const failure=describeError(error);if(this.failures.get(configHome)!==failure){this.failures.set(configHome,failure);this.store.event('daemon.discovery.failed',{configHome,error:failure});}}}));
  }
                                                     
  async applySnapshot(domain:DaemonDomain,threads:CodexThread[],revision?:number):Promise<void>{
    const roots=threads.filter(thread=>interactive(thread)&&!this.endedThreads.has(this.threadKey(domain,thread.id))),loaded=new Set(roots.map(thread=>thread.id));
    const previous=new Map((this.clients.get(normalizedHome(domain.configHome))?.threads??[]).map(thread=>[thread.id,thread]));
    const old=this.store.endpoints().filter(endpoint=>sameHome(endpoint,domain.configHome)&&endpoint.pid===domain.pid&&endpoint.procStart===domain.procStart&&this.store.bindings.current(endpoint.peerId));
    const current=()=>revision===undefined||this.clients.get(normalizedHome(domain.configHome))===domain&&(domain as Connection).revision===revision;
    for(const thread of roots){
      await this.store.faults.run('daemon_thread:'+thread.id,async()=>{
      if(this.store.peersForSession('codex',thread.id).some(peer=>peer.enabled===false))return;
      if(!current())return;
      const before=previous.get(thread.id),input=daemonRegistration(thread,domain),prior=before?daemonRegistration(before,domain):undefined;
      if(old.length&&!old.some(endpoint=>this.store.peer(endpoint.peerId).sessionId===thread.id))observeDaemonContext(this.store,{sessionId:thread.id,cwd:thread.cwd},domain);
      if(!prior||JSON.stringify(prior)!==JSON.stringify(input)||!old.some(endpoint=>this.store.peer(endpoint.peerId).sessionId===thread.id)){
        const retained=old.find(endpoint=>this.store.peer(endpoint.peerId).sessionId===thread.id);
                                             
        if(retained&&this.store.bindings.current(retained.peerId)?.transitioning)return;
        const peer=await this.register(input),key='daemonContinuity:'+peer.id,continuity=this.store.setting<{pairId:string;sessionId:string;configHome:string;generation:string;losses:string[]}>(key);
        try{await captureDaemonLaunch(this.home,peer,input.endpoint);}catch(error){this.store.event('launch.daemon.capture.failed',{peerId:peer.id,code:(error as BridgeError).code??'capture_failed'});}
        if(continuity&&continuity.sessionId===thread.id&&continuity.configHome===normalizedHome(domain.configHome)&&continuity.generation!==domain.procStart){
          const pair=this.store.pairById(continuity.pairId);
          if(pair?.archived&&[pair.claude,pair.codex].every((id,index)=>!this.store.pairFor(id)&&this.store.setting<{id:string}>('pairLoss:'+id)?.id===continuity.losses[index]))this.store.restorePair(pair.id);
          this.store.setSetting(key,null);
        }
      }
      });
    }
                                                
                                                
    for(const thread of roots.filter(thread=>thread.status?.type==='idle')){
      if(!current())return;
      const endpoint=old.find(endpoint=>this.store.peer(endpoint.peerId).sessionId===thread.id),peer=endpoint?this.store.peer(endpoint.peerId):undefined,binding=peer?this.store.bindings.current(peer.id):undefined,pair=peer?this.store.pairFor(peer.id):undefined;
      if(!peer||!endpoint||!binding?.transitioning||binding.transitionReason!=='unknown'||!pair||pair.paused||!daemonWakeAuthorized(this.store,pair)||daemonContextChanged(this.store,peer,endpoint)||['paused','needsHuman'].includes(peer.state)||peer.enabled===false||!endpoint.active)continue;
      await this.register(daemonRegistration(thread,domain));
      this.store.event('daemon.context.reopened',{peerId:peer.id,sessionId:thread.id});
    }
    const metadata=new Map(threads.map(thread=>[thread.id,thread.forkedFromId]));
    for(const endpoint of this.store.endpoints().filter(endpoint=>sameHome(endpoint,domain.configHome)))metadata.set(this.store.peer(endpoint.peerId).sessionId!,endpoint.daemon?.forkedFromId);
    const descendant=(thread:CodexThread,id:string)=>{const seen=new Set<string>();let from=thread.forkedFromId;while(from&&!seen.has(from)){if(from===id)return true;seen.add(from);from=metadata.get(from);}return false;};
    for(const endpoint of old){
      this.store.faults.sync('daemon_endpoint:'+endpoint.peerId,()=>{
      if(!current())return;
      if(!this.store.bindings.current(endpoint.peerId))return;
      if(this.store.peer(endpoint.peerId).enabled===false)return;
      const peer=this.store.peer(endpoint.peerId);if(!peer.sessionId||loaded.has(peer.sessionId))return;
      const forks=roots.filter(thread=>descendant(thread,peer.sessionId!));
      const pair=this.store.pairFor(peer.id);
      if(pair&&forks.length===1){
        const next=forks[0]!,candidate=this.store.peersForSession('codex',next.id).find(value=>this.store.endpoints(value.id).some(value=>value.active&&sameHome(value,domain.configHome)&&value.pid===domain.pid&&value.procStart===domain.procStart));
        if(candidate&&!this.store.hasPairHistory(candidate.id)){
          this.store.transaction(()=>{const before=this.store.bindings.current(peer.id)!;this.store.deactivate(peer.id);const input=daemonRegistration(next,domain);this.store.adopt(peer.id,input,candidate.id);this.store.rotateContext(peer.id,before,'fork');this.store.updatePeer(peer.id,{permission:daemonPermission(input.endpoint.daemon!)});this.store.event('daemon.fork.inherited',{peerId:peer.id,from:peer.sessionId,sessionId:next.id});});return;
        }
      }
      this.endPeer(peer,endpoint.epoch);
      });
    }
  }
  nativeInteraction(peer:Peer):void{
    const endpoint=this.store.endpoint(peer.id);if(peer.host==='codex'&&['root','fork'].includes(peer.kind)&&endpoint?.daemon)observeDaemonContext(this.store,peer,endpoint);
  }
  endPeer(peer:Peer,epoch?:string):void{
    if(this.store.peer(peer.id).enabled===false)return;
    this.store.transaction(()=>{
      const binding=this.store.bindings.current(peer.id);if(!binding||epoch&&!this.store.endpoints(peer.id).some(endpoint=>endpoint.epoch===epoch&&endpoint.bindingEpoch===binding.epoch))return;
                                                           
      if(peer.kind!=='subagent'&&!this.store.bindings.current(peer.id)?.transitioning)this.store.endContext({host:'codex',memberId:peer.id,sessionId:peer.sessionId!,callId:'daemon-end'});this.store.deactivate(peer.id,epoch);this.store.updatePeer(peer.id,{state:'offline'});
      this.store.bindings.save({...binding,active:false});
      this.store.selections.invalidate(peer.id);
      if(this.store.pairFor(peer.id))closeHostedWindow(this.store,peer,epoch);
    });
  }
  async ended(peer:Peer):Promise<void>{
    const endpoint=this.store.endpoint(peer.id),connection=endpoint?.configHome?this.clients.get(normalizedHome(endpoint.configHome)):undefined;
    if(this.store.setting('daemonContinuity:'+peer.id))this.store.setSetting('daemonContinuity:'+peer.id,null);
    if(endpoint?.configHome&&endpoint.pid&&endpoint.procStart){const key=this.threadKey({configHome:endpoint.configHome,pid:endpoint.pid,procStart:endpoint.procStart},peer.sessionId!);this.endedThreads.add(key);this.threadRevisions.set(key,(this.threadRevisions.get(key)??0)+1);}
    if(connection){connection.revision++;connection.at=0;await this.applySnapshot(connection,connection.threads.filter(thread=>thread.id!==peer.sessionId),connection.revision);return;}
    this.endPeer(peer,endpoint?.epoch);
  }
  close():void{this.closed=true;for(const connection of this.clients.values())connection.rpc.close();this.clients.clear();this.wakeChecks.clear();}
  async reconcile(peer:Peer,endpoint:Endpoint,options:{since?:number}={}):Promise<CodexContextReceipt[]>{
    if(this.store.peer(peer.id).enabled===false)return[];
    if(!endpoint.configHome)return[];const connection=await this.scan(endpoint.configHome);if(!connection||connection.pid!==endpoint.pid||connection.procStart!==endpoint.procStart)return[];
    const thread=await readCodexThread(connection.rpc,peer.sessionId!);
    const history=await readCodexHistory(thread.path,peer.sessionId!,options.since===undefined?{tail:true}:{since:options.since});this.store.setSetting('codexHistoryCompatibility:'+peer.id,{status:history.status,...(history.reason?{reason:history.reason}:{})});
    return history.receipts;
  }
}
