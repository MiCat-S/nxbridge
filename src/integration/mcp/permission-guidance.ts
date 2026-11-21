import type { Endpoint, NativeInbound, Peer, PermissionClass } from '../../types.js';

export interface PermissionGuidance {
  state:'class_mismatch'|'sender_unknown'|'held'|'refused';
  sender_class:PermissionClass;receiver_class:PermissionClass;receiver_host:'claude';
  policy_source?:NativeInbound['source'];
  receiver_member_id:string;receiver_session_id:string|null;message:string;
}

                                      
export function permissionFacts(peer:Peer,endpoint?:Endpoint){
  return{class:peer.permission,...(peer.host==='codex'?{...endpoint?.codexPermission,...(endpoint?.codexPermissionObservation?{source:endpoint.codexPermissionObservation.source,observed_at:endpoint.codexPermissionObservation.observedAt}:{})}:{...(endpoint?.nativePermission?.mode?{mode:endpoint.nativePermission.mode}:{}),...(endpoint?.nativeDecision?{bash_decision:endpoint.nativeDecision.bash,decision_rule:endpoint.nativeDecision.rule}:{}),...(endpoint?.nativeInbound?{inbound_policy:endpoint.nativeInbound.policy,inbound_source:endpoint.nativeInbound.source}:{} )})};
}

                                         
export function permissionGuidance(codex:Peer,claude:Peer,endpoint?:Endpoint):PermissionGuidance|undefined{
  const policy=endpoint?.nativeInbound?.policy,receiver=endpoint?.nativePermission?.permission??endpoint?.nativeInbound?.permission??claude.permission,sender=codex.permission;
  if(policy==='accept')return;
  const state=policy==='hold'?'held':policy==='refuse'?'refused':sender==='unknown'&&receiver==='bypass'?'sender_unknown':sender!=='unknown'&&receiver!=='unknown'&&sender!==receiver?'class_mismatch':undefined;
  if(!state)return;
  const target=`Claude ${claude.name} (session ${claude.sessionId??'not started'})`,source=endpoint?.nativeInbound?.source;
  const origin=source==='policy'?' Managed policy takes precedence over launch flags; only the user/admin may change it.':source==='project'||source==='local'?' Repository settings tighten launch/user policy; the user may remove that setting or choose native --setting-sources.':source==='invalid'?' An unrecognized native setting forces hold; fix that value.':'';
  const message=state==='held'?`${target} has crossSessionInbound=hold; incoming partner messages stay in native hold until the user changes that policy.`:
    state==='refused'?`${target} has crossSessionInbound=refuse; native rejects inbound messages. Saved is not delivered; user may change that setting in the original Claude window.`:
    state==='sender_unknown'?`Codex approval class is not yet verified; from-mode stays omitted. ${target} is bypass-class and may hold it. Check native Codex hooks/effective policy evidence; no need to switch to yolo.`:
    `Codex is ${sender}, ${target} is ${receiver}; native default inbound policy holds cross-class messages. User may handle the native inbound dialog there, change Claude mode with Shift+Tab, or deliberately adjust crossSessionInbound in /config. Permission rules for tools do not release inbound hold.`;
  return{state,sender_class:sender,receiver_class:receiver,receiver_host:'claude',receiver_member_id:claude.id,receiver_session_id:claude.sessionId,...(source?{policy_source:source}:{}),message:message+origin+' Never auto-approve or replay an unconfirmed message.'};
}
