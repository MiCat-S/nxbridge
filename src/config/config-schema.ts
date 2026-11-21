import { z } from 'zod';
import {BridgeError} from '../shared/errors.js';
import {DEFAULT_CONFIG,DEFAULT_RETENTION} from './defaults.js';
import {type BridgeConfig} from '../types.js';

export interface ConfigField {key:string;internal:string;schema:z.ZodType;expected:string;safe:boolean;immutable?:boolean}
const positive=z.number().int().positive().max(Number.MAX_SAFE_INTEGER),duration=positive.max(2147483647),nonempty=z.string().min(1);
const profileName=z.string().refine(value=>value.trim().length>0);
const field=(key:string,internal:string,schema:z.ZodType,expected:string,safe=false):ConfigField=>({key,internal,schema,expected,safe});
export const CONFIG_FIELDS:ConfigField[]=[
  {...field('schema_version','version',z.literal(1),'1'),immutable:true},
  field('collaboration.implicit','implicit',z.enum(['on-demand','never']),'on-demand 或 never'),
  field('collaboration.compatibility_wake','compatibilityWake',z.enum(['notify','strict']),'notify 或 strict'),
  field('collaboration.subagent_send','subagentSend',z.enum(['allow-verified','deny']),'allow-verified 或 deny'),
  field('collaboration.sync_tip_minutes','syncTipMinutes',z.number().int().nonnegative().max(2147483647),'0～2147483647 的整数分钟，0 关闭',true),
  field('collaboration.context_tip_tokens','contextTipTokens',z.array(positive).max(16).refine(values=>values.every((value,index)=>index===0||value>values[index-1]!)),'最多 16 个严格递增的正整数 token 阈值，空数组关闭上下文提醒',true),
  field('collaboration.idle_notice_minutes','idleNoticeMinutes',z.number().int().nonnegative().max(2147483647),'0～2147483647 的整数分钟，0 关闭',true),
  field('questions.timeout_ms','questionTimeoutMs',duration,'1～2147483647 的整数毫秒',true),
  field('hosts.claude.sdk_user_prompt','claudeSdkUserPrompt',z.boolean(),'true 或 false（默认 false）'),
  ...(['codex','claude'] as const).flatMap(host=>[
    field(`hosts.${host}.binary`,host+'Binary',nonempty,'非空程序路径'),
    field(`hosts.${host}.home`,host+'Home',nonempty,'非空配置目录路径'),
    field(`hosts.${host}.command`,host+'Command',z.tuple([nonempty]).rest(z.string()),'首项非空的字符串数组'),
    field(`partners.${host}.model`,`partnerProfiles.${host}.model`,profileName,'非空的模型名称（宿主接受的名称或别名）'),
    field(`partners.${host}.effort`,`partnerProfiles.${host}.effort`,z.union([profileName,z.number().finite()]),'非空的推理强度名称（如 high）或数值'),
    field(`partners.${host}.profile_source`,`partnerProfiles.${host}.source`,z.enum(['host','frozen']),'host 或 frozen'),
  ]),
  field('hosts.codex.endpoint','codexEndpoint',nonempty,'非空端点地址'),
  field('hosts.codex.auth_token_env','codexAuthTokenEnv',z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/),'保存凭据的环境变量名'),
  ...Object.keys(DEFAULT_RETENTION).map(key=>field('retention.'+key.replace(/[A-Z]/g,value=>'_'+value.toLowerCase()),'retention.'+key,key==='logBackups'?positive.max(10):key==='maintenanceIntervalMs'?duration:positive,key==='logBackups'?'1～10 的整数':'正整数',true)),
];
export const configValue=(value:unknown,key:string):unknown=>key.split('.').reduce<unknown>((parent,part)=>parent&&typeof parent==='object'&&!Array.isArray(parent)&&Object.hasOwn(parent,part)?(parent as Record<string,unknown>)[part]:undefined,value);
export function withConfigValue(document:Record<string,unknown>,key:string,value:unknown):Record<string,unknown>{
  if(value===undefined&&configValue(document,key)===undefined)return document;
  const copy=(item:Record<string,unknown>)=>Object.setPrototypeOf({...item},Object.getPrototypeOf(item)) as Record<string,unknown>;
  const result=copy(document),parts=key.split('.');let current=result;
  for(const part of parts.slice(0,-1)){current[part]=copy(current[part] as Record<string,unknown>??{});current=current[part] as Record<string,unknown>;}
  if(value===undefined)delete current[parts.at(-1)!];else current[parts.at(-1)!]=value;
  return result;
}
export function configurationField(key:string):ConfigField{
  const value=CONFIG_FIELDS.find(field=>field.key===key);if(!value)throw new BridgeError('config_key_unknown',`未知配置项 ${key}；用 nxbridge config list 查看可用键名。`);return value;
}
export function legacyDocument(value:Record<string,unknown>):Record<string,unknown>{
  for(const prefix of ['retention','partnerProfiles','partnerProfiles.codex','partnerProfiles.claude']){
    const item=configValue(value,prefix);
    if(item!==undefined&&(!item||typeof item!=='object'||Array.isArray(item)))throw new BridgeError('invalid_config',`${prefix} 必须是配置对象；旧 JSON 未修改。`);
  }
  let document:Record<string,unknown>={};for(const field of CONFIG_FIELDS){const item=configValue(value,field.internal);if(item!==undefined)document=withConfigValue(document,field.key,item);}return document;
}
export function normalizeConfiguration(document:Record<string,unknown>,where:(key:string)=>string):{config:BridgeConfig;unknown:string[][]}{
  let config:Record<string,unknown>={...DEFAULT_CONFIG,retention:{...DEFAULT_RETENTION}};
  for(const field of CONFIG_FIELDS){
    for(const prefix of field.key.split('.').slice(0,-1).map((_,index)=>field.key.split('.').slice(0,index+1).join('.'))){const value=configValue(document,prefix);if(value!==undefined&&(!value||typeof value!=='object'||Array.isArray(value)||value instanceof Date))throw new BridgeError('invalid_config',`${where(prefix)}：${prefix} 必须是 TOML 表。`);}
    const value=configValue(document,field.key);if(value===undefined)continue;
    const checked=field.schema.safeParse(value);if(!checked.success)throw new BridgeError('invalid_config',`${where(field.key)}：${field.key} 应为${field.expected}。`);
    config=withConfigValue(config,field.internal,checked.data);
  }
  const unknown:string[][]=[];
  const matches=(field:ConfigField,parts:string[])=>parts.every((part,index)=>field.key.split('.')[index]===part);
  const walk=(value:Record<string,unknown>,prefix:string[]=[])=>{for(const [key,item]of Object.entries(value)){const parts=[...prefix,key];if(CONFIG_FIELDS.some(field=>matches(field,parts)&&field.key.split('.').length===parts.length))continue;if(CONFIG_FIELDS.some(field=>matches(field,parts))&&item&&typeof item==='object'&&!Array.isArray(item)&&!(item instanceof Date))walk(item as Record<string,unknown>,parts);else unknown.push(parts);}};walk(document);
  return{config:config as unknown as BridgeConfig,unknown};
}
