import {embeddedSource} from "../shared/embedded-source.js";
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, rmSync, symlinkSync, writeFileSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {isElevated,privateDirectory} from '../process/permissions.js';
import {ownedSocketDirectory} from '../shared/local-paths.js';
import {windowsTool,windowsPowerShell} from '../shared/windows-tools.js';
import {PACKAGE_ROOT} from '../shared/package-location.js';
import { processIdentity } from '../process/process.js';
import { processRegistryDirectory } from '../process/owned-processes.js';
import { preparePlugins } from '../install/setup.js';
import { registerTestDirectory } from '../process/test-processes.js';
import { temporary } from './support/temporary.js';

test('Windows 系统工具使用绝对路径，遵循系统目录优先级并保留空格', t => {
  const previous = { SystemRoot: process.env.SystemRoot, windir: process.env.windir };
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  const cases = [
    { SystemRoot: 'D:\\Windows 系统', windir: 'E:\\Windows', root: 'D:\\Windows 系统' },
    { SystemRoot: undefined, windir: 'E:\\Windows', root: 'E:\\Windows' },
    { SystemRoot: '', windir: 'E:\\Windows', root: 'E:\\Windows' },
    { SystemRoot: undefined, windir: undefined, root: 'C:\\Windows' },
  ];
  for (const entry of cases) {
    for (const key of ['SystemRoot', 'windir'] as const) {
      if (entry[key] === undefined) delete process.env[key];
      else process.env[key] = entry[key];
    }
    for (const name of ['whoami.exe', 'icacls.exe', 'taskkill.exe']) {
      assert.equal(windowsTool(name), `${entry.root}\\System32\\${name}`);
    }
    assert.equal(windowsPowerShell(), `${entry.root}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`);
  }
});

test('Windows 权限初始化暂时失败后重试，既不缓存失败也不跳过未完成保护', {skip:process.platform!=='win32'}, async t=>{
  const directory=path.join(temporary(t),'private'),systemRoot=process.env.SystemRoot;
  try{
    process.env.SystemRoot=path.join(directory,'不存在的系统目录');
    await assert.rejects(privateDirectory(directory));
  }finally{if(systemRoot===undefined)delete process.env.SystemRoot;else process.env.SystemRoot=systemRoot;}
  await privateDirectory(directory);
  const {stdout}=await promisify(execFile)(windowsPowerShell(),['-NoLogo','-NoProfile','-NonInteractive','-Command','[IO.DirectoryInfo]::new($env:NXBRIDGE_TEST_DIRECTORY).GetAccessControl().AreAccessRulesProtected'],{windowsHide:true,env:{...process.env,NXBRIDGE_TEST_DIRECTORY:directory}});
  assert.equal(stdout.trim(),'True');
});

test('Windows 目录权限和进程查询不执行 PATH 中的同名程序', { skip: process.platform !== 'win32' }, async t => {
  const directory = temporary(t), previousPath = process.env.PATH;
  t.after(() => {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
  });
                                   
  for (const name of ['whoami.exe', 'icacls.exe', 'powershell.exe']) {
    writeFileSync(path.join(directory, name), 'nxbridge PATH 冲突回归测试', 'utf8');
  }
  process.env.PATH = directory;
  await privateDirectory(path.join(directory, 'private'));
  await privateDirectory(path.join(directory, 'private'));
  const identity = await processIdentity(process.pid);
  assert.equal(identity.pid, process.pid);
  assert.ok(identity.startedAt);
});

test('Windows 显式安装修复旧 H 子文件、长路径 socket 和本安装归属目录，保留子文件 DACL 与链接目标', {skip:process.platform!=='win32'},async t=>{
  if(!await isElevated()){t.skip('需要提权构造旧版高完整性标签');return;}
  const previous=process.env.NXBRIDGE_PROCESS_REGISTRY;
  t.after(()=>{if(previous===undefined)delete process.env.NXBRIDGE_PROCESS_REGISTRY;else process.env.NXBRIDGE_PROCESS_REGISTRY=previous;});
  const root=temporary(t),home=path.join(root,'long-private-home-'+'x'.repeat(35)),registry=path.join(root,'processes'),socket=ownedSocketDirectory(home);
  assert.notEqual(socket,path.join(home,'run'));
  registerTestDirectory(socket);t.after(()=>{if(existsSync(socket))rmSync(socket,{recursive:true});});
  process.env.NXBRIDGE_PROCESS_REGISTRY=registry;
  const own=processRegistryDirectory(home),other=processRegistryDirectory(path.join(root,'other-home')),external=path.join(root,'linked-user-data');
  const files=[path.join(home,'state.db'),path.join(home,'run','token'),path.join(own,'old-record.json'),path.join(socket,'old-socket.txt'),path.join(other,'other-record.json'),path.join(external,'keep.txt')];
  for(const file of files){mkdirSync(path.dirname(file),{recursive:true});writeFileSync(file,'隔离的旧版文件','utf8');}
  symlinkSync(external,path.join(home,'user-link'),'junction');
                                                         
  const labelSource=String.raw`using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
public static class NxbridgeTestLabel {
  [DllImport("advapi32.dll",CharSet=CharSet.Unicode,EntryPoint="GetNamedSecurityInfoW")]
  static extern uint GetNamedSecurityInfo(string name,int type,uint info,out IntPtr owner,out IntPtr group,out IntPtr dacl,out IntPtr sacl,out IntPtr descriptor);
  [DllImport("advapi32.dll",CharSet=CharSet.Unicode,SetLastError=true,EntryPoint="ConvertSecurityDescriptorToStringSecurityDescriptorW")]
  static extern bool ConvertDescriptor(IntPtr descriptor,uint revision,uint info,out IntPtr text,out uint size);
  [DllImport("kernel32.dll")] static extern IntPtr LocalFree(IntPtr value);
  public static string Read(string file) {
    IntPtr owner,group,dacl,sacl,descriptor,text=IntPtr.Zero; uint size;
    uint error=GetNamedSecurityInfo(file,1,16,out owner,out group,out dacl,out sacl,out descriptor);
    if(error!=0)throw new Win32Exception((int)error);
    try {if(!ConvertDescriptor(descriptor,1,16,out text,out size))throw new Win32Exception(Marshal.GetLastWin32Error());return Marshal.PtrToStringUni(text);}
    finally {if(text!=IntPtr.Zero)LocalFree(text);LocalFree(descriptor);}
  }
}`;
  const execute=promisify(execFile),env={...process.env,NXBRIDGE_TEST_ACL_FILES:JSON.stringify(files),NXBRIDGE_TEST_LABEL_SOURCE:labelSource};
  const protect=                                 embeddedSource("powershell", `$ErrorActionPreference='Stop'; foreach($file in (ConvertFrom-Json $env:NXBRIDGE_TEST_ACL_FILES)){$info=[IO.FileInfo]::new($file);$acl=$info.GetAccessControl();$acl.SetAccessRuleProtection($true,$true);$info.SetAccessControl($acl)}`);
  await execute(windowsPowerShell(),['-NoLogo','-NoProfile','-NonInteractive','-Command',protect],{windowsHide:true,env});
  for(const directory of [home,registry,socket,external])await execute(windowsTool('icacls.exe'),[directory,'/setintegritylevel','(OI)(CI)H','/T','/L'],{windowsHide:true});
  const inspect=                                 embeddedSource("powershell", `[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false);$ErrorActionPreference='Stop';Add-Type -TypeDefinition $env:NXBRIDGE_TEST_LABEL_SOURCE;$result=@(foreach($file in (ConvertFrom-Json $env:NXBRIDGE_TEST_ACL_FILES)){$label=[NxbridgeTestLabel]::Read($file);[pscustomobject]@{high=$label.Contains(';;;HI)');medium=$label.Contains(';;;ME)');dacl=[IO.FileInfo]::new($file).GetAccessControl().GetSecurityDescriptorSddlForm([Security.AccessControl.AccessControlSections]::Access)}});ConvertTo-Json -InputObject $result -Compress`);
  const read=async()=>JSON.parse((await execute(windowsPowerShell(),['-NoLogo','-NoProfile','-NonInteractive','-Command',inspect],{windowsHide:true,env})).stdout) as {high:boolean;medium:boolean;dacl:string}[];
  const before=await read();assert.ok(before.every(value=>value.high),'夹具必须确实带有旧 H 标签');
  await preparePlugins(home);
  const after=await read();
  assert.ok(after.slice(0,4).every(value=>value.medium&&!value.high),'自有 home/run/socket/本安装归属文件均应完成修复');
  assert.deepEqual(after.map(value=>value.dacl),before.map(value=>value.dacl));
  assert.deepEqual(after.slice(4),before.slice(4),'其他安装的归属文件及链接指向的用户文件不得改变');
  const worker=path.join(root,'medium-write.mjs'),fixture=path.join(root,'medium-write.json');
  writeFileSync(worker,"import{readFileSync,appendFileSync}from'node:fs';for(const file of JSON.parse(readFileSync(process.argv[2],'utf8')))appendFileSync(file,'普通终端写入成功','utf8');",'utf8');writeFileSync(fixture,JSON.stringify(files.slice(0,4)),'utf8');
  await execute(windowsPowerShell(),['-NoLogo','-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',path.join(PACKAGE_ROOT,'tools/test-normal-user.ps1'),'-Node',process.execPath,'-Worker',worker,'-Fixture',fixture],{cwd:root,windowsHide:true,timeout:15000});
  for(const file of files.slice(0,4))assert.match(readFileSync(file,'utf8'),/普通终端写入成功$/);
});
