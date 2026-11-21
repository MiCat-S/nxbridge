import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type {HealthStorage} from '../health/contracts.js';
import type { Endpoint, Host, Pair, Peer } from '../../types.js';
import {BridgeError,describeError} from '../../shared/errors.js';
import { normalizedHome } from '../../integration/hooks/session-bindings.js';
import { deterministicLaunchFailure, type LaunchPark } from '../../hosts/launch-park.js';

                                     
export interface RecoveryNotice {
  incident_id:string;partner:string;happened:string;nxbridge_did:string;
  ai_action?:string;user_step?:string;msgs:{held:number;uncertain:number};wake:boolean;
  interrupted?:{turn_id?:string;tools:string[];children:string[];effects:string};
}
export interface RecoveryProof {
  endpoint?:string;runtimeId?:string;nativeLaunchId?:string;pid?:number|null;procStart?:string|null;configHome?:string;
  executable?:string;version?:string;profileId?:string;
}
interface Attempt {id:string;at:number;state:'claimed'|'ready'|'failed'|'unknown';extra:boolean;reason?:string;error?:string;user?:boolean}
export interface ManagedIncident {
  version:1;id:string;peerId:string;pairId:string;host:Host;sessionId:string;configHome:string;
  openedAt:number;updatedAt:number;state:'pending'|'recovering'|'ready'|'blocked'|'exhausted'|'unknown'|'closed';preconditionCode?:string;
  proof:RecoveryProof;attempts:Attempt[];nextAt:number;precondition?:string;error?:string;
  launchPark?:LaunchPark;
  noticeId:string;wakeAdmitted?:boolean;noticeAdmitted?:boolean;notice?:RecoveryNotice;
  userAuthorization?:{id:string;unused:boolean};
}
export const managedRecoveryKey=(peerId:string)=>'managedRecovery:'+peerId;
const delays=[0,30000,120000];
const preconditions=new Set(['launch_proxy_unavailable','launch_probe_unavailable','bootstrap_required','claude_background_unavailable','claude_bypass_consent_required','claude_bypass_disabled','claude_inbound_restricted','claude_policy_unverified','claude_native_recovery_waiting','foreground_active','session_changed']);
export function recoveryPrecondition(error:unknown):boolean{
  if(deterministicLaunchFailure(error))return true;
  if(preconditions.has((error as {code?:string})?.code??''))return true;
                                   
  return /(?:workspace|directory|project).{0,60}(?:not trusted|untrusted)|no rollout found|session.{0,30}not found|failed to (?:load|parse).{0,30}config/i.test(describeError(error));
}
                                                                        
export function recoveryUserStep(peer:Pick<Peer,'host'|'cwd'>,incident:ManagedIncident):string|undefined{
  if(incident.state!=='blocked'&&incident.state!=='unknown')return;
  const sid=incident.sessionId,home=incident.configHome?'配置目录 '+incident.configHome:'原来的配置目录',
    entry=incident.proof.executable?`原来的 ${peer.host} 入口（${incident.proof.executable}）`:`原来的 ${peer.host} 启动方式`;
                                   
  if(incident.state==='unknown')return `运行 nxbridge status 核对上次启动结果；确认之前不要再次启动或恢复会话 ${sid}`;
  switch(incident.preconditionCode){
                                                              
    case 'bootstrap_required':
      return(peer.host==='codex'?'Claude 会先试着运行一次；不行的话，':'')+'在 Claude/Codex 之外的普通 PowerShell 里运行 nxbridge bootstrap';
    case 'bootstrap_policy_unsupported':
      return `更新${entry}，或用 nxbridge setup --codex-command 指定支持严格启动的 Codex`;
    case 'workspace_untrusted':case 'trust_required':
      return `用${entry}在 ${peer.cwd} 打开一次 ${peer.host}（${home}），接受目录信任提示`;
    case 'launch_proxy_unavailable':
      return '恢复原会话启动时用的本机代理';
    case 'launch_profile_missing':
      return `重新安装或更新${entry}后会自动重试；要换用别的程序，在系统终端运行 nxbridge config set hosts.${peer.host}.binary <程序完整路径>`;
    case 'launch_command_missing':case 'launch_command_invalid':
      return `改正你设置的 hosts.${peer.host}.command（运行 nxbridge config get hosts.${peer.host}.command 查看）`;
    case 'launch_probe_unavailable':
      return `暂时没能核验${entry}的版本，会自动重试；一直不行的话运行 nxbridge doctor 查看`;
    case 'launch_provenance_missing':
      return `在系统终端运行 nxbridge config set hosts.${peer.host}.binary <程序完整路径>，指定原安装渠道的程序；或在 ${peer.cwd} 里按会话 ID ${sid} 打开一次，让 nxbridge 记下程序`;
    case 'launch_image_ambiguous':
      return `等 Claude 桌面端更新完成（必要时完全退出再打开一次），会自动重试；或在系统终端运行 nxbridge config set hosts.${peer.host}.binary <程序完整路径>，指定要用的那一份`;
    case 'profile_version_unsupported':case 'dedicated_mode_unsupported':
      return `把${entry}更新到支持这个会话的版本，再重新打开会话 ${sid}`;
    case 'original_home_changed':case 'cwd_mismatch':
      return `把${home}和工程目录 ${peer.cwd} 改回原来的；如果是有意迁移，在原生窗口重新打开会话 ${sid}`;
    case 'session_not_found':case 'session_ambiguous':case 'session_invalid':case 'resume_not_found':case 'rollout_not_found':
      return `找回会话 ${sid} 的历史记录（${home}）；确实找不回的话，可以另选搭档`;
    case 'invalid_config':
      return `修复${home}里的 ${peer.host} 配置文件`;
    case 'foreground_active':case 'claude_foreground_active':
      return '回到正在接手这个会话的窗口继续；那个窗口结束接手后，后台会自动恢复';
    case 'claude_background_unavailable':case 'claude_bypass_consent_required':case 'claude_bypass_disabled':case 'claude_inbound_restricted':case 'claude_policy_unverified':
      return `在 ${peer.host} 里确认后台运行、审批和收信设置（${home}）`;
    case 'claude_native_recovery_waiting':
      return `后台 Claude 的原会话卡在 Claude 的后台列表里，超过一分钟没有恢复。请用平时启动 Claude 的方式（${home}）在终端运行 claude agents，找到会话 ${sid} 那一行，再运行 claude stop <那一行的 ID>。这只是停掉卡住的后台进程，对话不会删除；nxbridge 随后会自动接着原会话运行，消息都还在`;
    default:
      return '运行 nxbridge status 查看原因';
  }
}
export const recoverPartnerSchema=z.object({action:z.enum(['preview','retry','result']).default('preview'),incident_id:z.string().min(1).max(128).optional(),reason:z.string().trim().min(1).max(800).optional()}).strict();
export const RECOVER_PARTNER_TOOL={name:'recover_partner',description:'inspect current partner recovery; retry requests the single extra same-session managed launch after automatic attempts exhaust. Requires incident_id + recorded reason; never touches user-opened windows, config or approvals. Repeating the same incident returns its existing result.',inputSchema:{type:'object' as const,properties:{action:{type:'string',enum:['preview','retry','result']},incident_id:{type:'string'},reason:{type:'string'}},additionalProperties:false},annotations:{readOnlyHint:false,destructiveHint:false,openWorldHint:false}};

                                     
export class ManagedRecovery {
  private stable=new Map<string,{at:number;wall:number;last:number}>();
  private reconciled=new Set<string>();
  private clocks=new Map<string,{wall:number;mono:number}>();
  constructor(private storage:HealthStorage,private now=Date.now,private monotonic=()=>performance.now()){}
  get(peerId:string):ManagedIncident|undefined{return this.storage.setting(managedRecoveryKey(peerId));}
  authorize(peerId:string,id:string):void{const value=this.get(peerId);if(!value||value.userAuthorization?.id===id)return;value.userAuthorization={id,unused:true};value.nextAt=0;if(value.state!=='unknown')value.state='pending';this.save(value);this.storage.event('recovery.user_authorized',{incidentId:value.id,peerId,requestId:id});}
  private save(value:ManagedIncident):void{value.updatedAt=this.now();this.storage.setSetting(managedRecoveryKey(value.peerId),value);}
  observe(peer:Peer,pair:Pair,endpoint?:Endpoint,proof:RecoveryProof={}):ManagedIncident{
    if(!peer.sessionId)throw new BridgeError('session_missing','恢复需要原会话 ID。');
    return this.storage.transaction(()=>{
      const previous=this.get(peer.id),home=normalizedHome(proof.configHome??endpoint?.configHome??previous?.configHome??'');
      if(previous&&previous.sessionId===peer.sessionId&&previous.configHome===home&&previous.state!=='closed'){
                                                 
        previous.pairId=pair.id;
        this.reconcile(previous);return previous;
      }
      const value:ManagedIncident={version:1,id:randomUUID(),peerId:peer.id,pairId:pair.id,host:peer.host,sessionId:peer.sessionId!,configHome:home,openedAt:this.now(),updatedAt:this.now(),state:'pending',proof:{endpoint:endpoint?.address,runtimeId:endpoint?.runtimeId,pid:endpoint?.pid,procStart:endpoint?.procStart,configHome:endpoint?.configHome,...proof},attempts:[],nextAt:0,noticeId:randomUUID()};
      this.reconciled.add(value.id);this.stable.delete(peer.id);this.save(value);this.storage.event('recovery.opened',{incidentId:value.id,peerId:peer.id,sessionId:peer.sessionId});return value;
    });
  }
  private reconcile(value:ManagedIncident):void{
    if(this.reconciled.has(value.id))return;this.reconciled.add(value.id);
    const last=value.attempts.at(-1);
    if(last?.state==='claimed'){last.state='unknown';value.state='unknown';value.error='协调器在启动结果确认前退出，先核对原生进程。';}
    else if(!value.launchPark&&(value.nextAt>this.now()||value.updatedAt>this.now()))value.nextAt=this.now()+Math.min(120000,Math.max(0,value.nextAt-value.updatedAt));
    this.save(value);
  }
  blocked(value:ManagedIncident,error:unknown,park?:LaunchPark):void{const current=this.get(value.peerId);if(!current||current.id!==value.id)return;Object.assign(value,current);const last=value.attempts.at(-1);if(last?.state==='claimed')last.state='failed';value.state='blocked';value.precondition=describeError(error).slice(0,1200);value.preconditionCode=String((error as {code?:string})?.code??'precondition_failed');value.error=value.precondition;value.launchPark=park;value.nextAt=park?Number.MAX_SAFE_INTEGER:this.now()+30000;this.stable.delete(value.peerId);this.save(value);}
  rearm(value:ManagedIncident):void{delete value.launchPark;delete value.precondition;delete value.preconditionCode;delete value.error;value.nextAt=0;if(value.state==='blocked')value.state='pending';this.save(value);}
  due(value:ManagedIncident):boolean{if(value.launchPark)return false;const wall=this.now(),mono=this.monotonic(),prior=this.clocks.get(value.id);this.clocks.set(value.id,{wall,mono});if(prior&&Math.abs((wall-prior.wall)-(mono-prior.mono))>10000&&value.nextAt>wall+120000){value.nextAt=wall+120000;this.save(value);}return value.state!=='closed'&&value.state!=='recovering'&&!(value.state==='exhausted'&&value.attempts.filter(row=>!row.extra&&!row.user).length>=3)&&value.nextAt<=wall;}
                                           
  absent(value:ManagedIncident):void{const current=this.get(value.peerId);if(!current||current.id!==value.id)return;if(current.attempts.at(-1)?.state==='unknown'){current.attempts.at(-1)!.state='failed';current.state='pending';this.save(current);Object.assign(value,current);}}
  private capKey(value:ManagedIncident):string{return'recoveryLaunches:'+JSON.stringify([process.platform,value.host,value.configHome,value.sessionId]);}
  claim(value:ManagedIncident,extraReason?:string):Attempt{
    return this.storage.transaction(()=>{
      const current=this.get(value.peerId);if(!current||current.id!==value.id)throw new BridgeError('incident_changed','恢复事件已经改变。');
      const extra=extraReason!==undefined,last=current.attempts.at(-1),user=current.userAuthorization?.unused===true;
      if(last?.state==='claimed'||last?.state==='unknown')throw new BridgeError('recovery_uncertain','上次启动结果尚未核验，未重复启动。');
      if(extra&&current.attempts.some(row=>row.extra))throw new BridgeError('recovery_exhausted','本次事件的额外恢复已使用，请查看已有结果。');
      if(extra&&current.attempts.filter(row=>!row.extra&&!row.user).length<3)throw new BridgeError('recovery_not_exhausted','自动恢复额度尚未用完，请先核对当前前置条件。');
      if(!extra&&!user&&current.attempts.filter(row=>!row.extra&&!row.user).length>=3){current.state='exhausted';this.save(current);throw new BridgeError('recovery_exhausted','自动恢复已尝试三次，请查看状态或由搭档申请一次额外恢复。');}
      if(!extra&&!user&&current.nextAt>this.now())throw new BridgeError('recovery_backoff','恢复正在退避，未启动新进程。');
      const key=this.capKey(current),history=(this.storage.setting<number[]>(key)??[]).filter(at=>at>this.now()-3600000);
      if(!user&&history.length>=6){current.state='exhausted';current.nextAt=history[0]!+3600000;this.save(current);throw new BridgeError('recovery_rate_limited','同一会话一小时内已启动六次，已暂停自动恢复。');}
      const attempt:Attempt={id:randomUUID(),at:this.now(),state:'claimed',extra,...(user?{user:true}:{}),...(extraReason?{reason:extraReason}:{})};
      if(user)current.userAuthorization!.unused=false;
      current.attempts.push(attempt);current.state='recovering';delete current.precondition;delete current.error;
      this.storage.setSetting(key,[...history,this.now()]);this.save(current);Object.assign(value,current);return attempt;
    });
  }
  settled(value:ManagedIncident,error?:unknown,uncertain=false):void{
    const current=this.get(value.peerId);if(!current||current.id!==value.id)return;
    const last=current.attempts.at(-1);
    if(error){
      if(last?.state==='claimed'){last.state=uncertain?'unknown':'failed';last.error=describeError(error).slice(0,1200);}
      current.error=describeError(error).slice(0,1200);current.state=uncertain?'unknown':current.attempts.filter(row=>!row.extra&&!row.user).length>=3?'exhausted':'pending';
      current.nextAt=this.now()+(current.attempts.length?(delays[current.attempts.filter(row=>!row.extra).length]??120000):30000);this.stable.delete(value.peerId);
    }else{if(last?.state==='claimed'||last?.state==='unknown')last.state='ready';current.state='ready';current.nextAt=0;delete current.error;delete current.precondition;delete current.preconditionCode;delete current.launchPark;}
    this.save(current);Object.assign(value,current);
  }
  ready(peerId:string,healthy:boolean):void{
    const value=this.get(peerId);if(!value||value.state==='closed')return;
    if(!healthy){this.stable.delete(peerId);return;}
    if(value.state!=='ready')this.settled(value);
    const at=this.monotonic(),wall=this.now(),prior=this.stable.get(peerId);
    if(!prior||at-prior.last>10000||wall-prior.wall>at-prior.at+10000||wall<prior.wall){this.stable.set(peerId,{at,wall,last:at});return;}prior.last=at;
    if(at-prior.at>=60000){value.state='closed';this.save(value);this.stable.delete(peerId);this.storage.event('recovery.closed',{incidentId:value.id,peerId});}
  }
}
