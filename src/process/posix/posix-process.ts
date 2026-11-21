import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import {BridgeError} from '../../shared/errors.js';
import { remainingTime } from '../../shared/time-budget.js';
import type { ProcessAncestry, ProcessIdentity } from '../process.js';

const execute=promisify(execFile);
export const psEnvironment=(platform=process.platform):NodeJS.ProcessEnv=>{
  const env:NodeJS.ProcessEnv={...process.env,LC_TIME:'C',TZ:'UTC'};
                                                                
  if(platform==='darwin')env.LC_CTYPE='UTF-8';
  delete env.LC_ALL;return env;
};
                                         
export const PS_IDENTITY_FIELDS='pid=,ppid=,stat=,lstart=,comm=';
export function parsePsProcess(line:string):ProcessIdentity|undefined{
  const match=/^\s*(\d+)\s+(\d+)\s+(\S+)\s+([A-Z][a-z]{2}\s+[A-Z][a-z]{2}\s+\d+\s+\d+:\d+:\d+\s+\d{4})\s+(.+?)\s*$/.exec(line);
  if(!match||!Number.isFinite(Date.parse(match[4]+' UTC')))return;
  const image=match[5]!,startedAt=match[4]!;
  return{pid:Number(match[1]),parentPid:Number(match[2]),state:match[3]![0],name:path.posix.basename(image),startedAt,procStart:startedAt,...(path.posix.isAbsolute(image)?{image}:{})};
}
export function parseProcProcess(pid:number,stat:string,image?:string):ProcessIdentity{
                                                     
  const start=stat.indexOf('('),end=stat.lastIndexOf(')'),fields=stat.slice(end+2).trim().split(/\s+/),parentPid=Number(fields[1]),generation=fields[19];
  if(start<0||end<start||Number(stat.slice(0,start).trim())!==pid||!/^\d+$/.test(generation??'')||!Number.isSafeInteger(parentPid)||parentPid<0||!fields[0])throw new BridgeError('process_identity_invalid','无法解析 Linux 原生进程身份。');
  return{pid,parentPid,name:stat.slice(start+1,end),startedAt:generation!,procStart:generation!,state:fields[0],...(image?{image}:{})};
}

interface PosixReader {
  platform:NodeJS.Platform;
  ps:(command:string,args:string[],options:{timeout:number;env:NodeJS.ProcessEnv;maxBuffer:number})=>Promise<{stdout:string}>;
  stat:(pid:number)=>string;
  image:(pid:number)=>string;
}
const reader:PosixReader={platform:process.platform,ps:execute,stat:pid=>readFileSync('/proc/'+pid+'/stat','utf8'),image:pid=>realpathSync('/proc/'+pid+'/exe')};
const missing=(error:unknown)=>['ENOENT','ESRCH'].includes((error as NodeJS.ErrnoException).code??'');
const ended=(row:ProcessIdentity)=>['Z','X'].includes(row.state??'');
export async function readPosixAncestry(pid:number,depth:number,deadline:number,io:PosixReader=reader):Promise<ProcessAncestry>{
  const ancestors:ProcessIdentity[]=[],seen=new Set<number>();let current=pid,complete=false,reason='depth';
  const readPs=async(pids:number[],fields=PS_IDENTITY_FIELDS):Promise<Map<number,ProcessIdentity>>=>{
    let stdout:string;
    try{({stdout}=await io.ps(io.platform==='darwin'?'/bin/ps':'ps',['-ww','-o',fields,'-p',pids.join(',')],{timeout:remainingTime(deadline,2000),env:psEnvironment(io.platform),maxBuffer:16*1024*1024}));}
    catch(error){const value=error as {code?:number;stdout?:string};if(value.code===1&&!value.stdout?.trim())return new Map();throw error;}
    const rows=stdout.split('\n').flatMap(line=>{const row=parsePsProcess(line);return row?[row]:[];});
    if(stdout.trim()&&!rows.length)throw new BridgeError('process_identity_unknown','系统进程快照无法解析。');
    return new Map(rows.map(row=>[row.pid,row]));
  };
  while(current>0&&ancestors.length<depth){
    remainingTime(deadline,2000);
    if(seen.has(current))throw new BridgeError('process_identity_unknown','系统进程父链存在循环。');
    seen.add(current);let row:ProcessIdentity|undefined;
    if(io.platform!=='linux')row=(await readPs([current])).get(current);
    else{
      let stat:string|undefined;try{stat=io.stat(current);}catch(error){if(!missing(error))throw error;}
      if(stat!==undefined){
        let image:string|undefined;try{image=io.image(current);}catch{                                     }
        row=parseProcProcess(current,stat,image);
      }
    }
    if(!row||ancestors.length&&ended(row)){complete=true;reason=ancestors.length?'parent_missing':'missing';break;}
    const previous=ancestors.at(-1);
    const newer=previous&&(io.platform==='linux'?BigInt(row.startedAt)>BigInt(previous.startedAt):Date.parse(row.startedAt+' UTC')>Date.parse(previous.startedAt+' UTC'));
    if(newer){complete=true;reason='parent_reused';break;}
    ancestors.push(row);current=row.parentPid;
    if(current===0||io.platform==='darwin'&&current===1){complete=true;reason='root';break;}
  }
                                                                 
  const renamed=io.platform==='darwin'?ancestors.filter(value=>!value.image&&!ended(value)):[];
  if(renamed.length){
    const pids=renamed.map(value=>value.pid),kernel=await readPs(pids,PS_IDENTITY_FIELDS.replace('comm=','ucomm='));
    let stdout:string;
    try{({stdout}=await io.ps('/usr/sbin/lsof',['-nP','-a','-p',pids.join(','),'-d','txt','-F0pftn'],{timeout:remainingTime(deadline,2000),env:psEnvironment('darwin'),maxBuffer:1024*1024}));}
    catch(error){const value=error as {code?:number;stdout?:string;signal?:unknown;killed?:boolean};if(value.code!==1||value.signal||value.killed)throw error;stdout=value.stdout??'';}
    const images=new Map<number,Set<string>>();let pid=0,fd='',type='';
    for(const field of stdout.split('\0')){
      const line=field.replace(/^\n+/,''),value=line.slice(1);
      if(line[0]==='p'){pid=Number(value);fd='';type='';}
      else if(line[0]==='f'){fd=value;type='';}
      else if(line[0]==='t')type=value;
      else if(line[0]==='n'&&fd==='txt'&&type==='REG'&&path.posix.isAbsolute(value)&&path.posix.basename(value)===kernel.get(pid)?.name){
        const candidates=images.get(pid)??new Set<string>();candidates.add(value);images.set(pid,candidates);
      }
    }
    for(const value of renamed){
      const native=kernel.get(value.pid);if(!native)continue;
      if(native.startedAt!==value.startedAt)throw new BridgeError('process_identity_unknown','进程代次在程序映像核验期间变化。');
                                              
      if(/\s/.test(value.name))value.name=native.name;
      const candidates=images.get(value.pid);if(candidates?.size===1)value.image=[...candidates][0];
    }
  }
                                                 
                                                   
  const finalPs=io.platform!=='linux'&&(ancestors.length>1||renamed.length)?await readPs(ancestors.map(row=>row.pid)):undefined;
  if(ancestors.length>1||renamed.length)for(let index=0;index<ancestors.length;index++){
    const row=ancestors[index]!;let final:ProcessIdentity;
    try{if(finalPs){const found=finalPs.get(row.pid);if(!found)throw Object.assign(Error('进程已退出'),{code:'ENOENT'});final=found;}else final=parseProcProcess(row.pid,io.stat(row.pid));}catch(error){
      if(!missing(error))throw error;
      ancestors.splice(index);complete=true;reason=index?'parent_missing':'missing';break;
    }
    if(final.startedAt!==row.startedAt)throw new BridgeError('process_identity_unknown','进程代次在父链核验期间变化。');
    if(ended(final)){ancestors.splice(index);complete=true;reason=index?'parent_missing':'missing';break;}
    if(index+1<ancestors.length&&final.parentPid!==ancestors[index+1]!.pid){
      row.parentPid=final.parentPid;ancestors.splice(index+1);complete=final.parentPid<=1;reason=complete?'root':'parent_changed';break;
    }
  }
  return{ancestors,complete,reason,source:io.platform==='linux'?'proc':'ps'};
}
