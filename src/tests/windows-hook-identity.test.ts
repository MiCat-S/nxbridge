import { copyNodeBinary } from './support/node-binary.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { renameSync, unlinkSync, mkdirSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { randomUUID } from 'node:crypto';
import { spawn,execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { once } from 'node:events';
import path from 'node:path';
import { temporaryDirectory } from './support/temporary.js';
import { registration } from './support/registration.js';
import { processIdentity, windowsArguments, codexArguments } from '../process/process.js';
import { readWindowsHookIdentity, readWindowsJobMembers, windowsHelperStatus, withWindowsIdentityHome, watchWindowsJobNative } from '../process/windows/windows-hook-identity.js';
import { launchIndependentWindows } from '../process/windows/windows-background.js';
import { requireIndependentWindows } from './support/windows-job.js';
import { releaseOwnedProcess, ownedRecordState, completeOwnedContainer, rememberOwnedDescendants, declareOwnedNative, ownedProcesses } from '../process/owned-processes.js';
import { ownedProcessState, stopOwnedProcess } from '../process/process-stop.js';
import { relaunchHostImage } from '../hosts/host-image.js';
import { captureUserLaunch } from '../hosts/launch-profiles.js';
import { Store } from '../storage/store.js';
import {sameDirectory} from '../shared/files.js';
import {delay} from '../shared/time.js';
import {windowsPowerShell} from '../shared/windows-tools.js';
import { WindowsIdentitySession } from '../process/windows/windows-identity-session.js';

test('预检原生助手目录仅作用于当前异步调用，并行上下文与退出后的默认值保持独立',async t=>{
  const temp=temporaryDirectory(),original=windowsHelperStatus().binary;t.after(temp.cleanup);
  await Promise.all(['a','b'].map(name=>withWindowsIdentityHome(path.join(temp.directory,name),async()=>{
    const binary=windowsHelperStatus().binary;assert.ok(binary.startsWith(path.join(temp.directory,name)+path.sep));
    await new Promise<void>(resolve=>setImmediate(resolve));assert.equal(windowsHelperStatus().binary,binary);
  })));
  assert.equal(windowsHelperStatus().binary,original);
});

test('Windows 常驻助手并发查询使用新句柄，崩溃后重建且退出不沿用旧身份',{skip:process.platform!=='win32',timeout:30000},async t=>{
  const temp=temporaryDirectory(),binary=path.join(temp.directory,'codex.exe'),home=path.join(temp.directory,'bridge');copyNodeBinary(binary);
  const native=spawn(binary,['-e',"process.send('ready');setInterval(()=>{},1000)"],{windowsHide:true,stdio:['ignore','ignore','ignore','ipc']}),ended=once(native,'exit'),session=new WindowsIdentitySession(home);
  t.after(async()=>{session.close();if(native.exitCode===null&&native.signalCode===null)native.kill();await ended;await temp.cleanup();});await once(native,'message');
  await session.prepare(10000);const prepared=(session as any).child;
  const expected=await processIdentity(native.pid!),first=await session.read(native.pid!,10000);
  assert.equal((session as any).child,prepared,'预热后应复用查询进程，每次查询仍持有新句柄');
  for(const value of await Promise.all([session.read(native.pid!),session.read(native.pid!)]))assert.equal(value.procStart,first.procStart);
  assert.equal(first.procStart,expected.startedAt);
  const helper=(session as any).child,helperEnded=once(helper,'exit');helper.kill();await helperEnded;
  assert.equal((await session.read(native.pid!)).procStart,first.procStart);assert.notEqual((session as any).child.pid,helper.pid);
  native.kill();await ended;await assert.rejects(session.read(native.pid!),{code:'process_identity_unknown'});
  session.close();await assert.rejects(session.read(process.pid),{code:'hook_identity_unavailable'});await assert.rejects(session.prepare(),{code:'hook_identity_unavailable'});
});

test('hook 等待共用助手启动时保留自己的截止预算，不取消后台启动',async t=>{
  const session=new WindowsIdentitySession('unused');let opened!:(child:any)=>void,writes=0;
  const opening=new Promise<any>(resolve=>opened=resolve);t.mock.method(session as any,'open',()=>opening);
  const began=performance.now(),request=session.read(process.pid,30);
  await assert.rejects(request,{code:'process_identity_unknown'});
  assert.ok(performance.now()-began<1000,'短请求不能等待预热的完整编译预算');
  opened({stdin:{write:()=>writes++}});await opening;await delay(0);
  assert.equal(writes,0,'预算到期后不能向后来启动的助手提交查询');session.close();
});

test('正式重启路径只规范化精确更新后缀，不扩大宿主命名规则',()=>{
  for(const host of ['claude','codex'] as const){
    assert.equal(relaunchHostImage('C:\\bin\\'+host.toUpperCase()+'.EXE.old.123',host,'win32'),'C:\\bin\\'+host+'.exe');
    for(const suffix of ['','.old.','.old.1x','.old.-1','.old.1.exe','.backup.123']){const value='C:\\bin\\'+host+'.exe'+suffix;assert.equal(relaunchHostImage(value,host,'win32'),value);}
    assert.equal(relaunchHostImage('/opt/'+host+'.exe.old.123',host,'linux'),'/opt/'+host+'.exe.old.123');
  }
});

test('Windows 常驻助手短请求超时不取消并发请求，悬挂后下一次可重建',{skip:process.platform!=='win32',timeout:15000},async t=>{
  const temp=temporaryDirectory(),children:ReturnType<typeof spawn>[]=[],script=`require('node:readline').createInterface({input:process.stdin}).on('line',line=>{const[id,,pid]=line.split(' ');if(pid==='3')return;setTimeout(()=>console.log(JSON.stringify({id:+id,result:{pid:+pid,parentPid:0,image:'codex.exe',launchImage:'codex.exe',procStart:'1',procStartTicks:'1',commandLine:'codex'}})),pid==='1'?120:200);});`;
  const session=new WindowsIdentitySession(path.join(temp.directory,'bridge'),()=>{const child=spawn(process.execPath,['-e',script],{windowsHide:true,stdio:['pipe','pipe','pipe']});children.push(child);return child;});
  t.after(async()=>{session.close();await Promise.all(children.map(child=>child.exitCode===null&&child.signalCode===null?once(child,'close'):Promise.resolve()));await temp.cleanup();});
  await session.read(4,10000);const timed=session.read(1,50),other=session.read(2,1000);await assert.rejects(timed,{code:'process_identity_unknown'});assert.equal((await other).pid,2);assert.equal(children.length,1);
  await assert.rejects(session.read(3,50),{code:'process_identity_unknown'});assert.equal((await session.read(4,1000)).pid,4);assert.equal(children.length,2);
});

for(const host of ['codex','claude'] as const)test('Windows '+host+' 更新改名后原进程继续核验，启动捕获不保存旧映像',{skip:process.platform!=='win32',timeout:30000},async t=>{
  const temp=temporaryDirectory(),home=path.join(temp.directory,'bridge'),binary=path.join(temp.directory,host+'.exe'),old=binary+'.old.1793751136207';copyNodeBinary(binary);
  const child=spawn(binary,['-e',"process.send('ready');setInterval(()=>{},1000)"],{argv0:host,windowsHide:true,stdio:['ignore','ignore','ignore','ipc']}),exit=once(child,'exit');
  t.after(async()=>{if(child.exitCode===null&&child.signalCode===null)child.kill();await exit;await temp.cleanup();});await once(child,'message');
  const expected=await processIdentity(child.pid!);renameSync(binary,old);copyNodeBinary(binary);
  const found=await readWindowsHookIdentity(child.pid!,home,host);
  assert.equal(found.pid,child.pid);assert.equal(found.procStart,expected.startedAt);assert.equal(found.image,old);assert.ok(sameDirectory(found.launchImage,binary));
  const row=await processIdentity(child.pid!);
  assert.ok(row);assert.equal(row.name,host+'.exe');assert.equal(row.image,old);assert.ok(sameDirectory(row.launchImage!,binary));
  const store=new Store(':memory:');t.after(()=>store.close());const peer=store.register(registration(host,'renamed',{cwd:temp.directory}));
  const captured=await captureUserLaunch(home,{host,sessionId:'renamed',nativePid:found.pid,nativeGeneration:found.procStart,sourcePid:found.pid,sourceGeneration:found.procStart,env:{}},peer,found.pid,{ancestors:async()=>[row],version:async()=> 'native-update'});
  assert.ok(captured.profile&&sameDirectory(captured.profile.exe,binary));assert.equal(child.exitCode,null);
  unlinkSync(binary);try{
    const live=await readWindowsHookIdentity(child.pid!,home,host);
    assert.equal(live.pid,child.pid);assert.equal(live.procStart,expected.startedAt);assert.equal(live.image,old);
    const missing=await processIdentity(child.pid!);
    assert.ok(missing);assert.equal(missing.startedAt,expected.startedAt);
    await assert.rejects(captureUserLaunch(home,{host,sessionId:'renamed',nativePid:live.pid,nativeGeneration:live.procStart,sourcePid:live.pid,sourceGeneration:live.procStart,env:{},force:true},peer,live.pid,{ancestors:async()=>[missing],version:async()=> 'native-update'}),{code:'launch_image_missing'});
    assert.equal(child.exitCode,null);
  }finally{copyNodeBinary(binary);}
});

for(const host of ['codex','claude'] as const)test('Windows 原生 '+host+' 助手以同一句柄读取完整代次和含中文引号的启动参数',{skip:process.platform!=='win32',timeout:30000},async t=>{
  const temp=temporaryDirectory(),binary=path.join(temp.directory,host+'.exe'),home=path.join(temp.directory,'bridge');copyNodeBinary(binary);
  const argument='本地身份 Ω "带引号"',child=spawn(binary,['-e',"process.send('ready');setInterval(()=>{},1000)",argument],{windowsHide:true,stdio:['ignore','ignore','ignore','ipc']}),exit=once(child,'exit');
  t.after(async()=>{if(child.exitCode===null&&child.signalCode===null)child.kill();await exit;await temp.cleanup();});await once(child,'message');
  const expected=await processIdentity(child.pid!),began=performance.now(),first=await readWindowsHookIdentity(child.pid!,home,host),coldMs=performance.now()-began,warm=performance.now();
  const again=await Promise.all([readWindowsHookIdentity(child.pid!,home,host),readWindowsHookIdentity(child.pid!,home,host)]);
  for(const found of [first,...again]){assert.equal(found.pid,child.pid);assert.equal(found.procStart,expected.startedAt);assert.equal(found.procStartTicks,expected.procStart);assert.ok(windowsArguments(found.commandLine).includes(argument));}
  await assert.rejects(readWindowsHookIdentity(0,home,host),(error:any)=>error.code==='process_identity_unknown'&&/退出码 1/.test(error.message));
  t.diagnostic(JSON.stringify({coldMs,warmParallelMs:performance.now()-warm,backend:'native handles/FILETIME; no PowerShell/CIM query'}));
});

test('Windows 持久 Job 只列出本次成员，根退出后仍回收后代且不影响旁边进程',{skip:process.platform!=='win32',timeout:30000},async t=>{
  if(!await requireIndependentWindows(t))return;
  const temp=temporaryDirectory(),home=path.join(temp.directory,'bridge'),ready=path.join(temp.directory,'ready.json');mkdirSync(path.join(home,'run'),{recursive:true});
  const source="const{spawn}=require('node:child_process');const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore',windowsHide:true,detached:true});child.once('spawn',()=>require('node:fs').writeFileSync(process.argv[1],JSON.stringify({pid:child.pid})));setInterval(()=>{},1000);";
  const root=await launchIndependentWindows({home,executable:process.execPath,args:['-e',source,ready],cwd:home,env:{...process.env},logfile:path.join(home,'run','root.log'),role:'codex-runtime',launchId:randomUUID()});
  const unrelated=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{windowsHide:true,stdio:'ignore'}),otherClosed=once(unrelated,'close');
  t.after(async()=>{try{await releaseOwnedProcess(root);}finally{if(unrelated.exitCode===null&&unrelated.signalCode===null)unrelated.kill();await otherClosed;await temp.cleanup();}});
  for(let i=0;!existsSync(ready)&&i<100;i++)await delay(20);
  const pid=JSON.parse(readFileSync(ready,'utf8')).pid,identity=await processIdentity(pid),members=await readWindowsJobMembers(root.windowsJob!,root.identity);
  assert.ok(members.some(value=>value.pid===pid));assert.ok(members.some(value=>value.pid===root.identity.pid));assert.ok(!members.some(value=>value.pid===unrelated.pid));
  await assert.rejects(readWindowsJobMembers(root.windowsJob!,{...root.identity,startedAt:(BigInt(root.identity.startedAt)+1n).toString()}),/job root generation changed/);
  await stopOwnedProcess(root.identity);assert.equal(await ownedProcessState(identity),'alive','根退出不能丢失持久容器中的后代');
  assert.ok((await readWindowsJobMembers(root.windowsJob!,root.identity)).some(value=>value.pid===pid));
  await releaseOwnedProcess(root);assert.equal(await ownedProcessState(identity),'dead');assert.equal(unrelated.exitCode,null);
});

test('Windows 持有进程异常退出后仅回收登记代次，不将缺失的结束凭据当作 Job 已空',{skip:process.platform!=='win32',timeout:30000},async t=>{
  if(!await requireIndependentWindows(t))return;
  const temp=temporaryDirectory(),home=path.join(temp.directory,'bridge');mkdirSync(path.join(home,'run'),{recursive:true});
  const root=await launchIndependentWindows({home,executable:process.execPath,args:['-e','setInterval(()=>{},1000)'],cwd:home,env:process.env,logfile:path.join(home,'run','root.log'),role:'codex-runtime',launchId:randomUUID()});
                                               
  t.after(async()=>{await stopOwnedProcess(root.identity);assert.equal(await ownedProcessState(root.identity),'dead');completeOwnedContainer(root);await releaseOwnedProcess(root);await temp.cleanup();});
  assert.ok(root.windowsHolder);await stopOwnedProcess(root.windowsHolder);
  assert.equal(await ownedRecordState(root),'unknown');assert.equal(await ownedProcessState(root.identity),'alive');
  await assert.rejects(rememberOwnedDescendants(home,root.identity,root.proof.launchId!),/job_holder_missing/);
  await assert.rejects(releaseOwnedProcess(root),{code:'process_identity_unknown'});assert.equal(await ownedProcessState(root.identity),'dead');assert.equal(await ownedRecordState(root),'unknown');
  completeOwnedContainer(root);await rememberOwnedDescendants(home,root.identity,root.proof.launchId!);
                                            
  const original=fs.existsSync;let observations=0;
  t.mock.method(fs,'existsSync',(file:fs.PathLike)=>file===root.completionFile?++observations>1&&original(file):original(file));syncBuiltinESMExports();
  try{
    await rememberOwnedDescendants(home,root.identity,root.proof.launchId!);assert.equal(observations,2);
    observations=0;assert.equal(await ownedRecordState(root),'dead');assert.equal(observations,2);
  }finally{t.mock.restoreAll();syncBuiltinESMExports();}
});

test('Windows 包装器提前退出后交接真实宿主句柄，宿主退出会回收 Job 后代和持有进程',{skip:process.platform!=='win32',timeout:30000},async t=>{
  if(!await requireIndependentWindows(t))return;
  const temp=temporaryDirectory(),home=path.join(temp.directory,'bridge'),ready=path.join(temp.directory,'native.json'),stop=path.join(temp.directory,'native-exit');mkdirSync(path.join(home,'run'),{recursive:true});
  const native="const{spawn}=require('node:child_process'),fs=require('node:fs');const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore',windowsHide:true,detached:true});fs.writeFileSync(process.argv[1],JSON.stringify({native:process.pid,child:child.pid}));setInterval(()=>{if(fs.existsSync(process.argv[2]))process.exit(0);},25);";
  const wrapper="const{spawn}=require('node:child_process');const child=spawn(process.execPath,['-e',"+JSON.stringify(native)+",...process.argv.slice(1)],{stdio:'ignore',windowsHide:true,detached:true});child.unref();";
  const root=await launchIndependentWindows({home,executable:process.execPath,args:['-e',wrapper,ready,stop],cwd:home,env:process.env,logfile:path.join(home,'run','root.log'),role:'codex-runtime',launchId:randomUUID()});
  t.after(async()=>{await releaseOwnedProcess(root);await temp.cleanup();});
  const deadline=Date.now()+7000;while(!existsSync(ready)&&Date.now()<deadline)await delay(20);
  const pids=JSON.parse(readFileSync(ready,'utf8')),identity=await processIdentity(pids.native),descendant=await processIdentity(pids.child);
  assert.equal(await ownedProcessState(root.identity),'dead');
  for(const invalid of [{pid:2147483647,startedAt:identity.startedAt},{...identity,startedAt:(BigInt(identity.startedAt)+1n).toString()},await processIdentity(process.pid)]){
    await assert.rejects(watchWindowsJobNative(root.windowsJob!,invalid),{code:'launch_owner_unverified'});
    assert.equal(await ownedProcessState(identity),'alive','错误声明不能停止有效的容器');
  }
  await declareOwnedNative(root,identity);await declareOwnedNative(ownedProcesses(home).records.find(value=>value.id===root.id)!,identity);
  assert.deepEqual(ownedProcesses(home).records.find(value=>value.id===root.id)!.native,{pid:identity.pid,startedAt:identity.startedAt});
  await assert.rejects(watchWindowsJobNative(root.windowsJob!,descendant),{code:'launch_owner_unverified'});
  await watchWindowsJobNative(root.windowsJob!,identity);
  assert.equal(await ownedRecordState(root),'alive');writeFileSync(stop,'退出','utf8');
  while(await ownedRecordState(root)!=='dead'&&Date.now()<deadline)await delay(30);
  assert.equal(await ownedProcessState(descendant),'dead');assert.equal(await ownedProcessState(root.windowsHolder!),'dead');
});

test('Windows 程序别名的参数只取精确 PID 和代次，不替换成同名祖先',{skip:process.platform!=='win32',timeout:30000},async t=>{
  const temp=temporaryDirectory(),binary=path.join(temp.directory,'custom-runtime.exe');copyNodeBinary(binary);
  const argument='精确参数 Ω "引号"',child=spawn(binary,['-e',"process.send('ready');setInterval(()=>{},1000)",argument],{windowsHide:true,stdio:['ignore','ignore','ignore','ipc']}),exit=once(child,'exit');
  t.after(async()=>{if(child.exitCode===null&&child.signalCode===null)child.kill();await exit;await temp.cleanup();});await once(child,'message');
  const identity=await processIdentity(child.pid!);
  assert.ok((await codexArguments(identity)).includes(argument));
  await assert.rejects(codexArguments({...identity,startedAt:(BigInt(identity.startedAt)+1n).toString()}),{code:'process_identity_unknown'});
  assert.equal(child.exitCode,null);
});

test('旧代次的 PID 已复用为禁止终止的进程时，只读核验即可结束旧记录',{skip:process.platform!=='win32'},async t=>{
  const temp=temporaryDirectory(),child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore',windowsHide:true}),closed=once(child,'close');await once(child,'spawn');
  t.after(async()=>{if(child.exitCode===null&&child.signalCode===null)child.kill();await closed;await temp.cleanup();});
  const identity=await processIdentity(child.pid!),worker=path.join(temp.directory,'stop-reused.mjs'),source=String.raw`
using System;using System.Runtime.InteropServices;
public static class NxDenyTerminate {
 [StructLayout(LayoutKind.Sequential,Pack=1)]struct Privilege{public uint count;public long luid;public uint attributes;}
 [DllImport("advapi32.dll",SetLastError=true)]static extern bool SetKernelObjectSecurity(IntPtr handle,uint information,byte[] descriptor);
 [DllImport("advapi32.dll",SetLastError=true)]static extern bool OpenProcessToken(IntPtr process,uint access,out IntPtr token);
 [DllImport("advapi32.dll",CharSet=CharSet.Unicode,SetLastError=true)]static extern bool LookupPrivilegeValueW(string system,string name,out long luid);
 [DllImport("advapi32.dll",SetLastError=true)]static extern bool AdjustTokenPrivileges(IntPtr token,bool disableAll,ref Privilege privileges,uint size,IntPtr previous,IntPtr returned);
 [DllImport("kernel32.dll",SetLastError=true)]static extern IntPtr OpenProcess(uint access,bool inherit,uint pid);
 [DllImport("kernel32.dll")]static extern IntPtr GetCurrentProcess();
 [DllImport("kernel32.dll")]static extern bool CloseHandle(IntPtr handle);
 static void Check(bool ok){if(!ok)throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());}
 public static void DisableDebug(){IntPtr token;Check(OpenProcessToken(GetCurrentProcess(),0x20,out token));try{Privilege value=new Privilege();value.count=1;Check(LookupPrivilegeValueW(null,"SeDebugPrivilege",out value.luid));Check(AdjustTokenPrivileges(token,false,ref value,0,IntPtr.Zero,IntPtr.Zero));}finally{CloseHandle(token);}}
 public static void Deny(uint pid,byte[] descriptor){IntPtr handle=OpenProcess(0x40000,false,pid);Check(handle!=IntPtr.Zero);try{Check(SetKernelObjectSecurity(handle,4,descriptor));}finally{CloseHandle(handle);}}
 public static bool Denied(uint pid){IntPtr handle=OpenProcess(0x101001,false,pid);if(handle==IntPtr.Zero)return Marshal.GetLastWin32Error()==5;CloseHandle(handle);return false;}
}`;
  writeFileSync(worker,`import{spawn}from'node:child_process';import{once}from'node:events';import{processIdentity}from ${JSON.stringify(new URL('../process/process.js',import.meta.url).href)};import{stopWindowsProcess}from ${JSON.stringify(new URL('../process/windows/windows-hook-identity.js',import.meta.url).href)};await stopWindowsProcess(${JSON.stringify({...identity,startedAt:(BigInt(identity.startedAt)+1n).toString()})},1000);const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore',windowsHide:true});await once(child,'spawn');const closed=once(child,'close');try{await stopWindowsProcess(await processIdentity(child.pid),1000);await closed;}finally{if(child.exitCode===null&&child.signalCode===null)child.kill();}`,'utf8');
                                                    
  const script="$ErrorActionPreference='Stop';Add-Type -TypeDefinition $env:NXBRIDGE_DENY_SOURCE;[NxDenyTerminate]::DisableDebug();$sid=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value;$descriptor=[Security.AccessControl.RawSecurityDescriptor]::new('D:(D;;0x1;;;'+$sid+')(A;;0x1fffff;;;'+$sid+')');$bytes=New-Object byte[] $descriptor.BinaryLength;$descriptor.GetBinaryForm($bytes,0);[NxDenyTerminate]::Deny([uint32]$env:NXBRIDGE_DENY_PID,$bytes);[NxDenyTerminate]::Denied([uint32]$env:NXBRIDGE_DENY_PID);& $env:NXBRIDGE_DENY_NODE $env:NXBRIDGE_DENY_WORKER;if($LASTEXITCODE -ne 0){throw '旧代次只读停止失败'}";
  const result=await promisify(execFile)(windowsPowerShell(),['-NoLogo','-NoProfile','-NonInteractive','-Command',script],{windowsHide:true,env:{...process.env,NXBRIDGE_DENY_SOURCE:source,NXBRIDGE_DENY_PID:String(child.pid),NXBRIDGE_DENY_NODE:process.execPath,NXBRIDGE_DENY_WORKER:worker}});assert.equal(result.stdout.trim(),'True');
  assert.equal(await ownedProcessState(identity),'alive');
});
