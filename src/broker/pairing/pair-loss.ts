import { randomUUID } from 'node:crypto';
import type { Store } from '../../storage/store.js';
import type { Actor, Host, Pair, Peer } from '../../types.js';
import type {HealthStorage,RuntimeNotice} from '../health/contracts.js';
import { HealthNoticePolicy } from '../health/notice-policy.js';
import { partnerConfigHome } from './partner-home.js';

export interface PairLossCause {reason:'broker_shutdown'|'identity_mismatch'|'window_exit'|'external_release'|'session_deleted';actor?:string}
export interface PairLoss extends PairLossCause {
  id:string;pair_id:string;partner_id:string;partner_name:string;partner_host:Host;partner_session_id:string|null;partner_config_home?:string;
  session_id:string|null;binding?:Actor['binding'];at:number;state:RuntimeNotice['state'];admitted?:boolean;error?:string;
  restore_command:string;
  partner_missing?:boolean;
  deleted_member_id?:string;
  replacement_suppressed?:boolean;
  held_message_ids?:string[];
  replacement?:{state:'failed'|'uncertain';member_id:string;next_at:number;error:string;terminal?:boolean};
}
export const pairLossKey=(peerId:string)=>'pairLoss:'+peerId;
export function pairLoss(store:Store,peer:Peer):PairLoss|undefined{
  if(store.pairFor(peer.id))return;
                                     
  return store.setting<PairLoss|null>(pairLossKey(peer.id))??undefined;
}
export function recordPairLoss(store:Store,pair:Pair,cause:PairLossCause):void{
  for(const id of [pair.claude,pair.codex]){
    const peer=store.peer(id),partner=store.peer(id===pair.claude?pair.codex:pair.claude),binding=store.bindings.current(id),configHome=partnerConfigHome(store,partner);
    const loss:PairLoss={...cause,id:randomUUID(),pair_id:pair.id,partner_id:partner.id,partner_name:partner.name,partner_host:partner.host,partner_session_id:partner.sessionId,...(configHome?{partner_config_home:configHome}:{}),session_id:peer.sessionId,...(binding?{binding:{key:binding.key,epoch:binding.epoch}}:{}),at:Date.now(),state:'pending',restore_command:'nxbridge pair --restore '+pair.id};
    store.setSetting(pairLossKey(id),loss);
  }
}
                                                                 
const heldText=(loss:PairLoss)=>loss.held_message_ids?.length?' '+loss.held_message_ids.length+' unread msgs from former partner held: '+loss.held_message_ids.join(', ')+' -> read via read_messages before next step.':'';
                                                                                       
const replacementText=(loss:PairLoss)=>loss.replacement?.state==='uncertain'?' auto replacement result uncertain ('+loss.replacement.error+'): waiting for native launch verification, no 2nd auto create; continue solo-capable work, record state for user.':loss.replacement?.terminal?' auto replacement stopped after repeated failures ('+loss.replacement.error+'): no further auto create; continue solo-capable work, record state for user.':'';
export function pairLossText(loss:PairLoss):string{
                                                                                                                                                                                                                                                              
  if(loss.reason==='session_deleted')return 'nxbridge notice (not partner task or user approval): pair '+loss.pair_id+' ended: former partner '+JSON.stringify(loss.partner_name)+' session history verified missing -> unavailable while missing (restore only if native history reappears: '+loss.restore_command+'). tell user in this window + offer native partner picker (create/select replacement or stay unpaired). nxbridge-owned headless session may get 1 fresh partner automatically unless nxbridge off/paused/user declined. old msgs not forwarded/replayed; uncertain deliveries stay uncertain. replacement = fresh identity, no shared context -> brief it (goal, state, CURRENT path).'+heldText(loss)+replacementText(loss);
  return 'nxbridge notice (not partner reply or user msg): pair '+loss.pair_id+' ended; former '+loss.partner_host+' partner '+JSON.stringify(loss.partner_name)+' ('+loss.partner_id+'); cause '+loss.reason+(loss.actor?' / '+loss.actor:'')+' at '+new Date(loss.at).toISOString()+'. No new partner started. If the authorized task needs this partner, restore the same partner/session with '+loss.restore_command+' and tell the user; a NEW partner requires explicit user choice. History missing or identity changed -> stop and report; never substitute a new session. Nothing replayed; inspect prior progress before continuing.';
}
export function lossNotices(storage:HealthStorage,peer:Peer,loss:PairLoss,options:{admit?:boolean;noticeId?:string}={}):RuntimeNotice[]{
  const current=storage.setting<PairLoss|null>(pairLossKey(peer.id));if(!current||current.id!==loss.id)return[];loss=current;
  if(loss.admitted||loss.state!=='pending'||options.noticeId&&options.noticeId!==loss.id||['paused','needsHuman','offline'].includes(peer.state))return[];
  const notice:RuntimeNotice={id:loss.id,state:'pending',source:'pair_lost',message:pairLossText(loss),kind:'pair_lost',severity:2,wake:false};
  const policy=new HealthNoticePolicy(storage);if(!policy.eligible(peer.id,notice))return[];
  if(options.admit===false)return[{id:notice.id,source:notice.source,wake:false} as RuntimeNotice];
  storage.setSetting(pairLossKey(peer.id),{...loss,state:'unknown',admitted:true});policy.admit(peer.id,[notice]);
  storage.event('health.pair.lost',{pairId:loss.pair_id,peerId:peer.id,noticeId:loss.id,reason:loss.reason});
  return[notice];
}
