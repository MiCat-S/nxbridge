import {daemonDelivery,nativeDeliveryWait} from '../delivery/delivery-guidance.js';
import {permissionGuidance} from '../../integration/mcp/permission-guidance.js';
import {observeCodexPermission,codexProfileEvidence} from '../../hosts/codex/codex-permission.js';
import {daemonContextChanged} from '../../hosts/codex/daemon-wake.js';
import {Store} from '../../storage/store.js';
import {brokerRecoveryNotice} from '../broker-outage.js';
import {BridgeError,DeliveryError,describeError} from '../../shared/errors.js';
import {otherHost,type Actor,type BridgeConfig,type Endpoint,type Peer,type Pair} from '../../types.js';
import {codexHome} from '../../shared/local-paths.js';
import {sameDirectory} from '../../shared/files.js';
import {Questions} from '../../integration/mcp/questions.js';
import {runtimeProfile} from '../profiles/runtime-profile.js';
import {type PartnerProfiles} from '../profiles/partner-profile.js';
import {randomUUID} from 'node:crypto';
import {TurnHealthTracker,RECENT_PROGRESS_MS,SILENCE_MS,type TurnHealth} from './turn-health.js';
import {ForegroundHealth} from './foreground-health.js';
import {CodexModelRequests,providerBlocked,withModelRequest} from '../../hosts/codex/codex-model-request.js';
import type {DeliveryMessage} from '../delivery/file-references.js';
import {claudeChild,type ClaudeChildRecord} from '../../hosts/claude/claude-child.js';
import {probeProcesses} from '../../process/process.js';
import {DeliveryHealth} from './delivery.js';
import {noticeScope,unsettledCount,type RuntimeAvailability,type RuntimeNotice} from './contracts.js';
import {readCodexThread} from '../../hosts/codex/codex-evidence.js';
import {readCodexPendingTools} from '../../hosts/codex/codex-pending-tools.js';
import {RuntimeIncidents} from './runtime-incidents.js';
import {SKIPPED} from '../fault-boundary.js';
import {CommunicationTips} from '../delivery/communication-tips.js';
import {IdleNotices} from './idle-notices.js';
import {PairAnomalies} from '../pairing/pair-anomalies.js';
import {ResourceHealth} from './resource-health.js';
import {assertClaudeSession} from '../../hosts/claude/claude-session.js';
import {pairLoss,pairLossKey,pairLossText,type PairLoss} from '../pairing/pair-loss.js';
import {sessionPresence} from '../deleted-sessions.js';
import {claudeAutoStatus} from '../../hosts/claude/claude-auto-mode.js';
import {CodexDaemons,daemonPermission} from '../../hosts/codex/codex-daemon.js';
import {CodexDirectDelivery} from '../../hosts/codex/codex-direct.js';
import {ManagedRecovery} from '../recovery/managed-recovery.js';
import {hostingGate,hostingStatus} from '../recovery/session-hosting.js';
import {readSessionProfile,sessionFile} from '../../hosts/codex/codex-session-profile.js';
import type {Adapters} from '../coordinator.js';
import type {CodexFinalForwards} from '../codex-final-forwards.js';

interface HealthEnvironment {readonly store:Store;readonly config:BridgeConfig;readonly adapters:Adapters;readonly home:string;readonly resources?:ResourceHealth;}
interface HealthServices {readonly incidents:RuntimeIncidents;readonly deliveryHealth:DeliveryHealth;readonly communicationTips:CommunicationTips;readonly pairAnomalies:PairAnomalies;readonly idleNotices:IdleNotices;readonly profiles:PartnerProfiles;readonly foregroundHealth:ForegroundHealth;readonly managedRecovery:ManagedRecovery;readonly health:TurnHealthTracker;readonly codexDirect:CodexDirectDelivery;readonly daemons:CodexDaemons;readonly questions:Questions;readonly finalForwards:CodexFinalForwards;}
interface HealthHooks {
 stopped():boolean;
 actor(input:Actor):Peer;
 enabled(id:string):boolean;
 requireEnabled(peer:Peer):void;
 ownedClaudeLaunchReady(peer:Peer):boolean;
 ownedClaudeLaunchFailure(peer:Peer):Peer['launchFailure'];
 signalCodexWake(peer:Peer,endpoint:Endpoint):Promise<void|typeof SKIPPED>;
 signalEmbeddedWake(peer:Peer,endpoint:Endpoint):Promise<void>;
 refreshHookTrust(peer:Peer):void;
 pumpStage(stage:string,work:()=>unknown|Promise<unknown>):Promise<boolean>;
}

                                         
export class BrokerHealthCoordinator {
  private noticeAbort=new AbortController();
  private modelRequests=new CodexModelRequests();
  private deliveryHealthCheckedAt=0;
  private unqueuedHealthCheckedAt=0;
  private runtimeProbes=new Map<string,{key:string;at:number;work:Promise<RuntimeAvailability>}>();
  private healthRequests=new Set<Promise<unknown>>();
  private healthCheckedAt=0;
  private turnHealthProbes=new Map<string,{key:string;at:number}>();
  private pendingToolEvidence=new Map<string,{scope:string;tools:string[];complete:boolean}>();
  constructor(private readonly environment:HealthEnvironment,private readonly services:HealthServices,private readonly hooks:HealthHooks){}
  private runtimeEndpoint(id:string):Endpoint|undefined{return this.environment.store.endpoint(id)??this.environment.store.endpoints(id).at(-1);}
  get pending():boolean{return this.healthRequests.size>0;}
  get abortSignal():AbortSignal{return this.noticeAbort.signal;}
  abortNotices():void{this.noticeAbort.abort();}
  resetTurnCheck():void{this.healthCheckedAt=0;}
  async waitForIdle():Promise<void>{while(this.healthRequests.size)await Promise.all(this.healthRequests);}
  incidentViews(ids:string[]){return this.services.incidents.list(ids.map(id=>({peer:this.environment.store.peer(id),endpoint:this.runtimeEndpoint(id)})));}

  incidentNotes(ids:string[]){return[...this.incidentViews(ids).filter(value=>value.state!=='recovering').map(value=>({incidentId:value.id,text:`Delivery unconfirmed since ${new Date(value.since).toISOString().slice(11,16)} UTC (${value.attempts} attempts, ${value.code}); messages kept, ${value.state==='blocked'?'same request held; inspect status action':'auto-retrying'}; do not resend.`})),...ids.flatMap(id=>{const pair=this.environment.store.pairFor(id);return pair?this.services.deliveryHealth.notes(pair.id,id):[];})].slice(0,3);}

  deliveryGuidance(peer:Peer,pending?:number){
    const {store}=this.environment;
      const endpoint=store.endpoint(peer.id),pair=store.pairFor(peer.id);
      const count=pending??(pair?.paused?store.deliveryCounts(pair.id,pair[otherHost(peer.host)]).accepted:store.pendingCount(peer.id));
      const hosting=hostingStatus(store,peer);
      const auto=claudeAutoStatus(store,peer);
      const failure=this.hooks.ownedClaudeLaunchFailure(peer);
      const direct=peer.host==='codex'&&count>0?this.services.codexDirect.status(peer.id):undefined,wait=direct?.scope===JSON.stringify([pair?.id,JSON.stringify([peer.sessionId,endpoint?.epoch])])?direct.wait:undefined;
      return{owner:peer.owner,...(peer.state==='paused'&&peer.pauseReason?{pause_reason:peer.pauseReason}:{}),...daemonDelivery(peer,endpoint,count,store.bindings.current(peer.id)?.transitioning,this.services.daemons.canWake(peer,endpoint),pair?.paused,daemonContextChanged(store,peer,endpoint)),...(wait?{delivery_wait:{state:'waiting_native_interaction' as const,reason:'native_thread_state' as const,host:'codex' as const,member_id:peer.id,session_id:peer.sessionId,name:peer.name,pending:count,...wait}}:{}),...nativeDeliveryWait(peer,endpoint,count,this.peerHealth(peer)),...(hosting?{hosting}:{}),...(auto?{claude_auto_mode:auto}:{}),...(failure?{launchFailure:failure,launch_precondition:failure}:{})};
    }

  probeRuntime(peer:Peer,fresh=false):Promise<RuntimeAvailability>{
      this.hooks.requireEnabled(peer);
      const endpoint=this.runtimeEndpoint(peer.id),key=JSON.stringify([peer.sessionId,peer.owner,endpoint]),cached=this.runtimeProbes.get(peer.id);
      if(cached&&cached.key===key&&Date.now()-cached.at<2000&&!fresh)return cached.work;
      const work=this.environment.adapters[peer.host].probe(peer,endpoint).catch(()=>({state:'unknown' as const,reasons:['runtime availability check failed'],checked_at:Date.now()}));this.runtimeProbes.set(peer.id,{key,at:Date.now(),work});return work;
    }

  async deliveryAvailability(sender:Peer,partner:Peer):Promise<RuntimeAvailability>{
      const source=this.runtimeEndpoint(sender.id);
      const [availability,bridge]=await Promise.all([this.probeRuntime(partner,true),sender.host==='codex'&&source?.bridge&&!source.daemon?probeProcesses([source.bridge]):Promise.resolve([])]);
      if(availability.state==='unknown'||bridge[0]==='unknown')void this.environment.resources?.request('runtime_unverified');
      if(bridge.length){
        const state=bridge[0];
        if(state!=='alive')return{state:state==='dead'?'blocked':availability.state==='blocked'?'blocked':'unknown',reasons:[...availability.reasons,state==='dead'?'sender MCP bridge exited or PID generation changed':'sender MCP bridge PID generation unverifiable'],checked_at:Date.now()};
      }
      const incident=this.services.incidents.current(partner,this.runtimeEndpoint(partner.id));
      if(incident)return{...availability,state:incident.state==='blocked'?'blocked':'unknown',reasons:[incident.code],incident,functionalSuccessAt:this.environment.store.setting<number>('functionalDelivery:'+partner.id)};
      return{...availability,functionalSuccessAt:this.environment.store.setting<number>('functionalDelivery:'+partner.id)};
    }

  communicationTip(peer:Peer,body:string,channel:'partner'|'agent',actor:Actor,messageId?:string):string|undefined{
      const turnId=actor.turnId??this.peerHealth(peer)?.turnId??this.environment.store.setting<string>('communicationTurn:'+peer.id);
      try{return this.services.communicationTips.record(peer,body,channel,channel+':'+actor.sessionId+':'+actor.callId,turnId,messageId);}
      catch(error){this.environment.store.event('communication.tip.failed',{peerId:peer.id,error:describeError(error)});return undefined;}
    }

  async trackHealth<T>(work:Promise<T>):Promise<T>{this.healthRequests.add(work);try{return await work;}finally{this.healthRequests.delete(work);}}

  noticeScope(pair:Pair,sender:Peer):string{
      const partner=this.environment.store.peer(pair[otherHost(sender.host)]);
      return noticeScope(pair,sender,partner,this.environment.store.bindings.current(sender.id)?.epoch,this.environment.store.bindings.current(partner.id)?.epoch);
    }

  refreshNoticeConditions(pair:Pair,site:string):void{
    const {store}=this.environment;
      if(!this.hooks.enabled(pair.claude)||!this.hooks.enabled(pair.codex))return;
      this.services.finalForwards.refresh(pair);
      const stages=[...new Set(store.faults.status().filter(value=>value.degraded).map(value=>value.stage.split(':')[0]!))].sort(),key='brokerDegraded:'+pair.id;
      let degraded=store.setting<{id:string}>(key);
      if(stages.length){if(!degraded){degraded={id:randomUUID()};store.setSetting(key,degraded);}}
      else if(degraded){for(const id of [pair.claude,pair.codex])this.services.deliveryHealth.cancel(pair.id,id,degraded.id);store.setSetting(key,null);degraded=undefined;}
      for(const id of [pair.claude,pair.codex]){
        const peer=store.peer(id);
        if(degraded)this.services.deliveryHealth.enqueue(pair.id,id,{id:degraded.id,source:'broker_degraded',kind:'broker_degraded',wake:false,state:'pending',scope:this.noticeScope(pair,peer),message:'nxbridge coordinator is reachable but degraded in '+stages.join(', ')+'. Run nxbridge doctor once to inspect the failed stage and broker log; report the cause and next step. Do not replay messages or retry in a loop.'});
        if(peer.host==='codex')this.hooks.refreshHookTrust(peer);
        const health=this.peerHealth(peer);
        this.services.communicationTips.cooperation.observe(peer);
        const failure=this.hooks.ownedClaudeLaunchFailure(peer);
        this.services.pairAnomalies.observe(pair,failure?{...peer,launchFailure:failure}:peer,health,this.services.communicationTips.syncReminder(peer,this.environment.config.syncTipMinutes),site);
        this.services.idleNotices.observe(pair,peer,this.environment.config.idleNoticeMinutes);
      }
    }

  async prepareNotices(actor:Actor,ids?:string[],admit=true,requireWake=false,readyBoundary=false):Promise<RuntimeNotice[]>{
    const {store}=this.environment;
      const sender=this.hooks.actor(actor),pair=store.pairFor(sender.id);if(!pair||pair.paused)return[];
      if(hostingGate(store,sender))return[];
      if(!this.hooks.enabled(pair.claude)||!this.hooks.enabled(pair.codex))return[];
      this.refreshNoticeConditions(pair,'prepare_notices_before_probe');
                                               
                                      
                                              
      const selectedPending=ids?ids.some(id=>!!this.services.deliveryHealth.get(pair.id,sender.id,id)):this.services.deliveryHealth.due(pair.id,sender.id);
      if(!selectedPending&&!this.services.deliveryHealth.active(pair.id,sender.id))return[];
      const scope=this.noticeScope(pair,sender),partner=store.peer(pair[otherHost(sender.host)]),availability=await this.deliveryAvailability(sender,partner);
      const turnIncident=store.setting<{id:string;recoveryId?:string}>('turnHealthIncident:'+pair.id);
      if(turnIncident)await this.checkPairTurnHealth(pair);
      const current=store.pairFor(sender.id);
      if(this.hooks.stopped()||!current||current.id!==pair.id||current.paused||!this.hooks.enabled(current.claude)||!this.hooks.enabled(current.codex)||this.noticeScope(current,this.hooks.actor(actor))!==scope)return[];
      if(['paused','needsHuman','offline'].includes(store.peer(sender.id).state))return[];
      this.services.deliveryHealth.observe(current,store.peer(sender.id),store.peer(partner.id),store.deliveryCounts(pair.id,sender.id),availability,true,scope);
      this.refreshNoticeConditions(current,'prepare_notices_after_probe');
                                                   
      const selected=ids?ids.flatMap(id=>{const n=this.services.deliveryHealth.get(pair.id,sender.id,id);return n?[n]:[]}):this.services.deliveryHealth.peek(pair.id,sender.id);
      if(admit)this.assertClaudeNoticeSession(sender);
      return admit?this.admitNotices(pair,sender,selected,scope,requireWake,readyBoundary):selected;
    }

  assertClaudeNoticeSession(peer:Peer):void{
      if(peer.host!=='claude')return;
      const endpoint=this.environment.store.endpoint(peer.id);
      if(!peer.sessionId||!endpoint?.configHome||!endpoint.pid||!endpoint.procStart)throw new BridgeError('session_changed','无法核验当前 Claude 官方会话，未领取通知。');
      assertClaudeSession(endpoint.configHome,peer.sessionId,{pid:endpoint.pid,procStart:endpoint.procStart});
    }

  admitNotices(pair:Pair,sender:Peer,selected:RuntimeNotice[],scope:string,requireWake=false,readyBoundary=false):RuntimeNotice[]{
      return this.environment.store.transaction(()=>selected.flatMap(n=>{
        const allowReady=sender.host==='claude'&&readyBoundary&&this.services.finalForwards.ready(pair,true);
        const prepared=this.services.deliveryHealth.prepare(pair.id,sender.id,n.id,scope,false,requireWake,allowReady);
        if(prepared){
          this.services.finalForwards.admitted(pair,prepared);
          const key='turnHealthIncident:'+pair.id,value=this.environment.store.setting<{id:string;alertAdmitted?:boolean}>(key);
          if(value&&prepared.componentIds?.includes(value.id)){value.alertAdmitted=true;this.environment.store.setSetting(key,value);}
        }
        return prepared?[prepared]:[];
      }));
    }

  outageRecovery(peer:Peer,admit:boolean,noticeId?:string):RuntimeNotice|undefined{
      const endpoint=this.environment.store.endpoint(peer.id),native=endpoint?.native??endpoint;
      if(!peer.sessionId||!['root','fork'].includes(peer.kind)||!native?.pid||!native.procStart)return;
      return brokerRecoveryNotice(this.environment.home,{host:peer.host,peerId:peer.id,sessionId:peer.sessionId,pid:native.pid,procStart:native.procStart},{admit,noticeId});
    }

  async notifyDeletedReplacementFailure(peer:Peer,loss:PairLoss):Promise<void>{
    const {store}=this.environment;
      const endpoint=this.runtimeEndpoint(peer.id);if(!endpoint||!peer.sessionId)return;
      const current=()=>!this.hooks.stopped()&&this.hooks.enabled(peer.id)&&store.peer(peer.id).sessionId===peer.sessionId&&store.peer(peer.id).state==='ready'&&!store.pairFor(peer.id)&&pairLoss(store,store.peer(peer.id))?.id===loss.id&&this.runtimeEndpoint(peer.id)?.epoch===endpoint.epoch;
      if(!current()||await sessionPresence(store,store.peer(peer.id),probeProcesses,this.environment.home)!=='absent')return;
      const beforeSubmit=async()=>{
        if(!current()||await sessionPresence(store,store.peer(peer.id),probeProcesses,this.environment.home)!=='absent'||!current())return false;
        const fresh=pairLoss(store,store.peer(peer.id));if(!fresh||!fresh.replacement?.terminal)return false;
        store.setSetting(pairLossKey(peer.id),{...fresh,state:'unknown',admitted:true});return true;
      };
      const message=pairLossText(loss),id='deleted-replacement-failure:'+loss.id;
      try{
        if(peer.host==='codex')await this.environment.adapters.codex.wake(peer,endpoint,this.noticeAbort.signal,beforeSubmit,message);
        else await this.environment.adapters.claude.deliver(peer,endpoint,{id,pairId:loss.pair_id,from:peer.id,to:peer.id,body:message,inReplyTo:null,via:null,callId:id,state:'accepted',createdAt:Date.now(),updatedAt:Date.now(),evidence:null,error:null,attempts:1,notice:true,noticeSource:'pair_lost',beforeSubmit},peer);
        store.event('session.replacement.failure_notice',{memberId:peer.id,lossId:loss.id});
      }catch(error){store.event('session.replacement.failure_notice_failed',{memberId:peer.id,lossId:loss.id,error:describeError(error)});}
    }

  integrationIssues(peerId:string,includeMessage=false){
      const peer=this.environment.store.peer(peerId),owner=peer.owner,issues=this.services.pairAnomalies.issues(peerId);let configHome:string|undefined;
      if(issues.some(issue=>issue.kind==='hooks_trust_required')){
        const homes=this.environment.store.endpoints(peerId).filter(endpoint=>endpoint.active).map(endpoint=>endpoint.configHome??this.environment.config.codexHome??codexHome());
        if(!homes.length)configHome=this.environment.config.codexHome??codexHome();else if(homes.every(home=>sameDirectory(home,homes[0]!)))configHome=homes[0];
      }
      return issues.map(issue=>({peerId,code:issue.kind,...(includeMessage||issue.kind==='launch_failed'?{message:issue.message}:{}),
        ...(['hooks_restart_required','contract_inactive','subagent_completion_held'].includes(issue.kind)?{owner,...(owner==='user'&&peer.sessionId?{session_id:peer.sessionId,name:peer.name}:{})}:{}),
        ...(issue.kind==='hooks_trust_required'&&configHome&&!sameDirectory(configHome,codexHome())?{config_home:configHome}:{}),
        ...(issue.kind==='launch_failed'?{retry_command:'nxbridge open '+peer.host+' --member '+peer.id}:{})}));
    }

  deliveryAdmission(peer:Peer,pair:Pair){
    const {store}=this.environment;
      const permission=permissionGuidance(store.peer(pair.codex),store.peer(pair.claude),store.endpoint(pair.claude));
      return{inbound:store.deliveryAdmissionCounts(pair.id,pair[otherHost(peer.host)]),outbound:store.deliveryAdmissionCounts(pair.id,peer.id),approval_required:permission?.state==='class_mismatch'};
    }

  peerHealth(peer:Peer):TurnHealth|undefined{
      if(!this.hooks.enabled(peer.id))return;
      const child=peer.host==='claude'?claudeChild(this.environment.home,peer.id):undefined;
      if(child){const health=this.claudeHealth(peer,child);if(health)return health;}
      const endpoint=this.environment.store.endpoint(peer.id);
      const health=endpoint?.mode==='app-server'&&peer.sessionId?this.services.health.get(endpoint.address,peer.sessionId):this.services.foregroundHealth.get(peer);
      return this.modelRequestHealth(peer,endpoint,health);
    }

  modelRequestHealth(peer:Peer,endpoint:Endpoint|undefined,health:TurnHealth|undefined):TurnHealth|undefined{
      const pending=this.pendingToolEvidence.get(peer.id);
      if(health?.state==='silent'&&peer.host==='codex'){
        const current=pending&&pending.scope===this.pendingToolScope(peer,endpoint,health);
        health=current?{...health,tools:[...pending.tools],state:pending.tools.length?'waitingTool':'silent',progressEvidence:health.progressEvidence!==false&&pending.complete}:{...health,progressEvidence:false};
      }
      if(!health||peer.host!=='codex'||!peer.sessionId||!endpoint?.configHome||!endpoint.pid)return health;
      return withModelRequest(health,this.modelRequests.read(endpoint.configHome,peer.sessionId,health.turnId,endpoint.pid));
    }

  private pendingToolScope(peer:Peer,endpoint:Endpoint|undefined,health:TurnHealth):string{
      return JSON.stringify([peer.sessionId,endpoint?.epoch,endpoint?.active,endpoint?.bindingEpoch,health.turnId,health.lastEventAt,health.lastProgressAt,health.state,health.tools,endpoint?.mode==='app-server'?this.services.health.revision(endpoint.address,peer.sessionId!):null]);
    }

  private claimTurnHealthProbe(peer:Peer,endpoint:Endpoint):boolean{
      const key=JSON.stringify([peer.sessionId,endpoint.address,endpoint.epoch]),previous=this.turnHealthProbes.get(peer.id),now=Date.now();
      if(previous?.key===key&&now-previous.at<RECENT_PROGRESS_MS)return false;
      this.turnHealthProbes.set(peer.id,{key,at:now});return true;
    }

  private async probePendingTools(peer:Peer,endpoint:Endpoint,health:TurnHealth,file:unknown):Promise<TurnHealth|undefined>{
      const scope=this.pendingToolScope(peer,endpoint,health),evidence=await readCodexPendingTools(file,peer.sessionId!,health.turnId);
      const current=this.environment.store.peer(peer.id),currentEndpoint=this.environment.store.endpoint(peer.id);
      if(current.sessionId!==peer.sessionId||currentEndpoint?.epoch!==endpoint.epoch)throw new BridgeError('session_changed','工具等待核对期间目标会话已经改变。');
      const latest=endpoint.mode==='app-server'?this.services.health.get(endpoint.address,peer.sessionId!):this.services.foregroundHealth.get(current);
                                              
      if(latest&&this.pendingToolScope(current,currentEndpoint,latest)===scope){
        this.pendingToolEvidence.delete(peer.id);this.pendingToolEvidence.set(peer.id,{scope,tools:evidence?.calls.map(call=>call.id)??[],complete:evidence?.complete===true});
        while(this.pendingToolEvidence.size>64)this.pendingToolEvidence.delete(this.pendingToolEvidence.keys().next().value!);
      }else if(latest?.state==='silent')this.pendingToolEvidence.set(peer.id,{scope:this.pendingToolScope(current,currentEndpoint,latest),tools:[],complete:false});
      return latest;
    }

  claudeHealth(peer:Peer,child:ClaudeChildRecord):TurnHealth|undefined{
      if(child.phase!=='active'||peer.owner!=='nxbridge')return;
      const start=this.environment.store.setting<number>('claudeTurnStart:'+peer.id),value=child.health;
      if(start&&peer.state==='busy'&&(!value||value.lastEventAt<start))return{turnId:peer.sessionId+':'+start,lastProgressAt:start,lastEventAt:start,state:Date.now()-start>=SILENCE_MS?'silent':'running',tools:[]};
      if(!value)return;
      return{...value,state:peer.state==='needsHuman'?'needsHuman':['ready','failed','needsHuman'].includes(value.state)?value.state:value.retry?'networkRetrying':value.tools.length?'waitingTool':Date.now()-value.lastProgressAt>=SILENCE_MS?'silent':'running'};
    }

  deliverySucceeded(peer:Peer,endpoint=this.runtimeEndpoint(peer.id)):void{
      const now=Date.now();this.environment.store.setSetting('functionalDelivery:'+peer.id,now);this.services.incidents.succeeded(peer,endpoint);
      const pair=this.environment.store.pairFor(peer.id);if(pair)this.services.deliveryHealth.succeeded(pair.id,pair[otherHost(peer.host)],now);
    }

  async probeTurnHealth(peer:Peer,endpoint:Endpoint):Promise<TurnHealth|undefined>{
    const {store}=this.environment;
      this.hooks.requireEnabled(peer);
      const revision=this.services.health.revision(endpoint.address,peer.sessionId!);
      let result:{thread:Awaited<ReturnType<typeof readCodexThread>>};
      try{const rpc=await this.environment.adapters.codex.connect(endpoint.address);this.hooks.requireEnabled(peer);result={thread:await readCodexThread(rpc,peer.sessionId!,{timeout:5000,progress:true})};}
      catch(error){this.services.health.unverified(endpoint.address,peer.sessionId!,revision);throw error;}
      if(result.thread?.id!==peer.sessionId)throw new BridgeError('session_changed','原生状态返回了不同的线程，未处理目标。');
      const current=store.peer(peer.id),status=result.thread.status;
      if(current.sessionId!==peer.sessionId||store.endpoint(peer.id)?.epoch!==endpoint.epoch)throw new BridgeError('session_changed','原生状态核对期间目标会话已经改变。');
      await this.refreshCodexPermission(current,result.thread.path);
      if(this.services.health.revision(endpoint.address,peer.sessionId!)===revision&&store.peer(peer.id).state==='unknown'&&status?.type)store.updatePeer(peer.id,{state:status.activeFlags?.some((flag:string)=>/approval|input/i.test(flag))?'needsHuman':status.type==='active'?'busy':status.type==='idle'?'ready':status.type==='notLoaded'?'offline':'unknown'});
      let health=this.services.health.read(endpoint.address,result.thread,revision);
                                            
      if(health?.state==='silent')health=await this.probePendingTools(peer,endpoint,health,result.thread.path??endpoint.nativeSession?.transcriptPath);
      return this.modelRequestHealth(peer,endpoint,health);
    }

  async refreshCodexPermission(peer:Peer,file:unknown):Promise<void>{
    const {store}=this.environment;
      if(!peer.sessionId)return;const endpoint=store.endpoint(peer.id);if(!endpoint)return;
      const profile=await readSessionProfile(file,peer.sessionId),current=store.endpoint(peer.id),currentPeer=store.peer(peer.id);
      if(currentPeer.sessionId!==peer.sessionId||current?.epoch!==endpoint.epoch)return;
      if(profile.verified&&profile.complete){
        const observed=runtimeProfile(currentPeer,{model:profile.settings.model,effort:profile.settings.reasoningEffort});store.updatePeer(peer.id,observed);
        if(endpoint.mode!=='app-server'&&profile.compaction)this.services.communicationTips.cooperation.compacted(peer,profile.compaction.id,profile.compaction.at);
        if(profile.usage)this.services.communicationTips.cooperation.usage(peer,{tokens:profile.usage.inputTokens,at:profile.usage.at});
      }
      const evidence=codexProfileEvidence(profile);
      if(evidence){const observed=observeCodexPermission(current,peer.sessionId,evidence,'native-rollout');store.saveEndpoint(observed);store.updatePeer(peer.id,{permission:daemonPermission(observed.codexPermission??{})});}
      if(this.services.foregroundHealth.reconcile(currentPeer,profile)==='paused')this.services.questions.cancelPeer(peer.id);
    }

  private async healthNotice(pairId:string,peer:Peer,id:string,message:string,source?:RuntimeNotice['source']):Promise<'submitted'|'pending'|'unknown'|'denied'>{
    const {store}=this.environment;
      if(hostingGate(store,peer))return'pending';
      const scoped=store.pairFor(peer.id);if(!this.hooks.enabled(peer.id)||scoped&&(!this.hooks.enabled(scoped.claude)||!this.hooks.enabled(scoped.codex)))return'pending';
      if(this.hooks.stopped())return'pending';
      const pair=store.pairById(pairId);if(!pair||pair.archived||pair.paused)return'pending';
      const target=store.peer(pair[otherHost(peer.host)]),endpoint=store.endpoint(target.id);if(!endpoint||!target.sessionId||['paused','needsHuman','offline'].includes(target.state))return'pending';
      if(!this.hooks.ownedClaudeLaunchReady(target)||this.services.profiles.blocks(target))return'pending';
      const actor:Actor={host:target.host,memberId:target.id,sessionId:target.sessionId,callId:randomUUID(),...(store.bindings.current(target.id)?{binding:{key:store.bindings.current(target.id)!.key,epoch:store.bindings.current(target.id)!.epoch}}:{})};
      let admitted=false;
      const delivery:DeliveryMessage={id,pairId,from:peer.id,to:target.id,body:message,inReplyTo:null,via:null,callId:id,state:'accepted',createdAt:Date.now(),updatedAt:Date.now(),evidence:null,error:null,attempts:1,notice:true,...(source?{noticeSource:source}:{}),beforeSubmit:async()=>{const fresh=(await this.prepareNotices(actor,[id],true,true))[0];if(!fresh||this.services.profiles.blocks(store.peer(target.id)))return false;admitted=true;delivery.body=fresh.message;return true;}};
                                      
      try{
        if(endpoint.daemon){await this.hooks.signalCodexWake(target,endpoint);return'pending';}
        if(endpoint.mode==='embedded'){
          await this.hooks.signalEmbeddedWake(target,endpoint);
          return'pending';
        }
        if(target.host==='codex'){
          await this.hooks.signalCodexWake(target,endpoint);
          return'pending';
        }
        const result=await this.environment.adapters.claude.deliver(target,endpoint,delivery,peer);
        store.event('health.notice',{noticeId:id,peerId:target.id,state:result.state});
        const outcome=result.state==='expired'?'denied':result.state==='unknown'?'unknown':'submitted';
        if(admitted)this.services.deliveryHealth.outcome(pairId,target.id,id,outcome);
        return outcome;
      }catch(error){
        store.event('health.notice.unknown',{noticeId:id,peerId:target.id,error:describeError(error)});
        const outcome=error instanceof DeliveryError&&!error.uncertain?'pending':'unknown';if(admitted)this.services.deliveryHealth.outcome(pairId,target.id,id,outcome);return outcome;
      }
    }

  async checkDeliveryHealth():Promise<void>{
    const {store}=this.environment;
      if(Date.now()-this.deliveryHealthCheckedAt<5000)return;this.deliveryHealthCheckedAt=Date.now();
      const monitor=Date.now()-this.unqueuedHealthCheckedAt>=30000;if(monitor)this.unqueuedHealthCheckedAt=Date.now();
      await Promise.allSettled(store.pairs().filter(pair=>!pair.paused).flatMap(pair=>[pair.codex,pair.claude].map(id=>({pair,id}))).map(({pair,id})=>this.hooks.pumpStage('delivery_health:'+id,async()=>{
        const sender=store.peer(id),partner=store.peer(pair[sender.host==='codex'?'claude':'codex']),counts=store.deliveryCounts(pair.id,id);
        if(!this.hooks.enabled(id)||!this.hooks.enabled(partner.id))return;
        if(!monitor&&!unsettledCount(counts)&&!this.services.deliveryHealth.active(pair.id,id)&&!this.services.deliveryHealth.hasPending(pair.id,id))return;
        const availability=await this.deliveryAvailability(sender,partner);
        if(this.hooks.stopped()||store.pairFor(id)?.id!==pair.id||store.pairFor(id)?.paused)return;
        this.services.deliveryHealth.observe(pair,sender,partner,counts,availability,monitor,this.noticeScope(pair,store.peer(id)));
        const endpoint=store.endpoint(sender.id);
                                                                 
        if(!endpoint||sender.host==='claude'&&endpoint.questionSupport||['paused','needsHuman','offline'].includes(sender.state))return;
        if(endpoint.mode==='embedded'&&sender.state!=='ready')return;
                                             
        for(const notice of this.services.deliveryHealth.peek(pair.id,id).filter(n=>n.wake===true)){
          await this.healthNotice(pair.id,partner,notice.id,notice.message,notice.source);
        }
      })));
    }

  async checkTurnHealth():Promise<void>{
      if(Date.now()-this.healthCheckedAt<30000)return;this.healthCheckedAt=Date.now();
      await Promise.allSettled(this.environment.store.pairs().filter(pair=>!pair.paused).map(pair=>this.hooks.pumpStage('turn_health:'+pair.id,()=>this.checkPairTurnHealth(pair))));
    }

  private turnNoticeTier(pair:Pair,peer:Peer,health:TurnHealth|undefined):1|3{
    const {store}=this.environment;
      if(!health||health.state==='waitingTool'||health.progressEvidence===false||providerBlocked(health)||store.questions(true).some(q=>q.from===peer.id||q.to===peer.id))return 1;
      const since=store.deliveryDependencySince(pair.id,peer.id);if(since===undefined)return 1;
                                                 
      const contact=Math.max(store.lastMessageFacts(pair.id,peer.id)?.createdAt??0,store.setting<number>('functionalDelivery:'+peer.id)??0);
      return Date.now()-Math.max(since,contact,health.retry?.since??health.lastProgressAt)>=(health.retry?300000:900000)?3:1;
    }

  private async checkPairTurnHealth(pair:Pair):Promise<void>{
    const {store}=this.environment;
      if(!this.hooks.enabled(pair.codex)||!this.hooks.enabled(pair.claude))return;
      const peer=store.peer(pair.codex),endpoint=store.endpoint(peer.id);if(!peer.sessionId||!endpoint)return;
      if(endpoint.mode!=='app-server'){
        let health=this.services.foregroundHealth.get(peer);
        const known=store.setting<{sessionId:string;file:string}>('codexTranscript:'+peer.id);
        let file:unknown=known?.sessionId===peer.sessionId?known.file:endpoint.nativeSession?.transcriptPath;
        if(endpoint.configHome&&health&&!['ready','failed'].includes(health.state)){
          file??=sessionFile(endpoint.configHome,peer.sessionId);
          if(file&&known?.file!==file)store.setSetting('codexTranscript:'+peer.id,{sessionId:peer.sessionId,file});
          await this.refreshCodexPermission(peer,file);
          health=this.services.foregroundHealth.get(store.peer(peer.id));
        }
        if(health?.state==='silent'&&this.claimTurnHealthProbe(peer,endpoint))await this.probePendingTools(peer,endpoint,health,file);
        return;
      }
      type Incident={id:string;pairId:string;peerId:string;turnId:string;lastProgressAt:number;recovered?:boolean;scope?:string;endpointEpoch?:string;alertAdmitted?:boolean;recoveryId?:string};
      const incidentKey='turnHealthIncident:'+pair.id;let previous=store.setting<Incident>(incidentKey);
      const recipient=store.peer(pair.claude),scope=this.noticeScope(pair,recipient);
      const managed=this.services.managedRecovery.get(peer.id);if(managed?.pairId===pair.id&&managed.state!=='closed'){if(previous){this.services.deliveryHealth.cancel(pair.id,recipient.id,previous.id);if(previous.recoveryId)this.services.deliveryHealth.cancel(pair.id,recipient.id,previous.recoveryId);store.setSetting(incidentKey,null);}return;}
      if(previous&&(previous.scope&&previous.scope!==scope||previous.endpointEpoch&&previous.endpointEpoch!==endpoint.epoch)){this.services.deliveryHealth.cancel(pair.id,recipient.id,previous.id);if(previous.recoveryId)this.services.deliveryHealth.cancel(pair.id,recipient.id,previous.recoveryId);previous=undefined;store.setSetting(incidentKey,null);}
      let health=this.modelRequestHealth(peer,endpoint,this.services.health.get(endpoint.address,peer.sessionId));
                                              
      if(previous&&!previous.recovered&&this.turnNoticeTier(pair,peer,health)<3)this.services.deliveryHealth.cancel(pair.id,recipient.id,previous.id);
      const openTurn=health&&!['ready','failed'].includes(health.state);
      if(peer.state!=='busy'&&peer.state!=='unknown'&&(!previous||previous.recovered)&&!openTurn)return;
      let baselineOnly=false;
      if(!health||Date.now()-health.lastEventAt>=RECENT_PROGRESS_MS||health.state==='silent'||health.state==='networkRetrying'){
                                                  
        if(!this.claimTurnHealthProbe(peer,endpoint))return;
        baselineOnly=!this.services.health.hasSnapshot(endpoint.address,peer.sessionId);
        try{health=await this.probeTurnHealth(peer,endpoint);}catch(error){store.event('health.probe.failed',{peerId:peer.id,error:describeError(error)});return;}
      }
      if(this.hooks.stopped()||!health||store.pairFor(peer.id)?.id!==pair.id||this.noticeScope(pair,store.peer(recipient.id))!==scope||store.endpoint(peer.id)?.epoch!==endpoint.epoch)return;
      if(previous?.pairId===pair.id&&!previous.recovered&&(health.turnId!==previous.turnId||(health.observedProgressAt??0)>previous.lastProgressAt||['ready','failed','waitingTool'].includes(health.state))){
        previous.recovered=true;store.setSetting(incidentKey,previous);store.event('health.recovered',{peerId:peer.id,turnId:previous.turnId});
        this.services.deliveryHealth.cancel(pair.id,recipient.id,previous.id);
        if(previous.alertAdmitted){
          previous.recoveryId??=randomUUID();store.setSetting(incidentKey,previous);
          const message=`nxbridge runtime monitor (not partner reply or user msg): codex ${health.state==='failed'?'turn failed, not recovered':health.state==='ready'?'turn ended ('+health.completion+')':health.state==='waitingTool'?'native tool wait confirmed; earlier silence alert withdrawn, no new progress claimed':'progress resumed'}, turn ${previous.turnId}; nothing replayed; current turn ${health.turnId}, state ${health.state}${health.error?'; native error: '+health.error:''}`;
          this.services.deliveryHealth.enqueue(pair.id,recipient.id,{id:previous.recoveryId,message,state:'pending',source:'turn_health',kind:'turn_health:'+peer.id,phase:'recovery',scope});
        }
      }
      if(providerBlocked(health)){
        if(previous){this.services.deliveryHealth.cancel(pair.id,recipient.id,previous.id);if(previous.recoveryId)this.services.deliveryHealth.cancel(pair.id,recipient.id,previous.recoveryId);store.setSetting(incidentKey,null);}
        return;
      }
      const tier=this.turnNoticeTier(pair,peer,health);
      if(previous&&!previous.recovered&&previous.turnId===health.turnId){
        if(tier<3)this.services.deliveryHealth.cancel(pair.id,recipient.id,previous.id);
        else if(!previous.alertAdmitted&&!this.services.deliveryHealth.get(pair.id,recipient.id,previous.id))previous=undefined;
        else this.services.deliveryHealth.updatePending(pair.id,recipient.id,previous.id,'Partner work still has no verified progress; continue independent work and inspect nxbridge status before changing the held task.',scope,undefined,{tier,wake:false});
      }
                                                
      if(baselineOnly||health.progressEvidence===false||!['silent','networkRetrying'].includes(health.state)||previous?.pairId===pair.id&&previous.turnId===health.turnId&&!previous.recovered)return;
      if(store.questions(true).some(q=>q.from===peer.id||q.to===peer.id))return;
      if(previous?.recoveryId)this.services.deliveryHealth.cancel(pair.id,recipient.id,previous.recoveryId);
      const incident:Incident={id:randomUUID(),pairId:pair.id,peerId:peer.id,turnId:health.turnId,lastProgressAt:health.lastProgressAt,scope,endpointEpoch:endpoint.epoch};
      store.setSetting(incidentKey,incident);store.event('health.alert',{...incident,health:{state:health.state,lastEventAt:health.lastEventAt,...(health.retry?{retry:health.retry}:{}),...(health.error?{error:health.error}: {})}});
        const message=`nxbridge runtime monitor (not partner reply or user msg): codex ${health.state}, turn ${health.turnId}, last progress ${new Date(health.lastProgressAt).toISOString()}. ${health.retry?'native retry: '+health.retry.message:'no observed progress 10+ min, cause unknown, not proof of deadlock'}. work + msg ledger kept. dont resend tasks or kill processes. details: nxbridge status/doctor${health.retry?'; keep native retry; interrupt/restart cannot repair a provider outage':'; explicit recovery (user, outside codex): nxbridge recover codex --turn '+health.turnId}`;
      this.services.deliveryHealth.enqueue(pair.id,recipient.id,{id:incident.id,message,tier,wake:false,state:'pending',source:'turn_health',kind:'turn_health:'+peer.id,phase:'alert',scope});
    }
}
