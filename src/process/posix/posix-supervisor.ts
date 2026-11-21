import {embeddedSource} from "../../shared/embedded-source.js";
import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { mkdtempSync, unlinkSync, rmdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import net from 'node:net';
import {BridgeError} from '../../shared/errors.js';

                                     
export const posixSupervisorSource=                                 embeddedSource("javascript", `
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {readFileSync,writeFileSync} from 'node:fs';
export function supervise(onTerminate,completionFile) {
 let stopping=false,requested=false;
 const stop=(grace=2000)=>{
  if(stopping)return;stopping=true;
                                   
  if(!grace){process.kill(-process.pid,'SIGKILL');return;}
  process.kill(-process.pid,'SIGTERM');
  void settle(grace,true).then(rows=>{
   if(rows.length){process.kill(-process.pid,'SIGKILL');return;}
                                            
   if(completionFile)try{writeFileSync(completionFile,'',{flag:'wx',encoding:'utf8'});}catch(error){if(error.code!=='EEXIST')throw error;}
   process.exit(0);
  }).catch(error=>{process.stderr.write(String(error)+'\\n');process.kill(-process.pid,'SIGKILL');});
 };
 const terminate=()=>{if(stopping||requested)return;requested=true;Promise.resolve().then(()=>onTerminate?.()).finally(()=>stop()).catch(error=>process.stderr.write(String(error)+'\\n'));};
 process.on('SIGTERM',terminate);process.on('SIGINT',terminate);
 const members=async()=>{
  const env={...process.env,LC_ALL:undefined,LC_TIME:'C',TZ:'UTC'};
  try{
   const selection=process.platform==='darwin'?['-p',(await promisify(execFile)('/usr/bin/pgrep',['-g',String(process.pid)],{env,encoding:'utf8',timeout:2000})).stdout.trim().split(/\\s+/).join(',')]:['-s',String(process.pid)];
   const pending=promisify(execFile)(process.platform==='darwin'?'/bin/ps':'ps',[...selection,'-o','pid=,pgid=,stat=,comm='],{env,encoding:'utf8',timeout:2000});
   const {stdout}=await pending;
   return stdout.split('\\n').flatMap(line=>{const row=/^\\s*(\\d+)\\s+(\\d+)\\s+(\\S+)\\s+(.+?)\\s*$/.exec(line);return row&&Number(row[2])===process.pid&&Number(row[1])!==process.pid&&Number(row[1])!==pending.child.pid&&!/^[ZX]/.test(row[3])?[{pid:Number(row[1]),image:row[4].split('/').at(-1)}]:[];});
  }catch(error){if(error.code===1)return[];throw error;}
 };
 const present=pid=>{
  try{if(process.platform==='linux'){const stat=readFileSync('/proc/'+pid+'/stat','utf8');return!['Z','X'].includes(stat.slice(stat.lastIndexOf(')')+2)[0]);}process.kill(pid,0);return true;}
  catch(error){if(['ENOENT','ESRCH'].includes(error.code))return false;if(error.code==='EPERM')return true;throw error;}
 };
 const settle=async(grace,draining=false)=>{
  const deadline=Date.now()+grace;let rows=await members();
  for(;;){
   if(stopping&&!draining)return[];if(!rows.length||Date.now()>=deadline)return rows.map(row=>row.image);
   await new Promise(resolve=>setTimeout(resolve,Math.min(50,Math.max(0,deadline-Date.now()))));
   rows=rows.filter(row=>present(row.pid));
                                        
   if(!rows.length||Date.now()>=deadline)rows=await members();
  }
 };
 return{stop,settle,completion:file=>{completionFile=file;},get stopping(){return stopping;}};
}
`);

interface PosixSupervisor {stop:(grace?:number)=>void;settle:(grace:number)=>Promise<string[]>;completion:(file:string)=>void;readonly stopping:boolean}
let implementation:Promise<{supervise:(onTerminate?:()=>Promise<void>)=>PosixSupervisor}>|undefined,current:PosixSupervisor|undefined;
export async function supervisePosixGroup(onTerminate?:()=>Promise<void>):Promise<PosixSupervisor>{
  implementation??=import('data:text/javascript;base64,'+Buffer.from(posixSupervisorSource).toString('base64'));
  return current=(await implementation).supervise(onTerminate);
}

export interface NativeProcessExit {code:number|null;signal:NodeJS.Signals|null}
interface SupervisorMetadata {posixControl:string;registered?:boolean}
const exits=new WeakMap<ChildProcess,NativeProcessExit>(),metadata=new WeakMap<ChildProcess,SupervisorMetadata>();
export const posixSupervisorExit=(child:ChildProcess)=>exits.get(child);
export function posixSupervisorMetadata(child:ChildProcess):{posixControl?:string}{
  const value=metadata.get(child);if(!value)return{};value.registered=true;return{posixControl:value.posixControl};
}
export function configurePosixCompletion(file:string,child?:ChildProcess):void{
  if(!child){current?.completion(file);return;}
  const stream=child.stdio[3] as NodeJS.WritableStream|undefined;
  if(stream?.writable)stream.write(JSON.stringify({completionFile:file})+'\n');
}
export async function declarePosixNative(address:string,root:{pid:number;startedAt:string},native:{pid:number;startedAt:string}):Promise<void>{
  await new Promise<void>((resolve,reject)=>{
    const socket=net.createConnection(address);let buffer='';
    const finish=(error?:Error)=>{socket.removeAllListeners();socket.on('error',()=>{});socket.destroy();error?reject(error):resolve();};
    socket.setTimeout(10000,()=>finish(new BridgeError('launch_owner_unverified','监督进程未确认原生宿主交接，保留启动证据。')));
    socket.once('connect',()=>socket.write(JSON.stringify({root,native})+'\n'));
    socket.on('data',chunk=>{buffer+=chunk.toString('utf8');const end=buffer.indexOf('\n');if(end<0)return;try{const reply=JSON.parse(buffer.slice(0,end));finish(reply.ok?undefined:new BridgeError('process_launch_unverified','原生宿主交接被拒绝：'+reply.error));}catch(error){finish(error as Error);}});
    socket.once('error',error=>finish(new BridgeError('launch_owner_unverified','无法连接原启动监督进程：'+error.message)));
    socket.once('close',()=>finish(new BridgeError('launch_owner_unverified','监督进程在确认宿主前断开，保留启动证据。')));
  });
}
export async function watchPosixNative(child:ChildProcess,identity:{pid:number;startedAt:string}):Promise<void>{
  const value=metadata.get(child);if(!value)throw new BridgeError('launch_owner_unverified','原监督进程没有可重连的交接通道。');
  const {processIdentity}=await import('../process.js');await declarePosixNative(value.posixControl,await processIdentity(child.pid!),identity);
}

                                                              
export function spawnPosixSupervisor(command:string,args:string[],options:SpawnOptions&{waitForNative?:boolean}={}):ChildProcess{
  const source=                                 embeddedSource("javascript", `
import {spawn,execFile} from 'node:child_process';
import {Socket,createServer} from 'node:net';
import {promisify} from 'node:util';
import {readFileSync} from 'node:fs';
const request=JSON.parse(Buffer.from(process.argv[1],'base64').toString('utf8')),{supervise}=await import(request.supervisorModule),supervisor=supervise(undefined,request.completionFile);
let configured=false;
const owner=new Socket({fd:3,readable:true,writable:true});owner.on('error',()=>{});owner.on('end',()=>owner.destroy());owner.on('close',()=>{if(!configured)supervisor.stop();});owner.unref();
const report=result=>{if(!owner.destroyed)owner.write(JSON.stringify(result)+'\\n');};
let ownerBuffer='';owner.on('data',chunk=>{ownerBuffer+=chunk.toString('utf8');let end;while((end=ownerBuffer.indexOf('\\n'))>=0){try{const value=JSON.parse(ownerBuffer.slice(0,end));if(value.completionFile){supervisor.completion(value.completionFile);configured=true;}}catch(error){process.stderr.write(String(error)+'\\n');}ownerBuffer=ownerBuffer.slice(end+1);}});
let native,child;
if(request.waitForNative){
 const identity=async pid=>{
  if(process.platform==='linux'){
   try{const stat=readFileSync('/proc/'+pid+'/stat','utf8'),fields=stat.slice(stat.lastIndexOf(')')+2).trim().split(/\\s+/);return{pid,startedAt:fields[19],group:Number(fields[2]),state:fields[0]};}
   catch(error){if(['ENOENT','ESRCH'].includes(error.code))return;throw error;}
  }
  try{
   const {stdout}=await promisify(execFile)('/bin/ps',['-p',String(pid),'-o','pgid=,lstart=,stat='],{encoding:'utf8',timeout:2000,env:{...process.env,LC_ALL:undefined,LC_TIME:'C',TZ:'UTC'}}),row=/^\\s*(\\d+)\\s+(.+\\d{4})\\s+(\\S+)\\s*$/.exec(stdout);
   if(!row)throw Error('无法解析进程身份');return{pid,startedAt:row[2],group:Number(row[1]),state:row[3]};
  }catch(error){if(error.code===1)return;throw error;}
 };
 const root=await identity(process.pid);let timer,observing=false,reported=false,declaring=Promise.resolve();
 const observe=async()=>{
  if(observing||supervisor.stopping)return;observing=true;
  try{
   let alive;
   if(process.platform==='linux'){const value=await identity(native.pid);alive=value?.startedAt===native.startedAt&&!/^[ZX]/.test(value.state);}
   else try{process.kill(native.pid,0);alive=true;}catch(error){if(error.code==='EPERM')alive=true;else if(error.code==='ESRCH')alive=false;else throw error;}
   if(!alive){clearInterval(timer);supervisor.stop();}reported=false;
  }catch(error){if(!reported)process.stderr.write('原生宿主状态暂不可核验：'+String(error)+'\\n');reported=true;}
  finally{observing=false;}
 };
 const declare=async value=>{
  if(supervisor.stopping)throw Error('监督进程正在结束');
  if(value?.root?.pid!==root.pid||value.root.startedAt!==root.startedAt)throw Error('监督进程代次不符');
  const requested=value.native;
  if(!Number.isSafeInteger(requested?.pid)||requested.pid<=0||typeof requested.startedAt!=='string')throw Error('原生宿主身份无效');
  if(native){if(native.pid!==requested.pid||native.startedAt!==requested.startedAt)throw Error('已经声明另一个原生宿主');return;}
  const found=await identity(requested.pid);
  if(!found||found.startedAt!==requested.startedAt||found.group!==process.pid||/^[ZX]/.test(found.state)||found.pid===process.pid)throw Error('原生宿主不是此容器内的存活代次');
  native={pid:found.pid,startedAt:found.startedAt};
                                          
  if(native.pid===child.pid){if(child.exitCode!==null||child.signalCode!==null)supervisor.stop();}
  else timer=setInterval(()=>void observe(),500);
 };
 const server=createServer(socket=>{
  let buffer='',received=false;socket.on('error',()=>{});socket.setTimeout(10000,()=>socket.destroy());
  socket.on('data',chunk=>{
   if(received)return;buffer+=chunk.toString('utf8');const end=buffer.indexOf('\\n');if(end<0){if(buffer.length>8192)socket.destroy();return;}received=true;
   declaring=declaring.then(async()=>{try{await declare(JSON.parse(buffer.slice(0,end)));socket.end(JSON.stringify({ok:true})+'\\n');}catch(error){socket.end(JSON.stringify({ok:false,error:error.message})+'\\n');}});
  });
 });
 await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(request.posixControl,resolve);});
}
if(!supervisor.stopping){
child=spawn(request.command,request.args,{stdio:[0,1,2]});
child.once('error',error=>{process.stderr.write(String(error)+'\\n');report({code:1,signal:null,error:{message:error.message,code:error.code,syscall:error.syscall,path:error.path,spawnargs:error.spawnargs}});supervisor.stop();});
child.once('exit',async(code,signal)=>{
 report({code,signal});
 if(!request.waitForNative||native?.pid===child.pid)supervisor.stop();
 else if(!native&&!supervisor.stopping)try{if(!(await supervisor.settle(0)).length)supervisor.stop();}catch(error){process.stderr.write(String(error)+'\\n');}
                                             
});
}
`);
  const {waitForNative,...settings}=options,mode=settings.stdio??'pipe',stdio=typeof mode==='string'?[mode,mode,mode]:mode;
  const directory=waitForNative?mkdtempSync(path.join(tmpdir(),'nxbridge-supervisor-')):undefined,posixControl=directory?path.join(directory,'native.sock'):undefined;
  const child=spawn(process.execPath,['--input-type=module','-e',source,Buffer.from(JSON.stringify({command,args,waitForNative,posixControl,supervisorModule:'data:text/javascript;base64,'+Buffer.from(posixSupervisorSource).toString('base64')})).toString('base64')],{...settings,detached:true,stdio:[...stdio.slice(0,3),'pipe'],shell:false});
  if(posixControl){const value={posixControl,registered:false};metadata.set(child,value);child.once('close',()=>{if(value.registered)return;try{unlinkSync(posixControl);}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')process.stderr.write(String(error)+'\n');}try{rmdirSync(directory!);}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')process.stderr.write(String(error)+'\n');}});}
  let buffer='';const status=child.stdio[3];
  if(status&&'on' in status){
    status.on('data',chunk=>{buffer+=chunk.toString('utf8');let end;while((end=buffer.indexOf('\n'))>=0){const value=JSON.parse(buffer.slice(0,end));exits.set(child,{code:value.code,signal:value.signal});buffer=buffer.slice(end+1);if(value.error)child.emit('error',Object.assign(Error(value.error.message),value.error));}});
    status.on('error',()=>{});(status as typeof status&{unref?:()=>void}).unref?.();
  }
  return child;
}
