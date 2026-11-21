import path from 'node:path';
import {z} from 'zod';
import {Store} from '../storage/store.js';
import {CodexAdapter} from '../hosts/codex/adapter.js';
import {ClaudeAdapter} from '../hosts/claude/adapter.js';
import {BridgeError,describeError} from '../shared/errors.js';
import {bridgeHome} from '../shared/local-paths.js';
import {ensureHome,removeDanglingCodexSockets} from '../ipc/home.js';
import {loadConfig} from '../config/load.js';
import {installationEnabled,listenBroker,serviceOrigin} from '../ipc/ipc.js';
import {neutralEnvironment} from '../process/environment.js';
import {registerRuntimeProcess} from '../install/runtime-install.js';
import {unlinkSync,existsSync} from 'node:fs';
import {withBrokerStartup,assertStartupReservation} from './broker-startup.js';
import {forgetOwnedProcess,ownedProcesses,registerCurrentProcess} from '../process/owned-processes.js';
import {ResourceHealth,resourceSampler} from './health/resource-health.js';
import {Broker} from './coordinator.js';

export async function runService(home=bridgeHome()):Promise<void>{
  const startupToken=process.env.NXBRIDGE_BROKER_STARTUP_TOKEN;
  const environment=neutralEnvironment({NXBRIDGE_HOME:home,NXBRIDGE_SERVICE_ORIGIN:process.env.NXBRIDGE_SERVICE_ORIGIN});
  for(const key of Object.keys(process.env))delete process.env[key];Object.assign(process.env,environment.env);
  await ensureHome(home);let broker:Broker|undefined,shutdown:(()=>Promise<void>)|undefined,started:Promise<void>|undefined;
  const inherited=z.array(z.object({pid:z.number().int().positive(),startedAt:z.string(),name:z.string()})).safeParse(process.env.NXBRIDGE_SERVICE_ORIGIN?JSON.parse(process.env.NXBRIDGE_SERVICE_ORIGIN):undefined);
  const origin=inherited.success?inherited.data:await serviceOrigin();
                                           
  let server:Awaited<ReturnType<typeof listenBroker>>|undefined;
  try{const listening=await withBrokerStartup(home,origin,async()=>server=await listenBroker(home,async(method,params)=>{
    if(!broker)throw new BridgeError('starting','协调器正在恢复。');
    if(method==='shutdown'){
      const options=z.object({releaseOwned:z.boolean().default(false),reason:z.enum(['shutdown','uninstall','test_cleanup','external_release']).default('shutdown'),requester:z.object({pid:z.number().int().positive(),command:z.string().max(256)}).optional(),startupToken:z.string().optional(),expectedBroker:z.object({pid:z.number().int().positive(),generation:z.string().optional()}).optional()}).parse(params??{});await started;
      if(options.expectedBroker&&(options.expectedBroker.pid!==process.pid||options.expectedBroker.generation!==undefined&&options.expectedBroker.generation!==runtime?.record.generation))throw new BridgeError('broker_changed','协调器代次已改变，未停止新的协调器。');
                                             
      if(options.reason!=='uninstall'||installationEnabled(home))await assertStartupReservation(home,options.startupToken);
      const actor=options.reason+(options.requester?' (requester pid '+options.requester.pid+', '+options.requester.command+')':'');
      const {startupToken:_token,...recordedOptions}=options;store!.event('shutdown.requested',recordedOptions);
      const notes=await broker.stop(options.releaseOwned,options.reason==='uninstall'?null:{reason:options.reason==='external_release'?'external_release':'broker_shutdown',actor});setTimeout(()=>{void shutdown?.().catch(error=>{process.stderr.write('协调器关闭未完成：'+describeError(error)+'\n');process.exitCode=1;});},20);return{stopping:true,notes};
    }
                                            
    if(method==='codex.restart'||method==='codex.restart.target')await started;
    return broker.dispatch(method,params);
  }),startupToken);if(!listening)return;server=listening;}
  catch(error){
                                                   
    try{await server?.close();}catch(cleanup){process.stderr.write('协调器监听回收未完成：'+describeError(cleanup)+'\n');}
    if(error instanceof BridgeError&&error.code==='already_running')return;throw error;
  }
  if(!installationEnabled(home)){await server.close();return;}
  const boundServer=server;
  let runtime:Awaited<ReturnType<typeof registerRuntimeProcess>>|undefined,store:Store|undefined,ownership:Awaited<ReturnType<typeof registerCurrentProcess>>|undefined,closing=false;
  const close=async()=>{
    if(closing)return;closing=true;
    try{await boundServer.close();await broker?.stop();}
    finally{if(ownership)forgetOwnedProcess(ownership);store?.close();if(runtime&&existsSync(runtime.file))unlinkSync(runtime.file);}
  };
  shutdown=close;
  try{
    runtime=await registerRuntimeProcess(home);
    if(!installationEnabled(home)){await close();return;}
    store=new Store(path.join(home,'nxbridge.db'));const config=loadConfig(home);
    const removedSockets=removeDanglingCodexSockets(home);if(removedSockets.length)store.event('socket.dangling.cleaned',{paths:removedSockets});
    ownership=await registerCurrentProcess(home,'broker');
    const windowsIndependent=process.platform!=='win32'||ownedProcesses(home).records.some(value=>value.role==='broker'&&value.windowsIndependent&&value.identity.pid===process.pid&&value.identity.startedAt===ownership!.identity.startedAt);
    const resources=new ResourceHealth(resourceSampler(home));
    broker=new Broker(store,config,{codex:new CodexAdapter(config,home),claude:new ClaudeAdapter(config,home)},home,origin,{entry:runtime.record.entry,generation:runtime.record.generation,buildId:runtime.record.buildId,windowsIndependent},resources);
    started=broker.start();await started;
    const terminate=()=>{void close().catch(error=>{process.stderr.write('协调器关闭未完成：'+describeError(error)+'\n');process.exitCode=1;});};
    process.once('SIGINT',terminate);process.once('SIGTERM',terminate);
  }catch(error){try{await close();}catch(cleanup){process.stderr.write('协调器启动失败后的回收未完成：'+describeError(cleanup)+'\n');}throw error;}
}
