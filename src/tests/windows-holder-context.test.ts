import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { readFileSync,existsSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { temporaryDirectory } from './support/temporary.js';
import {ensureHome} from '../ipc/home.js';
import {delay} from '../shared/time.js';
import {isElevated} from '../process/permissions.js';
import {windowsPowerShell} from '../shared/windows-tools.js';
import { launchIndependentWindows } from '../process/windows/windows-background.js';
import { windowsHookIdentityHelper } from '../process/windows/windows-hook-identity.js';
import { ownedProcesses,releaseOwnedProcess } from '../process/owned-processes.js';
import { requireIndependentWindows } from './support/windows-job.js';

const inspectSource=String.raw`
using System;using System.ComponentModel;using System.Runtime.InteropServices;
public static class NxHolderContext {
 [DllImport("kernel32.dll",SetLastError=true)]static extern IntPtr OpenProcess(uint access,bool inherit,uint pid);
 [DllImport("advapi32.dll",SetLastError=true)]static extern bool OpenProcessToken(IntPtr process,uint access,out IntPtr token);
 [DllImport("advapi32.dll",SetLastError=true)]static extern bool GetTokenInformation(IntPtr token,int kind,IntPtr value,uint size,out uint required);
 [DllImport("advapi32.dll")]static extern IntPtr GetSidSubAuthorityCount(IntPtr sid);
 [DllImport("advapi32.dll")]static extern IntPtr GetSidSubAuthority(IntPtr sid,uint index);
 [DllImport("advapi32.dll",CharSet=CharSet.Unicode)]static extern uint GetNamedSecurityInfoW(string name,int kind,uint info,out IntPtr owner,out IntPtr group,out IntPtr dacl,out IntPtr sacl,out IntPtr descriptor);
 [DllImport("kernel32.dll")]static extern bool CloseHandle(IntPtr handle);
 [DllImport("kernel32.dll")]static extern IntPtr LocalFree(IntPtr memory);
 public static int Level(uint pid){IntPtr process=OpenProcess(0x1000,false,pid),token=IntPtr.Zero,data=IntPtr.Zero;try{if(process==IntPtr.Zero||!OpenProcessToken(process,8,out token))throw new Win32Exception(Marshal.GetLastWin32Error());uint size;GetTokenInformation(token,25,IntPtr.Zero,0,out size);data=Marshal.AllocHGlobal((int)size);if(!GetTokenInformation(token,25,data,size,out size))throw new Win32Exception(Marshal.GetLastWin32Error());IntPtr sid=Marshal.ReadIntPtr(data);return Marshal.ReadInt32(GetSidSubAuthority(sid,(uint)Marshal.ReadByte(GetSidSubAuthorityCount(sid))-1));}finally{if(data!=IntPtr.Zero)Marshal.FreeHGlobal(data);if(token!=IntPtr.Zero)CloseHandle(token);if(process!=IntPtr.Zero)CloseHandle(process);}}
 public static bool Unlabeled(string file){IntPtr owner,group,dacl,sacl,descriptor;uint error=GetNamedSecurityInfoW(file,1,16,out owner,out group,out dacl,out sacl,out descriptor);if(error!=0)throw new Win32Exception((int)error);try{return sacl==IntPtr.Zero||Marshal.ReadInt16(sacl,4)==0;}finally{LocalFree(descriptor);}}
}
`;

test('显式修复及同版本再次安装不标记 EXE',{skip:process.platform!=='win32',timeout:30000},async t=>{
  if(!await isElevated()){t.skip('需要提权核验修复前后助手未降权');return;}
  const temp=temporaryDirectory(),home=temp.directory,ready=path.join(home,'ready.json');await ensureHome(home);
  t.after(async()=>{for(const record of ownedProcesses(home).records)await releaseOwnedProcess(record);await temp.cleanup();});
  const helper=await windowsHookIdentityHelper(home);
  await ensureHome(home,true);await ensureHome(home,true);assert.equal(await windowsHookIdentityHelper(home),helper,'重复安装沿用同一版本助手');
  const inspection="$ErrorActionPreference='Stop';Add-Type -TypeDefinition $env:NXBRIDGE_CONTEXT_SOURCE;$levels=@(foreach($id in(ConvertFrom-Json $env:NXBRIDGE_CONTEXT_PIDS)){[NxHolderContext]::Level($id)});@{levels=$levels;unlabeled=[NxHolderContext]::Unlabeled($env:NXBRIDGE_CONTEXT_HELPER)}|ConvertTo-Json -Compress";
  const inspect=async(pids:number[])=>JSON.parse((await promisify(execFile)(windowsPowerShell(),['-NoLogo','-NoProfile','-NonInteractive','-Command',inspection],{windowsHide:true,env:{...process.env,NXBRIDGE_CONTEXT_SOURCE:inspectSource,NXBRIDGE_CONTEXT_PIDS:JSON.stringify(pids),NXBRIDGE_CONTEXT_HELPER:helper}})).stdout);
  assert.equal((await inspect([process.pid])).unlabeled,true);
  await t.test('独立后台与持有器保持调用者完整性',async t=>{
    if(!await requireIndependentWindows(t))return;
    const module=JSON.stringify(new URL('../process/windows/windows-background.js',import.meta.url).href),script=`import{launchIndependentWindows}from ${module};import{writeFileSync}from'node:fs';import{randomUUID}from'node:crypto';const home=${JSON.stringify(home)};let result;try{result={ok:true,records:await Promise.all([0,1].map(i=>launchIndependentWindows({home,executable:process.execPath,args:['-e','setInterval(()=>{},1000)'],cwd:home,env:process.env,logfile:home+'/run/native-'+i+'.log',role:'codex-runtime',launchId:randomUUID()})))};}catch(error){result={ok:false,error:error.stack};}writeFileSync(${JSON.stringify(ready)},JSON.stringify(result));setInterval(()=>{},1000);`;
    const broker=await launchIndependentWindows({home,executable:process.execPath,args:['--input-type=module','-e',script],cwd:home,env:process.env,logfile:path.join(home,'run','broker.log'),role:'broker',launchId:randomUUID()});
    const deadline=Date.now()+15000;while(!existsSync(ready)&&Date.now()<deadline)await delay(20);
    assert.equal(existsSync(ready),true,readFileSync(path.join(home,'run','broker.log'),'utf8'));
    const result=JSON.parse(readFileSync(ready,'utf8'));assert.equal(result.ok,true,JSON.stringify(result));
    const value=await inspect([process.pid,broker.identity.pid,...result.records.map((record:any)=>record.windowsHolder.pid)]);
    assert.ok(value.levels[0]>=12288);assert.ok(value.levels.every((level:number)=>level===value.levels[0]),JSON.stringify(value));
  });
});
