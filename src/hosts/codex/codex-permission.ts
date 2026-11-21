import type { CodexPermissionEvidence, PermissionClass, Endpoint } from '../../types.js';
import { mergeObservedFields, type FieldObservation } from '../../storage/observed-fields.js';
import { readSessionProfile, type SessionProfile } from './codex-session-profile.js';

const sandboxes:Record<string,string>={readOnly:'read-only',workspaceWrite:'workspace-write',dangerFullAccess:'danger-full-access'};

export function codexEvidenceContext(sessionId:string|null,endpoint:Endpoint):string{
  return JSON.stringify([sessionId,endpoint.bindingEpoch,endpoint.pid,endpoint.procStart]);
}

                                    
export function observeCodexPermission(endpoint:Endpoint,sessionId:string|null,incoming:CodexPermissionEvidence,source:string,previous?:FieldObservation<CodexPermissionEvidence>,observedAt=Date.now()):Endpoint{
  previous??=endpoint.codexPermissionObservation??(endpoint.codexPermission?{value:endpoint.codexPermission,source:'prior-native-registration',context:codexEvidenceContext(sessionId,endpoint),observedAt:endpoint.seenAt}:undefined);
  const observation=mergeObservedFields(previous,incoming,{source,context:codexEvidenceContext(sessionId,endpoint),observedAt},[['approval','sandbox'],['approval','autoReview']]);
  const next={...endpoint};delete next.codexPermission;delete next.codexPermissionObservation;
  if(observation){next.codexPermissionObservation=observation;next.codexPermission=observation.value;}
  return next;
}

                                    
export function classifyCodexPermission(evidence:CodexPermissionEvidence):PermissionClass{
  const sandbox=sandboxes[evidence.sandbox??'']??evidence.sandbox;
  if(sandbox==='danger-full-access'&&evidence.approval==='bypass')return'bypass';
  if(['read-only','workspace-write'].includes(sandbox??'')||evidence.autoReview===true&&evidence.approval!=='bypass'||evidence.approval==='prompting')return'prompting';
  return'unknown';
}

export function codexHookApproval(mode:unknown):PermissionClass{
  return ['bypassPermissions','never'].includes(String(mode))?'bypass':['default','manual','plan','acceptEdits','dontAsk','auto','prompting','on-request','on-failure','untrusted'].includes(String(mode))?'prompting':'unknown';
}

                                                 
export function codexProfileEvidence(profile:SessionProfile):CodexPermissionEvidence|undefined{
  if(!profile.verified||!profile.complete)return;
  const p=profile.settings,permission=p.permissionProfile;
  if(!permission&&!p.sandbox&&p.approvalPolicy===undefined&&p.approvalsReviewer===undefined)return;
  const sandbox=permission?.type==='disabled'?'danger-full-access':permission?.type==='managed'?'workspace-write':p.sandbox?.type??'unknown';
  return{sandbox:sandboxes[sandbox]??sandbox,approval:p.approvalPolicy==='never'?'bypass':p.approvalPolicy!==undefined?'prompting':'unknown',...(p.approvalsReviewer==='auto_review'?{autoReview:true}:p.approvalsReviewer==='user'?{autoReview:false}:{})};
}
export async function persistedCodexPermission(file:unknown,sessionId:string):Promise<CodexPermissionEvidence|undefined>{
  return codexProfileEvidence(await readSessionProfile(file,sessionId));
}

export function codexMetadataEvidence(details:Record<string,unknown>):CodexPermissionEvidence{
  return{...(typeof details.sandbox_mode==='string'?{sandbox:details.sandbox_mode}:{}),...(typeof details.approval_policy==='string'?{approval:details.approval_policy==='never'?'bypass' as const:'prompting' as const}:{}),...(typeof details.auto_review_enabled==='boolean'?{autoReview:details.auto_review_enabled}:{})};
}

export function codexRuntimeEvidence(result:{approvalPolicy?:unknown;approvalsReviewer?:unknown;sandbox?:{type?:string};autoReviewEnabled?:boolean}):CodexPermissionEvidence{
  const sandbox=result.sandbox?.type;
  return{...(sandbox?{sandbox:sandboxes[sandbox]??sandbox}:{}),...(result.approvalPolicy?{approval:result.approvalPolicy==='never'?'bypass' as const:'prompting' as const}:{}),...(['user','auto_review'].includes(String(result.approvalsReviewer))?{autoReview:result.approvalsReviewer==='auto_review'}:typeof result.autoReviewEnabled==='boolean'?{autoReview:result.autoReviewEnabled}:{})};
}
