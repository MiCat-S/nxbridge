import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { VERSION } from '../../version.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { BrokerSession } from '../../ipc/ipc.js';
import {claudeIdentity,claudeRegistration} from '../../hosts/claude/identity.js';
import {codexProcessIdentity} from '../../process/process.js';
import {BridgeError} from '../../shared/errors.js';
import {CLAUDE_PARTNER_INSTRUCTIONS,CODEX_PARTNER_INSTRUCTIONS} from '../instructions.js';
import {type Actor,type Host,type Peer,type RegisterInput} from '../../types.js';
import {bridgeHome,codexHome} from '../../shared/local-paths.js';
import { currentLaunchCapture } from '../../hosts/launch-profiles.js';
import { ASK_TOOL, ANSWER_TOOL, codexAskSchema } from './questions.js';
import { modelError } from './model-error.js';
import { CONFIGURATION_TOOL } from '../../config/config-in-host.js';
import { processIdentity } from '../../process/process.js';
import { elicitPartner } from '../../broker/pairing/pair-elicitation.js';
import { CHECKPOINT_TOOL } from '../../broker/recovery/recovery.js';
import { READ_MESSAGES_TOOL, readMessagesSchema } from '../../broker/delivery/message-history.js';
import { disabledMember, memberOffResultFor, MEMBER_CONTROL_TOOL, type MemberContext } from '../../broker/member-control.js';
import { classifyCodexPermission, codexMetadataEvidence } from '../../hosts/codex/codex-permission.js';
import { RECOVER_PARTNER_TOOL, recoverPartnerSchema } from '../../broker/recovery/managed-recovery.js';
import { PARTNER_PROFILE_TOOL, modelProfileSchema } from '../../broker/profiles/partner-profile.js';
import { CODEX_HOOK_TOOL, McpHook } from '../hooks/mcp-hook.js';

export const MESSAGE_TOOLS=[
  PARTNER_PROFILE_TOOL,
  RECOVER_PARTNER_TOOL,
  MEMBER_CONTROL_TOOL,
  READ_MESSAGES_TOOL,
                                   
  {name:'send_message',description:'msg partner; returns once saved, doesnt wait read/reply; saved msgs need no resend/polling, replies/alerts come via nxbridge delivery',inputSchema:{type:'object' as const,properties:{message:{type:'string'},reply_expected:{type:'boolean',description:'true for a task/question that needs a reply; omitted/false for reports or FYI'},in_reply_to:{type:'string',description:'id of the partner msg this one answers or finishes; omit for a new topic'}},required:['message'],additionalProperties:false},annotations:{readOnlyHint:false,destructiveHint:false,openWorldHint:false}},
                                    
  {name:'status',description:'partner/link state + needs-human flags; doesnt wake partner',inputSchema:{type:'object' as const,properties:{},additionalProperties:false},annotations:{readOnlyHint:true,openWorldHint:false}},
                                                    
  {name:'receive_messages',description:'fetch pending partner msgs; call when an nxbridge notice says msgs await pickup; otherwise msgs arrive on their own, no polling',inputSchema:{type:'object' as const,properties:{},additionalProperties:false},annotations:{readOnlyHint:false,destructiveHint:false,openWorldHint:false}},
  {name:'choose_partner',description:'open native partner picker when user wants to pair, switch, or unpair; user chooses; does not commit a choice automatically',inputSchema:{type:'object' as const,properties:{},additionalProperties:false},annotations:{readOnlyHint:false,destructiveHint:false,openWorldHint:false}},
                                                                                                                                          
  {name:'select_partner',description:'commit user\'s explicit partner choice only; never choose yourself. pass selection_id + key (choose), or action: create/adopt/wait/unpair/cancel. create may include model + effort for new owned partner',inputSchema:{type:'object' as const,properties:{selection_id:{type:'string'},key:{type:'string'},action:{type:'string',enum:['choose','create','adopt','wait','unpair','cancel']},model:{type:'string'},effort:{anyOf:[{type:'string'},{type:'number',minimum:0}]}},required:['selection_id'],additionalProperties:false},annotations:{readOnlyHint:false,destructiveHint:false,openWorldHint:false}},
];

export function codexIdentity(meta:Record<string,unknown>,cwd=process.cwd(),runtime:{pid:number;procStart:string;appServer?:boolean;managedDaemon?:boolean}={pid:process.ppid,procStart:''}):{actor:Actor;registration:RegisterInput}{
  if(typeof meta.threadId!=='string'||!meta.threadId)throw new BridgeError('unverified_identity','宿主未提供有效的 Codex threadId。');
  const threadId=meta.threadId,sessionId=typeof meta.sessionId==='string'&&meta.sessionId?meta.sessionId:undefined;
  const details=(meta['x-codex-turn-metadata']??{}) as Record<string,unknown>;
  const evidence=codexMetadataEvidence(details),permission=classifyCodexPermission(evidence);
  return{actor:{host:'codex',sessionId:threadId,callId:typeof meta.callId==='string'?meta.callId:randomUUID(),...(sessionId&&threadId!==sessionId?{via:threadId}:{}),...(typeof meta.turnId==='string'?{turnId:meta.turnId}:{})},registration:{host:'codex',sessionId:threadId,cwd,name:'Codex',kind:threadId===sessionId?'root':'unknown',permission,replyContract:1,endpoint:{mode:'embedded',address:'',epoch:`embedded:${runtime.pid}:${runtime.procStart}:${threadId}`,pid:runtime.pid,procStart:runtime.procStart,configHome:codexHome(),processKind:runtime.appServer?'app-server':'foreground',codexPermission:evidence,...(runtime.managedDaemon?{daemon:{address:'',...evidence}}:{})}}};
}

                                                    
export function registerMcpIdentity<T=any>(connection:Pick<BrokerSession,'request'>,method:'register'|'mcp.register',input:unknown):Promise<T>{return connection.request<T>(method,input,{timeout:45000});}

                                                         
export function codexPartnerActor(actor:Actor,registered:{id:string;kind?:Peer['kind'];binding?:Actor['binding']}):Actor{
  if(registered.kind==='subagent'||registered.kind==='unknown'&&actor.via)throw new BridgeError('subagent_denied','Codex 子代理只能向父代理汇报，由独立主会话调用 Claude 搭档工具。');
  if(!registered.kind||!['root','fork'].includes(registered.kind))throw new BridgeError('unverified_identity','尚未核验独立 Codex 主会话身份，不能调用搭档工具。');
  const {via,...independent}=actor;
  return{...independent,memberId:registered.id,...(registered.binding?{binding:registered.binding}:{})};
}

export async function serveMcp(host:Host,options:{connection?:BrokerSession;transport?:Transport;codexRuntime?:ReturnType<typeof codexProcessIdentity>}={}):Promise<Server>{
  const server=new Server({name:host==='codex'?'claude':'codex',version:VERSION},{capabilities:{tools:{}},instructions:host==='codex'?CODEX_PARTNER_INSTRUCTIONS:CLAUDE_PARTNER_INSTRUCTIONS});
  let closing=false;
  const connection=options.connection??new BrokerSession();
  const hooks=new McpHook(connection),hookReceipts=new Map<string|number,string>();
  const brokerCall=<T=any>(method:string,params:unknown={},options:{timeout?:number;mutation?:boolean}={})=>connection.request<T>(method,params,options);
  let codexRuntime=options.codexRuntime;
  let bridgeRuntime:Promise<{pid:number;procStart:string}>|undefined;
  const bridgeIdentity=()=>bridgeRuntime??=processIdentity(process.pid).then(native=>({pid:native.pid,procStart:native.startedAt}));
  let startupRegistered=host!=='codex',starting:Promise<void>|undefined,locallyDisabled=false;
  let localContext:MemberContext|undefined;
  const registerStartup=()=>starting??=(async()=>{
    try{
      const native=await(codexRuntime??=codexProcessIdentity());
      localContext={host,...native,sessionId:native.resumeSessionId,configHome:codexHome()};
      if(disabledMember(bridgeHome(),localContext)){locallyDisabled=true;startupRegistered=true;return;}
      if(!native.appServer)await brokerCall('window.pending',{window:{host:'codex',configHome:codexHome(),pid:native.pid,procStart:native.procStart},cwd:process.cwd(),...(native.resumeSessionId?{sessionId:native.resumeSessionId}:{}),bridge:await bridgeIdentity()},{mutation:true});
      startupRegistered=true;
    }catch(error){codexRuntime=undefined;process.stderr.write('nxbridge 启动窗口登记：'+(error instanceof Error?error.message:String(error))+'\n');}
  })().finally(()=>{starting=undefined;});
  if(!startupRegistered)await registerStartup();
  const captured=new Set<string>();
  const capture=async(sessionId:string,native:{pid:number;procStart:string})=>{
    if(captured.has(sessionId))return;captured.add(sessionId);
    try{await brokerCall('launch.capture',await currentLaunchCapture(host,sessionId,native));}
    catch(error){process.stderr.write('nxbridge 启动环境登记：'+(error instanceof Error?error.message:String(error))+'\n');}
  };
                                          
  if(host==='claude')try{const identity=await claudeIdentity(),address=process.env.CLAUDE_CODE_MESSAGING_SOCKET;localContext={host,sessionId:identity.record.sessionId,pid:identity.pid,procStart:identity.native.startedAt};locallyDisabled=!!disabledMember(bridgeHome(),localContext);if(address&&!locallyDisabled){const registration=claudeRegistration(identity,address,false);registration.replyContract=1;registration.endpoint.bridge=await bridgeIdentity();await brokerCall('register',registration,{timeout:15000});}}catch{}
  let reconnect:NodeJS.Timeout|undefined,maintenance:Promise<void>|undefined,retries=0;
  const schedule=()=>{if(closing||reconnect||maintenance)return;reconnect=setTimeout(()=>{reconnect=undefined;void maintain();},Math.min(30000,1000*2**Math.min(retries++,5)));reconnect.unref();};
  const maintain=()=>maintenance??=(async()=>{if(localContext)locallyDisabled=!!disabledMember(bridgeHome(),localContext);if(locallyDisabled)return;try{await connection.connect();if(!startupRegistered)await registerStartup();if(startupRegistered)retries=0;}catch{}})().finally(()=>{maintenance=undefined;if(!closing&&!locallyDisabled&&(!connection.connected||!startupRegistered))schedule();});
  connection.on('disconnected',()=>{startupRegistered=host!=='codex';schedule();});void maintain();
  server.setRequestHandler(ListToolsRequestSchema,async()=>({tools:host==='codex'?[...MESSAGE_TOOLS,ASK_TOOL,ANSWER_TOOL,CONFIGURATION_TOOL,CHECKPOINT_TOOL]:[...MESSAGE_TOOLS,CONFIGURATION_TOOL,CHECKPOINT_TOOL]}));
  server.setRequestHandler(CallToolRequestSchema,async(request,extra)=>{
    try{
      if(request.params.name===CODEX_HOOK_TOOL){
        if(host!=='codex')throw new BridgeError('unknown_tool','此隐藏入口仅供 Codex hook 使用。');
        const output=await hooks.run(request.params.arguments,(request.params._meta??{}) as Record<string,unknown>,extra.requestId,hookReceipts,extra.signal);
        return{content:[{type:'text' as const,text:JSON.stringify(output)}]};
      }
      if(request.params.name==='set_enabled'&&(request.params.arguments as {enabled?:boolean}|undefined)?.enabled===true)throw new BridgeError('member_enable_human_required','开启必须由用户亲自输入 nxbridge on（Claude 使用 /nxbridge on），或在独立终端运行 nxbridge on <宿主> --member <成员 ID>。');
      let actor:Actor;
      if(host==='codex'){
        const boundaryStartedAt=Date.now(),identity=codexIdentity((request.params._meta??{}) as Record<string,unknown>,process.cwd(),await(codexRuntime??=codexProcessIdentity()));
        const disabled=disabledMember(bridgeHome(),{host,sessionId:identity.actor.sessionId,...await codexRuntime!,configHome:codexHome()});
        localContext={host,sessionId:identity.actor.sessionId,...await codexRuntime!,configHome:codexHome()};
        if(disabled){
                                     
          codexPartnerActor(identity.actor,{id:disabled.peerId,kind:identity.registration.kind});
          locallyDisabled=true;if(request.params.name!=='status')return{content:[{type:'text' as const,text:JSON.stringify(memberOffResultFor({host,id:disabled.peerId}))}]};
          actor={...identity.actor,memberId:disabled.peerId,sessionId:disabled.sessionId!};
        }else{
        locallyDisabled=false;
        identity.registration.boundaryStartedAt=boundaryStartedAt;
        identity.registration.endpoint.bridge=await bridgeIdentity();
                                                
        const registered=await registerMcpIdentity<{id:string;enabled?:boolean;kind?:Peer['kind'];binding?:Actor['binding']}>(connection,'mcp.register',identity.registration);actor=codexPartnerActor(identity.actor,registered);if(registered.enabled===false)return{content:[{type:'text' as const,text:JSON.stringify(memberOffResultFor({host,id:registered.id}))}]};await capture(actor.sessionId,await codexRuntime!);
        }
      }else{
        const identity=await claudeIdentity(),address=process.env.CLAUDE_CODE_MESSAGING_SOCKET;
        localContext={host,sessionId:identity.record.sessionId,pid:identity.pid,procStart:identity.native.startedAt};
        const disabled=disabledMember(bridgeHome(),localContext);
        if(disabled){locallyDisabled=true;if(request.params.name!=='status')return{content:[{type:'text' as const,text:JSON.stringify(memberOffResultFor({host,id:disabled.peerId}))}]};actor={host,sessionId:disabled.sessionId!,memberId:disabled.peerId,callId:randomUUID()};}
        else{
        locallyDisabled=false;
        if(!address)throw new BridgeError('inbox_unavailable','当前 Claude 会话未暴露 peer inbox。');
        const registration=claudeRegistration(identity,address,false);registration.replyContract=1;registration.endpoint.bridge=await bridgeIdentity();
        const registered=await registerMcpIdentity<{id:string;binding?:Actor['binding']}>(connection,'register',{...registration,mcpInteraction:true});
        await capture(identity.record.sessionId,{pid:identity.pid,procStart:identity.native.startedAt});
        actor={host:'claude',memberId:registered.id,sessionId:identity.record.sessionId,callId:typeof request.params._meta?.callId==='string'?request.params._meta.callId:randomUUID(),...(registered.binding?{binding:registered.binding}:{})};
        }
      }
      let value:unknown;
      switch(request.params.name){
        case'set_enabled':{const args=z.object({target:z.enum(['self','partner']),enabled:z.boolean(),user_requested:z.literal(true)}).strict().parse(request.params.arguments);value=await brokerCall('member.switch',{actor,...args},{mutation:true});if(args.target==='self'&&args.enabled)locallyDisabled=false;break;}
        case'read_messages':value=await brokerCall('messages.read',{actor,...readMessagesSchema.parse(request.params.arguments)});break;
        case'checkpoint':value=await brokerCall('checkpoint',{actor,input:request.params.arguments},{mutation:true});break;
        case'recover_partner':{const input=recoverPartnerSchema.parse(request.params.arguments??{});value=await brokerCall('partner.recover',{actor,...input},{mutation:input.action==='retry',timeout:45000});break;}
        case'config':value=await brokerCall('config.model',{actor,input:request.params.arguments},{mutation:true});break;
        case'ask':{if(host!=='codex')throw new BridgeError('unknown_tool','Claude 通过 Mod 路由原生提问。');const args=codexAskSchema.parse(request.params.arguments);value=await brokerCall('question.create',{actor,...args},{mutation:true});break;}
        case'answer_question':{if(host!=='codex')throw new BridgeError('unknown_tool','Claude 使用 Mod 注册的答题工具。');value=await brokerCall('question.answer',{actor,input:request.params.arguments},{mutation:true});break;}
        case'send_message':{const args=z.object({message:z.string().min(1),in_reply_to:z.string().optional(),reply_expected:z.boolean().optional()}).strict().parse(request.params.arguments);value=await brokerCall('send',{actor,...args},{mutation:true});if(host==='codex')value=await elicitPartner(server,value,(method,params)=>brokerCall(method,{actor,...params},{mutation:['pair.selection.commit','pair.selection.resolve'].includes(method)}),{signal:extra.signal,relatedRequestId:extra.requestId,timeout:600000});break;}
        case'choose_partner':{z.object({}).strict().parse(request.params.arguments??{});value=await brokerCall('pair.code',{actor},{mutation:true});if(host==='codex')value=await elicitPartner(server,value,(method,params)=>brokerCall(method,{actor,...params},{mutation:['pair.selection.commit','pair.selection.resolve'].includes(method)}),{signal:extra.signal,relatedRequestId:extra.requestId,timeout:600000});break;}
        case'select_partner':{const args=z.object({selection_id:z.string(),key:z.string().optional(),action:z.enum(['choose','create','adopt','wait','unpair','cancel']).optional(),...modelProfileSchema.shape}).strict().parse(request.params.arguments);value=await brokerCall('pair.selection.commit',{actor,...args},{mutation:true});break;}
        case'partner_profile':{const args=modelProfileSchema.extend({action:z.enum(['get','set','reset']).default('get')}).strict().parse(request.params.arguments??{});value=await brokerCall('partner.profile',{actor,...args},{mutation:args.action!=='get'});break;}
        case'status':z.object({}).strict().parse(request.params.arguments??{});value=await brokerCall('status',{actor,model_view:true});break;
        case'receive_messages':z.object({}).strict().parse(request.params.arguments??{});value=await brokerCall('receive',actor,{mutation:true});break;
        default:throw new BridgeError('unknown_tool','未知的搭档工具。');
      }
      if(host==='codex'&&['status','send_message','checkpoint'].includes(request.params.name)){
        const metadata=request.params._meta?.['x-codex-turn-metadata'] as {turn_id?:unknown}|undefined;
        const hint=await brokerCall<Record<string,unknown>>('messages.pending-hint',{...actor,hint_deadline:Date.now()+450,...(typeof metadata?.turn_id==='string'?{turnId:metadata.turn_id}:{})},{timeout:500}).catch(error=>{process.stderr.write('nxbridge pending hint: '+String(error)+'\n');return{};});
        if(Object.keys(hint).length&&value&&typeof value==='object')value={...value,...hint};
      }
      return{content:[{type:'text' as const,text:JSON.stringify(value)}]};
    }catch(error){
      if(!(error instanceof BridgeError)&&!(error instanceof z.ZodError))process.stderr.write(JSON.stringify({type:'mcp.error',tool:request.params.name,error:error instanceof Error?error.stack:String(error)})+'\n');
      return{isError:true,content:[{type:'text' as const,text:JSON.stringify(modelError(error))}]};
    }
  });
  const transport=options.transport??new StdioServerTransport(),onEnd=()=>{void server.close();};
  const send=transport.send.bind(transport);
  transport.send=async(message,sendOptions)=>{
    try{
      await send(message,sendOptions);
      if('id'in message&&message.id!==undefined){const receipt=hookReceipts.get(message.id);hookReceipts.delete(message.id);if(receipt&&'result'in message)hooks.acknowledge(receipt);}
    }catch(error){if('id'in message&&message.id!==undefined)hookReceipts.delete(message.id);throw error;}
  };
  if(!options.transport)process.stdin.once('end',onEnd);
  server.onclose=()=>{closing=true;clearTimeout(reconnect);hooks.close();hookReceipts.clear();connection.close();process.stdin.off('end',onEnd);};
  await server.connect(transport);
  return server;
}
