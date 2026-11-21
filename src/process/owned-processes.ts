import path from 'node:path';
import { homedir, uptime } from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import type { ChildProcess } from 'node:child_process';
import { constants, copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs';
import {atomicJson} from '../shared/files.js';
import {privateDirectory} from './permissions.js';
import { processAncestors, processIdentity, type ProcessIdentity } from './process.js';
import { ownedProcessState, stopOwnedProcess, type OwnedIdentity } from './process-stop.js';
import {BridgeError,describeError} from '../shared/errors.js';
import { readWindowsJobMembers, stopWindowsJob, stopWindowsProcess, watchWindowsJobNative } from './windows/windows-hook-identity.js';
import { stopOwnedGroup, ownedGroupState, type ProcessState } from './process-stop.js';
import { posixSupervisorMetadata, declarePosixNative, configurePosixCompletion } from './posix/posix-supervisor.js';

export type OwnedProcessRole='broker'|'codex-runtime'|'claude-native'|'claude-worker'|'claude-child'|'host-control'|'proxy'|'test-daemon';
export interface OwnedProcessRecord {
  version:1;id:string;home:string;role:OwnedProcessRole;identity:ProcessIdentity;
  peerId?:string;sessionId?:string;configHome?:string;handle?:string;parent?:OwnedIdentity;
  scope?:string;releasedToUser?:boolean;createdAt:number;
  windowsIndependent?:true;
  windowsJob?:string;
  windowsHolder?:OwnedIdentity;
  completionFile?:string;
  posixGroup?:true;
  posixControl?:string;
  native?:OwnedIdentity;
  bootTime?:number;
  bootId?:string;
  proof:{kind:'spawn'|'native-session'|'legacy-runtime'|'legacy-ledger';launchId?:string};
}
const normalize=(home:string)=>process.platform==='win32'?path.resolve(home).toLowerCase():path.resolve(home);
const linuxBootId=(()=>{if(process.platform!=='linux')return;try{return readFileSync('/proc/sys/kernel/random/boot_id','utf8').trim()||undefined;}catch{return;}})();
export const currentLinuxBootId=():string|undefined=>linuxBootId;
const defaultProcessRegistryRoot=()=>process.platform==='win32'?path.join(process.env.LOCALAPPDATA??path.join(homedir(),'AppData','Local'),'nxbridge','processes'):path.join(process.env.XDG_STATE_HOME??path.join(homedir(),'.local','state'),'nxbridge','processes');
export function processRegistryRoot():string{return path.resolve(process.env.NXBRIDGE_PROCESS_REGISTRY??defaultProcessRegistryRoot());}
export function processRegistryDirectory(home:string):string{return path.join(processRegistryRoot(),createHash('sha256').update(normalize(home)).digest('hex').slice(0,24));}
export const containerCompletionFile=(home:string,id=randomUUID())=>path.join(processRegistryDirectory(home),id+'.json.done');
export function processOwnershipEnvironment():NodeJS.ProcessEnv{return Object.fromEntries(['NXBRIDGE_PROCESS_REGISTRY','NXBRIDGE_TEST_SCOPE'].filter(key=>process.env[key]!==undefined).map(key=>[key,process.env[key]]));}
const filename=(record:Pick<OwnedProcessRecord,'home'|'id'>)=>{
  if(!/^[a-f0-9-]{36}$/.test(record.id))throw new BridgeError('process_record_invalid','进程归属记录标识无效。');
  return path.join(processRegistryDirectory(record.home),record.id+'.json');
};
function currentRecord(record:OwnedProcessRecord):OwnedProcessRecord|undefined{
  try{return JSON.parse(readFileSync(filename(record),'utf8'));}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return;throw error;}
}
const prepared=new Map<string,Promise<void>>();
export async function prepareProcessRegistry(home:string):Promise<void>{
  const root=processRegistryRoot();let work=prepared.get(root);
  if(work&&!existsSync(root)){prepared.delete(root);work=undefined;}
  if(!work){work=privateDirectory(root);prepared.set(root,work);work.catch(()=>prepared.delete(root));}
  await work;mkdirSync(processRegistryDirectory(home),{recursive:true,mode:0o700});
}
export async function recordOwnedProcess(home:string,input:Omit<OwnedProcessRecord,'version'|'id'|'home'|'createdAt'|'scope'>):Promise<OwnedProcessRecord>{
  if(input.proof.kind==='spawn'&&input.identity.pid!==process.pid){
    const chain=await processAncestors(input.identity.pid,32);
    verifySpawnChain(input.identity,input.parent,chain);
  }
  return persistOwnedProcess(home,input);
}
function verifySpawnChain(identity:ProcessIdentity,parent:OwnedIdentity|undefined,chain:ProcessIdentity[]):void{
  if(chain[0]?.startedAt!==identity.startedAt||['Z','X'].includes(chain[0]?.state??''))throw new BridgeError('process_identity_unknown','新启动的进程身份不可核验，未登记为可回收进程。');
  if(!parent||!chain.some(value=>value.pid===parent.pid&&value.startedAt===parent.startedAt))throw new BridgeError('process_launch_unverified','无法核验该进程由本次启动创建，未登记为可回收进程。');
}
async function persistOwnedProcess(home:string,input:Omit<OwnedProcessRecord,'version'|'id'|'home'|'createdAt'|'scope'>,id=randomUUID()):Promise<OwnedProcessRecord>{
  await prepareProcessRegistry(home);
  const record:OwnedProcessRecord={...input,version:1,id,home:path.resolve(home),createdAt:Date.now(),bootTime:Date.now()-uptime()*1000,...(linuxBootId?{bootId:linuxBootId}:{}),...(process.env.NXBRIDGE_TEST_SCOPE?{scope:process.env.NXBRIDGE_TEST_SCOPE}:{})};
  if(record.posixGroup||record.windowsJob)record.completionFile??=filename(record)+'.done';
                                           
  if(record.scope){const directory=path.join(processRegistryRoot(),'test-generations');mkdirSync(directory,{recursive:true,mode:0o700});atomicJson(path.join(directory,record.id+'.json'),record);}
                                               
  atomicJson(filename(record),record);return record;
}
                                      
export const recordSpawnedProcess=persistOwnedProcess;
export function completeOwnedContainer(record:OwnedProcessRecord):void{
  if(!record.completionFile||existsSync(retiredCompletionFile(record)))return;
  try{writeFileSync(record.completionFile,'',{flag:'wx',encoding:'utf8'});}catch(error){
    const code=(error as NodeJS.ErrnoException).code;if(code==='EEXIST')return;if(code!=='ENOENT')throw error;
                                            
    const file=retiredCompletionFile(record);mkdirSync(path.dirname(file),{recursive:true,mode:0o700});
    try{writeFileSync(file,'',{flag:'wx',encoding:'utf8'});}catch(error){if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error;}
  }
}
const retiredCompletionFile=(record:Pick<OwnedProcessRecord,'id'>)=>path.join(processRegistryRoot(),'retired',record.id+'.done');
export const ownedContainerComplete=(record:OwnedProcessRecord)=>!!record.completionFile&&(existsSync(record.completionFile)||existsSync(retiredCompletionFile(record)));
                                     
function predatesBoot(record:OwnedProcessRecord):boolean{
  if(process.platform==='linux'&&record.bootId&&linuxBootId)return record.bootId!==linuxBootId;
  const boot=Date.now()-uptime()*1000,tolerance=120000;
  if(record.bootTime!==undefined)return boot-record.bootTime>tolerance;
  const generation=record.identity.startedAt,started=process.platform==='win32'&&/^\d+$/.test(generation)?Number(BigInt(generation)/10000n-11644473600000n):process.platform==='darwin'?Date.parse(generation+' UTC'):record.createdAt;
  return Number.isFinite(started)&&started<boot-tolerance;
}
                                                          
export function ownedRecordPredatesBoot(record:OwnedProcessRecord):boolean{return process.platform==='linux'?!!(record.bootId&&linuxBootId&&record.bootId!==linuxBootId):predatesBoot(record);}
async function unknownContainerState(record:OwnedProcessRecord):Promise<ProcessState>{
  if(ownedContainerComplete(record))return'dead';
  if(predatesBoot(record)&&await ownedProcessState(record.identity)==='dead'&&(!record.native||await ownedProcessState(record.native)==='dead')){completeOwnedContainer(record);return'dead';}
  return'unknown';
}
                                             
export async function declareOwnedNative(record:OwnedProcessRecord,identity:OwnedIdentity):Promise<void>{
  if(!record.windowsJob&&!record.posixControl)return;
  const current=currentRecord(record);
  if(!current||current.releasedToUser||current.identity.pid!==record.identity.pid||current.identity.startedAt!==record.identity.startedAt)throw new BridgeError('process_launch_unverified','原启动容器的归属已经改变，未交接原生宿主。');
  if(current.native){
    if(current.native.pid!==identity.pid||current.native.startedAt!==identity.startedAt)throw new BridgeError('process_launch_unverified','该容器已经交接给另一个原生宿主，未替换其代次。');
    Object.assign(record,current);return;
  }
  if(current.windowsJob)await watchWindowsJobNative(current.windowsJob,identity);
  else await declarePosixNative(current.posixControl!,current.identity,identity);
                                             
  const latest=currentRecord(current);
  if(!latest||latest.releasedToUser||latest.identity.pid!==current.identity.pid||latest.identity.startedAt!==current.identity.startedAt||latest.windowsJob!==current.windowsJob||latest.posixControl!==current.posixControl||latest.native&&(latest.native.pid!==identity.pid||latest.native.startedAt!==identity.startedAt))throw new BridgeError('process_launch_unverified','交接确认期间容器归属已经改变，未覆盖当前记录。');
  const updated={...latest,native:{pid:identity.pid,startedAt:identity.startedAt}};atomicJson(filename(updated),updated);Object.assign(record,updated);
}
export async function rememberOwnedDescendants(home:string,parent:OwnedIdentity,launchId:string):Promise<void>{
                                           
  if(process.platform!=='win32')return;
  const records=ownedProcesses(home).records,root=records.find(value=>value.identity.pid===parent.pid&&value.identity.startedAt===parent.startedAt&&value.windowsJob);
  if(!root?.windowsJob||ownedContainerComplete(root))return;
  let descendants:ProcessIdentity[];
  try{descendants=await readWindowsJobMembers(root.windowsJob,parent);}
  catch(error){
                                              
    if((error as {stderr?:string}).stderr?.includes('job_holder_missing')&&ownedContainerComplete(root))return;
    throw error;
  }
  const known=new Set(records.map(value=>value.identity.pid+':'+value.identity.startedAt));
  for(const identity of descendants)if(!known.has(identity.pid+':'+identity.startedAt))await persistOwnedProcess(home,{role:'host-control',identity,parent,proof:{kind:'spawn',launchId}});
}
export function ownedProcesses(home:string):{records:OwnedProcessRecord[];notes:string[]}{
  const directory=processRegistryDirectory(home),records:OwnedProcessRecord[]=[],notes:string[]=[];
  let names:string[]=[];
  try{names=readdirSync(directory);}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
  for(const name of names.filter(value=>/^[a-f0-9-]{36}\.json$/.test(value))){
    let content:string;
                                       
    try{content=readFileSync(path.join(directory,name),'utf8');}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')continue;throw error;}
    try{
      const value=JSON.parse(content) as OwnedProcessRecord;
      if(value.version!==1||normalize(value.home)!==normalize(home)||value.id+'.json'!==name)throw Error('记录版本或归属不符');
      records.push(value);
    }catch(error){notes.push('无法核验进程归属记录 '+name+'：'+describeError(error));}
  }
  return{records,notes};
}
export function forgetOwnedProcess(record:OwnedProcessRecord,reason='record-retired'):void{
                                              
  const retired=path.join(processRegistryRoot(),'retired'),file=path.join(retired,record.id+'.json');
  mkdirSync(retired,{recursive:true,mode:0o700});
  const receipt=retiredCompletionFile(record);
  if(record.completionFile)moveCompletion(record.completionFile,receipt);
  if(!existsSync(file))atomicJson(file,{version:1,id:record.id,home:record.home,role:record.role,pid:record.identity.pid,generation:record.identity.startedAt,launchId:record.proof.launchId??null,completionFile:record.completionFile?(existsSync(receipt)?receipt:record.completionFile):undefined,retiredAt:Date.now(),reason});
  try{unlinkSync(filename(record));}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
  if(record.posixControl&&existsSync(receipt)){
    try{unlinkSync(record.posixControl);}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
    try{rmdirSync(path.dirname(record.posixControl));}catch(error){if(!['ENOENT','ENOTEMPTY'].includes((error as NodeJS.ErrnoException).code??''))throw error;}
  }
}
function moveCompletion(original:string,target:string):void{
  if(original===target)return;
  try{if(existsSync(target))unlinkSync(original);else renameSync(original,target);}catch(error){
    const code=(error as NodeJS.ErrnoException).code;if(code==='ENOENT')return;if(code!=='EXDEV')throw error;
    try{copyFileSync(original,target,constants.COPYFILE_EXCL);}catch(error){if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error;}unlinkSync(original);
  }
}
                                   
export function migrateRetiredCompletions(home:string):void{
  const directory=path.join(processRegistryRoot(),'retired');let names:string[];
  try{names=readdirSync(directory);}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return;throw error;}
  for(const name of names.filter(value=>/^[a-f0-9-]{36}\.json$/.test(value))){
    const file=path.join(directory,name);let record:any;
    try{record=JSON.parse(readFileSync(file,'utf8'));}catch{continue;}
    if(record.home!==path.resolve(home)||!record.completionFile||record.id+'.json'!==name)continue;
    const target=retiredCompletionFile(record);moveCompletion(record.completionFile,target);
    if(record.completionFile!==target&&existsSync(target))atomicJson(file,{...record,completionFile:target});
  }
}
                                            
export async function retireDeadOwnedProcess(record:OwnedProcessRecord,reason='dead-generation'):Promise<void>{
  if(record.windowsHolder)await stopWindowsProcess(record.windowsHolder,3000);
  forgetOwnedProcess(record,reason);
}
export async function ownedRecordState(record:OwnedProcessRecord):Promise<ProcessState>{
  if(ownedContainerComplete(record))return'dead';
  if(process.platform==='linux'&&ownedRecordPredatesBoot(record)){completeOwnedContainer(record);return'dead';}
  if(record.windowsJob)try{
    if((await readWindowsJobMembers(record.windowsJob,record.identity)).length)return'alive';
    completeOwnedContainer(record);return'dead';
  }catch{return unknownContainerState(record);}
  if(record.posixGroup){const state=await ownedGroupState(record.identity);if(state==='dead')completeOwnedContainer(record);return state==='unknown'?unknownContainerState(record):state;}
  return ownedProcessState(record.identity);
}
export async function releaseOwnedProcess(record:OwnedProcessRecord):Promise<void>{
  const current=currentRecord(record);
                                             
  if(!current)return;
                                           
                                             
  if(current.id!==record.id||normalize(current.home)!==normalize(record.home)||current.identity.pid!==record.identity.pid||current.identity.startedAt!==record.identity.startedAt||current.windowsJob!==record.windowsJob||current.posixGroup!==record.posixGroup||current.windowsHolder?.pid!==record.windowsHolder?.pid||current.windowsHolder?.startedAt!==record.windowsHolder?.startedAt){
    throw new BridgeError('process_record_changed',`进程归属记录已经变化或无法核验，未停止（${record.role}；停止权限已经改变）。`);
  }
  record=current;
  if(record.releasedToUser)throw new BridgeError('process_owned_by_user','该进程已经交给用户窗口，未停止。');
  if(process.platform==='linux'&&ownedRecordPredatesBoot(record)){completeOwnedContainer(record);await retireDeadOwnedProcess(record,'previous-boot');return;}
  if((record.windowsJob||record.posixGroup)&&predatesBoot(record)&&await ownedRecordState(record)==='dead'){await retireDeadOwnedProcess(record,'previous-boot');return;}
  if(record.windowsJob){
    if(!ownedContainerComplete(record))try{await stopWindowsJob(record.windowsJob,record.identity);completeOwnedContainer(record);}
    catch(error){
      if(!ownedContainerComplete(record)){
        if((error as {stderr?:string}).stderr?.includes('job_holder_missing')){await stopOwnedProcess(record.identity);throw new BridgeError('process_identity_unknown','Job 持有进程已丢失；只回收登记的精确代次，缺少整组结束凭据，保留记录。');}
        throw error;
      }
    }
  }
  else if(record.posixGroup){if(!ownedContainerComplete(record)){await stopOwnedGroup(record.identity);completeOwnedContainer(record);}}
  else await stopOwnedProcess(record.identity);
  await retireDeadOwnedProcess(record,'owned-release');
}
export function transferOwnedPeerToUser(home:string,peerId:string):void{
  for(const record of ownedProcesses(home).records.filter(value=>value.peerId===peerId)){
    const updated={...record,releasedToUser:true};atomicJson(filename(updated),updated);
  }
}
export async function releaseRecordedProcesses(home:string,filter:(record:OwnedProcessRecord)=>boolean):Promise<string[]>{
  const {records,notes}=ownedProcesses(home);
  for(const record of records.filter(filter).sort((a,b)=>Number(a.role==='broker')-Number(b.role==='broker')||b.createdAt-a.createdAt))try{await releaseOwnedProcess(record);}catch(error){notes.push(`自有进程 ${record.identity.pid} 回收未完成：${describeError(error)}`);}
  return notes;
}
export async function registerCurrentProcess(home:string,role:OwnedProcessRole,extra:Partial<Pick<OwnedProcessRecord,'peerId'|'sessionId'|'parent'|'configHome'|'posixGroup'>>={}):Promise<OwnedProcessRecord>{const record=await recordOwnedProcess(home,{role,identity:await processIdentity(process.pid),proof:{kind:'spawn'},...extra});if(record.posixGroup)configurePosixCompletion(record.completionFile!);return record;}
export async function rememberOwnedChild(home:string,child:ChildProcess,role:OwnedProcessRole,extra:Partial<Pick<OwnedProcessRecord,'peerId'|'sessionId'|'configHome'|'posixGroup'>>={},launchId?:string):Promise<OwnedProcessRecord|undefined>{
  if(!child.pid||child.exitCode!==null||child.signalCode!==null)return;
  let identity:ProcessIdentity|undefined;
  let record:OwnedProcessRecord;
  try{
    const parent=await processIdentity(process.pid);identity=(await processAncestors(child.pid,1))[0];
    if(child.exitCode!==null||child.signalCode!==null)return;
    if(!identity)throw new BridgeError('process_identity_unknown','新启动的进程身份不可核验，未登记为可回收进程。');
                                                  
    if(identity.parentPid!==parent.pid)throw new BridgeError('process_launch_unverified','新进程的直接父项不是本次调用，未登记为可回收进程。');
    record=await persistOwnedProcess(home,{role,identity,parent,proof:{kind:'spawn',launchId},...extra,...posixSupervisorMetadata(child)});
    if(record.posixGroup)configurePosixCompletion(record.completionFile!,child);
  }
  catch(error){
                                    
    if(['process_identity_unknown','process_launch_unverified','process_missing'].includes((error as BridgeError).code)&&(child.exitCode!==null||child.signalCode!==null||identity&&await ownedProcessState(identity)==='dead'))return;
    throw error;
  }
  const done=()=>{if(record.posixGroup)return;try{forgetOwnedProcess(record,'child-exited');}catch(error){process.stderr.write('自有子进程记录清理未完成：'+describeError(error)+'\n');}};
  if(child.exitCode!==null||child.signalCode!==null)done();else child.once('exit',done);return record;
}
export async function rememberOwnedHost(home:string,child:ChildProcess,_host:'codex'|'claude',role:OwnedProcessRole,launchId:string,configHome?:string):Promise<void>{
                                   
  await rememberOwnedChild(home,child,role,{configHome},launchId);
}
