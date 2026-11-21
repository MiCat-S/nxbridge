import path from 'node:path';
import { existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import {atomicJson,readJson} from '../shared/files.js';
import {BridgeError} from '../shared/errors.js';

interface BackgroundState {revision:string;failure?:string;retryContext?:{key:string;until:number}}
const failures=new Map<string,{until:number;failure:string}>();
export const BACKGROUND_RETRY_DELAY_MS=30000;
const file=(home:string)=>path.join(home,'run','background-state.json');
export function backgroundState(home:string):BackgroundState|undefined{return existsSync(file(home))?readJson<BackgroundState>(file(home)):undefined;}
export function deferBackgroundRetry(home:string,failure:string):void{
  failures.set(path.resolve(home),{until:performance.now()+BACKGROUND_RETRY_DELAY_MS,failure});
  while(failures.size>32)failures.delete(failures.keys().next().value!);
}
export function backgroundRetryContext(origin:{pid:number;startedAt:string;name:string}[]):string|undefined{
  const host=origin.find(value=>/^(?:codex|claude)(?:\.exe(?:\.old\.\d+)?)?$/i.test(value.name));
  return host?host.pid+':'+host.startedAt:undefined;
}
export function recordBackgroundState(home:string,failure?:string,context?:string):void{
  if(failure)deferBackgroundRetry(home,failure);else failures.delete(path.resolve(home));
  atomicJson(file(home),{revision:randomUUID(),...(failure?{failure,...(context?{retryContext:{key:context,until:Date.now()+BACKGROUND_RETRY_DELAY_MS}}:{})}:{})});
}
export function requireBackgroundRetry(home:string,explicit=false,context?:string):void{
  if(explicit)return;
                                           
  const key=path.resolve(home),failed=failures.get(key);let failure:string|undefined;
  if(failed){if(performance.now()>=failed.until)failures.delete(key);else failure=failed.failure;}
  if(!failure&&context){
    const state=backgroundState(home),retry=state?.retryContext,remaining=retry?retry.until-Date.now():0;
    if(retry?.key===context&&remaining>0&&remaining<=BACKGROUND_RETRY_DELAY_MS)failure=state?.failure;
  }
  if(failure)throw new BridgeError('bootstrap_required','本调用环境最近启动未通过，三十秒内未重复尝试；可从普通 PowerShell 运行 nxbridge bootstrap。原因：'+failure);
}
