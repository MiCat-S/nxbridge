import {embeddedSource} from "../shared/embedded-source.js";
import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { windowsArgument } from '../process/windows/windows-background.js';
import { bootstrapBackground } from '../hosts/background-bootstrap.js';
import { brokerCall, listenBroker } from '../ipc/ipc.js';
import { recordBackgroundState } from '../hosts/background-state.js';
import {delay} from '../shared/time.js';
import {ensureHome} from '../ipc/home.js';
import {PACKAGE_ROOT} from '../shared/package-location.js';
import {windowsPowerShell} from '../shared/windows-tools.js';
import { ownedProcessState } from '../process/process-stop.js';
import { ownedProcesses, releaseOwnedProcess, rememberOwnedChild } from '../process/owned-processes.js';
import { temporaryDirectory } from './support/temporary.js';
import { requireIndependentWindows } from './support/windows-job.js';

                                         
const source=                             embeddedSource("csharp", `
using System;using System.ComponentModel;using System.Runtime.InteropServices;using System.Text;
public sealed class NxPrivateJob:IDisposable {
 [StructLayout(LayoutKind.Sequential)] struct Basic {public long processTime,jobTime;public uint flags;public UIntPtr min,max;public uint count;public UIntPtr affinity;public uint priority,scheduling;}
 [StructLayout(LayoutKind.Sequential)] struct Io {public ulong r,w,o,rb,wb,ob;}
 [StructLayout(LayoutKind.Sequential)] struct Limits {public Basic basic;public Io io;public UIntPtr process,job,peakProcess,peakJob;}
 [StructLayout(LayoutKind.Sequential,CharSet=CharSet.Unicode)] struct Startup {public int cb;public string reserved,desktop,title;public int x,y,w,h,xc,yc,fill,flags;public short show,n;public IntPtr bytes,input,output,error;}
 [StructLayout(LayoutKind.Sequential)] struct Info {public IntPtr process,thread;public uint pid,tid;}
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern IntPtr CreateJobObjectW(IntPtr attributes,string name);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool SetInformationJobObject(IntPtr job,int type,IntPtr data,uint size);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool AssignProcessToJobObject(IntPtr job,IntPtr process);
 [DllImport("kernel32.dll",SetLastError=true)] static extern IntPtr OpenProcess(uint access,bool inherit,uint pid);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool IsProcessInJob(IntPtr process,IntPtr job,out bool inside);
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool CreateProcessW(string exe,StringBuilder command,IntPtr pa,IntPtr ta,bool inherit,uint flags,IntPtr env,string cwd,ref Startup startup,out Info info);
 [DllImport("kernel32.dll",SetLastError=true)] static extern uint ResumeThread(IntPtr thread);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool TerminateProcess(IntPtr process,uint code);
 [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
 IntPtr job,outer;
 static IntPtr Create(bool allow) {
  IntPtr job=CreateJobObjectW(IntPtr.Zero,null);if(job==IntPtr.Zero)throw new Win32Exception(Marshal.GetLastWin32Error());
  Limits limits=new Limits();limits.basic.flags=0x2000u|(allow?0x800u:0u);int size=Marshal.SizeOf(typeof(Limits));IntPtr data=Marshal.AllocHGlobal(size);
  try {Marshal.StructureToPtr(limits,data,false);if(!SetInformationJobObject(job,9,data,(uint)size))throw new Win32Exception(Marshal.GetLastWin32Error());}finally{Marshal.FreeHGlobal(data);}
  return job;
 }
 public uint Start(string exe,string command,string cwd,bool allow,bool nested) {
  job=Create(allow);if(nested)outer=Create(false);
  Startup startup=new Startup();startup.cb=Marshal.SizeOf(typeof(Startup));Info child;
  if(!CreateProcessW(exe,new StringBuilder(command),IntPtr.Zero,IntPtr.Zero,false,0x08000004,IntPtr.Zero,cwd,ref startup,out child))throw new Win32Exception(Marshal.GetLastWin32Error());
  bool running=false;try {if(outer!=IntPtr.Zero&&!AssignProcessToJobObject(outer,child.process))throw new Win32Exception(Marshal.GetLastWin32Error());if(!AssignProcessToJobObject(job,child.process))throw new Win32Exception(Marshal.GetLastWin32Error());if(ResumeThread(child.thread)==0xffffffff)throw new Win32Exception(Marshal.GetLastWin32Error());running=true;return child.pid;}
  finally{if(!running)TerminateProcess(child.process,1);CloseHandle(child.thread);CloseHandle(child.process);}
 }
 bool ContainsIn(uint pid,IntPtr target){IntPtr process=OpenProcess(0x1000,false,pid);if(process==IntPtr.Zero)throw new Win32Exception(Marshal.GetLastWin32Error());try{bool inside;if(!IsProcessInJob(process,target,out inside))throw new Win32Exception(Marshal.GetLastWin32Error());return inside;}finally{CloseHandle(process);}}
 public bool Contains(uint pid){return ContainsIn(pid,job);}
 public bool ContainsOuter(uint pid){return outer!=IntPtr.Zero&&ContainsIn(pid,outer);}
 public void Dispose(){if(job!=IntPtr.Zero){CloseHandle(job);job=IntPtr.Zero;}if(outer!=IntPtr.Zero){CloseHandle(outer);outer=IntPtr.Zero;}}
}`);
const controller=                                 embeddedSource("powershell", `
$ErrorActionPreference='Stop'
$files=[CodeDom.Compiler.TempFileCollection]::new($env:NXBRIDGE_JOB_COMPILER,$false)
$compiler=[CodeDom.Compiler.CompilerParameters]::new();$compiler.GenerateInMemory=$true;$compiler.TempFiles=$files;$null=$compiler.ReferencedAssemblies.Add('System.dll')
$job=$null
try {
 Add-Type -TypeDefinition $env:NXBRIDGE_JOB_SOURCE -CompilerParameters $compiler
 $job=[NxPrivateJob]::new();$pidValue=$job.Start($env:NXBRIDGE_JOB_NODE,$env:NXBRIDGE_JOB_COMMAND,$env:NXBRIDGE_JOB_CWD,$env:NXBRIDGE_JOB_ALLOW -eq 'yes',$env:NXBRIDGE_JOB_NESTED -eq 'yes')
 while(!(Test-Path -LiteralPath $env:NXBRIDGE_JOB_CLOSE)){
  if((Test-Path -LiteralPath $env:NXBRIDGE_JOB_READY) -and !(Test-Path -LiteralPath $env:NXBRIDGE_JOB_MEMBERSHIP)){
   $ready=Get-Content -LiteralPath $env:NXBRIDGE_JOB_READY -Raw -Encoding UTF8|ConvertFrom-Json
   $members=@();if($ready.ok){$members=@($ready.records|ForEach-Object{$job.Contains([uint32]$_.identity.pid)})};$membership=@{runner=$job.Contains([uint32]$ready.runner.pid);outerRunner=$job.ContainsOuter([uint32]$ready.runner.pid);broker=$(if($ready.ok){$job.Contains([uint32]$ready.broker.pid)}else{$null});children=$members};[IO.File]::WriteAllText($env:NXBRIDGE_JOB_MEMBERSHIP+'.tmp',($membership|ConvertTo-Json -Compress),[Text.UTF8Encoding]::new($false));[IO.File]::Move($env:NXBRIDGE_JOB_MEMBERSHIP+'.tmp',$env:NXBRIDGE_JOB_MEMBERSHIP)
  }
  Start-Sleep -Milliseconds 50
 }
} catch {[IO.File]::WriteAllText($env:NXBRIDGE_JOB_ERROR,$_.Exception.ToString(),[Text.UTF8Encoding]::new($false))}
finally {if($job){$job.Dispose()};$files.Delete()}
`);

async function until(check:()=>boolean|Promise<boolean>,reason:string):Promise<void>{
  const end=Date.now()+45000;
  while(!await check()){if(Date.now()>end)throw Error(reason);await delay(50);}
}

async function startController(t:TestContext,home:string,root:string,files:{runner:string;compiler:string;close:string;error:string;ready:string;membership:string},allow:boolean,nested:boolean){
                                                   
  const child=spawn(windowsPowerShell(),['-NoLogo','-NoProfile','-NonInteractive','-Command',controller],{cwd:root,windowsHide:true,stdio:'ignore',env:{...process.env,NXBRIDGE_JOB_SOURCE:source,NXBRIDGE_JOB_COMPILER:files.compiler,NXBRIDGE_JOB_NODE:process.execPath,NXBRIDGE_JOB_COMMAND:[process.execPath,files.runner].map(windowsArgument).join(' '),NXBRIDGE_JOB_CWD:root,NXBRIDGE_JOB_ALLOW:allow?'yes':'no',NXBRIDGE_JOB_NESTED:nested?'yes':'no',NXBRIDGE_JOB_CLOSE:files.close,NXBRIDGE_JOB_ERROR:files.error,NXBRIDGE_JOB_READY:files.ready,NXBRIDGE_JOB_MEMBERSHIP:files.membership}});
  const closed=once(child,'close');
  t.after(async()=>{if(child.exitCode===null&&child.signalCode===null)child.kill();await closed;});
  const owner=await rememberOwnedChild(home,child,'host-control');
  assert.ok(owner,existsSync(files.error)?readFileSync(files.error,'utf8'):'私有 Job 控制器未登记');
  return owner;
}

for(const {allow,nested} of [{allow:true,nested:false},{allow:false,nested:false},{allow:true,nested:true}])test(`私有 kill-on-close Job ${nested?'外层拒绝且内层允许':allow?'允许':'拒绝'} breakaway，关闭后独立后台存活或明确引导`,{skip:process.platform!=='win32',timeout:110000},async t=>{
  const expected=allow&&!nested;
  if(expected&&!await requireIndependentWindows(t))return;
  const temp=temporaryDirectory(),root=temp.directory,home=path.join(root,'bridge');await ensureHome(home);
  const ready=path.join(root,'ready.json'),membership=path.join(root,'membership.json'),close=path.join(root,'close'),error=path.join(root,'controller-error'),compiler=path.join(root,'compiler'),runner=path.join(root,'runner.mjs');mkdirSync(compiler);
  const moduleUrl=(name:string)=>JSON.stringify(pathToFileURL(path.join(PACKAGE_ROOT,'dist',name+'.js')).href);
  writeFileSync(runner,`import{atomicJson}from ${moduleUrl('shared/files')};import{processIdentity}from ${moduleUrl('process/process')};import{ensureBroker}from ${moduleUrl('ipc/ipc')};import{backgroundState}from ${moduleUrl('hosts/background-state')};import{launchIndependentWindows}from ${moduleUrl('process/windows/windows-background')};import{windowsIndependentAvailable}from ${moduleUrl('tests/support/windows-job')};import{randomUUID}from'node:crypto';
const home=${JSON.stringify(home)},out=${JSON.stringify(ready)},records=[];let result,broker;try{const rpc=await ensureBroker(home);broker=await rpc.request('ping',{});rpc.close();for(let i=0;i<2;i++)records.push(await launchIndependentWindows({home,executable:process.execPath,args:['-e','setInterval(()=>{},1000)'],cwd:home,env:{...process.env},logfile:home+'/run/partner-'+i+'.log',role:'codex-runtime',launchId:randomUUID(),peerId:'partner-'+i}));result={ok:true,broker,records};}catch(e){const first=backgroundState(home);let second;try{await ensureBroker(home);}catch(error){second={code:error.code,message:error.message};}result={ok:false,broker,code:e.code,message:e.message,first,second,unchanged:JSON.stringify(first)===JSON.stringify(backgroundState(home))};}let breakaway;try{breakaway=await windowsIndependentAvailable();}catch(error){breakaway=String(error);}atomicJson(out,{...result,breakaway,runner:await processIdentity(process.pid)});setInterval(()=>{},1000);`,'utf8');
  t.after(async()=>{try{writeFileSync(close,'close','utf8');try{await brokerCall('shutdown',{releaseOwned:true},{home,start:false,mutation:true});}catch(e){if(!['ENOENT','ECONNREFUSED','EPIPE'].includes((e as any).code))throw e;}for(const record of ownedProcesses(home).records.reverse())if(await ownedProcessState(record.identity)!=='dead')await releaseOwnedProcess(record);}finally{await temp.cleanup();}});
  const owner=await startController(t,home,root,{runner,compiler,close,error,ready,membership},allow,nested);
  await until(()=>existsSync(ready)||existsSync(error),'私有 Job 未返回结果');assert.equal(existsSync(error),false,existsSync(error)?readFileSync(error,'utf8'):'');
  const result=JSON.parse(readFileSync(ready,'utf8'));
  await until(()=>existsSync(membership)||existsSync(error),'未核验调用方 Job 成员关系');assert.equal(existsSync(error),false);
  const callerMembership=JSON.parse(readFileSync(membership,'utf8'));assert.equal(callerMembership.runner,true);assert.equal(callerMembership.outerRunner,nested);
  assert.equal(result.breakaway,expected,'能力探针应反映私有 Job 的实际继承限制');
  assert.equal(result.ok,expected,JSON.stringify({...result,callerMembership}));
  if(expected)assert.deepEqual(callerMembership,{runner:true,outerRunner:false,broker:false,children:[false,false]});
  writeFileSync(close,'close','utf8');
  await until(async()=>await ownedProcessState(owner.identity)==='dead'&&await ownedProcessState(result.runner)==='dead','关闭私有 Job 后原窗口夹具未退出');
  if(expected){
    assert.equal(result.broker.runtime.windowsIndependent,true);
    assert.equal((await brokerCall<{pid:number}>('ping',{}, {home,start:false})).pid,result.broker.pid);
    for(const record of result.records){assert.equal(record.windowsIndependent,true);assert.equal(await ownedProcessState(record.identity),'alive');}
  }else{
    assert.equal(result.broker,undefined);assert.equal(result.code,'bootstrap_required');assert.equal(result.second.code,'bootstrap_required');assert.equal(result.unchanged,true);assert.match(result.second.message,/未重复尝试/);
    assert.equal(ownedProcesses(home).records.some(record=>record.role==='broker'),false);
    await t.test('在允许脱离的调用环境中可显式引导',async t=>{
      if(!await requireIndependentWindows(t))return;
      assert.match((await bootstrapBackground(home)).text,/已独立运行/);
      assert.equal((await brokerCall<any>('ping',{}, {home,start:false})).runtime.windowsIndependent,true);
    });
  }
});

test('拒绝 breakaway 的实际 Job 内执行 bootstrap，预检失败保留旧协调器及原诊断',{skip:process.platform!=='win32',timeout:65000},async t=>{
  const temp=temporaryDirectory(),root=temp.directory,home=path.join(root,'bridge');await ensureHome(home);
  const ready=path.join(root,'ready.json'),membership=path.join(root,'membership.json'),close=path.join(root,'close'),error=path.join(root,'controller-error'),compiler=path.join(root,'compiler'),runner=path.join(root,'runner.mjs');mkdirSync(compiler);
  const moduleUrl=(name:string)=>JSON.stringify(pathToFileURL(path.join(PACKAGE_ROOT,'dist',name+'.js')).href),methods:string[]=[];
  recordBackgroundState(home,'其他调用环境的历史诊断');const state=path.join(home,'run','background-state.json'),before=readFileSync(state);
  const server=await listenBroker(home,async method=>{methods.push(method);assert.equal(method,'ping','预检失败不能关闭旧协调器');return{pid:process.pid,runtime:{windowsIndependent:false}};});
  writeFileSync(runner,`import{atomicJson}from ${moduleUrl('shared/files')};import{processIdentity}from ${moduleUrl('process/process')};import{bootstrapBackground}from ${moduleUrl('hosts/background-bootstrap')};let result;try{await bootstrapBackground(${JSON.stringify(home)});result={ok:true};}catch(error){result={ok:false,code:error.code,message:error.message};}atomicJson(${JSON.stringify(ready)},{...result,runner:await processIdentity(process.pid)});setInterval(()=>{},1000);`,'utf8');
  t.after(async()=>{try{await server.close();}finally{await temp.cleanup();}});
  const owner=await startController(t,home,root,{runner,compiler,close,error,ready,membership},false,false);
  await until(()=>existsSync(ready)||existsSync(error),'实际 Job 中的 bootstrap 未返回');assert.equal(existsSync(error),false,existsSync(error)?readFileSync(error,'utf8'):'');
  const result=JSON.parse(readFileSync(ready,'utf8'));assert.equal(result.ok,false);assert.equal(result.code,'bootstrap_context_unavailable');assert.match(result.message,/普通 PowerShell.*nxbridge bootstrap/);
  await until(()=>existsSync(membership),'未确认调用进程实际属于拒绝 breakaway 的 Job');assert.equal(JSON.parse(readFileSync(membership,'utf8')).runner,true);
  assert.deepEqual(methods,['ping']);assert.deepEqual(readFileSync(state),before);assert.equal(existsSync(path.join(home,'run','broker-startup.db')),false);
  assert.equal((await brokerCall<any>('ping',{}, {home,start:false})).pid,process.pid);
  writeFileSync(close,'close','utf8');await until(async()=>await ownedProcessState(owner.identity)==='dead'&&await ownedProcessState(result.runner)==='dead','私有 Job 未退出');
});
