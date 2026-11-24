import net from 'node:net';
import { EventEmitter } from 'node:events';
import { existsSync, unlinkSync, openSync, closeSync, statSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { timingSafeEqual } from 'node:crypto';
import path from 'node:path';
import {BridgeError,DeliveryError,describeError} from '../shared/errors.js';
import {DEFAULT_RETENTION} from '../config/defaults.js';
import {atomicJson,readJson} from '../shared/files.js';
import {bridgeHome,ipcAddress} from '../shared/local-paths.js';
import {delay} from '../shared/time.js';
import {ensureHome} from './home.js';
import {ipcToken} from './token.js';
import {loadConfig} from '../config/load.js';
import { neutralEnvironment } from '../process/environment.js';
import { rotateLog } from '../storage/logs.js';
import { RpcClient, type RpcMessage } from './rpc.js';
import { modelError } from '../integration/mcp/model-error.js';
import { z } from 'zod';
import { processAncestors, type ProcessIdentity } from '../process/process.js';
import { installedEntry } from '../install/runtime-install.js';
import { prepareProcessRegistry, rememberOwnedChild } from '../process/owned-processes.js';
import { launchIndependentWindows, WINDOWS_BACKGROUND_TIMEOUT_MS, WINDOWS_BACKGROUND_EXIT_TIMEOUT_MS } from '../process/windows/windows-background.js';
import { backgroundRetryContext, recordBackgroundState, requireBackgroundRetry } from '../hosts/background-state.js';
import { randomUUID } from 'node:crypto';
import { reserveBrokerStartup, startupHeldElsewhere, currentStartupToken, type StartupReservation } from '../broker/broker-startup.js';
import { remainingTime } from '../shared/time-budget.js';

export type ServiceOrigin=Pick<ProcessIdentity,'pid'|'startedAt'|'name'>[];
let originQuery:Promise<ServiceOrigin>|undefined;
                                             
export function serviceOrigin(timeout=10000):Promise<ServiceOrigin>{
  return originQuery??=processAncestors(process.pid,16,timeout).then(chain=>chain.map(({pid,startedAt,name})=>({pid,startedAt,name})),error=>{originQuery=undefined;throw error;});
}

const MAX_LINE=2*1024*1024;
const BROKER_READY_ATTEMPTS=60,BROKER_READY_POLL_MS=150;
function lines(socket:net.Socket,receive:(line:string)=>void,maxLine?:number):void {
  let buffered='';socket.setEncoding('utf8');
  socket.on('data',chunk=>{
    buffered+=chunk;
    let at:number;while((at=buffered.indexOf('\n'))>=0){
      if(maxLine!==undefined&&at>maxLine){socket.destroy();return;}
      const line=buffered.slice(0,at);buffered=buffered.slice(at+1);if(line)receive(line);
      if(socket.destroyed)return;
    }
    if(maxLine!==undefined&&buffered.length>maxLine)socket.destroy();
  });
}

export async function connectBroker(home=bridgeHome(),timeout=2000,address=ipcAddress(home)):Promise<RpcClient>{
  const token=ipcToken(home),socket=net.createConnection(address);
  await new Promise<void>((resolve,reject)=>{
    const timer=setTimeout(()=>{socket.destroy();reject(new BridgeError('broker_timeout','协调器连接超时。'));},timeout);
    socket.once('connect',()=>{clearTimeout(timer);socket.off('error',reject);resolve();});
    socket.once('error',error=>{clearTimeout(timer);reject(error);});
  });
  const rpc=new RpcClient(message=>socket.write(JSON.stringify({...message,token})+'\n'),()=>socket.destroy());
                                           
  lines(socket,line=>{try{rpc.receive(JSON.parse(line));}catch{socket.destroy();}});
  socket.on('close',()=>rpc.disconnected());socket.on('error',()=>rpc.disconnected());
  return rpc;
}

export function installationEnabled(home:string):boolean{
  const state=path.join(home,'setup-state.json');
  return!existsSync(state)||!readJson<{disabled?:boolean}>(state).disabled;
}
async function pingBroker(home:string,timeout=500,deadline?:number):Promise<RpcClient>{
  const rpc=await connectBroker(home,remainingTime(deadline,timeout));
  try{await rpc.request('ping',{}, {timeout:remainingTime(deadline,timeout)});return rpc;}catch(error){rpc.close();throw error;}
}
const brokerStarts=new Map<string,Promise<void>>();
type BrokerStartOptions={bootstrap?:boolean;reserved?:boolean;deadline?:number};
export async function ensureBroker(home=bridgeHome(),options:BrokerStartOptions={}):Promise<RpcClient>{
  if(options.bootstrap||options.reserved)return ensureBrokerNow(home,options);
  if(!installationEnabled(home))throw new BridgeError('uninstalled','nxbridge 已卸载；运行 setup 后重新启用。');
  try{return await pingBroker(home,2000,options.deadline);}catch(error){if((error as {code?:string}).code==='ipc_token_invalid')throw error;}
  remainingTime(options.deadline,2000);
  const key=path.resolve(home);let work=brokerStarts.get(key);
  if(!work){
    const starting=ensureBrokerNow(home,options).then(rpc=>rpc.close()).finally(()=>{if(brokerStarts.get(key)===starting)brokerStarts.delete(key);});
    work=starting;brokerStarts.set(key,starting);
  }
  let timer:NodeJS.Timeout|undefined;
  try{await(options.deadline===undefined?work:Promise.race([work,new Promise<never>((_resolve,reject)=>{timer=setTimeout(()=>reject(new BridgeError('timeout','协调器启动等待已达本次 hook 截止时间。')),remainingTime(options.deadline,Number.MAX_SAFE_INTEGER));})]));}finally{clearTimeout(timer);}
  return pingBroker(home,2000,options.deadline);
}
async function ensureBrokerNow(home:string,options:BrokerStartOptions):Promise<RpcClient>{
  const budget=(limit:number)=>remainingTime(options.deadline,limit);
  if(!installationEnabled(home))throw new BridgeError('uninstalled','nxbridge 已卸载；运行 setup 后重新启用。');
                                               
  for(let attempt=0;attempt<40;attempt++){
    try{return await pingBroker(home,2000,options.deadline);}
    catch(error){const code=(error as {code?:string}).code;if(code==='ipc_token_invalid')throw error;if(code!=='stopping')break;if(attempt===39)throw error;await delay(budget(50));}
  }
  budget(2000);
  await ensureHome(home);
  const logfile=path.join(home,'run','broker.log');
  const retention={...DEFAULT_RETENTION,...loadConfig(home).retention};
  rotateLog(logfile,retention.logMaxBytes,retention.logBackups);
                                             
  const awaitStarter=async():Promise<RpcClient|undefined>=>{
    const deadline=Date.now()+WINDOWS_BACKGROUND_TIMEOUT_MS+WINDOWS_BACKGROUND_EXIT_TIMEOUT_MS+BROKER_READY_ATTEMPTS*BROKER_READY_POLL_MS;
    for(let poll=1;Date.now()<deadline;poll++){
      await delay(budget(BROKER_READY_POLL_MS));
      if(!installationEnabled(home))throw new BridgeError('uninstalled','nxbridge 已卸载；运行 setup 后重新启用。');
      requireBackgroundRetry(home);
      try{return await pingBroker(home,500,options.deadline);}catch{}
                                              
      if(poll%7===0&&!await startupHeldElsewhere(home,budget(1500)))return;
    }
    throw new BridgeError('broker_start_pending','其他调用方的协调器启动尚未确认，本次未重复启动。');
  };
                                                 
  if(process.platform==='win32'&&!options.reserved&&await startupHeldElsewhere(home,budget(1500))){const ready=await awaitStarter();if(ready)return ready;}
  const origin=await serviceOrigin(budget(10000));
  if(process.platform==='win32')requireBackgroundRetry(home,options.bootstrap,backgroundRetryContext(origin));
                                       
  if(!installationEnabled(home))throw new BridgeError('uninstalled','nxbridge 已卸载；运行 setup 后重新启用。');
  await prepareProcessRegistry(home);
  if(!installationEnabled(home))throw new BridgeError('uninstalled','nxbridge 已卸载；运行 setup 后重新启用。');
  let releaseStartup:StartupReservation|undefined;
  if(process.platform==='win32'&&!options.reserved){
    const caller=origin.find(value=>value.pid===process.pid);
    if(!caller)throw new BridgeError('broker_origin_unverified','无法核验协调器启动调用方。');
    try{releaseStartup=await reserveBrokerStartup(home,caller);}
    catch(error){
      if(!(error instanceof BridgeError&&error.code==='restart_in_progress'))throw error;
      const ready=await awaitStarter();if(ready)return ready;
                                   
      releaseStartup=await reserveBrokerStartup(home,caller);
    }
  }
  try{
                                        
  try{return await pingBroker(home,500,options.deadline);}catch{}
  budget(2000);
  const runtime=installedEntry(home);
  const startupToken=process.platform==='win32'?await currentStartupToken(home):undefined;
  const environment=neutralEnvironment({NXBRIDGE_HOME:home,NXBRIDGE_SERVICE_ORIGIN:JSON.stringify(origin),NXBRIDGE_BROKER_STARTUP_TOKEN:startupToken},true);
  let launchError:unknown;
  if(process.platform==='win32'){
    requireBackgroundRetry(home,options.bootstrap);
    try{
      const record=await launchIndependentWindows({home,executable:runtime.node,args:['--no-warnings',runtime.entry,'service'],cwd:home,env:environment.env,logfile,role:'broker',launchId:randomUUID(),deadline:options.deadline});
      atomicJson(path.join(home,'run','launch-broker.json'),{pid:record.identity.pid,generation:record.identity.startedAt,independent:true,spawnedAt:Date.now(),environment:environment.report},{durability:'buffered'});
      recordBackgroundState(home);
    }catch(error){recordBackgroundState(home,describeError(error),backgroundRetryContext(origin));throw error;}
  }else{
  const fd=openSync(logfile,'a',0o600);
  const child=spawn(runtime.node,['--no-warnings',runtime.entry,'service-launch'],{env:environment.env,detached:true,windowsHide:true,stdio:['ignore',fd,fd]});
  if(child.pid)atomicJson(path.join(home,'run','launch-broker.json'),{pid:child.pid,spawnedAt:Date.now(),environment:environment.report},{durability:'buffered'});
  child.unref();closeSync(fd);
  child.on('error',error=>{launchError=error;});
  await rememberOwnedChild(home,child,'broker');
  }
  let last:unknown;
  for(let attempt=0;attempt<BROKER_READY_ATTEMPTS;attempt++){
    await delay(budget(BROKER_READY_POLL_MS));
    if(launchError){last=launchError;break;}
    if(!installationEnabled(home))throw new BridgeError('uninstalled','nxbridge 已卸载；运行 setup 后重新启用。');
    try{return await pingBroker(home,500,options.deadline);}catch(e){last=e;}
  }
  throw new BridgeError('broker_start_failed',`协调器未能启动：${describeError(last)}。请检查 ${logfile}`);
  }finally{await releaseStartup?.();}
}

export async function detachService():Promise<void> {
                                                    
  const runtime=installedEntry(bridgeHome());
  const child=spawn(runtime.node,['--no-warnings',runtime.entry,'service'],{env:neutralEnvironment({NXBRIDGE_HOME:bridgeHome(),NXBRIDGE_SERVICE_ORIGIN:process.env.NXBRIDGE_SERVICE_ORIGIN}).env,detached:true,windowsHide:true,stdio:['ignore',process.stdout,process.stderr]});
  child.on('error',error=>{process.stderr.write(describeError(error)+'\n');process.exitCode=1;});
  child.unref();await rememberOwnedChild(bridgeHome(),child,'broker');
}

                                               
function brokerRequestTimeout(method:string,timeout?:number):number|undefined{return timeout??(['send','pair.selection.resolve','pair.selection.commit'].includes(method)?120000:undefined);}
export async function brokerCall<T=any>(method:string,params:unknown={},options:{home?:string;start?:boolean;timeout?:number;mutation?:boolean;reserved?:boolean;deadline?:number}={}):Promise<T>{
  const c=options.start===false?await connectBroker(options.home,remainingTime(options.deadline,Math.min(options.timeout??2000,2000))):await ensureBroker(options.home,{reserved:options.reserved,deadline:options.deadline});
  const timeout=brokerRequestTimeout(method,options.timeout);
  try{return await c.request<T>(method,params,{timeout:options.deadline===undefined?timeout:remainingTime(options.deadline,timeout??2000),mutation:options.mutation});}finally{c.close();}
}

                                           
export class BrokerSession extends EventEmitter {
  private rpc?:RpcClient;
  private opening?:Promise<RpcClient>;
  private closed=false;
  constructor(private home=bridgeHome(),private open=()=>ensureBroker(home)){super();}
  get connected():boolean{return!!this.rpc&&!this.rpc.closed;}
  connect():Promise<RpcClient>{
    if(this.closed)return Promise.reject(new DeliveryError('disconnected','本地协议连接已关闭。'));
    if(!installationEnabled(this.home))return Promise.reject(new BridgeError('uninstalled','nxbridge 已卸载；运行 setup 后重新启用。'));
    if(this.rpc&&!this.rpc.closed)return Promise.resolve(this.rpc);
    return this.opening??=this.open().then(rpc=>{
      if(this.closed){rpc.close();throw new DeliveryError('disconnected','本地协议连接已关闭。');}
      this.rpc=rpc;rpc.once('disconnected',()=>{if(this.rpc!==rpc)return;this.rpc=undefined;if(!this.closed)this.emit('disconnected');});return rpc;
    }).finally(()=>{this.opening=undefined;});
  }
  async request<T=any>(method:string,params:unknown={},options:{timeout?:number;mutation?:boolean}={}):Promise<T>{
    return(await this.connect()).request<T>(method,params,{...options,timeout:brokerRequestTimeout(method,options.timeout)});
  }
  close():void{this.closed=true;this.rpc?.close();this.rpc=undefined;}
}

export async function listenBroker(home:string,handler:(method:string,params:unknown)=>Promise<unknown>,address=ipcAddress(home)):Promise<{close:()=>Promise<void>}>{
  const token=Buffer.from(ipcToken(home));
  const sockets=new Set<net.Socket>();
  const server=net.createServer(socket=>{
    sockets.add(socket);socket.on('close',()=>sockets.delete(socket));socket.on('error',()=>{});
    lines(socket,line=>{
      let request:RpcMessage&{token?:string};
      try{request=JSON.parse(line);}catch{socket.destroy();return;}
      const offered=Buffer.from(typeof request.token==='string'?request.token:'');
      if(offered.length!==token.length||!timingSafeEqual(offered,token)){socket.destroy();return;}
      if(request.id===undefined||typeof request.method!=='string'){socket.destroy();return;}
      void handler(request.method,request.params).then(result=>{
        if(!socket.destroyed)socket.write(JSON.stringify({jsonrpc:'2.0',id:request.id,result})+'\n');
      },error=>{
        const validation=error instanceof z.ZodError,detail=modelError(error);
        if(!(error instanceof BridgeError)&&!validation)process.stderr.write(JSON.stringify({type:'rpc.error',method:request.method,error:error instanceof Error?error.stack:String(error)})+'\n');
        if(!socket.destroyed)socket.write(JSON.stringify({jsonrpc:'2.0',id:request.id,error:{code:validation?'invalid_arguments':detail.code==='storage_busy'?detail.code:error instanceof BridgeError?error.code:'internal',message:validation?detail.message:describeError(error),data:{...(validation?{issues:error.issues}:{}),...(detail.enable_command?{enable_command:detail.enable_command}:{}),...(typeof detail.uncertain==='boolean'?{uncertain:detail.uncertain}:{}),...(detail.phase?{phase:detail.phase}:{}),...(detail.operation?{operation:detail.operation}:{}),...(detail.sqliteCode===undefined?{}:{sqliteCode:detail.sqliteCode})}}})+'\n');
      });
    },MAX_LINE);
  });
  const listen=()=>new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(address,()=>{server.off('error',reject);resolve();});});
  try{await listen();}catch(error){
    if((error as NodeJS.ErrnoException).code!=='EADDRINUSE')throw error;
                                             
    let refused=false;
    for(let attempt=0;attempt<5;attempt++){
      try{const c=await connectBroker(home,500,address);try{await c.request('ping',{}, {timeout:500});}catch(e){if(!(e instanceof DeliveryError)||e.code!=='starting')throw e;}finally{c.close();}throw new BridgeError('already_running','协调器已运行。');}
      catch(e){
        if(e instanceof BridgeError&&e.code==='already_running')throw e;
        const code=(e as NodeJS.ErrnoException).code??'';refused=code==='ECONNREFUSED';
        if(!['ENOENT','ECONNREFUSED','ECONNRESET','EPIPE','disconnected','broker_timeout','timeout'].includes(code))throw e;
        if(attempt<4)await delay(100);
      }
    }
    if(process.platform==='win32')throw error;
    if(!refused)throw error;
    if(!statSync(address).isSocket())throw new BridgeError('invalid_socket','协调器地址不是 Unix socket。');
    unlinkSync(address);await listen();
  }
  return {close:async()=>{for(const s of sockets)s.destroy();await new Promise<void>(resolve=>server.close(()=>resolve()));}};
}
