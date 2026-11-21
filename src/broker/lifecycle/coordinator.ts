import type {Store} from '../../storage/store.js';
import {otherHost,type BridgeConfig,type Endpoint,type Peer,type RegisterInput} from '../../types.js';
import type {Adapters} from '../coordinator.js';
import type {DeletedSessions} from '../deleted-sessions.js';
import type {PartnerProfileCoordination} from '../profiles/coordination.js';
import type {BrokerHealthCoordinator} from '../health/coordinator.js';
import type {DeliveryHealth} from '../health/delivery.js';
import type {CodexDaemons} from '../../hosts/codex/codex-daemon.js';
import type {CodexDirectDelivery} from '../../hosts/codex/codex-direct.js';
import type {Takeovers} from '../recovery/takeover.js';
import {hostingRecord,writeHosting,closeHostedWindow,type SessionTransfers} from '../recovery/session-hosting.js';
import {managedRecoveryKey,recoveryPrecondition,recoveryUserStep,type ManagedRecovery,type ManagedIncident,type RecoveryNotice} from '../recovery/managed-recovery.js';
import {returnLegacyTakeover} from '../recovery/legacy-takeover.js';
import {type ManagedConflict,clearManagedConflict} from '../recovery/managed-conflicts.js';
import {reconcileManagedCodexConflict} from '../../hosts/managed-registration.js';
import {claudeAutoHolds,claudeAutoKey,observeClaudeAuto,type ClaudeAutoFallback} from '../../hosts/claude/claude-auto-mode.js';
import {claudeChild,childHandoff,type ClaudeChildRecord} from '../../hosts/claude/claude-child.js';
import {nativeOwnership} from '../../process/owned-native.js';
import {ownedProcesses} from '../../process/owned-processes.js';
import {probeProcesses,liveProcess} from '../../process/process.js';
import {runtimeFor} from '../../hosts/managed-runtimes.js';
import {codexUserWindow} from '../../hosts/codex/codex-lineage.js';
import {partnerConfigHome} from '../pairing/pair-restore.js';
import {selectHostLaunch} from '../../hosts/host-launch.js';
import {launchInputFingerprint,parkLaunchFailure} from '../../hosts/launch-park.js';
import {restoreBootstrapKey} from '../../hosts/codex/codex-isolation.js';
import {nativeProfileEffort} from '../../integration/mod/mod-protocol.js';
import {memberEnabled,requireMemberEnabled} from '../member-control.js';
import {BridgeError,describeError} from '../../shared/errors.js';
import {sameDirectory} from '../../shared/files.js';
import {delay} from '../../shared/time.js';
import {randomUUID} from 'node:crypto';
import {SKIPPED} from '../fault-boundary.js';

interface LifecycleEnvironment {readonly store:Store;readonly config:BridgeConfig;readonly adapters:Adapters;readonly home:string;}
interface LifecycleServices {
  readonly profileCoordination:PartnerProfileCoordination;
  readonly deletedSessions:DeletedSessions;
  readonly takeovers:Takeovers;
  readonly managedRecovery:ManagedRecovery;
  readonly transfers:SessionTransfers;
  readonly runtimeHealth:BrokerHealthCoordinator;
  readonly deliveryHealth:DeliveryHealth;
  readonly daemons:CodexDaemons;
  readonly codexDirect:CodexDirectDelivery;
}
interface LifecycleHooks {
  stopped():boolean;
  migrateCodexIdentity(peer:Peer,endpoint:Endpoint,error:BridgeError):Promise<void>;
  pumpAfterCurrent():Promise<void>;
}
export type StoredLaunchProof=ManagedIncident['proof']&{sessionId:string;restorePairId?:string};

export function codexRequester(store:Store,peer:Peer):string|undefined{const pair=store.pairFor(peer.id);return pair?store.peer(pair.claude).sessionId??undefined:undefined;}
export function isCodexIdentityError(error:unknown):error is BridgeError{return error instanceof BridgeError&&error.code.startsWith('codex_identity_');}

                                            
export class BrokerLifecycleCoordinator {
  private memberRecoveries=new Map<string,Promise<boolean>>();
  private restoringMembers=new Set<string>();
  private recoveryDeliveryWaits=new WeakSet<Promise<boolean>>();
  private preparing=new Map<string,Promise<void>>();
  private retiring=new Set<string>();
  private releases=new Map<string,Promise<string[]>>();
  private retryAt=new Map<string,number>();
  private recoveryFailures=new Map<string,number>();
  private recoveryAt=new Map<string,number>();
  private parkChecks=new Map<string,number>();
  private fastObserving?:Promise<void>;
  private restarting=new Set<string>();
  constructor(private readonly environment:LifecycleEnvironment,private readonly services:LifecycleServices,private readonly hooks:LifecycleHooks){}
  private enabled(id:string):boolean{const peer=this.environment.store.getPeer(id);return !!peer&&memberEnabled(this.environment.store,peer);}
  private requireEnabled(peer:Peer):void{requireMemberEnabled(this.environment.store,peer);}
  private async pumpStage(stage:string,work:()=>unknown|Promise<unknown>):Promise<boolean>{return this.environment.store.faults.run(stage,work);}
  private background(stage:string,work:()=>unknown|Promise<unknown>):void{
    if(this.hooks.stopped())return;
    void this.services.runtimeHealth.trackHealth(this.pumpStage(stage,work));
  }
  get pending():boolean{return !!(this.memberRecoveries.size||this.fastObserving||this.preparing.size||this.restarting.size);}
  isPreparing(id:string):boolean{return this.preparing.has(id);}
  isRestarting(id:string):boolean{return this.restarting.has(id);}
  isRetiring(id:string):boolean{return this.retiring.has(id);}
  isRestoring(id:string):boolean{return this.restoringMembers.has(id);}
  preparation(id:string):Promise<void>|undefined{return this.preparing.get(id);}
  recoveryWork(id:string):Promise<boolean>|undefined{return this.memberRecoveries.get(id);}
  async waitForRelease(id:string):Promise<void>{await this.releases.get(id);}
  async waitForReleases():Promise<void>{await Promise.allSettled(this.releases.values());}
  beginRestart(id:string):()=>void{this.restarting.add(id);return()=>{this.restarting.delete(id);};}
  retryPending(id:string):boolean{return (this.retryAt.get(id)??0)>Date.now();}
  delayRetry(id:string,delayMs:number):void{this.retryAt.set(id,Date.now()+delayMs);}
  clearRetryDelay(id:string):void{this.retryAt.delete(id);this.recoveryAt.delete(id);}
  clearBackoff(id:string):void{this.clearRetryDelay(id);this.recoveryFailures.delete(id);}
  launchInputsChanged(id?:string):void{if(id===undefined)this.parkChecks.clear();else this.parkChecks.delete(id);}

  async prepare(peer:Peer,extraReason?:string,provisional?:{peerId:string;sessionId:string;authorize?:()=>void;beforeCreate?:()=>void}):Promise<void>{
    const {store,adapters}=this.environment;
    this.requireEnabled(peer);
    try{this.services.profileCoordination.profiles.initialize(peer);}catch(error){store.updatePeer(peer.id,{state:'offline',launchFailure:{at:Date.now(),...(error instanceof BridgeError?{code:error.code}:{}),message:describeError(error).slice(0,1200)}});throw error;}
    if(claudeAutoHolds(store,peer))throw new BridgeError('claude_start_pending','自动权限恢复尚未结算，未重复启动原会话；请运行 nxbridge open claude 或 doctor。');
    if(hostingRecord(store,peer)?.released)throw new BridgeError('awaiting_window','后台托管已释放，请按平时方式打开原会话；未自动恢复后台。');
    if(store.endpoint(peer.id)?.pendingContext&&peer.owner==='user')return;
    if(this.hooks.stopped()||this.retiring.has(peer.id)||!store.pairFor(peer.id)&&!provisional)throw new BridgeError('peer_releasing','搭档已离开当前配对，未启动后台进程。');
    const pending=this.preparing.get(peer.id);if(pending)return pending;
    if(this.services.deletedSessions.pendingCreation(peer.id))throw new BridgeError('session_unverified','新会话创建结果尚未核实，未重复创建；请等待原生身份登记。');
    const runtime=peer.host==='codex'?runtimeFor(this.environment.home,{peerId:peer.id})?.value:undefined;
    if(runtime)store.setSetting('managedLaunchProof:'+peer.id,{sessionId:peer.sessionId,runtimeId:runtime.id,configHome:runtime.configHome,executable:runtime.executable,profileId:runtime.profileId,version:runtime.version});
    const pairId=store.pairFor(peer.id)?.id,sessionId=peer.sessionId;
    const guard=()=>{
      const current=store.peer(peer.id),pair=store.pairFor(peer.id),sourcePair=provisional?store.pairFor(provisional.peerId):undefined;
                                          
      const selected=!!provisional&&!!pair&&pair.id===sourcePair?.id&&pair[otherHost(peer.host)]===provisional.peerId;
      if(!selected)provisional?.authorize?.();
      const intent=provisional?store.setting<{peerId:string;sessionId:string}>('implicitPartner:'+provisional.peerId):undefined;
      this.requireEnabled(current);
      if(claudeAutoHolds(store,current))throw new BridgeError('claude_start_pending','自动权限恢复尚未结算，未重复启动原会话；请运行 nxbridge open claude 或 doctor。');
      if(this.hooks.stopped()||!selected&&pair?.id!==pairId||pair?.paused||!provisional&&current.sessionId!==sessionId||provisional&&(!this.enabled(provisional.peerId)||store.peer(provisional.peerId).sessionId!==provisional.sessionId||!selected&&(intent?.peerId!==peer.id||sourcePair))||current.owner!==peer.owner||this.retiring.has(peer.id)||store.setting('managedSessionConflict:'+peer.id))throw new BridgeError('session_changed','恢复期间配对、归属或会话已经改变，未启动。');
    };
    const beforeLaunch=async()=>{
      guard();await this.assertNoLiveSessionHolder(peer);guard();
      if(this.services.takeovers.get(peer.id))throw new BridgeError('foreground_active','前台接管仍在使用原后台，未启动另一运行时。');
      if(!provisional&&peer.owner==='nxbridge'&&peer.sessionId){
        if(hostingRecord(store,peer)?.phase==='adopting')return;
        const incident=this.recoveryIncident(peer);
                                                     
        this.services.managedRecovery.absent(incident);this.services.managedRecovery.claim(incident,extraReason);
      }
    };
    const work=(async()=>{
      if(!peer.sessionId){
        const source=provisional?store.peer(provisional.peerId):pairId?store.peer(store.pairFor(peer.id)![otherHost(peer.host)]):undefined;
        let marked=false;
        const beforeCreate=provisional?.beforeCreate??(()=>{if(!marked){this.services.deletedSessions.markSelectedCreation(peer.id);marked=true;}});
        guard();if(peer.host==='codex')store.adopt(peer.id,await adapters.codex.create(peer,source?.sessionId??codexRequester(store,peer),guard,source?.permission??'unknown',beforeCreate));
        else{
          store.setSetting('ownedClaudePolicy:'+peer.id,{sessionId:null,inboundAccept:source?.permission!=='bypass'});
          const sessionId=await adapters.claude.create(peer,guard,source?.permission??'unknown',beforeCreate);
          store.setSetting('ownedClaudePolicy:'+peer.id,{sessionId,inboundAccept:source?.permission!=='bypass'});
                                            
          store.updatePeer(peer.id,{sessionId});
          for(let i=0;i<50;i++){
            if(i===0||i%10===0){const discovered=await adapters.claude.discover(sessionId);if(discovered)store.adopt(peer.id,discovered);}
            if(store.endpoint(peer.id))return;
            if(this.hooks.stopped())return;await delay(200);
          }
          throw new BridgeError('plugin_unavailable','后台 Claude 已启动，但插件尚未发布 inbox；请运行 doctor。');
        }
      }else if(peer.host==='codex'){
        const attach=async(endpoint:Endpoint)=>{
          try{if(codexUserWindow(peer))await adapters.codex.observe(peer,endpoint);else await adapters.codex.attach(peer,endpoint,{verify:hostingRecord(store,peer)?.phase==='adopting'});}
          catch(error){
            const runtime=runtimeFor(this.environment.home,{endpoint:endpoint.address})?.value;
            if(!(error instanceof BridgeError)||error.code!=='policy_verification_incomplete'||peer.owner!=='nxbridge'||!runtime?.dedicated||runtime.peerId!==peer.id||runtime.sessionVerification?.sessionId!==peer.sessionId)throw error;
            guard();const pair=store.pairFor(peer.id)!,counts=store.deliveryCounts(pair.id,pair[otherHost(peer.host)]);
            if(counts.unknown+counts.sending+counts.runtimeQueued)throw new BridgeError('delivery_unsettled','权限核验被中断且仍有未结算投递，保留原运行时及消息。');
            const result=await adapters.codex.restart(peer,endpoint,guard,{verificationRecovery:true,requesterSession:codexRequester(store,peer)});guard();
            store.deactivate(peer.id,endpoint.epoch);store.event('codex.verification.restarted',{peerId:peer.id,sessionId:peer.sessionId,oldPid:result.oldPid,pid:result.pid});
          }
        };
        const previous=store.endpoints(peer.id).filter(e=>e.mode==='app-server'&&(hostingRecord(store,peer)?.phase!=='adopting'||runtimeFor(this.environment.home,{endpoint:e.address})?.value.peerId===peer.id)).sort((a,b)=>a.seenAt-b.seenAt).at(-1);
        if(previous){try{await attach(previous);return;}catch(error){if(isCodexIdentityError(error)){await this.hooks.migrateCodexIdentity(peer,previous,error);return;}if(peer.owner!=='nxbridge')throw error;}}
        if(peer.owner==='nxbridge'){
          const original=previous??store.endpoints(peer.id).sort((a,b)=>b.seenAt-a.seenAt)[0];
          guard();
          const affinity=store.setting<ManagedIncident['proof']&{sessionId:string}>('managedLaunchProof:'+peer.id),proof=affinity?.sessionId===peer.sessionId?affinity:this.services.managedRecovery.get(peer.id)?.proof;
          const address=await adapters.codex.ensureEndpoint(peer.cwd,peer.id,codexRequester(store,peer),peer.sessionId,partnerConfigHome(store,peer,proof?.configHome??original?.configHome),beforeLaunch,proof);
          guard();
          await attach({peerId:peer.id,mode:'app-server',address,epoch:address,pid:null,procStart:null,seenAt:Date.now(),active:true});guard();
          for(const old of store.endpoints(peer.id))if(old.mode==='app-server'&&old.address!==address)store.deactivate(peer.id,old.epoch);
        }
      }else if(peer.owner==='nxbridge'){
        const saved=store.setting<ManagedIncident['proof']&{sessionId:string}>('managedLaunchProof:'+peer.id),affinity={...(saved?.sessionId===peer.sessionId?saved:{}),configHome:partnerConfigHome(store,peer)};
        guard();await adapters.claude.wake(peer,undefined,undefined,beforeLaunch,affinity);guard();const registration=await adapters.claude.discover(peer.sessionId);
        if(!registration)throw new BridgeError('plugin_unavailable','恢复的 Claude 尚未发布同一会话的 inbox。');
        store.adopt(peer.id,registration);
      }
    })().then(async()=>{await this.verifyOwnedClaudeLaunch(peer.id);const actual=store.peer(peer.id);if(actual.host==='codex')this.services.profileCoordination.profiles.observed(actual,actual);await this.services.profileCoordination.verifyInitial(actual,true);await this.services.profileCoordination.reconcile(store.peer(peer.id));});
    this.preparing.set(peer.id,work);
    try{
      await work;if(provisional)guard();
      if(peer.host==='codex')this.rememberManagedLaunch(peer.id);
      this.retryAt.delete(peer.id);this.recoveryAt.delete(peer.id);this.recoveryFailures.delete(peer.id);
      const incident=this.services.managedRecovery.get(peer.id);if(incident?.state==='recovering')this.services.managedRecovery.settled(incident);
      const saved=store.setting<StoredLaunchProof>('managedLaunchProof:'+peer.id);
      if(saved?.nativeLaunchId&&saved.sessionId===peer.sessionId&&saved.restorePairId===store.pairFor(peer.id)?.id)store.setSetting('managedLaunchProof:'+peer.id,null);
      if(store.peer(peer.id).launchFailure)store.updatePeer(peer.id,{launchFailure:undefined});
    }
    catch(error){if(peer.owner==='nxbridge'&&this.enabled(peer.id)&&!isCodexIdentityError(error)){store.updatePeer(peer.id,{state:'offline',launchFailure:{at:Date.now(),...(error instanceof BridgeError?{code:error.code}:{}),message:describeError(error).slice(0,1200)}});if(error instanceof BridgeError&&error.code==='bootstrap_policy_unsupported'&&store.pairFor(peer.id)){const key=(error as BridgeError&{bootstrapProbeKey?:string}).bootstrapProbeKey;writeHosting(store,peer,{verifying:false,reason:error.code,userStep:error.message,bootstrapProbeKey:key,nextAt:key?Number.MAX_SAFE_INTEGER:Date.now()+30000});}}throw error;}
    finally{this.preparing.delete(peer.id);}
  }
  ownedClaudeLaunchReady(peer:Peer):boolean{
    if(peer.host!=='claude'||peer.owner!=='nxbridge')return true;
    const expected=this.environment.store.setting<{sessionId:string|null;verified?:boolean;context?:string}>('ownedClaudePolicy:'+peer.id);
    return !expected||expected.verified===true&&(expected.sessionId!==peer.sessionId||expected.context===this.ownedClaudeContext(peer.id));
  }
  private ownedClaudeContext(peerId:string):string{
    const endpoint=this.environment.store.endpoint(peerId);return JSON.stringify([endpoint?.pid,endpoint?.procStart,endpoint?.bindingEpoch]);
  }
  ownedClaudeLaunchFailure(peer:Peer):Peer['launchFailure']{
    const value=peer.host==='claude'&&peer.owner==='nxbridge'?this.environment.store.setting<{sessionId:string;failure?:Peer['launchFailure']}>('ownedClaudePolicy:'+peer.id):undefined;
    return value&&value.sessionId===peer.sessionId?value.failure:undefined;
  }
  async verifyOwnedClaudeLaunch(peerId:string,wait=true):Promise<void>{
    const {store}=this.environment;
    const expected=store.setting<{sessionId:string;inboundAccept:boolean;verified?:boolean;context?:string;failure?:Peer['launchFailure']}>('ownedClaudePolicy:'+peerId);
    if(!expected)return;
    if(expected.sessionId!==store.peer(peerId).sessionId){store.setSetting('ownedClaudePolicy:'+peerId,null);return;}
    if(this.ownedClaudeLaunchReady(store.peer(peerId)))return;
    const until=Date.now()+(wait?10000:0);
    try{
    while(true){
      const peer=store.peer(peerId),endpoint=store.endpoint(peerId);
      if(peer.owner!=='nxbridge'||peer.sessionId!==expected.sessionId)throw new BridgeError('session_changed','新后台权限核验期间会话已改变，原任务未提交。');
      const mode=endpoint?.nativePermission?.mode,decision=endpoint?.nativeDecision,knownMode=!!mode&&mode!=='unknown';
      if(knownMode&&mode!=='bypassPermissions'||decision&&decision.bash!=='allow')throw new BridgeError('claude_bypass_disabled','原生 Claude 未采用无人审批的全部放行策略，组织或项目设置可能限制了它；后台尚未接收任务，请由用户或管理员检查原生权限策略。');
      if(endpoint&&(mode==='bypassPermissions'||decision?.bash==='allow'&&decision.rule===undefined)){
        if(!expected.inboundAccept||endpoint.nativeInbound&&endpoint.nativeInbound.policy!=='unknown'){
          if(expected.inboundAccept&&endpoint.nativeInbound?.policy!=='accept')throw new BridgeError('claude_inbound_restricted',`原生 Claude 没有采用本次启动请求的入站接收策略（${endpoint.nativeInbound?.source??'unknown'}：${endpoint.nativeInbound?.policy??'unknown'}），后台尚未接收任务；请由用户检查对应的组织或项目设置。`);
          store.setSetting('ownedClaudePolicy:'+peerId,{...expected,verified:true,context:this.ownedClaudeContext(peerId),failure:undefined});
          store.event('claude.launch.verified',{peerId,sessionId:peer.sessionId,mode:mode??'unknown',decision:decision?.bash,inbound:endpoint?.nativeInbound?.policy,inboundSource:endpoint?.nativeInbound?.source});return;
        }
      }
      if(this.hooks.stopped()||Date.now()>=until)throw new BridgeError('claude_policy_unverified','新后台已经创建，但原生权限与入站策略尚未核验；任务未提交，原草稿保留，稍后重试原操作即可。');
      await delay(200);
    }
    }catch(error){
      store.setSetting('ownedClaudePolicy:'+peerId,{...expected,verified:false,failure:{at:Date.now(),code:(error as BridgeError).code,message:describeError(error).slice(0,1200)}});throw error;
    }
  }
  async recover(peer:Peer,extraReason?:string):Promise<boolean>{
    const {store}=this.environment;
    if(!this.enabled(peer.id))return false;
    if(peer.owner==='user'&&store.setting('legacyTakeoverNeedsUser:'+peer.id))return false;
    const hosting=hostingRecord(store,peer);
    const previousIncident=this.services.managedRecovery.get(peer.id),park=hosting?.launchPark??previousIncident?.launchPark;
    if(park){
      if((this.parkChecks.get(peer.id)??0)>performance.now())return false;
      this.parkChecks.set(peer.id,performance.now()+30000);
      const proof=park.proof??store.setting<ManagedIncident['proof']>('managedLaunchProof:'+peer.id)??previousIncident?.proof??{},configHome=park.configHome??hosting?.configHome??previousIncident?.configHome??'';
      if(launchInputFingerprint(this.environment.home,this.environment.config,peer,configHome,proof)===park.fingerprint)return false;
      if(hosting?.launchPark)writeHosting(store,peer,{launchPark:undefined,bootstrapProbeKey:undefined,reason:undefined,userStep:undefined,nextAt:undefined});
      if(previousIncident?.launchPark)this.services.managedRecovery.rearm(previousIncident);
      this.recoveryAt.delete(peer.id);this.retryAt.delete(peer.id);this.parkChecks.delete(peer.id);
      store.event('recovery.inputs_changed',{peerId:peer.id,code:park.code});
    }
    if(peer.host==='codex'&&hosting?.reason==='bootstrap_policy_unsupported'&&hosting.bootstrapProbeKey){
      const proof=store.setting<ManagedIncident['proof']&{sessionId:string}>('managedLaunchProof:'+peer.id);
      try{const selected=selectHostLaunch('codex',this.environment.config,{home:this.environment.home,sessionId:peer.sessionId!,cwd:peer.cwd,configHome:hosting.configHome,...(proof?.executable?{executable:proof.executable,profileId:proof.profileId}:{})});if(restoreBootstrapKey(selected)!==hosting.bootstrapProbeKey){writeHosting(store,peer,{reason:undefined,userStep:undefined,bootstrapProbeKey:undefined,nextAt:undefined});this.recoveryAt.delete(peer.id);}}catch{                              }
    }
    if((this.recoveryAt.get(peer.id)??0)>Date.now()||(hostingRecord(store,peer)?.nextAt??0)>Date.now())return false;
    let incident:ManagedIncident|undefined;
    if(peer.owner==='nxbridge'&&peer.sessionId){const previous=this.services.managedRecovery.get(peer.id);if(previous?.state!=='closed')incident=previous;if(incident&&!extraReason&&!this.services.managedRecovery.due(incident))return false;}
    try{
      if(peer.host==='codex'&&hostingRecord(store,peer)?.phase==='adopting'){await this.services.transfers.adopt(peer);return true;}
      if(peer.owner==='nxbridge'){
        await this.prepare(peer,extraReason);
        if(store.peer(peer.id).state==='offline'||!store.endpoint(peer.id))throw new BridgeError('recovery_pending','原会话尚未恢复就绪。');
      }else{
                                         
        const endpoint=store.endpoints(peer.id).filter(e=>e.mode==='app-server').sort((a,b)=>a.seenAt-b.seenAt).at(-1);
        if(!endpoint)return false;
        await this.environment.adapters.codex.connect(endpoint.address);
        const current=store.endpoints(peer.id).filter(e=>e.mode==='app-server').sort((a,b)=>a.seenAt-b.seenAt).at(-1);
        if(current?.epoch!==endpoint.epoch||current.bindingEpoch!==endpoint.bindingEpoch||store.peer(peer.id).sessionId!==peer.sessionId)return false;
        store.saveEndpoint({...current,active:true,seenAt:Date.now()});
      }
      incident??=this.services.managedRecovery.get(peer.id);this.recoveryAt.delete(peer.id);this.recoveryFailures.delete(peer.id);if(incident&&incident.state!=='closed'){this.services.managedRecovery.settled(incident);this.publishRecovery(incident,peer,'restored same session; no task replayed');}return true;
    }catch(error){
      if(isCodexIdentityError(error))return false;
      if(peer.owner==='nxbridge'&&peer.sessionId)incident=this.recoveryIncident(peer);
      if(incident){
        if(recoveryPrecondition(error))this.services.managedRecovery.blocked(incident,error,parkLaunchFailure(error,this.environment.home,this.environment.config,peer,incident.configHome,incident.proof));
        else if(!['recovery_backoff','recovery_exhausted','recovery_rate_limited','recovery_not_exhausted'].includes((error as BridgeError).code))this.services.managedRecovery.settled(incident,error,!!incident.attempts.length&&['runtime_launch_unconfirmed','claude_start_pending','claude_child_pending','claude_release_pending','recovery_uncertain','timeout'].includes((error as BridgeError).code));
        this.publishRecovery(this.services.managedRecovery.get(peer.id)!,peer,'recovery held: '+describeError(error));return false;
      }
      const failures=(this.recoveryFailures.get(peer.id)??0)+1,wait=Math.min(60000,1000*2**Math.min(failures-1,6));
      this.recoveryFailures.set(peer.id,failures);this.recoveryAt.set(peer.id,Date.now()+wait);
      store.event('recovery.failed',{peerId:peer.id,retryInMs:wait,error:describeError(error)});return false;
    }
  }
  private recoveryIncident(peer:Peer):ManagedIncident{
    const {store}=this.environment;
    const pair=store.pairFor(peer.id);if(!pair)throw new BridgeError('unpaired','成员已离开配对，未恢复。');
    const endpoint=store.endpoints(peer.id).sort((a,b)=>b.seenAt-a.seenAt)[0],runtime=peer.host==='codex'?runtimeFor(this.environment.home,{peerId:peer.id})?.value:undefined;
    const saved=store.setting<ManagedIncident['proof']&{sessionId:string}>('managedLaunchProof:'+peer.id),proof=runtime?{runtimeId:runtime.id,configHome:runtime.configHome,executable:runtime.executable,version:runtime.version,profileId:runtime.profileId}:saved?.sessionId===peer.sessionId?saved:{};
    const incident=this.services.managedRecovery.observe(peer,pair,endpoint,proof);
    if(!incident.notice){const health=this.services.runtimeHealth.peerHealth(peer),children=store.peers().filter(child=>child.kind==='subagent'&&['busy','starting','needsHuman','unknown'].includes(child.state)&&(child.rootPeerId===peer.id||child.parentId===peer.sessionId)).map(child=>child.sessionId!).filter(Boolean).slice(0,32);incident.notice={incident_id:incident.id,partner:peer.name,happened:'native endpoint unavailable at '+new Date(incident.openedAt).toISOString(),nxbridge_did:'read-only reconciliation',msgs:{held:0,uncertain:0},wake:false,...(health&&!['ready','failed'].includes(health.state)||children.length?{interrupted:{turn_id:health?.turnId,tools:health?.tools.slice(0,16)??[],children,effects:'prior tool effects require history inspection; nothing replayed'}}:{})};store.setSetting(managedRecoveryKey(peer.id),incident);}
    return incident;
  }
  private publishRecovery(incident:ManagedIncident,peer:Peer,did:string):void{
    const {store}=this.environment;
    const pair=store.pairFor(peer.id);if(!pair||pair.id!==incident.pairId)return;
    const recipient=store.peer(pair[otherHost(peer.host)]),bootstrapToClaude=incident.state==='blocked'&&incident.preconditionCode==='bootstrap_required'&&recipient.host==='claude';
    const counts=store.deliveryCounts(pair.id,pair[otherHost(peer.host)]),extra=incident.state==='exhausted'&&incident.attempts.filter(row=>!row.extra&&!row.user).length===3&&!incident.attempts.some(row=>row.extra),unfinished=incident.state==='ready'&&incident.attempts.length>0&&!!incident.notice?.interrupted;
    const prior={...incident.notice!};delete prior.ai_action;delete prior.user_step;
    const step=recoveryUserStep(peer,incident),payload:RecoveryNotice={...prior,incident_id:incident.id,partner:peer.name,nxbridge_did:did,msgs:{held:counts.held+counts.accepted,uncertain:counts.unknown+counts.sending+counts.runtimeQueued},wake:!incident.wakeAdmitted&&(extra||unfinished),...(bootstrapToClaude?{ai_action:'attempt nxbridge bootstrap once; it verifies independent launch before handover. If refused, tell the user in the originating window to run nxbridge bootstrap in ordinary PowerShell outside Claude/Codex. Keep pending messages; do not resend.'}:extra?{ai_action:'inspect recovery; request recover_partner retry once with recorded reason'}:unfinished?{ai_action:'inspect original history, partial work and unresolved effects; decide whether a NEW authorized check-progress instruction is needed'}:{}),...(step?{user_step:step}:{})};
    incident.notice=payload;store.setSetting(managedRecoveryKey(peer.id),incident);
    const message='nxbridge runtime notice (not partner task or user approval): '+JSON.stringify(payload)+'; to stop managed recovery, human may use nxbridge off '+peer.host+' or unpair.';
    if(!incident.noticeAdmitted||payload.wake)this.services.deliveryHealth.enqueue(pair.id,recipient.id,{id:incident.noticeId+(incident.noticeAdmitted?':action':''),message,state:'pending',source:'managed_recovery',kind:'managed_recovery:'+peer.id,scope:this.services.runtimeHealth.noticeScope(pair,recipient),incidentId:incident.id,recovery:payload,wake:payload.wake,tier:bootstrapToClaude?3:undefined});
  }
  observeManagedExits():Promise<void>{
    const {store}=this.environment;
    if(this.fastObserving)return this.fastObserving;
    const work=(async()=>{
      for(const pair of store.pairs())for(const id of [pair.claude,pair.codex]){
        if(this.hooks.stopped())return;
        await this.pumpStage('managed_exit:'+id,async()=>{
        const peer=store.peer(id);if(!this.enabled(id)||!peer.sessionId||!['root','fork'].includes(peer.kind))return;
        if(peer.owner==='user')await returnLegacyTakeover(store,this.environment.home,peer);
        const legacy=store.setting<{sessionId:string;user_step:string}>('legacyTakeoverNeedsUser:'+id);
        if(legacy?.sessionId===peer.sessionId){const recipient=store.peer(pair[otherHost(peer.host)]);this.services.deliveryHealth.enqueue(pair.id,recipient.id,{id:'legacy-takeover:'+id,source:'pair_anomaly',kind:'legacy_takeover:'+id,state:'pending',scope:this.services.runtimeHealth.noticeScope(pair,recipient),factKey:JSON.stringify([id,peer.sessionId]),message:`nxbridge runtime notice (not partner task or user approval): earlier takeover ownership cannot be verified; no automatic launch or stop. User: open original ${peer.host} config home in ${peer.cwd} and run ${legacy.user_step}; same-session continuity is preserved when verified.`});}
        const takeover=this.services.takeovers.get(id);if(takeover)await this.returnTakeover(id,takeover.id);
        const endpoints=store.endpoints(id),endpoint=endpoints.filter(ep=>ep.active&&!ep.daemon).sort((a,b)=>b.seenAt-a.seenAt)[0];
        if(endpoint?.pid&&!liveProcess(endpoint.pid)){if(peer.host==='codex'&&peer.owner==='user')closeHostedWindow(store,peer,endpoint.epoch);else{store.deactivate(id,endpoint.epoch);if(peer.state!=='paused')store.updatePeer(id,{state:'offline'});}}
        const conflict=store.setting<ManagedConflict>('managedRuntimeConflict:'+id);
        if(conflict&&peer.host==='codex'){
          await reconcileManagedCodexConflict(store,this.environment.home,store.peer(id),(runtime,session)=>this.environment.adapters.codex.inspectThread(runtime,session));
          if(store.setting('managedRuntimeConflict:'+id)&&endpoint?.mode==='app-server'&&await this.environment.adapters.codex.sessionState({...peer,sessionId:conflict.sessionId},endpoint)==='dead')clearManagedConflict(store,id,conflict.runtimeId,conflict.sessionId,conflict);
        }
        await this.services.transfers.reconcileOwned(store.peer(id));
        const hosting=hostingRecord(store,store.peer(id));
        if(peer.host==='codex'&&hosting?.phase==='releasing'&&(hosting.nextAt??0)<=Date.now()&&!this.services.takeovers.get(id)){this.background('hosting_release:'+id,()=>this.services.transfers.release(store.peer(id)));return;}
        if(peer.host==='codex'&&hosting?.background&&!hosting.released&&(hosting.nextAt??0)<=Date.now()&&peer.owner==='user'&&!pair.paused&&!this.services.takeovers.get(id)&&(this.recoveryAt.get(id)??0)<=Date.now()){
          const state=await this.nativeSessionState(store.peer(id));if(state==='dead'){closeHostedWindow(store,store.peer(id));this.background('hosting_adopt:'+id,()=>this.services.transfers.adopt(store.peer(id)));return;}
        }
        });
      }
    })().finally(()=>{if(this.fastObserving===work)this.fastObserving=undefined;});this.fastObserving=work;return work;
  }
  recoveryStatus(peer:Peer){
    const {store}=this.environment;
    if(store.setting('managedSessionConflict:'+peer.id))return{incident_id:'conflict:'+peer.id,state:'blocked',attempts_used:0,attempts_max:3,precondition:'session_conflict',user_step:'nxbridge pair',held:0,uncertain:0};
    const legacy=store.setting<{sessionId:string;user_step:string}>('legacyTakeoverNeedsUser:'+peer.id);if(legacy?.sessionId===peer.sessionId)return{incident_id:'legacy:'+peer.id,state:'blocked',attempts_used:0,attempts_max:3,precondition:'legacy_takeover_unverified',user_step:legacy.user_step,held:0,uncertain:0};
    const adopted=store.setting<{at:number;sessionId:string}>('managedAdopted:'+peer.id);if(adopted?.sessionId===peer.sessionId&&Date.now()-adopted.at<60000)return{incident_id:'adopted:'+peer.id,state:'ready',attempts_used:0,attempts_max:3,held:0,uncertain:0,adopted:true};
    const value=this.services.managedRecovery.get(peer.id);if(!value||value.sessionId!==peer.sessionId||value.state==='closed')return undefined;
    const pair=store.pairFor(peer.id),counts=pair?store.deliveryCounts(value.pairId,pair[otherHost(peer.host)]):undefined;
    return{incident_id:value.id,state:value.state==='pending'?'recovering':value.state,attempts_used:value.attempts.filter(row=>!row.extra&&!row.user).length,attempts_max:3,extra_used:value.attempts.some(row=>row.extra),next_at:value.nextAt||undefined,precondition:value.preconditionCode,user_step:value.notice?.user_step,held:(counts?.held??0)+(counts?.accepted??0),uncertain:(counts?.unknown??0)+(counts?.sending??0)+(counts?.runtimeQueued??0)};
  }
  async nativeSessionState(peer:Peer):Promise<'alive'|'dead'|'unknown'>{
    const all=this.environment.store.endpoints(peer.id).sort((a,b)=>b.seenAt-a.seenAt),active=all.filter(ep=>ep.active),endpoints=active.length?active:all.slice(0,1);if(!endpoints.length)return'dead';
    const states=await Promise.all(endpoints.map(async endpoint=>{
      const native=endpoint.native??endpoint;if(!native.pid||!native.procStart)return'unknown' as const;
      const state=(await probeProcesses([{pid:native.pid,procStart:native.procStart}]))[0]??'unknown';
      if(state!=='alive'||peer.host!=='codex')return state;
      if(endpoint.daemon){
        try{const connection=endpoint.configHome?await this.services.daemons.scan(endpoint.configHome,{pid:native.pid,procStart:native.procStart},true):undefined;return connection?connection.threads.some(thread=>thread.id===peer.sessionId)?'alive' as const:'dead' as const:'unknown' as const;}
        catch(error){if(error instanceof BridgeError&&error.code==='daemon_snapshot_changed')return'unknown' as const;throw error;}
      }
      if(endpoint.mode!=='app-server')return state;
      return this.environment.adapters.codex.sessionState?this.environment.adapters.codex.sessionState(peer,endpoint):'unknown' as const;
    }));return states.includes('alive')?'alive':states.every(state=>state==='dead')?'dead':'unknown';
  }
  async assertNoLiveSessionHolder(peer:Peer):Promise<void>{
    const {store}=this.environment;
    if(!peer.sessionId)return;const home=partnerConfigHome(store,peer),homes=[...store.endpoints(peer.id).flatMap(ep=>ep.configHome?[ep.configHome]:[]),...(home?[home]:[])];
    const holders=()=>store.peersForSession(peer.host,peer.sessionId!).filter(other=>other.id!==peer.id&&['root','fork'].includes(other.kind)).flatMap(other=>store.endpoints(other.id).filter(ep=>ep.active&&ep.configHome&&homes.some(home=>sameDirectory(home,ep.configHome!))).map(endpoint=>({peer:other,endpoint})));
    const others=holders(),snapshot=JSON.stringify(others);
    for(const {peer:other} of others)if(await this.nativeSessionState(other)!=='dead')throw new BridgeError('foreground_active','同一配置目录和会话仍由另一成员使用，或其状态待核验，未重复恢复。');
                                    
    if(JSON.stringify(holders())!==snapshot)throw new BridgeError('session_changed','核验期间原会话的持有窗口已经改变，请重新选择。');
  }
  returnClaudeChild(peer:Peer,child:ClaudeChildRecord,handoffId:string):void{
    const endpoint=this.environment.store.endpoint(peer.id),profile=endpoint?.nativeProfile;
                                       
    const current=profile?.model&&endpoint?.pid===child.foreground?.pid&&endpoint?.procStart===child.foreground?.startedAt?{model:profile.model,...(profile.effortUnverified||profile.runtimeEffort!==undefined||profile.effortOverride!==undefined||profile.effective?.effort!==undefined?{effort:nativeProfileEffort(profile)}:{})}:undefined;
    if(current&&profile?.effortUnverified)this.environment.store.event('partner.profile.unverified',{peerId:peer.id,sessionId:peer.sessionId,field:'effort',action:'host_default'});
    childHandoff(this.environment.home,peer.id,'stopped',handoffId,current);
  }
  async returnTakeover(peerId:string,leaseId:string,foregroundEnded=false):Promise<boolean>{
    const {store}=this.environment;
    const lease=this.services.takeovers.get(peerId);if(!lease)return true;
    if(lease.adopted&&!lease.adopted.retirementChecked&&store.peer(peerId).host==='codex'&&lease.adopted.endpoint){
      lease.adopted.retirementChecked=true;store.setSetting('takeover:'+peerId,lease);
      const references=store.endpoints().filter(ep=>{const peer=store.peer(ep.peerId);return ep.active&&!(ep.mode==='app-server'&&peer.host==='codex'&&peer.kind==='subagent');}),note=await this.environment.adapters.codex.releaseRuntime(references,lease.adopted.endpoint.address,[{...store.peer(peerId),owner:'nxbridge'}]);
      if(note)store.event('takeover.old_runtime_retained',{peerId,note});
    }
    if(!await this.services.takeovers.returned(peerId,leaseId,foregroundEnded))return false;
    const peer=store.peer(peerId);if(peer.sessionId!==lease.sessionId||store.pairFor(peerId)?.id!==lease.pairId)return true;
    this.services.profileCoordination.profiles.clear(peer);
    if(peer.host==='codex'&&hostingRecord(store,peer)?.released){
      closeHostedWindow(store,peer);writeHosting(store,peer,{phase:'releasing'});
      try{await this.services.transfers.release(store.peer(peerId));}catch(error){store.event('hosting.release_pending',{peerId,reason:describeError(error)});}return true;
    }
    if(lease.adopted){store.deactivate(peerId);const binding=store.bindings.current(peerId);if(binding)store.bindings.save({...binding,active:false});if(lease.adopted.endpoint)store.saveEndpoint({...lease.adopted.endpoint,active:false,seenAt:Date.now()});store.updatePeer(peerId,{owner:'nxbridge',state:'offline'});store.setSetting('managedAdopted:'+peerId,null);store.event('takeover.custody_returned',{peerId,sessionId:peer.sessionId});return true;}
    const child=peer.host==='claude'?claudeChild(this.environment.home,peerId):undefined;
    if(child&&lease.handoffId&&['handoff','user'].includes(child.phase))this.returnClaudeChild(peer,child,lease.handoffId);
    if(lease.kind==='child'||lease.endpoint?.pid&&!liveProcess(lease.endpoint.pid)){store.deactivate(peerId);if(peer.owner==='nxbridge'&&peer.state!=='paused')store.updatePeer(peerId,{state:'offline'});}
    return true;
  }
  completeClaudeAuto(peer:Peer,discovered:RegisterInput,value:ClaudeAutoFallback):ClaudeAutoFallback{
    const {store}=this.environment;
    if(discovered.sessionId===value.old_session_id)throw new BridgeError('session_changed','原生权限恢复没有创建新的会话 ID，未覆盖原上下文。');
    const provisional=store.peers().find(candidate=>candidate.id!==peer.id&&candidate.host==='claude'&&candidate.sessionId===discovered.sessionId&&store.endpoints(candidate.id).some(ep=>ep.pid===discovered.endpoint.pid&&ep.procStart===discovered.endpoint.procStart));
    const observed=provisional?store.endpoint(provisional.id):undefined,permission=observed?.nativePermission??discovered.endpoint.nativePermission;
                                                                 
    if(permission&&permission.mode!=='unknown'&&permission.mode!=='default')throw new BridgeError('policy_verification_failed','手动副本的实际权限模式与启动要求不符，保留启动记录，未继续投递。');
    const binding=store.bindings.current(peer.id),completed={...value,phase:'ready' as const,phase_at:Date.now(),session_id:discovered.sessionId,mode_checked:permission?.mode==='default',error:undefined};
    store.transaction(()=>{
      store.deactivate(peer.id);if(binding)store.bindings.save({...binding,active:false});
      store.adopt(peer.id,{...discovered,contextReason:'fork',endpoint:{...observed,...discovered.endpoint}},provisional?.id);
      store.setSetting(claudeAutoKey(peer.id),completed);store.event('claude.auto.replaced',{peerId:peer.id,oldSessionId:value.old_session_id,sessionId:discovered.sessionId});
    });return completed;
  }
  private notifyClaudeAuto(peer:Peer,value:ClaudeAutoFallback):void{
    const pair=this.environment.store.pairFor(peer.id);if(!pair||pair.id!==value.pair_id||!['ready','unknown','blocked'].includes(value.phase)||value.notified_phase===value.phase)return;
    const id=randomUUID(),recipient=this.environment.store.peer(pair.codex),blocked=`The ${value.tool} action was denied and NOT done; no task or message replayed.`;
    const text=value.phase==='ready'?`Claude auto mode classifier unavailable; nxbridge used a native Manual copy with history. Member/pair retained; old_session_id=${value.old_session_id}; session_id=${value.session_id}. ${blocked} Inspect progress, then send a NEW instruction only if still authorized. Actions needing approval wait for the user in nxbridge open claude.`:value.phase==='blocked'?`Claude auto mode classifier unavailable; original session retained: ${value.error}. Messages continue normally; checked actions remain denied. ${blocked} User can run nxbridge open claude.`:`Claude auto mode classifier unavailable; recovery needs inspection: ${value.error}. ${blocked} Uncertain replacement launch will not be repeated. Run nxbridge open claude or doctor; do not resume old sessions or stop user windows.`;
    this.services.deliveryHealth.enqueue(pair.id,recipient.id,{id,message:'nxbridge runtime notice (not partner task or user approval): '+text,state:'pending',source:'claude_auto_mode',kind:'claude_auto_mode:'+peer.id,factKey:value.old_session_id+':'+value.phase,scope:this.services.runtimeHealth.noticeScope(pair,recipient),wake:true});
    this.environment.store.setSetting(claudeAutoKey(peer.id),{...value,notice_id:id,notified_phase:value.phase});
  }
  async sweepClaudeAuto():Promise<void>{
    const {store,home}=this.environment;
    for(const pair of store.pairs()){
      const peer=store.peer(pair.claude),endpoint=store.endpoint(peer.id);
      if(endpoint)observeClaudeAuto(store,peer,endpoint);
      let value=store.setting<ClaudeAutoFallback>(claudeAutoKey(peer.id));
      if(!value||value.pair_id!==pair.id||value.old_session_id!==peer.sessionId&&value.session_id!==peer.sessionId)continue;
      if(value.phase==='ready'&&!value.mode_checked&&peer.owner==='nxbridge'&&!this.services.takeovers.get(peer.id)&&value.session_id===peer.sessionId&&endpoint?.nativePermission?.mode&&endpoint.nativePermission.mode!=='unknown'){
        value={...value,mode_checked:true,...(endpoint.nativePermission.mode!=='default'?{phase:'unknown' as const,error:'副本首次上报的实际权限不是手动模式，未再次创建副本。'}:{})};store.setSetting(claudeAutoKey(peer.id),value);
      }
      if(['ready','resolved','unknown','blocked'].includes(value.phase)){this.notifyClaudeAuto(peer,value);continue;}
      if(pair.paused||!this.enabled(pair.claude)||!this.enabled(pair.codex)||peer.owner!=='nxbridge'||this.retiring.has(peer.id)||this.restarting.has(peer.id)||this.preparing.has(peer.id)||this.services.takeovers.get(peer.id))continue;
      const save=(patch:Partial<ClaudeAutoFallback>)=>{
        if(JSON.stringify(store.setting(claudeAutoKey(peer.id)))!==JSON.stringify(value))throw new BridgeError('fallback_changed','权限恢复状态已经改变，未覆盖较新的处理结果。');
        value={...value!,...(patch.phase&&patch.phase!==value!.phase?{phase_at:Date.now()}:{}),...patch};store.setSetting(claudeAutoKey(peer.id),value);
      };
      const guard=()=>{
        const current=store.peer(peer.id),active=store.pairFor(peer.id);
        if(this.hooks.stopped()||!this.enabled(peer.id)||!this.enabled(pair.codex)||current.owner!=='nxbridge'||current.sessionId!==value!.old_session_id||active?.id!==pair.id||active.paused||this.services.takeovers.get(peer.id)||this.retiring.has(peer.id))throw new BridgeError('session_changed','权限恢复期间配对、后台归属或会话已经改变。');
      };
      let stopIssued=false;
      this.restarting.add(peer.id);
      try{
        if(value.phase==='pending'){
          if(endpoint?.nativePermission?.mode&&!['auto','unknown'].includes(endpoint.nativePermission.mode)){save({phase:'resolved',session_id:peer.sessionId!,error:undefined});continue;}
          if(endpoint&&endpoint.epoch!==value.source_epoch){save({phase:'blocked',error:'原后台进程代次已经改变，未停止或创建替代会话。'});continue;}
          const original=nativeOwnership(home,peer.id);
          if(original?.native&&peer.state==='offline'&&(await probeProcesses([{pid:original.native.pid,procStart:original.native.startedAt}]))[0]==='dead'){save({phase:'blocked',error:'原后台在空闲核验前已退出，保留原会话，交由普通恢复处理。'});continue;}
          const health=endpoint?.nativeHealth;
          if(peer.state==='ready'&&health&&['ready','failed'].includes(health.state)&&!value.idle_at)save({idle_at:Date.now()});
          if((endpoint?.nativeBackground?.crons??0)>0||value.idle_at&&Date.now()-value.idle_at>=120000){save({phase:'blocked',error:(endpoint?.nativeBackground?.crons??0)>0?'原会话有定时任务，保留原会话继续运行。':'轮次结束后两分钟仍未能核验空闲，保留原会话继续运行。'});continue;}
          if(!endpoint||endpoint.epoch!==value.source_epoch||peer.state!=='ready'||!health||!['ready','failed'].includes(health.state)||health.tools.length||endpoint.nativeBackground?.tasks!==0||endpoint.nativeBackground.crons!==0||endpoint.nativeBackground.observedAt<value.denied_at||store.restartUnsettled(peer.id)||store.questions(true).some(q=>q.from===peer.id||q.to===peer.id))continue;
          const source=nativeOwnership(home,peer.id);
          if(!source||source.phase!=='bound'||source.releasedToUser||source.sessionId!==peer.sessionId||source.native?.pid!==endpoint.pid||source.native.startedAt!==endpoint.procStart||claudeChild(home,peer.id)){save({phase:'blocked',error:'无法核验可切换的原生后台归属，未停止或创建替代会话。'});continue;}
          guard();save({phase:'stopping',source});
        }
        if(value.phase==='stopping'){
          guard();
          const oldGone=!nativeOwnership(home,peer.id)&&!ownedProcesses(home).records.some(record=>record.peerId===peer.id&&record.role==='claude-native')&&value.source?.native&&(await probeProcesses([{pid:value.source.native.pid,procStart:value.source.native.startedAt}]))[0]==='dead';
          if(!oldGone)await this.environment.adapters.claude.release(peer,agent=>{
            guard();const fresh=store.peer(peer.id),ep=store.endpoint(peer.id);
            if(agent.status!=='idle'||fresh.state!=='ready'||ep?.epoch!==value!.source_epoch||ep.nativeBackground?.tasks!==0||ep.nativeBackground.crons!==0||ep.nativeBackground.observedAt<value!.denied_at||store.restartUnsettled(peer.id)||store.questions(true).some(q=>q.from===peer.id||q.to===peer.id))throw new BridgeError('session_busy','后台尚有工作、审批或未结算投递，等待空闲后处理自动模式故障。');
            stopIssued=true;
          });
          guard();store.deactivate(peer.id);save({phase:'launching',requested_mode:'default'});
                                           
          const sessionId=await this.environment.adapters.claude.createManualCopy(peer,value.source!,guard);
          save({phase:'binding',session_id:sessionId});
        }else if(value.phase==='launching'){
          const proof=nativeOwnership(home,peer.id);
          if(!proof?.handle){save({phase:'unknown',error:'上次手动审批后台的启动结果不明，未重复启动；请运行 nxbridge doctor 核对原生后台清单。'});continue;}
          save({phase:'binding'});
        }
        if(value.phase==='binding'){
          guard();const discovered=await this.environment.adapters.claude.manualCopyRegistration(peer);
          if(!discovered){if(Date.now()-(value.phase_at??value.at)>=60000)save({phase:'unknown',error:'手动副本在一分钟内未完成身份核验，保留启动记录，未重复启动。'});continue;}
          guard();
          value=this.completeClaudeAuto(peer,discovered,value);
        }
      }catch(error){
                                            
        const code=(error as BridgeError).code;
        if(code==='fallback_changed'){}
        else if(value.phase==='pending')save({phase:'blocked',error:describeError(error).slice(0,1200)});
        else if(value.phase==='stopping'&&!stopIssued&&['session_busy','session_changed','member_disabled'].includes(code))save({phase:'pending',error:undefined});
        else if(value.phase==='launching'&&nativeOwnership(home,peer.id)?.handle)save({phase:'binding',error:describeError(error)});
        else if(value.phase==='binding'&&!['policy_verification_failed','session_changed','process_record_changed','claude_launch_unverified'].includes(code))save({...(Date.now()-(value.phase_at??value.at)>=60000?{phase:'unknown' as const}:{}),error:describeError(error).slice(0,1200)});
        else save({phase:'unknown',error:describeError(error).slice(0,1200)});
      }finally{
        this.restarting.delete(peer.id);
        value=store.setting<ClaudeAutoFallback>(claudeAutoKey(peer.id))!;
        this.notifyClaudeAuto(store.peer(peer.id),value);
      }
    }
  }
  private async recoverPairedPeer(id:string,hasPending:boolean):Promise<void>{
    const {store}=this.environment;
    const peer=store.peer(id),pair=store.pairFor(id);
    if(this.hooks.stopped()||!pair||pair.paused||!this.enabled(id)||claudeAutoHolds(store,peer))return;
    if(this.retiring.has(id)||this.restarting.has(id)||this.services.takeovers.get(id)||store.setting('managedSessionConflict:'+id)||hostingRecord(store,peer)?.released||['paused','needsHuman'].includes(peer.state))return;
                                         
    const child=process.platform==='linux'&&peer.host==='claude'?claudeChild(this.environment.home,id):undefined;
    if(peer.owner==='nxbridge'&&child&&['handoff','user'].includes(child.phase))return;
    for(const endpoint of store.endpoints(id))if(endpoint.active&&!endpoint.daemon&&endpoint.pid&&!liveProcess(endpoint.pid))store.deactivate(id,endpoint.epoch);
    const endpoint=store.endpoint(id);
    if(endpoint?.pendingContext)return;
    let restore:(()=>Promise<unknown>)|undefined;
    if(peer.owner==='nxbridge'){
      this.services.managedRecovery.ready(id,!!endpoint&&peer.state!=='offline');
      if(!peer.sessionId){if(hasPending&&!peer.launchFailure)restore=()=>this.prepare(peer);}
      else if(!endpoint||peer.state==='offline')restore=()=>this.recover(peer);
    }else if(peer.host==='codex'&&peer.sessionId&&!endpoint)restore=()=>this.recover(peer);
    if(restore){this.restoringMembers.add(id);try{await restore();}finally{this.restoringMembers.delete(id);}}
  }
  schedulePairedRecovery(id:string,hasPending:boolean):Promise<boolean>{
    const pending=this.memberRecoveries.get(id);if(pending)return pending;
    const work=this.pumpStage('member_recovery:'+id,()=>this.recoverPairedPeer(id,hasPending)).finally(()=>{if(this.memberRecoveries.get(id)===work)this.memberRecoveries.delete(id);});
    this.memberRecoveries.set(id,work);return work;
  }
  deferRecoveryDelivery(id:string,recovery:Promise<boolean>):typeof SKIPPED{
    if(!this.recoveryDeliveryWaits.has(recovery)){
      this.recoveryDeliveryWaits.add(recovery);
      void recovery.then(ready=>{
        this.recoveryDeliveryWaits.delete(recovery);
        if(ready)this.background('recovery_delivery:'+id,()=>{
          const peer=this.environment.store.getPeer(id);
          if(peer&&['ready','busy'].includes(peer.state)&&this.environment.store.endpoint(id)&&(this.environment.store.pendingCount(id)||this.services.codexDirect.pending(id))){
            return this.hooks.pumpAfterCurrent();
          }
          return SKIPPED;
        });
      });
    }
    return SKIPPED;
  }
  schedulePairedRecoveries():Map<string,Promise<boolean>>{
    const recoveries=new Map<string,Promise<boolean>>();
                                                 
    this.environment.store.faults.sync('member_recovery_schedule',()=>{
      const queued=new Set(this.environment.store.pendingFacts().map(message=>message.to));
      for(const pair of this.environment.store.pairs())for(const id of [pair.claude,pair.codex])recoveries.set(id,this.schedulePairedRecovery(id,queued.has(id)||id===pair.codex&&this.services.codexDirect.pending(id)));
    });
    return recoveries;
  }
  private rememberManagedLaunch(id:string):void{
    const peer=this.environment.store.peer(id);if(peer.owner!=='nxbridge'||!peer.sessionId)return;
    if(peer.host==='codex'){
      const runtime=runtimeFor(this.environment.home,{peerId:id})?.value;
      if(runtime)this.environment.store.setSetting('managedLaunchProof:'+id,{sessionId:peer.sessionId,runtimeId:runtime.id,configHome:runtime.configHome,executable:runtime.executable,profileId:runtime.profileId,version:runtime.version});
      return;
    }
    const proof=nativeOwnership(this.environment.home,id);
    if(proof?.phase!=='bound'||proof.releasedToUser||proof.sessionId!==peer.sessionId)return;
    this.environment.store.setSetting('managedLaunchProof:'+id,{sessionId:peer.sessionId,nativeLaunchId:proof.id,configHome:proof.configHome,executable:proof.executable,profileId:proof.profileId,version:proof.hostVersion});
  }
  queueRetirements(ids:string[]):string[]{
    const {store}=this.environment;
    const pending=store.setting<Record<string,{attempts:number;nextAt:number;error?:string}>>('processRetirements')??{};
    const release=ids.filter(id=>store.peer(id).owner==='nxbridge'&&!store.pairFor(id));
    for(const id of release)pending[id]??={attempts:0,nextAt:0};
    store.setSetting('processRetirements',pending);return release;
  }
  async releaseOwned(ids:string[]):Promise<string[]>{
    return(await Promise.all([...new Set(ids)].map(id=>{
      const active=this.releases.get(id);if(active)return active;
      this.retiring.add(id);
      const work=this.releaseMember(id).finally(()=>{this.retiring.delete(id);this.releases.delete(id);});this.releases.set(id,work);return work;
    }))).flat();
  }
  private async releaseMember(id:string):Promise<string[]>{
    const {store,adapters}=this.environment;
      if(!this.enabled(id))return[];
      await this.preparing.get(id)?.catch(()=>{});
      while(this.restarting.has(id))await delay(20);
      const pair=store.pairFor(id),peer=store.peer(id);
      let failure:unknown;
      try{
        if(peer.owner!=='nxbridge'||pair)return[];
        if(this.services.takeovers.get(id))throw new BridgeError('foreground_active','接管窗口仍存活，未回收后台。');
        const ep=store.endpoint(id)??store.endpoints(id).filter(value=>value.mode==='app-server').sort((a,b)=>b.seenAt-a.seenAt)[0];
        this.rememberManagedLaunch(id);
        if(peer.host==='claude'){
          const auto=store.setting<ClaudeAutoFallback>(claudeAutoKey(id));let proof=nativeOwnership(this.environment.home,id);
          if(auto?.source&&proof&&proof.id!==auto.source.id){if(!proof.sessionId&&proof.handle){await adapters.claude.manualCopyRegistration(peer);proof=nativeOwnership(this.environment.home,id);}await adapters.claude.release({...peer,sessionId:proof?.sessionId??peer.sessionId});}
          else await adapters.claude.release(peer);
          if(auto)store.setSetting(claudeAutoKey(id),{...auto,phase:'resolved'});
        }else if(ep)await adapters.codex.release(peer,ep);
        store.deactivate(id);store.updatePeer(id,{state:'offline'});
        if(peer.host==='codex'){
          const references=store.peers().filter(value=>(value.owner==='user'||!!store.pairFor(value.id))&&!(value.host==='codex'&&value.kind==='subagent')).flatMap(value=>store.endpoints(value.id));
          const note=await adapters.codex.releaseRuntime(references,ep?.address,[peer]);
          if(note)throw new BridgeError('runtime_release_pending',note);
        }
      }catch(error){failure=error;}
      finally{
                                                 
        const pending=store.setting<Record<string,{attempts:number;nextAt:number;error?:string}>>('processRetirements')??{};
        if(failure){const attempts=(pending[id]?.attempts??0)+1,wait=[0,30000,120000][attempts]??120000,exhausted=attempts>=3||(failure as BridgeError).code==='claude_release_unresolved';pending[id]={attempts,nextAt:exhausted?Number.MAX_SAFE_INTEGER:Date.now()+wait,error:describeError(failure)};store.event('release.failed',{peerId:id,retryInMs:exhausted?null:wait,exhausted,error:describeError(failure)});}
        else delete pending[id];
        store.setSetting('processRetirements',pending);
      }
      return failure?[`${peer.name} 回收未完成：${describeError(failure)}`]:[];
  }
}
