import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { brokerCall } from '../../ipc/ipc.js';
import {claudeIdentity,claudeRegistration} from '../../hosts/claude/identity.js';
import {BridgeError,describeError} from '../../shared/errors.js';
import {type Actor} from '../../types.js';
import {bridgeHome,claudeHome} from '../../shared/local-paths.js';
import { currentLaunchCapture } from '../../hosts/launch-profiles.js';
import { collectRuntimeNotices, acknowledgeRuntimeNotice } from '../../broker/health/runtime-monitor.js';
import { configurationArguments } from '../../config/config-in-host.js';
import { formatStatus } from '../mcp/presentation.js';
import { modContextSchema, modMonitorAdmission, modResponse } from './mod-protocol.js';
import { openModReadReceipt, readModReadReceipt } from './mod-read-receipt.js';
import { queueRuntimeNotice } from '../../broker/health/runtime-notice-delivery.js';
import { claudeObservedPermission } from '../../hosts/claude/claude-inbound.js';
import { disabledMember, memberOffResult } from '../../broker/member-control.js';
import { preSubmitError } from '../../storage/storage-errors.js';

                                          
const OFF_ALLOWED=['switch','status','status-human'];
const offValue=(operation:string)=>['monitor','monitor-prepare'].includes(operation)?{...memberOffResult,notices:[]}:memberOffResult;
                                   
function switchParams(input:any){
  const enabled=z.boolean().parse(input.enabled),target=z.enum(['self','partner']).parse(input.target),human=input.origin==='composer'&&!input.agentId;
  if(enabled&&!human)throw new BridgeError('member_enable_human_required','开启 nxbridge 需要用户在原生输入框输入 /nxbridge on，或在独立终端运行 nxbridge on。');
  return{target,enabled,user_requested:true as const,...(human?{origin:'composer' as const}:{})};
}

export interface ModExecution {home:string;configHome:string;identity:Awaited<ReturnType<typeof claudeIdentity>>;request:typeof brokerCall}
export async function mod(input:any,execution?:ModExecution):Promise<unknown>{
  try{return await modNow(input,execution);}
  catch(error){if(['monitor','monitor-prepare'].includes(input?.operation))throw preSubmitError(error,input.operation,'prepare');throw error;}
}
async function modNow(input:any,execution?:ModExecution):Promise<unknown>{
  const home=execution?.home??bridgeHome(),configHome=execution?.configHome??claudeHome(),rawRequest=execution?.request??brokerCall;
  if(input.operation==='monitor'&&input.read_credential){
    let receipt;try{receipt=readModReadReceipt(bridgeHome(),input.read_credential);}catch{                      }
    if(receipt&&receipt.sessionId===input.sessionId&&disabledMember(bridgeHome(),{host:'claude',sessionId:receipt.sessionId,pid:receipt.native.pid,procStart:receipt.native.procStart,configHome:claudeHome()}))return offValue('monitor');
    if(receipt&&receipt.sessionId===input.sessionId)return{notices:await collectRuntimeNotices(bridgeHome(),'claude',receipt.sessionId,receipt.native,undefined,input.mod_version,receipt.revision,{admit:false,...(input.binding?{binding:input.binding}:{})})};
  }
  const identity=execution?.identity??await claudeIdentity(z.string().parse(input.sessionId));
  if(input.operation==='control-open')return{credential:await openModReadReceipt(bridgeHome(),claudeHome(),identity,input.mod_revision)};
  const registration=claudeRegistration(identity,z.string().min(1).parse(input.inbox),true,execution?{configHome}:undefined);
  const disabled=disabledMember(home,{host:'claude',sessionId:identity.record.sessionId,pid:identity.pid,procStart:registration.endpoint.procStart??undefined,configHome});
  if(disabled){
    if(!OFF_ALLOWED.includes(input.operation))return offValue(input.operation);
    const actor:Actor={host:'claude',memberId:disabled.peerId,sessionId:identity.record.sessionId,callId:typeof input.callId==='string'?input.callId:randomUUID()};
    if(input.operation==='switch')return rawRequest('member.switch',{actor,...switchParams(input)},{mutation:true});
    const status=await rawRequest<object>('status',{actor,model_view:input.model_view===true});
    return input.operation==='status-human'?{text:`${memberOffResult.message}\n${formatStatus(status)}`}:{...status,...memberOffResult};
  }
  if(typeof input.mod_version==='string'&&input.mod_version.length<100)registration.endpoint.modVersion=input.mod_version;
  if(typeof input.mod_revision==='string'&&/^[a-f0-9]{16}$/.test(input.mod_revision))registration.endpoint.modRevision=input.mod_revision;
  const observation=modContextSchema.shape.nativePermission.parse(input.nativePermission),decision=modContextSchema.shape.nativeDecision.parse(input.nativeDecision),permission=claudeObservedPermission(observation?.mode,decision);
  if(observation||decision){registration.permission=permission;registration.endpoint.nativePermission={permission,mode:observation?.mode??'unknown',observedAt:Math.max(observation?.observedAt??0,decision?.observedAt??0)};}
  if(decision)registration.endpoint.nativeDecision=decision;
  const autoMode=modContextSchema.shape.nativeAutoMode.parse(input.nativeAutoMode);
  if(autoMode)registration.endpoint.nativeAutoMode=autoMode;
  const background=modContextSchema.shape.nativeBackground.parse(input.nativeBackground);
  if(background)registration.endpoint.nativeBackground=background;
  const inbound=modContextSchema.shape.nativeInbound.parse(input.nativeInbound);
  if(inbound)registration.endpoint.nativeInbound={...inbound,...(observation||decision?{permission}:{})};
  const nativeProfile=modContextSchema.shape.nativeProfile.parse(input.nativeProfile);
  if(nativeProfile)registration.endpoint.nativeProfile=nativeProfile;
  const nativeHealth=modContextSchema.shape.nativeHealth.parse(input.nativeHealth);
  if(nativeHealth)registration.endpoint.nativeHealth={...nativeHealth,source:'native-mod'};
  const nativeSession=modContextSchema.shape.nativeSession.parse(input.nativeSession);
  if(nativeSession)registration.endpoint.nativeSession=nativeSession;
  const native={pid:identity.pid,procStart:registration.endpoint.procStart!};
  const binding=modContextSchema.shape.binding.parse(input.binding);
  if(input.operation==='monitor-enqueue')return queueRuntimeNotice(bridgeHome(),identity.record.sessionId,native,z.object({key:z.string(),epoch:z.string()}).parse(binding),z.string().min(1).parse(input.inbox),z.string().min(1).max(128).parse(input.notice_id),z.string().regex(/^[a-f0-9]{16}$/).parse(input.mod_revision),observation||decision?permission:undefined);
                                                     
  const passive=['register','prompt','state','observe','tip-agent','tip-sync','ref-capture','context-end'].includes(input.operation);
  const request=<T=any>(method:string,params:any,options:Parameters<typeof brokerCall>[2]={})=>rawRequest<T>(method,params,{...options,...(passive?{start:false,timeout:2000}:{})});
                                  
  if(input.operation==='monitor'||input.operation==='monitor-prepare')return{notices:await collectRuntimeNotices(bridgeHome(),'claude',identity.record.sessionId,native,undefined,typeof input.mod_version==='string'?input.mod_version:undefined,registration.endpoint.modRevision,{admit:modMonitorAdmission(input),...(binding?{binding}:{}),...(input.operation==='monitor-prepare'?{noticeId:z.string().parse(input.notice_id)}:{})})};
  if(input.operation==='monitor-ack'){
    await acknowledgeRuntimeNotice(bridgeHome(),'claude',identity.record.sessionId,native,z.string().parse(input.notice_id),z.enum(['submitted','denied','unknown']).parse(input.state),typeof input.error==='string'?input.error:undefined);return{recorded:true};
  }
  registration.contextStart=input.operation==='context-start'||input.contextStart===true;
  if(binding)registration.expectedBinding=binding;
  if(['reset','switch','fork','unknown'].includes(input.contextReason))registration.contextReason=input.contextReason;
  const registered=await request<{binding?:Actor['binding'];owner?:'user'|'nxbridge'}>('register',{...registration,mod_operation:input.operation,...(input.mod_diagnostics?{mod_diagnostics:input.mod_diagnostics}:{}),...(input.question_diagnostics?{question_diagnostics:input.question_diagnostics}:{})});
                                          
  if(!execution&&(registration.contextStart||input.operation==='register'&&!Object.hasOwn(input,'contextStart')))try{await request('launch.capture',await currentLaunchCapture('claude',identity.record.sessionId,{pid:identity.pid,procStart:identity.native.startedAt}));}catch(error){process.stderr.write('nxbridge 启动环境登记：'+describeError(error)+'\n');}
  const actor:Actor={host:'claude',sessionId:identity.record.sessionId,callId:typeof input.callId==='string'?input.callId:randomUUID(),...(registered.binding?{binding:registered.binding}:{}),...(typeof input.turnId==='string'?{turnId:input.turnId}:{})};
  if(['send','tip-agent'].includes(input.operation)&&input.via){
    const agents=z.array(z.object({id:z.string(),parentId:z.string().optional()})).parse(input.agents),chain:typeof agents=[];
    let id=z.string().parse(input.via);const seen=new Set<string>();
    while(id){if(seen.has(id))throw new BridgeError('unverified_parent','Claude 子代理父链存在循环。');seen.add(id);const agent=agents.find(a=>a.id===id);if(!agent)throw new BridgeError('unverified_parent','Claude 未确认这个子代理属于当前会话。');chain.unshift(agent);id=agent.parentId??'';}
    for(const agent of chain)await request('register',{...registration,sessionId:identity.record.sessionId+'#'+agent.id,kind:'subagent',parentId:agent.parentId?identity.record.sessionId+'#'+agent.parentId:identity.record.sessionId});
    actor.sessionId=identity.record.sessionId+'#'+input.via;actor.via=input.via;
  }
  const execute=async()=>{switch(input.operation){
    case'checkpoint':return request('checkpoint',{actor,input:input.input},{mutation:true});
    case'recovery':return request('recovery.facts',{actor},{start:false,timeout:2000});
    case'read-messages':return request('messages.read',{actor,message_ids:input.message_ids});
    case'register':case'context-start':return{registered:true,binding:registered.binding,owner:registered.owner};
    case'context-end':return request('context.end',{actor,reason:input.reason},{mutation:true});
    case'send':return request('send',{actor,message:input.message,in_reply_to:input.in_reply_to,auto_reply_to:input.auto_reply_to,auto_reply_text:input.auto_reply_text,reply_expected:input.reply_expected},{mutation:true});
    case'selection-get':case'selection-refresh':return request(input.operation==='selection-get'?'pair.selection.get':'pair.selection.refresh',{actor,selection_id:input.selection_id});
    case'selection-resolve':return request('pair.selection.resolve',{actor,selection_id:input.selection_id},{mutation:true});
    case'selection-commit':return request('pair.selection.commit',{actor,selection_id:input.selection_id,key:input.key,action:input.action,...(input.model!==undefined?{model:input.model}:{}),...(input.effort!==undefined?{effort:input.effort}:{})},{mutation:true});
    case'partner-profile':{const action=input.action??'get';return request('partner.profile',{actor,action,...(input.model!==undefined?{model:input.model}:{}),...(input.effort!==undefined?{effort:input.effort}:{})},{mutation:action!=='get'});}
    case'pair-code':return request('pair.code',{actor});
    case'pair-code-commit':{if(input.origin!=='composer'||input.agentId)throw new BridgeError('pairing_human_origin_required','配对码必须由本窗口用户输入。');return request('pair.code.commit',{actor,code:input.code,origin:'composer'},{mutation:true});}
    case'switch':return request('member.switch',{actor,...switchParams(input)},{mutation:true});
    case'status':return request('status',{actor,model_view:input.model_view===true});
    case'status-human':return{text:formatStatus(await request('status',{actor}))};
    case'observe':return request('observe',{actor,message_id:input.message_id,state:input.state,admission:input.admission});
    case'state':return request('peer.state',{actor,state:input.state,model:input.model,effort:input.effort});
    case'prompt':return request('peer.prompt',{actor},{mutation:true});
    case'config':{
      if(input.origin!=='composer'||input.agentId)throw new BridgeError('config_human_origin_required','配置命令必须由本窗口用户在 Claude 原生输入框提交。');
      const args=configurationArguments(z.string().parse(input.args));
      return request('config.human',{actor,origin:'composer',args},{mutation:true});
    }
                                              
    case'human-refused':return request('config.human.refused',{actor,command:z.enum(['config','pair','switch']).parse(input.command),origin:z.string().max(64).parse(input.origin),surfaces:z.array(z.string().max(32)).max(8).parse(input.surfaces)},{mutation:true});
    case'config-model':{
      if(input.agentId)throw new BridgeError('subagent_denied','配置入口只接受独立根会话。');
      return request('config.model',{actor,input:input.input},{mutation:true});
    }
    case'ref-expand':return request('ref.expand',{actor,text:input.text});
    case'tip-agent':return request('tip.agent',{actor,text:input.text});
    case'tip-sync':return request('tip.sync',{actor,usage:input.usage,compaction:input.compaction});
    case'reload-attempt':return request('mod.reload.attempt',{actor,attempt_id:input.attempt_id,target_revision:input.target_revision},{mutation:true});
    case'ref-capture':{
      const agents=z.array(z.object({id:z.string(),parentId:z.string().optional()})).parse(input.agents);
      let id=z.string().parse(input.agent_id);const seen=new Set<string>();
      while(id){if(seen.has(id))throw new BridgeError('unverified_parent','Claude 子代理父链存在循环。');seen.add(id);const agent=agents.find(a=>a.id===id);if(!agent)throw new BridgeError('unverified_parent','子代理不属于当前原生会话。');id=agent.parentId??'';}
      return request('ref.capture',{actor,agent_id:input.agent_id,text:input.text});
    }
    default:throw new BridgeError('unknown_mod_operation','不支持的 Mod 操作。');
  }};
  const value=await execute();let readTransport;
  if(input.read_credential&&['register','context-start','status'].includes(input.operation))try{
    readTransport=await request('mod.read.open',{actor,credential:input.read_credential},{start:false,timeout:2000});
  }catch{                        }
  const response=modResponse(input,value,{sessionId:identity.record.sessionId,binding:registered.binding});
  return readTransport&&response&&typeof response==='object'?{...response,readTransport}:response;
}

