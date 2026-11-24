import { copyNodeBinary } from './support/node-binary.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { once } from 'node:events';
import { copyFileSync, existsSync, mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { readWindowsAncestors, readWindowsHookIdentity, windowsHookIdentityHelper } from '../process/windows/windows-hook-identity.js';
import { windowsHookIdentitySource } from '../process/windows/native-sources.js';
import { processAncestry, processIdentity, windowsAncestry, windowsArguments } from '../process/process.js';
import { recordOwnedProcess, releaseOwnedProcess } from '../process/owned-processes.js';
import { ownedProcessState } from '../process/process-stop.js';
import {sameDirectory} from '../shared/files.js';
import { temporaryDirectory } from './support/temporary.js';

const execute=promisify(execFile),options={skip:process.platform!=='win32',timeout:30000};
async function compile(home:string,source:string,output:string):Promise<void>{
  const file=path.join(home,'fixture.cs'),windows=process.env.SystemRoot??'C:\\Windows',compiler=path.join(windows,'Microsoft.NET','Framework64','v4.0.30319','csc.exe');
  mkdirSync(path.dirname(output),{recursive:true});writeFileSync(file,source,'utf8');
  await execute(compiler,['/nologo','/target:exe','/optimize+','/platform:anycpu','/out:'+output,file],{windowsHide:true,timeout:10000});
}

test('Windows 通用祖先查询冷准备及并发暖查询保持同代父链，原生成功零 WMI',options,async t=>{
  const temp=temporaryDirectory(),home=path.join(temp.directory,'bridge'),child=spawn(process.execPath,['-e',"process.send('ready');setInterval(()=>{},1000)"],{windowsHide:true,stdio:['ignore','ignore','ignore','ipc']}),closed=once(child,'close');
  t.after(async()=>{if(child.exitCode===null&&child.signalCode===null)child.kill();await closed;await temp.cleanup();});await once(child,'message');
  const began=performance.now(),first=await readWindowsAncestors(child.pid!,2,10000,home),coldMs=performance.now()-began,parent=await processIdentity(process.pid),warm=performance.now();
  const chains=await Promise.all(Array.from({length:12},()=>windowsAncestry(child.pid!,2,10000,(pid,depth,budget)=>readWindowsAncestors(pid,depth,budget,home))));
  for(const chain of [first,...chains]){
    assert.equal(chain.source,'native');assert.equal(chain.complete,false);assert.equal(chain.reason,'depth');
    assert.deepEqual(chain.ancestors.map(row=>row.pid),[child.pid,process.pid]);assert.equal(chain.ancestors[1]?.startedAt,parent.startedAt);
    assert.equal(chain.ancestors[0]?.startedAt,first.ancestors[0]?.startedAt);assert.equal(chain.ancestors[0]?.procStartFt,first.ancestors[0]?.startedAt);
  }
  const absent=await readWindowsAncestors(2147483647,32,10000,home);assert.equal(absent.complete,true);assert.equal(absent.reason,'missing');assert.deepEqual(absent.ancestors,[]);
  t.diagnostic(JSON.stringify({backend:'native',coldMs,warmParallel12Ms:performance.now()-warm,wmiCalls:0}));
});

test('Windows 超过 MAX_PATH 的中文及代理对映像、更新后缀和完整长参数均不截断',options,async t=>{
  const temp=temporaryDirectory(),home=path.join(temp.directory,'bridge'),directory=path.join(temp.directory,...Array(5).fill('中文 e\u0301 Ω 🚀 '+ 'long'.repeat(12))),binary=path.join(directory,'codex.exe'),old=binary+'.old.123456';
  mkdirSync(directory,{recursive:true});assert.ok(binary.length>300);copyNodeBinary(binary);
  const argument='中文 🚀 Ω e\u0301 '.repeat(1000),child=spawn(path.toNamespacedPath(binary),['-e',"process.send('ready');setInterval(()=>{},1000)",argument],{windowsHide:true,stdio:['ignore','ignore','ignore','ipc']}),closed=new Promise<void>(resolve=>child.once('close',()=>resolve()));
  t.after(async()=>{if(child.exitCode===null&&child.signalCode===null)child.kill();await closed;await temp.cleanup();});await once(child,'message');
  renameSync(binary,old);
  const ancestry=await readWindowsAncestors(child.pid!,2,10000,home),identity=ancestry.ancestors[0]!,host=await readWindowsHookIdentity(child.pid!,home);
  assert.ok(sameDirectory(identity.image!,old));assert.ok(sameDirectory(identity.launchImage!,binary));assert.equal(identity.name,'codex.exe');
  assert.equal(identity.image!.length,old.length);assert.equal(host.image,identity.image);assert.equal(host.procStart,identity.startedAt);assert.ok(windowsArguments(host.commandLine).includes(argument));
  assert.equal(child.exitCode,null);
});

test('Windows 助手按源码修订升级；旧二进制不认识 ancestors 时保留可用性错误',options,async t=>{
  const temp=temporaryDirectory(),home=temp.directory,oldSource=windowsHookIdentitySource.replace('if(args.Length>0&&args[0]=="ancestors")return Ancestors(args);',''),oldRevision=createHash('sha256').update(oldSource).digest('hex').slice(0,16),legacy=path.join(home,'run','hook-identity-'+oldRevision,'identity.exe');
  t.after(temp.cleanup);assert.notEqual(oldSource,windowsHookIdentitySource);await compile(home,oldSource,legacy);
  const current=await windowsHookIdentityHelper(home),chain=await readWindowsAncestors(process.pid,1,10000,home);
  assert.notEqual(current,legacy);assert.equal(existsSync(legacy),true);assert.equal(chain.ancestors[0]?.pid,process.pid);
  copyFileSync(legacy,current);await assert.rejects(readWindowsAncestors(process.pid,1,10000,home),{code:'native_identity_unavailable'});
  await assert.rejects(windowsAncestry(process.pid,1,10000,(pid,depth,budget)=>readWindowsAncestors(pid,depth,budget,home)),{code:'native_identity_unavailable'});
});

test('Windows 复用进入已见 PID 及退出均正常断链，真正身份冲突才拒绝且不回退',options,async t=>{
  const temp=temporaryDirectory(),home=temp.directory;t.after(temp.cleanup);
  const binary=await windowsHookIdentityHelper(home),custom=path.join(home,'custom.exe');
  for(const mode of ['reused','cycle','exited-root','exited-parent','mismatch']){
    const source=mode==='reused'?windowsHookIdentitySource.replace('if(created>childCreated)','if(rows.Count>0||created>childCreated)'):
      mode==='cycle'?windowsHookIdentitySource.replace('childCreated=created;pid=(uint)info.parent.ToUInt64();','childCreated=created;pid=rows[0].pid;'):
      mode==='mismatch'?windowsHookIdentitySource.replace('if(info.pid.ToUInt64()!=pid||info.parent.ToUInt64()>Int32.MaxValue)','if(true)'):
      windowsHookIdentitySource.replace('uint state=WaitForSingleObject(handles[index],0);','uint state=index=='+(mode==='exited-root'?0:1)+'?0u:WaitForSingleObject(handles[index],0);');
    assert.notEqual(source,windowsHookIdentitySource);await compile(home,source,custom);copyFileSync(custom,binary);
    const query=()=>windowsAncestry(process.pid,32,10000,(pid,depth,budget)=>readWindowsAncestors(pid,depth,budget,home));
    if(mode==='mismatch')await assert.rejects(query(),{code:'process_identity_unknown'});
    else{const chain=await query();assert.equal(chain.complete,true);assert.equal(chain.reason,mode==='reused'||mode==='cycle'?'parent_reused':mode==='exited-root'?'missing':'parent_missing');assert.equal(chain.ancestors.length,mode==='exited-root'?0:1);}
  }
});

test('Windows 原生 JSON 保留孤立 UTF-16 代理字符、有效代理对与完整路径',options,async t=>{
  const temp=temporaryDirectory(),home=temp.directory,binary=path.join(home,'json.exe'),value='C:\\中文\\lone-\ud800-\udfff-pair-🚀\\codex.exe';t.after(temp.cleanup);
  const marker='if(args.Length>0&&args[0]=="probe")return Probe(args);',extra='if(args.Length>0&&args[0]=="fixture-json"){Console.OutputEncoding=new UTF8Encoding(false);Console.Write(Json('+JSON.stringify(value)+'));return 0;}';
  const source=windowsHookIdentitySource.replace(marker,extra+marker);assert.notEqual(source,windowsHookIdentitySource);await compile(home,source,binary);
  const {stdout}=await execute(binary,['fixture-json'],{windowsHide:true,timeout:10000});
  assert.ok(stdout.includes('\\ud800'));assert.ok(stdout.includes('\\udfff'));assert.equal(JSON.parse(stdout),value);
});

test('Windows 已登记子进程的启动器退出后，原生断链仍允许按原代次回收',options,async t=>{
  const temp=temporaryDirectory(),home=path.join(temp.directory,'bridge'),launcher=spawn(process.execPath,['-e',"const{spawn}=require('node:child_process');const c=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{detached:true,windowsHide:true,stdio:'ignore'});c.on('spawn',()=>process.send(c.pid));process.on('message',()=>process.exit());"],{windowsHide:true,stdio:['ignore','ignore','ignore','ipc']}),closed=once(launcher,'close');
  let identity:Awaited<ReturnType<typeof processIdentity>>|undefined,record:Awaited<ReturnType<typeof recordOwnedProcess>>|undefined;
  t.after(async()=>{if(launcher.exitCode===null&&launcher.signalCode===null)launcher.kill();await closed;if(record)await releaseOwnedProcess(record);else if(identity&&await ownedProcessState(identity)==='alive')process.kill(identity.pid);await temp.cleanup();});
  const [pid]=await once(launcher,'message');identity=await processIdentity(pid);record=await recordOwnedProcess(home,{role:'host-control',identity,parent:await processIdentity(process.pid),proof:{kind:'spawn'}});
  launcher.send('exit');await closed;
  const chain=await processAncestry(identity.pid,32);assert.equal(chain.complete,true);assert.equal(chain.reason,'parent_missing');assert.equal(chain.ancestors.length,1);
  await releaseOwnedProcess(record);record=undefined;assert.equal(await ownedProcessState(identity),'dead');
});
