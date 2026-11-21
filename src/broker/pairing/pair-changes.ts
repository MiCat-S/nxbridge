import { randomUUID } from 'node:crypto';
import type { Store } from '../../storage/store.js';
import type { Actor, Pair, Peer } from '../../types.js';
import type {HealthStorage,RuntimeNotice} from '../health/contracts.js';

export interface PairChange extends RuntimeNotice {
  pair_id:string;session_id:string|null;binding?:Actor['binding'];at:number;
  cancelled_message_ids:string[];uncertain_message_ids:string[];
}
export const pairChangeKey=(id:string)=>'pairChange:'+id;

                                       
export function settleChangedPair(store:Store,pair:Pair,initiator?:string):{cancelled_message_ids:string[];uncertain_message_ids:string[]}{
  const cancelled=new Map<string,string[]>(),uncertain=new Map<string,string[]>();
  for(const message of store.messagesFor(pair.id)){
    if(!['accepted','held','sending','runtimeQueued','unknown'].includes(message.state))continue;
    const safe=['accepted','held'].includes(message.state)&&message.attempts===0,target=safe?cancelled:uncertain,list=target.get(message.from)??[];list.push(message.id);target.set(message.from,list);
    if(safe)store.transition(message.id,'expired','partner_changed: 搭档已改变，此消息未投递；没有自动转发给新搭档。');
    else if(message.state==='sending')store.transition(message.id,'unknown','partner_changed: 旧搭档可能已收到，必须核对原生历史，不得自动重发。');
  }
  for(const id of [pair.claude,pair.codex]){
    if(id===initiator)continue;
    const peer=store.peer(id),partner=store.peer(id===pair.claude?pair.codex:pair.claude),binding=store.bindings.current(id),cancelledIds=cancelled.get(id)??[],uncertainIds=uncertain.get(id)??[];
    const notice:PairChange={id:randomUUID(),pair_id:pair.id,session_id:peer.sessionId,...(binding?{binding:{key:binding.key,epoch:binding.epoch}}:{}),at:Date.now(),state:'pending',source:'pair_changed',wake:false,cancelled_message_ids:cancelledIds,uncertain_message_ids:uncertainIds,
      message:'nxbridge pairing notice (not partner task): user changed or ended the pairing with '+partner.host+' '+JSON.stringify(partner.name)+'. This window is no longer paired with that partner. Nothing forwarded or replayed.'+(cancelledIds.length?' Confirmed NOT delivered; sender may resend to its newly selected partner only if task still needed: '+cancelledIds.join(', ')+'.':'')+(uncertainIds.length?' May already be received by old partner; do NOT resend: '+uncertainIds.join(', ')+'.':'')+' Tell user briefly; do not restore this old pairing or pick a replacement yourself.'};
    store.setSetting(pairChangeKey(id),notice);
  }
  return{cancelled_message_ids:initiator?cancelled.get(initiator)??[]:[...cancelled.values()].flat(),uncertain_message_ids:initiator?uncertain.get(initiator)??[]:[...uncertain.values()].flat()};
}

export function changeNotices(storage:HealthStorage,peer:Peer,options:{admit?:boolean;noticeId?:string}={}):RuntimeNotice[]{
  const value=storage.setting<PairChange>(pairChangeKey(peer.id));
  if(!value||value.admitted||value.state!=='pending'||value.session_id!==peer.sessionId||options.noticeId&&options.noticeId!==value.id||['paused','needsHuman','offline'].includes(peer.state))return[];
  if(options.admit===false)return[{id:value.id,source:'pair_changed',wake:false} as RuntimeNotice];
  storage.setSetting(pairChangeKey(peer.id),{...value,admitted:true,state:'unknown'});return[value];
}
