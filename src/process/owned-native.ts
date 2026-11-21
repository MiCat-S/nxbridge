import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, unlinkSync } from 'node:fs';
import {atomicJson,readJson} from '../shared/files.js';
import { claudeBackgroundHost, matchesProcess, processAncestors, processIdentity, type ProcessIdentity } from './process.js';
import { ownedProcessState } from './process-stop.js';
import { ownedProcesses, prepareProcessRegistry, processRegistryDirectory, recordOwnedProcess } from './owned-processes.js';
import {BridgeError,describeError} from '../shared/errors.js';
import {type Peer} from '../types.js';
import type {SessionRecord} from '../hosts/claude/claude-inbox.js';
import { sameHostImage } from '../hosts/host-launch.js';

export interface NativeOwnership {
  version:1;id:string;home:string;peerId:string;configHome:string;phase:'intent'|'bound'|'failed';createdAt:number;failure?:string;
  sessionId?:string;handle?:string;scope?:string;native?:{pid:number;startedAt:string};nativeImage?:string;supervisor?:{pid:number;startedAt:string};releasedToUser?:boolean;
  executable?:string;profileId?:string;hostVersion?:string;
}
export async function nativeSupervisorAvailable(configHome:string):Promise<boolean>{
  return !!await nativeSupervisorIdentity(configHome);
}
async function nativeSupervisorIdentity(configHome:string):Promise<ProcessIdentity|undefined>{
  const filename=path.join(configHome,'daemon.status.json');if(!existsSync(filename))return;
  const value=readJson<{supervisorPid?:number;supervisorProcStart?:string;pid?:number;procStart?:string}>(filename),pid=value.supervisorPid??value.pid,generation=value.supervisorProcStart??value.procStart;
  if(!pid||!generation)return;
  try{const identity=await processIdentity(pid);return matchesProcess({procStart:generation},identity)?identity:undefined;}catch(error){if((error as BridgeError).code==='process_missing')return;throw error;}
}
const file=(home:string,peerId:string)=>path.join(processRegistryDirectory(home),'native-'+peerId+'.json');
export function nativeOwnership(home:string,peerId:string):NativeOwnership|undefined{
  let value:NativeOwnership;
  try{value=readJson<NativeOwnership>(file(home,peerId));}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return;throw error;}
                               
  if(value.version!==1)throw new BridgeError('process_record_invalid','原生后台归属记录来自其他版本，未停止。');
  return value;
}
export function saveNativeOwnership(value:NativeOwnership):void{
                                             
  const filename=file(value.home,value.peerId);mkdirSync(path.dirname(filename),{recursive:true,mode:0o700});atomicJson(filename,value);
}
export function nativeOwnershipForSession(home:string,sessionId:string):NativeOwnership|undefined{
  const matches=nativeOwnershipRecords(home).filter(value=>value.sessionId===sessionId);
  if(matches.length>1)throw new BridgeError('ambiguous_background','同一原生会话存在多份启动归属，未停止。');return matches[0];
}
const readFailures=new Map<string,string>();
export function nativeOwnershipRecords(home:string,onInvalid?:(peerId:string,note:string)=>void):NativeOwnership[]{
  const directory=processRegistryDirectory(home);let names:string[];
  try{names=readdirSync(directory);}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return[];throw error;}
  return names.filter(name=>/^native-[a-f0-9-]{36}\.json$/.test(name)).flatMap(name=>{
    const peerId=name.slice(7,-5),filename=path.join(directory,name);
    try{const value=nativeOwnership(home,peerId);readFailures.delete(filename);return value?[value]:[];}
    catch(error){
      const note='原生后台归属无法读取，保留原文件，未授权停止 '+filename+'：'+describeError(error);
      if(onInvalid)onInvalid(peerId,note);
      else if(readFailures.get(filename)!==note){readFailures.set(filename,note);try{process.stderr.write(note+'\n');}catch{                    }}
      return[];
    }
  });
}
export async function beginNativeLaunch(home:string,peer:Peer,configHome:string):Promise<NativeOwnership>{
  await prepareProcessRegistry(home);
  const value:NativeOwnership={version:1,id:randomUUID(),home:path.resolve(home),peerId:peer.id,configHome,phase:'intent',createdAt:Date.now(),...(peer.sessionId?{sessionId:peer.sessionId}:{}),...(process.env.NXBRIDGE_TEST_SCOPE?{scope:process.env.NXBRIDGE_TEST_SCOPE}:{})};saveNativeOwnership(value);return value;
}
const nativeHandlePattern=/\bbackgrounded\s*·\s*([a-f0-9-]{8,36})(?=\s*(?:·|\(|$))/i;
export function nativeLaunchHandle(output:string):string{
  const match=nativeHandlePattern.exec(output);
  if(!match)throw new BridgeError('claude_launch_unverified','Claude 后台启动命令的返回结果中没有可核验的会话 handle；已保留启动记录，请运行 nxbridge doctor。');return match[1]!;
}
                                                       
export function failNativeLaunch(intent:NativeOwnership,error:unknown,neverSpawned=false):boolean{
  const value=error as {exitCode?:number;signal?:string;cause?:{stdout?:string;killed?:boolean}};
  if(nativeOwnership(intent.home,intent.peerId)?.id!==intent.id)return false;
  const handle=nativeHandlePattern.exec(String(value.cause?.stdout??''))?.[1];
  if(handle){saveNativeOwnership({...intent,handle});return false;}
  if(!neverSpawned&&(!value.exitCode||value.signal||value.cause?.killed))return false;
  saveNativeOwnership({...intent,phase:'failed',failure:String(error).slice(0,1200)});return true;
}
type NativeSessionObserver=(record:SessionRecord,identity:ProcessIdentity)=>void;
export async function bindNativeLaunch(intent:NativeOwnership,agent:{id?:string;sessionId?:string;pid?:number;kind?:string},observe?:NativeSessionObserver):Promise<NativeOwnership>{
  if(agent.kind!=='background'||!intent.handle||!agent.id||!agent.sessionId||intent.handle!==agent.id||intent.sessionId&&intent.sessionId!==agent.sessionId)throw new BridgeError('claude_launch_unverified','Claude 后台会话列表与本次启动结果不符，未认领其他会话。');
  const current=nativeOwnership(intent.home,intent.peerId);if(current?.id!==intent.id||current.releasedToUser)throw new BridgeError('process_record_changed','后台启动记录已经变化或已交给用户窗口。');
  const bound={...intent,phase:'bound' as const,handle:agent.id,sessionId:agent.sessionId};saveNativeOwnership(bound);
  return captureNativeProcess(bound,agent,observe);
}
export async function captureNativeProcess(binding:NativeOwnership,agent:{id?:string;sessionId?:string;pid?:number;kind?:string},observe?:NativeSessionObserver):Promise<NativeOwnership>{
  const initial=nativeOwnership(binding.home,binding.peerId);
  if(agent.kind!=='background'||binding.phase!=='bound'||binding.handle!==agent.id||binding.sessionId!==agent.sessionId||binding.releasedToUser||initial?.id!==binding.id||initial.releasedToUser)throw new BridgeError('claude_launch_unverified','当前后台进程不是本次启动的，或已交给用户窗口；未认领或停止。');
  if(!agent.pid)return binding;
  const identity=await processIdentity(agent.pid),official=readJson<SessionRecord>(path.join(binding.configHome,'sessions',agent.pid+'.json'));
  if(!/^claude(?:\.exe)?$/i.test(identity.name)||official.sessionId!==binding.sessionId||!matchesProcess(official,identity))throw new BridgeError('claude_launch_unverified','Claude 会话登记与启动结果或进程代次不符。');
  const host=await claudeBackgroundHost(identity);
  const replaced=!!binding.native&&(binding.native.pid!==identity.pid||binding.native.startedAt!==identity.startedAt);
  const supervisor=!binding.supervisor||replaced?await nativeSupervisorIdentity(binding.configHome):undefined;
                                                                  
  const ancestry=host&&supervisor?await processAncestors(host.pid,2):[];
  const linked=!!host&&!!supervisor&&ancestry[0]?.startedAt===host.startedAt&&ancestry[1]?.pid===supervisor.pid&&ancestry[1].startedAt===supervisor.startedAt;
  if(replaced){
                                                                 
    const ownedHost=host&&ownedProcesses(binding.home).records.some(value=>!value.releasedToUser&&value.proof.launchId===binding.id&&value.identity.pid===host.pid&&value.identity.startedAt===host.startedAt);
    const ownedSupervisor=linked&&/^claude(?:\.exe)?$/i.test(supervisor!.name)&&supervisor!.image&&identity.image&&sameHostImage(supervisor!.image,identity.image,'claude')&&(!binding.nativeImage||sameHostImage(binding.nativeImage,identity.image,'claude'));
    if(await ownedProcessState(binding.native!)!=='dead'||!ownedHost&&!ownedSupervisor)throw new BridgeError('process_record_changed','同一 Claude 会话已换成未登记的新进程，未认领用户窗口。');
  }
  if(!ownedProcesses(binding.home).records.some(value=>value.peerId===binding.peerId&&value.identity.pid===identity.pid&&value.identity.startedAt===identity.startedAt))await recordOwnedProcess(binding.home,{role:'claude-native',identity,peerId:binding.peerId,sessionId:binding.sessionId,configHome:binding.configHome,handle:binding.handle,proof:{kind:'native-session',launchId:binding.id}});
  if(host&&!ownedProcesses(binding.home).records.some(value=>value.peerId===binding.peerId&&value.identity.pid===host.pid&&value.identity.startedAt===host.startedAt))await recordOwnedProcess(binding.home,{role:'claude-native',identity:host,peerId:binding.peerId,sessionId:binding.sessionId,configHome:binding.configHome,handle:binding.handle,proof:{kind:'native-session',launchId:binding.id}});
                                                      
  const current=readJson<SessionRecord>(path.join(binding.configHome,'sessions',agent.pid+'.json'));
  if(current.sessionId!==binding.sessionId||!matchesProcess(current,identity))throw new BridgeError('claude_launch_unverified','Claude 会话在归属核验期间已切换或换代。');
  const ownership=nativeOwnership(binding.home,binding.peerId);
  if(ownership?.id!==binding.id||ownership.releasedToUser)throw new BridgeError('process_record_changed','后台归属在核验期间已改变，未覆盖后继启动或用户接管记录。');
  const result={...binding,...(linked?{supervisor:{pid:supervisor!.pid,startedAt:supervisor!.startedAt}}:{}),native:{pid:identity.pid,startedAt:identity.startedAt},nativeImage:identity.image};saveNativeOwnership(result);observe?.(current,identity);return result;
}
export function forgetNativeOwnership(value:NativeOwnership):void{
  if(nativeOwnership(value.home,value.peerId)?.id!==value.id)throw new BridgeError('process_record_changed','后台归属记录已经变化，保留新记录。');
  try{unlinkSync(file(value.home,value.peerId));}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
}
