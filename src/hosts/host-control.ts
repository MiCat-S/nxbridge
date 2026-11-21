import path from 'node:path';
import { realpathSync } from 'node:fs';
import { redactCommand } from '../config/configuration.js';
import type { Host } from '../types.js';

const pending=new Map<string,Promise<void>>();

                                       
export async function acquireHostControl(command:string):Promise<()=>void>{
  let key=path.resolve(command);try{key=realpathSync.native(key);}catch{                  }
  if(process.platform==='win32')key=key.toLowerCase();
  const previous=pending.get(key)??Promise.resolve();
  let unlock!:()=>void;
  const gate=new Promise<void>(resolve=>unlock=resolve),tail=previous.then(()=>gate);
  pending.set(key,tail);await previous;
  let released=false;
  return()=>{if(released)return;released=true;unlock();if(pending.get(key)===tail)pending.delete(key);};
}

export function hostControlFailure(host:Host,args:string[],error:unknown):Error&{code?:string|number;exitCode:number|null;signal:string|null}{
  const native=error as {code?:string|number;signal?:string|null;killed?:boolean;stdout?:string|Buffer;stderr?:string|Buffer;detail?:string};
  const exitCode=typeof native.code==='number'?native.code:null,signal=native.signal??null;
  const tail=(value:unknown)=>String(value??'').slice(-4096).trim()||'（空）';
  const message=`${host} 控制命令 ${redactCommand(args).join(' ')} 失败：退出码=${exitCode??'未取得'}，信号=${signal??'无'}，系统错误=${typeof native.code==='string'?native.code:'无'}，已终止=${native.killed===true}。${native.detail?'\n补充：'+tail(native.detail):''}\n标准错误末尾：${tail(native.stderr)}\n标准输出末尾：${tail(native.stdout)}`;
  return Object.assign(new Error(message,{cause:error}),{name:'HostControlError',code:native.code,exitCode,signal});
}
