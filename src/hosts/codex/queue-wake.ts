import { lstatSync } from 'node:fs';
import { createConnection } from 'node:net';
import path from 'node:path';
import { proveUnixCodexSocket } from '../../ipc/unix-socket.js';
import { executeContainedCommand } from '../../process/contained-command.js';
import { runCli } from '../../process/host-command.js';
import { codexIsManagedDaemon, liveProcess, processIdentity } from '../../process/process.js';
import { BridgeError, DeliveryError } from '../../shared/errors.js';
import { readJson, sameDirectory } from '../../shared/files.js';
import { HEALTH_WAKE_NOTICE, WAKE_NOTICE, type BridgeConfig, type Endpoint, type Peer } from '../../types.js';
import { sameHostImage, selectHostLaunch, type HostLaunch } from '../host-launch.js';
import { profileState } from '../launch-profiles.js';
import { managedRuntimeNativeState, runtimeFor } from '../managed-runtimes.js';
import { verifyDedicatedCodex } from './codex-isolation.js';
import { configClient } from './stdio-codex.js';

export interface CodexQueueParams {threadId:string;input:[{type:'text';text:string}];clientUserMessageId:string}
export interface CodexQueueOptions {
  clientUserMessageId:string;
  message:string;
  beforeSubmit:()=>void|Promise<void>;
  requestRemote?:(params:CodexQueueParams,authorize:()=>Promise<void>)=>Promise<unknown>;
}
export interface CodexQueueReceipt {id:string;clientUserMessageId:string}

const uuid=/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const unavailable=()=>new BridgeError('queue_route_unverified','无法核验 Codex 队列使用原会话的本机端点，未执行入队。');
const collision=()=>new BridgeError('queue_daemon_collision','嵌入式会话的共享 daemon 仍在运行或无法排除冲突，保留提醒等待原生取件。');
const absent=(error:unknown)=>['ENOENT','ENOTDIR'].includes((error as NodeJS.ErrnoException).code??'');

function readDaemonPid(filename:string):number|undefined{
  try{const {pid}=readJson<{pid:number}>(filename);if(!Number.isSafeInteger(pid)||pid<=0)throw unavailable();return pid;}
  catch(error){if(!absent(error))throw error;}
}

export async function windowsQueueSocketVacant(filename:string,launch:HostLaunch,home:string,run=executeContainedCommand):Promise<boolean>{
  try{lstatSync(filename);}catch(error){if(absent(error))return true;}
                                               
                                            
  try{
    await run(launch.executable.command,['app-server','proxy','--sock',filename],{cwd:launch.cwd,env:launch.env,home,timeout:1500,maxBuffer:8192});
    return false;
  }catch(error){
    const failure=error as {code?:unknown;killed?:boolean;signal?:unknown;stderr?:unknown};
    if(failure.code!==1||failure.killed||failure.signal||typeof failure.stderr!=='string')return false;
    const [context,cause,detail]=failure.stderr.trim().split(/\r?\n/).filter(Boolean).slice(-3);
                                  
    return context==='Error: failed to connect to socket at '+filename&&cause==='Caused by:'
      &&detail!==undefined&&/\(os error (?:10061|2|3)\)$/.test(detail);
  }
}

                                                 
async function defaultSocketVacant(filename:string,launch:HostLaunch,home:string):Promise<boolean>{
  if(process.platform==='win32')return windowsQueueSocketVacant(filename,launch,home);
  return new Promise(resolve=>{
    const socket=createConnection(filename),settle=(vacant:boolean)=>{socket.destroy();resolve(vacant);};
    socket.once('connect',()=>settle(false));
    socket.once('timeout',()=>settle(false));
    socket.once('error',error=>settle(absent(error)||(error as NodeJS.ErrnoException).code==='ECONNREFUSED'));
    socket.setTimeout(750);
  });
}

const defaults={run:runCli,control:configClient,identity:processIdentity,dedicated:verifyDedicatedCodex,
  daemon:codexIsManagedDaemon,unixSocket:proveUnixCodexSocket,live:liveProcess,socketVacant:defaultSocketVacant};

                                    
export async function queueCodexWake(home:string,config:BridgeConfig,peer:Peer,endpoint:Endpoint,options:CodexQueueOptions,io=defaults):Promise<CodexQueueReceipt>{
  const {sessionId}=peer,{address,configHome,pid,procStart}=endpoint,{clientUserMessageId,message}=options;
  if(peer.host!=='codex'||!['root','fork'].includes(peer.kind)||!sessionId||!uuid.test(sessionId)||!configHome||!path.isAbsolute(configHome)
    ||!pid||!procStart||endpoint.peerId!==peer.id||!endpoint.active||endpoint.pendingContext||!clientUserMessageId
    ||message!==WAKE_NOTICE&&message!==HEALTH_WAKE_NOTICE)throw unavailable();
  const embedded=endpoint.mode==='embedded'&&!endpoint.daemon&&endpoint.processKind!=='app-server'&&!address;
  const isUnix=address.startsWith('unix://')&&path.isAbsolute(address.slice(7)),isLoopback=/^ws:\/\/127\.0\.0\.1:\d+$/.test(address);
  const remote=endpoint.daemon?isUnix&&endpoint.daemon.address===address:endpoint.mode==='app-server'&&(isUnix||isLoopback);
  if(embedded?!!options.requestRemote:!remote||!options.requestRemote)throw unavailable();

  const start=await io.identity(pid),image=start.image;
  if(start.startedAt!==procStart||!image||!path.isAbsolute(image))throw unavailable();
  const original=async()=>{
    const native=await io.identity(pid);
    if(native.startedAt!==procStart||native.image!==image)throw unavailable();
    return native;
  };
  const launchOriginal=()=>{
    const state=profileState(home);
    const profile=[...(state.observations??[]),...state.profiles].find(value=>value.host==='codex'&&value.sourceSession===sessionId&&value.sourcePid===pid&&value.sourceGeneration===procStart&&sameDirectory(value.configHome,configHome)&&sameHostImage(value.exe,image,'codex'));
                                      
    const launch=selectHostLaunch('codex',{...config,codexHome:undefined,codexBinary:undefined,codexCommand:undefined},{home,cwd:peer.cwd,sessionId,configHome,executable:image,record:profile,unobserved:!profile},state);
    launch.executable={command:image,prefix:[]};
    for(const name of Object.keys(launch.env))if(name.toUpperCase()==='NXBRIDGE_CODEX_REMOTE_TOKEN')delete launch.env[name];
    return launch;
  };
  const privateRuntime=()=>{
    const runtime=runtimeFor(home,{endpoint:address})?.value;
    if(!runtime||runtime.kind!=='owned'||runtime.state!=='ready'||!runtime.dedicated||runtime.pid!==pid||runtime.procStart!==procStart
      ||!runtime.configHome||!sameDirectory(runtime.configHome,configHome)||endpoint.runtimeId&&endpoint.runtimeId!==runtime.id
      ||runtime.peerId&&runtime.peerId!==peer.id||isLoopback&&!runtime.authenticatedLoopback)throw unavailable();
    return runtime;
  };

  const daemonDir=path.join(configHome,'app-server-daemon'),daemonPidFile=path.join(daemonDir,'daemon.pid');
  const daemonFiles=[daemonPidFile,path.join(daemonDir,'app-server.pid')];
  const socket=path.join(configHome,'app-server-control','app-server-control.sock');
  const daemonPidMatches=()=>readDaemonPid(daemonPidFile)===pid;
  const embeddedSnapshot=()=>JSON.stringify([socket,...daemonFiles].map(file=>{
    try{const {dev,ino,mtimeMs,size}=lstatSync(file);return[dev,ino,mtimeMs,size];}
    catch(error){
      if(absent(error))return null;
      if(process.platform!=='win32'||file!==socket||!['EACCES','EPERM'].includes((error as NodeJS.ErrnoException).code??''))throw collision();
                                                      
      const {dev,ino,mtimeMs}=lstatSync(path.dirname(file));return['parent',dev,ino,mtimeMs];
    }
  }));
  const verifyEmbedded=async(launch:HostLaunch)=>{
    if(!await io.socketVacant(socket,launch,home))throw collision();
                                           
    for(const file of daemonFiles){
      const daemonPid=readDaemonPid(file);
      if(daemonPid&&io.live(daemonPid)&&await io.daemon(await io.identity(daemonPid)))throw collision();
    }
  };
  let runtimeId:string|undefined;
  const embeddedLaunch=embedded?launchOriginal():undefined;
  if(embeddedLaunch)await verifyEmbedded(embeddedLaunch);
  else if(endpoint.daemon){
    if(!daemonPidMatches()||!await io.daemon(start))throw unavailable();
    if(process.platform==='win32'){
      const launch=launchOriginal(),status=JSON.parse(await io.run('codex',['app-server','daemon','version'],{home,config,launch,cwd:peer.cwd,timeout:5000}));
      if(status?.status!=='running'||typeof status.socketPath!=='string'||!sameDirectory(address.slice(7),status.socketPath))throw unavailable();
    }else await io.unixSocket(address.slice(7),start);
  }else{
    const runtime=privateRuntime();
    if(await managedRuntimeNativeState(home,runtime,'alive')!=='alive')throw unavailable();
    await io.dedicated(address,start);
    runtimeId=runtime.id;
  }

  const params:CodexQueueParams={threadId:sessionId,input:[{type:'text',text:message}],clientUserMessageId};
  let attempted=false,control:Awaited<ReturnType<typeof configClient>>|undefined;
  const authorize=async()=>{
    if(attempted)throw unavailable();
    await original();
    if(endpoint.daemon?!daemonPidMatches():!embedded&&privateRuntime().id!==runtimeId)throw unavailable();
                                       
    const stamp=embedded?embeddedSnapshot():undefined;
    if(embeddedLaunch)await verifyEmbedded(embeddedLaunch);
    await options.beforeSubmit();
    if(embedded){if(embeddedSnapshot()!==stamp)throw collision();}
    else if(endpoint.daemon?!daemonPidMatches():privateRuntime().id!==runtimeId)throw unavailable();
    attempted=true;
  };
  try{
    let result:unknown;
    if(options.requestRemote){
                                                   
      result=await options.requestRemote(params,authorize);
    }else{
      control=await io.control(config,home,embeddedLaunch);
      await authorize();
      result=await control.request('thread/queue/add',params,{mutation:true});
    }
    if(!attempted)throw unavailable();
    const receipt=(result as {queuedSubmission?:Partial<CodexQueueReceipt>}|null)?.queuedSubmission;
    if(typeof receipt?.id!=='string'||!receipt.id||receipt.clientUserMessageId!==clientUserMessageId)throw new BridgeError('queue_ack_unverified','Codex 队列回执未确认提交编号。');
    return{id:receipt.id,clientUserMessageId};
  }catch(error){
    if(!attempted||error instanceof DeliveryError&&!error.uncertain)throw error;
    throw Object.assign(new DeliveryError('queue_result_unknown','Codex 队列提交结果未知，保留原预约。',true),{cause:error});
  }finally{
                                      
    try{await control?.close();}catch{                   }
  }
}
