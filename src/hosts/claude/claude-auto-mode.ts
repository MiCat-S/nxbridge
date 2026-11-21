import { z } from 'zod';
import type { Store } from '../../storage/store.js';
import type { Endpoint, Peer } from '../../types.js';

export const nativeAutoModeSchema=z.object({
  observedAt:z.number().finite().nonnegative(),
  unavailable:z.object({at:z.number().finite().nonnegative(),tool:z.string().min(1).max(256),toolUseId:z.string().max(256).optional(),agent:z.literal(true).optional()}).optional(),
});
export const nativeBackgroundSchema=z.object({tasks:z.number().int().nonnegative().optional(),crons:z.number().int().nonnegative().optional(),observedAt:z.number().finite().nonnegative()});
export type NativeAutoMode=z.infer<typeof nativeAutoModeSchema>;
export interface ClaudeAutoFallback {
  phase:'pending'|'stopping'|'launching'|'binding'|'ready'|'resolved'|'blocked'|'unknown';
  old_session_id:string;session_id?:string;source_epoch:string;pair_id:string;at:number;
  reason:'classifier_unavailable';tool:string;denied_at:number;error?:string;notice_id?:string;notified_phase?:string;phase_at?:number;idle_at?:number;requested_mode?:'default';mode_checked?:boolean;
  source?:import('../../process/owned-native.js').NativeOwnership;
}
export const claudeAutoKey=(id:string)=>'claudeAutoFallback:'+id;
export function claudeAutoMatches(value:ClaudeAutoFallback|undefined,peer:Peer,pairId:string|undefined):boolean{
  return !!value&&peer.owner==='nxbridge'&&pairId===value.pair_id&&(value.old_session_id===peer.sessionId||value.session_id===peer.sessionId);
}
export function claudeAutoPhaseHolds(phase:ClaudeAutoFallback['phase']):boolean{return !['ready','resolved','blocked'].includes(phase);}
export function claudeAutoStatus(store:Store,peer:Peer):Omit<ClaudeAutoFallback,'source'>|undefined{
  const value=store.setting<ClaudeAutoFallback>(claudeAutoKey(peer.id));
  if(!value||!claudeAutoMatches(value,peer,store.pairFor(peer.id)?.id))return;
  const {source,...status}=value;return status;
}
export function claudeAutoHolds(store:Store,peer:Peer):boolean{
  const value=claudeAutoStatus(store,peer);return !!value&&claudeAutoPhaseHolds(value.phase);
}
export function observeClaudeAuto(store:Store,peer:Peer,endpoint:Endpoint):void{
  const observation=endpoint.nativeAutoMode,pair=store.pairFor(peer.id),previous=store.setting<ClaudeAutoFallback>(claudeAutoKey(peer.id));
  if(peer.host!=='claude'||peer.owner!=='nxbridge'||!peer.sessionId||!pair||endpoint.nativePermission?.mode!=='auto'||!observation?.unavailable)return;
                               
  if(previous&&(previous.old_session_id===peer.sessionId||previous.session_id===peer.sessionId))return;
  store.setSetting(claudeAutoKey(peer.id),{phase:'pending',old_session_id:peer.sessionId,source_epoch:endpoint.epoch,pair_id:pair.id,at:Date.now(),reason:'classifier_unavailable',tool:observation.unavailable.tool,denied_at:observation.unavailable.at} satisfies ClaudeAutoFallback);
  store.event('claude.auto.unavailable',{peerId:peer.id,sessionId:peer.sessionId,tool:observation.unavailable.tool});
}
