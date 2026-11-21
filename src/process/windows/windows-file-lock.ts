import {embeddedSource} from "../../shared/embedded-source.js";
import { execFileSync } from 'node:child_process';
import path from 'node:path';

const windowsFileLockSource=                             embeddedSource("csharp", `using System;
using System.Runtime.InteropServices;
public static class NxFileOwners {
  [StructLayout(LayoutKind.Sequential)] public struct UniqueProcess { public uint pid; public System.Runtime.InteropServices.ComTypes.FILETIME started; }
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] public struct ProcessInfo {
    public UniqueProcess process;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst=256)] public string name;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst=64)] public string service;
    public uint type, status, session;
    [MarshalAs(UnmanagedType.Bool)] public bool restartable;
  }
  [DllImport("rstrtmgr.dll", CharSet=CharSet.Unicode)] public static extern int RmStartSession(out uint handle, int flags, System.Text.StringBuilder key);
  [DllImport("rstrtmgr.dll", CharSet=CharSet.Unicode)] public static extern int RmRegisterResources(uint handle, uint count, string[] files, uint apps, IntPtr processes, uint services, IntPtr names);
  [DllImport("rstrtmgr.dll")] public static extern int RmGetList(uint handle, out uint needed, ref uint count, [In,Out] ProcessInfo[] info, ref uint reasons);
  [DllImport("rstrtmgr.dll")] public static extern int RmEndSession(uint handle);
}`);

                                              
export function windowsFileLockOwners(filename:string):string{
  const script=                                 embeddedSource("powershell", `
Add-Type -TypeDefinition '${windowsFileLockSource.replaceAll("'","''")}'
$handle=[uint32]0
if([NxFileOwners]::RmStartSession([ref]$handle,0,[Text.StringBuilder]::new(33)) -ne 0){exit 1}
try {
  if([NxFileOwners]::RmRegisterResources($handle,1,[string[]]@($env:NXBRIDGE_LOCK_FILE),0,[IntPtr]::Zero,0,[IntPtr]::Zero) -ne 0){exit 1}
  $needed=[uint32]0;$count=[uint32]0;$reasons=[uint32]0
  $result=[NxFileOwners]::RmGetList($handle,[ref]$needed,[ref]$count,$null,[ref]$reasons)
  if($result -eq 0){'[]';exit 0}
  if($result -ne 234){exit 1}
  $count=$needed;$rows=New-Object 'NxFileOwners+ProcessInfo[]' $count
  if([NxFileOwners]::RmGetList($handle,[ref]$needed,[ref]$count,$rows,[ref]$reasons) -ne 0){exit 1}
  $output=@();for($index=0;$index -lt $count;$index++){$output+=@{pid=$rows[$index].process.pid;name=$rows[$index].name}}
  ConvertTo-Json -InputObject @($output) -Compress
} finally { [void][NxFileOwners]::RmEndSession($handle) }
`);
  try{
    const executable=path.win32.join(process.env.SystemRoot??process.env.windir??'C:\\Windows','System32','WindowsPowerShell','v1.0','powershell.exe');
    const rows:unknown=JSON.parse(execFileSync(executable,['-NoLogo','-NoProfile','-NonInteractive','-Command',script],{env:{...process.env,NXBRIDGE_LOCK_FILE:filename},windowsHide:true,timeout:3000,maxBuffer:32*1024,encoding:'utf8',stdio:['ignore','pipe','pipe']}));
    if(Array.isArray(rows)){
      const owners=rows.filter(row=>Number.isSafeInteger(row?.pid)&&row.pid>0&&typeof row.name==='string').map(row=>`PID ${row.pid} ${row.name.replace(/[\r\n]/g,' ')}`);
      if(owners.length)return 'Restart Manager 当前占用快照：'+owners.join('、')+'。';
    }
  }catch{                                }
  return '未能确认当前占用进程。';
}
