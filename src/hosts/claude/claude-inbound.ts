import { randomUUID } from 'node:crypto';
import type { Store } from '../../storage/store.js';
import type { Endpoint, Message, Peer, PermissionClass } from '../../types.js';
import {noticeScope} from '../../broker/health/contracts.js';
import {type DeliveryHealth} from '../../broker/health/delivery.js';

                                              
export const claudePermissionClass=(mode?:string):PermissionClass=>['bypassPermissions','plan','bypass'].includes(mode??'')?'bypass':['default','acceptEdits','dontAsk','auto','prompting'].includes(mode??'')?'prompting':'unknown';
                                           
export function claudeObservedPermission(mode?:string,decision?:Endpoint['nativeDecision']):PermissionClass{
  const permission=claudePermissionClass(mode);
  return permission!=='unknown'?permission:decision?.bash==='allow'&&decision.rule===undefined?'bypass':decision&&decision.bash!=='allow'?'prompting':'unknown';
}
export type InboundAdmission='accept'|'approval_required'|'held'|'refused'|'unknown';
export function inboundAdmission(sender:PermissionClass,endpoint?:Endpoint):InboundAdmission{
  const inbound=endpoint?.nativeInbound;
  if(!inbound||inbound.policy==='unknown')return'unknown';
  if(inbound.policy==='accept')return'accept';
  if(inbound.policy==='hold')return'held';
  if(inbound.policy==='refuse')return'refused';
  if(!inbound.permission||inbound.permission==='unknown'||sender==='unknown')return'unknown';
  return sender===inbound.permission?'accept':'approval_required';
}
export function inboundWarning(state:InboundAdmission):string|undefined{
  return state==='approval_required'?'Claude native inbound approval expected: sender/receiver permission classes differ; recipient user must approve this message in the original Claude window. Default dialog expires after 5m unless configured otherwise; no automatic replay':
    state==='held'?'Claude crossSessionInbound=hold: native keeps messages pending until its policy allows release; no automatic replay':
    state==='refused'?'Claude crossSessionInbound=refuse: native rejects incoming messages before the receive hook; saved != delivered; no automatic replay':undefined;
}
const approvalKey=(id:string)=>'claudeApproval:'+id;
export interface NativeApproval {
  receivedAt:number;expiresAt?:number;durationVerified:boolean;scope:string;noticeIds:string[];expiredUnconfirmed?:boolean;
}
function approvalDuration(raw?:string,override?:number):{ms?:number;verified:boolean}{
  if(override!==undefined)return{ms:override,verified:true};
  if(raw==='never')return{verified:true};
  if(raw===undefined)return{ms:300000,verified:true};
  const match=/^(\d+)(s|m|h)$/.exec(raw),ms=match?Number(match[1])*({s:1000,m:60000,h:3600000}[match[2]!]??0):NaN;
  return Number.isSafeInteger(ms)&&ms>=0?{ms,verified:true}:{ms:300000,verified:false};
}

                                            
export class ClaudeInbound {
  constructor(private store:Store,private notices:DeliveryHealth){}
  private scope(message:Message):string|undefined{
    const pair=this.store.pairFor(message.from);if(!pair||pair.id!==message.pairId)return;
    const sender=this.store.peer(message.from),target=this.store.peer(message.to);
    return noticeScope(pair,sender,target,this.store.bindings.current(sender.id)?.epoch,this.store.bindings.current(target.id)?.epoch);
  }
  private notify(message:Message,approval:NativeApproval,text:string,kind:string,severity=1,id=randomUUID() as string):void{
    if(this.scope(message)!==approval.scope)return;
    approval.noticeIds.push(id);
    this.notices.enqueue(message.pairId,message.from,{id,state:'pending',source:'pair_anomaly',scope:approval.scope,kind,severity,message:'nxbridge runtime monitor (not partner reply or user msg): '+text});
  }
  received(peer:Peer,message:Message,admission?:'approval_required'):void{
    if(!admission||peer.host!=='claude'||['contextObserved','responded','refused','expired'].includes(message.state))return;
    if(this.store.setting<NativeApproval|null>(approvalKey(message.id)))return;
    const scope=this.scope(message);if(!scope)return;
    const inbound=this.store.endpoint(peer.id)?.nativeInbound,now=Date.now(),duration=approvalDuration(inbound?.dialogExpiry,inbound?.dialogTimeoutMs);
    const approval:NativeApproval={receivedAt:now,...(inbound?.policy==='default'&&duration.ms!==undefined?{expiresAt:now+duration.ms}:{}),durationVerified:duration.verified,scope,noticeIds:[]};
    this.store.transition(message.id,'held','Claude 接收钩子报告原生入站审核等待；尚未确认进入模型上下文。');
    this.notify(message,approval,`Claude receive hook saw msg ${message.id}, but native admission requires approval/hold; not read. ${inbound?.policy==='hold'?'Explicit hold has no dialog deadline.':'Recipient user may need to approve it in the original Claude window.'} Never automatically replay.`,'inbound_approval');
    this.store.setSetting(approvalKey(message.id),approval);
    this.store.event('message.inbound.held',{messageId:message.id,receivedAt:now,expiresAt:approval.expiresAt,policy:inbound?.policy});
  }
  resolved(message:Message):void{
    this.notices.cancel(message.pairId,message.from,'inbound-failure:'+message.id);
    const approval=this.store.setting<NativeApproval|null>(approvalKey(message.id));if(!approval)return;
    for(const id of approval.noticeIds)this.notices.cancel(message.pairId,message.from,id);
    this.store.setSetting(approvalKey(message.id),null);
  }
  rejected(message:Message,status:'refused'|'expired',reason?:string):void{
                                         
    if(message.state===status||this.store.message(message.id).state!==status)return;
    this.resolved(message);
    const scope=this.scope(message);if(!scope)return;
    this.notify(message,{receivedAt:Date.now(),durationVerified:true,scope,noticeIds:[]},`Claude native receipt confirmed msg ${message.id} ${status}; not delivered${reason?': '+reason:''}. Message retained; no automatic replay.`,'inbound_delivery_failed',2,'inbound-failure:'+message.id);
  }
  sweep(now=Date.now()):void{
    for(const {message,approval} of this.store.inboundApprovals()){
      this.store.faults.sync('inbound_approval:'+message.id,()=>this.store.transaction(()=>{
      if(this.store.peer(message.from).enabled===false||this.store.peer(message.to).enabled===false)return;
      if(['contextObserved','responded','refused','expired','runtimeQueued'].includes(message.state)||this.scope(message)!==approval.scope){this.resolved(message);return;}
      if(approval.expiredUnconfirmed||approval.expiresAt===undefined||now<approval.expiresAt)return;
      approval.expiredUnconfirmed=true;
      this.notify(message,approval,`approval_expiry_unconfirmed: Claude msg ${message.id} was held at receive; ${approval.durationVerified?'its approval dialog deadline':'the default 5m observation window (configured duration unrecognized)'} passed without context/reply evidence. Native may have dropped it; approval followed by a busy queue is also possible. Delivery remains unconfirmed; do not automatically resend. If still needed after the recipient approves or fixes the mode, tell your user to inspect the original Claude message; the user decides whether to resend with the original id.`,'inbound_approval_expiry',2);
      this.store.setSetting(approvalKey(message.id),approval);
      this.store.event('message.inbound.expiry_unconfirmed',{messageId:message.id,expiresAt:approval.expiresAt,durationVerified:approval.durationVerified});
      }));
    }
  }
}
