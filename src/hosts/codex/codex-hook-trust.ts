import { statSync } from 'node:fs';
import path from 'node:path';
import { configClient } from './stdio-codex.js';
import type { BridgeConfig, Peer } from '../../types.js';
import { partnerRestartAdvice } from '../../app/commands/agent-command.js';

export type HookTrust='trusted'|'required'|'unknown';
export type HookTrustIssue='hooks_trust_required'|'hooks_restart_required';
export const hookApprovalRequired=(error:string)=>/plugin contents changed;\s*hook approval required/i.test(error);

export function hookTrustMessage(peer:Pick<Peer,'id'|'owner'>,issue:HookTrustIssue,human=false,home?:string):string{
  if(issue==='hooks_trust_required')return human
    ?'Codex 的 nxbridge hooks 需要重新信任：在使用该配置目录的 Codex 窗口里打开 /hooks，信任 nxbridge。'
    :'nxbridge hooks need re-trust: user opens /hooks in a Codex window using this config dir and trusts nxbridge; tell user';
  if(peer.owner==='nxbridge')return human
    ?`Codex 已信任新版 hooks，但这个后台会话仍使用旧定义或信任快照；搭档 Claude 会在它空闲时自动重启。要马上处理，可等它空闲后在 Codex 之外的终端运行 nxbridge restart codex --member ${peer.id}。`
    :`hooks trusted on disk but this Codex session still runs old definitions/trust snapshot; ${partnerRestartAdvice(home)}`;
  return human
    ?'Codex 已信任新版 hooks，但该会话仍使用旧定义或信任快照；请等它空闲后退出并按原会话 ID 恢复，或重新打开该 Codex 会话。'
    :'hooks trusted on disk but this Codex session still runs old definitions/trust snapshot; when idle, user exits and resumes the same session id (or reopens it); tell user';
}

interface NativeHook {pluginId?:string;enabled?:boolean;trustStatus?:string;currentHash?:string}
export function hookTrustFromList(hooks:NativeHook[]):HookTrust{
  const own=hooks.filter(hook=>hook.pluginId==='nxbridge@nxbridge-local'&&hook.enabled!==false);
  if(own.some(hook=>hook.trustStatus==='untrusted'||hook.trustStatus==='modified'))return'required';
  return own.length&&own.every(hook=>hook.trustStatus==='trusted'||hook.trustStatus==='managed')?'trusted':'unknown';
}

                                                        
export async function readCodexHookTrust(config:BridgeConfig,home:string,configHome:string,cwd:string):Promise<HookTrust>{
  const client=await configClient({...config,codexHome:configHome},home);
  try{
    const result=await client.request('hooks/list',{cwds:[cwd]},{timeout:5000});
    return hookTrustFromList((result.data??[]).flatMap((row:{hooks?:NativeHook[]})=>row.hooks??[]));
  }finally{await client.close();}
}

const stamp=(home:string)=>{
  try{const value=statSync(path.join(home,'config.toml'));return value.mtimeMs+':'+value.size;}
  catch(error){return(error as NodeJS.ErrnoException).code==='ENOENT'?'missing':undefined;}
};

                                              
export class CodexHookTrust {
  private checks=new Map<string,{stamp:string|undefined;at:number;pending:boolean;work:Promise<HookTrust>}>();
  constructor(private read:(configHome:string,cwd:string)=>Promise<HookTrust>){}
  check(configHome:string,cwd:string):Promise<HookTrust>{
    const key=JSON.stringify([path.resolve(configHome),path.resolve(cwd)]),current=stamp(configHome),previous=this.checks.get(key);
    if(current===undefined)return Promise.resolve('unknown');
    if(previous&&(previous.pending||current!==undefined&&previous.stamp===current&&Date.now()-previous.at<60000))return previous.work;
    const entry={stamp:current,at:Date.now(),pending:true,work:undefined as unknown as Promise<HookTrust>};
    entry.work=Promise.resolve().then(()=>this.read(configHome,cwd)).then(result=>stamp(configHome)===current?result:'unknown').catch(()=>'unknown' as const).finally(()=>{entry.pending=false;});
    this.checks.set(key,entry);return entry.work;
  }
}
