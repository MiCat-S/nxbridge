import {embeddedSource} from "../../shared/embedded-source.js";
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { mkdtempSync, rmdirSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {windowsPowerShell} from '../../shared/windows-tools.js';
import { retireDeadOwnedProcess, recordSpawnedProcess, rememberOwnedChild, ownedRecordState, completeOwnedContainer, type OwnedProcessRecord, type OwnedProcessRole } from '../owned-processes.js';
import { ownedProcessState } from '../process-stop.js';
import {BridgeError,describeError} from '../../shared/errors.js';
import { deferBackgroundRetry } from '../../hosts/background-state.js';
import { windowsHookIdentityHelper } from './windows-hook-identity.js';
import { randomUUID } from 'node:crypto';
import { processRegistryDirectory } from '../owned-processes.js';

export const WINDOWS_BACKGROUND_TIMEOUT_MS=20000;
export const WINDOWS_BACKGROUND_EXIT_TIMEOUT_MS=3000;

                                                
export const windowsBackgroundSource=                             embeddedSource("csharp", `
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;
public sealed class NxBackground : IDisposable {
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] struct Startup {
    public int cb; public string reserved, desktop, title;
    public int x,y,width,height,xchars,ychars,fill,flags; public short show,reservedSize;
    public IntPtr reservedBytes,input,output,error;
  }
  [StructLayout(LayoutKind.Sequential)] struct StartupEx {public Startup startup;public IntPtr attributes;}
  [StructLayout(LayoutKind.Sequential)] struct ProcessInfo {public IntPtr process,thread;public uint pid,tid;}
  [StructLayout(LayoutKind.Sequential)] struct Security {public int length;public IntPtr descriptor;[MarshalAs(UnmanagedType.Bool)]public bool inherit;}
  [StructLayout(LayoutKind.Sequential)] struct JobBasic {public long processTime,jobTime;public uint flags;public UIntPtr min,max;public uint count;public UIntPtr affinity;public uint priority,scheduling;}
  [StructLayout(LayoutKind.Sequential)] struct JobIo {public ulong r,w,o,rb,wb,ob;}
  [StructLayout(LayoutKind.Sequential)] struct JobLimits {public JobBasic basic;public JobIo io;public UIntPtr process,job,peakProcess,peakJob;}
  [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool CreateProcessW(string app,StringBuilder command,IntPtr pa,IntPtr ta,bool inherit,uint flags,IntPtr environment,string cwd,ref StartupEx startup,out ProcessInfo info);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool InitializeProcThreadAttributeList(IntPtr list,int count,int flags,ref IntPtr size);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool UpdateProcThreadAttribute(IntPtr list,uint flags,IntPtr attribute,IntPtr value,IntPtr size,IntPtr previous,IntPtr returned);
  [DllImport("kernel32.dll")] static extern void DeleteProcThreadAttributeList(IntPtr list);
  [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern IntPtr CreateFileW(string name,uint access,uint share,ref Security security,uint creation,uint flags,IntPtr template);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool IsProcessInJob(IntPtr process,IntPtr job,out bool inside);
  [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern IntPtr CreateJobObjectW(IntPtr attributes,string name);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool SetInformationJobObject(IntPtr job,int kind,IntPtr data,uint size);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool AssignProcessToJobObject(IntPtr job,IntPtr process);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool GetProcessTimes(IntPtr process,out long created,out long exited,out long kernel,out long user);
  [DllImport("kernel32.dll",SetLastError=true)] static extern uint ResumeThread(IntPtr thread);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool TerminateProcess(IntPtr process,uint code);
  [DllImport("kernel32.dll",SetLastError=true)] static extern uint WaitForSingleObject(IntPtr handle,uint milliseconds);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
  [DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();
  [DllImport("kernel32.dll")] static extern uint GetCurrentProcessId();
  [DllImport("kernel32.dll")] static extern uint WaitForMultipleObjects(uint count,IntPtr[] handles,bool all,uint timeout);
  ProcessInfo info,holder; bool resumed,entryStarted;string completionFile;IntPtr guard;System.Threading.EventWaitHandle ready,commit;
  void GuardLimits(bool killOnClose) {
    JobLimits limits=new JobLimits();limits.basic.flags=0x0800u|(killOnClose?0x2000u:0u);
    int size=Marshal.SizeOf(typeof(JobLimits));IntPtr data=Marshal.AllocHGlobal(size);
    try {Marshal.StructureToPtr(limits,data,false);if(!SetInformationJobObject(guard,9,data,(uint)size))throw new Win32Exception(Marshal.GetLastWin32Error());}
    finally {Marshal.FreeHGlobal(data);}
  }
  public uint Pid {get {return info.pid;}}
  public string Generation {get;private set;}
  public string JobName {get;private set;}
  public uint HolderPid {get {return holder.pid;}}
  public string HolderGeneration {get;private set;}
  public void Protect(string executable,bool handoff,string completion) {
    completionFile=completion;
    ready=new System.Threading.EventWaitHandle(false,System.Threading.EventResetMode.ManualReset,JobName+"-ready");
    commit=new System.Threading.EventWaitHandle(false,System.Threading.EventResetMode.ManualReset,JobName+"-commit");
    long own,exited,kernel,user;if(!GetProcessTimes(GetCurrentProcess(),out own,out exited,out kernel,out user))throw new Win32Exception(Marshal.GetLastWin32Error());
    StartupEx startup=new StartupEx();startup.startup.cb=Marshal.SizeOf(typeof(Startup));
    string command="\\""+executable+"\\" job-hold \\""+JobName+"\\" "+info.pid+" "+Generation+" "+GetCurrentProcessId()+" "+own+" "+(handoff?"handoff":"direct")+" \\""+completion+"\\"";
                                               
    if(!CreateProcessW(executable,new StringBuilder(command),IntPtr.Zero,IntPtr.Zero,false,0x01000000|0x08000000,IntPtr.Zero,null,ref startup,out holder))throw new Win32Exception(Marshal.GetLastWin32Error());
    if(WaitForMultipleObjects(2,new IntPtr[]{ready.SafeWaitHandle.DangerousGetHandle(),holder.process},false,10000)!=0)throw new InvalidOperationException("job holder startup unconfirmed");
    long created;if(!GetProcessTimes(holder.process,out created,out exited,out kernel,out user))throw new Win32Exception(Marshal.GetLastWin32Error());HolderGeneration=created.ToString();
  }
  public void Start(string app,string command,string environment,string cwd,string logfile) {
    IntPtr block=IntPtr.Zero,log=IntPtr.Zero,input=IntPtr.Zero,attributes=IntPtr.Zero,handles=IntPtr.Zero;bool initialized=false;
    try {
      Security security=new Security();security.length=Marshal.SizeOf(typeof(Security));security.inherit=true;
      log=CreateFileW(logfile,0x00000004,7,ref security,4,0x80,IntPtr.Zero);
      if(log==new IntPtr(-1))throw new Win32Exception(Marshal.GetLastWin32Error());
      input=CreateFileW("NUL",0x80000000,7,ref security,3,0x80,IntPtr.Zero);
      if(input==new IntPtr(-1))throw new Win32Exception(Marshal.GetLastWin32Error());
      StartupEx startup=new StartupEx();startup.startup.cb=Marshal.SizeOf(typeof(StartupEx));startup.startup.flags=0x100;startup.startup.input=input;startup.startup.output=log;startup.startup.error=log;
      JobName="Global\\\\nxbridge-job-"+Guid.NewGuid().ToString("N");
      guard=CreateJobObjectW(IntPtr.Zero,JobName);if(guard==IntPtr.Zero)throw new Win32Exception(Marshal.GetLastWin32Error());GuardLimits(true);
      IntPtr size=IntPtr.Zero;InitializeProcThreadAttributeList(IntPtr.Zero,1,0,ref size);
      attributes=Marshal.AllocHGlobal(size);
      if(!InitializeProcThreadAttributeList(attributes,1,0,ref size))throw new Win32Exception(Marshal.GetLastWin32Error());
      initialized=true;handles=Marshal.AllocHGlobal(IntPtr.Size*2);Marshal.WriteIntPtr(handles,input);Marshal.WriteIntPtr(handles,IntPtr.Size,log);
      if(!UpdateProcThreadAttribute(attributes,0,new IntPtr(0x00020002),handles,new IntPtr(IntPtr.Size*2),IntPtr.Zero,IntPtr.Zero))throw new Win32Exception(Marshal.GetLastWin32Error());
      startup.attributes=attributes;
      block=Marshal.StringToHGlobalUni(environment);
      if(!CreateProcessW(app,new StringBuilder(command),IntPtr.Zero,IntPtr.Zero,true,0x01000000|0x08000000|0x00000400|0x00000004|0x00080000,block,cwd,ref startup,out info))throw new Win32Exception(Marshal.GetLastWin32Error());
      bool inside;
      if(!IsProcessInJob(info.process,IntPtr.Zero,out inside))throw new Win32Exception(Marshal.GetLastWin32Error());
      if(inside)throw new InvalidOperationException("child remains in inherited Windows Job");
                                                    
                                               
      if(!AssignProcessToJobObject(guard,info.process))throw new Win32Exception(Marshal.GetLastWin32Error());
      long created,exited,kernel,user;
      if(!GetProcessTimes(info.process,out created,out exited,out kernel,out user))throw new Win32Exception(Marshal.GetLastWin32Error());
      Generation=created.ToString();
    }
    finally {if(initialized)DeleteProcThreadAttributeList(attributes);if(attributes!=IntPtr.Zero)Marshal.FreeHGlobal(attributes);if(handles!=IntPtr.Zero)Marshal.FreeHGlobal(handles);if(block!=IntPtr.Zero)Marshal.FreeHGlobal(block);if(log!=IntPtr.Zero&&log!=new IntPtr(-1))CloseHandle(log);if(input!=IntPtr.Zero&&input!=new IntPtr(-1))CloseHandle(input);}
  }
  public void Resume() {
    if(holder.process!=IntPtr.Zero&&WaitForSingleObject(holder.process,0)!=258)throw new InvalidOperationException("job holder exited before commit");
    if(ResumeThread(info.thread)==0xffffffff)throw new Win32Exception(Marshal.GetLastWin32Error());
    entryStarted=true;
                                                      
    GuardLimits(false);if(commit!=null)commit.Set();resumed=true;CloseHandle(guard);guard=IntPtr.Zero;
  }
  public void Dispose() {
    try {
      if(info.process!=IntPtr.Zero&&!resumed&&WaitForSingleObject(info.process,0)!=0){
        if(!TerminateProcess(info.process,1))throw new Win32Exception(Marshal.GetLastWin32Error());
        if(WaitForSingleObject(info.process,5000)!=0)throw new InvalidOperationException("suspended child exit unconfirmed");
      }
                                             
      if(!entryStarted&&info.process!=IntPtr.Zero&&completionFile!=null){
        System.IO.Directory.CreateDirectory(System.IO.Path.GetDirectoryName(completionFile));
        try{using(var receipt=new System.IO.FileStream(completionFile,System.IO.FileMode.CreateNew,System.IO.FileAccess.Write)){} }catch(System.IO.IOException){if(!System.IO.File.Exists(completionFile))throw;}
      }
    } finally {
      if(guard!=IntPtr.Zero){CloseHandle(guard);guard=IntPtr.Zero;}
      if(info.process!=IntPtr.Zero){CloseHandle(info.process);info.process=IntPtr.Zero;}
      if(info.thread!=IntPtr.Zero){CloseHandle(info.thread);info.thread=IntPtr.Zero;}
      if(commit!=null){commit.Dispose();commit=null;}if(ready!=null){ready.Dispose();ready=null;}
      if(holder.process!=IntPtr.Zero){CloseHandle(holder.process);holder.process=IntPtr.Zero;}if(holder.thread!=IntPtr.Zero){CloseHandle(holder.thread);holder.thread=IntPtr.Zero;}
    }
  }
}`);

const script=                                 embeddedSource("powershell", `
$ErrorActionPreference='Stop'
$OutputEncoding=[Text.UTF8Encoding]::new($false);[Console]::InputEncoding=$OutputEncoding;[Console]::OutputEncoding=$OutputEncoding
$request=[Console]::ReadLine()|ConvertFrom-Json
$tempFiles=[CodeDom.Compiler.TempFileCollection]::new($request.tempDirectory,$false)
$compiler=[CodeDom.Compiler.CompilerParameters]::new();$compiler.GenerateInMemory=$true;$compiler.TempFiles=$tempFiles
$null=$compiler.ReferencedAssemblies.Add('System.dll')
$launcher=$null
$reported=$false
try {
  Add-Type -TypeDefinition $request.source -CompilerParameters $compiler
  $environment=($request.environment.PSObject.Properties|Sort-Object Name|ForEach-Object {$_.Name+'='+[string]$_.Value}) -join [char]0
  $environment+=[string][char]0+[char]0
  $launcher=[NxBackground]::new()
  $launcher.Start($request.executable,$request.command,$environment,$request.cwd,$request.logfile)
  if($request.probe){
    $pidValue=$launcher.Pid;$generation=$launcher.Generation
    $launcher.Dispose();$launcher=$null
    [Console]::WriteLine((@{pid=$pidValue;generation=$generation;independent=$true;stopped=$true}|ConvertTo-Json -Compress));[Console]::Out.Flush()
    $reported=$true
  }else{
  $proof=@{pid=$launcher.Pid;generation=$launcher.Generation;independent=$true}
  if($request.holder){$launcher.Protect($request.holder,$request.handoff,$request.completionFile);$proof.job=$launcher.JobName;$proof.holder=@{pid=$launcher.HolderPid;startedAt=$launcher.HolderGeneration}}
  [Console]::WriteLine(($proof|ConvertTo-Json -Compress -Depth 3));[Console]::Out.Flush()
  $reported=$true
  if([Console]::ReadLine() -ne 'resume'){throw 'launch canceled before ownership commit'}
  $launcher.Resume()
  [Console]::WriteLine('{"resumed":true}');[Console]::Out.Flush()
  }
} catch {
  if(!$reported){[Console]::WriteLine((@{pid=$(if($launcher){$launcher.Pid}else{0});generation=$(if($launcher){$launcher.Generation}else{$null});error=$_.Exception.Message}|ConvertTo-Json -Compress));[Console]::Out.Flush()}
  [Console]::Error.WriteLine($_.Exception.Message)
  $global:LASTEXITCODE=1
} finally {
  try {if($launcher){$launcher.Dispose()}}
  catch {[Console]::Error.WriteLine('child cleanup unconfirmed: '+$_.Exception.Message);$global:LASTEXITCODE=1}
  finally {$tempFiles.Delete()}
}
if($global:LASTEXITCODE){exit 1}
`);

export function windowsArgument(value:string):string{
  let result='"',slashes=0;
  for(const ch of value){if(ch==='\\'){slashes++;continue;}if(ch==='"'){result+='\\'.repeat(slashes*2+1)+'"';slashes=0;continue;}result+='\\'.repeat(slashes)+ch;slashes=0;}
  return result+'\\'.repeat(slashes*2)+'"';
}

                                              
export async function probeIndependentWindows(executable:string,env:NodeJS.ProcessEnv):Promise<void>{
  if(process.platform!=='win32')return;
  const tempDirectory=mkdtempSync(path.join(tmpdir(),'nxbridge-context-probe-')),logfile=path.join(tempDirectory,'probe.log');
  const helper=spawn(windowsPowerShell(),['-NoLogo','-NoProfile','-NonInteractive','-Command',script],{windowsHide:true,stdio:['pipe','pipe','pipe']});
  let stdout='',stderr='',expired=false;
  helper.stdout.on('data',chunk=>{if(stdout.length<16384)stdout+=chunk.toString('utf8');});helper.stderr.on('data',chunk=>{if(stderr.length<8192)stderr+=chunk.toString('utf8');});helper.stdin.on('error',()=>{});
  const ended=new Promise<number>((resolve,reject)=>{helper.once('error',reject);helper.once('close',code=>resolve(code??1));});
  const timer=setTimeout(()=>{expired=true;helper.kill();},WINDOWS_BACKGROUND_TIMEOUT_MS);
  try{
    helper.stdin.end(JSON.stringify({probe:true,source:windowsBackgroundSource,tempDirectory,executable,command:[executable,'-e',''].map(windowsArgument).join(' '),cwd:tempDirectory,environment:env,logfile})+'\n');
    const code=await ended,proof=stdout.split(/\r?\n/).filter(Boolean).map(line=>{try{return JSON.parse(line);}catch{return undefined;}}).find(value=>value?.independent&&value.stopped);
    if(code!==0||!proof||expired)throw new BridgeError('bootstrap_context_unavailable','当前环境无法启动独立后台，原协调器未改变。请在 Claude/Codex 之外的普通 PowerShell 执行 nxbridge bootstrap。原因：'+(stderr.trim()||stdout.trim()||'启动环境核验超时'));
  }finally{
    clearTimeout(timer);
    try{unlinkSync(logfile);}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
    try{rmdirSync(tempDirectory);}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')process.stderr.write('启动环境探针临时文件清理未完成：'+tempDirectory+'：'+describeError(error)+'\n');}
  }
}

export async function launchIndependentWindows(options:{home:string;executable:string;args:string[];cwd:string;env:NodeJS.ProcessEnv;logfile:string;role:OwnedProcessRole;launchId:string;peerId?:string;configHome?:string;deadline?:number}):Promise<OwnedProcessRecord>{
  if(process.platform!=='win32')throw new BridgeError('background_platform','此启动器仅用于 Windows。');
                                                           
  const holder=options.role==='broker'?undefined:await windowsHookIdentityHelper(options.home);
  const recordId=randomUUID(),completionFile=holder?path.join(processRegistryDirectory(options.home),recordId+'.json.done'):undefined;
  const tempDirectory=mkdtempSync(path.join(options.home,'run','launcher-'));
  const helper=spawn(windowsPowerShell(),['-NoLogo','-NoProfile','-NonInteractive','-Command',script],{windowsHide:true,stdio:['pipe','pipe','pipe']});
  const lines=createInterface({input:helper.stdout}),queue:unknown[]=[];let waiter:((value:any)=>void)|undefined,stderr='',ended=false;
  lines.on('line',line=>{let value:unknown;try{value=JSON.parse(line);}catch{return;}if(waiter){const done=waiter;waiter=undefined;done(value);}else queue.push(value);});
  helper.stderr.on('data',data=>{if(stderr.length<8192)stderr+=data.toString('utf8');});
  const fail=(error:string)=>{waiter?.({error});waiter=undefined;};
  const exit=new Promise<number>(resolve=>{helper.once('error',error=>{stderr+=describeError(error);ended=true;fail(stderr);resolve(1);});helper.once('close',code=>{ended=true;fail(stderr||'launcher exited');resolve(code??1);});});
  helper.stdin.on('error',error=>{stderr+=describeError(error);fail(stderr);});
  let expired=false;
  const finishInput=(command:string)=>{if(!helper.stdin.destroyed&&!helper.stdin.writableEnded)helper.stdin.end(command+'\n');};
  const next=async():Promise<any>=>queue.length?queue.shift():expired?{error:'launcher timed out'}:ended?{error:stderr||'launcher exited'}:new Promise(resolve=>{waiter=resolve;});
  const left=(limit:number)=>options.deadline===undefined?limit:Math.max(0,Math.min(limit,options.deadline-performance.now()));
  const timer=setTimeout(()=>{expired=true;finishInput('cancel');fail('launcher timed out');},left(WINDOWS_BACKGROUND_TIMEOUT_MS));
  const boundedExit=async()=>{
    let timeout:NodeJS.Timeout|undefined;
    try{return await Promise.race([exit,new Promise<undefined>(resolve=>{timeout=setTimeout(()=>resolve(undefined),left(WINDOWS_BACKGROUND_EXIT_TIMEOUT_MS));})]);}
    finally{clearTimeout(timeout);}
  };
  let record:OwnedProcessRecord|undefined,resumeSent=false;
  try{
    const helperRecord=await rememberOwnedChild(options.home,helper,'host-control',{},options.launchId);
    if(!helperRecord)throw new BridgeError('background_launch_failed','启动助手未完成原生身份登记。');
    if(expired)throw new BridgeError('bootstrap_required','独立后台启动助手超时，未提交入口执行。');
    helper.stdin.write(JSON.stringify({source:windowsBackgroundSource,tempDirectory,executable:options.executable,command:[options.executable,...options.args].map(windowsArgument).join(' '),cwd:options.cwd,environment:options.env,logfile:options.logfile,holder,completionFile,handoff:options.role==='codex-runtime'})+'\n');
    const ready=await next();
    if(!ready.error)record=await recordSpawnedProcess(options.home,{role:options.role,identity:{pid:ready.pid,parentPid:helper.pid!,name:path.basename(options.executable),image:options.executable,startedAt:ready.generation,procStartFt:ready.generation},parent:helperRecord.identity,proof:{kind:'spawn',launchId:options.launchId},windowsJob:ready.job,windowsHolder:ready.holder,completionFile,...(ready.independent?{windowsIndependent:true as const}:{}),...(options.peerId?{peerId:options.peerId}:{}),...(options.configHome?{configHome:options.configHome}:{})},recordId);
    if(!ready.independent||!record||expired)throw new BridgeError('bootstrap_required','无法核验独立后台：'+(ready.error??stderr));
    resumeSent=true;finishInput('resume');
    const ack=await next();if(!ack.resumed)throw new BridgeError('background_launch_unconfirmed','独立后台启动结果未确认，保留归属记录：'+(ack.error??stderr));
    if(await boundedExit()!==0)throw new BridgeError('background_launch_unconfirmed','启动助手退出异常或未退出，后台状态需核对：'+stderr);
    return record;
  }catch(error){
    finishInput('cancel');const helperExit=await boundedExit();
                                              
    const state=record?await (resumeSent?ownedRecordState(record):ownedProcessState(record.identity)):undefined;
    if(record&&state==='dead'){if(!resumeSent)completeOwnedContainer(record);await retireDeadOwnedProcess(record);}
    if(resumeSent||helperExit===undefined||record&&state!=='dead'||stderr.includes('child cleanup unconfirmed:'))throw new BridgeError('background_launch_unconfirmed','入口执行或回收结果未确认，保留启动证据：'+describeError(error));
    deferBackgroundRetry(options.home,describeError(error));throw new BridgeError('bootstrap_required',describeError(error));
  }finally{
    clearTimeout(timer);lines.close();
    const cleanup=()=>{try{rmdirSync(tempDirectory);}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')process.stderr.write('启动助手临时文件清理未完成：'+tempDirectory+'：'+describeError(error)+'\n');}};
    if(ended)cleanup();else{
      helper.once('close',cleanup);helper.unref();
      for(const stream of [helper.stdin,helper.stdout,helper.stderr])(stream as unknown as {unref?:()=>void}).unref?.();
    }
  }
}
