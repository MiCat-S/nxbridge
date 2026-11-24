import { statement } from '../../storage/sql-statements.js';
import { randomInt, randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { Store } from '../../storage/store.js';
import {BridgeError,describeError} from '../../shared/errors.js';
import {otherHost,type Actor,type BridgeConfig,type Host,type Peer} from '../../types.js';
import { candidateDescription, candidateLabel } from './pair-presentation.js';
import { pairLossView, restorableOwnedPartner, refreshRestoreObservations, partnerConfigHome } from './pair-restore.js';
import { daemonCandidateNotice, daemonDelivery } from '../delivery/delivery-guidance.js';
import { authorizeDaemonWake } from '../../hosts/codex/daemon-wake.js';
import { settleChangedPair } from './pair-changes.js';
import { permissionGuidance, permissionFacts, type PermissionGuidance } from '../../integration/mcp/permission-guidance.js';
import { nativeDeliveryWait } from '../delivery/delivery-guidance.js';
import { recordManagedAdoption } from '../recovery/takeover.js';
import { hostingRecord, hostingStatus, writeHosting } from '../recovery/session-hosting.js';

export interface SendIntent {actor:Actor;message:string;in_reply_to?:string;auto_reply_to?:string;auto_reply_text?:string;reply_expected?:boolean}
export interface PairCandidate {
  key:string;member_id:string;host:Host;session_id:string|null;name:string;cwd:string;
  kind:Peer['kind'];owner:Peer['owner'];state:Peer['state'];observed_at:number;activity_at:number|null;
  pid:number|null;generation:string|null;process_kind:'window'|'runtime'|'unknown';opened_at:number|null;model?:string;
  binding_epoch:string|null;endpoint_epoch:string|null;
  label?:string;description?:string;
  delivery_mode?:'daemon-pull';
  former_partner?:true;restore_state?:'resumable'|'gone'|'unverified';
  continuation_of?:string;
  permission_guidance?:PermissionGuidance;
  permission_facts?:ReturnType<typeof permissionFacts>;
}
interface Selection {
  id:string;peerId:string;callKey:string;sessionId:string;epoch?:string;code:string;createdAt:number;expiresAt:number;
  status:'pending'|'committed'|'cancelled'|'expired';candidates:PairCandidate[];draft?:SendIntent;receipt?:unknown;reason?:'bootstrap_required'|'launch_precondition'|'lineage_unverified'|'lineage_choice'|'pair_lost'|'hosting';proofDeadline?:number;lineagePairId?:string;lossId?:string;currentPairId?:string;
  messageId?:string;hostingTarget?:{memberId:string;sessionId:string|null;home?:string;cwd:string};
  launchPrecondition?:{code:string;message:string};
}
export interface SelectionChoice {selection_id:string;key?:string;action?:'choose'|'create'|'cancel'|'unpair'|'adopt'|'wait';model?:string;effort?:string|number}

                                          
export class PairSelections {
  constructor(private db:DatabaseSync,private store:Store){}
  private save(s:Selection):void{
    statement(this.db,'INSERT INTO pair_selections(id,peer_id,call_key,code,status,expires_at,data) VALUES(?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET status=excluded.status,data=excluded.data').run(s.id,s.peerId,s.callKey,s.code,s.status,s.expiresAt,JSON.stringify(s));
  }
  private get(id:string):Selection{
    const row=statement(this.db,'SELECT data FROM pair_selections WHERE id=?').get(id);
    if(!row)throw new BridgeError('selection_expired','选择已失效，请重新发送消息获取候选。');
    return JSON.parse(row.data as string);
  }
  hostingResult(actor:Actor,id:string,result:unknown):unknown{
    const selection=this.get(id),peer=this.store.resolve(actor);
    if(selection.reason==='hosting'&&selection.status==='committed'&&peer?.id===selection.peerId&&peer.sessionId===selection.sessionId&&this.store.bindings.current(peer.id)?.epoch===selection.epoch){selection.receipt=result;this.save(selection);}
    return result;
  }
  private validate(s:Selection,actor:Actor):Peer{
    const peer=this.store.resolve(actor),epoch=peer&&this.store.bindings.current(peer.id)?.epoch;
    if(!peer||peer.id!==s.peerId||peer.sessionId!==s.sessionId||epoch!==s.epoch)throw new BridgeError('selection_expired','发起窗口的对话已改变，原选择失效。');
    if(s.status==='expired'||s.expiresAt<=Date.now())throw new BridgeError('selection_expired','选择已过期，请重新发送消息。');
    if(s.status==='pending'&&s.currentPairId&&this.store.pairFor(peer.id)?.id!==s.currentPairId)throw new BridgeError('selection_expired','当前搭档已经改变，请重新打开选择。');
    return peer;
  }
  maintain():void{this.sweep();}
  pending(peerId:string,sessionId:string):boolean{return!!statement(this.db,"SELECT 1 FROM pair_selections WHERE peer_id=? AND status='pending' AND expires_at>? AND json_extract(data,'$.sessionId')=? LIMIT 1").get(peerId,Date.now(),sessionId);}
  committed(actor:Actor,id:string):boolean{const selection=this.get(id);this.validate(selection,actor);return selection.status==='committed';}
  private sweep():void{
    statement(this.db,"UPDATE pair_selections SET status='expired',data=json_set(data,'$.status','expired') WHERE status='pending' AND expires_at<=?").run(Date.now());
    statement(this.db,"DELETE FROM pair_selections WHERE expires_at<? AND status!='pending' AND COALESCE(json_extract(data,'$.reason'),'') NOT LIKE 'lineage_%'").run(Date.now()-600000);
  }
  invalidate(peerId:string):void{statement(this.db,"UPDATE pair_selections SET status='expired',data=json_set(data,'$.status','expired') WHERE peer_id=? AND status='pending'").run(peerId);}
  rebind(from:string,to:string):void{
    for(const row of statement(this.db,'SELECT data FROM pair_selections WHERE peer_id=?').all(from)){
      const selection=JSON.parse(row.data as string) as Selection;selection.peerId=to;
      if(selection.draft)selection.draft.actor={...selection.draft.actor,memberId:to};
      statement(this.db,'UPDATE pair_selections SET peer_id=?,data=? WHERE id=?').run(to,JSON.stringify(selection),selection.id);
    }
  }
  resumeHeld(peerId:string,send:(intent:SendIntent)=>unknown):void{
    this.store.transaction(()=>{
      for(const row of statement(this.db,"SELECT data FROM pair_selections WHERE peer_id=? AND status IN ('pending','expired') ORDER BY rowid").all(peerId)){
        const selection=JSON.parse(row.data as string) as Selection;
        if(!selection.draft||!selection.reason?.startsWith('lineage_'))continue;
                                                       
        let peer:Peer|undefined;
        try{peer=this.store.resolve(selection.draft.actor);}
        catch(error){
          // 旧窗口留下的草稿不能阻塞新窗口登记，也不能在新窗口代发。
          if(error instanceof BridgeError&&error.code==='stale_context')continue;
          throw error;
        }
        if(!peer||peer.id!==selection.peerId||peer.sessionId!==selection.sessionId||this.store.bindings.current(peer.id)?.epoch!==selection.epoch)continue;
        if(!selection.lineagePairId||this.store.pairFor(peer.id)?.id!==selection.lineagePairId)continue;
        selection.receipt=send(selection.draft);selection.status='committed';this.save(selection);
      }
    });
  }
  refresh(actor:Actor,id:string,config:BridgeConfig,excluded:ReadonlySet<string>=new Set()):unknown{
    return this.store.transaction(()=>{const s=this.get(id),peer=this.validate(s,actor);if(s.status!=='pending'||this.store.pairFor(peer.id)&&!s.currentPairId)throw new BridgeError('selection_expired','原选择已经结束。');s.candidates=this.candidates(peer).filter(candidate=>!excluded.has(candidate.member_id));this.save(s);return this.view(actor,id,config);});
  }
  automaticDraft(actor:Actor,id:string,config:BridgeConfig):SendIntent|undefined{
    const selection=this.get(id),peer=this.validate(selection,actor);
    if(config.implicit==='never'||selection.status!=='pending'||!selection.draft||selection.currentPairId||selection.reason&&!['bootstrap_required','launch_precondition'].includes(selection.reason)||pairLossView(this.store,peer))return;
    if(this.store.pairFor(peer.id))throw new BridgeError('selection_expired','发起窗口已有搭档，原自动配对草稿未提交。');
    return selection.draft;
  }
  private provisional(selection:Selection):Peer|undefined{
    const intent=this.store.setting<{peerId:string;sessionId:string;callId?:string}>('implicitPartner:'+selection.peerId);
    if(!intent||intent.sessionId!==selection.sessionId||intent.callId&&selection.draft&&intent.callId!==selection.draft.actor.callId)return;
    const target=this.store.getPeer(intent.peerId);return target?.owner==='nxbridge'&&!this.store.pairFor(target.id)?target:undefined;
  }
  provisionalPartner(actor:Actor,id:string):Peer|undefined{const selection=this.get(id);this.validate(selection,actor);return this.provisional(selection);}
  commitAutomatic(actor:Actor,id:string,config:BridgeConfig,send:(intent:SendIntent)=>{message_id:string}):{message_id:string}{
    return this.store.transaction(()=>{
      const selection=this.get(id),draft=this.automaticDraft(actor,id,config);
      if(!draft)throw new BridgeError('selection_expired','原发送草稿已结束，未自动提交。');
                                                   
      const receipt=send(draft);selection.status='committed';selection.receipt={...receipt,status:'paired',persisted:true};this.save(selection);return receipt;
    });
  }
  automaticReceipt(actor:Actor,id:string,receipt:unknown):unknown{
    return this.store.transaction(()=>{
      const selection=this.get(id);this.validate(selection,actor);
      const messageId=(receipt as {message_id?:string})?.message_id;
      if(!messageId||!selection.draft)return receipt;
      const message=this.store.message(messageId);
      if(message.from!==selection.peerId||message.callId!==selection.draft.actor.sessionId+':'+selection.draft.actor.callId)throw new BridgeError('selection_expired','自动配对回执不属于原发送草稿。');
      selection.status='committed';selection.receipt=receipt;this.save(selection);return receipt;
    });
  }
  candidates(peer:Peer,includeHistory=true):PairCandidate[]{
    const provisional=this.store.setting<{peerId:string;sessionId:string}>('implicitPartner:'+peer.id);
    const loss=includeHistory?pairLossView(this.store,peer):undefined,former=loss?this.store.peer(loss.partner_id):undefined;
    const availableFormer=former&&(former.owner==='user'||former.sessionId===loss!.partner_session_id&&restorableOwnedPartner(this.store,former));
    const peers=this.store.candidates(otherHost(peer.host),peer.cwd).filter(candidate=>(provisional?.sessionId!==peer.sessionId||candidate.id!==provisional.peerId)&&!(loss&&candidate.id===loss.partner_id&&(!availableFormer||loss.reason==='session_deleted'&&loss.restore_state==='gone')));
                                           
    const conflicts=this.store.faults.map('managed_conflict_scan',this.store.peers(),old=>old.id,old=>{
      const conflict=this.store.setting<{memberId:string;pairId:string}>('managedSessionConflict:'+old.id),pair=this.store.pairFor(old.id);
      return conflict&&pair?.id===conflict.pairId?{old,conflict,pair}:undefined;
    }).filter(value=>!!value);
    for(const {old,conflict,pair} of conflicts){
      if(conflict.memberId===peer.id){const partner=this.store.peer(pair[otherHost(old.host)]);if(!peers.some(value=>value.id===partner.id))peers.unshift(partner);}
    }
    const previous=new Map<string,number>();
    for(const pair of includeHistory?this.store.pairHistory(peer.id):[]){
      if(!pair.archived)continue;
      const target=this.store.getPeer(pair[otherHost(peer.host)]);
      if(!target||previous.has(target.id)||!restorableOwnedPartner(this.store,target))continue;
      previous.set(target.id,pair.createdAt);if(!peers.some(value=>value.id===target.id))peers.push(target);
    }
    if(former&&availableFormer&&!(loss?.reason==='session_deleted'&&loss.restore_state==='gone')&&!this.store.pairFor(former.id)&&!peers.some(p=>p.id===former.id))peers.unshift(former);
    const candidates=peers.map(p=>{
      const binding=this.store.bindings.current(p.id),endpoint=this.store.endpoint(p.id),native=binding??endpoint?.native;
      let opened:number|null=null;
      if(process.platform==='win32'&&native?.procStart&&/^\d{17,19}$/.test(native.procStart))opened=Number(BigInt(native.procStart)/10000n-11644473600000n);
      return{key:randomUUID(),member_id:p.id,host:p.host,session_id:p.sessionId!,name:p.name,cwd:p.cwd,kind:p.kind,owner:p.owner,state:p.state,observed_at:binding?.observedAt??p.updatedAt,activity_at:p.activityAt??previous.get(p.id)??null,pid:native?.pid??endpoint?.pid??null,generation:native?.procStart??endpoint?.procStart??null,process_kind:binding?'window' as const:endpoint?.mode==='app-server'?'runtime' as const:'unknown' as const,opened_at:opened,binding_epoch:binding?.epoch??null,endpoint_epoch:endpoint?.epoch??null,...(p.model?{model:p.model}:{}),...(endpoint?.daemon?{delivery_mode:'daemon-pull' as const}:{}),...(loss?.partner_id===p.id?{former_partner:true as const,restore_state:loss.restore_state}:previous.has(p.id)?{former_partner:true as const,restore_state:'resumable' as const}:{})};
    }).sort((a,b)=>Number(!!b.former_partner)-Number(!!a.former_partner)||(b.activity_at??-1)-(a.activity_at??-1));
    return candidates.map(value=>{
      const target=this.store.peer(value.member_id),claude=peer.host==='claude'?peer:target,codex=peer.host==='codex'?peer:target,permission=permissionGuidance(codex,claude,this.store.endpoint(claude.id));
      const continuation=conflicts.find(({old,conflict,pair})=>conflict.memberId===peer.id&&pair[otherHost(old.host)]===target.id||conflict.memberId===target.id&&pair[otherHost(old.host)]===peer.id)?.old;
      return{...value,permission_facts:permissionFacts(target,this.store.endpoint(target.id)),...(continuation?{continuation_of:continuation.id}:{}),...(permission?{permission_guidance:permission}:{}),label:candidateLabel(value,candidates.filter(other=>candidateLabel(other)===candidateLabel(value)).length>1),description:(continuation?'接续同一会话的原配对与消息记录 · ':'')+(value.owner==='user'?'你开的窗口':'nxbridge 后台')+' · '+value.cwd+' · '+candidateDescription(value)+(value.delivery_mode?' · '+daemonCandidateNotice(value.state):'')+(permission?' · '+(permission.state==='class_mismatch'?'两端权限类别不同，Claude 可能需要逐条审核入站':permission.state==='sender_unknown'?'发送方权限类别待核验，Claude 可能暂扣入站':permission.state==='held'?'Claude 当前暂扣所有入站消息':'Claude 当前拒收所有入站消息'):'')};
    });
  }
  inventory():PairCandidate[]{
    const all=new Map<string,PairCandidate>();
    for(const peer of this.store.peers())if(['root','fork'].includes(peer.kind))for(const candidate of this.candidates({...peer,host:otherHost(peer.host)},false))all.set(candidate.member_id,candidate);
    return[...all.values()].filter(candidate=>!candidate.former_partner).sort((a,b)=>(b.activity_at??-1)-(a.activity_at??-1));
  }
  previousPartners():PairCandidate[]{
    refreshRestoreObservations(this.store);
    const all=new Map<string,PairCandidate>();
    for(const peer of this.store.peers())if(['root','fork'].includes(peer.kind))for(const candidate of this.candidates(peer))if(candidate.former_partner&&candidate.owner==='nxbridge'&&candidate.restore_state==='resumable')all.set(candidate.member_id,candidate);
    return[...all.values()].sort((a,b)=>(b.activity_at??-1)-(a.activity_at??-1));
  }
  codeRequester(code:string):{peer:Peer;binding:NonNullable<ReturnType<Store['bindings']['current']>>}{
    this.sweep();const row=statement(this.db,"SELECT data FROM pair_selections WHERE code=? AND status='pending'").get(code);
    if(!row)throw new BridgeError('pairing_code_invalid','配对码无效或已过期。回到发起配对的窗口重新发送消息，可以拿到新的配对码。');
    const s=JSON.parse(row.data as string) as Selection,peer=this.store.peer(s.peerId),binding=this.store.bindings.current(peer.id);
    if(!binding||binding.epoch!==s.epoch||binding.transitioning||peer.sessionId!==s.sessionId||this.store.pairFor(peer.id)&&this.store.pairFor(peer.id)?.id!==s.currentPairId||s.currentPairId&&this.store.pairFor(peer.id)?.id!==s.currentPairId)throw new BridgeError('requester_changed','发起配对的窗口或当前搭档已经改变。');
    return{peer,binding};
  }
  create(peer:Peer,actor:Actor,config:BridgeConfig,draft?:SendIntent,reason?:Selection['reason'],proofDeadline?:number,lineagePairId?:string):unknown{
    return this.store.transaction(()=>{
      this.sweep();
      if(draft&&(!draft.message.trim()||Buffer.byteLength(draft.message)>256*1024))throw new BridgeError('invalid_message','消息不能为空，且不能超过 256 KiB。');
      const epoch=this.store.bindings.current(peer.id)?.epoch,callKey=JSON.stringify([peer.id,epoch??actor.sessionId,actor.callId]);
      const previous=statement(this.db,'SELECT data FROM pair_selections WHERE call_key=?').get(callKey);
      if(previous){const s=JSON.parse(previous.data as string) as Selection;if(s.draft?.message!==draft?.message||s.draft?.in_reply_to!==draft?.in_reply_to)throw new BridgeError('idempotency_conflict','同一次发送不能修改待选消息。');return this.view(actor,s.id,config);}
      if(!reason?.startsWith('lineage_'))statement(this.db,"UPDATE pair_selections SET status='cancelled',data=json_set(data,'$.status','cancelled') WHERE peer_id=? AND status='pending' AND COALESCE(json_extract(data,'$.reason'),'') NOT LIKE 'lineage_%'").run(peer.id);
      const used=new Set(statement(this.db,"SELECT code FROM pair_selections WHERE status='pending'").all().map(r=>r.code)),start=randomInt(10000);
      let code:string|undefined;for(let i=0;i<10000;i++){const candidate=String((start+i)%10000).padStart(4,'0');if(!used.has(candidate)){code=candidate;break;}}
      if(!code)throw new BridgeError('selection_unavailable','有效配对码已满，请稍后重试。');
      const current=!draft&&(!reason||reason==='hosting')?this.store.pairFor(peer.id):undefined,loss=pairLossView(this.store,peer),now=Date.now(),s:Selection={id:randomUUID(),peerId:peer.id,callKey,sessionId:actor.sessionId,epoch,code,createdAt:now,expiresAt:now+600000,status:'pending',candidates:this.candidates(peer),...(current?{currentPairId:current.id}:{}),...(draft?{draft}:{}),...(reason?{reason}:{}),...(proofDeadline?{proofDeadline}:{}),...(lineagePairId?{lineagePairId}:{}),...(loss?{lossId:loss.id}:{})};
      if(reason==='hosting'&&current){const target=this.store.peer(current.codex),hosting=hostingStatus(this.store,target);s.hostingTarget={memberId:target.id,sessionId:target.sessionId,home:hosting?.config_home,cwd:target.cwd};}
      this.save(s);return this.view(actor,s.id,config);
    });
  }
  hosting(peer:Peer,actor:Actor,config:BridgeConfig,messageId?:string):unknown{
    return this.store.transaction(()=>{
      const view=this.create(peer,actor,config,undefined,'hosting') as {selection_id?:string};if(!view.selection_id)return view;const s=this.get(view.selection_id),pair=this.store.pairFor(peer.id);
      if(!pair||peer.host!=='claude')throw new BridgeError('selection_expired','后台托管选择只适用于当前 Codex 搭档。');
      const target=this.store.peer(pair.codex),hosting=hostingStatus(this.store,target);
      if(!s.hostingTarget)s.hostingTarget={memberId:target.id,sessionId:target.sessionId,home:hosting?.config_home,cwd:target.cwd};if(messageId&&!s.messageId)s.messageId=messageId;this.save(s);
      return this.view(actor,s.id,config);
    });
  }
  launchBlocked(peer:Peer,actor:Actor,config:BridgeConfig,draft:SendIntent,error:unknown,excluded:ReadonlySet<string>=new Set()):unknown{
    const value=this.create(peer,actor,config,draft,'launch_precondition') as {selection_id:string},selection=this.get(value.selection_id);
    selection.reason='launch_precondition';selection.candidates=this.candidates(peer).filter(candidate=>!excluded.has(candidate.member_id));selection.launchPrecondition={code:(error as BridgeError).code??'launch_pending',message:describeError(error)};this.save(selection);
    return this.view(actor,selection.id,config);
  }
  view(actor:Actor,id:string,config:BridgeConfig):unknown{
    const s=this.get(id);this.validate(s,actor);
    if(s.receipt)return s.receipt;
    if(s.reason==='launch_precondition')return{status:s.candidates.length?'selection_required':'launch_precondition',reason:'launch_precondition',selection_id:s.id,expires_at:s.expiresAt,host:otherHost(actor.host),candidates:s.candidates,allowed_actions:config.implicit==='never'?['choose','cancel']:['choose','create','cancel'],launch_precondition:s.launchPrecondition,message:(s.launchPrecondition?.message??'原生启动前置条件尚未满足。')+' 原发送草稿已保留；完成前置条件后可重试原操作，或选择已有窗口。'};
    if(s.reason==='hosting'){
      const pair=this.store.pairFor(s.peerId),target=pair?this.store.peer(pair.codex):undefined;
      if(!target||target.id!==s.hostingTarget?.memberId||target.sessionId!==s.hostingTarget.sessionId)throw new BridgeError('selection_expired','原会话已改变，请重新打开托管选择。');
      return{status:'selection_required',reason:'hosting',selection_id:s.id,current_pair_id:pair!.id,...(s.messageId?{message_id:s.messageId}:{}),hosting:hostingStatus(this.store,target),allowed_actions:config.implicit==='never'?['adopt','wait','unpair','cancel']:['adopt','wait','create','unpair','cancel'],expires_at:s.expiresAt,candidates:[],message:'message saved; user chooses background hosting of the original session, waiting for its window, a new partner, or unpair. Never choose for user; no old message replay.'};
    }
    if(s.currentPairId){
      const pair=this.store.pairById(s.currentPairId)!,partner=this.store.peer(pair[otherHost(actor.host)]);
      return{status:'selection_required',mode:'change',current_pair_id:pair.id,current_partner:{member_id:partner.id,host:partner.host,name:partner.name,owner:partner.owner,state:partner.state,session_id:partner.sessionId},selection_id:s.id,pairing_code:s.epoch?s.code:null,expires_at:s.expiresAt,host:otherHost(actor.host),candidates:s.candidates,allowed_actions:config.implicit==='never'?['choose','unpair','cancel']:['choose','create','unpair','cancel'],message:'open native partner selection; current pairing stays until user chooses. cancel keeps it; unpair ends it; choose/create replaces it. Never choose for user; do not replay old msgs.'};
    }
    if(s.reason==='pair_lost'){
      const loss=pairLossView(this.store,this.store.peer(s.peerId),config);
      if(!loss||loss.id!==s.lossId)throw new BridgeError('selection_expired','配对解除记录已经改变，请重新选择。');
      return{status:'selection_required',reason:'pair_lost',pair_lost:loss,selection_id:s.id,expires_at:s.expiresAt,candidates:s.candidates,allowed_actions:config.implicit==='never'?['choose','cancel']:['choose','create','cancel'],message:loss.reason==='session_deleted'&&loss.restore_state==='gone'?'former pair ended: partner session history missing, unavailable while missing; user may explicitly choose another partner'+(config.implicit==='never'?'':', create a new one')+', or cancel. Never choose for user.':'former pair ended ('+loss.reason+'); no new partner started; user may restore same session with '+loss.restore_command+', explicitly choose a new partner, or cancel. Never choose for user.'};
    }
    if(s.reason==='lineage_unverified'&&Date.now()<(s.proofDeadline??0))return{status:'lineage_held',selection_id:s.id,persisted:true,allowed_actions:['cancel'],proof_deadline:s.proofDeadline,message:'held: this window has an earlier partner whose state cant be verified yet; nxbridge retries, msg kept; still unverified -> user picks via nxbridge pair'};
    if(s.reason?.startsWith('lineage_'))return{status:'selection_required',reason:s.reason,selection_id:s.id,expires_at:s.expiresAt,candidates:s.candidates,allowed_actions:config.implicit==='never'?['choose','cancel']:['choose','create','cancel'],message:s.reason==='lineage_choice'?'nothing sent: this conversation still runs in another window paired with your earlier partner (or several match); no new partner started. tell user to pick via nxbridge pair, or close the other window':'这个窗口之前的搭档状态无法确认，请用 nxbridge pair 选择要配对的窗口。'};
    return{status:s.status==='cancelled'?'selection_declined':s.reason??'selection_required',selection_id:s.id,pairing_code:s.epoch?s.code:null,expires_at:s.expiresAt,host:otherHost(actor.host),candidates:s.candidates,allowed_actions:config.implicit==='never'?['choose','cancel']:['choose','create','cancel'],message:s.reason==='bootstrap_required'?'nothing sent/started; original draft kept: AI may attempt `nxbridge bootstrap` once; it verifies independent launch before handover. If refused, tell user in the originating window to run it in ordinary PowerShell outside Claude/Codex. After success, retry select_partner with this same saved selection_id + action=create only if create was already authorized; keep the draft, do not resend. Otherwise show native selection for the user to choose; never choose for user.':'nothing sent: existing unpaired '+otherHost(actor.host)+' window(s) require user confirmation, even a single candidate; show label + description including delivery limits; user may choose an existing window, create a background partner if offered, or cancel; commit only user\'s explicit choice via select_partner (selection_id + key)'+(s.epoch?' or user types `nxbridge pair '+s.code+'` in target window':'')+'. never choose yourself'};
  }
  commit(actor:Actor,choice:SelectionChoice,config:BridgeConfig,send:(intent:SendIntent)=>unknown):unknown{
    return this.store.transaction(()=>{
      const s=this.get(choice.selection_id),peer=this.validate(s,actor);
      if(s.receipt)return s.receipt;
      if(s.status!=='pending')throw new BridgeError('selection_declined','用户已取消选择，消息未发送。');
      const action=choice.action??'choose';
      if(action==='adopt'||action==='wait'){
        if(s.reason!=='hosting'||!s.currentPairId||!s.hostingTarget)throw new BridgeError('invalid_action','此选择不支持后台托管操作。');
        const pair=this.store.pairFor(peer.id),target=pair?this.store.peer(pair.codex):undefined,hosting=target?hostingStatus(this.store,target):undefined;
        if(!target||target.id!==s.hostingTarget.memberId||target.sessionId!==s.hostingTarget.sessionId||target.cwd!==s.hostingTarget.cwd||hosting?.config_home!==s.hostingTarget.home)throw new BridgeError('selection_expired','原会话、配置目录或工程目录已改变。');
        const phase=action==='wait'?'awaiting_window':target.owner==='nxbridge'?hostingRecord(this.store,target)?.phase:'adopting';
        writeHosting(this.store,target,{background:action==='adopt',released:action==='wait',phase,reason:undefined});
        s.status='committed';s.receipt={status:'paired',pair_id:pair!.id,message_id:s.messageId,hosting_action:action,hosting:hostingStatus(this.store,target)};this.save(s);return s.receipt;
      }
      if(s.reason==='hosting'&&action==='choose')throw new BridgeError('invalid_action','请选择继续后台托管、等待窗口、新搭档或解除配对。');
      if(action==='cancel'){s.status='cancelled';s.receipt=s.reason==='hosting'&&s.messageId?{status:'held',message_id:s.messageId,persisted:true,delivery_state:this.store.message(s.messageId).state,read_confirmed:false,hosting:s.hostingTarget?hostingStatus(this.store,this.store.peer(s.hostingTarget.memberId)):undefined,message:'saved; waiting for original session; do not resend'}:{status:'selection_declined',...(s.currentPairId?{pair_unchanged:true}:{}),message:s.currentPairId?'current pairing unchanged; user cancelled selection':'nothing sent: user declined partner selection; dont resend unless user asks'};this.save(s);return s.receipt;}
      if(action==='unpair'){
        if(!s.currentPairId)throw new BridgeError('selection_expired','当前没有可解除的配对。');
        const pair=this.store.pairFor(peer.id)!,changes=settleChangedPair(this.store,pair,peer.id);this.store.unpair(pair.id);
        s.status='committed';s.receipt={status:'unpaired',pair_id:pair.id,...changes,message:'pair ended by user; no new partner started; old msgs not replayed'};this.save(s);return s.receipt;
      }
      if(s.reason==='lineage_unverified'&&Date.now()<(s.proofDeadline??0))throw new BridgeError('lineage_unverified','这个窗口之前的搭档状态正在核验，消息已保存，请稍后重试。');
      if(this.store.pairFor(peer.id)&&!s.currentPairId)throw new BridgeError('selection_expired','当前窗口已有搭档，原选择失效。');
      let target:Peer;
      if(action==='create'){
        if(config.implicit==='never')throw new BridgeError('partner_missing','隐式创建已关闭。');
        const provisional=this.provisional(s);
                                                      
        target=provisional&&choice.model===undefined&&choice.effort===undefined?provisional:this.store.placeholder(otherHost(peer.host),peer.cwd);
      }else{
        const candidate=s.candidates.find(c=>c.key===choice.key);
        if(!candidate)throw new BridgeError('selection_expired','候选标识无效。');
        if(candidate.continuation_of){
          const old=this.store.peer(candidate.continuation_of),key='managedSessionConflict:'+old.id,conflict=this.store.setting<{memberId:string;sessionId:string;pairId:string;input:import('../../types.js').RegisterInput;detached:boolean}>(key),pair=this.store.pairFor(old.id),fresh=this.candidates(peer).find(value=>value.member_id===candidate.member_id);
          if(!conflict?.detached||!pair||pair.id!==conflict.pairId||!fresh||fresh.binding_epoch!==candidate.binding_epoch||fresh.endpoint_epoch!==candidate.endpoint_epoch||fresh.pid!==candidate.pid||fresh.generation!==candidate.generation||old.sessionId!==conflict.sessionId||this.store.peer(conflict.memberId).sessionId!==old.sessionId||this.store.pairFor(conflict.memberId))throw new BridgeError('selection_expired','原会话或恢复窗口已改变，请重新选择。');
          const original=this.store.endpoints(old.id).filter(ep=>ep.mode==='app-server').sort((a,b)=>b.seenAt-a.seenAt)[0];this.store.deactivate(old.id);const binding=this.store.bindings.current(old.id);if(binding)this.store.bindings.save({...binding,active:false});this.store.updatePeer(old.id,{owner:'user',state:'offline'});
          const adopted=this.store.adopt(old.id,conflict.input,conflict.memberId);this.store.setSetting(key,null);if(old.owner==='nxbridge'||hostingRecord(this.store,old)?.background)recordManagedAdoption(this.store,adopted,conflict.input,original);else if(hostingRecord(this.store,adopted))writeHosting(this.store,adopted,{phase:undefined,reason:undefined,verified:true});
          const incident=this.store.setting<Record<string,unknown>>('managedRecovery:'+old.id);if(incident)this.store.setSetting('managedRecovery:'+old.id,{...incident,state:'closed'});
          if(peer.id===conflict.memberId){s.peerId=adopted.id;if(s.draft)s.draft.actor={...s.draft.actor,memberId:adopted.id};}
          const result=s.draft?send(s.draft):{};s.status='committed';s.receipt={...(result as object),status:'paired',pair_id:pair.id,partner_name:this.store.peer(pair[otherHost(peer.host)]).name,continued_same_session:true,message:'same session + original pair continued; held msgs kept; unknown msgs not replayed'};this.save(s);this.store.event('context.managed.selected',{peerId:old.id,pairId:pair.id});return s.receipt;
        }
        const loss=candidate.former_partner&&s.lossId?pairLossView(this.store,peer,config,true):undefined;
        if(loss?.partner_id===candidate.member_id&&(loss.id!==s.lossId||loss.restore_state==='gone'))throw new BridgeError('pair_restore_unavailable','原搭档会话已不存在或配对记录已改变，未创建新会话。');
        const current=candidate.former_partner?this.store.peer(candidate.member_id):this.store.candidates(otherHost(peer.host),peer.cwd).find(p=>p.id===candidate.member_id&&p.sessionId===candidate.session_id);
        if(!current||current.sessionId!==candidate.session_id)throw new BridgeError('selection_expired','候选窗口已经改变，请重新选择。');
        if(candidate.former_partner&&current.owner==='nxbridge'&&!restorableOwnedPartner(this.store,current,partnerConfigHome(this.store,current,loss?.partner_id===current.id?loss.partner_config_home:undefined),true))throw new BridgeError('pair_restore_unavailable','无法核验原会话历史，未新建搭档。请确认原配置目录和会话文件。');
        const fresh=this.candidates(peer).find(c=>c.member_id===current.id);
        if(!fresh||fresh.binding_epoch!==candidate.binding_epoch||fresh.endpoint_epoch!==candidate.endpoint_epoch||fresh.pid!==candidate.pid||fresh.generation!==candidate.generation)throw new BridgeError('selection_expired','候选窗口或对话代次已经改变，请重新选择。');
        target=current;
      }
      return this.complete(s,peer,target,send,'user choice');
    });
  }
  private complete(s:Selection,peer:Peer,target:Peer,send:(intent:SendIntent)=>unknown,source:string):unknown{
    const loss=pairLossView(this.store,peer),former=loss?.id===s.lossId&&loss?.partner_id===target.id;
    const old=s.currentPairId?this.store.pairFor(peer.id):undefined,changes=old?settleChangedPair(this.store,old,peer.id):undefined;
    const pair=former?this.store.restorePair(loss!.pair_id):this.store.pair(peer.host==='claude'?peer.id:target.id,peer.host==='codex'?peer.id:target.id,!!old);
    if(this.store.setting<{peerId:string}>('implicitPartner:'+peer.id)?.peerId===target.id)this.store.setSetting('implicitPartner:'+peer.id,null);
    authorizeDaemonWake(this.store,pair,source==='code in target window'?'code':'selection');
    const result=s.draft?send(s.draft):{};
    const guidance={...daemonDelivery(target,this.store.endpoint(target.id),this.store.pendingCount(target.id),this.store.bindings.current(target.id)?.transitioning),...nativeDeliveryWait(target,this.store.endpoint(target.id),this.store.pendingCount(target.id))};
    const permission=permissionGuidance(this.store.peer(pair.codex),this.store.peer(pair.claude),this.store.endpoint(pair.claude));
    s.status='committed';s.receipt={...(result as object),...(s.draft?{persisted:true,delivery_state:'accepted',read_confirmed:false}:{}),...guidance,...(permission?{permission_guidance:permission}:{}),...changes,status:'paired',selection_id:s.id,pair_id:pair.id,partner_name:target.name,...(target.owner==='nxbridge'&&s.candidates.some(candidate=>candidate.member_id===target.id&&candidate.former_partner)?{restored_previous_partner:true}:{}),message:'paired w/ '+target.name+' ('+source+')'+(guidance.delivery_wait?'; '+guidance.delivery_wait.message:'')};this.save(s);
    this.store.event('pair.selection.committed',{selectionId:s.id,pairId:pair.id,source});return s.receipt;
  }
  commitCode(actor:Actor,code:string,send:(intent:SendIntent)=>unknown):unknown{
    return this.store.transaction(()=>{
      this.sweep();const target=this.store.resolve(actor);
      if(!target||target.kind==='subagent'||!actor.binding)throw new BridgeError('unverified_identity','配对码只接受已核验的原生主窗口输入。');
      if(this.store.pairFor(target.id))throw new BridgeError('target_paired','这个窗口已有搭档，配对没有改变。');
      const row=statement(this.db,"SELECT data FROM pair_selections WHERE code=? AND status='pending'").get(code);
      if(!row)throw new BridgeError('pairing_code_invalid','配对码无效或已过期。回到发起配对的窗口重新发送消息，可以拿到新的配对码。');
      const s=JSON.parse(row.data as string) as Selection,peer=this.store.peer(s.peerId),current=this.store.bindings.current(peer.id);
      if(s.expiresAt<=Date.now()||peer.sessionId!==s.sessionId||current?.epoch!==s.epoch||current?.transitioning||peer.state==='offline'||this.store.pairFor(peer.id)&&this.store.pairFor(peer.id)?.id!==s.currentPairId||s.currentPairId&&this.store.pairFor(peer.id)?.id!==s.currentPairId)throw new BridgeError('requester_changed','发起配对的窗口或当前搭档已经改变。');
      if(peer.host===target.host)throw new BridgeError('pairing_code_host','配对码要在 '+(peer.host==='claude'?'Codex':'Claude')+' 窗口里输入。');
      if(!current)throw new BridgeError('requester_unverified','发起窗口尚未核验原生身份，暂不支持配对码。');
      return this.complete(s,peer,target,send,'code in target window');
    });
  }
}
