import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { launchIndependentWindows, windowsArgument, windowsBackgroundSource } from '../process/windows/windows-background.js';
import {ensureHome} from '../ipc/home.js';
import {delay} from '../shared/time.js';
import {windowsPowerShell} from '../shared/windows-tools.js';
import { ownedProcesses, releaseOwnedProcess, rememberOwnedChild, recordOwnedProcess, type OwnedProcessRecord } from '../process/owned-processes.js';
import { ownedProcessState, stopOwnedProcess } from '../process/process-stop.js';
import { processIdentity, type ProcessIdentity } from '../process/process.js';
import { temporary } from './support/temporary.js';
import { requireIndependentWindows } from './support/windows-job.js';
import { windowsHookIdentityHelper } from '../process/windows/windows-hook-identity.js';
import {containerCompletionFile} from '../process/owned-processes.js';

test('Windows 原生命令行保留空值、空格、引号和末尾反斜线',()=>{
  assert.equal(windowsArgument(''),'""');
  assert.equal(windowsArgument('a b'),'"a b"');
  assert.equal(windowsArgument('a\\"b'),'"a\\\\\\"b"');
  assert.equal(windowsArgument('C:\\a b\\'),'"C:\\a b\\\\"');
});

test('Windows 独立入口在归属提交后才运行，参数无损且助手编译文件全部清理',{skip:process.platform!=='win32',timeout:30000},async t=>{
  if(!await requireIndependentWindows(t))return;
  const home=temporary(t);await ensureHome(home);
  const output=path.join(home,'arguments.json'),args=['','中文 空格','a"b','C:\\a b\\'];
  const record=await launchIndependentWindows({home,executable:process.execPath,args:['-e','require("node:fs").writeFileSync(process.argv[1],JSON.stringify(process.argv.slice(2)));setInterval(()=>{},1000)',output,...args],cwd:home,env:{...process.env},logfile:path.join(home,'run','native.log'),role:'codex-runtime',launchId:randomUUID(),peerId:'isolated'});
  t.after(async()=>{await releaseOwnedProcess(record);});
  assert.equal(await ownedProcessState(record.identity),'alive');
  assert.equal(ownedProcesses(home).records.some(value=>value.id===record.id),true);
  const deadline=Date.now()+5000;
  while(!existsSync(output)&&Date.now()<deadline)await delay(20);
  assert.deepEqual(JSON.parse(readFileSync(output,'utf8')),args);
  assert.deepEqual(readdirSync(path.join(home,'run')).filter(value=>value.startsWith('launcher-')),[]);
});

test('Windows 独立启动失败保留诊断且不留下编译目录或受管入口',{skip:process.platform!=='win32',timeout:30000},async t=>{
  const home=temporary(t);await ensureHome(home);
  await assert.rejects(launchIndependentWindows({home,executable:path.join(home,'missing.exe'),args:[],cwd:home,env:{...process.env},logfile:path.join(home,'run','failed.log'),role:'codex-runtime',launchId:randomUUID()}),(error:any)=>error.code==='bootstrap_required'&&!/\.cs\(/.test(error.message));
  assert.equal(ownedProcesses(home).records.filter(value=>value.role==='codex-runtime').length,0);
  assert.deepEqual(readdirSync(path.join(home,'run')).filter(value=>value.startsWith('launcher-')),[]);
});

test('Windows 协调器只回收自身代次，不连带终止共享 supervisor 的会话',{skip:process.platform!=='win32',timeout:30000},async t=>{
  if(!await requireIndependentWindows(t))return;
  const home=temporary(t);await ensureHome(home);const ready=path.join(home,'shared.json');
  const script="const{spawn}=require('node:child_process'),fs=require('node:fs');const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore',windowsHide:true,detached:true});fs.writeFileSync(process.argv[1],JSON.stringify({pid:child.pid}));setInterval(()=>{},1000);";
  const root=await launchIndependentWindows({home,executable:process.execPath,args:['-e',script,ready],cwd:home,env:process.env,logfile:path.join(home,'run','broker.log'),role:'broker',launchId:randomUUID()});
  let shared:OwnedProcessRecord|undefined;
  t.after(async()=>{await releaseOwnedProcess(root);if(shared)await releaseOwnedProcess(shared);});
  for(let i=0;!existsSync(ready)&&i<100;i++)await delay(20);
  shared=await recordOwnedProcess(path.join(home,'independent-evidence'),{role:'host-control',identity:await processIdentity(JSON.parse(readFileSync(ready,'utf8')).pid),parent:root.identity,proof:{kind:'spawn'}});
  assert.equal(root.windowsJob,undefined);assert.equal(root.windowsHolder,undefined);await releaseOwnedProcess(root);
  assert.equal(await ownedProcessState(shared.identity),'alive','其他会话的 supervisor 只能由其自己的归属证明释放');
});

for(const stage of ['created','held','holder-lost','committed'])test(`Windows 启动助手在 ${stage} 阶段被终止，已提交入口保持独立，未提交入口不执行`,{skip:process.platform!=='win32',timeout:30000},async t=>{
  if(!await requireIndependentWindows(t))return;
  const committed=stage==='committed';
  const home=temporary(t);await ensureHome(home);
  const ready=path.join(home,'ready.json'),resumed=path.join(home,'resumed'),executed=path.join(home,'executed'),completionFile=containerCompletionFile(home);
  const nested=path.join(home,'nested.json'),entry='const{writeFileSync}=require("node:fs");writeFileSync(process.argv[1],"executed");'+(committed?'(async()=>{const{launchIndependentWindows}=await import('+JSON.stringify(new URL('../process/windows/windows-background.js',import.meta.url).href)+');const{atomicJson}=await import('+JSON.stringify(new URL('../shared/files.js',import.meta.url).href)+');const record=await launchIndependentWindows({home:process.env.NXBRIDGE_GUARD_HOME,executable:process.execPath,args:["-e","setInterval(()=>{},1000)"],cwd:process.env.NXBRIDGE_GUARD_HOME,env:{...process.env},logfile:process.env.NXBRIDGE_GUARD_HOME+"/run/nested.log",role:"codex-runtime",launchId:require("node:crypto").randomUUID()});atomicJson(process.env.NXBRIDGE_GUARD_NESTED,record);})();':'')+'setInterval(()=>{},1000);';
  const checkpoint='Generation=created.ToString();',source=stage!=='created'?windowsBackgroundSource:windowsBackgroundSource.replace(checkpoint,checkpoint+'System.IO.File.WriteAllText(System.Environment.GetEnvironmentVariable("NXBRIDGE_GUARD_READY")+".tmp","{\\"pid\\":"+info.pid+",\\"generation\\":\\""+Generation+"\\"}");System.IO.File.Move(System.Environment.GetEnvironmentVariable("NXBRIDGE_GUARD_READY")+".tmp",System.Environment.GetEnvironmentVariable("NXBRIDGE_GUARD_READY"));System.Threading.Thread.Sleep(-1);');
  const script=String.raw`
$ErrorActionPreference='Stop'
$files=[CodeDom.Compiler.TempFileCollection]::new($env:NXBRIDGE_GUARD_HOME,$false)
$compiler=[CodeDom.Compiler.CompilerParameters]::new();$compiler.GenerateInMemory=$true;$compiler.TempFiles=$files;$null=$compiler.ReferencedAssemblies.Add('System.dll')
$launcher=$null
try {
 Add-Type -TypeDefinition $env:NXBRIDGE_GUARD_SOURCE -CompilerParameters $compiler
 $environment=([Environment]::GetEnvironmentVariables().GetEnumerator()|ForEach-Object{$_.Key+'='+$_.Value}) -join [char]0;$environment+=[string][char]0+[char]0
 $launcher=[NxBackground]::new();$launcher.Start($env:NXBRIDGE_GUARD_NODE,$env:NXBRIDGE_GUARD_COMMAND,$environment,$env:NXBRIDGE_GUARD_HOME,$env:NXBRIDGE_GUARD_LOG)
 $launcher.Protect($env:NXBRIDGE_GUARD_HOLDER,$true,$env:NXBRIDGE_GUARD_DONE)
 [IO.File]::WriteAllText($env:NXBRIDGE_GUARD_READY+'.tmp',(@{pid=$launcher.Pid;generation=$launcher.Generation;job=$launcher.JobName;holder=@{pid=$launcher.HolderPid;startedAt=$launcher.HolderGeneration}}|ConvertTo-Json -Compress -Depth 3),[Text.UTF8Encoding]::new($false));[IO.File]::Move($env:NXBRIDGE_GUARD_READY+'.tmp',$env:NXBRIDGE_GUARD_READY)
 if([Console]::ReadLine() -ne 'resume'){throw 'fixture canceled'}
 $launcher.Resume();[IO.File]::WriteAllText($env:NXBRIDGE_GUARD_RESUMED,'ready');$null=[Console]::ReadLine()
} finally {if($launcher){$launcher.Dispose()};$files.Delete()}
`;
  const helper=spawn(windowsPowerShell(),['-NoLogo','-NoProfile','-NonInteractive','-Command',script],{windowsHide:true,stdio:['pipe','pipe','pipe'],env:{...process.env,NXBRIDGE_GUARD_HOME:home,NXBRIDGE_GUARD_READY:ready,NXBRIDGE_GUARD_RESUMED:resumed,NXBRIDGE_GUARD_NESTED:nested,NXBRIDGE_GUARD_SOURCE:source,NXBRIDGE_GUARD_NODE:process.execPath,NXBRIDGE_GUARD_DONE:completionFile,NXBRIDGE_GUARD_HOLDER:await windowsHookIdentityHelper(home),NXBRIDGE_GUARD_COMMAND:[process.execPath,'-e',entry,executed].map(windowsArgument).join(' '),NXBRIDGE_GUARD_LOG:path.join(home,'run','child.log')}}),closed=once(helper,'close');
  let errors='',identity:ProcessIdentity|undefined,record:OwnedProcessRecord|undefined;
  helper.stderr!.on('data',chunk=>errors+=chunk);helper.stdin!.on('error',()=>{});
  t.after(async()=>{if(helper.exitCode===null&&helper.signalCode===null)helper.kill();await closed;if(record)await releaseOwnedProcess(record);else if(identity)await stopOwnedProcess(identity);});
  assert.ok(await rememberOwnedChild(home,helper,'host-control'));
  const until=async(check:()=>boolean|Promise<boolean>)=>{const deadline=Date.now()+10000;while(!await check()){assert.ok(Date.now()<deadline,errors||'启动阶段未完成');await delay(20);}};
  await until(()=>existsSync(ready));const captured=JSON.parse(readFileSync(ready,'utf8'));identity=await processIdentity(captured.pid);assert.equal(identity.startedAt,captured.generation);assert.equal(identity.parentPid,helper.pid);
  if(captured.job)record=await recordOwnedProcess(home,{role:'codex-runtime',identity,parent:await processIdentity(helper.pid!),windowsJob:captured.job,windowsHolder:captured.holder,completionFile,proof:{kind:'spawn',launchId:randomUUID()}});
  if(committed){
    helper.stdin!.write('resume\n');await until(()=>existsSync(resumed)&&existsSync(executed)&&existsSync(nested));
  }
  if(stage==='holder-lost'){await stopOwnedProcess(record!.windowsHolder!);helper.stdin!.end('resume\n');await closed;assert.match(errors,/job holder exited before commit/);}
  else{helper.kill();await closed;}
  if(committed){assert.equal(await ownedProcessState(identity),'alive');assert.ok(ownedProcesses(home).records.some(value=>value.id===record!.id));const next=JSON.parse(readFileSync(nested,'utf8')) as OwnedProcessRecord;assert.equal(await ownedProcessState(next.identity),'alive');await releaseOwnedProcess(record!);record=undefined;assert.equal(await ownedProcessState(identity),'dead');assert.equal(await ownedProcessState(next.identity),'alive');await releaseOwnedProcess(next);assert.equal(await ownedProcessState(next.identity),'dead');}
  else{await until(async()=>await ownedProcessState(identity!)==='dead');assert.equal(existsSync(executed),false);if(record)await until(()=>existsSync(completionFile));}
});
