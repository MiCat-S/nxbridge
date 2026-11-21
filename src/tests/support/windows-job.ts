import {embeddedSource} from "../../shared/embedded-source.js";
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { TestContext } from 'node:test';
import { windowsPowerShell } from '../../shared/windows-tools.js';

                                              
const source=                             embeddedSource("csharp", `
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
public static class NxTestBreakaway {
  [StructLayout(LayoutKind.Sequential,CharSet=CharSet.Unicode)] struct Startup {
    public int size; public string reserved,desktop,title;
    public int x,y,w,h,xc,yc,fill,flags;public short show,n;public IntPtr bytes,input,output,error;
  }
  [StructLayout(LayoutKind.Sequential)] struct ProcessInfo {public IntPtr process,thread;public uint pid,tid;}
  [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool CreateProcessW(string app,string command,IntPtr pa,IntPtr ta,bool inherit,uint flags,IntPtr env,string cwd,ref Startup startup,out ProcessInfo info);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool IsProcessInJob(IntPtr process,IntPtr job,out bool inside);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool TerminateProcess(IntPtr process,uint exitCode);
  [DllImport("kernel32.dll",SetLastError=true)] static extern uint WaitForSingleObject(IntPtr process,uint timeout);
  [DllImport("kernel32.dll")] static extern void CloseHandle(IntPtr handle);
  [DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();
  static bool InJob(IntPtr process) {
    bool inside;if(!IsProcessInJob(process,IntPtr.Zero,out inside))throw new Win32Exception(Marshal.GetLastWin32Error());return inside;
  }
  static bool TryChild(string app,uint flags,out bool inside,out int error) {
    Startup startup=new Startup();startup.size=Marshal.SizeOf(typeof(Startup));ProcessInfo child;inside=false;error=0;
    if(!CreateProcessW(app,null,IntPtr.Zero,IntPtr.Zero,false,0x08000004|flags,IntPtr.Zero,null,ref startup,out child)){
      error=Marshal.GetLastWin32Error();return false;
    }
    try {inside=InJob(child.process);return true;}
    finally {
      try {
        if(!TerminateProcess(child.process,1))throw new Win32Exception(Marshal.GetLastWin32Error());
        if(WaitForSingleObject(child.process,5000)!=0)throw new InvalidOperationException("挂起探针未退出");
      }finally{CloseHandle(child.thread);CloseHandle(child.process);}
    }
  }
  public static bool Available(string app) {
    bool inside;int error;
    if(TryChild(app,0x01000000,out inside,out error))return !inside;
                                                                 
    int normalError;
    if(error==5&&InJob(GetCurrentProcess())&&TryChild(app,0,out inside,out normalError)&&inside)return false;
    throw new Win32Exception(error);
  }
}`);
const script=                                 embeddedSource("powershell", `
$ErrorActionPreference='Stop'
Add-Type -TypeDefinition $env:NXBRIDGE_JOB_PROBE_SOURCE
[NxTestBreakaway]::Available($env:NXBRIDGE_JOB_PROBE_NODE)
`);

export const WINDOWS_JOB_RESTRICTION='当前 Windows 调用环境的 Job 不允许完全脱离，无法验证独立后台启动成功路径';
let availability:Promise<boolean>|undefined;
export function windowsIndependentAvailable():Promise<boolean>{
  if(process.platform!=='win32')return Promise.resolve(true);
  return availability??=promisify(execFile)(windowsPowerShell(),['-NoLogo','-NoProfile','-NonInteractive','-Command',script],{windowsHide:true,timeout:20000,env:{...process.env,NXBRIDGE_JOB_PROBE_SOURCE:source,NXBRIDGE_JOB_PROBE_NODE:process.execPath}}).then(({stdout})=>{
    const answer=stdout.trim();
    if(answer==='True'||answer==='False')return answer==='True';
    throw Error('Windows Job 探针返回异常：'+answer);
  });
}

export async function requireIndependentWindows(t:TestContext):Promise<boolean>{
  if(await windowsIndependentAvailable())return true;
  t.skip(WINDOWS_JOB_RESTRICTION);return false;
}
