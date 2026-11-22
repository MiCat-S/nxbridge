import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import {BridgeError} from '../shared/errors.js';
import { readWindowsHookIdentity, readWindowsProcessArguments, readWindowsProcessGenerations, readWindowsJobMembers, readWindowsAncestors } from './windows/windows-hook-identity.js';
import { remainingTime } from '../shared/time-budget.js';
import { parsePsProcess, PS_IDENTITY_FIELDS, psEnvironment, readPosixAncestry } from './posix/posix-process.js';
export { parsePsProcess, PS_IDENTITY_FIELDS } from './posix/posix-process.js';

const execute = promisify(execFile);
const ps=()=>process.platform==='darwin'?'/bin/ps':'ps';
export interface ProcessIdentity {
  pid: number;
  parentPid: number;
  name: string;
  startedAt: string;
  procStart?: string;
  procStartFt?: string;
  image?: string;
  launchImage?:string;
  state?: string;
}

export interface ProcessAncestry {
  ancestors:ProcessIdentity[];
  complete:boolean;
  reason:string;
  source?:'native'|'proc'|'ps';
}

export function liveProcess(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code === 'EPERM'; }
}



                                            
export async function nativeConfigHome(identity:ProcessIdentity,host:'codex'|'claude'):Promise<string|undefined>{
  if(process.platform!=='linux')return;
  let configured:string|undefined;
  try{
    const environment=readFileSync('/proc/'+identity.pid+'/environ','utf8').split('\0'),get=(key:string)=>environment.find(value=>value.startsWith(key+'='))?.slice(key.length+1);
    const value=get(host==='codex'?'CODEX_HOME':'CLAUDE_CONFIG_DIR'),userHome=get('HOME');
    configured=value&&path.isAbsolute(value)?value:!value&&userHome&&path.isAbsolute(userHome)?path.join(userHome,host==='codex'?'.codex':'.claude'):undefined;
  }catch{return;}
  const current=await processIdentity(identity.pid);if(current.startedAt!==identity.startedAt)throw new BridgeError('process_identity_unknown','配置目录观察期间原生进程代次改变。');
  return configured;
}

export async function processAncestry(pid:number,depth=1,timeout=10000):Promise<ProcessAncestry>{
  if(!Number.isSafeInteger(pid)||pid<=0||!Number.isSafeInteger(depth)||depth<=0)throw new BridgeError('process_identity_invalid','进程 PID 或祖先深度无效。');
  const deadline=performance.now()+timeout;
  const value=process.platform==='win32'?await windowsAncestry(pid,depth,remainingTime(deadline,timeout)):await readPosixAncestry(pid,depth,deadline);
  if(value.source==='proc'||value.source==='ps'){
    ancestryDiagnostics[value.source]++;
    if(!value.complete&&value.reason!=='depth')ancestryDiagnostics.unknown++;
    ancestryDiagnostics.last={source:value.source,reason:value.reason,durationMs:performance.now()-(deadline-timeout)};
  }
  if(!value.ancestors.length&&!value.complete)throw new BridgeError('process_identity_unknown','进程祖先身份不可核验（'+value.source+'/'+value.reason+'）。');
  return value;
}
export async function processAncestors(pid:number,depth=1,timeout=10000):Promise<ProcessIdentity[]>{
  return(await processAncestry(pid,depth,timeout)).ancestors;
}

let ownIdentity:Promise<ProcessIdentity>|undefined;
export async function processIdentity(pid: number): Promise<ProcessIdentity> {
  const read=async()=>{
    const result = (await processAncestors(pid))[0];
    if (!result) throw new BridgeError('process_missing', '会话进程已经结束。');
    return result;
  };
                                      
  if(pid!==process.pid)return read();
  if(!ownIdentity){ownIdentity=read();void ownIdentity.catch(()=>{ownIdentity=undefined;});}
  return ownIdentity;
}

export interface ProcessContainer {identity:ProcessIdentity;windowsJob?:string;posixGroup?:true}
export async function processDescendants(root:Pick<ProcessIdentity,'pid'|'startedAt'>,container?:ProcessContainer):Promise<ProcessIdentity[]>{
  if(process.platform==='win32'){
    if(!container?.windowsJob)throw new BridgeError('launch_owner_unverified','没有本次启动的 Job 证据，不能发现或认领未登记的后代。');
    return(await readWindowsJobMembers(container.windowsJob,root)).filter(value=>value.pid!==root.pid);
  }
  let identity:ProcessIdentity;
  try{identity=await processIdentity(root.pid);if(identity.startedAt!==root.startedAt)return[];}
  catch(error){if((error as BridgeError).code!=='process_missing')throw error;if(!container?.posixGroup)return[];throw new BridgeError('launch_owner_unverified','监督进程已经退出，数字组号不能证明原代次的后代归属。');}
  if(container?.posixGroup&&['Z','X'].includes(identity.state??''))throw new BridgeError('launch_owner_unverified','监督进程已经结束，不能继续认领进程组中的宿主。');
  const group=container?.posixGroup?String(root.pid):(await execute(ps(),['-o','pgid=','-p',String(root.pid)],{env:psEnvironment(),timeout:3000})).stdout.trim();
  if(!/^\d+$/.test(group))throw new BridgeError('process_identity_unknown','启动进程组无法核验。');
  let rows:ProcessIdentity[];
  try{
    if(process.platform==='linux'){
      const selection=container?.posixGroup?['-s',group]:['-p',(await execute('pgrep',['-g',group],{env:psEnvironment(),timeout:3000})).stdout.trim().split(/\s+/).join(',')];
      const {stdout}=await execute(ps(),['-ww',...selection,'-o','pgid=,'+PS_IDENTITY_FIELDS],{env:psEnvironment(),timeout:3000});
      rows=stdout.split('\n').flatMap(line=>{const match=/^\s*(\d+)\s+(.+)$/.exec(line);const value=match&&match[1]===group?parsePsProcess(match[2]!):undefined;return value?[value]:[];});
      rows=(await Promise.all(rows.map(async value=>{try{return[await processIdentity(value.pid)];}catch(error){if((error as BridgeError).code==='process_missing')return[];throw error;}}))).flat();
    }else{
      const members=(await execute('/usr/bin/pgrep',['-g',group],{env:psEnvironment(),timeout:3000})).stdout.trim().split(/\s+/).join(',');
      const {stdout}=await execute(ps(),['-ww','-p',members,'-o',PS_IDENTITY_FIELDS],{env:psEnvironment(),timeout:3000});
      rows=stdout.split('\n').flatMap(line=>{const value=parsePsProcess(line);return value?[value]:[];});
    }
  }catch(error){if((error as {code?:number}).code===1)return[];throw error;}
                                       
                                            
  const refresh=async(values:ProcessIdentity[])=>process.platform!=='darwin'?values:(await Promise.all(values.map(async value=>{if(value.image)return[value];try{return[await processIdentity(value.pid)];}catch(error){if((error as BridgeError).code==='process_missing')return[];throw error;}}))).flat();
  if(container?.posixGroup)return refresh(rows.filter(value=>value.pid!==root.pid));
  const found=new Map<number,ProcessIdentity>([[root.pid,identity]]);let added:boolean;
  do{added=false;for(const row of rows){if(found.has(row.pid)||!found.has(row.parentPid))continue;const parent=found.get(row.parentPid)!;if(process.platform==='linux'&&BigInt(row.startedAt)<BigInt(parent.startedAt))continue;found.set(row.pid,row);added=true;}}while(added);
  return refresh([...found.values()].filter(value=>value.pid!==root.pid));
}

export async function nativeDescendant(rootPid:number,host:'codex'|'claude',startedAt:number,endpoint?:string,container?:ProcessContainer):Promise<ProcessIdentity>{
  let rows:ProcessIdentity[];
  const minimum=process.platform==='win32'?BigInt(startedAt-2000)*10000n+116444736000000000n:undefined;
  {
                                                           
    try{
      let root:ProcessIdentity|undefined;
      try{root=await processIdentity(rootPid);}catch(error){if((error as BridgeError).code!=='process_missing'||!container)throw error;}
      if(root&&container&&root.startedAt!==container.identity.startedAt)throw new BridgeError('launch_owner_unverified','启动入口代次已改变，未沿用原容器。');
                                                   
      if(root&&!['Z','X'].includes(root.state??'')&&(!minimum||BigInt(root.startedAt)>=minimum)&&
        (endpoint?codexDedicatedEndpointArguments(await codexArguments(root),endpoint):new RegExp('^'+host+'(?:\\.exe)?$','i').test(root.name)))return root;
      rows=[...(root?[root]:[]),...await processDescendants(container?.identity??root!,container)];
    }
    catch(error){if((error as BridgeError).code==='process_missing')throw new BridgeError('launch_owner_unverified','启动进程已退出，无法确认唯一一个原生宿主。');throw error;}
  }
  const byPid=new Map(rows.map(value=>[value.pid,value]));
  const descendants=rows.filter(value=>{
    if(['Z','X'].includes(value.state??''))return false;
    if((!endpoint&&!new RegExp('^'+host+'(?:\\.exe)?$','i').test(value.name))||minimum&&BigInt(value.startedAt)<minimum)return false;
    if(container?.windowsJob||container?.posixGroup)return true;
    let current=value;const seen=new Set<number>();
    while(!seen.has(current.pid)){if(current.pid===rootPid||current.parentPid===rootPid)return true;seen.add(current.pid);const parent=byPid.get(current.parentPid);if(!parent)return false;current=parent;}return false;
  });
  const candidates:ProcessIdentity[]=[];
  for(const value of descendants){
    if(!endpoint){candidates.push(value);continue;}
    try{
      if(codexDedicatedEndpointArguments(await codexArguments(value),endpoint))candidates.push(value);
    }catch(error){if((error as BridgeError).code!=='process_missing'&&!['ENOENT','ESRCH'].includes((error as NodeJS.ErrnoException).code??''))throw error;}
  }
                                                     
  const native=selectNativeHost(candidates,rows);
  return native;
}

                                      
export function selectNativeHost(candidates:ProcessIdentity[],rows:ProcessIdentity[]):ProcessIdentity{
  const byPid=new Map(rows.map(value=>[value.pid,value])),ids=new Set(candidates.map(value=>value.pid));
  const roots=candidates.filter(value=>{
    let current=byPid.get(value.parentPid);const seen=new Set<number>();
    while(current&&!seen.has(current.pid)){if(ids.has(current.pid))return false;seen.add(current.pid);current=byPid.get(current.parentPid);}
    return true;
  });
  if(roots.length!==1)throw new BridgeError('launch_owner_unverified','没能通过启动父链确认唯一一个原生宿主；请核对自定义启动命令，未停止任何进程。');
  return roots[0]!;
}

export async function claudeBackgroundHost(native:ProcessIdentity,sessionId?:string):Promise<ProcessIdentity|undefined>{
  if(sessionId&&!/^[a-f0-9-]{36}$/i.test(sessionId))return;
  const parent=(await processAncestors(native.pid,2))[1];if(!parent||!/^claude(?:\.exe)?$/i.test(parent.name))return;
  const args=await codexArguments(parent);
                                                                             
                                         
  if(args.includes('--bg-pty-host')&&(!sessionId||args.some((arg,index)=>['--session-id','--resume'].includes(arg)&&args[index+1]===sessionId||['--session-id=','--resume='].some(flag=>arg===flag+sessionId))))return parent;
}

export function matchesProcess(record: { procStart?: string; procStartFt?: string }, process: ProcessIdentity): boolean {
  if (record.procStartFt !== undefined) return record.procStartFt === process.procStartFt;
                                                                         
  return record.procStart !== undefined && (record.procStart === process.procStart || record.procStart === process.procStartFt);
}

type ProbeState='alive'|'dead'|'unknown';
interface ProbeRequest {records:{pid:number;procStart:string}[];resolve:(states:ProbeState[])=>void;reject:(error:unknown)=>void}
const probeBatches=new Map<number,ProbeRequest[]>();
const probeDiagnostics:{batches:number;requests:number;last?:{at:number;durationMs:number;pidCount:number;outcome:'ok'|'timeout'|'failed';code?:string}}={batches:0,requests:0};
export const processProbeStatus=()=>({...probeDiagnostics,...(probeDiagnostics.last?{last:{...probeDiagnostics.last}}:{})});
                                  
export function probeProcesses(records:{pid:number;procStart:string}[],timeout=1500):Promise<ProbeState[]>{
  if(!records.length)return Promise.resolve([]);probeDiagnostics.requests++;
  return new Promise((resolve,reject)=>{
    const pending=probeBatches.get(timeout);if(pending){pending.push({records,resolve,reject});return;}
    const batch:ProbeRequest[]=[{records,resolve,reject}];probeBatches.set(timeout,batch);
    setImmediate(()=>{
      probeBatches.delete(timeout);probeDiagnostics.batches++;
      void probeProcessesNow(batch.flatMap(r=>r.records),timeout).then(states=>{let offset=0;for(const request of batch){request.resolve(states.slice(offset,offset+request.records.length));offset+=request.records.length;}},error=>{for(const request of batch)request.reject(error);});
    });
  });
}
                                                
async function probeProcessesNow(records:{pid:number;procStart:string}[],timeout:number):Promise<ProbeState[]>{
  if(!records.length)return[];
  const identities=new Map<number,{generation:string;ticks?:string}>(),missing=new Set<number>();
  const valid=(pid:number)=>Number.isSafeInteger(pid)&&pid>0;
  const pids=[...new Set(records.map(r=>r.pid).filter(pid=>valid(pid)&&liveProcess(pid)))];
  if(process.platform==='win32'&&pids.length){
    const began=performance.now();
    try{
      for(const row of await readWindowsProcessGenerations(pids,timeout))if(row.missing)missing.add(row.pid);else if(row.generation)identities.set(row.pid,{generation:row.generation,...(row.ticks?{ticks:row.ticks}:{})});
      probeDiagnostics.last={at:Date.now(),durationMs:performance.now()-began,pidCount:pids.length,outcome:'ok'};
    }catch(error){
      const detail=error as {killed?:boolean;code?:string};probeDiagnostics.last={at:Date.now(),durationMs:performance.now()-began,pidCount:pids.length,outcome:detail.killed||detail.code==='ETIMEDOUT'?'timeout':'failed',...(typeof detail.code==='string'?{code:detail.code}:{})};
                                    
    }
  }else{
    await Promise.all(pids.map(async pid=>{
      try{const identity=await processIdentity(pid);if(['Z','X'].includes(identity.state??''))missing.add(pid);else identities.set(pid,{generation:identity.startedAt});}
      catch(error){if((error as BridgeError).code==='process_missing')missing.add(pid);}
    }));
  }
  return records.map(record=>{
    if(!valid(record.pid))return'unknown';
    if(!liveProcess(record.pid)||missing.has(record.pid))return'dead';
    const identity=identities.get(record.pid);if(!identity||!record.procStart)return'unknown';
    return identity.generation===record.procStart||identity.ticks===record.procStart?'alive':'dead';
  });
}

export function windowsArguments(line:string):string[]{
  const args:string[]=[];let value='',quoted=false,started=false;
  for(let i=0;i<line.length;i++){
    const ch=line[i]!;
    if(ch==='\\'){
      let count=1;while(line[i+1]==='\\'){count++;i++;}
      if(line[i+1]==='"'){value+='\\'.repeat(Math.floor(count/2));if(count%2){value+='"';i++;}else{quoted=!quoted;i++;}}
      else value+='\\'.repeat(count);
      started=true;
    }else if(ch==='"'){quoted=!quoted;started=true;}
    else if(/\s/.test(ch)&&!quoted){if(started){args.push(value);value='';started=false;}}
    else{value+=ch;started=true;}
  }
  if(started)args.push(value);return args;
}
export function codexAppServerArguments(args:string[]):boolean{
  const values=new Set(['-c','--config','--profile','-p','--enable','--disable','-C','--cd','--model','-m','--sandbox','-s','--ask-for-approval','-a']);
  for(let i=1;i<args.length;i++){const arg=args[i]!;if(arg==='--')return false;if(arg.startsWith('-')){if(values.has(arg))i++;continue;}return arg==='app-server';}return false;
}
export function codexDedicatedEndpointArguments(args:string[],endpoint:string):boolean{
  return codexAppServerArguments(args)&&args.some((arg,index)=>arg==='--listen'&&args[index+1]===endpoint||arg==='--listen='+endpoint);
}
export function codexStartupArguments(args:string[]):{appServer:boolean;resumeSessionId?:string}{
  const appServer=codexAppServerArguments(args),values=new Set(['-c','--config','--profile','-p','--enable','--disable','-C','--cd','--model','-m','--sandbox','-s','--ask-for-approval','-a']);
  if(appServer||args.includes('--fork'))return{appServer};
  for(let i=1;i<args.length;i++){
    const value=args[i]!;if(value==='--')break;if(value.startsWith('-')){if(values.has(value))i++;continue;}
    if(value!=='resume')break;
    const id=args[i+1];return{appServer,...(id&&/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(id)?{resumeSessionId:id}:{})};
  }
  return{appServer};
}
export async function codexProcessIdentity(timeout=10000,originPid=process.ppid,windowsRead=readWindowsHookIdentity,skipOrigin=false): Promise<{ pid: number; procStart: string; appServer:boolean;managedDaemon:boolean;resumeSessionId?:string }> {
  const deadline=performance.now()+timeout;
  if(process.platform==='win32'){
    const found=await windowsRead(originPid,undefined,'codex',remainingTime(deadline,timeout),skipOrigin);
    const args=windowsArguments(found.commandLine);return{pid:found.pid,procStart:found.procStart,...codexStartupArguments(args),managedDaemon:codexAppServerArguments(args)&&args.includes('--managed-daemon')};
  }
  const found = (await processAncestors(originPid, skipOrigin?11:10,remainingTime(deadline,timeout))).slice(skipOrigin?1:0).find(p => /^codex(?:\.exe)?$/i.test(p.name));
  if (!found) throw new BridgeError('codex_process_missing', '无法确认是哪个 Codex 进程发起了这次调用。');
  const args=await codexArguments(found,remainingTime(deadline,timeout));return { pid: found.pid, procStart: found.startedAt,...codexStartupArguments(args),managedDaemon:codexAppServerArguments(args)&&args.includes('--managed-daemon') };
}

const ancestryDiagnostics:{native:number;proc:number;ps:number;unknown:number;last?:{source:string;reason:string;durationMs:number}}={native:0,proc:0,ps:0,unknown:0};
export const processAncestryStatus=()=>({...ancestryDiagnostics,...(ancestryDiagnostics.last?{last:{...ancestryDiagnostics.last}}:{})});
export async function windowsAncestry(pid:number,depth:number,timeout:number,read=readWindowsAncestors):Promise<ProcessAncestry>{
  const began=performance.now();
  try{
    const value=await read(pid,depth,timeout);ancestryDiagnostics.native++;
    if(!value.complete&&value.reason!=='depth')ancestryDiagnostics.unknown++;
    ancestryDiagnostics.last={source:value.source??'native',reason:value.reason,durationMs:performance.now()-began};
    return value;
  }catch(error){
    ancestryDiagnostics.unknown++;ancestryDiagnostics.last={source:'native',reason:(error as BridgeError).code??'failed',durationMs:performance.now()-began};throw error;
  }
}
export async function codexArguments(found:ProcessIdentity,timeout=10000):Promise<string[]>{
  const deadline=performance.now()+timeout;
  let args:string[];
  if(process.platform==='win32'){
    args=windowsArguments(await readWindowsProcessArguments(found,remainingTime(deadline,timeout)));
  }else if(process.platform==='linux')args=readFileSync('/proc/'+found.pid+'/cmdline','utf8').split('\0').filter(Boolean);
  else{
    const {stdout}=await execute(ps(),['-ww','-p',String(found.pid),'-o','lstart=,args='],{timeout:remainingTime(deadline,2000),env:psEnvironment(),maxBuffer:16*1024*1024});
    return parsePsArguments(stdout,found);
  }
  if(!args.length||process.platform!=='win32'&&(await processAncestors(found.pid,1,remainingTime(deadline,2000)))[0]?.startedAt!==found.startedAt)throw new BridgeError('process_identity_unknown','原生 Codex 身份在读取期间改变。');
  return args;
}
export function parsePsArguments(stdout:string,found:Pick<ProcessIdentity,'startedAt'|'image'>):string[]{
  const match=/^\s*([A-Z][a-z]{2}\s+[A-Z][a-z]{2}\s+\d+\s+\d+:\d+:\d+\s+\d{4})\s+([\s\S]+?)\s*$/.exec(stdout);
  if(!match||match[1]!.replace(/\s+/g,' ')!==found.startedAt.replace(/\s+/g,' '))throw new BridgeError('process_identity_unknown','原生 Codex 身份在读取参数时改变。');
  const command=match[2]!,image=found.image;
                                                     
  if(image&&command.startsWith(image)&&(command.length===image.length||/\s/.test(command[image.length]!)))return[image,...windowsArguments(command.slice(image.length))];
  return windowsArguments(command);
}
export async function codexIsAppServer(found:ProcessIdentity):Promise<boolean>{return codexAppServerArguments(await codexArguments(found));}
export async function codexIsManagedDaemon(found:ProcessIdentity):Promise<boolean>{const args=await codexArguments(found);return codexAppServerArguments(args)&&args.includes('--managed-daemon');}
