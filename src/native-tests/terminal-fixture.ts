import path from 'node:path';
import { containerCompletionFile } from '../process/owned-processes.js';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import {existsSync,mkdirSync,readFileSync} from 'node:fs';
import { randomUUID } from 'node:crypto';
import { stripVTControlCharacters } from 'node:util';
import {delay} from '../shared/time.js';
import {windowsPowerShell} from '../shared/windows-tools.js';
import { windowsArgument } from '../process/windows/windows-background.js';
import { processIdentity, type ProcessIdentity } from '../process/process.js';
import { recordOwnedProcess, rememberOwnedDescendants, releaseOwnedProcess, type OwnedProcessRecord } from '../process/owned-processes.js';
import { assignGatedWindowsJob } from '../process/windows/windows-hook-identity.js';

                                        
const source=String.raw`
using System;using System.IO;using System.Text;using System.Threading;using System.ComponentModel;using System.Runtime.InteropServices;using Microsoft.Win32.SafeHandles;
public sealed class NxTerminal:IDisposable {
 [StructLayout(LayoutKind.Sequential)] struct Coord {public short x,y;public Coord(short a,short b){x=a;y=b;}}
 [StructLayout(LayoutKind.Sequential,CharSet=CharSet.Unicode)] struct Startup {public int cb;public string reserved,desktop,title;public int x,y,w,h,xc,yc,fill,flags;public short show,n;public IntPtr bytes,input,output,error;}
 [StructLayout(LayoutKind.Sequential)] struct Extended {public Startup startup;public IntPtr attributes;}
 [StructLayout(LayoutKind.Sequential)] struct Info {public IntPtr process,thread;public uint pid,tid;}
 [StructLayout(LayoutKind.Sequential)] struct Security {public int size;public IntPtr descriptor;public bool inherit;}
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool CreatePipe(out IntPtr read,out IntPtr write,IntPtr sa,uint size);
 [DllImport("kernel32.dll")] static extern int CreatePseudoConsole(Coord size,IntPtr input,IntPtr output,uint flags,out IntPtr console);
 [DllImport("kernel32.dll")] static extern void ClosePseudoConsole(IntPtr console);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool InitializeProcThreadAttributeList(IntPtr list,int count,int flags,ref IntPtr size);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool UpdateProcThreadAttribute(IntPtr list,uint flags,IntPtr attr,IntPtr value,IntPtr size,IntPtr previous,IntPtr returned);
 [DllImport("kernel32.dll")] static extern void DeleteProcThreadAttributeList(IntPtr list);
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool CreateProcessW(string exe,StringBuilder command,IntPtr pa,IntPtr ta,bool inherit,uint flags,IntPtr env,string cwd,ref Extended startup,out Info info);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool TerminateProcess(IntPtr process,uint code);
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern IntPtr CreateFileW(string name,uint access,uint share,ref Security sa,uint creation,uint flags,IntPtr template);
 [DllImport("kernel32.dll")] static extern uint WaitForSingleObject(IntPtr handle,uint milliseconds);
 [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
 IntPtr console,process;FileStream input,output;Thread reader;
 public uint Start(string exe,string command,string cwd) {
  IntPtr ir,iw,or,ow;if(!CreatePipe(out ir,out iw,IntPtr.Zero,0))throw new Win32Exception(Marshal.GetLastWin32Error());
  if(!CreatePipe(out or,out ow,IntPtr.Zero,0)){CloseHandle(ir);CloseHandle(iw);throw new Win32Exception(Marshal.GetLastWin32Error());}
  int result=CreatePseudoConsole(new Coord(150,45),ir,ow,0,out console);CloseHandle(ir);CloseHandle(ow);
  if(result!=0){CloseHandle(iw);CloseHandle(or);Marshal.ThrowExceptionForHR(result);}
  input=new FileStream(new SafeFileHandle(iw,true),FileAccess.Write);output=new FileStream(new SafeFileHandle(or,true),FileAccess.Read);
  IntPtr size=IntPtr.Zero;InitializeProcThreadAttributeList(IntPtr.Zero,1,0,ref size);IntPtr list=Marshal.AllocHGlobal(size);
  try {
   if(!InitializeProcThreadAttributeList(list,1,0,ref size))throw new Win32Exception(Marshal.GetLastWin32Error());
   try {
    if(!UpdateProcThreadAttribute(list,0,new IntPtr(0x20016),console,new IntPtr(IntPtr.Size),IntPtr.Zero,IntPtr.Zero))throw new Win32Exception(Marshal.GetLastWin32Error());
    Extended startup=new Extended();startup.startup.cb=Marshal.SizeOf(typeof(Extended));startup.attributes=list;Info child;
    if(!CreateProcessW(exe,new StringBuilder(command),IntPtr.Zero,IntPtr.Zero,false,0x80000,IntPtr.Zero,cwd,ref startup,out child))throw new Win32Exception(Marshal.GetLastWin32Error());
    process=child.process;CloseHandle(child.thread);
    reader=new Thread(Pump);reader.IsBackground=true;reader.Start();return child.pid;
   }finally{DeleteProcThreadAttributeList(list);}
  }finally{Marshal.FreeHGlobal(list);}
 }
 void Pump(){try{Stream target=Console.OpenStandardOutput();byte[] bytes=new byte[16384];int count;while((count=output.Read(bytes,0,bytes.Length))>0){target.Write(bytes,0,count);target.Flush();}}catch(IOException){}catch(ObjectDisposedException){}}
 public static void Run(string exe,string command,string cwd,string ready) {
  Security sa=new Security();sa.size=Marshal.SizeOf(typeof(Security));sa.inherit=true;
  IntPtr input=CreateFileW("CONIN$",0xc0000000,3,ref sa,3,0,IntPtr.Zero),output=CreateFileW("CONOUT$",0xc0000000,3,ref sa,3,0,IntPtr.Zero);
  if(input==new IntPtr(-1)||output==new IntPtr(-1))throw new Win32Exception(Marshal.GetLastWin32Error());
  try {
   Extended startup=new Extended();startup.startup.cb=Marshal.SizeOf(typeof(Startup));startup.startup.flags=0x100;startup.startup.input=input;startup.startup.output=output;startup.startup.error=output;Info child;
   if(!CreateProcessW(exe,new StringBuilder(command),IntPtr.Zero,IntPtr.Zero,true,0,IntPtr.Zero,cwd,ref startup,out child))throw new Win32Exception(Marshal.GetLastWin32Error());
   CloseHandle(child.thread);try{File.WriteAllText(ready,child.pid.ToString(),new UTF8Encoding(false));WaitForSingleObject(child.process,0xffffffff);}finally{CloseHandle(child.process);}
  }finally{CloseHandle(input);CloseHandle(output);}
 }
 public void Send(string value){byte[] bytes=Convert.FromBase64String(value);input.Write(bytes,0,bytes.Length);input.Flush();}
 public void Dispose(){if(process!=IntPtr.Zero){TerminateProcess(process,0);CloseHandle(process);process=IntPtr.Zero;}if(input!=null)input.Dispose();if(console!=IntPtr.Zero){ClosePseudoConsole(console);console=IntPtr.Zero;}if(output!=null)output.Dispose();}
}`;
const controller=String.raw`
$ErrorActionPreference='Stop'
if([Console]::ReadLine() -ne 'start'){exit 1}
[Console]::InputEncoding=[Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)
$files=[CodeDom.Compiler.TempFileCollection]::new($env:NXBRIDGE_TERMINAL_COMPILER,$false)
$compiler=[CodeDom.Compiler.CompilerParameters]::new();$compiler.GenerateInMemory=$true;$compiler.TempFiles=$files;$null=$compiler.ReferencedAssemblies.Add('System.dll')
$terminal=$null
try {
 Add-Type -TypeDefinition $env:NXBRIDGE_TERMINAL_SOURCE -CompilerParameters $compiler
 $terminal=[NxTerminal]::new();$nativePid=$terminal.Start($env:NXBRIDGE_TERMINAL_EXE,$env:NXBRIDGE_TERMINAL_COMMAND,$env:NXBRIDGE_TERMINAL_CWD)
 [IO.File]::WriteAllText($env:NXBRIDGE_TERMINAL_READY,[string]$nativePid,[Text.UTF8Encoding]::new($false))
 while($null -ne ($line=[Console]::ReadLine())){if($line -eq 'stop'){break};$terminal.Send($line)}
} catch {[Console]::Error.WriteLine($_.Exception.ToString());exit 1}
finally{if($terminal){$terminal.Dispose()};$files.Delete()}
`;
const nativeController=String.raw`
$ErrorActionPreference='Stop'
$files=[CodeDom.Compiler.TempFileCollection]::new($env:NXBRIDGE_TERMINAL_COMPILER,$false)
$compiler=[CodeDom.Compiler.CompilerParameters]::new();$compiler.GenerateInMemory=$true;$compiler.TempFiles=$files;$null=$compiler.ReferencedAssemblies.Add('System.dll')
try{Add-Type -TypeDefinition $env:NXBRIDGE_TERMINAL_SOURCE -CompilerParameters $compiler;[NxTerminal]::Run($env:NXBRIDGE_TERMINAL_NATIVE_EXE,$env:NXBRIDGE_TERMINAL_NATIVE_COMMAND,$env:NXBRIDGE_TERMINAL_CWD,$env:NXBRIDGE_TERMINAL_NATIVE_READY)}finally{$files.Delete()}
`;

export class NativeTerminal {
  output='';
  errors='';
  identity!:ProcessIdentity;
  private exited:Promise<void>;
  private launch?:{home:string;wrapper:ProcessIdentity;id:string;record:OwnedProcessRecord};
  private constructor(private child:ChildProcessWithoutNullStreams,private host:'codex'|'claude'){
    child.stdout.setEncoding('utf8');child.stderr.setEncoding('utf8');
    child.stdout.on('data',(value:string)=>{
      this.output=(this.output+value).slice(-400000);
      if(value.includes('\x1b[6n'))this.send('\x1b[1;1R');
      if(value.includes('\x1b[c'))this.send('\x1b[?1;2c');
    });
    child.stderr.on('data',(value:string)=>this.errors=(this.errors+value).slice(-12000));
    this.exited=new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',()=>resolve());});
    void this.exited.catch(()=>{});
  }
  static async start(root:string,home:string,exe:string,args:string[],cwd:string,env:NodeJS.ProcessEnv):Promise<NativeTerminal>{
    const host=path.basename(exe).toLowerCase().includes('claude')?'claude':'codex';
                                                  
    const terminalArgs=host==='claude'&&!args.includes('--permission-mode')?[...args,'--permission-mode','default']:args;
    const directory=path.join(root,'terminal-'+randomUUID()),compiler=path.join(directory,'compiler'),ready=path.join(directory,'ready');mkdirSync(compiler,{recursive:true});
                                                         
    const launcher=windowsPowerShell(),nativeReady=path.join(directory,'native-ready'),nativeCommand=[exe,...terminalArgs].map(windowsArgument).join(' '),startedAt=Date.now();
    const phases:{stage:string;at:number;elapsedMs:number;remainingMs:number}[]=[],mark=(stage:string)=>{const at=Date.now();phases.push({stage,at,elapsedMs:at-startedAt,remainingMs:Math.max(0,15000-(at-startedAt))});};
    mark('controller-spawn-requested');
    const child=spawn(launcher,['-NoLogo','-NoProfile','-NonInteractive','-Command',controller],{cwd,env:{...env,NXBRIDGE_TERMINAL_SOURCE:source,NXBRIDGE_TERMINAL_COMPILER:compiler,NXBRIDGE_TERMINAL_EXE:launcher,NXBRIDGE_TERMINAL_COMMAND:[launcher,'-NoLogo','-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(nativeController,'utf16le').toString('base64')].map(windowsArgument).join(' '),NXBRIDGE_TERMINAL_NATIVE_EXE:exe,NXBRIDGE_TERMINAL_NATIVE_COMMAND:nativeCommand,NXBRIDGE_TERMINAL_NATIVE_READY:nativeReady,NXBRIDGE_TERMINAL_CWD:cwd,NXBRIDGE_TERMINAL_READY:ready},stdio:['pipe','pipe','pipe'],windowsHide:true});
    const terminal=new NativeTerminal(child,host);
    child.once('spawn',()=>mark('controller-spawned'));
    try{
      const owner=await processIdentity(child.pid!),launchId=randomUUID(),job=await assignGatedWindowsJob(owner,containerCompletionFile(home));
      const record=await recordOwnedProcess(home,{role:'host-control',identity:owner,parent:await processIdentity(process.pid),windowsJob:job.name,windowsHolder:job.holder,completionFile:job.completionFile,proof:{kind:'spawn',launchId}});
      terminal.launch={home,wrapper:owner,id:launchId,record};child.stdin.write('start\n');
      const end=Date.now()+15000;
      while(!existsSync(ready)){if(child.exitCode!==null||Date.now()>end)throw Error('伪终端启动失败：'+terminal.errors);await delay(30);}
      mark('controller-ready');
      while(!existsSync(nativeReady)){if(child.exitCode!==null||Date.now()>end)throw Error('原生终端宿主未启动');await delay(30);}
      mark('native-ready');mark('native-query-started');
      terminal.identity=await processIdentity(Number(readFileSync(nativeReady,'utf8')));
      mark('native-query-completed');
      await rememberOwnedDescendants(home,owner,launchId);
      return terminal;
    }catch(error){
      mark('startup-failed');let cleanupError:unknown;try{await terminal.close();}catch(failure){cleanupError=String(failure);}
                                        
      throw new Error(String(error)+'\n'+JSON.stringify({terminalStartup:phases,...(cleanupError?{cleanupError}:{})})+'\n'+terminal.errors+'\n'+terminal.output,{cause:error});
    }
  }
  send(value:string):void{if(!this.child.stdin.destroyed)this.child.stdin.write(Buffer.from(value,'utf8').toString('base64')+'\n');}
  async wait(check:()=>boolean|Promise<boolean>,reason:string,timeout=20000):Promise<void>{
    const end=Date.now()+timeout;
    while(!await check()){if(this.child.exitCode!==null||Date.now()>end)throw Error(reason+'\n'+this.errors+'\n'+stripVTControlCharacters(this.output).split(/\r?\n/).filter(v=>v.trim()).join('\n').slice(-4500));await delay(50);}
  }
  async prompt(value:string):Promise<void>{
                                                   
    const offset=this.output.length;this.send(value);
    if(this.host==='claude'&&value)await this.wait(()=>stripVTControlCharacters(this.output.slice(offset)).replace(/\s+/gu,'').includes(value.replace(/\s+/gu,'')),'原生输入未回显',15000);
    await delay(this.host==='claude'?600:150);
                                                   
    this.send((this.host==='codex'&&value?'\x1b[F':'')+'\r');
  }
  async close():Promise<void>{
    if(this.child.exitCode!==null){if(this.launch)await releaseOwnedProcess(this.launch.record);return;}
    try{
                                               
      if(this.launch)await rememberOwnedDescendants(this.launch.home,this.launch.wrapper,this.launch.id);
    }catch(error){if((error as {code?:string}).code!=='process_missing')throw error;}
    finally{this.child.stdin.end('stop\n');await this.exited;if(this.launch)await releaseOwnedProcess(this.launch.record);}
  }
}
