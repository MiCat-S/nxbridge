import { configurationField } from '../../config/config-schema.js';
import { configurationStatus, writeConfiguration } from '../../config/configuration.js';
import type { processAncestry } from '../../process/process.js';
import { brokerCall } from '../../ipc/ipc.js';
import {BridgeError} from '../../shared/errors.js';
import { externalTerminalOrigin, requireExternalTerminal, type TerminalOrigin } from '../../hosts/user-origin.js';

interface TerminalContext {origin?:TerminalOrigin;ancestry:typeof processAncestry}
export async function requireConfigurationTerminal(context?:TerminalContext):Promise<void>{
  try{await requireExternalTerminal(context?context.origin:await externalTerminalOrigin(),context?.ancestry);}
  catch{throw new BridgeError('config_terminal_required','请在 Claude/Codex 之外的独立交互终端（包括 VS Code 终端）运行此 CLI 写命令。宿主内可使用 config 工具（敏感项返回人工确认行），或在 Claude 原生输入框运行 /nxbridge config；也可手动编辑 config.toml 后运行 nxbridge reload。');}
}
export async function configurationCommand(home:string,args:string[],terminalContext?:TerminalContext):Promise<unknown>{
  const [action,key,input]=args;
  const usage=()=>new BridgeError('invalid_arguments','用法：nxbridge config list；config get <键名>；config set <键名> <值>；config unset <键名>。数值和命令数组使用 JSON，字符串可直接传入。');
  if(action==='--help'&&args.length===1)return{usage:usage().message,files:'自动保存写 config.managed.toml，手写 config.toml 优先。',notice:'CLI 写入仅支持独立交互终端；宿主内使用 config 工具或 Claude /nxbridge config，敏感提案由用户在原生窗口输入确认行。'};
  if(action==='list'&&args.length===1)return configurationStatus(home);
  if(action==='get'&&args.length===2&&key){configurationField(key);const status=configurationStatus(home);return{file:status.file,userFile:status.userFile,warnings:status.warnings,...status.entries.find(entry=>entry.key===key),...(key.startsWith('partners.')&&Object.keys(status.frozen_profiles??{}).length?{frozen_profiles:status.frozen_profiles}:{})};}
  if((action!=='set'&&action!=='unset')||!key||args.length!==(action==='set'?3:2))throw usage();
  await requireConfigurationTerminal(terminalContext);
  let value:unknown;
  if(action==='set'){try{value=JSON.parse(input!);}catch{value=input;}}
  const result=writeConfiguration(home,[{key,value}],'terminal');
  let applied=false;
  try{await brokerCall('reload',{}, {home,start:false,mutation:true,timeout:2000});applied=true;}catch{                                   }
  return{...result,entry:configurationStatus(home).entries.find(entry=>entry.key===key),applied,notice:applied?'保存成功，协调器已读取新配置，受此配置阻止的恢复会重新核验；启动项对后续启动生效。':'保存成功；未能连接当前协调器。下次启动会读取新配置，也可运行 nxbridge reload；启动项对后续启动生效。'};
}
