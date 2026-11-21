import { randomUUID } from 'node:crypto';
import type { Store, MessageFacts } from '../../storage/store.js';
import {noticeScope} from '../health/contracts.js';
import {type DeliveryHealth} from '../health/delivery.js';
import type { TurnHealth } from '../health/turn-health.js';
import { SILENCE_MS } from '../health/turn-health.js';
import { providerBlocked, modelRequestText } from '../../hosts/codex/codex-model-request.js';
import type { SyncReminder } from '../delivery/communication-tips.js';
import type {Endpoint,Pair,Peer} from '../../types.js';
import { MOD_REVISION } from '../../mod-revision.js';
import { resourceEvidence, type ResourceHealth } from '../health/resource-health.js';
import { HEALTH_UNVERIFIED_MS } from '../health/notice-policy.js';
import { inboundAdmission, inboundWarning } from '../../hosts/claude/claude-inbound.js';
import { hookTrustMessage, type HookTrustIssue } from '../../hosts/codex/codex-hook-trust.js';
import { diagnosisAdvice, partnerRestartAdvice } from '../../app/commands/agent-command.js';
import { daemonDelivery } from '../delivery/delivery-guidance.js';
import { mergeObservedFields, type FieldObservation } from '../../storage/observed-fields.js';
import { modStaleNotice, MOD_STALE_NOTICE_MS } from '../../integration/mod/mod-reload.js';

export interface IntegrationEvidence {
  nativeHookDurations?:{event:string;durationMs:number}[];
  modObservation?:FieldObservation<{version?:string;revision?:string}>;
  scope:string;since:number;turnsWithoutHook:number;lastTurnAt?:number;lastHookAt?:number;lastTurnId?:string;lastHookTurnId?:string;hookError?:string;modVersion?:string;modRevision?:string;modSeenAt?:number;
  nativeSessionAt?:number;firstNativeInteractionAt?:number;mcpInteractionAt?:number;
                                                     
  currentModAt?:number;
  hookTimeouts?:{count:number;firstAt:number;lastAt:number;limitSeconds?:number};hookTrustIssue?:HookTrustIssue;
  wakeQueueError?:string;pickup?:{exhausted?:boolean;attempts:number;error?:string;anchor?:string;scope?:string};
                                                                    
  failedTurnId?:string;
}
export const hookTimedOut=(error:string)=>/\bhook timed out\b|\bhook[^;\n]*\btimeout\b/i.test(error);
                                                       
export interface PairIssue {kind:string;message:string;factKey?:string;terminal?:boolean;firstSeenAt?:number;asOf?:number}
                                              
const TERMINAL_KINDS=new Set(['turn_failed','continuation_failed','pickup_exhausted']);
export interface PairObservation {
  nativeHistory?:{status:string;reason?:string};
                                                        
  continuation?:{anchor:string;attempts:number;uncertain?:boolean;error?:string;scope?:string};
  pair:Pair;peer:Peer;endpoint?:Endpoint;now:number;messages:MessageFacts[];transitioning:boolean;
  questionPending:boolean;health?:TurnHealth;integration:IntegrationEvidence;version:string;
  syncReminder?:SyncReminder;unanswered?:MessageFacts[];lastMessage?:MessageFacts;
  replyContractActive?:boolean;modRevision?:string;
  partnerPermission?:Peer['permission'];home?:string;
  pickup?:{exhausted?:boolean;attempts:number;error?:string;anchor?:string;scope?:string};
}
const grace=120000;
                                                 
export const MOD_STALE_GRACE_MS=MOD_STALE_NOTICE_MS;
const claudeReload='only the affected Claude window may call its reload_plugins tool once at a safe turn end; if that tool is unavailable or next status is still stale, tell user to run native /reload-plugins there; Codex cannot reload another window; no retry loop';
export function pairIssues(value:PairObservation):PairIssue[]{
  const {peer,endpoint,now,health,integration}=value,issues:PairIssue[]=[],add=(kind:string,message:string,factKey?:string,terminal?:boolean)=>issues.push({kind,message,...(factKey!==undefined?{factKey}:{}),...(terminal?{terminal}:{})});
  if(!value.pair.archived&&peer.launchFailure){add('launch_failed',`后台 ${peer.host} 启动失败：${peer.launchFailure.message}；消息已保留且未投递。修复原因后运行 nxbridge open ${peer.host} --member ${peer.id} 重试；详细诊断：nxbridge doctor`);return issues;}
                                                            
  const failedTurn=()=>{if(health?.state==='failed'&&!value.questionPending)add('turn_failed',`${peer.host} turn ${health.turnId} failed${health.error?': '+health.error:''}`,JSON.stringify([peer.id,health.turnId]),true);};
  if(value.pair.archived||endpoint?.pendingContext)return issues;
                                                               
                                                
  if(peer.state==='offline'){if(endpoint)failedTurn();return issues;}
  if(providerBlocked(health)){
    add('provider_retry',modelRequestText(health!.modelRequest!)+'；等待模型服务，必要时由用户检查供应商。');
    return issues;
  }
  if(peer.host==='claude'){
    const admission=inboundAdmission(value.partnerPermission??'unknown',endpoint),warning=inboundWarning(admission);
    if(warning)add(admission==='refused'?'inbound_refuse':'inbound_hold',warning);
  }
  const contractSince=Math.max(integration.since,integration.nativeSessionAt??0,endpoint?.daemon?integration.firstNativeInteractionAt??now:0);
  if(value.replyContractActive===false&&now-contractSince>=grace)add('contract_inactive',`reply-link contract not verified by a current nxbridge interaction; seen-without-reply detection inactive; delivery and native-progress monitors remain active; ${peer.host==='codex'?(endpoint?.daemon?'shared-daemon Codex: tell user to continue in the existing Codex window '+peer.name+' (session '+peer.sessionId+'); current nxbridge MCP interaction verifies the contract; discovery/resume alone does not; do not ask to reopen/resume again or restart the shared daemon':peer.owner==='nxbridge'?partnerRestartAdvice(value.home):'user-owned Codex: tell user to reopen/resume original session id; AI must not restart it'):'native /reload-plugins in the original Claude window; other windows cannot reload it'}`);
                                         
  if(peer.host==='claude'&&(now-integration.since>=grace||integration.mcpInteractionAt!==undefined&&(!endpoint?.questionSupport||integration.modSeenAt===undefined||now-integration.modSeenAt>=grace))){
    if(!endpoint?.questionSupport||now-(integration.modSeenAt??integration.since)>=grace||integration.mcpInteractionAt!==undefined&&integration.modSeenAt===undefined)add('mod_missing','no recent verified Mod registration/heartbeat; pure MCP may require extra native approval; '+claudeReload);
    else if(integration.modVersion!==value.version||value.modRevision!==undefined&&integration.modRevision!==value.modRevision)add('mod_stale',(integration.modVersion?`loaded Claude Mod ${integration.modVersion}/${integration.modRevision??'unknown'}, runtime ${value.version}/${value.modRevision??'unknown'}`:'loaded Claude Mod version unverified; possible old Mod')+'; '+claudeReload,JSON.stringify([integration.modRevision??integration.modVersion??null,value.modRevision??value.version]));
  }
  if(peer.host==='codex'){
    if(value.nativeHistory?.status==='unsupported')add('history_receipt_unverified','原生持久历史格式无法核验，消息只在完整调用与结果匹配后确认进入上下文；请查看 nxbridge doctor，勿重发正文');
                                           
    const continuation=value.continuation;
    if(continuation&&(continuation.error||continuation.attempts>=3)){
      const exhausted=continuation.attempts>=3&&!continuation.uncertain;
      add('continuation_failed','正文已进入原生持久历史，但模型续跑失败：'+(continuation.error??'续跑已达到三次尝试上限')+(exhausted?'；自动续跑已停止':continuation.uncertain?'；最近一次续跑结果未知':'；仍会自动重试')+'；请在原窗口继续，勿重发正文',JSON.stringify([continuation.scope??null,continuation.anchor]),exhausted&&!value.questionPending);
    }
    if(integration.pickup?.exhausted)add('pickup_exhausted',`已尝试 ${integration.pickup.attempts} 次唤醒，但 Codex 尚未取件；消息正文仍在持久收件箱，自动唤醒已停止。请在原 Codex 窗口继续并调用 claude.receive_messages，或查看 nxbridge status/doctor；不要重发正文${integration.pickup.error?'；最近唤醒错误：'+integration.pickup.error:''}`,JSON.stringify([integration.pickup.scope??null,integration.pickup.anchor??null]),!value.questionPending);
    if(integration.wakeQueueError)add('wake_queue_unverified',`原生唤醒队列无法核验（${integration.wakeQueueError}）；保留消息，通过 hooks 取件，兼容唤醒最多每十分钟尝试一次; ${diagnosisAdvice(value.home)}`);
    if(integration.hookError&&!hookTimedOut(integration.hookError)){
      if(integration.hookTrustIssue)add(integration.hookTrustIssue,hookTrustMessage(peer,integration.hookTrustIssue,false,value.home));
      else add('hooks_blocked',`hook failed (${integration.hookError.replace(/^hook\s+/i,'')}); ${diagnosisAdvice(value.home)}`);
    }
    else if((integration.hookTimeouts?.count??0)>=3&&now-integration.hookTimeouts!.firstAt>=HEALTH_UNVERIFIED_MS)add('hooks_timeout',`hook timeout after ${integration.hookTimeouts?.limitSeconds??10}s; info only, machine load may delay delivery; not a reason to restart`);
                                                                                               
                                                                            
    else if(!integration.hookTimeouts&&!integration.hookError&&!(integration.lastTurnId&&integration.lastHookTurnId===integration.lastTurnId)&&!(integration.lastTurnId&&(integration.failedTurnId===integration.lastTurnId||health?.state==='failed'&&health.turnId===integration.lastTurnId))&&(integration.turnsWithoutHook>=2||peer.state!=='busy'&&integration.lastTurnAt!==undefined&&now-integration.lastTurnAt>=grace&&(!integration.lastHookAt||integration.lastHookAt<integration.lastTurnAt)))add('hooks_missing',`no verified nxbridge hook event since ${new Date(integration.lastHookAt??integration.since).toISOString()}; possible untrusted/disabled hooks or old host; ${diagnosisAdvice(value.home)}`);
  }
  failedTurn();
  if(health?.state==='ready'&&health.nativeIssue&&health.nativeIssue.kind!=='tool_failed')add('native_denied',`${peer.host} turn ${health.turnId}: observed ${health.nativeIssue.kind} for ${health.nativeIssue.tool??'native tool'}${health.nativeIssue.item_id?' ('+health.nativeIssue.item_id+')':''}; tool fact only, task outcome remains unverified; inspect the original turn and partner reply, do not auto-replay or change permissions`);
  if(value.pair.paused||['paused','needsHuman','offline','starting'].includes(peer.state))return issues;
  const pending=value.messages.filter(m=>m.to===peer.id&&now-m.updatedAt>=grace&&['accepted','sending','runtimeQueued','held','unknown','refused','expired'].includes(m.state));
  const stalled=peer.state==='busy'&&health&&!['needsHuman','ready','failed'].includes(health.state)&&now-health.lastProgressAt>=SILENCE_MS;
  for(const state of [...new Set(pending.map(m=>m.state))]){
    if(['accepted','sending','runtimeQueued'].includes(state)&&peer.state!=='ready'&&!stalled)continue;
    const rows=pending.filter(m=>m.state===state);
    const daemonWait=state==='accepted'?daemonDelivery(peer,endpoint,rows.length,value.transitioning).delivery_wait:undefined;
    add('delivery_'+state,`${rows.length} msg(s) remain ${state} for 2+ min: ${rows.slice(-5).map(m=>m.id).join(', ')}; ${daemonWait?daemonWait.message:state==='runtimeQueued'?'native queued != observed in context; an interrupted turn may discard its pending output; inspect original history/replies before any manual resend':state==='unknown'?'submission outcome unknown; never auto-replay':state==='held'?'native admission held; inspect original window':'inspect delivery/status before any resend'}`,state==='unknown'?JSON.stringify([value.pair.id,...rows.map(m=>m.id).sort()]):undefined);
  }
  if(value.transitioning&&pending.length)add('context_stuck','window context transition still holds pending msgs after 2+ min; next verified native context required');
  if(peer.state==='busy'&&!value.questionPending){
    if(!value.transitioning&&value.syncReminder&&now>=value.syncReminder.dueAt&&value.unanswered?.length){
      const last=value.lastMessage;
      add('busy_unanswered',`busy since ${new Date(peer.stateSince??peer.activityAt??now).toISOString()}; sync tip fired ${new Date(value.syncReminder.firedAt).toISOString()}, another sync period passed without a msg to you; last msg to you: ${last?last.id+' at '+new Date(last.createdAt).toISOString():'none'}; your msgs seen since its last send (<=3, newest first): ${value.unanswered.slice(0,3).map(m=>m.id).join(', ')}; native progress does not establish work on the current task`);
    }
    else if(health?.state==='networkRetrying'&&peer.host==='claude')add('turn_retrying',`${peer.host} native retry: ${health.retry?.message??'retry in progress'}; last progress ${new Date(health.lastProgressAt).toISOString()}`);
                                                                        
    else if(health?.progressEvidence===false&&!['needsHuman','ready'].includes(health.state)&&now-health.lastProgressAt>=SILENCE_MS)add('progress_unverified',`${peer.host} turn ${health.turnId}: native progress observation unavailable for 10+ min (no event stream or latest-item read); not evidence of a stall; inspect original window/status`);
    else if(health&&now-health.lastProgressAt>=SILENCE_MS&&!['needsHuman','ready'].includes(health.state)&&(peer.host==='claude'||endpoint?.mode==='embedded'||health.tools.length))add(health.tools.length?'tool_wait':'turn_silent',`${peer.host} turn ${health.turnId}: ${health.tools.length?'waiting for native tool(s) '+health.tools.join(', '):'no observed progress'} for 10+ min; cause unknown, not proof of deadlock`);
    else if(!health&&now-Math.max(peer.stateSince??peer.activityAt??now,peer.activityAt??0)>=SILENCE_MS)add('progress_unverified',`${peer.host} reported busy for 10+ min; native progress observation unavailable; inspect original window/status, do not assume a hang`);
  }
  return issues;
}

interface IssueNotice {id:string;recipient:string;kind:string;factKey?:string}
interface Incidents {scope:string;issues:PairIssue[];notices:IssueNotice[];gone?:{kind:string;message:string;factKey?:string;firstSeenAt:number;goneAt:number}[]}
                                                    
export const TURN_FAILED_SETTLE_MS=30_000;
                                                                                                                 
function rejection(error:string|undefined):{status:number;type?:string}|undefined{
  const start=error?.indexOf('{')??-1;if(start<0)return;
  let value:any;try{value=JSON.parse(error!.slice(start));}catch{return;}
  const status=Number(value?.status??value?.error?.status);
  return Number.isInteger(status)&&status>=400&&status<=599?{status,...(typeof value?.error?.type==='string'?{type:value.error.type}:{})}:undefined;
}
                            
function failureStatus(health:TurnHealth|undefined):{status?:number;kind?:string;type?:string}{
  const request=health?.modelRequest;
  if(request?.state==='failed')return{...(request.statusCode!==undefined?{status:request.statusCode}:{}),kind:request.kind,...(rejection(health?.error)?.type?{type:rejection(health?.error)!.type}:{})};
  const rejected=rejection(health?.error);
  return rejected?{status:rejected.status,kind:rejected.status===429?'quota':[401,403].includes(rejected.status)?'auth':'http',...(rejected.type?{type:rejected.type}:{})}:{};
}
                                                          
const refusedRequest=(failure:{status?:number;kind?:string})=>failure.kind==='http'&&failure.status!==undefined&&failure.status>=400&&failure.status<500&&![401,403,408,429].includes(failure.status);
                                     
function failureCause(health:TurnHealth|undefined):string{
  const request=health?.modelRequest,failure=failureStatus(health),code=failure.status;
  const cause=request?.state==='failed'&&request.kind==='timeout'?'model request timeout':request?.state==='failed'&&request.kind==='network'?'provider unreachable':failure.kind==='quota'?`provider rate limit/quota (${code??429})`:failure.kind==='auth'?`provider rejected credentials (${code??'auth'})`:code&&code>=500?`provider unavailable (${code})`:code?`provider refused the request (${code}${failure.type?' '+failure.type:''})`:request?.state==='failed'?'model request failed':undefined;
  const error=health?.error?.replace(/\s+/g,' ').trim().slice(0,300);
  return [cause,error?'native error: '+error:undefined].filter(Boolean).join('; ')||'cause not reported';
}
                                                          
                                                                                                                                                                                                                                 
                                                                               
                                                                                                            
                                                                       
                                                                                                                                                                    
function automationStoppedText(peer:Peer,endpoint:Endpoint|undefined,kind:string,pickup:IntegrationEvidence['pickup'],continuation:{attempts:number;error?:string}|undefined):string{
  const facts=kind==='pickup_exhausted'
    ? `your partner ${peer.name} (${peer.host}) has not picked up your msg(s) after ${pickup?.attempts??'several'} wake attempts; automatic waking stopped; msgs stay in its durable inbox (nothing lost or replayed)${pickup?.error?'; last wake error: '+pickup.error.replace(/\s+/g,' ').slice(0,300):''}`
    : `your msg is in partner ${peer.name}'s (${peer.host}) durable history, but starting its model failed ${continuation?.attempts??3} times${continuation?.error?' ('+continuation.error.replace(/\s+/g,' ').slice(0,300)+')':''}; it will not process it by itself; do not resend the body`;
  const action=peer.owner==='nxbridge'&&!endpoint?.daemon
    ? 'It is an nxbridge-owned background partner: decide whether one short resume msg is worth a fresh attempt, else tell the user.'
    : `It is a user-owned window: AI cannot restart it; tell the user the exact step: continue in the original ${peer.host} window "${peer.name}" (session ${peer.sessionId??'unknown'})${kind==='pickup_exhausted'?' and call claude.receive_messages there':''}; no restart, no resend.`;
  return `nxbridge runtime monitor (not partner reply or user msg): ${facts}. ${action} Meanwhile continue work that does not depend on it.`;
}
                                                                                                                                                     
function turnFailedText(peer:Peer,health:TurnHealth|undefined,issue:PairIssue):string{
  const failure=failureStatus(health),persistent=failure.kind==='quota'||failure.kind==='auth';
  const decide=refusedRequest(failure)
    ? 'The provider refused the request itself (4xx, e.g. "model requires a newer Codex"); this usually repeats. Tell the user the exact error (user-owned fix, e.g. upgrade Codex or switch model; do not upgrade it yourself). If the work is still needed, at most one short resume msg (such refusals are sometimes intermittent), never loop resends; or take the work over.'
    : `Decide: if you still need that work, send it one short resume msg (it continues from its own session history; do not resend the full task); or take the work over; or tell the user.${persistent?' Quota/auth errors usually persist: check nxbridge status before resending; do not loop resends.':''}`;
  return `nxbridge runtime monitor (not partner reply or user msg): your partner ${peer.name} (${peer.host}) turn ${health?.turnId??'unknown'} failed (observed ${new Date(issue.firstSeenAt??Date.now()).toISOString()}): ${failureCause(health)}. Native retries are exhausted; it will not resume this work by itself; nothing was replayed. ${decide} Repeat failures are rate-limited.`;
}
const CURRENT_MOD_PREFERENCE_MS=120_000;
                                                                       
const FLAP_MS=120_000;
                                                                            
const DEPENDENCY_MS=5*60_000,QUIET_MS=15*60_000,DELIVERY_STUCK_MS=3*60_000;
export class PairAnomalies {
  constructor(private store:Store,private notices:DeliveryHealth,private version:string,private resources?:ResourceHealth,private home?:string){}
  private scope(peer:Peer):string{return JSON.stringify([peer.sessionId,this.store.bindings.current(peer.id)?.epoch]);}
  private currentEvidence(peer:Peer,scope=this.scope(peer)):IntegrationEvidence{
    const value=this.store.setting<IntegrationEvidence>('integration:'+peer.id);
    return value?.scope===scope?value:{scope,since:Date.now(),turnsWithoutHook:0};
  }
  evidence(peer:Peer):IntegrationEvidence{
    const key='integration:'+peer.id,previous=this.store.setting<IntegrationEvidence>(key),scope=this.scope(peer);
    if(previous?.scope===scope)return previous;
    const value:IntegrationEvidence={scope,since:Date.now(),turnsWithoutHook:0};this.store.setSetting(key,value);return value;
  }
  restarted(peer:Peer):void{this.store.setSetting('integration:'+peer.id,{scope:this.scope(peer),since:Date.now(),turnsWithoutHook:0});}
  hookTimings(peer:Peer):{peerId:string;source:string;events:{event:string;count:number;lastMs:number;p50Ms:number;p95Ms:number;maxMs:number;samplesMs:number[]}[]}|undefined{
    const samples=this.currentEvidence(peer).nativeHookDurations;if(!samples?.length)return;
    const events=[...new Set(samples.map(row=>row.event))].map(event=>{
      const values=samples.filter(row=>row.event===event).map(row=>row.durationMs),sorted=[...values].sort((a,b)=>a-b),at=(q:number)=>sorted[Math.min(sorted.length-1,Math.ceil(q*sorted.length)-1)]!;
      return{event,count:values.length,lastMs:values.at(-1)!,p50Ms:at(.5),p95Ms:at(.95),maxMs:at(1),samplesMs:values};
    });
    return{peerId:peer.id,source:'codex hook/completed',events};
  }
  integration(peer:Peer,input:{nativeHook?:{event:string;durationMs:number};turn?:true;turnFailed?:true;turnId?:string;hook?:true;hookSeen?:true;sessionStart?:true;nativeInput?:true;hookError?:string;hookTrustIssue?:HookTrustIssue|null;modVersion?:string;modRevision?:string;mod?:true;mcp?:true;wakeQueueError?:string|null;pickup?:IntegrationEvidence['pickup']|null}):void{
    const value=this.currentEvidence(peer);
    if(input.sessionStart){value.nativeSessionAt=Date.now();delete value.firstNativeInteractionAt;}
    if((input.nativeInput||input.turn)&&value.firstNativeInteractionAt===undefined)value.firstNativeInteractionAt=Date.now();
    if(input.pickup!==undefined){if(input.pickup)value.pickup=input.pickup;else delete value.pickup;}
    if(input.wakeQueueError!==undefined){if(input.wakeQueueError)value.wakeQueueError=input.wakeQueueError;else delete value.wakeQueueError;}
                                                        
    if(input.turn){value.lastTurnAt=Date.now();value.lastTurnId=input.turnId;value.turnsWithoutHook=input.turnId&&value.lastHookTurnId===input.turnId?0:value.turnsWithoutHook+1;}
    if(input.hook||input.hookSeen){value.lastHookAt=Date.now();value.turnsWithoutHook=0;}
    if(input.hook&&input.turnId)value.lastHookTurnId=input.turnId;
                                                             
    if(input.turnFailed&&input.turnId&&value.lastTurnId===input.turnId&&value.lastHookTurnId!==input.turnId&&value.failedTurnId!==input.turnId){value.turnsWithoutHook=Math.max(0,value.turnsWithoutHook-1);value.failedTurnId=input.turnId;}
                                                     
    if(input.hook){delete value.hookError;delete value.hookTimeouts;delete value.hookTrustIssue;}
    if(input.nativeHook)value.nativeHookDurations=[...(value.nativeHookDurations??[]),input.nativeHook].slice(-40);
    if(input.hookError){
      if(value.hookError!==input.hookError)delete value.hookTrustIssue;
      if(hookTimedOut(input.hookError)){
        void this.resources?.request('hook_timeout');
        const now=Date.now(),limit=/timed out after\s+(\d+(?:\.\d+)?)s\b/i.exec(input.hookError);value.hookTimeouts={count:(value.hookTimeouts?.count??0)+1,firstAt:value.hookTimeouts?.firstAt??now,lastAt:now,...(limit?{limitSeconds:Number(limit[1])}:{})};
        if(value.hookError&&hookTimedOut(value.hookError))delete value.hookError;
      }else value.hookError=input.hookError.slice(0,1000);
    }
    if(input.hookTrustIssue!==undefined){if(input.hookTrustIssue)value.hookTrustIssue=input.hookTrustIssue;else delete value.hookTrustIssue;}
    const prior=value.modObservation??(value.modVersion||value.modRevision?{value:{version:value.modVersion,revision:value.modRevision},source:'prior-mod',context:value.scope,observedAt:value.modSeenAt??value.since}:undefined);
                                                                    
                                                                                   
    let incoming:{version?:string;revision?:string}={version:input.modVersion,revision:input.modRevision};
    if(input.modRevision!==undefined){
      const now=Date.now();
      if(input.modRevision===MOD_REVISION)value.currentModAt=now;
      else if(value.modRevision===MOD_REVISION&&value.currentModAt!==undefined&&now-value.currentModAt<=CURRENT_MOD_PREFERENCE_MS)incoming={};
    }
    const observation=mergeObservedFields(prior,incoming,{source:input.mod?'native-mod':'registration',context:value.scope,observedAt:Date.now()},[['version','revision']]);
    if(observation){value.modObservation=observation;value.modVersion=observation.value.version;value.modRevision=observation.value.revision;}
    if(input.mod)value.modSeenAt=Date.now();
    if(input.mcp)value.mcpInteractionAt=Date.now();
    this.store.setSetting('integration:'+peer.id,value);
    const mod=/^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(input.modVersion??'');
    if(peer.host==='claude'&&mod&&(Number(mod[1])>0||Number(mod[2])>1||Number(mod[2])===1&&Number(mod[3])>=1))this.store.adoptReplyContract(peer.id,'mod');
  }
  observe(pair:Pair,peer:Peer,health?:TurnHealth,syncReminder?:SyncReminder,site?:string):void{
    this.store.transaction(()=>{
      const eligible=!pair.paused&&!['paused','needsHuman','offline','starting'].includes(peer.state);
      const binding=this.store.bindings.current(peer.id),peerScope=JSON.stringify([peer.sessionId,binding?.epoch]),scope=JSON.stringify([pair.id,peerScope]);
      const key='pairIssues:'+peer.id,previous=this.store.setting<Incidents>(key),recipient=pair[peer.host==='codex'?'claude':'codex'],partner=this.store.peer(recipient),partnerBinding=this.store.bindings.current(recipient),endpoint=this.store.endpoint(peer.id),now=Date.now();
      const integration=this.currentEvidence(peer,peerScope),direct=this.store.setting<{scope?:string;continuation?:{anchor:string;attempts:number;uncertain?:boolean;error?:string}}>('codexDirect:'+peer.id),lastMessage=this.store.lastMessageFacts(pair.id,peer.id),messages=eligible?this.store.deliveryIssueFacts(pair.id,peer.id):[];
      const value:Incidents={scope,issues:pairIssues({nativeHistory:this.store.setting('codexHistoryCompatibility:'+peer.id),continuation:direct?.continuation?{...direct.continuation,scope:direct.scope}:undefined,pair,peer,endpoint,partnerPermission:partner.permission,home:this.home,now,messages,transitioning:binding?.transitioning??false,questionPending:this.store.questions(true).some(q=>q.from===peer.id||q.to===peer.id),health,integration,version:this.version,modRevision:MOD_REVISION,replyContractActive:!!this.store.setting('replyContract:'+peer.id),syncReminder,unanswered:syncReminder?this.store.seenSinceLastSendFacts(pair.id,peer.id,binding?.activatedAt??pair.createdAt):undefined,lastMessage:syncReminder?lastMessage:undefined}),notices:[]};
      const receipt=this.store.setting<{sessionId?:string;reportedAt?:number;diagnostic:{consecutive:number;last_error:{at:number}}}>('modReceiptDiagnostic:'+peer.id);
                                                                          
      const same=(row:{kind:string;message:string;factKey?:string},issue:PairIssue)=>row.kind===issue.kind&&(issue.kind==='mod_stale'?row.message===issue.message:TERMINAL_KINDS.has(issue.kind)?row.factKey===issue.factKey:true);
      const recent=previous?.scope===scope?[...previous.issues,...(previous.gone??[]).filter(row=>now-row.goneAt<FLAP_MS)]:[];
      for(const issue of value.issues){const old=recent.find(row=>same(row,issue));issue.firstSeenAt=old?.firstSeenAt??now;issue.asOf=integration.modObservation?.observedAt??now;}
      if(previous?.scope===scope){
        const gone=[...previous.issues.filter(row=>!value.issues.some(issue=>same(row,issue))).map(row=>({kind:row.kind,message:row.message,...(row.factKey!==undefined?{factKey:row.factKey}:{}),firstSeenAt:row.firstSeenAt??now,goneAt:now})),...(previous.gone??[]).filter(row=>now-row.goneAt<FLAP_MS&&!value.issues.some(issue=>same(row,issue)))];
        if(gone.length)value.gone=gone;
      }
                                                    
      const expected=eligible?this.store.expectedReplyFacts(pair.id,peer.id,binding?.activatedAt??pair.createdAt):[];
                                                                                  
      const dependencySince=eligible?this.store.deliveryDependencySince(pair.id,peer.id):undefined,dependent=dependencySince!==undefined;
      const contact=Math.max(lastMessage?.createdAt??0,this.store.setting<number>('functionalDelivery:'+peer.id)??0);
      const waited=(since:number)=>dependent?now-Math.max(dependencySince!,contact,since):0;
      const tier=(issue:PairIssue):1|2|3|4=>{
        const age=now-(issue.firstSeenAt??now);
        switch(issue.kind){
          case'contract_inactive':return peer.host==='codex'&&peer.owner==='nxbridge'&&!endpoint?.daemon?3:1;
          case'hooks_timeout':case'hooks_missing':case'native_denied':return 1;
          case'provider_retry':case'turn_retrying':return dependent&&waited(issue.firstSeenAt??now)>=DEPENDENCY_MS?3:1;
          case'turn_silent':case'tool_wait':case'progress_unverified':return dependent&&waited(health?.lastProgressAt??issue.firstSeenAt??now)>=QUIET_MS?3:1;
          case'busy_unanswered':return expected.length?3:1;
                                                                                                                        
                                                           
          case'turn_failed':return issue.terminal&&['ready','unknown','offline'].includes(peer.state)&&age>=TURN_FAILED_SETTLE_MS?4:1;
                                                        
          case'continuation_failed':case'pickup_exhausted':return issue.terminal&&peer.state==='ready'?4:1;
          case'delivery_accepted':case'delivery_sending':case'delivery_runtimeQueued':case'delivery_held':return age>=DELIVERY_STUCK_MS?3:2;
          default:return 3;
        }
      };
      const receiptFailed=receipt?.sessionId===peer.sessionId&&receipt.diagnostic.consecutive>0&&(receipt.reportedAt??receipt.diagnostic.last_error.at)>=(integration.modSeenAt??0);
      const staleIssue=value.issues.find(issue=>issue.kind==='mod_stale'),staleNotice=staleIssue?modStaleNotice(this.store,peer,staleIssue.firstSeenAt!,MOD_REVISION,now):undefined;
                                       
      const targets=(issue:PairIssue):string[]=>tier(issue)<3?[]:issue.kind==='mod_missing'?[peer.id,recipient]:issue.kind==='mod_stale'?(!staleNotice?[]:[peer.id,...(receiptFailed?[recipient]:[])]):[recipient];
                                                                        
      const noticeTier=(issue:PairIssue,target:string):3|4=>issue.kind==='mod_stale'&&target===peer.id?(staleNotice?.tier??3):tier(issue)===4?4:3;
                                      
                                                     
      for(const notice of previous?.notices??[])if(previous?.scope!==scope||!value.issues.some(issue=>issue.kind===notice.kind&&targets(issue).includes(notice.recipient)&&(!TERMINAL_KINDS.has(issue.kind)||issue.factKey===notice.factKey))){this.notices.cancel(pair.id,notice.recipient,notice.id);this.store.event('health.pair.cancel',{pairId:pair.id,peerId:peer.id,recipient:notice.recipient,noticeId:notice.id,kind:notice.kind,scopeChanged:previous?.scope!==scope,inIssues:value.issues.some(issue=>issue.kind===notice.kind),site:site??null});}else value.notices.push(notice);
      const managed=this.store.setting<{pairId:string;state:string}>('managedRecovery:'+peer.id);
                                                                     
      if(!pair.paused)for(const issue of value.issues.filter(issue=>(peer.launchFailure||!['paused','needsHuman','offline'].includes(peer.state)||peer.state==='offline'&&issue.kind==='turn_failed')&&(issue.kind!=='launch_failed'||managed?.pairId!==pair.id||managed.state==='closed')))for(const target of targets(issue)){
        const existing=value.notices.find(n=>n.kind===issue.kind&&n.recipient===target),id=existing?.id??randomUUID(),recipientPeer=target===peer.id?peer:partner,other=target===peer.id?partner:peer;
        if(!existing)value.notices.push({id,recipient:target,kind:issue.kind,...(TERMINAL_KINDS.has(issue.kind)&&issue.factKey!==undefined?{factKey:issue.factKey}:{})});
        const fallback=target!==peer.id&&['mod_missing','mod_stale'].includes(issue.kind)?' User guidance only: the affected Claude window was already notified, but its Mod is missing or its latest receipt failed. Tell user to run native /reload-plugins there only if still unresolved; do not relay this to Claude or repeat a reload already handled.':'';
        const scope=noticeScope(pair,recipientPeer,other,(target===peer.id?binding:partnerBinding)?.epoch,(target===peer.id?partnerBinding:binding)?.epoch),evidence=issue.kind==='hooks_timeout'?resourceEvidence(this.resources?.snapshot().sample):'';let message=`nxbridge runtime monitor (not partner reply or user msg): ${peer.host}: ${issue.message}.${fallback} Facts only; inspect and decide; no task replay; AI actions limited to the explicitly scoped steps above.${evidence?' '+evidence:''}`;
        const tierFor=noticeTier(issue,target);
                                                                              
                                                                                                                                                                        
        if(issue.kind==='mod_stale'&&target===peer.id&&tierFor===4)message=`nxbridge: this window's Claude Mod is outdated (loaded ${integration.modRevision??integration.modVersion??'unknown'}, current ${MOD_REVISION}; current stable since ${new Date(issue.firstSeenAt??now).toISOString()}). Call reload_plugins once now: it reloads when this turn ends and does not disturb the current task. Later updates reload automatically, so this will not repeat. If the tool is unavailable, tell the user to run /reload-plugins in this window.`;
        if(issue.kind==='turn_failed')message=turnFailedText(peer,health,issue);
        else if(tierFor===4&&(issue.kind==='continuation_failed'||issue.kind==='pickup_exhausted'))message=automationStoppedText(peer,endpoint,issue.kind,integration.pickup,direct?.continuation);
        if(existing)this.notices.updatePending(pair.id,target,id,message,scope,issue.factKey,{tier:tierFor});
        else this.notices.enqueue(pair.id,target,{id,source:'pair_anomaly',state:'pending',scope,message,tier:tierFor,kind:'pair_anomaly:'+peer.id+':'+issue.kind,issueKey:peer.id+':'+issue.kind,factKey:issue.factKey,asOf:issue.asOf});
        if(!existing)this.store.event('health.pair.alert',{pairId:pair.id,peerId:peer.id,recipient:target,noticeId:id,...issue});
      }
      if(JSON.stringify(previous)!==JSON.stringify(value))this.store.setSetting(key,value);
    });
  }
  issues(peerId:string):PairIssue[]{return this.store.setting<Incidents>('pairIssues:'+peerId)?.issues??[];}
}
