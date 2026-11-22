import path from 'node:path';
import { proveUnixCodexSocket } from '../../ipc/unix-socket.js';
import { runCli } from '../../process/host-command.js';
import { codexIsManagedDaemon, processIdentity } from '../../process/process.js';
import { BridgeError, DeliveryError } from '../../shared/errors.js';
import { readJson, sameDirectory } from '../../shared/files.js';
import { HEALTH_WAKE_NOTICE, type BridgeConfig, type Endpoint, type Peer } from '../../types.js';
import { sameHostImage, selectHostLaunch } from '../host-launch.js';
import { profileState } from '../launch-profiles.js';
import { managedRuntimeNativeState, managedRuntimeToken, runtimeFor } from '../managed-runtimes.js';
import { verifyDedicatedCodex } from './codex-isolation.js';
import { codexPackageEnvironment } from './codex-package.js';

const uuid=/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const tokenVariable='NXBRIDGE_CODEX_REMOTE_TOKEN';
const defaults={run:runCli,identity:processIdentity,dedicated:verifyDedicatedCodex,daemon:codexIsManagedDaemon,unixSocket:proveUnixCodexSocket};
const unavailable=()=>new BridgeError('queue_route_unverified','无法核验 Codex 队列使用原会话的本机端点，未执行入队。');

                                        
export async function queueCodexWake(home:string,config:BridgeConfig,peer:Peer,endpoint:Endpoint,beforeSpawn:()=>void|Promise<void>,onSpawn:()=>void,io=defaults):Promise<void>{
  const {sessionId}=peer,{address,configHome,pid,procStart}=endpoint;
  if(peer.host!=='codex'||!['root','fork'].includes(peer.kind)||!sessionId||!uuid.test(sessionId)||!configHome||!path.isAbsolute(configHome)||!pid||!procStart||endpoint.peerId!==peer.id||!endpoint.active||endpoint.pendingContext)throw unavailable();
  const isUnix=address.startsWith('unix://')&&path.isAbsolute(address.slice(7)),isLoopback=/^ws:\/\/127\.0\.0\.1:\d+$/.test(address);
  if(endpoint.daemon?(!isUnix||endpoint.daemon.address!==address):endpoint.mode!=='app-server'||(!isUnix&&!isLoopback))throw unavailable();

  const start=await io.identity(pid);
  if(start.startedAt!==procStart||!start.image||!path.isAbsolute(start.image))throw unavailable();
  const image=start.image,state=profileState(home);
  const profile=[...(state.observations??[]),...state.profiles].find(value=>value.host==='codex'&&value.sourceSession===sessionId&&value.sourcePid===pid&&value.sourceGeneration===procStart&&sameDirectory(value.configHome,configHome)&&sameHostImage(value.exe,image,'codex'));
                                         
  const launch=selectHostLaunch('codex',{...config,codexHome:undefined,codexBinary:undefined,codexCommand:undefined},{home,cwd:peer.cwd,sessionId,configHome,executable:image,record:profile,unobserved:!profile},state);
  launch.executable={command:image,prefix:[]};
  const env=codexPackageEnvironment(launch.executable,launch.env);
  for(const name of Object.keys(env))if(name.toUpperCase()===tokenVariable)delete env[name];
  const args=['queue','--thread',sessionId,'--message',HEALTH_WAKE_NOTICE,'--remote',address,...(isLoopback?['--remote-auth-token-env',tokenVariable]:[])];
  const privateRuntime=()=>{
    const runtime=runtimeFor(home,{endpoint:address})?.value;
    if(!runtime||runtime.kind!=='owned'||runtime.state!=='ready'||!runtime.dedicated
      ||runtime.pid!==pid||runtime.procStart!==procStart||!runtime.configHome||!sameDirectory(runtime.configHome,configHome)
      ||endpoint.runtimeId&&endpoint.runtimeId!==runtime.id||runtime.peerId&&runtime.peerId!==peer.id
      ||isLoopback&&!runtime.authenticatedLoopback)throw unavailable();
    return runtime;
  };

                                                                 
  const daemonPidFile=path.join(configHome,'app-server-daemon','daemon.pid');
  const daemonPidMatches=()=>readJson<{pid:number}>(daemonPidFile).pid===pid;
  if(endpoint.daemon&&process.platform==='win32'){
    if(!daemonPidMatches()||!await io.daemon(start))throw unavailable();
    const current=JSON.parse(await io.run('codex',['app-server','daemon','version'],{home,config,launch,env,cwd:peer.cwd,timeout:5000})) as {status?:string;socketPath?:string};
    if(current.status!=='running'||typeof current.socketPath!=='string'||!sameDirectory(address.slice(7),current.socketPath))throw unavailable();
  }

  let passedGuard=false,observerError:unknown;
  try{
    const output=await io.run('codex',args,{home,config,launch,env,cwd:peer.cwd,beforeSpawn:async()=>{
      const native=await io.identity(pid);
      if(native.startedAt!==procStart||native.image!==image)throw unavailable();
      let verifiedRuntimeId:string|undefined;
      if(endpoint.daemon){
        if(!daemonPidMatches()||!await io.daemon(native))throw unavailable();
        if(process.platform!=='win32')await io.unixSocket(address.slice(7),native);
      }else{
        const runtime=privateRuntime();
        if(await managedRuntimeNativeState(home,runtime,'alive')!=='alive')throw unavailable();
        await io.dedicated(address,native);
        verifiedRuntimeId=runtime.id;
      }
      await beforeSpawn();
      if(endpoint.daemon?!daemonPidMatches():privateRuntime().id!==verifiedRuntimeId)throw unavailable();
      if(isLoopback){
        const token=managedRuntimeToken(home,address);
        if(!token)throw unavailable();
        env[tokenVariable]=token;
      }
      passedGuard=true;
    },onSpawn:()=>{try{onSpawn();}catch(error){observerError=error;}}});
    const receipt=/^Queued message \S+ for thread ([a-f0-9-]+)\.\r?$/im.exec(output);
    if(receipt?.[1]?.toLowerCase()!==sessionId.toLowerCase()||observerError)throw observerError??new BridgeError('queue_ack_unverified','Codex 队列回执未确认目标会话。');
  }catch(error){
    if(!passedGuard)throw error;
                                          
    throw Object.assign(new DeliveryError('queue_result_unknown','Codex 队列提交结果未知，保留原预约。',true),{cause:error});
  }finally{delete env[tokenVariable];}
}
