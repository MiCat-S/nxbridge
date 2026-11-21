import path from 'node:path';
import { readFileSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import { managedMarker } from '../install/installation.js';
import { retireDeadOwnedProcess, ownedProcesses, ownedRecordState, processRegistryRoot } from './owned-processes.js';
import { probeProcesses } from './process.js';
import {DEFAULT_RETENTION} from '../config/defaults.js';
import {describeError} from '../shared/errors.js';
import {type RetentionConfig} from '../types.js';
import { managedRuntimes, managedRuntimeState, removeManagedRuntime } from '../hosts/managed-runtimes.js';
import { capLog } from '../storage/logs.js';
import type { ClaudeChildRecord } from '../hosts/claude/claude-child.js';

                                     
export async function pruneDeadProcessRecords(home:string,options:{retention?:Partial<RetentionConfig>;referencedPeers?:Set<string>}={}):Promise<{owned:number;runtime:number;artifacts:number;notes:string[]}>{
  const snapshot=ownedProcesses(home),notes=[...snapshot.notes],runtime:{file:string;content:string;pid:number;generation:string}[]=[];
  const retention={...DEFAULT_RETENTION,...options.retention},children:{file:string;content:string;record:ClaudeChildRecord}[]=[],now=Date.now();
  let names:string[]=[];
  try{names=readdirSync(path.join(home,'run'));}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
  for(const name of names.filter(value=>/^runtime-.*\.json$/.test(value))){
    const file=path.join(home,'run',name);
    try{
      const content=readFileSync(file,'utf8'),record=JSON.parse(content);
      if(record?.owner!==managedMarker(home))continue;
      if(!Number.isSafeInteger(record.pid)||record.pid<=0||typeof record.generation!=='string'||!record.generation)throw Error('运行时记录缺少有效的 PID 或进程代次');
      runtime.push({file,content,pid:record.pid,generation:record.generation});
    }catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')notes.push(`保留无法核验的运行时记录 ${file}：${describeError(error)}`);}
  }
  for(const name of names.filter(value=>/^claude-child-[a-f0-9]+\.json$/.test(value))){
    const file=path.join(home,'run',name);
    try{
      const content=readFileSync(file,'utf8'),record=JSON.parse(content) as ClaudeChildRecord;
      if(record.version===1&&record.peerId&&['stopped','released','failed'].includes(record.phase)&&Number.isFinite(record.updatedAt)&&now-record.updatedAt>retention.historyMaxAgeMs&&!options.referencedPeers?.has(record.peerId))children.push({file,content,record});
    }catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')notes.push('保留无法读取的子进程记录 '+file+'：'+describeError(error));}
  }
  const identities=new Map<string,{pid:number;procStart:string}>();
  const key=(pid:number,generation:string)=>`${pid}:${generation}`;
  for(const record of snapshot.records)if(!record.windowsJob&&!record.posixGroup)identities.set(key(record.identity.pid,record.identity.startedAt),{pid:record.identity.pid,procStart:record.identity.startedAt});
  for(const record of runtime)identities.set(key(record.pid,record.generation),{pid:record.pid,procStart:record.generation});
  for(const child of children)for(const identity of [child.record.worker,child.record.wrapper,child.record.native,child.record.foreground])if(identity)identities.set(key(identity.pid,identity.startedAt),{pid:identity.pid,procStart:identity.startedAt});
  const values=[...identities.values()],states=await probeProcesses(values),byIdentity=new Map(values.map((value,index)=>[key(value.pid,value.procStart),states[index]]));
  await Promise.all(snapshot.records.filter(record=>record.windowsJob||record.posixGroup).map(async record=>{byIdentity.set(key(record.identity.pid,record.identity.startedAt),await ownedRecordState(record));}));
  let owned=0,removedRuntime=0,artifacts=0;
  const activeLaunches=new Set(snapshot.records.filter(record=>byIdentity.get(key(record.identity.pid,record.identity.startedAt))!=='dead').map(record=>record.proof.launchId));
  try{
    const managed=managedRuntimes(home),states=await Promise.all(managed.map(record=>managedRuntimeState(home,record.value)));
    for(let i=0;i<managed.length;i++)if(states[i]!=='dead'||managed[i]!.value.peerId&&options.referencedPeers?.has(managed[i]!.value.peerId!))activeLaunches.add(managed[i]!.value.id);else if(managed[i]!.value.failureCode!=='bootstrap_required')try{removeManagedRuntime(managed[i]!);removedRuntime++;}catch(error){notes.push('失效托管运行时记录清理未完成：'+describeError(error));}
  }catch(error){notes.push('保留无法核验的托管运行时记录：'+describeError(error));}
  for(const record of snapshot.records)if(byIdentity.get(key(record.identity.pid,record.identity.startedAt))==='dead'&&!(record.peerId&&options.referencedPeers?.has(record.peerId)))try{
    await retireDeadOwnedProcess(record);owned++;
  }catch(error){notes.push(`进程 ${record.identity.pid} 的失效归属记录清理未完成：${describeError(error)}`);}
  for(const record of runtime)if(byIdentity.get(key(record.pid,record.generation))==='dead')try{
                                     
    if(readFileSync(record.file,'utf8')===record.content){unlinkSync(record.file);removedRuntime++;}
  }catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')notes.push(`失效运行时记录 ${record.file} 清理未完成：${describeError(error)}`);}
  for(const child of children){
    const associated=snapshot.records.filter(value=>value.peerId===child.record.peerId).map(value=>value.identity),processes=[child.record.worker,child.record.wrapper,child.record.native,child.record.foreground,...associated].filter(value=>!!value);
    if(processes.some(value=>byIdentity.get(key(value.pid,value.startedAt))!=='dead'))continue;
    try{if(readFileSync(child.file,'utf8')===child.content){unlinkSync(child.file);artifacts++;}}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')notes.push('失效子进程记录清理未完成：'+describeError(error));}
  }
  const logs=names.flatMap(name=>{
    const match=/^codex-([a-f0-9-]{36})\.log$/.exec(name);if(!match)return[];
    try{return[{name,id:match[1]!,time:statSync(path.join(home,'run',name)).mtimeMs}];}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return[];throw error;}
  }).sort((a,b)=>b.time-a.time);
  let retained=0;
  for(const log of logs)if(!activeLaunches.has(log.id)&&(retained++>=retention.logBackups+1||now-log.time>retention.eventMaxAgeMs)){
    for(const name of names.filter(name=>name===log.name||name.startsWith(log.name+'.')&&/^\d+$/.test(name.slice(log.name.length+1))))try{unlinkSync(path.join(home,'run',name));artifacts++;}catch(error){if(!['ENOENT','EACCES','EPERM','EBUSY'].includes((error as NodeJS.ErrnoException).code??''))notes.push('运行日志清理未完成：'+describeError(error));}
  }
  for(const [name,limit] of [['broker.log',retention.logMaxBytes],['claude-child.log',1024*1024],...logs.map(log=>[log.name,retention.logMaxBytes])] as [string,number][])if(capLog(path.join(home,'run',name),limit))artifacts++;
  const retired=path.join(processRegistryRoot(),'retired');let retiredNames:string[]=[];
  try{retiredNames=readdirSync(retired);}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')notes.push('已退出进程的归属快照无法读取：'+describeError(error));}
  for(const name of retiredNames.filter(name=>/^[a-f0-9-]{36}\.json$/.test(name)))try{
    const file=path.join(retired,name),record=JSON.parse(readFileSync(file,'utf8'));
    if(record.version===1&&record.id+'.json'===name&&record.home===path.resolve(home)&&Number.isFinite(record.retiredAt)&&now-record.retiredAt>retention.historyMaxAgeMs){if(record.completionFile)try{unlinkSync(record.completionFile);}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}unlinkSync(file);artifacts++;}
  }catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')notes.push('保留无法读取的已退出进程快照：'+describeError(error));}
  return{owned,runtime:removedRuntime,artifacts,notes};
}
