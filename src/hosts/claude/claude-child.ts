import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { closeSync, existsSync, openSync, readFileSync, readdirSync, unlinkSync } from 'node:fs';
import {atomicJson,readJson} from '../../shared/files.js';
import {bridgeHome} from '../../shared/local-paths.js';
import {delay} from '../../shared/time.js';
import {ensureHome,socketDirectory} from '../../ipc/home.js';
import {loadConfig} from '../../config/load.js';
import { connectBroker, listenBroker } from '../../ipc/ipc.js';
import { installedEntry, registerRuntimeProcess } from '../../install/runtime-install.js';
import { neutralEnvironment } from '../../process/environment.js';
import {prepareOwnedLaunch,recordHostLaunch,spawnSelectedHost} from '../host-launch.js';
import { selectSessionLaunch } from '../session-launch.js';
import { liveProcess, matchesProcess, nativeDescendant, processIdentity, type ProcessIdentity } from '../../process/process.js';
import {BridgeError,describeError} from '../../shared/errors.js';
import {type BridgeConfig,type Peer,type RegisterInput} from '../../types.js';
import { ClaudeStreamHealth } from './claude-stream.js';
import type { TurnHealth } from '../../broker/health/turn-health.js';
import { rotateLog } from '../../storage/logs.js';
import {ownedProcesses,recordOwnedProcess,registerCurrentProcess,releaseOwnedProcess,rememberOwnedChild,type OwnedProcessRecord} from '../../process/owned-processes.js';
import { ownedProcessState, stopOwnedProcess } from '../../process/process-stop.js';
import { disabledMember } from '../../broker/member-control.js';
import { ownedClaudeArgs } from '../owned-launch-policy.js';
import { requireClaudeBypassConsent } from './claude-autonomy.js';
import type { PermissionClass } from '../../types.js';
import { restoreState } from '../../broker/pairing/pair-restore.js';
import { claudeProfileArgs, claudeProfileSettings } from '../../broker/profiles/profile-arguments.js';
import type { ModelProfile } from '../../types.js';
import { modelProfileSchema, profileChangeFailure } from '../../broker/profiles/partner-profile.js';
import { supervisePosixGroup } from '../../process/posix/posix-supervisor.js';

export interface ClaudeChildRecord {
  version:1;peerId:string;sessionId:string;cwd:string;address:string;
  phase:'starting'|'active'|'handoff'|'user'|'stopped'|'failed'|'released';hasSession:boolean;
  worker?:ProcessIdentity;wrapper?:ProcessIdentity;native?:ProcessIdentity;
  foreground?:Pick<ProcessIdentity,'pid'|'startedAt'>;
  configHome?:string;executable?:string;profileId?:string;registration?:RegisterInput;health?:TurnHealth;human?:{kind:'approval'|'question';tool:string};
  handoffId?:string;error?:string;updatedAt:number;
  launchSourcePermission?:PermissionClass;
  modelProfile?:ModelProfile;
}
const key=(id:string)=>createHash('sha256').update(id).digest('hex').slice(0,16);
export const claudeChildFile=(home:string,id:string)=>path.join(home,'run','claude-child-'+key(id)+'.json');
export function claudeChild(home:string,id:string):ClaudeChildRecord|undefined{
  try{const value=readJson<ClaudeChildRecord>(claudeChildFile(home,id));return value.version===1&&value.peerId===id?value:undefined;}catch{return;}
}
export function findClaudeChild(home:string,sessionId:string):ClaudeChildRecord|undefined{
  if(!existsSync(path.join(home,'run')))return;
  const records=readdirSync(path.join(home,'run')).filter(n=>/^claude-child-[a-f0-9]+\.json$/.test(n)).flatMap(n=>{try{return[readJson<ClaudeChildRecord>(path.join(home,'run',n))];}catch{return[];}}).filter(v=>v.version===1&&v.sessionId===sessionId);
  if(records.length>1)throw new BridgeError('ambiguous_endpoint','同一 Claude 会话有多个托管记录，未启动新进程。');return records[0];
}
export function claudeHistoryExists(configHome:string,sessionId:string):boolean{
  const projects=path.join(configHome,'projects');if(!/^[a-f0-9-]{36}$/i.test(sessionId)||!existsSync(projects))return false;
  return readdirSync(projects,{withFileTypes:true}).some(item=>item.isDirectory()&&existsSync(path.join(projects,item.name,sessionId+'.jsonl')));
}
async function alive(identity?:Pick<ProcessIdentity,'pid'|'startedAt'>):Promise<boolean>{
  if(!identity||!liveProcess(identity.pid))return false;
  try{return(await processIdentity(identity.pid)).startedAt===identity.startedAt;}catch(error){if((error as BridgeError).code==='process_missing')return false;throw error;}
}
async function stopProcess(home:string,identity?:Pick<ProcessIdentity,'pid'|'startedAt'>):Promise<void>{
  if(!identity)return;
  const records=ownedProcesses(home).records.filter(value=>value.identity.pid===identity.pid&&value.identity.startedAt===identity.startedAt),proof=records.find(value=>value.windowsJob||value.posixGroup)??records[0];
  if(proof)await releaseOwnedProcess(proof);else await stopOwnedProcess(identity);
}
async function waitDead(identities:(Pick<ProcessIdentity,'pid'|'startedAt'>|undefined)[],timeout=4000):Promise<boolean>{
  const end=Date.now()+timeout;while((await Promise.all(identities.map(alive))).some(Boolean)){if(Date.now()>end)return false;await delay(50);}return true;
}
export async function childCall<T=ClaudeChildRecord>(home:string,record:ClaudeChildRecord,method:'status'|'interrupt'|'stop'|'profile'|'profile.get',params:unknown={},timeout=method==='profile'?10000:7000):Promise<T>{
  const rpc=await connectBroker(home,1000,record.address).catch(error=>{throw method==='profile'?profileChangeFailure(error,false):error;});try{return await rpc.request<T>(method,params,{timeout,mutation:!['status','profile.get'].includes(method)});}finally{rpc.close();}
}
export function childHandoff(home:string,id:string,phase:'user'|'stopped',handoffId:string,profile?:ModelProfile):void{
  const record=claudeChild(home,id);if(!record||record.handoffId!==handoffId||!['handoff','user'].includes(record.phase))throw new BridgeError('handoff_changed','前台接管请求已经改变，请重新运行 nxbridge open claude。');
  atomicJson(claudeChildFile(home,id),{...record,phase,...(profile?{modelProfile:{...record.modelProfile,...profile}}:{}),updatedAt:Date.now()});
}
export function recordClaudeForeground(home:string,id:string,pid:number,startedAt:string):void{
  const record=claudeChild(home,id);if(record?.phase!=='user'||record.foreground?.pid===pid&&record.foreground.startedAt===startedAt)return;
  atomicJson(claudeChildFile(home,id),{...record,foreground:{pid,startedAt},updatedAt:Date.now()});
}
export async function ensureClaudeChild(home:string,config:BridgeConfig,peer:Peer,beforeLaunch?:()=>void|Promise<void>,sourcePermission?:PermissionClass,beforeCreate?:()=>void|Promise<void>,profile?:ModelProfile):Promise<ClaudeChildRecord>{
  const requireEnabled=()=>{if(disabledMember(home,{host:'claude',memberId:peer.id}))throw new BridgeError('member_disabled','此成员的 nxbridge 已关闭，未启动或恢复后台。');};requireEnabled();
  if(process.platform!=='linux')throw new BridgeError('claude_child_unsupported','此平台尚不支持托管 Claude 子进程。');
  await ensureHome(home);let previous=claudeChild(home,peer.id);
  if(previous&&peer.sessionId&&previous.sessionId!==peer.sessionId)throw new BridgeError('session_changed','托管 Claude 记录与当前配对会话不符。');
  if(previous&&['handoff','user'].includes(previous.phase))throw new BridgeError('claude_handoff','Claude 正在等待前台接管；运行 nxbridge open claude 完成接管。');
  if(previous?.foreground&&!await waitDead([previous.foreground]))throw new BridgeError('claude_foreground_active','原生前台窗口尚未退出，未恢复第二个 Claude 实例。');
  if(previous&&await alive(previous.worker)){
    const current=await childCall(home,previous,'status');if(current.phase==='active'&&current.registration)return current;
    if(current.phase==='failed')throw new BridgeError('claude_child_failed',current.error??'托管 Claude 启动失败。');
  }else if(previous){
                                                
    if(previous.wrapper&&!previous.native){
      const wrapper=previous.wrapper,container=ownedProcesses(home).records.find(value=>value.identity.pid===wrapper.pid&&value.identity.startedAt===wrapper.startedAt);
      if(!container?.posixGroup&&!container?.windowsJob&&await alive(wrapper))previous.native=await nativeDescendant(wrapper.pid,'claude',0);
    }
    requireEnabled();await stopProcess(home,previous.native);requireEnabled();await stopProcess(home,previous.wrapper);
  }
  if(!previous||!await alive(previous.worker)){
    const launch=await prepareOwnedLaunch(await selectSessionLaunch('claude',config,{home,cwd:peer.cwd,sessionId:peer.sessionId??undefined,configHome:previous?.configHome,executable:previous?.executable,profileId:previous?.profileId}));
    if(peer.sessionId&&restoreState(peer,launch.configHome)==='gone')throw new BridgeError('session_not_found','原配置目录中没有该 Claude 会话，请先恢复原会话文件。');
    const directory=await socketDirectory(home),hasSession=previous?.hasSession||!!(previous?.configHome&&claudeHistoryExists(previous.configHome,previous.sessionId))||!previous&&!!peer.sessionId,record:ClaudeChildRecord={version:1,peerId:peer.id,sessionId:peer.sessionId??previous?.sessionId??randomUUID(),cwd:peer.cwd,address:path.join(directory,'cc-'+key(peer.id)+'.sock'),phase:'starting',hasSession,configHome:launch.configHome,executable:launch.executable.command,profileId:launch.profile?.id,updatedAt:Date.now()};
                                               
    record.launchSourcePermission=previous?.launchSourcePermission??(!hasSession?sourcePermission:undefined);
    record.modelProfile=profile??previous?.modelProfile;
    if(record.launchSourcePermission!==undefined)requireClaudeBypassConsent(launch.configHome,peer.cwd);
    requireEnabled();await beforeLaunch?.();requireEnabled();atomicJson(claudeChildFile(home,peer.id),record);const runtime=installedEntry(home),env=neutralEnvironment({NXBRIDGE_HOME:home}).env,log=path.join(home,'run','claude-child.log');rotateLog(log,1024*1024,2);const fd=openSync(log,'a',0o600);
                                                     
    let child:ReturnType<typeof spawn>;
    try{await beforeCreate?.();child=spawn(runtime.node,['--no-warnings',runtime.entry,'claude-worker',peer.id],{env,detached:true,windowsHide:true,stdio:['ignore',fd,fd]});}
    finally{closeSync(fd);}
    child.on('error',()=>{});child.unref();previous=record;
    await rememberOwnedChild(home,child,'claude-worker',{peerId:peer.id,sessionId:record.sessionId,configHome:record.configHome,posixGroup:true});
  }
  const end=Date.now()+25000;
  while(Date.now()<end){
    const current=claudeChild(home,peer.id);
    if(current?.phase==='active'&&current.registration&&await alive(current.worker))return current;
    if(current?.phase==='failed')throw new BridgeError('claude_child_failed',current.error??'托管 Claude 启动失败。');
    await delay(100);
  }
  throw new BridgeError('claude_child_pending','托管 Claude 尚未发布原生 inbox；消息仍保留，请运行 doctor 检查启动命令或打开前台 Claude。');
}
export async function stopClaudeChild(home:string,record:ClaudeChildRecord,handoffId?:string):Promise<ClaudeChildRecord>{
  if(await alive(record.worker)){
    try{const result=await childCall<ClaudeChildRecord>(home,record,'stop',{...(handoffId?{handoffId}:{})},12000);
      if(!await waitDead([result.worker,result.wrapper,result.native]))throw new BridgeError('claude_child_stopping','Claude 托管进程尚未完全退出，未启动前台副本。');await stopProcess(home,result.worker);return result;
    }catch(error){if(record.phase!=='failed'||!await waitDead([record.worker,record.wrapper,record.native]))throw error;}
  }
  if(record.foreground&&await alive(record.foreground))throw new BridgeError('process_owned_by_user','原生前台窗口仍在运行，未停止用户窗口。');
  for(const identity of [record.native,record.wrapper,record.worker])if(identity){
    const records=ownedProcesses(home).records.filter(value=>value.peerId===record.peerId&&value.identity.pid===identity.pid&&value.identity.startedAt===identity.startedAt),proof=records.find(value=>value.windowsJob||value.posixGroup)??records[0];
    if(!proof){if(await ownedProcessState(identity)==='dead')continue;throw new BridgeError('claude_child_orphan','托管父进程已退出，子进程缺少可核验的启动归属；保留进程和记录，请运行 doctor。');}
    await releaseOwnedProcess(proof);
  }
  const result={...record,phase:handoffId?'handoff' as const:'released' as const,...(handoffId?{handoffId}:{}),updatedAt:Date.now()};atomicJson(claudeChildFile(home,record.peerId),result);return result;
}

export async function runClaudeWorker(peerId:string):Promise<void>{
  const home=bridgeHome(),file=claudeChildFile(home,peerId);let record=claudeChild(home,peerId);
  if(!record||record.phase!=='starting')throw new BridgeError('claude_worker_record','缺少有效的托管 Claude 启动记录。');
  const state=record,health=new ClaudeStreamHealth(),pending=new Map<string,{resolve:(value?:unknown)=>void;reject:(e:Error)=>void;timer:NodeJS.Timeout}>();
  let stopping=false,closed=false,dirty=false,finished=false,child:ReturnType<typeof spawnSelectedHost>|undefined,timer:NodeJS.Timeout|undefined,server:Awaited<ReturnType<typeof listenBroker>>|undefined,runtime:Awaited<ReturnType<typeof registerRuntimeProcess>>|undefined,ownership:OwnedProcessRecord|undefined;
  const save=()=>{if(!state.hasSession&&state.configHome)state.hasSession=claudeHistoryExists(state.configHome,state.sessionId);state.health=health.get();state.human=health.human;state.updatedAt=Date.now();atomicJson(file,state);dirty=false;};
  const controlRequest=async(request:Record<string,unknown>):Promise<unknown>=>{
    if(!child?.stdin?.writable)throw profileChangeFailure(new BridgeError('claude_child_offline','托管 Claude 已离线。'),false);
    const requestId=randomUUID();return new Promise((resolve,reject)=>{const timeout=setTimeout(()=>{pending.delete(requestId);reject(new BridgeError(request.subtype==='interrupt'?'claude_interrupt_timeout':'claude_profile_timeout','Claude 尚未确认控制请求；未自动重试。'));},4000);pending.set(requestId,{resolve,reject,timer:timeout});child!.stdin!.write(JSON.stringify({type:'control_request',request_id:requestId,request})+'\n',error=>{if(error){clearTimeout(timeout);pending.delete(requestId);reject(error);}});});
  };
  const interrupt=()=>controlRequest({subtype:'interrupt'});
  const readProfile=async(profile?:ModelProfile)=>{
    const settings=await controlRequest({subtype:'get_settings'}) as {effective?:ModelProfile;sources?:{source:string;settings:ModelProfile}[];applied?:{model?:string;effort?:string|number}};
    if(!settings?.applied?.model)throw new BridgeError('profile_verification_failed','Claude 没有报告实际模型，消息暂缓投递。');
    const raw=settings.effective?.model,echo=raw&&settings.sources?.find(source=>source.source==='flagSettings')?.settings.model===raw;
    if(profile?.model&&(raw!==profile.model||!echo)||!profile&&state.modelProfile?.model&&state.modelProfile.model!==settings.applied.model&&(!echo||raw!==state.modelProfile.model))throw new BridgeError('profile_verification_failed','Claude 的有效设置没有采用指定模型，可能被其他策略覆盖；消息暂缓投递。');
                                      
    state.modelProfile={...state.modelProfile,model:settings.applied.model};save();
    return{model:settings.applied.model,...(echo?{requestedModel:raw}:{}),...(settings.applied.effort!==undefined&&settings.applied.effort!==null?{effort:settings.applied.effort}:{})};
  };
  const setProfile=async(params:unknown)=>{
    const profile=modelProfileSchema.strict().parse(params);
                                                    
    const current=health.get();if(current&&!['ready','failed'].includes(current.state)||health.human)throw new BridgeError('session_busy','搭档仍在工作，设置将在安全空闲点应用。');
    if(profile.effort!==undefined&&!['low','medium','high','xhigh'].includes(String(profile.effort)))throw new BridgeError('profile_change_unsupported','此 Claude 控制接口不支持这档推理强度；请在新建后台时指定。');
    let accepted=false;try{
      await controlRequest({subtype:'apply_flag_settings',settings:{...(profile.model?{model:profile.model}:{}),...(profile.effort!==undefined?{effortLevel:profile.effort,ultracode:false}:{})}});
      accepted=true;
      state.modelProfile={...state.modelProfile,...profile};save();return await readProfile(profile);
    }catch(error){throw profileChangeFailure(error,true,accepted);}
  };
  const stop=async(handoffId?:string)=>{
    if(stopping)throw new BridgeError('claude_child_stopping','托管 Claude 正在退出。');stopping=true;
    try{
      if(!closed)await interrupt();
                                                       
      state.phase=handoffId?'handoff':'released';if(handoffId)state.handoffId=handoffId;save();
      await stopProcess(home,state.native);await stopProcess(home,state.wrapper);
      save();setTimeout(()=>void finish(),30);return state;
    }catch(error){stopping=false;state.error=describeError(error);save();throw error;}
  };
  const finish=async()=>{if(finished)return;finished=true;stopping=true;clearInterval(timer);for(const p of pending.values()){clearTimeout(p.timer);p.reject(new BridgeError('claude_child_offline','托管 Claude 已退出。'));}pending.clear();try{await server?.close();if(runtime)try{unlinkSync(runtime.file);}catch{}}finally{supervisor.stop();}};
  const supervisor=await supervisePosixGroup(async()=>{try{await stop();}catch(error){state.error=describeError(error);save();}finally{await finish();}});
  try{
    server=await listenBroker(home,async(method,params:any)=>{if(method==='ping')return{pid:process.pid};if(method==='status'){save();return state;}if(method==='profile.get')return readProfile();if(method==='profile')return setProfile(params);if(method==='interrupt'){await interrupt();save();return state;}if(method==='stop')return stop(typeof params?.handoffId==='string'?params.handoffId:undefined);throw new BridgeError('unknown_method','不支持的托管 Claude 控制命令。');},state.address);
    state.worker=await processIdentity(process.pid);runtime=await registerRuntimeProcess(home);ownership=await registerCurrentProcess(home,'claude-worker',{peerId,sessionId:state.sessionId,configHome:state.configHome,posixGroup:true});save();
    const launch=await prepareOwnedLaunch(await selectSessionLaunch('claude',loadConfig(home),{cwd:state.cwd,home,sessionId:state.hasSession?state.sessionId:undefined,configHome:state.configHome,executable:state.executable,profileId:state.profileId}));
    if(disabledMember(home,{host:'claude',memberId:peerId}))throw new BridgeError('member_disabled','此成员的 nxbridge 已关闭，未启动原生后台。');
    const profile=state.modelProfile??{},settings=claudeProfileSettings(profile),permissionArgs=state.launchSourcePermission!==undefined?ownedClaudeArgs(state.launchSourcePermission,profile):Object.keys(settings).length?['--settings',JSON.stringify(settings)]:[];
    child=spawnSelectedHost(launch,['-p',state.hasSession?'--resume':'--session-id',state.sessionId,'--input-format','stream-json','--output-format','stream-json','--verbose','--include-partial-messages','--permission-prompt-tool','stdio',...permissionArgs,...claudeProfileArgs(profile)],{stdio:['pipe','pipe','pipe']});
    let buffer='';child.stdout!.setEncoding('utf8');child.stdout!.on('data',(chunk:string)=>{
      buffer+=chunk;if(buffer.length>2*1024*1024){buffer='';state.error='Claude 原生输出行超过控制解析上限。';return;}
      let at:number;while((at=buffer.indexOf('\n'))>=0){const line=buffer.slice(0,at);buffer=buffer.slice(at+1);try{const message=JSON.parse(line);if(message.type==='control_response'){const p=pending.get(message.response?.request_id);if(p){clearTimeout(p.timer);pending.delete(message.response.request_id);message.response.subtype==='success'?p.resolve(message.response.response):p.reject(new BridgeError('claude_control_rejected','Claude 拒绝了控制请求。'));}}health.observe(message);dirty=true;}catch{}}
    });
                                          
    child.stderr!.on('data',()=>{});child.on('error',error=>{state.error='Claude 启动失败：'+describeError(error);state.phase='failed';save();});
    child.on('close',(code,signal)=>{closed=true;if(!stopping){state.phase='failed';state.error=`Claude 子进程已退出（${signal??code??'unknown'}）；只会恢复同一会话，不重放消息。`;save();void finish();}});
    await new Promise<void>((resolve,reject)=>{child!.once('spawn',resolve);child!.once('error',reject);});state.wrapper=await processIdentity(child.pid!);save();
    await rememberOwnedChild(home,child,'claude-child',{peerId,sessionId:state.sessionId,configHome:launch.configHome});
    const end=Date.now()+18000;let pendingIdentity:unknown;
    while(!closed&&Date.now()<end){
      try{
        let native:ProcessIdentity;
        try{native=await nativeDescendant(state.worker.pid,'claude',0,undefined,ownership);}
        catch(error){if((error as BridgeError).code!=='launch_owner_unverified')throw error;throw new BridgeError('claude_identity_pending',describeError(error));}
        state.native=native;
        if(!ownedProcesses(home).records.some(value=>value.peerId===peerId&&value.identity.pid===native.pid&&value.identity.startedAt===native.startedAt))await recordOwnedProcess(home,{role:'claude-child',identity:native,parent:state.wrapper,peerId,sessionId:state.sessionId,configHome:launch.configHome,proof:{kind:'spawn'}});
        let env:string[];
        try{env=readFileSync('/proc/'+native.pid+'/environ','utf8').split('\0');}
        catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;throw new BridgeError('claude_identity_pending',describeError(error));}
        const configHome=env.find(v=>v.startsWith('CLAUDE_CONFIG_DIR='))?.slice('CLAUDE_CONFIG_DIR='.length)??launch.configHome;
        state.configHome=configHome;save();let official:{sessionId:string;cwd:string;pid?:number;procStart?:string;messagingSocketPath?:string};
        try{official=readJson(path.join(configHome,'sessions',native.pid+'.json'));}
        catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;throw new BridgeError('claude_identity_pending',describeError(error));}
        if(official.sessionId!==state.sessionId)throw new BridgeError('session_changed','原生 Claude 发布了不同的会话 ID，未认领后台。');
        if(!matchesProcess(official,native)||!official.messagingSocketPath)throw new BridgeError('claude_identity_pending','等待原生 Claude 身份。');
        state.phase='active';state.registration={host:'claude',sessionId:state.sessionId,cwd:official.cwd,name:'后台 Claude（托管子进程）',kind:'root',state:'ready',endpoint:{mode:'claude-inbox',address:official.messagingSocketPath,pid:native.pid,procStart:native.startedAt,configHome,epoch:`${native.pid}:${native.startedAt}:${official.messagingSocketPath}`}};
        launch.configHome=configHome;recordHostLaunch(home,'claude-child',launch,native.pid);save();break;
      }catch(error){
        if(closed)break;
                                                   
        if(!(error instanceof BridgeError)||error.code!=='claude_identity_pending')throw error;
        pendingIdentity=error;await delay(150);
      }
    }
    if(state.phase!=='active')throw new BridgeError('claude_child_failed',state.error??('启动命令没有发布可核验的同一 Claude 会话和 inbox；请核对信任与插件状态。'+(pendingIdentity?' 原因：'+describeError(pendingIdentity):'')));
    timer=setInterval(()=>{void (async()=>{if(stopping)return;if(!await alive(state.native)){state.phase='failed';state.error='Claude 原生进程已退出；保留同一会话 ID。';await stopProcess(home,state.wrapper);save();await finish();return;}if(dirty)save();})().catch(error=>{state.error=describeError(error);save();});},500);
  }catch(error){
                                                
    if(server){state.phase='failed';state.error=describeError(error);save();for(const identity of [state.native,state.wrapper])try{await stopProcess(home,identity);}catch(cleanup){process.stderr.write('托管启动失败后的回收未完成：'+describeError(cleanup)+'\n');}try{await finish();}catch(cleanup){process.stderr.write('托管 worker 关闭未完成：'+describeError(cleanup)+'\n');}}else supervisor.stop();throw error;
  }
}
