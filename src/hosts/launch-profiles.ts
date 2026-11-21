import { existsSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {atomicJson,readJson,sameDirectory} from '../shared/files.js';
import { processAncestors, processIdentity, codexIsManagedDaemon } from '../process/process.js';
import { cleanInstanceEnvironment, neutralEnvironment, configHomeFor } from '../process/environment.js';
import {BridgeError} from '../shared/errors.js';
import {type Host,type Peer,type Endpoint} from '../types.js';
import { acquireHostControl, hostControlFailure } from './host-control.js';
import { managedRuntimes, type ManagedRuntime } from './managed-runtimes.js';
import { relaunchHostImage } from './host-image.js';
import {profileVersionSupported} from './host-version.js';

const execute=promisify(execFile);
export interface LaunchProfile {id:string;host:Host;exe:string;version:string;configHome:string;cwd:string;env:Record<string,string>;sourceSession:string;sourcePid:number;sourceGeneration:string;capturedAt:number;dropped:string[];kind?:'daemon'|'managed'}
export interface ProfileState {version:1;profiles:LaunchProfile[];observations?:(LaunchProfile&{owned?:boolean})[];preferred:Partial<Record<Host,string>>}
export interface LaunchCapture {host:Host;sessionId:string;nativePid:number;nativeGeneration:string;sourcePid:number;sourceGeneration:string;env:Record<string,string>;force?:boolean}
const filename=(home:string)=>path.join(home,'launch-profiles.json');
export function profileState(home:string):ProfileState{return existsSync(filename(home))?readJson<ProfileState>(filename(home)):{version:1,profiles:[],preferred:{}};}
export function profileMetadata(profile:LaunchProfile){const {env,...metadata}=profile;return{...metadata,variableCount:Object.keys(env).length};}
export function setPreferredProfiles(home:string,preferred:ProfileState['preferred']):void{
  const state=profileState(home);if(JSON.stringify(state.preferred)===JSON.stringify(preferred))return;state.preferred=preferred;atomicJson(filename(home),state);
}
export function saveUserProfile(home:string,profile:LaunchProfile):LaunchProfile{
  const state=profileState(home);updateUserProfile(state,profile);atomicJson(filename(home),state);return profile;
}
function updateUserProfile(state:ProfileState,profile:LaunchProfile):void{
  const old=state.profiles.find(value=>value.host===profile.host&&sameDirectory(value.exe,profile.exe)&&sameDirectory(value.configHome,profile.configHome)&&sameDirectory(value.cwd,profile.cwd));
  if(old)profile.id=old.id;state.profiles=state.profiles.filter(value=>value.id!==profile.id);state.profiles.push(profile);
}
export function profileAvailability(profile:LaunchProfile){
  const executable=relaunchHostImage(profile.exe,profile.host);
  const reason=!existsSync(executable)?'exe_missing':!existsSync(profile.configHome)?'home_missing':!existsSync(profile.cwd)?'cwd_missing':undefined;
  const labels={exe_missing:'程序已不存在',home_missing:'配置目录已不存在',cwd_missing:'项目目录已不存在'};
  return{available:!reason,executable,...(executable!==profile.exe?{updatedFrom:profile.exe}:{}),...(reason?{reason,label:labels[reason]}:{})};
}
export function chooseUserProfile(home:string,host:Host,cwd:string,state=profileState(home)):{profile?:LaunchProfile;configHome?:string;notes:string[]}{
  const profiles=state.profiles.filter(value=>value.host===host).sort((a,b)=>b.capturedAt-a.capturedAt),session=state.preferred[host];
  const paired=session?profiles.find(value=>value.sourceSession===session):undefined;
  if(paired)return{profile:paired,notes:sameDirectory(paired.cwd,cwd)?[]:[`沿用当前配对窗口的启动环境（记录自 ${paired.cwd}）；新会话在 ${cwd} 中启动。`]};
                                     
                                
  let profile=profiles.find(value=>sameDirectory(value.cwd,cwd))??profiles.find(value=>existsSync(value.cwd));
  if(!profile)return{configHome:profiles[0]?.configHome,notes:profiles.length?[`之前记录的 ${host} 启动方式都来自已不存在的项目目录，这次改用${process.platform==='win32'?'系统保存的环境变量和 PATH':'当前进程继承并过滤会话变量后的环境和 PATH'}启动。以后你在常用项目里正常打开 ${host} 时，会自动重新记录。`]:[]};
  const original=profile,availability=profileAvailability(profile);
                                          
  if(availability.available&&availability.updatedFrom)return{profile,notes:sameDirectory(profile.cwd,cwd)?[]:[`这个目录没有启动记录，沿用 ${profile.cwd} 的记录；新会话在 ${cwd} 中启动。`]};
  const candidates=[...profiles,...(state.observations??[]).filter(value=>value.host===host&&!!value.kind)].filter(value=>sameDirectory(value.configHome,original.configHome)&&profileAvailability(value).available);
  if(!availability.available){
    profile=candidates.find(value=>sameDirectory(value.cwd,cwd))??candidates[0];
    if(!profile)return{configHome:original.configHome,notes:[`之前记录的 ${host} 程序都已不存在，这次改用${process.platform==='win32'?'系统保存的环境变量和 PATH':'当前进程继承并过滤会话变量后的环境和 PATH'}中的 ${host}，配置目录仍是 ${original.configHome}。以后你正常打开 ${host} 时，会自动记下新的程序位置。`]};
  }
  for(const candidate of candidates)if(profileVersionSupported(candidate.version,profile.version)&&!profileVersionSupported(profile.version,candidate.version))profile=candidate;
  return{profile,notes:[...(!availability.available?[`之前选用的 ${host} 记录已不可用（${availability.label}），改用同一配置目录下的另一份记录：${relaunchHostImage(profile.exe,host)}（记录自 ${profile.cwd}）。`]:[]),...(sameDirectory(profile.cwd,cwd)?[]:[`这个目录没有启动记录，沿用 ${profile.cwd} 的记录；新会话在 ${cwd} 中启动。`])]};
}

export async function captureUserLaunch(home:string,capture:LaunchCapture,peer:Peer,expectedPid?:number|null,dependencies:{ancestors?:typeof processAncestors;version?:(exe:string,env:NodeJS.ProcessEnv)=>Promise<string>;owned?:boolean}={}):Promise<{configHome:string;profile?:LaunchProfile;owned:boolean;cached?:boolean}>{
  const initial=profileState(home);
  const runtime=capture.host==='codex'?managedRuntimes(home).map(record=>record.value).find(value=>value.pid===capture.nativePid&&value.procStart===capture.nativeGeneration):undefined;
  const previous=initial.observations?.find(value=>value.host===capture.host&&value.sourceSession===capture.sessionId&&value.sourcePid===capture.nativePid&&value.sourceGeneration===capture.nativeGeneration);
  const owned=!!previous?.owned||!!dependencies.owned||peer.owner==='nxbridge'||!!capture.env.NXBRIDGE_OWNED_LAUNCH||runtime?.pid===capture.nativePid&&runtime.procStart===capture.nativeGeneration;
                                      
  if(previous&&!capture.force&&(!expectedPid||expectedPid===capture.nativePid)&&!!previous.owned===owned)return{configHome:previous.configHome,owned,cached:true,profile:owned?undefined:initial.profiles.find(value=>value.sourceSession===capture.sessionId&&value.sourcePid===capture.nativePid&&value.sourceGeneration===capture.nativeGeneration)};
  const chain=await(dependencies.ancestors??processAncestors)(capture.sourcePid,16),nativeIndex=chain.findIndex(value=>value.pid===capture.nativePid&&value.startedAt===capture.nativeGeneration),source=chain[0],native=chain[nativeIndex];
  if(!source||source.startedAt!==capture.sourceGeneration||!native||!new RegExp('^'+capture.host+'(?:\\.exe)?$','i').test(native.name)||expectedPid&&expectedPid!==native.pid||chain.slice(0,nativeIndex).some(value=>/^(?:cmd|powershell|pwsh|bash|zsh|sh)(?:\.exe)?$/i.test(value.name)))throw new BridgeError('launch_capture_unverified','无法确认这份启动环境来自该窗口自身，未记录。');
  const scopedHome=capture.env[capture.host==='codex'?'CODEX_HOME':'CLAUDE_CONFIG_DIR'];
  const configHome=scopedHome?path.resolve(peer.cwd,scopedHome):configHomeFor(capture.host,capture.env);
  const exe=native.launchImage??native.image;
  if(!exe||!path.isAbsolute(exe)||!existsSync(exe))throw new BridgeError('launch_image_missing','无法确认该窗口实际运行的程序路径，未记录启动环境。');
  const clean=cleanInstanceEnvironment(capture.env),existing=[...initial.profiles,...(initial.observations??[])].find(value=>value.host===capture.host&&value.sourcePid===native.pid&&value.sourceGeneration===native.startedAt);
  const probeVersion=async()=>{const release=await acquireHostControl(exe!);try{return(await execute(exe!,['--version'],{env:clean.env,encoding:'utf8',windowsHide:true,timeout:10000})).stdout.trim();}catch(error){throw hostControlFailure(capture.host,['--version'],error);}finally{release();}};
  const version=existing?.version??(dependencies.version?await dependencies.version(exe,clean.env):await probeVersion());
  const stable=owned&&runtime?.executable?runtime.executable:exe,kind=owned?(previous?.kind??(runtime?'managed':undefined)):undefined;
  const value:LaunchProfile={id:existing?.id??randomUUID(),host:capture.host,exe:stable,version,configHome,cwd:peer.cwd,env:kind?{}:clean.env as Record<string,string>,sourceSession:peer.sessionId!,sourcePid:native.pid,sourceGeneration:native.startedAt,capturedAt:Date.now(),dropped:clean.report.dropped,...(kind?{kind}:{})};
                                   
  const state=profileState(home);
  if(owned)state.profiles=state.profiles.filter(item=>item.host!==capture.host||item.sourceSession!==capture.sessionId);
  else updateUserProfile(state,value);
  state.observations=[...(state.observations??[]).filter(item=>item.host!==capture.host||item.sourceSession!==capture.sessionId),{...value,owned}];
  atomicJson(filename(home),state);
  if(owned)return{configHome,owned:true};
  return{configHome,profile:value,owned:false};
}

export async function currentLaunchCapture(host:Host,sessionId:string,native:{pid:number;procStart:string}):Promise<LaunchCapture>{
  const source=await processIdentity(process.pid);
  return{host,sessionId,nativePid:native.pid,nativeGeneration:native.procStart,sourcePid:process.pid,sourceGeneration:source.startedAt,env:Object.fromEntries(Object.entries(process.env).filter((value):value is [string,string]=>typeof value[1]==='string'))};
}

                                                           
export function recordManagedSessionLaunch(home:string,sessionId:string,cwd:string,runtime:ManagedRuntime):void{
  if(runtime.kind!=='owned'||runtime.state!=='ready'||!runtime.dedicated||!runtime.executable||!runtime.configHome||!runtime.pid||!runtime.procStart)return;
  const state=profileState(home),previous=state.observations?.find(value=>value.host==='codex'&&value.sourceSession===sessionId);
  if(previous?.kind==='managed'&&previous.sourcePid===runtime.pid&&previous.sourceGeneration===runtime.procStart&&previous.exe===runtime.executable&&sameDirectory(previous.configHome,runtime.configHome))return;
  const value:LaunchProfile={id:randomUUID(),host:'codex',kind:'managed',exe:runtime.executable,version:runtime.version??'版本未知',configHome:runtime.configHome,cwd,env:{},sourceSession:sessionId,sourcePid:runtime.pid,sourceGeneration:runtime.procStart,capturedAt:Date.now(),dropped:[]};
  state.observations=[...(state.observations??[]).filter(item=>item.host!=='codex'||item.sourceSession!==sessionId),{...value,owned:true}];atomicJson(filename(home),state);
}

                                           
export async function captureDaemonLaunch(home:string,peer:Pick<Peer,'sessionId'|'cwd'>,endpoint:Pick<Endpoint,'daemon'|'pid'|'procStart'|'configHome'>,dependencies:{identity?:typeof processIdentity;daemon?:typeof codexIsManagedDaemon;version?:(exe:string)=>Promise<string>}={}):Promise<LaunchProfile|undefined>{
  if(!peer.sessionId||!endpoint.daemon||!endpoint.pid||!endpoint.procStart||!endpoint.configHome)return;
  const state=profileState(home),previous=state.observations?.find(value=>value.host==='codex'&&value.kind==='daemon'&&value.sourceSession===peer.sessionId&&value.sourcePid===endpoint.pid&&value.sourceGeneration===endpoint.procStart&&sameDirectory(value.configHome,endpoint.configHome!));
  if(previous)return previous;
  const identity=dependencies.identity??processIdentity,native=await identity(endpoint.pid);
  if(native.startedAt!==endpoint.procStart||!native.image||!await(dependencies.daemon??codexIsManagedDaemon)(native))throw new BridgeError('launch_capture_unverified','共享 daemon 的映像或进程代次无法核验，未记录。');
  const exe=relaunchHostImage(native.image,'codex'),existing=state.observations?.find(value=>value.kind==='daemon'&&value.sourcePid===native.pid&&value.sourceGeneration===native.startedAt&&value.exe===exe);
  const version=existing?.version??await(dependencies.version??(async file=>{const release=await acquireHostControl(file);try{return(await execute(file,['--version'],{env:neutralEnvironment().env,windowsHide:true,timeout:8000})).stdout.trim();}finally{release();}}))(exe);
  if((await identity(endpoint.pid)).startedAt!==endpoint.procStart)throw new BridgeError('launch_capture_unverified','共享 daemon 在记录期间改变，未记录旧入口。');
  const value:LaunchProfile={id:randomUUID(),host:'codex',kind:'daemon',exe,version,configHome:endpoint.configHome,cwd:peer.cwd,env:{},sourceSession:peer.sessionId,sourcePid:native.pid,sourceGeneration:native.startedAt,capturedAt:Date.now(),dropped:[]};
  const current=profileState(home);current.observations=[...(current.observations??[]).filter(item=>item.host!=='codex'||item.sourceSession!==peer.sessionId),{...value,owned:true}];atomicJson(filename(home),current);return value;
}
