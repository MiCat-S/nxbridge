import type { Store } from '../../storage/store.js';
import {BridgeError,describeError} from '../../shared/errors.js';
import {type Endpoint,type Peer,type BridgeConfig} from '../../types.js';
import type { SessionPolicy } from '../../hosts/codex/codex-session-profile.js';
import { readSessionProfile, sessionFile } from '../../hosts/codex/codex-session-profile.js';
import {sameDirectory} from '../../shared/files.js';
import { prepareOwnedLaunch } from '../../hosts/host-launch.js';
import { selectSessionLaunch } from '../../hosts/session-launch.js';
export { profileVersionSupported } from '../../hosts/host-version.js';
import { managedRuntimes, runtimeFor, managedRuntimeState, managedRuntimeNativeState, removeManagedRuntime, saveManagedRuntime, type ManagedRuntime, type RuntimeRecord } from '../../hosts/managed-runtimes.js';
import { codexSubagent, codexUserWindow } from '../../hosts/codex/codex-lineage.js';
import { nativeConfigHome, processIdentity, codexArguments, codexAppServerArguments, probeProcesses } from '../../process/process.js';
import { knownNativeProcesses, type KnownNativeProcess } from '../../process/native-processes.js';
import { ownedProcesses } from '../../process/owned-processes.js';
import { parkLaunchFailure, type LaunchPark } from '../../hosts/launch-park.js';

export interface HostingRecord {
  pairId:string;memberId:string;sessionId:string;configHome:string;cwd:string;origin:'user'|'managed';
  background:boolean;released?:boolean;phase?:'adopting'|'releasing'|'awaiting_window';
  verified?:boolean;verifying?:boolean;reason?:string;userStep?:string;policy?:SessionPolicy;at:number;
  verificationRuntimeId?:string;verificationEndpoint?:string;verificationError?:{code:string;message:string};
  attempts?:number;nextAt?:number;bootstrapProbeKey?:string;launchPark?:LaunchPark;
}
export const hostingKey=(id:string)=>'hosting:'+id;
export const codexForegroundEndKey=(address:string,sessionId:string)=>'codexForegroundEnd:'+address+'|'+sessionId;
export interface CodexForegroundEnd {runtimeId?:string;pid?:number;procStart?:string;epoch:string;exact:boolean;released?:boolean}
export function codexForegroundEnd(store:Store,peer:Peer,endpoint=store.endpoint(peer.id)):CodexForegroundEnd|undefined{
  if(!codexUserWindow(peer)||!peer.sessionId||!endpoint)return;
  const value=store.setting<CodexForegroundEnd>(codexForegroundEndKey(endpoint.address,peer.sessionId));return value?.epoch===endpoint.epoch?value:undefined;
}
export function hostingRecord(store:Store,peer:Peer):HostingRecord|undefined{
  const record=store.setting<HostingRecord>(hostingKey(peer.id)),pair=store.pairFor(peer.id);
  return record&&record.memberId===peer.id&&record.sessionId===peer.sessionId&&record.pairId===pair?.id?record:undefined;
}
export function writeHosting(store:Store,peer:Peer,patch:Partial<HostingRecord>={},home?:string):HostingRecord{
  const pair=store.pairFor(peer.id);if(!pair||!peer.sessionId)throw Error('托管状态必须属于当前配对及会话。');
  const prior=hostingRecord(store,peer),endpoints=store.endpoints(peer.id).sort((a,b)=>b.seenAt-a.seenAt);
  const value:HostingRecord={pairId:pair.id,memberId:peer.id,sessionId:peer.sessionId,configHome:home??prior?.configHome??endpoints.find(ep=>ep.configHome)?.configHome??'',cwd:peer.cwd,origin:prior?.origin??(peer.owner==='nxbridge'?'managed':'user'),background:prior?.background??peer.owner==='nxbridge',...prior,...patch,at:Date.now()};
  if(patch.verified===true){delete value.launchPark;delete value.bootstrapProbeKey;}
  if(peer.owner==='user'){value.verifying=false;delete value.verificationRuntimeId;delete value.verificationEndpoint;delete value.verificationError;}
  store.setSetting(hostingKey(peer.id),value);return value;
}
function verificationPending(peer:Peer,value:HostingRecord|undefined):boolean{
  return !!value?.verifying&&peer.owner==='nxbridge';
}
                                             
export function hostingGate(store:Store,peer:Peer):boolean{
  if(peer.host!=='codex'||!peer.sessionId)return false;
  if(store.setting('managedRuntimeConflict:'+peer.id))return true;
  if(peer.owner==='user'&&codexForegroundEnd(store,peer))return true;
  const value=hostingRecord(store,peer);
  if(verificationPending(peer,value)||peer.owner==='nxbridge'&&value?.reason==='bootstrap_policy_unsupported'||value?.phase==='adopting'||value?.phase==='releasing'||value?.phase==='awaiting_window')return true;
  return peer.owner==='user'&&(!store.endpoint(peer.id)||peer.state==='offline');
}
export function hostingStatus(store:Store,peer:Peer){
  if(peer.host!=='codex'||!peer.sessionId||!store.pairFor(peer.id))return undefined;
  const value=hostingRecord(store,peer),endpoint=store.endpoint(peer.id),binding=store.bindings.current(peer.id),lease=store.setting<{foreground?:{pid:number;procStart:string}}>('takeover:'+peer.id);
  const holder=lease?.foreground??(binding?{pid:binding.pid,procStart:binding.procStart}:endpoint?.native??(endpoint?.pid&&endpoint.procStart?{pid:endpoint.pid,procStart:endpoint.procStart}:undefined));
  const preference=value?.background??peer.owner==='nxbridge'?'bg':'user';
  const conflict=store.setting('managedRuntimeConflict:'+peer.id);
  const verifying=verificationPending(peer,value),verificationError=verifying?value?.verificationError:undefined;
  const phase=conflict||verificationError||peer.owner==='nxbridge'&&value?.reason==='bootstrap_policy_unsupported'||value?.reason&&['adopting','releasing'].includes(value.phase??'')?'blocked':value?.phase??(verifying?'verifying':endpoint&&peer.state!=='offline'?peer.owner==='nxbridge'&&preference==='bg'&&!binding&&!lease?'background':'foreground':'window_closed');
  const pair=store.pairFor(peer.id)!,counts=store.deliveryCounts(pair.id,pair.claude===peer.id?pair.codex:pair.claude);
  return{preference,phase,verifying:verifying&&!verificationError,name:peer.name,pair_id:store.pairFor(peer.id)!.id,member_id:peer.id,session_id:peer.sessionId,config_home:value?.configHome??endpoint?.configHome??store.endpoints(peer.id).find(ep=>ep.configHome)?.configHome,cwd:peer.cwd,wake_capable:!hostingGate(store,peer)&&!!endpoint&&(endpoint.mode==='app-server'&&!endpoint.daemon||endpoint.mode==='embedded'&&!!endpoint.bridge),...(holder?{holder:{mode:endpoint?.daemon?'daemon':endpoint?.mode??'foreground',pid:holder.pid,generation:holder.procStart}}:{}),held_unsent:hostingGate(store,peer)?counts.accepted:0,uncertain:counts.unknown+counts.sending+counts.runtimeQueued,...(value?.policy?{policy:value.policy}:{}),...(conflict?{reason:'session_conflict'}:verificationError?{reason:verificationError.code,user_step:verificationError.message}:value?.reason?{reason:value.reason}:{}),...(!verificationError&&value?.userStep?{user_step:value.userStep}:{})};
}
export function closeHostedWindow(store:Store,peer:Peer,epoch?:string):void{
  const record=hostingRecord(store,peer);store.deactivate(peer.id,epoch);
  const binding=store.bindings.current(peer.id);if(binding)store.bindings.save({...binding,active:false});
  store.updatePeer(peer.id,{state:'offline'});
  if(peer.sessionId&&store.pairFor(peer.id))writeHosting(store,peer,{...(record?.released?{phase:'awaiting_window' as const}:{phase:undefined}),reason:undefined});
}
                                            
function holderTopology(store:Store,peer:Peer):string{
  const endpoints=store.endpoints(peer.id).map(ep=>JSON.stringify([ep.epoch,ep.mode,ep.address,ep.active,ep.pid,ep.procStart,ep.configHome,ep.runtimeId,ep.native,ep.bridge,ep.bindingEpoch,ep.processKind,ep.daemon?[ep.daemon.address,ep.daemon.rootSessionId,ep.daemon.forkedFromId]:null,ep.pendingContext])).sort();
  const b=store.bindings.current(peer.id);
  return JSON.stringify([endpoints,b?[b.key,b.epoch,b.peerId,b.sessionId,b.configHome,b.pid,b.procStart,b.threadId,b.active,b.transitioning]:null]);
}

export class SessionTransfers {
  private pending=new Map<string,{kind:'adopt'|'release';work:Promise<unknown>}>();
  constructor(private store:Store,private config:BridgeConfig,private home:string,private ops:{
    holder:(peer:Peer)=>Promise<'alive'|'dead'|'unknown'>;prepare:(peer:Peer)=>Promise<void>;stop:(peer:Peer,endpoint:Endpoint,guard:()=>void)=>Promise<void>;enabled:(peer:Peer)=>void;
    loaded?:(peer:Peer,endpoint:Endpoint)=>Promise<'alive'|'dead'|'unknown'>;daemon?:(peer:Peer,runtime:{pid:number;procStart:string})=>Promise<'alive'|'dead'|'unknown'>;cleanup?:(peer:Peer,endpoint:string)=>Promise<void>;
    inspect?:(runtime:ManagedRuntime,sessionId:string)=>Promise<{id:string;parentThreadId?:string|null;source?:any;threadSource?:string;status?:{type:string}}|undefined>;
    processes?:(host:'codex'|'claude')=>Promise<KnownNativeProcess[]>;identity?:typeof processIdentity;
  }){}
  private assert(peer:Peer):void{this.ops.enabled(peer);if(peer.host!=='codex'||!peer.sessionId||!this.store.pairFor(peer.id))throw new BridgeError('session_missing','托管切换需要已配对的 Codex 原会话。');}
  private human(peer:Peer):void{
    if(peer.state==='needsHuman'||this.store.questions(true).some(q=>q.from===peer.id||q.to===peer.id))throw new BridgeError('pending_approval','原会话仍有问题或审批待处理；请先 nxbridge open codex 打开并回答，再切换托管。');
  }
  private run(peer:Peer,kind:'adopt'|'release',work:()=>Promise<unknown>):Promise<unknown>{
    const pending=this.pending.get(peer.id);if(pending?.kind===kind)return pending.work;
    const execute=pending?pending.work.catch(()=>{}).then(work):work(),next=execute.finally(()=>{if(this.pending.get(peer.id)?.work===next)this.pending.delete(peer.id);});this.pending.set(peer.id,{kind,work:next});return next;
  }
  private waiting(peer:Peer):unknown{const live=!!this.store.endpoint(peer.id)&&peer.state!=='offline';this.store.updatePeer(peer.id,{owner:'user'});writeHosting(this.store,this.store.peer(peer.id),{background:false,released:true,phase:live?undefined:'awaiting_window',reason:undefined,userStep:live?undefined:'按平时方式重新打开原 Codex 会话。',attempts:0,nextAt:undefined});return{status:'paired',hosting:hostingStatus(this.store,this.store.peer(peer.id))};}
  async wait(peer:Peer):Promise<unknown>{this.assert(peer);if(this.pending.has(peer.id)||runtimeFor(this.home,{peerId:peer.id}))return this.release(peer);return this.waiting(peer);}
  private failed(peer:Peer,error:unknown,phase:'adopting'|'releasing'):void{const record=hostingRecord(this.store,peer);if(!record||phase==='adopting'&&record.released)return;const attempts=(record.attempts??0)+1,key=(error as {bootstrapProbeKey?:string}).bootstrapProbeKey,launchPark=phase==='adopting'?parkLaunchFailure(error,this.home,this.config,peer,record.configHome,this.store.setting<any>('managedLaunchProof:'+peer.id)??{}):undefined;writeHosting(this.store,peer,{phase,reason:(error as BridgeError).code??'holder_unknown',userStep:describeError(error),attempts,bootstrapProbeKey:key,launchPark,nextAt:launchPark||(error as BridgeError).code==='bootstrap_policy_unsupported'&&key?Number.MAX_SAFE_INTEGER:Date.now()+Math.min(300000,5000*2**Math.min(attempts-1,6))});}
  async reconcileOwned(peer:Peer):Promise<boolean>{
    if(this.pending.has(peer.id))return false;return this.settleOwned(peer);
  }
  private async settleOwned(peer:Peer):Promise<boolean>{
    const eligible=()=>{
      const current=this.store.peer(peer.id),record=hostingRecord(this.store,current),endpoint=this.store.endpoint(peer.id),runtime=runtimeFor(this.home,{peerId:peer.id})?.value;
      if(current.host!=='codex'||current.owner!=='nxbridge'||!current.sessionId||current.sessionId!==peer.sessionId||current.state==='offline'||!record?.background||record.phase!=='adopting'||record.released||record.verifying||record.verificationError||record.reason==='bootstrap_policy_unsupported'||this.store.bindings.current(peer.id)||this.store.setting('takeover:'+peer.id)||this.store.setting('managedSessionConflict:'+peer.id)||this.store.setting('managedRuntimeConflict:'+peer.id))return;
      if(!endpoint||endpoint.mode!=='app-server'||endpoint.daemon||!runtime||runtime.kind!=='owned'||runtime.state!=='ready'||runtime.sessionVerification||runtime.sessionId&&runtime.sessionId!==current.sessionId||!runtime.pid||!runtime.procStart||endpoint.address!==runtime.endpoint||endpoint.runtimeId&&endpoint.runtimeId!==runtime.id||endpoint.pid!==runtime.pid||endpoint.procStart!==runtime.procStart||!endpoint.configHome||!runtime.configHome||!sameDirectory(endpoint.configHome,runtime.configHome)||!sameDirectory(record.configHome,runtime.configHome))return;
      return{current,runtime,record};
    };
    if(peer.host!=='codex'||!this.ops.inspect)return false;
    const before=eligible();if(!before)return false;
    this.ops.enabled(before.current);const topology=holderTopology(this.store,peer);let thread:Awaited<ReturnType<NonNullable<typeof this.ops.inspect>>>;
    try{thread=await this.ops.inspect(before.runtime,peer.sessionId!);}catch{return false;}
    if(thread?.id!==peer.sessionId||!['active','idle'].includes(thread.status?.type??'')||codexSubagent(thread))return false;
    const after=eligible();if(!after||after.record.pairId!==before.record.pairId||after.runtime.id!==before.runtime.id||after.runtime.pid!==before.runtime.pid||after.runtime.procStart!==before.runtime.procStart||holderTopology(this.store,peer)!==topology)return false;
    this.ops.enabled(after.current);writeHosting(this.store,after.current,{phase:undefined,verified:true,reason:undefined,userStep:undefined,attempts:0,nextAt:undefined});
    this.store.event('hosting.adopted',{peerId:peer.id,pairId:after.record.pairId,sessionId:peer.sessionId,reconciled:true});return true;
  }
  async adopt(peer:Peer,options:{home?:string;cwd?:string}={}):Promise<unknown>{
    this.assert(peer);return this.run(peer,'adopt',async()=>{
      peer=this.store.peer(peer.id);const pair=this.store.pairFor(peer.id)!,id=peer.sessionId!,prior=hostingRecord(this.store,peer);
      const home=options.home??prior?.configHome??this.store.endpoints(peer.id).find(ep=>ep.configHome)?.configHome;
      if(!home)throw new BridgeError('original_home_changed','无法核验原 CODEX_HOME，请用 --home 明确指定。');
      if(prior?.configHome&&!sameDirectory(prior.configHome,home)||this.store.endpoints(peer.id).some(ep=>ep.configHome&&!sameDirectory(ep.configHome,home)))throw new BridgeError('original_home_changed','指定配置目录与原会话不一致，未切换托管。');
      if(options.cwd&&!sameDirectory(options.cwd,peer.cwd))throw new BridgeError('cwd_mismatch',`原目录为 ${peer.cwd}，请求目录为 ${options.cwd}；请先在原生窗口明确选择目录。`);
      let topology=holderTopology(this.store,peer);
      const guard=(checkHolder=true)=>{const current=this.store.peer(peer.id);this.ops.enabled(current);if(current.sessionId!==id||this.store.pairFor(current.id)?.id!==pair.id||hostingRecord(this.store,current)?.released||this.store.setting('managedSessionConflict:'+peer.id)||this.store.setting('managedRuntimeConflict:'+peer.id)||checkHolder&&holderTopology(this.store,current)!==topology)throw new BridgeError('session_changed','托管切换期间会话、配对或原生持有者已经改变。');};
      if(peer.owner==='nxbridge'&&this.store.endpoint(peer.id)&&peer.state!=='offline'){
        await this.settleOwned(peer);return{status:hostingGate(this.store,this.store.peer(peer.id))?'held':'paired',hosting:hostingStatus(this.store,this.store.peer(peer.id))};
      }
      writeHosting(this.store,peer,{background:true,released:false,reason:undefined,userStep:undefined},home);
      try{
        const state=peer.owner==='nxbridge'?'dead':await this.ops.holder(peer);guard();
        if(state==='alive'){writeHosting(this.store,peer,{phase:undefined,reason:'holder_active',userStep:'已记录后台托管选择；原窗口退出后继续原会话。'});return{status:'paired',hosting:hostingStatus(this.store,this.store.peer(peer.id))};}
        if(state==='unknown')throw new BridgeError('holder_unknown','原窗口或线程是否已退出尚无法核验，未启动第二个运行时。');
        this.human(peer);
        this.store.transaction(()=>{guard();const binding=this.store.bindings.current(peer.id);if(binding)this.store.bindings.save({...binding,active:false});this.store.deactivate(peer.id);this.store.updatePeer(peer.id,{owner:'nxbridge',state:'offline'});writeHosting(this.store,this.store.peer(peer.id),{background:true,released:false,phase:'adopting',verified:false},home);const proof=this.store.setting<any>('managedLaunchProof:'+peer.id);this.store.setSetting('managedLaunchProof:'+peer.id,{...(proof?.sessionId===id?proof:{}),sessionId:id,configHome:home,adopted:true});});
        peer=this.store.peer(peer.id);topology=holderTopology(this.store,peer);
        const file=sessionFile(home,id),profile=await readSessionProfile(file,id);guard();
        if(!profile.verified)throw new BridgeError('session_not_found','原配置目录中没有可核验的同 ID 持久历史；未创建新会话。');
        if(profile.settings.cwd&&!sameDirectory(profile.settings.cwd,peer.cwd)||!profile.settings.cwd&&profile.meta.cwd&&!sameDirectory(profile.meta.cwd,peer.cwd))throw new BridgeError('cwd_mismatch',`原生会话目录为 ${profile.settings.cwd??profile.meta.cwd}，成员目录为 ${peer.cwd}；请先在原窗口选择。`);
        await this.assertNoExternalHolder(peer);guard();
        const affinity=this.store.setting<any>('managedLaunchProof:'+peer.id),launch=await prepareOwnedLaunch(await selectSessionLaunch('codex',this.config,{home:this.home,sessionId:id,configHome:home,cwd:peer.cwd,...(affinity?.executable?{executable:affinity.executable,profileId:affinity.profileId}:{})},{writer:profile.meta.cli_version}));
        guard();this.store.setSetting('managedLaunchProof:'+peer.id,{sessionId:id,configHome:home,executable:launch.executable.command,profileId:launch.profile?.id,version:launch.version!.trim(),adopted:true});
        await this.ops.prepare(this.store.peer(peer.id));guard(false);
        if(!this.store.endpoint(peer.id)||this.store.peer(peer.id).state==='offline')throw new BridgeError('policy_verification_failed','原会话尚未完成权限核验，消息继续保留。');
        writeHosting(this.store,this.store.peer(peer.id),{phase:undefined,verified:true,reason:undefined,userStep:undefined,attempts:0,nextAt:undefined});this.store.event('hosting.adopted',{peerId:peer.id,pairId:pair.id,sessionId:id});
        return{status:'paired',hosting:hostingStatus(this.store,this.store.peer(peer.id))};
      }catch(error){this.failed(this.store.peer(peer.id),error,'adopting');throw error;}
    });
  }
  async release(peer:Peer):Promise<unknown>{
    this.assert(peer);
    if(this.pending.get(peer.id)?.kind==='adopt'){this.store.updatePeer(peer.id,{owner:'user'});writeHosting(this.store,this.store.peer(peer.id),{background:false,released:true,phase:'releasing',verified:false});}
    return this.run(peer,'release',async()=>{
      peer=this.store.peer(peer.id);const prior=hostingRecord(this.store,peer),lease=this.store.setting<any>('takeover:'+peer.id);
      if(prior?.released&&peer.owner==='user'&&(!prior.phase||prior.phase==='awaiting_window'&&prior.verified))return{status:'paired',hosting:hostingStatus(this.store,peer)};
      if(lease?.foreground&&(await probeProcesses([lease.foreground]))[0]==='alive'){
        this.store.transaction(()=>{this.store.updatePeer(peer.id,{owner:'user'});writeHosting(this.store,this.store.peer(peer.id),{background:false,released:true,phase:undefined,verified:true,reason:undefined});});return{status:'paired',hosting:hostingStatus(this.store,this.store.peer(peer.id))};
      }
      if(lease)throw new BridgeError('holder_unknown','临时接管窗口尚未核验退出，请返回原窗口后重试。');
      if(peer.owner==='user'&&!prior?.phase&&!runtimeFor(this.home,{peerId:peer.id}))return this.waiting(peer);
      this.human(peer);const runtime=runtimeFor(this.home,{peerId:peer.id});
      if(!runtime&&prior?.released){closeHostedWindow(this.store,peer);writeHosting(this.store,this.store.peer(peer.id),{phase:'awaiting_window',verified:true,reason:undefined});return{status:'paired',hosting:hostingStatus(this.store,this.store.peer(peer.id))};}
      if(runtime&&await this.retireExitedRuntime(runtime)){closeHostedWindow(this.store,peer);this.store.updatePeer(peer.id,{owner:'user'});writeHosting(this.store,this.store.peer(peer.id),{background:false,released:true,phase:'awaiting_window',verified:true,reason:undefined});return{status:'paired',hosting:hostingStatus(this.store,this.store.peer(peer.id))};}
      if(runtime&&runtime.value.state!=='ready'&&this.ops.cleanup){
        this.store.updatePeer(peer.id,{owner:'user'});writeHosting(this.store,this.store.peer(peer.id),{background:false,released:true,phase:'releasing'});
        try{await this.ops.cleanup(this.store.peer(peer.id),runtime.value.endpoint);const remaining=runtimeFor(this.home,{peerId:peer.id});if(remaining&&!await this.retireExitedRuntime(remaining))throw new BridgeError('holder_unknown','启动中的原后台尚未核验退出。');closeHostedWindow(this.store,this.store.peer(peer.id));writeHosting(this.store,this.store.peer(peer.id),{phase:'awaiting_window',verified:true,reason:undefined});return{status:'paired',hosting:hostingStatus(this.store,this.store.peer(peer.id))};}catch(error){this.failed(this.store.peer(peer.id),error,'releasing');throw error;}
      }
      const endpoint=this.store.endpoint(peer.id)??(runtime?{peerId:peer.id,address:runtime.value.endpoint,epoch:runtime.value.endpoint,mode:'app-server' as const,pid:runtime.value.pid??null,procStart:runtime.value.procStart??null,configHome:runtime.value.configHome,active:false,seenAt:Date.now()}:this.store.endpoints(peer.id).filter(ep=>ep.mode==='app-server').sort((a,b)=>b.seenAt-a.seenAt)[0]);
      if(!endpoint)throw new BridgeError('holder_unknown','没有可核验的原后台端点，未报告可以打开原会话。');
      const pairId=this.store.pairFor(peer.id)!.id,id=peer.sessionId!,guard=()=>{const current=this.store.peer(peer.id);this.ops.enabled(current);const record=hostingRecord(this.store,current);if(current.sessionId!==id||this.store.pairFor(current.id)?.id!==pairId||!record?.released)throw new BridgeError('session_changed','释放期间会话或选择已变化。');};
      this.store.transaction(()=>{this.store.updatePeer(peer.id,{owner:'user'});writeHosting(this.store,this.store.peer(peer.id),{background:false,released:true,phase:'releasing',reason:undefined,verified:false});});
      try{await this.ops.stop(this.store.peer(peer.id),endpoint,guard);guard();closeHostedWindow(this.store,this.store.peer(peer.id));writeHosting(this.store,this.store.peer(peer.id),{phase:'awaiting_window',verified:true,userStep:`原后台已退出。按平时方式打开原会话 ${id}（目录 ${peer.cwd}）。`});return{status:'paired',hosting:hostingStatus(this.store,this.store.peer(peer.id))};}
      catch(error){this.failed(this.store.peer(peer.id),error,'releasing');throw error;}
    });
  }
  private async retireExitedRuntime(record:RuntimeRecord):Promise<boolean>{
    if(await managedRuntimeNativeState(this.home,record.value)!=='dead')return false;
    if(await managedRuntimeState(this.home,record.value)==='dead')removeManagedRuntime(record);
    else if(record.value.kind==='owned'&&record.value.state!=='failed'){record.value.state='failed';saveManagedRuntime(this.home,record.value);}
    return true;
  }
  private async assertNoExternalHolder(peer:Peer):Promise<void>{
    const targetHome=hostingRecord(this.store,peer)?.configHome,records=managedRuntimes(this.home),owned=ownedProcesses(this.home).records;
    const rows=await(this.ops.processes?.('codex')??knownNativeProcesses(this.home,'codex',targetHome));
    for(const {value:runtime} of records){
      if(runtime.peerId===peer.id||runtime.configHome&&!sameDirectory(runtime.configHome,hostingRecord(this.store,peer)?.configHome??''))continue;
      const state=await managedRuntimeNativeState(this.home,runtime);if(state==='dead')continue;
      const endpoint:Endpoint={peerId:peer.id,mode:'app-server',address:runtime.endpoint,epoch:runtime.id,pid:runtime.pid??null,procStart:runtime.procStart??null,configHome:runtime.configHome,seenAt:Date.now(),active:true};
      const loaded=state==='alive'&&this.ops.loaded?await this.ops.loaded(peer,endpoint):'unknown';
      if(loaded!=='dead')throw new BridgeError(loaded==='alive'?'holder_active':'holder_unknown','另一后台仍可能持有原会话（端点 '+runtime.endpoint+'）；等待原线程卸载后再接手。');
    }
    const deadline=Date.now()+10000;
    for(const row of rows){
      if(Date.now()>deadline)throw new BridgeError('holder_unknown','原生持有者核验尚未完成，请稍后重试。');
      if(records.some(r=>r.value.pid===row.pid&&r.value.procStart===row.startedAt)||owned.some(r=>r.identity.pid===row.pid&&r.identity.startedAt===row.startedAt))continue;
      try{
      const identity=await(this.ops.identity??processIdentity)(row.pid);
      if(identity.startedAt!==row.startedAt)throw new BridgeError('holder_unknown','原生进程在核验期间变化。');
      const configHome=row.configHome??await nativeConfigHome(identity,'codex');if(configHome&&targetHome&&!sameDirectory(configHome,targetHome))continue;
      const args=await codexArguments(identity,1500);
      if(args.includes('--managed-daemon')){
        const loaded=this.ops.daemon?await this.ops.daemon(peer,{pid:identity.pid,procStart:identity.startedAt}):'unknown';
        if(loaded!=='dead')throw new BridgeError(loaded==='alive'?'holder_active':'holder_unknown',`共享 Codex daemon（PID ${row.pid}）${loaded==='alive'?'仍加载原会话':'的线程状态尚无法核验'}；请先在 ChatGPT 或 Codex 窗口关闭该会话，然后重试。`);
        continue;
      }
      if(!codexAppServerArguments(args)&&args.includes(peer.sessionId!))throw new BridgeError('holder_active',`原会话仍由 Codex 窗口 PID ${row.pid} 持有，请退出该窗口后重试。`);
      if(codexAppServerArguments(args)&&!args.includes('--managed-daemon')&&!args.includes('proxy')&&!args.some(arg=>/[\\/]app-server-(?:control|daemon)[\\/]/i.test(arg)))throw new BridgeError('holder_unknown',`原生 App Server（PID ${row.pid}）可能仍持有原会话，当前无法观察其线程。请先在 ChatGPT 应用中关闭该会话；若仍受阻，完全退出 ChatGPT 应用或对应 Codex 应用，再运行 nxbridge adopt codex --member ${peer.id} 重试。`);
      }catch(error){
        const code=(error as {code?:string}).code;if(code==='process_missing')continue;
                                               
        if(['ENOENT','ESRCH','process_identity_unknown'].includes(code??''))try{await(this.ops.identity??processIdentity)(row.pid);}catch(current){if((current as {code?:string}).code==='process_missing')continue;}
        throw error;
      }
    }
  }
}
