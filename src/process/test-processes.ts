import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readdirSync, realpathSync, unlinkSync } from 'node:fs';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {atomicJson,readJson} from '../shared/files.js';
import {delay} from '../shared/time.js';
import {loadConfig} from '../config/load.js';
import {runCli} from './host-command.js';
import { matchesProcess, processAncestors, processIdentity, type ProcessIdentity } from './process.js';
import {psEnvironment} from './posix/posix-process.js';
import { ownedProcesses, ownedRecordState, processRegistryDirectory, processRegistryRoot, recordOwnedProcess, releaseRecordedProcesses, ownedContainerComplete, completeOwnedContainer, type OwnedProcessRecord } from './owned-processes.js';
import { ownedProcessState, stopOwnedProcess, stopOwnedGroup } from './process-stop.js';
import { stopWindowsJob } from './windows/windows-hook-identity.js';
import { brokerCall } from '../ipc/ipc.js';
import {describeError} from '../shared/errors.js';

                                            
function canonical(value:string):string{
  let parent=path.resolve(value);const tail:string[]=[];
  for(;;)try{return path.join(realpathSync.native(parent),...tail.reverse());}catch(error){
    if(path.dirname(parent)===parent)throw error;
    if((error as NodeJS.ErrnoException).code!=='ENOENT'){
                                                             
      let missing=false;try{lstatSync(parent);}catch(statError){missing=(statError as NodeJS.ErrnoException).code==='ENOENT';}
      if(!missing)throw error;
    }
    tail.push(path.basename(parent));parent=path.dirname(parent);
  }
}
const inside=(root:string,value:string)=>{const relative=path.relative(canonical(root),canonical(value));return relative===''||!relative.startsWith('..'+path.sep)&&relative!=='..'&&!path.isAbsolute(relative);};
interface TestRoot {scope:string;directory:string;createdAt:number;processRegistry?:string}
interface Control {id:string;scope:string;home:string;configHome:string;startedAt:number;before?:{pid:number;generation?:string};parent:ProcessIdentity}
const rootsDirectory=()=>path.join(processRegistryRoot(),'test-roots');
const controlsDirectory=()=>path.join(processRegistryRoot(),'test-controls');
function testRecords<T>(directory:string,report?:(file:string,error:unknown)=>void):T[]{
  let names:string[];try{names=readdirSync(directory);}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return[];if(!report)throw error;report(directory,error);return[];}
                                          
  return names.filter(name=>name.endsWith('.json')).flatMap(name=>{
    const file=path.join(directory,name);
    try{return[readJson<T>(file)];}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return[];if(!report)throw error;report(file,error);return[];}
  });
}
function roots():TestRoot[]{return testRecords<TestRoot>(rootsDirectory()).filter(value=>value.scope===process.env.NXBRIDGE_TEST_SCOPE);}
export function registerTestDirectory(directory:string,processRegistry?:string):void{
  const scope=process.env.NXBRIDGE_TEST_SCOPE;if(!scope)return;
  if(processRegistry&&(!inside(directory,processRegistry)||path.resolve(directory)===path.resolve(processRegistry)))throw Error('子测试进程登记目录必须位于隔离夹具内');
  mkdirSync(rootsDirectory(),{recursive:true,mode:0o700});atomicJson(path.join(rootsDirectory(),createHash('sha256').update(directory).digest('hex')+'.json'),{scope,directory:path.resolve(directory),createdAt:Date.now(),...(processRegistry?{processRegistry:path.resolve(processRegistry)}:{})});
}
export function readClaudeSupervisor(configHome:string):{pid:number;generation?:string}|undefined{
  const filename=path.join(configHome,'daemon.status.json');if(!existsSync(filename))return;
  const value=readJson<{pid?:number;procStart?:string;supervisorPid?:number;supervisorProcStart?:string}>(filename),pid=value.supervisorPid??value.pid;
  return Number.isSafeInteger(pid)&&pid!>0?{pid:pid!,generation:value.supervisorProcStart??value.procStart}:undefined;
}
let caller:Promise<ProcessIdentity>|undefined;
export async function beginTestControl(home:string,configHome:string):Promise<Control|undefined>{
  const scope=process.env.NXBRIDGE_TEST_SCOPE;if(!scope)return;
  const registered=roots();if(![home,configHome].every(directory=>registered.some(root=>inside(root.directory,directory))))return;
  const parent=await(caller??=processIdentity(process.pid)),control:Control={id:randomUUID(),scope,home:path.resolve(home),configHome:path.resolve(configHome),startedAt:Date.now(),before:readClaudeSupervisor(configHome),parent};
  mkdirSync(controlsDirectory(),{recursive:true,mode:0o700});atomicJson(path.join(controlsDirectory(),control.id+'.json'),control);return control;
}
export async function finishTestControl(control?:Control):Promise<void>{
  if(!control)return;
  const supervisor=readClaudeSupervisor(control.configHome);
  if(supervisor){
    let owned=[...new Set([control.configHome,control.home])].flatMap(home=>ownedProcesses(home).records).find(record=>record.role==='test-daemon'&&record.identity.pid===supervisor.pid&&(!supervisor.generation||matchesProcess({procStart:supervisor.generation},record.identity)));
    if(!owned){
      let identity:ProcessIdentity|undefined;
      try{identity=await processIdentity(supervisor.pid);}catch(error){if((error as {code?:string}).code!=='process_missing')throw error;}
                                                             
      if(identity&&(!supervisor.generation||matchesProcess({procStart:supervisor.generation},identity))){
        if(control.before?.pid===supervisor.pid&&(!control.before.generation||matchesProcess({procStart:control.before.generation},identity)))throw Error('测试启动前已存在但无法证明归属的 Claude supervisor，未停止或认领');
        if(!/^claude(?:\.exe)?$/i.test(identity.name))throw Error('Claude supervisor 的原生状态与进程代次不符');
                                                       
        owned=await recordOwnedProcess(control.configHome,{role:'test-daemon',identity,configHome:control.configHome,parent:control.parent,proof:{kind:'native-session',launchId:control.id}});
      }
    }
                                                
    if(owned?.proof.kind==='native-session'&&!owned.releasedToUser)await recordTestDaemonDescendants(owned);
  }
  try{unlinkSync(path.join(controlsDirectory(),control.id+'.json'));}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
}
                                                      
export async function recordTestDaemonDescendants(daemon:OwnedProcessRecord):Promise<void>{
  if(process.platform==='win32')return;
  const known=new Map(ownedProcesses(daemon.home).records.map(record=>[record.identity.pid+':'+record.identity.startedAt,record])),pending=[daemon.identity],seen=new Set(known.keys());
  const execute=promisify(execFile);
  for(const parent of pending){
    let output:string;
    try{output=(await execute('/usr/bin/pgrep',['-P',String(parent.pid)],{env:psEnvironment(),timeout:2000})).stdout.trim();}
    catch(error){if((error as {code?:number}).code===1)continue;throw error;}
    for(const pid of output?output.split(/\s+/).map(Number):[]){
      let chain:ProcessIdentity[];
      try{chain=await processAncestors(pid,2);}catch(error){if((error as {code?:string}).code==='process_missing')continue;throw error;}
      const child=chain[0],actualParent=chain[1];
      if(!child||!actualParent||actualParent.pid!==parent.pid||actualParent.startedAt!==parent.startedAt||['Z','X'].includes(child.state??''))continue;
      const key=child.pid+':'+child.startedAt;if(known.get(key)?.releasedToUser)continue;
      if(!seen.has(key)){
        seen.add(key);await recordOwnedProcess(daemon.home,{role:'host-control',identity:child,parent,configHome:daemon.configHome,proof:{kind:'native-session',launchId:daemon.proof.launchId}});
      }
      if(!pending.some(value=>value.pid===child.pid&&value.startedAt===child.startedAt))pending.push(child);
    }
  }
}
function externalHomes(directory:string|undefined,controls:Control[],notes:Set<string>):string[]{
  const root=processRegistryRoot(),scope=process.env.NXBRIDGE_TEST_SCOPE,result=new Set<string>();if(!existsSync(root))return[];
  const candidates=new Set<string>(directory?[processRegistryDirectory(directory)]:[]);
  for(const record of generations(directory)){result.add(record.home);candidates.add(processRegistryDirectory(record.home));}
                                      
  if(directory)for(const control of controls)for(const home of [control.home,control.configHome])if(inside(directory,home))candidates.add(processRegistryDirectory(home));
  const directories=directory?[...candidates]:readdirSync(root,{withFileTypes:true}).filter(value=>value.isDirectory()&&/^[a-f0-9]{24}$/.test(value.name)).map(value=>path.join(root,value.name));
  const report=(file:string,error:unknown)=>notes.add(`测试归属证据无法读取 ${file}：${describeError(error)}；保留监督目录。`);
  for(const location of directories)for(const value of testRecords<{home?:string;scope?:string}>(location,report)){
    if(typeof value?.home!=='string'||!path.isAbsolute(value.home)||processRegistryDirectory(value.home)!==location){report(location,Error('归属目录与 home 不符'));continue;}
    if(value.scope===scope&&(!directory||inside(directory,value.home)))result.add(value.home);
  }
  return[...result];
}
function generations(directory?:string):OwnedProcessRecord[]{
  return testRecords<OwnedProcessRecord>(path.join(processRegistryRoot(),'test-generations')).filter(record=>{
    if(record.scope!==process.env.NXBRIDGE_TEST_SCOPE)return false;
    if(record.version!==1||typeof record.home!=='string'||!path.isAbsolute(record.home)||!Number.isSafeInteger(record.identity?.pid)||record.identity.pid<=0||typeof record.identity.startedAt!=='string'||!record.identity.startedAt)throw Error('测试进程代次凭据损坏，保留监督目录');
    return!directory||inside(directory,record.home);
  });
}
export async function cleanupTestProcesses(directory?:string):Promise<{pids:number[];notes:string[];processes:{pid:number;procStart:string;after:string}[];diagnostics:string[]}>{
  if(!process.env.NXBRIDGE_TEST_SCOPE)return{pids:[],notes:[],processes:[],diagnostics:[]};
  const notes:string[]=[],pids:number[]=[],identities=new Map<string,Pick<ProcessIdentity,'pid'|'startedAt'>>(),diagnostics:string[]=[],ownershipNotes=new Set<string>();
  const registered=roots(),protectedHomes=JSON.parse(process.env.NXBRIDGE_TEST_PROTECTED_HOMES??'[]') as string[];
                                                        
  const allowed=(value:string)=>!protectedHomes.some(home=>inside(home,value))&&registered.some(root=>{try{return inside(root.directory,value);}catch(error){if(['EPERM','EACCES','ENOENT'].includes((error as NodeJS.ErrnoException).code??''))return false;throw error;}});
  const rejected=new Set<string>(),reject=(home:string)=>{if(!rejected.has(home)){rejected.add(home);notes.push('拒绝清理未登记的测试目录：'+home+'；未关闭协调器或释放其进程。');}};
  if(directory&&!allowed(directory)){reject(directory);return{pids,notes,processes:[],diagnostics};}
  const permitted=(home:string)=>{if(allowed(home))return true;reject(home);return false;};
  const controls=testRecords<Control>(controlsDirectory()).filter(value=>value.scope===process.env.NXBRIDGE_TEST_SCOPE);
  for(const value of controls){
    if(directory&&!inside(directory,value.home))continue;
    if(!permitted(value.home)||!permitted(value.configHome))continue;
    try{await finishTestControl(value);}catch(error){notes.push(describeError(error));}
  }
  for(const home of externalHomes(directory,controls,ownershipNotes)){
    if(!permitted(home))continue;
    const snapshot=ownedProcesses(home),before={notes:snapshot.notes,records:snapshot.records.filter(record=>record.scope===process.env.NXBRIDGE_TEST_SCOPE)};
    notes.push(...before.notes);pids.push(...before.records.map(record=>record.identity.pid));
    for(const record of before.records)for(const identity of [record.identity,...(record.windowsHolder?[record.windowsHolder]:[])]){pids.push(identity.pid);identities.set(identity.pid+':'+identity.startedAt,identity);}
    try{
                                                  
      if(snapshot.records.some(record=>record.scope!==process.env.NXBRIDGE_TEST_SCOPE))throw Error('隔离目录含其他会话的归属记录，未关闭协调器');
      await brokerCall('shutdown',{releaseOwned:true,reason:'test_cleanup',requester:{pid:process.pid,command:'cleanupTestProcesses'}},{home,start:false,timeout:8000});
                                               
      const deadline=Date.now()+2000;
      for(const record of before.records.filter(value=>value.role==='broker'))while(await ownedProcessState(record.identity)==='alive'&&Date.now()<deadline)await delay(50);
    }catch(error){if(!['ENOENT','ECONNREFUSED','EPIPE','disconnected'].includes((error as {code?:string}).code??''))diagnostics.push('隔离 broker 正常关闭未完成：'+describeError(error));}
    for(const daemon of before.records.filter(record=>record.role==='test-daemon'&&!record.releasedToUser&&record.configHome&&record.proof.kind==='native-session'&&record.scope===process.env.NXBRIDGE_TEST_SCOPE)){
      if(await ownedProcessState(daemon.identity)==='alive'){
        try{
          await recordTestDaemonDescendants(daemon);
          const current=readClaudeSupervisor(daemon.configHome!);
          if(current?.pid!==daemon.identity.pid||current.generation&&!matchesProcess({procStart:current.generation},daemon.identity))throw Error('隔离 Claude 服务登记已改变，未发送停止命令');
          await runCli('claude',['daemon','stop','--any','--json-path',path.join(daemon.configHome!,'daemon.json')],{home,config:{...loadConfig(home),claudeHome:daemon.configHome},timeout:15000});
        }catch(error){diagnostics.push('隔离 Claude supervisor 正常关闭未完成：'+describeError(error));}
      }
    }
    notes.push(...await releaseRecordedProcesses(home,record=>record.scope===process.env.NXBRIDGE_TEST_SCOPE));
  }
                                          
                                     
  for(const record of generations(directory)){
    if(!permitted(record.home))continue;
    if(record.identity.pid===process.pid)continue;
    const key=record.identity.pid+':'+record.identity.startedAt;pids.push(record.identity.pid);identities.set(key,record.identity);
    if(record.windowsHolder){pids.push(record.windowsHolder.pid);identities.set(record.windowsHolder.pid+':'+record.windowsHolder.startedAt,record.windowsHolder);}
    try{if(record.windowsJob){if(!ownedContainerComplete(record))try{await stopWindowsJob(record.windowsJob,record.identity);completeOwnedContainer(record);}catch(error){if(!ownedContainerComplete(record))throw error;}if(record.windowsHolder)await stopOwnedProcess(record.windowsHolder);}else if(record.posixGroup){if(!ownedContainerComplete(record)){await stopOwnedGroup(record.identity);completeOwnedContainer(record);}}else await stopOwnedProcess(record.identity);}catch(error){notes.push(`测试进程 ${key} 的最终回收未完成：${describeError(error)}`);}
  }
  const remaining=externalHomes(directory,controls,ownershipNotes).filter(home=>allowed(home)).flatMap(home=>ownedProcesses(home).records.filter(record=>record.scope===process.env.NXBRIDGE_TEST_SCOPE));
  for(const record of remaining)if(await ownedRecordState(record)!=='dead')notes.push(`隔离进程 ${record.identity.pid}/${record.identity.startedAt} 尚未核验退出；归属证据保留于 ${processRegistryRoot()}`);
  const processes:{pid:number;procStart:string;after:string}[]=await Promise.all([...identities.values()].map(async identity=>({pid:identity.pid,procStart:identity.startedAt,after:await ownedProcessState(identity)})));
  for(const value of processes)if(value.after!=='dead')notes.push(`测试进程 ${value.pid}/${value.procStart} 的最终状态为 ${value.after}，未清除证据。`);
                                                     
  const linked=roots().filter(root=>root.processRegistry&&inside(root.directory,root.processRegistry)&&(!directory||inside(directory,root.directory)));
  for(const root of linked){
    if(!existsSync(root.processRegistry!)||path.resolve(root.processRegistry!)===path.resolve(processRegistryRoot()))continue;
    const previous=process.env.NXBRIDGE_PROCESS_REGISTRY;
    try{process.env.NXBRIDGE_PROCESS_REGISTRY=root.processRegistry!;const child=await cleanupTestProcesses(root.directory);pids.push(...child.pids);notes.push(...child.notes);processes.push(...child.processes);diagnostics.push(...child.diagnostics);}
    finally{if(previous===undefined)delete process.env.NXBRIDGE_PROCESS_REGISTRY;else process.env.NXBRIDGE_PROCESS_REGISTRY=previous;}
  }
  notes.push(...ownershipNotes);return{pids,notes,processes,diagnostics};
}
