import {embeddedSource} from "../shared/embedded-source.js";
import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import net from 'node:net';
import { randomUUID } from 'node:crypto';
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { windowsHookIdentityHelper } from './windows/windows-hook-identity.js';
import {BridgeError} from '../shared/errors.js';
import { bridgeHome } from '../shared/local-paths.js';
import { rotateLog } from '../storage/logs.js';
import { posixSupervisorSource, type NativeProcessExit } from './posix/posix-supervisor.js';

const failures=new WeakMap<ChildProcess,Error>();
const exits=new WeakMap<ChildProcess,NativeProcessExit>();
const startedChildren=new WeakSet<ChildProcess>();
export const CONTAINED_COMMAND_EXIT_GRACE_MS=2000;
export const containedCommandFailure=(child:ChildProcess)=>failures.get(child);
export const containedCommandExit=(child:ChildProcess,code=child.exitCode,signal=child.signalCode):NativeProcessExit=>exits.get(child)??{code,signal};
export function containedCommandStatus(home=bridgeHome()):{observedReapings:number;recent:unknown[]}{
  const file=path.join(home,'run','control-survivors.log'),events:unknown[]=[];
  for(const name of [file+'.1',file])try{for(const line of readFileSync(name,'utf8').split('\n').filter(Boolean))try{events.push(JSON.parse(line));}catch{}}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
  return{observedReapings:events.length,recent:events.slice(-10)};
}
function receiveStatus(child:ChildProcess,stream:NodeJS.ReadWriteStream,home:string,command:string):void{
  let buffer='';stream.on('error',()=>{});stream.on('data',chunk=>{
    buffer+=chunk.toString('utf8');let at:number;while((at=buffer.indexOf('\n'))>=0){
    try{
      const value=JSON.parse(buffer.slice(0,at));buffer=buffer.slice(at+1);
      if(value.kind==='started'){startedChildren.add(child);child.emit('command-spawn');}
      else if(value.kind==='exit')exits.set(child,{code:value.code,signal:value.signal});
      else if(value.kind==='survivors'){
        const event={at:Date.now(),command:path.basename(command),count:value.images.length,images:value.images},file=path.join(home,'run','control-survivors.log');
        try{mkdirSync(path.dirname(file),{recursive:true});rotateLog(file,128*1024,1);appendFileSync(file,JSON.stringify(event)+'\n','utf8');}catch(error){process.stderr.write('控制容器后代诊断写入失败：'+String(error)+'\n');}
      }
      else{
        const code=process.platform==='win32'?({2:'ENOENT',3:'ENOENT',5:'EACCES',8:'ENOMEM',14:'ENOMEM',193:'ENOEXEC',206:'ENAMETOOLONG',740:'EACCES',1450:'EAGAIN'} as Record<number,string>)[value.code]??'UNKNOWN':value.code;
        failures.set(child,value.kind==='spawn'?Object.assign(Error(value.message),{code,syscall:'spawn '+value.command,nativeCode:value.code}):new BridgeError('host_ownership_unknown',value.message));
      }
      stream.write('ok\n');
    }catch{buffer=buffer.slice(at+1);failures.set(child,new BridgeError('host_ownership_unknown','控制容器返回了无效的启动状态。'));}
    }
  });
}

                                      
const posixCommandSource=                                 embeddedSource("javascript", `
import {spawn} from 'node:child_process';
import {Socket} from 'node:net';
const {command,args,grace,supervisorModule}=JSON.parse(Buffer.from(process.argv[1],'base64').toString('utf8')),{supervise}=await import(supervisorModule);
const owner=new Socket({fd:3,readable:true,writable:true}),supervisor=supervise();
owner.on('end',()=>supervisor.stop());owner.on('error',()=>supervisor.stop());owner.resume();
const child=spawn(command,args,{stdio:[0,1,2]});
child.once('spawn',()=>owner.write(JSON.stringify({kind:'started'})+'\\n'));
child.once('error',error=>{owner.end(JSON.stringify({kind:'spawn',code:error.code,message:error.message,command})+'\\n',()=>owner.destroy());process.exitCode=125;});
child.once('exit',async(code,signal)=>{
 owner.write(JSON.stringify({kind:'exit',code,signal})+'\\n');
 if(supervisor.stopping)return;
 let images;try{images=await supervisor.settle(grace);}catch(error){owner.write(JSON.stringify({kind:'ownership',message:String(error)})+'\\n');supervisor.stop(0);return;}
 if(supervisor.stopping)return;
 if(images.length){owner.write(JSON.stringify({kind:'survivors',images})+'\\n');owner.once('data',()=>supervisor.stop(0));}
 else{owner.destroy();if(signal){process.removeAllListeners(signal);process.kill(process.pid,signal);}else process.exitCode=code??1;}
});
`);

                                    
export async function spawnContainedCommand(command:string,args:string[],options:SpawnOptions&{home?:string}={}):Promise<ChildProcess>{
  const {home,...settings}=options;
  if(process.platform==='win32'){
    const helper=await windowsHookIdentityHelper(home);
    const pipe='nxbridge-command-'+process.pid+'-'+randomUUID(),connections=new Set<net.Socket>();let child:ChildProcess;
    const server=net.createServer(socket=>{connections.add(socket);receiveStatus(child,socket,home??bridgeHome(),command);socket.once('close',()=>connections.delete(socket));});
    await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen('\\\\.\\pipe\\'+pipe,resolve);});
    try{child=spawn(helper,['run',String(process.pid),pipe,command,...args],{...settings,windowsHide:true,shell:false});}
    catch(error){server.close();throw error;}
    child.once('close',()=>{for(const socket of connections)socket.destroy();server.close();});
    return child;
  }
  const encoded=Buffer.from(JSON.stringify({command,args,grace:CONTAINED_COMMAND_EXIT_GRACE_MS,supervisorModule:'data:text/javascript;base64,'+Buffer.from(posixSupervisorSource).toString('base64')})).toString('base64');
  const child=spawn(process.execPath,['--input-type=module','-e',posixCommandSource,encoded],{...settings,detached:true,stdio:['pipe','pipe','pipe','pipe'],shell:false});
  receiveStatus(child,child.stdio[3] as unknown as NodeJS.ReadWriteStream,home??bridgeHome(),command);return child;
}

                                     
export async function closeContainedCommand(child:ChildProcess,grace=1000+CONTAINED_COMMAND_EXIT_GRACE_MS):Promise<void>{
  if(child.exitCode!==null||child.signalCode!==null)return;
  await new Promise<void>((resolve,reject)=>{
    const force=setTimeout(()=>child.kill(),grace);
    const deadline=setTimeout(()=>{finish();reject(new BridgeError('process_stop_pending','控制容器尚未退出。'));},grace+5000);
    const finish=()=>{clearTimeout(force);clearTimeout(deadline);child.off('close',closed);};
    const closed=()=>{finish();resolve();};child.once('close',closed);child.stdin?.end();
  });
}

export async function executeContainedCommand(command:string,args:string[],options:{cwd?:string;env?:NodeJS.ProcessEnv;home?:string;timeout:number;maxBuffer:number;onSpawn?:()=>void}):Promise<{stdout:string;stderr:string}>{
  let child:ChildProcess;
  try{child=await spawnContainedCommand(command,args,{cwd:options.cwd,env:options.env,home:options.home,stdio:['pipe','pipe','pipe']});}catch(error){throw Object.assign(Error('控制进程容器准备失败'),{ownershipError:error});}
  let stdout=Buffer.alloc(0),stderr=Buffer.alloc(0),failure:Error|undefined,killed=false;
  const collect=(kind:'stdout'|'stderr',chunk:Buffer)=>{
    const previous=kind==='stdout'?stdout:stderr;
    if(previous.length+chunk.length>options.maxBuffer){failure=Object.assign(Error(kind+' maxBuffer exceeded'),{code:'ERR_CHILD_PROCESS_STDIO_MAXBUFFER'});child.kill();killed=true;}
    const value=Buffer.concat([previous,chunk.subarray(0,Math.max(0,options.maxBuffer-previous.length))]);if(kind==='stdout')stdout=value;else stderr=value;
  };
  child.stdout!.on('data',chunk=>collect('stdout',chunk));child.stderr!.on('data',chunk=>collect('stderr',chunk));child.stdin!.on('error',()=>{});child.stdin!.end();
  child.once('command-spawn',()=>options.onSpawn?.());
  const ended=new Promise<{stdout:string;stderr:string}>((resolve,reject)=>{
    child.once('error',error=>{failure=error;});
    child.once('close',(code,signal)=>{
      ({code,signal}=containedCommandExit(child,code,signal));
      const output={stdout:stdout.toString('utf8'),stderr:stderr.toString('utf8')};
      failure??=containedCommandFailure(child);
      if(!failure&&!startedChildren.has(child)&&code===125&&output.stderr.startsWith('nxbridge command ownership: '))failure=new BridgeError('host_ownership_unknown',output.stderr.trim());
      if(failure||code!==0||signal)reject(Object.assign(failure??Error('控制命令退出'),{...output,code:(failure as NodeJS.ErrnoException|undefined)?.code??code,signal,killed}));else resolve(output);
    });
  });
  void ended.catch(()=>{});
  const timer=setTimeout(()=>{killed=true;failure??=Object.assign(Error('控制命令超时'),{code:'ETIMEDOUT'});child.kill();},options.timeout);
  try{return await ended;}finally{clearTimeout(timer);}
}
