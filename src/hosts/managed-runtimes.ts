import path from 'node:path';
import { existsSync, readdirSync, unlinkSync,readFileSync } from 'node:fs';
import {randomBytes} from 'node:crypto';
import {atomicJson,readJson} from '../shared/files.js';
import { managedMarker } from '../install/installation.js';
import {BridgeError} from '../shared/errors.js';
import {atomicWriteText} from '../storage/atomic-file.js';
import {stateDirectory} from '../storage/state-directory.js';
import { ownedProcesses, ownedRecordState, ownedRecordPredatesBoot, currentLinuxBootId, type OwnedProcessRecord } from '../process/owned-processes.js';
import { ownedProcessState, type ProcessState } from '../process/process-stop.js';
import type { SessionProfile } from './codex/codex-session-profile.js';

export interface ManagedRuntime {
  id:string;peerId?:string;owner:string;kind:'owned'|'legacy';state:'starting'|'ready'|'failed';
  endpoint:string;pid?:number;procStart?:string;wrapperPid?:number;wrapperProcStart?:string;
  configHome?:string;launchMethod?:string;createdAt:number;error?:string;failureCode?:string;launchSettled?:boolean;bootstrapRevision?:string;
  dedicated?:boolean;executable?:string;version?:string;sessionId?:string;profileId?:string;authenticatedLoopback?:boolean;
  sessionVerification?:{sessionId:string;profile:SessionProfile};
  threadUnloadDelaySecs?:number;bootId?:string;
}
export interface RuntimeRecord {file:string;value:ManagedRuntime}
export const runtimeDirectory=(home:string)=>path.join(home,'run','runtimes');
const tokenFile=(home:string,id:string)=>runtimeFile(home,id).replace(/\.json$/,'.token');
export function createRuntimeToken(home:string,value:ManagedRuntime):string{
  if(!value.authenticatedLoopback||!/^ws:\/\/127\.0\.0\.1:\d+$/.test(value.endpoint))throw new BridgeError('runtime_record_invalid','认证后台必须绑定本地回环地址。');
  const file=tokenFile(home,value.id);atomicWriteText(file,randomBytes(32).toString('hex'),{exclusive:true});return file;
}
                                     
export function managedRuntimeToken(home:string,endpoint:string):string|undefined{
  if(!/^ws:\/\/127\.0\.0\.1:\d+$/.test(endpoint))return;
  const runtime=runtimeFor(home,{endpoint})?.value;if(!runtime?.authenticatedLoopback)return;
  if(runtime.state==='failed'||!runtime.pid||!runtime.procStart||runtimePredatesBoot(runtime))throw new BridgeError('runtime_endpoint_unverified','后台原生代次尚未核验，未使用认证凭证。');
  const token=readFileSync(tokenFile(home,runtime.id),'utf8').trim();
  if(!/^[a-f0-9]{64}$/i.test(token))throw new BridgeError('runtime_token_invalid','托管后台的认证凭证损坏，已保留该后台；请等它正常退出后重新创建。');
  return token;
}
export async function assertManagedRuntimeEndpoint(home:string,endpoint:string,verified?:{pid:number;procStart:string}):Promise<void>{
  if(!/^ws:\/\/127\.0\.0\.1:\d+$/.test(endpoint))return;
  const runtime=runtimeFor(home,{endpoint})?.value;if(!runtime?.authenticatedLoopback)return;
  const known=verified&&verified.pid===runtime.pid&&verified.procStart===runtime.procStart?'alive':undefined;
  if(runtime.state==='failed'||!runtime.pid||!runtime.procStart||await managedRuntimeNativeState(home,runtime,known)!=='alive')throw new BridgeError('runtime_endpoint_unverified','认证后台的原生进程代次未确认存活，未连接或发送凭证。');
}
export async function managedRemoteAuthentication(home:string,args:string[]):Promise<{args:string[];env:Record<string,string>} >{
  let endpoint:string|undefined;for(let index=0;index<args.length;index++){if(args[index]==='--')break;if(args[index]==='--remote')endpoint=args[index+1];else if(args[index]!.startsWith('--remote='))endpoint=args[index]!.slice(9);}
  if(!endpoint||args.some(arg=>arg==='--remote-auth-token-env'||arg.startsWith('--remote-auth-token-env=')))return{args,env:{}};
  await assertManagedRuntimeEndpoint(home,endpoint);
  const token=managedRuntimeToken(home,endpoint);return token?{args:['--remote-auth-token-env','NXBRIDGE_CODEX_REMOTE_TOKEN',...args],env:{NXBRIDGE_CODEX_REMOTE_TOKEN:token}}:{args,env:{}};
}
export function runtimeFile(home:string,id:string):string{
  if(!/^[a-f0-9-]{36}$/i.test(id))throw new BridgeError('runtime_identity_invalid','运行时标识无效。');
  return path.join(runtimeDirectory(home),id+'.json');
}
export function saveManagedRuntime(home:string,value:ManagedRuntime):void{
  const file=runtimeFile(home,value.id);
  if(!existsSync(file)&&value.bootId===undefined){const bootId=currentLinuxBootId();if(bootId)value.bootId=bootId;}
  stateDirectory(runtimeDirectory(home),0o700);atomicJson(file,value);
}
export function managedRuntimes(home:string):RuntimeRecord[]{
  const directory=runtimeDirectory(home),result:RuntimeRecord[]=[];
  for(const name of existsSync(directory)?readdirSync(directory):[]){
    if(!/^[a-f0-9-]{36}\.json$/i.test(name))continue;
    const file=path.join(directory,name);let value:ManagedRuntime;
    try{value=readJson<ManagedRuntime>(file);}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')continue;throw new BridgeError('runtime_record_invalid','运行时记录无法读取，请保留后检查：'+file);}
    if(value.id+'.json'!==name||value.owner!==managedMarker(home))throw new BridgeError('runtime_record_invalid','运行时记录身份不符，请保留后检查：'+file);
    result.push({file,value});
  }
  const legacy=path.join(home,'run','codex-runtime.json');
  if(existsSync(legacy)){
    const value=readJson<Omit<ManagedRuntime,'id'|'owner'|'kind'|'state'>>(legacy);
    if(!result.some(r=>r.value.endpoint===value.endpoint))result.push({file:legacy,value:{...value,id:'legacy',owner:managedMarker(home),kind:'legacy',state:'ready'}});
  }
  return result;
}
export function runtimeFor(home:string,selector:{peerId?:string;endpoint?:string;id?:string}):RuntimeRecord|undefined{
  const found=managedRuntimes(home).filter(r=>(selector.peerId===undefined||r.value.peerId===selector.peerId)&&(selector.endpoint===undefined||r.value.endpoint===selector.endpoint)&&(selector.id===undefined||r.value.id===selector.id));
  const active=found.filter(r=>r.value.state!=='failed');
  if(active.length>1)throw new BridgeError('runtime_ambiguous','该成员有多个尚未核验结束的运行时，未启动第二个。');
  return active[0]??found.sort((a,b)=>b.value.createdAt-a.value.createdAt)[0];
}
                                   
export function localCodexEndpoint(home:string|undefined,endpoint:string):boolean{
  if(endpoint.startsWith('unix://'))return true;
  if(!home||!/^ws:\/\/127\.0\.0\.1:\d+$/.test(endpoint))return false;
  try{const runtime=runtimeFor(home,{endpoint})?.value;return runtime?.kind==='owned'&&runtime.state!=='failed'&&runtime.authenticatedLoopback===true&&!runtimePredatesBoot(runtime);}catch{return false;}
}
export function removeManagedRuntime(record:RuntimeRecord):void{
  if(!existsSync(record.file))return;
  const current=readJson<Partial<ManagedRuntime>>(record.file);
  if(current.endpoint!==record.value.endpoint||current.pid!==record.value.pid||current.procStart!==record.value.procStart||current.wrapperPid!==record.value.wrapperPid||current.wrapperProcStart!==record.value.wrapperProcStart||record.value.kind==='owned'&&(current.id!==record.value.id||current.owner!==record.value.owner||current.state!==record.value.state))throw new BridgeError('runtime_changed','运行时记录已改变，保留证据。');
  unlinkSync(record.file);
  if(record.value.authenticatedLoopback){const file=tokenFile(path.dirname(path.dirname(path.dirname(record.file))),record.value.id);if(existsSync(file))unlinkSync(file);}
}

                                
function matchesRuntime(record:OwnedProcessRecord,runtime:ManagedRuntime):boolean{return record.proof.launchId===runtime.id||runtime.kind==='legacy'&&record.proof.launchId===runtime.endpoint;}
function runtimePredatesBoot(runtime:ManagedRuntime,records:OwnedProcessRecord[]=[]):boolean{
  if(process.platform!=='linux')return false;
  const current=currentLinuxBootId();
  return!!runtime.bootId&&!!current&&runtime.bootId!==current||records.some(record=>matchesRuntime(record,runtime)&&ownedRecordPredatesBoot(record));
}
export async function managedRuntimeState(home:string,runtime:ManagedRuntime):Promise<ProcessState>{
  const proof=ownedProcesses(home),identities=new Map<string,{identity:{pid:number;startedAt:string};record?:OwnedProcessRecord}>();
  if(runtimePredatesBoot(runtime,proof.records))return'dead';
  let containerProof=false;
  for(const [pid,startedAt] of [[runtime.pid,runtime.procStart],[runtime.wrapperPid,runtime.wrapperProcStart]] as const)if(pid&&startedAt)identities.set(pid+':'+startedAt,{identity:{pid,startedAt}});
  for(const record of proof.records)if(matchesRuntime(record,runtime)){
    if(record.windowsJob||record.posixGroup)containerProof=true;
    const key=record.identity.pid+':'+record.identity.startedAt,previous=identities.get(key)?.record;
    if(!previous?.windowsJob&&!previous?.posixGroup)identities.set(key,{identity:record.identity,record});
  }
  const states=await Promise.all([...identities.values()].map(value=>value.record?ownedRecordState(value.record):ownedProcessState(value.identity)));
  if(states.includes('alive'))return'alive';
  if(states.includes('unknown'))return'unknown';
  if(!runtime.pid&&!runtime.launchSettled&&!containerProof)return'unknown';
  return identities.size||runtime.launchSettled?'dead':'unknown';
}

                                                     
export async function managedRuntimeNativeState(home:string,runtime:ManagedRuntime,knownNativeState?:ProcessState):Promise<ProcessState>{
  if(runtimePredatesBoot(runtime))return'dead';
  if(runtime.pid&&runtime.procStart&&(process.platform!=='linux'||runtime.bootId))return knownNativeState??ownedProcessState({pid:runtime.pid,startedAt:runtime.procStart});
  const records=ownedProcesses(home).records.filter(record=>matchesRuntime(record,runtime));
  if(runtimePredatesBoot(runtime,records))return'dead';
  if(runtime.pid&&runtime.procStart)return knownNativeState??ownedProcessState({pid:runtime.pid,startedAt:runtime.procStart});
  const natives=new Map(records.filter(record=>record.native).map(record=>[record.native!.pid+':'+record.native!.startedAt,record.native!]));
  if(natives.size>1)return'unknown';
  if(natives.size)return ownedProcessState([...natives.values()][0]!);
                                                        
  return managedRuntimeState(home,runtime);
}

