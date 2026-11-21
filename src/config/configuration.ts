import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { atomicWriteText } from '../storage/atomic-file.js';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { stringify } from 'smol-toml';
import {BridgeError} from '../shared/errors.js';
import {type BridgeConfig,type Host} from '../types.js';
import { CONFIG_FIELDS, configurationField, configValue, legacyDocument, normalizeConfiguration, withConfigValue } from './config-schema.js';
import { configLocation, parseConfiguration } from '../storage/toml-document.js';
import { frozenProfileStatus, syncFrozenProfiles } from '../broker/profiles/frozen-profile.js';

export interface ConfigurationDocument {
  filename:string;userFile:string;source:'toml'|'legacy-json'|'default';text:string;userText:string;
  managedExists:boolean;userExists:boolean;legacyText?:string;
  document:Record<string,unknown>;userDocument:Record<string,unknown>;config:BridgeConfig;warnings:string[];
}
export interface ConfigurationEdit {key:string;value?:unknown}
export type ConfigurationOrigin='terminal'|'migration'|'setup'|'claude-user'|'codex-user'|'claude-model'|'codex-model';
export interface PreparedConfiguration {current:ConfigurationDocument;document:Record<string,unknown>;keys:string[];changed:boolean}
const optionalText=(filename:string):string|undefined=>{
  try{return readFileSync(filename,'utf8');}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return undefined;throw error;}
};
const MANAGED_HEADER='# 此文件由 nxbridge 管理，保存时会重新生成格式。\n# 手写配置请放在 config.toml；其中的配置优先，自动工具不会改写该文件。\n# 凭据值放在原生宿主配置或环境中，不要写入这里。\n';
export function readConfiguration(home:string):ConfigurationDocument{
  const filename=path.join(home,'config.managed.toml'),userFile=path.join(home,'config.toml'),legacy=path.join(home,'config.json');
  const managed=optionalText(filename),user=optionalText(userFile),warnings:string[]=[];
  let source:ConfigurationDocument['source']=managed!==undefined||user!==undefined?'toml':'default',legacyText:string|undefined,document:Record<string,unknown>={};
  if(managed!==undefined)document=parseConfiguration(managed,filename);
  if(source!=='toml'&&(legacyText=optionalText(legacy))!==undefined){
    source='legacy-json';let raw:Record<string,unknown>;
    try{raw=JSON.parse(legacyText.replace(/^\ufeff/,''));}catch{throw new BridgeError('invalid_config',`${legacy}:1:1：旧 JSON 配置格式无效；原文件未修改。`);}
    if(!raw||typeof raw!=='object'||Array.isArray(raw))throw new BridgeError('invalid_config',`${legacy}:1:1：旧 JSON 配置必须是对象。`);
    document=legacyDocument(raw);
    warnings.push('正在兼容读取 config.json；下一次明确保存配置或 setup 时迁移到 config.managed.toml，旧文件保留为备份。');
    const known=new Set(CONFIG_FIELDS.map(field=>field.internal.split('.')[0]));
    for(const key of Object.keys(raw))if(!known.has(key))warnings.push(`旧 JSON 中的未知项 ${key} 不参与运行配置；迁移后仍保留在旧文件中。`);
  }else if(source==='toml'&&existsSync(legacy))warnings.push(`${legacy} 仅作为旧配置备份保留；已有 TOML 配置，不合并旧 JSON。`);
  const userDocument=user===undefined?{}:parseConfiguration(user,userFile);
  const active=source==='legacy-json'?legacy:filename;
  const normalized=normalizeConfiguration(document,key=>configLocation(managed??'',key,active));
  const userNormalized=normalizeConfiguration(userDocument,key=>configLocation(user??'',key,userFile));
  let config=normalized.config as unknown as Record<string,unknown>;
  for(const field of CONFIG_FIELDS)if(configValue(userDocument,field.key)!==undefined)config=withConfigValue(config,field.internal,configValue(userNormalized.config,field.internal));
  for(const [items,text,file]of [[normalized.unknown,managed??'',active],[userNormalized.unknown,user??'',userFile]] as const)
    for(const key of items)warnings.push(`${configLocation(text,key,file)}：未知配置项 ${key.map(part=>/^[\w-]+$/.test(part)?part:JSON.stringify(part)).join('.')}，已保留但未使用。`);
  return{filename,userFile,source,text:managed??'',userText:user??'',managedExists:managed!==undefined,userExists:user!==undefined,legacyText,document,userDocument,config:config as unknown as BridgeConfig,warnings};
}
export const loadBridgeConfig=(home:string):BridgeConfig=>readConfiguration(home).config;
function atomicText(filename:string,text:string):void{
  mkdirSync(path.dirname(filename),{recursive:true,mode:0o700});
  atomicWriteText(filename,text);
}
function unchanged(current:ConfigurationDocument):void{
  if(optionalText(current.filename)!==(current.managedExists?current.text:undefined)||optionalText(current.userFile)!==(current.userExists?current.userText:undefined)||current.source==='legacy-json'&&optionalText(path.join(path.dirname(current.filename),'config.json'))!==current.legacyText)
    throw new BridgeError('config_changed','配置在保存前已被另一个进程修改；没有覆盖，请重新查看后再试。');
}
function persist(current:ConfigurationDocument,document:Record<string,unknown>,keys:string[],origin:ConfigurationOrigin){
  const migrated=current.source==='legacy-json';
  unchanged(current);
  atomicText(current.filename,MANAGED_HEADER+stringify(withConfigValue(document,'schema_version',1))+'\n');
  const home=path.dirname(current.filename);syncFrozenProfiles(home,readConfiguration(home).config);
  atomicText(path.join(path.dirname(current.filename),'config-last-change.json'),JSON.stringify({at:Date.now(),origin,keys,migrated},null,2)+'\n');
  return{changed:true,filename:current.filename,keys,migrated};
}
export function ensureConfiguration(home:string):void{
  const current=readConfiguration(home);if(!current.managedExists)persist(current,current.document,[],current.source==='legacy-json'?'migration':'setup');
}
export function writeConfiguration(home:string,edits:ConfigurationEdit[],origin:ConfigurationOrigin):{changed:boolean;filename:string;keys:string[];migrated:boolean}{
  return commitConfiguration(prepareConfiguration(home,edits),origin);
}
export function prepareConfiguration(home:string,edits:ConfigurationEdit[]):PreparedConfiguration{
  const current=readConfiguration(home);let document=current.document;
  for(const edit of edits){
    const field=configurationField(edit.key);
    if(field.immutable)throw new BridgeError('config_key_immutable',`${edit.key} 由配置版本管理，不能用 set/unset 修改。`);
    if(configValue(current.userDocument,edit.key)!==undefined)throw new BridgeError('config_user_override',`${configLocation(current.userText,edit.key,current.userFile)}：${edit.key} 由手写配置覆盖，请手动编辑该文件；自动工具不会改写。`);
    document=withConfigValue(document,edit.key,edit.value);
  }
  normalizeConfiguration(document,key=>configLocation(current.text,key,current.filename));
  return{current,document,keys:[...new Set(edits.map(edit=>edit.key))],changed:!current.managedExists||!isDeepStrictEqual(current.document,document)};
}
export function commitConfiguration(prepared:PreparedConfiguration,origin:ConfigurationOrigin):{changed:boolean;filename:string;keys:string[];migrated:boolean}{
  const {current,document,keys,changed}=prepared;
                                       
  if(!changed){unchanged(current);syncFrozenProfiles(path.dirname(current.filename),current.config);return{changed:false,filename:current.filename,keys:[],migrated:false};}
  return persist(current,document,keys,origin);
}
export function configurationStatus(home:string){
  const current=readConfiguration(home),frozen=frozenProfileStatus(home,current.config),captured=frozen.profiles,last=path.join(home,'config-last-change.json');let lastChange:unknown=null;
  if(existsSync(last))try{
    const raw=JSON.parse(readFileSync(last,'utf8'));
    if(raw&&typeof raw==='object')lastChange={at:typeof raw.at==='number'?raw.at:null,origin:['terminal','migration','setup','claude-user','codex-user','claude-model','codex-model'].includes(raw.origin)?raw.origin:null,keys:Array.isArray(raw.keys)?raw.keys.filter((key:unknown)=>typeof key==='string'&&CONFIG_FIELDS.some(field=>field.key===key)):[],migrated:raw.migrated===true};
  }catch{                             }
  return{file:current.filename,userFile:current.userFile,source:current.source,warnings:[...current.warnings,...frozen.warnings],lastChange,frozen_profiles:captured,entries:CONFIG_FIELDS.map(field=>{
    const user=configValue(current.userDocument,field.key)!==undefined,managed=configValue(current.document,field.key);
    return{key:field.key,value:redactConfigValue(field.key,configValue(current.config,field.internal)),source:user?'user-toml':managed!==undefined?(current.source==='legacy-json'?'legacy-json':'managed-toml'):'default',safe:field.safe,editable:!field.immutable&&!user,...(user&&managed!==undefined?{shadowed:redactConfigValue(field.key,managed)}:{}),...(field.key.endsWith('.profile_source')?{captured:captured[field.key.split('.')[1] as Host]??null}:{})};
  })};
}
export function redactConfigValue(key:string,value:unknown):unknown{
  if(!key.endsWith('.command')||!Array.isArray(value))return value??null;
  return redactCommand(value);
}
export function redactCommand(value:string[]):string[]{
  let redact=false;
  return value.map((argument:string)=>{
    if(redact){redact=false;return'[已隐藏]';}
    if(/^--?(?:api[-_]?key|auth(?:orization)?(?:[-_]?token)?|access[-_]?token|bearer[-_]?token|token|password|secret)(?:=|$)/i.test(argument)){
      if(argument.includes('='))return argument.split('=')[0]+'=[已隐藏]';redact=true;
    }
    return argument;
  });
}
