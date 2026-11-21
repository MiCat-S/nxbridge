import {type Pair,type Peer} from '../../types.js';
import type {IncidentLayer,CauseClass,IncidentAction} from './runtime-incidents.js';
export interface RuntimeAvailability {state:'reachable'|'blocked'|'unknown'|'starting';reasons:string[];checked_at:number;nativeState?:'alive'|'dead'|'unknown';resourceEvidence?:string;incident?:import('./runtime-incidents.js').IncidentStatus;functionalSuccessAt?:number}
export interface DeliveryCounts {accepted:number;sending:number;runtimeQueued:number;held:number;unknown:number}
export const emptyDeliveryCounts=():DeliveryCounts=>({accepted:0,sending:0,runtimeQueued:0,held:0,unknown:0});
export const unsettledCount=(counts:DeliveryCounts)=>Object.values(counts).reduce((a,b)=>a+b,0);
export interface RuntimeNotice {id:string;message:string;tier?:0|1|2|3|4;layer?:IncidentLayer;causeClass?:CauseClass;affectedMessageIds?:string[];action?:IncidentAction;state:'pending'|'sending'|'submitted'|'denied'|'unknown';claimedAt?:number;error?:string;source?:'context_rotation'|'idle_unanswered'|'pair_anomaly'|'turn_health'|'pair_lost'|'pair_changed'|'managed_recovery'|'claude_auto_mode'|'broker_outage'|'broker_degraded';epoch?:string;since?:number;claimedBy?:(import('../broker-outage.js').OutageClaimant&{at?:number});wake?:boolean;scope?:string;incidentId?:string;phase?:'alert'|'recovery';admitted?:boolean;revision?:number;kind?:string;severity?:number;batchId?:string;componentIds?:string[];issueKey?:string;factKey?:string;asOf?:number;recovery?:import('../recovery/managed-recovery.js').RecoveryNotice}
export interface HealthStorage {
  setting<T>(key:string):T|undefined;
  setSetting(key:string,value:unknown):void;
  transaction<T>(work:()=>T):T;
  event(type:string,data:unknown):void;
  deliveryDependencySince?(pairId:string,recipientId:string):number|undefined;
}
export const deliveryHealthKey=(pairId:string,senderId:string)=>`turnHealthDelivery:${pairId}:${senderId}`;
export const noticeScope=(pair:Pair,sender:Peer,partner:Peer,senderEpoch?:string,partnerEpoch?:string)=>JSON.stringify([pair.id,sender.id,sender.sessionId,senderEpoch,partner.id,partner.sessionId,partnerEpoch]);
export function runtimeNoticeText(notice:RuntimeNotice):string{return`[nxbridge system_notice source=${notice.source??'runtime_monitor'} notice_id=${notice.id}]\n${notice.message}`;}
