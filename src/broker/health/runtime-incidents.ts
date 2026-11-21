import { randomUUID } from 'node:crypto';
import type { Endpoint, Peer } from '../../types.js';
import {describeError} from '../../shared/errors.js';
import type {HealthStorage} from './contracts.js';

export type IncidentLayer='native'|'transport'|'protocol'|'delivery'|'receipt'|'task'|'integration';
export type CauseClass='transient'|'payload'|'protocol'|'auth'|'configuration'|'human'|'exhausted'|'unknown';
export interface IncidentAction {owner:'runtime'|'model'|'user';text:string}
export interface IncidentStatus {
  id:string;peerId:string;layer:IncidentLayer;causeClass:CauseClass;code:string;
  state:'observing'|'blocked'|'recovering';since:number;lastFailureAt:number;attempts:number;retryAt?:number;
  message:string;userText:string;affectedMessageIds?:string[];action?:IncidentAction;
}
interface Incident extends IncidentStatus {scope:string;successAt?:number;closed?:boolean}
const delays=[1000,2000,4000,8000,15000,30000,60000];
const key=(id:string)=>'runtimeIncident:'+id;
const scope=(peer:Peer,endpoint?:Endpoint)=>JSON.stringify([peer.sessionId,endpoint?.runtimeId??endpoint?.native?.procStart??endpoint?.procStart??endpoint?.epoch]);

export function faultCause(error:unknown):{code:string;layer:IncidentLayer;causeClass:CauseClass;userText:string;action:IncidentAction}{
  const code=String((error as {code?:unknown})?.code??'unknown'),message=describeError(error);
  if(code==='payload_too_large')return{code,layer:'protocol',causeClass:'unknown',userText:'原生消息超过大小保护，连接已关闭，正在降频核验。',action:{owner:'runtime',text:'使用有界请求重新核验连接，不重复拉取全量历史。'}};
  if(/payload|response_too_large|WS_ERR_UNSUPPORTED_MESSAGE_LENGTH|1009/.test(code)||/max(?:imum)?.*(?:payload|message).*size|unsupported.*message.*length/i.test(message))return{code,layer:'protocol',causeClass:'payload',userText:'原生响应超过大小保护，已停止重复读取。',action:{owner:'model',text:'Report the protocol size fault once; continue independent work.'}};
  if(/auth|token_missing|unauthori[sz]ed|401|403/.test(code))return{code,layer:'protocol',causeClass:'auth',userText:'原生连接认证失败，需要检查登录或认证配置。',action:{owner:'user',text:'检查原生宿主的登录和认证配置。'}};
  if(['trust_required','workspace_untrusted','claude_bypass_consent_required','permission_denied','consent_required'].includes(code))return{code,layer:'integration',causeClass:'human',userText:'原生宿主需要用户确认信任或权限。',action:{owner:'user',text:'在原生窗口完成当前信任或权限提示。'}};
  if(/config|invalid_endpoint|bootstrap|profile_missing|command_missing/.test(code))return{code,layer:'integration',causeClass:'configuration',userText:'运行配置无法使用，已停止重复尝试。',action:{owner:'user',text:'检查 nxbridge doctor 给出的配置原因。'}};
  if(/invalid_json|protocol|invalid_response|-3260[012]|schema/.test(code))return{code,layer:'protocol',causeClass:'protocol',userText:'原生协议无法兼容，已停止相同请求。',action:{owner:'model',text:'Report the protocol compatibility fault once; do not repeat the same request.'}};
  if(/timeout|disconnect|ECONN|EPIPE|ETIMEDOUT|unreachable|offline|attach_failed/.test(code))return{code,layer:'transport',causeClass:'transient',userText:'搭档连接暂时中断，消息已保留，后台正在退避重连。',action:{owner:'runtime',text:'后台自动重连；结果不明的发送不重放。'}};
  return{code,layer:'delivery',causeClass:'unknown',userText:'搭档投递尚未确认，消息已保留，正在核验。',action:{owner:'runtime',text:'核验原编号的投递结果。'}};
}

                                          
export class RuntimeIncidents {
  constructor(private storage:HealthStorage,private now=Date.now){}
  current(peer:Peer,endpoint?:Endpoint):IncidentStatus|undefined{
    const value=this.storage.setting<Incident>(key(peer.id));if(!value||value.closed||value.scope!==scope(peer,endpoint))return;
    if(value.successAt&&this.now()-value.successAt>=30000&&value.successAt>=value.lastFailureAt){value.closed=true;this.storage.setSetting(key(peer.id),value);return;}
    const {scope:_scope,successAt:_successAt,closed:_closed,...status}=value;return status;
  }
  canAttempt(peer:Peer,endpoint?:Endpoint):boolean{
    const value=this.current(peer,endpoint);if(!value)return true;
    return value.state==='recovering'||(value.retryAt??Infinity)<=this.now();
  }
  failed(peer:Peer,endpoint:Endpoint|undefined,error:unknown,messageIds:string[]=[]):IncidentStatus{
    const before=this.storage.setting<Incident>(key(peer.id)),identity=scope(peer,endpoint),cause=faultCause(error),same=before&&!before.closed&&before.scope===identity;
    const attempts=(same?before.attempts:0)+1,since=same?before.since:this.now();
    const value:Incident={id:same?before.id:randomUUID(),peerId:peer.id,scope:identity,...cause,state:['transient','unknown'].includes(cause.causeClass)?'observing':'blocked',since,lastFailureAt:this.now(),attempts,message:'Partner operation has not succeeded ('+cause.code+').',affectedMessageIds:messageIds.slice(0,3)};
    value.retryAt=this.now()+(value.state==='observing'?delays[Math.min(attempts-1,delays.length-1)]!:900000);
    this.storage.setSetting(key(peer.id),value);this.storage.event('runtime.incident.failed',{peerId:peer.id,incidentId:value.id,layer:value.layer,causeClass:value.causeClass,code:value.code,attempts,retryAt:value.retryAt});return value;
  }
  succeeded(peer:Peer,endpoint?:Endpoint):void{
    const value=this.storage.setting<Incident>(key(peer.id));if(!value||value.closed||value.scope!==scope(peer,endpoint))return;
    value.successAt??=this.now();value.state='recovering';value.userText='搭档投递已恢复，正在观察稳定性。';delete value.retryAt;this.storage.setSetting(key(peer.id),value);
  }
  list(peers:{peer:Peer;endpoint?:Endpoint}[]):IncidentStatus[]{return peers.flatMap(({peer,endpoint})=>{const value=this.current(peer,endpoint);return value?[value]:[];});}
}
