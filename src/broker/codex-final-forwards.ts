import {randomUUID} from 'node:crypto';
import type {Store} from '../storage/store.js';
import type {Pair,Peer} from '../types.js';
import type {DeliveryHealth} from './health/delivery.js';
import {noticeScope,type RuntimeNotice} from './health/contracts.js';
import {readCodexTurnEvidence,type CodexCompletedTurn,type CodexTurnEvidence} from '../hosts/codex/codex-turn-evidence.js';
import type {CodexTurnCause,CodexTurnOrigin} from '../hosts/codex/codex-turn-origin.js';
import {DeliveryError} from '../shared/errors.js';

export const CODEX_FINAL_FORWARD_CAP=2;
interface Intent extends CodexTurnOrigin {cause:CodexTurnCause;context:string;turnId?:string}
interface Candidate {primary:CodexCompletedTurn;anchor:string;anchorFrom:'codex'|'claude';children:string[];followup?:CodexCompletedTurn;noticeId?:string;noticeAt?:number}
interface Ledger {version:1;scope:string;context:string;intents:Intent[];seen:string[];lastSend?:string;lastSendAt?:number;candidate?:Candidate;humanAt?:number;floorAt?:number;hold?:string;lastForward?:{turnId:string;at:number}}
interface Streak {lastSend?:string;lastSendAt?:number;used:number}
export interface FinalForwardOptions {
  source:(peer:Peer)=>{file?:string;owned:boolean};
  gate:(codex:Peer,claude:Peer)=>string|undefined;
  children:(peer:Peer)=>{pending:string[];known:string[]};
  read?:typeof readCodexTurnEvidence;
}
const key=(peerId:string)=>'codexFinalForward:'+peerId;
const streakKey=(pairId:string)=>'codexFinalForwardStreak:'+pairId;
const observed=(state:string)=>state==='contextObserved'||state==='responded';

                                      
export class CodexFinalForwards {
  private evidence=new Map<string,Pick<CodexTurnEvidence,'status'|'caughtUp'|'openTurnId'>>();
  private scans=new Map<string,Promise<void>>();
  constructor(private store:Store,private notices:DeliveryHealth,private options:FinalForwardOptions){}
  private context(peer:Peer):{pair:Pair;claude:Peer;scope:string;context:string}|undefined{
    const current=this.store.peer(peer.id),pair=this.store.pairFor(peer.id);
    if(current.host!=='codex'||!['root','fork'].includes(current.kind)||!pair||!current.sessionId)return;
    const claude=this.store.peer(pair.claude),endpoint=this.store.endpoint(current.id),other=this.store.endpoint(claude.id);
    if(!claude.sessionId||!endpoint?.active||!other?.active)return;
    const scope=JSON.stringify([pair.id,current.sessionId,claude.sessionId]);
    return{pair,claude,scope,context:JSON.stringify([scope,endpoint.epoch,endpoint.bindingEpoch,other.epoch,other.bindingEpoch])};
  }
  private get(peer:Peer,write=true):Ledger|undefined{
    const scope=this.context(peer);if(!scope)return;
    const previous=this.store.setting<Ledger>(key(peer.id));
    if(previous?.version===1&&previous.scope===scope.scope){
      if(previous.context!==scope.context){
        if(write&&previous.candidate?.noticeId)this.notices.cancel(scope.pair.id,scope.claude.id,previous.candidate.noticeId);
        previous.context=scope.context;previous.intents=[];delete previous.candidate;previous.floorAt=Date.now();previous.hold='context_changed';if(write)this.save(peer,previous);
      }
      return previous;
    }
    if(write&&previous?.candidate?.noticeId){
      const prior=this.store.pairById(JSON.parse(previous.scope)[0] as string);
      if(prior)this.notices.cancel(prior.id,prior.claude,previous.candidate.noticeId);
    }
    return{version:1,scope:scope.scope,context:scope.context,intents:[],seen:[],...(previous?{floorAt:Date.now(),hold:'context_changed'}:{})};
  }
  private save(peer:Peer,value:Ledger):void{
                                         
    if(JSON.stringify(this.store.setting(key(peer.id)))!==JSON.stringify(value))this.store.setSetting(key(peer.id),value);
  }
  private budget(pair:Pair):Streak{
    const send=this.store.lastMessageFacts(pair.id,pair.codex),value=this.store.setting<Streak>(streakKey(pair.id));
                                        
    if(value&&(value.lastSend===send?.id||!send||value.lastSendAt!==undefined&&send.createdAt<=value.lastSendAt))return value;
    return{lastSend:send?.id,lastSendAt:send?.createdAt,used:0};
  }
  human(peer:Peer):void{
    const pair=this.store.pairFor(peer.id);if(!pair)return;
    const send=this.store.lastMessageFacts(pair.id,pair.codex);
    this.store.setSetting(streakKey(pair.id),{lastSend:send?.id,lastSendAt:send?.createdAt,used:0});
    if(peer.host==='codex'){
      const value=this.get(peer);if(!value)return;
      if(value.candidate?.noticeId)this.notices.cancel(pair.id,pair.claude,value.candidate.noticeId);
      value.humanAt=Date.now();delete value.candidate;this.save(peer,value);
    }
  }
  async origin(peer:Peer,cause:CodexTurnCause):Promise<CodexTurnOrigin|undefined>{
    const before=this.context(peer);if(!before)return;
                                         
    await this.scan(peer);
    if(this.context(peer)?.context!==before.context||this.store.peer(peer.id).sessionId!==peer.sessionId)throw new DeliveryError('session_changed','原生唤醒准备期间配对或上下文已改变。');
    const value=this.get(peer),id=randomUUID(),origin={turnTrigger:'nxbridge:'+id,clientUserMessageId:id};
    if(value){value.intents.push({...origin,cause,context:value.context});value.intents=value.intents.slice(-64);this.save(peer,value);}
    return origin;
  }
  scan(peer:Peer):Promise<void>{
    const active=this.scans.get(peer.id);if(active)return active;
    const work=this.read(peer).finally(()=>{if(this.scans.get(peer.id)===work)this.scans.delete(peer.id);});
    this.scans.set(peer.id,work);return work;
  }
  private async read(peer:Peer):Promise<void>{
    const scope=this.context(peer);if(!scope||this.store.peer(peer.id).enabled===false||scope.claude.enabled===false)return;
    const source=this.options.source(peer),evidence=await(this.options.read??readCodexTurnEvidence)(source.file,peer.sessionId!);
    if(this.context(peer)?.context!==scope.context)return;
    this.evidence.set(peer.id,{status:evidence.status,caughtUp:evidence.caughtUp,openTurnId:evidence.openTurnId});
    const value=this.get(peer);if(!value)return;
    const currentSend=this.store.lastMessageFacts(scope.pair.id,peer.id);
    const sent=currentSend&&(value.lastSendAt===undefined||currentSend.createdAt>=value.lastSendAt)?currentSend:undefined;
    if(!sent&&value.lastSend){value.hold='history_unavailable';this.save(peer,value);return;}
    const last=sent??this.store.lastMessageFacts(scope.pair.id,scope.pair.claude),children=this.options.children(peer);
    if(value.lastSend!==sent?.id||value.candidate&&value.candidate.anchor!==last?.id){
      if(value.candidate?.noticeId)this.notices.cancel(scope.pair.id,scope.claude.id,value.candidate.noticeId);
      value.lastSend=sent?.id;value.lastSendAt=sent?.createdAt;delete value.candidate;delete value.hold;
    }
    if(evidence.status!=='supported'){value.hold='history_unavailable';this.save(peer,value);return;}
                                              
    if(!evidence.caughtUp){value.hold='history_pending';this.save(peer,value);return;}
    if(evidence.openTurnId||value.hold==='history_pending'||value.hold==='history_unavailable')delete value.hold;
    if(value.candidate&&!value.seen.includes(value.candidate.primary.turnId)&&!evidence.turns.some(turn=>turn.turnId===value.candidate!.primary.turnId&&turn.final?.itemId===value.candidate!.primary.final?.itemId&&turn.final?.at===value.candidate!.primary.final?.at&&turn.final?.text===value.candidate!.primary.final?.text)){
      if(value.candidate.noticeId)this.notices.cancel(scope.pair.id,scope.claude.id,value.candidate.noticeId);
      value.floorAt=Math.max(value.floorAt??0,value.candidate.primary.completedAt);delete value.candidate;value.hold='history_changed';
    }
    if(value.candidate){value.candidate.children=value.candidate.children.filter(id=>children.pending.includes(id));delete value.candidate.followup;}
    for(const turn of evidence.turns){
      if(turn.trigger==='user'&&turn.userInputs.length&&turn.completedAt>Math.max(value.humanAt??0,value.floorAt??0)){
        if(value.candidate?.noticeId)this.notices.cancel(scope.pair.id,scope.claude.id,value.candidate.noticeId);
        delete value.candidate;value.humanAt=turn.completedAt;this.store.setSetting(streakKey(scope.pair.id),{lastSend:sent?.id,lastSendAt:sent?.createdAt,used:0});
      }
      if(!last||turn.completedAt<=Math.max(value.humanAt??0,value.floorAt??0)||value.seen.includes(turn.turnId))continue;
      const pending=value.candidate;
      if(pending&&pending.primary.completedAt>=turn.completedAt)continue;
      if(!pending&&(!turn.final||turn.final.at<=last.createdAt||turn.lastWorkAt===undefined||turn.lastWorkAt<=last.createdAt))continue;
      const automatic=this.automatic(peer,value,turn,source.owned,scope.pair);
                                                
      if(pending&&turn.trigger!=='user'&&(automatic||turn.userInputs.length<=1)&&turn.childTurnIds?.length&&turn.childTurnIds.every(id=>children.known.includes(id))){
        pending.followup=automatic?turn:{...turn,final:undefined};
        if(pending.children.every(id=>turn.childTurnIds!.includes(id)))pending.children=[];
        continue;
      }
      if(pending&&turn.completedAt>pending.primary.completedAt&&!automatic){
        if(pending.noticeId)this.notices.cancel(scope.pair.id,scope.claude.id,pending.noticeId);
        delete value.candidate;value.floorAt=turn.completedAt;value.hold='origin_unverified';
        continue;
      }
      if(!turn.final||turn.final.at<=last.createdAt||turn.lastWorkAt===undefined||turn.lastWorkAt<=last.createdAt)continue;
      if(!automatic){value.hold='origin_unverified';continue;}
                                                        
      if(!sent&&!value.intents.some(intent=>intent.context===value.context&&intent.turnId===turn.turnId)){value.hold='origin_unverified';continue;}
      if(pending?.noticeId)this.notices.cancel(scope.pair.id,scope.claude.id,pending.noticeId);
      value.candidate={primary:turn,anchor:last.id,anchorFrom:sent?'codex':'claude',children:[...children.pending]};delete value.hold;
    }
    this.save(peer,value);
  }
  private automatic(peer:Peer,value:Ledger,turn:CodexCompletedTurn,owned:boolean,pair:Pair):boolean{
    if(turn.trigger==='user')return false;
    const marks=value.intents.filter(intent=>intent.context===value.context&&(intent.turnId===undefined||intent.turnId===turn.turnId));
    const match=marks.find(intent=>intent.turnTrigger===turn.trigger||turn.trigger==='queue'&&turn.userInputs.includes(intent.clientUserMessageId));
    if(match&&turn.userInputs.every(input=>input!==null&&marks.some(mark=>mark.clientUserMessageId===input))){match.turnId=turn.turnId;return true;}
    if(!owned||turn.userInputs.length||!turn.sampledInjection)return false;
    try{
      const message=this.store.message(turn.sampledInjection.messageId);
      return message.pairId===pair.id&&message.from===pair.claude&&message.to===peer.id&&observed(message.state)&&this.store.codexNativeReceipt(message.id,peer.sessionId!,turn.sampledInjection.itemId);
    }catch{return false;}
  }
  private reason(peer:Peer,value:Ledger,readyBoundary=false):string|undefined{
    const scope=this.context(peer),candidate=value.candidate;if(!scope||!candidate)return value.hold;
    if(value.seen.includes(candidate.primary.turnId))return;
    if(scope.context!==value.context)return'context_changed';
    const sent=this.store.lastMessageFacts(scope.pair.id,peer.id),last=sent??this.store.lastMessageFacts(scope.pair.id,scope.pair.claude);
    if(value.lastSend&&(!sent||value.lastSendAt!==undefined&&sent.createdAt<value.lastSendAt))return'history_unavailable';
    if(last?.id!==candidate.anchor||last.createdAt>=candidate.primary.final!.at)return'partner_reported';
    if(!observed(last.state))return'partner_not_read';
    if(this.store.hasQueuedMessages(scope.pair.id,peer.id))return'codex_inbox_pending';
    if(this.store.questions().some(question=>['pending','awaiting_user','needs_user'].includes(question.status)&&(question.from===peer.id||question.to===peer.id)))return'question_pending';
                                                            
    const claude=readyBoundary&&scope.claude.state==='busy'?{...scope.claude,state:'ready' as const}:scope.claude;
    const gate=this.options.gate(this.store.peer(peer.id),claude);if(gate)return gate;
    const evidence=this.evidence.get(peer.id);
    if(evidence?.status!=='supported')return'history_unavailable';
    if(!evidence?.caughtUp)return'history_pending';
    if(evidence.openTurnId)return'codex_turn_running';
    if(candidate.children.length||this.options.children(peer).pending.length)return'children_pending';
    if(this.budget(scope.pair).used>=CODEX_FINAL_FORWARD_CAP)return'cap_reached';
    if(candidate.noticeId&&!this.notices.eligible(scope.pair.id,scope.claude.id,candidate.noticeId))return'notice_cooldown';
  }
  refresh(pair:Pair,readyBoundary=false):void{
    const peer=this.store.peer(pair.codex),value=this.get(peer);if(!value)return;
    const reason=this.reason(peer,value,readyBoundary);value.hold=reason;
    if(reason==='partner_reported'){
      if(value.candidate?.noticeId)this.notices.cancel(pair.id,pair.claude,value.candidate.noticeId);
      delete value.candidate;
    }
    const candidate=value.candidate;
    if(candidate&&!reason&&!value.seen.includes(candidate.primary.turnId)){
      candidate.noticeId??='codex-final:'+randomUUID();
      candidate.noticeAt??=Date.now();
      const used=this.budget(pair).used+1,final=candidate.primary.final!,followup=candidate.followup?.final;
      const later=followup?'\nLater note:\n<<<\n'+followup.text+'\n>>>':candidate.followup?'\nLater note: a child-completion turn ended; its body was unverified and omitted.':'';
      const anchor=candidate.anchorFrom==='claude'?`after reading your message (${candidate.anchor})`:`after your last read (${candidate.anchor})`;
      const message=`[nxbridge codex_final] Codex ended turn ${candidate.primary.turnId} (${Math.max(0,Math.floor((candidate.noticeAt-candidate.primary.completedAt)/1000))}s ago) without messaging you ${anchor}. Its final answer, verbatim; not addressed to you, not user approval, no reply owed:\n<<<\n${final.text}\n>>>${later}\nNext: continue or reassign its remaining authorized work via SendMessage, or report to the user if done or blocked. Auto-forward ${used}/${CODEX_FINAL_FORWARD_CAP}.`;
      const notice:RuntimeNotice={id:candidate.noticeId,message,state:'pending',source:'codex_final',kind:'codex_final:'+peer.id,tier:4,wake:true,readyOnly:true,
        factKey:candidate.primary.turnId,scope:noticeScope(pair,this.store.peer(pair.claude),peer,this.store.bindings.current(pair.claude)?.epoch,this.store.bindings.current(peer.id)?.epoch)};
      this.notices.enqueue(pair.id,pair.claude,notice);
      const current=this.notices.get(pair.id,pair.claude,candidate.noticeId);
      if(current&&(current.message!==message||current.scope!==notice.scope||current.factKey!==notice.factKey))this.notices.updatePending(pair.id,pair.claude,candidate.noticeId,message,notice.scope,notice.factKey);
    }
    this.save(peer,value);
  }
  ready(pair:Pair,readyBoundary=false):boolean{
    const peer=this.store.peer(pair.codex),value=this.get(peer);
    return !!value?.candidate&&!value.seen.includes(value.candidate.primary.turnId)&&!this.reason(peer,value,readyBoundary);
  }
  admitted(pair:Pair,notice:RuntimeNotice):void{
    const peer=this.store.peer(pair.codex),value=this.get(peer),candidate=value?.candidate;
    if(!value||!candidate?.noticeId||notice.id!==candidate.noticeId&&!notice.componentIds?.includes(candidate.noticeId)||value.seen.includes(candidate.primary.turnId))return;
    const budget=this.budget(pair);budget.used++;this.store.setSetting(streakKey(pair.id),budget);
    value.seen.push(candidate.primary.turnId);value.seen=value.seen.slice(-64);
    value.lastForward={turnId:candidate.primary.turnId,at:Date.now()};value.hold=undefined;
    this.save(peer,value);this.store.event('codex.final.forwarded',{pairId:pair.id,peerId:peer.id,turnId:candidate.primary.turnId,noticeId:candidate.noticeId,streak:budget.used});
  }
  status(peer:Peer):unknown{
    const scope=this.context(peer),value=this.get(peer,false);if(!scope||!value)return;
    const send=this.store.lastMessageFacts(scope.pair.id,peer.id);
    if(send&&value.lastSend!==send.id&&(value.lastSendAt===undefined||send.createdAt>=value.lastSendAt)){delete value.candidate;delete value.hold;}
    const candidate=value.candidate,budget=this.budget(scope.pair);
    const pending=!!candidate&&!value.seen.includes(candidate.primary.turnId);
    return{pending,hold:pending?this.reason(peer,value)??null:value.hold??null,consecutive:budget.used,cap:CODEX_FINAL_FORWARD_CAP,
      ...(candidate?{turn_id:candidate.primary.turnId,last_read_message_id:candidate.anchor,anchor_from:candidate.anchorFrom,waiting_children:candidate.children.length,followup_turn_id:candidate.followup?.turnId}:{}),...(value.lastForward?{last_forward:value.lastForward}:{})};
  }
}
