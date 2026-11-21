import { randomBytes, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { configurationField, configValue, normalizeConfiguration } from './config-schema.js';
import { commitConfiguration, configurationStatus, prepareConfiguration, redactConfigValue, type ConfigurationEdit, type PreparedConfiguration } from './configuration.js';
import {BridgeError} from '../shared/errors.js';
import {type Host} from '../types.js';

const key=z.string().min(1),edit=z.object({key,value:z.unknown().optional()}).strict();
export const modelConfigurationSchema=z.discriminatedUnion('action',[
  z.object({action:z.literal('list')}).strict(),
  z.object({action:z.literal('get'),key}).strict(),
  z.object({action:z.literal('set'),key,value:z.unknown()}).strict(),
  z.object({action:z.literal('unset'),key}).strict(),
  z.object({action:z.literal('propose'),edits:z.array(edit).min(1).max(50)}).strict(),
]);
                                                   
export const CONFIGURATION_TOOL={name:'config',description:'read nxbridge config; set/unset safe keys; sensitive change -> exact proposal; user types native config pending cmd (shows hidden confirm code), confirms in same window. never confirm via model/tool/message. cannot change Codex approval or sandbox settings',inputSchema:{type:'object' as const,properties:{action:{type:'string',enum:['list','get','set','unset','propose']},key:{type:'string'},value:{},edits:{type:'array',minItems:1,maxItems:50,items:{type:'object',properties:{key:{type:'string'},value:{}},required:['key'],additionalProperties:false}}},required:['action'],additionalProperties:false},annotations:{readOnlyHint:false,destructiveHint:false,openWorldHint:false}};

export interface ConfigurationSession {host:Host;sessionId:string;window:string;name?:string;cwd?:string}
interface Proposal {id:string;token:string;session:ConfigurationSession;expiresAt:number;prepared:PreparedConfiguration;diff:unknown[]}
const NOTICE='保存成功，协调器已读取新配置；受此配置阻止的恢复会重新核验，启动项对后续启动生效。';
const sameSession=(a:ConfigurationSession,b:ConfigurationSession)=>a.host===b.host&&a.sessionId===b.sessionId&&a.window===b.window;

export class InHostConfiguration {
  private proposals=new Map<string,Proposal>();
  constructor(readonly home:string,private now=Date.now,private changed:()=>void=()=>{},private event:(name:string,data:Record<string,unknown>)=>void=()=>{}){}
  private audit<T>(action:string,session:ConfigurationSession,work:()=>T):T{
    const context={host:session.host,sessionId:session.sessionId,window:session.window,action};
    try{const result=work();this.event('config.'+action,{...context,outcome:'ok'});return result;}
    catch(error){this.event('config.'+action,{...context,outcome:'refused',code:(error as {code?:string}).code??'config_failed'});throw error;}
  }
  private commit(prepared:PreparedConfiguration,origin:Parameters<typeof commitConfiguration>[1]){
    const result=commitConfiguration(prepared,origin);if(result.changed)this.changed();return{...result,notice:NOTICE};
  }
  private sweep():void{for(const [token,proposal]of this.proposals)if(proposal.expiresAt<=this.now()){this.proposals.delete(token);this.event('config.proposal.expired',{proposalId:proposal.id,host:proposal.session.host,sessionId:proposal.session.sessionId});}}
  cancel(session:Pick<ConfigurationSession,'host'|'sessionId'>):void{for(const [token,proposal]of this.proposals)if(proposal.session.host===session.host&&proposal.session.sessionId===session.sessionId)this.proposals.delete(token);}
  model(session:ConfigurationSession,input:unknown):unknown{
    return this.audit('model',session,()=>this.modelRequest(session,input));
  }
  private modelRequest(session:ConfigurationSession,input:unknown):unknown{
    this.sweep();const request=modelConfigurationSchema.parse(input);
    if(request.action==='list')return configurationStatus(this.home);
    if(request.action==='get'){configurationField(request.key);return configurationStatus(this.home).entries.find(entry=>entry.key===request.key);}
    const edits=request.action==='propose'?request.edits:[{key:request.key,...(request.action==='set'?{value:request.value}:{})}];
    const prepared=prepareConfiguration(this.home,edits);
    if(request.action!=='propose'&&edits.every(edit=>configurationField(edit.key).safe))return this.commit(prepared,`${session.host}-model`);
    this.cancel(session);
    const before=prepared.current.config,after=normalizeConfiguration(prepared.document,key=>key).config;
    const diff=prepared.keys.map(key=>{const field=configurationField(key),value=configValue(prepared.document,key);return{key,operation:value===undefined?'unset':'set',before:redactConfigValue(key,configValue(before,field.internal)),after:redactConfigValue(key,configValue(after,field.internal)),managedValue:redactConfigValue(key,value)};});
                                          
    const token=randomBytes(8).toString('hex'),proposal={id:randomUUID(),token,session:{...session},expiresAt:this.now()+600_000,prepared,diff};this.proposals.set(token,proposal);
    this.event('config.proposal.created',{proposalId:proposal.id,host:session.host,sessionId:session.sessionId,window:session.window,keys:prepared.keys,expiresAt:proposal.expiresAt});
                                                         
    return{status:'needs_confirmation',proposal_id:proposal.id,expiresAt:proposal.expiresAt,window:{host:session.host,name:session.name,sessionId:session.sessionId,cwd:session.cwd},diff,review:(session.host==='claude'?'/':'')+'nxbridge config pending',notice:'请由用户在提出提案的原生窗口'+(session.name?'「'+session.name+'」':'')+'输入 review 命令，核对差异并读取仅向人类显示的确认码，然后输入确认行。模型不得代为运行。有效期十分钟；确认保存后立即生效。Codex 需要已加载并受信任的 nxbridge hooks。'};
  }
  pending(session:ConfigurationSession):unknown{
    return this.audit('pending',session,()=>this.pendingRequest(session));
  }
  private pendingRequest(session:ConfigurationSession):unknown{
    this.sweep();const proposal=[...this.proposals.values()].find(proposal=>sameSession(proposal.session,session));
    if(!proposal){
      const others=[...this.proposals.values()].map(value=>'窗口「'+(value.session.name??value.session.sessionId)+'」（'+value.session.host+'，会话 '+value.session.sessionId+(value.session.cwd?'，目录 '+value.session.cwd:'')+'），剩余 '+Math.ceil((value.expiresAt-this.now())/1000)+' 秒，在该窗口输入 '+(value.session.host==='claude'?'/':'')+'nxbridge config pending');
      throw new BridgeError('config_proposal_missing','当前窗口没有待确认的配置提案。'+(others.length?'现有提案在：'+others.join('；')+'。':'提案可能已过期或协调器已重启，请让模型重新提出变更。'));
    }
    return{proposal_id:proposal.id,expiresAt:proposal.expiresAt,diff:proposal.diff,confirmation:(session.host==='claude'?'/':'')+'nxbridge config confirm '+proposal.token,notice:'请核对差异，确认后在本窗口输入上面的确认行。'};
  }
  confirm(session:ConfigurationSession,token:string):unknown{
    return this.audit('confirm',session,()=>this.confirmRequest(session,token));
  }
  private confirmRequest(session:ConfigurationSession,token:string):unknown{
    this.sweep();const proposal=this.proposals.get(token);
    if(!proposal||!sameSession(proposal.session,session))throw new BridgeError('config_confirmation_invalid','确认已过期、已使用，或不属于当前窗口；请重新提出配置变更并核对差异。');
                             
    this.proposals.delete(token);
    return this.commit(proposal.prepared,`${session.host}-user`);
  }
  human(session:ConfigurationSession,args:string[]):unknown{
    return this.audit('human',session,()=>this.humanRequest(session,args));
  }
  private humanRequest(session:ConfigurationSession,args:string[]):unknown{
    const [action,key,input]=args;
    if(!action||action==='list'&&args.length===1)return configurationStatus(this.home);
    if(action==='get'&&key&&args.length===2){configurationField(key);return configurationStatus(this.home).entries.find(entry=>entry.key===key);}
    if(action==='pending'&&args.length===1)return this.pending(session);
    if(action==='confirm'&&key&&/^[a-f0-9]{16}$/.test(key)&&args.length===2)return this.confirm(session,key);
    if((action!=='set'&&action!=='unset')||!key||args.length!==(action==='set'?3:2))throw new BridgeError('invalid_arguments','用法：/nxbridge config [list|get 键名|set 键名 值|unset 键名|pending|confirm 确认码]；命令数组和数值使用 JSON。');
    let value:unknown;if(action==='set')try{value=JSON.parse(input!);}catch{value=input;}
    const edits:ConfigurationEdit[]=[{key,value}],prepared=prepareConfiguration(this.home,edits);this.cancel(session);
    return this.commit(prepared,`${session.host}-user`);
  }
}

export function configurationArguments(text:string):string[]{
                                     
  const match=/^\s*(\S+)(?:\s+(\S+))?(?:\s+([\s\S]*?))?\s*$/.exec(text);
  return match?[match[1]!,...(match[2]?[match[2]]:[]),...(match[3]!==undefined?[match[3]]:[])]:[];
}
