import type { Store } from '../../storage/store.js';
import type { BridgeConfig, ModelProfile, Peer } from '../../types.js';
import type { CodexAdapter } from '../../hosts/codex/adapter.js';
import type { ClaudeAdapter } from '../../hosts/claude/adapter.js';
import { claudeChild } from '../../hosts/claude/claude-child.js';
import { nativeProfileEffort } from '../../integration/mod/mod-protocol.js';
import { BridgeError, describeError } from '../../shared/errors.js';
import { delay } from '../../shared/time.js';
import { hostingGate } from '../recovery/session-hosting.js';
import { PartnerProfiles, modelProfileSchema, hasProfile, profileMatches, type EffectiveModelProfile } from './partner-profile.js';
import { syncFrozenProfiles } from './frozen-profile.js';

interface ProfileEnvironment {
  readonly store:Store;
  readonly config:BridgeConfig;
  readonly adapters:{
    readonly codex:Pick<CodexAdapter,'modelProfile'|'setProfile'|'readProfile'>;
    readonly claude:Pick<ClaudeAdapter,'modelProfile'|'setProfile'|'readProfile'>;
  };
  readonly home:string;
}
interface ProfileLifecycle {
  stopped:boolean;enabled:boolean;preparing:boolean;restarting:boolean;retiring:boolean;takingOver:boolean;
}
interface ProfileHooks {
  lifecycle:(id:string)=>ProfileLifecycle;
  beginChange:(id:string)=>()=>void;
  pump:()=>Promise<void>;
}

                                            
export class PartnerProfileCoordination {
  readonly profiles:PartnerProfiles;
  private profileChecks=new Map<string,number>();
  private profileStages=new Set<string>();
  constructor(private readonly environment:ProfileEnvironment,private readonly hooks:ProfileHooks){
    const {store,home,config,adapters}=environment;
    syncFrozenProfiles(home,config);this.profiles=new PartnerProfiles(store,home,config);this.profiles.syncConfiguration();
    adapters.codex.modelProfile=peer=>this.profiles.requested(peer);adapters.claude.modelProfile=peer=>this.profiles.requested(peer);
  }
  async apply(peer:Peer):Promise<void>{
    const {store,adapters}=this.environment,intent=this.profiles.intent(peer),pair=store.pairFor(peer.id),endpoint=store.endpoint(peer.id);
    if(!intent||intent.status!=='pending'||!intent.sessionId||!hasProfile(intent.requested)||peer.owner!=='nxbridge'||peer.state!=='ready'||!endpoint||!pair||pair.paused)return;
    const state=this.hooks.lifecycle(peer.id);
    if(!state.enabled||state.preparing||state.restarting||state.retiring||state.takingOver||hostingGate(store,peer))return;
    const release=this.hooks.beginChange(peer.id);
    const guard=()=>{
      const current=store.peer(peer.id),ep=store.endpoint(peer.id),latest=this.profiles.intent(current),state=this.hooks.lifecycle(peer.id);
      if(state.stopped||!state.enabled||current.owner!=='nxbridge'||current.sessionId!==peer.sessionId||store.pairFor(peer.id)?.id!==pair.id||ep?.epoch!==endpoint.epoch||ep.address!==endpoint.address||latest?.at!==intent.at||JSON.stringify(latest.requested)!==JSON.stringify(intent.requested)||state.takingOver)throw new BridgeError('session_changed','切换期间搭档、会话或所选设置有变化，这次没有切换。');
    };
    try{
      guard();
      const actual=await adapters[peer.host].setProfile(peer,endpoint,intent.requested,guard);guard();
      this.profiles.applied(peer,actual);store.event('partner.profile.applied',{peerId:peer.id,sessionId:peer.sessionId,...actual});
    }catch(error){if((error as BridgeError).code!=='session_busy'){
                                            
      if(this.profiles.intent(peer)?.at===intent.at)this.profiles.failed(peer,error);
      store.event('partner.profile.failed',{peerId:peer.id,error:describeError(error)});
    }}finally{release();}
  }
  async verifyInitial(peer:Peer,wait=false):Promise<void>{
    const {store,adapters,home}=this.environment,intent=this.profiles.intent(peer);
    if(peer.owner!=='nxbridge'||!peer.sessionId||!intent||intent.sessionId||intent.status!=='pending'||!hasProfile(intent.requested))return;
    const until=Date.now()+(wait?10000:0);
    try{
      let actual:EffectiveModelProfile;
      if(peer.host==='codex'){const endpoint=store.endpoint(peer.id);if(!endpoint)return;actual=await adapters.codex.readProfile(peer,endpoint,()=>{if(store.peer(peer.id).sessionId!==peer.sessionId)throw new BridgeError('session_changed','启动设置核验期间会话已改变。');});}
      else if(claudeChild(home,peer.id))actual=await adapters.claude.readProfile(peer);
      else{
        while(true){
          const current=store.peer(peer.id),profile=store.endpoint(peer.id)?.nativeProfile,state=this.hooks.lifecycle(peer.id);
          if(current.sessionId!==peer.sessionId||current.owner!=='nxbridge'||state.stopped||!state.enabled)throw new BridgeError('session_changed','启动设置核验期间会话或归属已改变，任务未提交。');
          if(profile?.model&&profile.flag&&profile.effective){
            if(!profileMatches(intent.requested,profile.flag)||intent.requested.model!==undefined&&profile.effective.model!==intent.requested.model)throw new BridgeError('profile_verification_failed','原生 Claude 没有采用启动时指定的模型或推理强度，任务尚未提交。');
            actual={model:profile.model,...(intent.requested.model?{requestedModel:intent.requested.model}:{}),effort:nativeProfileEffort(profile)};break;
          }
          if(!wait)return;
          if(Date.now()>=until)throw new BridgeError('profile_unverified','新后台尚未报告可核验的模型与推理强度，任务暂缓投递。');
          await delay(200);
        }
      }
      if(this.profiles.intent(peer)?.at!==intent.at)return;
      const current=store.peer(peer.id),state=this.hooks.lifecycle(peer.id);
      if(current.sessionId!==peer.sessionId||current.owner!=='nxbridge'||state.stopped||!state.enabled)throw new BridgeError('session_changed','启动设置回读期间会话或归属已改变，任务未提交。');
      this.profiles.applied(current,actual);
    }catch(error){if(this.profiles.intent(peer)?.at===intent.at){
                                             
      if((error as BridgeError).code==='profile_verification_failed')this.profiles.failed(peer,error);else this.profiles.waiting(peer,error);
    }}
  }
  async synchronize(id:string):Promise<void>{
    if(this.profileStages.has(id))return;
    this.profileStages.add(id);
    try{await this.verifyInitial(this.environment.store.peer(id));await this.reconcile(this.environment.store.peer(id));await this.apply(this.environment.store.peer(id));}
    finally{this.profileStages.delete(id);}
  }
  async reconcile(peer:Peer):Promise<void>{
    const {store,adapters,home}=this.environment,intent=this.profiles.intent(peer),endpoint=store.endpoint(peer.id),pair=store.pairFor(peer.id);
    if(!intent||!hasProfile(intent.requested)||peer.owner!=='nxbridge'||!endpoint||peer.state!=='ready'||!pair||pair.paused)return;
    const state=this.hooks.lifecycle(peer.id);
    if(!state.enabled||state.restarting||state.retiring||state.takingOver||hostingGate(store,peer)||intent.status==='pending'||!this.profiles.blocks(peer)||(this.profileChecks.get(peer.id)??0)>Date.now())return;
    this.profileChecks.set(peer.id,Date.now()+5000);
    const context=this.profiles.context(peer);
    const guard=()=>{const current=store.peer(peer.id),state=this.hooks.lifecycle(peer.id);if(state.stopped||!state.enabled||current.owner!=='nxbridge'||this.profiles.context(current)!==context||store.pairFor(peer.id)?.id!==pair.id||store.pairFor(peer.id)?.paused||state.restarting||state.retiring||state.takingOver||this.profiles.intent(peer)?.at!==intent.at)throw new BridgeError('session_changed','设置核对期间会话已改变。');};
    try{
      guard();const native=endpoint.nativeProfile;
      const actual=peer.host==='codex'?await adapters.codex.readProfile(peer,endpoint,guard):claudeChild(home,peer.id)?await adapters.claude.readProfile(peer):native?.model&&native.effective&&(!intent.failedAt||native.observedAt>=intent.failedAt)?{model:native.model,...(native.flag?.model&&native.flag.model===native.effective.model?{requestedModel:native.flag.model}:{}),effort:nativeProfileEffort(native)}:undefined;
      guard();if(actual)this.profiles.applied(store.peer(peer.id),actual);
    }catch(error){if((error as BridgeError).code==='profile_verification_failed')this.profiles.failed(peer,error);else this.profiles.waiting(peer,error);}
  }
  async command(peer:Peer,action:'get'|'set'|'reset',profile:ModelProfile):Promise<unknown>{
    if(action!=='get'){
      if(peer.owner!=='nxbridge')throw new BridgeError('process_owned_by_user','只能修改 nxbridge 自己启动的后台搭档的模型和推理强度；你自己打开的窗口请在那个窗口里设置。');
      if(action==='set'&&!hasProfile(profile))throw new BridgeError('invalid_arguments','修改时至少要指定模型或推理强度其中一项。');
      if(action!=='reset'&&peer.sessionId&&peer.host==='claude'&&!claudeChild(this.environment.home,peer.id))throw new BridgeError('profile_change_unsupported','这个后台 Claude 已经在运行，暂时不能在保留原会话的情况下改模型或推理强度。可以用想要的设置新建一个后台搭档。');
      if(action==='set'&&peer.sessionId&&peer.host==='claude'&&profile.effort!==undefined&&!['low','medium','high','xhigh'].includes(String(profile.effort)))throw new BridgeError('profile_change_unsupported','此 Claude 控制接口不支持这档推理强度；请在新建后台时指定。');
      this.profiles.set(peer,modelProfileSchema.parse(profile),action==='reset');await this.apply(peer);
      queueMicrotask(()=>void this.hooks.pump());
    }
    return{member_id:peer.id,host:peer.host,session_id:peer.sessionId,...this.profiles.view(this.environment.store.peer(peer.id))};
  }
}
