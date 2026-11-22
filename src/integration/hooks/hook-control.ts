import { randomUUID } from 'node:crypto';
import { brokerCall as callBroker } from '../../ipc/ipc.js';
import {claudeIdentity,claudeRegistration} from '../../hosts/claude/identity.js';
import {codexProcessIdentity} from '../../process/process.js';
import { codexAgentPath } from '../../hosts/codex/adapter.js';
import {bridgeHome,codexHome} from '../../shared/local-paths.js';
import {describeError} from '../../shared/errors.js';
import {isEmbeddedWake,type Actor,type Host} from '../../types.js';
import { hookCommand as runHookCommand } from './hook-command.js';
import { acknowledgeRuntimeNotice, collectRuntimeNotices } from '../../broker/health/runtime-monitor.js';
import {runtimeNoticeText,type RuntimeNotice} from '../../broker/health/contracts.js';
import { compactedMessageIds } from '../../broker/delivery/compacted-messages.js';
import { remainingTime } from '../../shared/time-budget.js';
import { disabledMember } from '../../broker/member-control.js';
import { formatStatus } from '../mcp/presentation.js';
import { codexHookApproval } from '../../hosts/codex/codex-permission.js';

export interface HookExecution {
  home?:string;configHome?:string;startedAt?:number;deadline?:number;
  claude?:{identity:Awaited<ReturnType<typeof claudeIdentity>>;address?:string;configHome:string;ownedLaunch?:{peerId:string;launchId:string}};
  runtime?:Awaited<ReturnType<typeof codexProcessIdentity>>;identityMs?:number;elapsedMs?:number;
  call?:typeof callBroker;
}
export async function hook(host:Host,input:any,provided:(ack:()=>Promise<void>)=>void,execution:HookExecution={}):Promise<unknown>{
                                                            
  const began=performance.now(),home=execution.home??bridgeHome(),configHome=execution.configHome??codexHome();
  const inheritedStart=Number(process.env.NXBRIDGE_HOOK_STARTED_AT),inheritedAge=performance.timeOrigin-inheritedStart,startedAt=execution.startedAt??(Number.isFinite(inheritedStart)&&inheritedAge>=0&&inheritedAge<10000?inheritedStart:performance.timeOrigin);
  const deadline=execution.deadline??(host==='codex'?(['SessionEnd','Interrupt'].includes(input.hook_event_name)?2300:9000)-(performance.timeOrigin-startedAt):undefined);
  const brokerCall=<T=any>(method:string,params:unknown={},options:Parameters<typeof callBroker>[2]={})=>(execution.call??callBroker)<T>(method,params,{...options,deadline});
  const control=input.hook_event_name==='UserPromptSubmit'&&!input.agent_id&&!input.agent_transcript_path&&typeof input.prompt==='string'?/^\s*nxbridge\s+(on|off|status)(?:\s+(self|codex|claude))?\s*$/.exec(input.prompt):null;
  const disabledResult=host==='codex'&&input.hook_event_name==='UserPromptSubmit'&&isEmbeddedWake(input.prompt)?{continue:false}:{};
  if(!control&&disabledMember(home,{host,sessionId:input.session_id})){input.nxbridge_disabled=true;return disabledResult;}
  if(host==='claude'){
    const identity=execution.claude?.identity??await claudeIdentity(input.session_id),address=execution.claude?execution.claude.address:process.env.CLAUDE_CODE_MESSAGING_SOCKET;
    if(input.hook_event_name==='SessionEnd')return brokerCall('context.end',{actor:{host:'claude',sessionId:identity.record.sessionId,callId:randomUUID()},reason:input.reason==='clear'?'reset':input.reason==='resume'?'switch':'unknown'},{start:false,timeout:2000});
    if(address){
      const registration=claudeRegistration(identity,address,undefined,execution.claude);
      if(!input.agent_id&&!input.agent_transcript_path&&typeof input.transcript_path==='string')registration.endpoint.nativeSession={transcriptPath:input.transcript_path};
                                                                    
      registration.contextStart=input.hook_event_name==='SessionStart';
      registration.contextReason=input.source==='clear'?'reset':input.source==='resume'?'switch':'unknown';
      registration.boundaryStartedAt=execution.startedAt??performance.timeOrigin;
      await brokerCall('register',registration);
    }
    return{};
  }
  const identityStartedAt=performance.now(),runtime=execution.runtime??await codexProcessIdentity(remainingTime(deadline,10000)),identityMs=execution.identityMs??performance.now()-identityStartedAt,registrationStartedAt=performance.now();
  const disabled=disabledMember(home,{host,sessionId:input.session_id,...runtime,configHome});
  if(disabled){
    input.nxbridge_disabled=true;if(!control)return disabledResult;
    const actor={host,memberId:disabled.peerId,sessionId:disabled.sessionId!,callId:randomUUID()};
    if(control[1]==='status')return{decision:'block',reason:formatStatus(await brokerCall('status',{actor},{timeout:8000}))};
    const target=control[2]&&control[2]!=='self'&&control[2]!==host?'partner':'self';
    const result=await brokerCall<any>('member.switch',{actor,target,enabled:control[1]==='on',user_requested:true,origin:'composer'},{mutation:true,timeout:8000});
    return{decision:'block',reason:result.message};
  }
  input.context_key=`${runtime.pid}:${runtime.procStart}:${input.transcript_path??input.session_id}`;
  if(input.hook_event_name==='SubagentStop'&&typeof input.agent_id==='string'&&typeof input.agent_transcript_path==='string'&&typeof input.transcript_path==='string'){
    delete input.agent_path;
    try{input.agent_path=codexAgentPath(input.session_id,input.agent_id,input.agent_transcript_path,input.transcript_path);}
    catch(error){process.stderr.write('nxbridge 子代理路径读取：'+describeError(error)+'\n');}
  }
  try{
  if((!runtime.appServer||runtime.managedDaemon)&&['SessionStart','UserPromptSubmit','PostToolUse'].includes(input.hook_event_name)&&!input.agent_id&&!input.agent_transcript_path){
    const approval=input.permission_mode?{approval:codexHookApproval(input.permission_mode)}:{};
    const registered=await brokerCall<{binding?:Actor['binding']}>('mcp.register',{host:'codex',sessionId:input.session_id,context_key:input.context_key,cwd:input.cwd??process.cwd(),name:'Codex',kind:'root',boundaryStartedAt:startedAt,contextStart:input.hook_event_name==='SessionStart',contextReason:input.source==='resume'?'switch':input.source==='fork'?'fork':input.hook_event_name==='SessionStart'&&input.source==='startup'?'reset':'unknown',permission:'unknown',endpoint:{mode:'embedded',address:'',epoch:`embedded:${runtime.pid}:${runtime.procStart}:${input.session_id}`,pid:runtime.pid,procStart:runtime.procStart,configHome,codexPermission:approval,...(runtime.managedDaemon?{daemon:{address:'',...approval},processKind:'app-server'}:{})}},{start:input.hook_event_name==='SessionStart',timeout:input.hook_event_name==='SessionStart'?8000:2000});
    input.actor={host:'codex',sessionId:input.session_id,callId:randomUUID(),...(registered.binding?{binding:registered.binding}:{})};
  }
  }catch(error){
    process.stderr.write('nxbridge hook 登记：'+describeError(error)+'\n');
    if(!['ENOENT','ECONNREFUSED','EPIPE','disconnected','broker_timeout','timeout','starting','daemon_thread_ended','daemon_unavailable','daemon_identity_changed','unverified_parent'].includes((error as {code?:string}).code??''))throw error;
  }
  try{
  if((!runtime.appServer||runtime.managedDaemon)&&!input.actor){
    const current=await brokerCall<{binding?:Actor['binding']}>('context.lookup',{host:'codex',configHome,pid:runtime.pid,procStart:runtime.procStart,session_id:input.session_id,...(runtime.managedDaemon?{threadId:input.session_id}:{}),boundary_started_at:startedAt},{start:false,timeout:2000});
    if(current.binding)input.actor={host:'codex',sessionId:input.session_id,callId:randomUUID(),binding:current.binding};
  }
  }catch(error){if(!['ENOENT','ECONNREFUSED','EPIPE','disconnected','broker_timeout','timeout','starting'].includes((error as {code?:string}).code??''))throw error;}
  if(control){
    const actor=input.actor??{host,sessionId:input.session_id,callId:randomUUID()};
    if(control[1]==='status')return{decision:'block',reason:formatStatus(await brokerCall('status',{actor},{timeout:8000}))};
    const target=control[2]&&control[2]!=='self'&&control[2]!==host?'partner':'self';
    const result=await brokerCall<any>('member.switch',{actor,target,enabled:control[1]==='on',user_requested:true,origin:'composer'},{mutation:true,timeout:8000});
    return{decision:'block',reason:result.message};
  }
  const monitor=['PostToolUse','UserPromptSubmit','SessionStart'].includes(input.hook_event_name)&&!input.agent_id&&!input.agent_transcript_path;
  if(monitor&&input.hook_event_name==='SessionStart'&&input.source==='compact'&&typeof input.transcript_path==='string'){
    try{input.nxbridge_compacted_message_ids=await compactedMessageIds(input.transcript_path);}
    catch(error){process.stderr.write('nxbridge 压缩窗口读取失败：'+describeError(error)+'\n');}
  }
  input.nxbridge_timing={identityMs,registrationMs:performance.now()-registrationStartedAt,elapsedBeforeBrokerMs:execution.elapsedMs===undefined?performance.now():execution.elapsedMs+identityMs+performance.now()-began};
  let result:any,notices:RuntimeNotice[]=[];
  try{result=await brokerCall('hook',input,{timeout:2000,start:input.hook_event_name==='SessionStart'});}
  catch(error){
    if(!monitor)throw error;
                                               
    if(input.hook_event_name==='UserPromptSubmit'&&isEmbeddedWake(input.prompt))return{continue:false};
    notices=await collectRuntimeNotices(home,'codex',input.session_id,runtime,input.context_key,undefined,undefined,{deadline});
    if(!notices.length)throw error;
    process.stderr.write('nxbridge hook：'+describeError(error)+'\n');
  }
  if(disabledMember(home,{host,sessionId:input.session_id,...runtime,configHome})){input.nxbridge_disabled=true;return disabledResult;}
  if(result?.continue===false)return result;
  if(monitor&&!notices.length)try{notices=await collectRuntimeNotices(home,'codex',input.session_id,runtime,input.context_key,undefined,undefined,{deadline});}catch(error){process.stderr.write('nxbridge 运行时监测：'+describeError(error)+'\n');}
  if(notices.length){
                                                       
    provided(async()=>{for(const notice of notices)await acknowledgeRuntimeNotice(home,'codex',input.session_id,runtime,notice.id,'unknown','hook output written; native admission unconfirmed',input.context_key,Math.max(0,Math.min(3000,(deadline??Infinity)-performance.now())));});
    const original=result?.hookSpecificOutput??{};
    return{...result,hookSpecificOutput:{...original,hookEventName:input.hook_event_name,additionalContext:[original.additionalContext,...notices.map(runtimeNoticeText)].filter(Boolean).join('\n\n')}};
  }
  return result??{};
}

export async function hookCommand(args:string[]):Promise<void>{await runHookCommand(args,hook);}
