import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdirSync, readFileSync, existsSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { spawnPosixSupervisor, posixSupervisorExit, watchPosixNative } from '../process/posix/posix-supervisor.js';
import { processIdentity } from '../process/process.js';
import { ownedProcessState } from '../process/process-stop.js';
import { rememberOwnedChild, recordOwnedProcess, releaseOwnedProcess, ownedRecordState, declareOwnedNative, ownedProcesses, processRegistryDirectory, type OwnedProcessRecord } from '../process/owned-processes.js';
import {delay} from '../shared/time.js';
import { temporaryDirectory } from './support/temporary.js';

const options={skip:process.platform==='win32',timeout:20000};

test('POSIX 原生命令启动失败仍提供原始系统错误',options,async t=>{
  const fixture=temporaryDirectory(),home=fixture.directory,child=spawnPosixSupervisor(path.join(home,'不存在的程序'),[],{stdio:'ignore'}),closed=new Promise(resolve=>child.once('close',resolve));
  const failure=new Promise<Error>(resolve=>child.once('error',resolve));
  const proof=await rememberOwnedChild(home,child,'host-control',{posixGroup:true});t.after(async()=>{if(proof)await releaseOwnedProcess(proof);await fixture.cleanup();});
  assert.equal((await failure as NodeJS.ErrnoException).code,'ENOENT');await closed;
});

for(const waitForNative of [false,true])for(const code of [0,23])test('POSIX 原生退出码 '+code+' 经组长清理后仍完整传给调用者，等待交接：'+waitForNative,options,async t=>{
  const fixture=temporaryDirectory(),home=fixture.directory,child=spawnPosixSupervisor(process.execPath,['-e',`process.stdout.write('原生输出');process.stderr.write('原生诊断');process.exitCode=${code};`],{stdio:['ignore','pipe','pipe'],waitForNative}),closed=once(child,'close');
  const proof=await rememberOwnedChild(home,child,'host-control',{posixGroup:true});let stdout='',stderr='';child.stdout!.on('data',chunk=>stdout+=chunk);child.stderr!.on('data',chunk=>stderr+=chunk);
  t.after(async()=>{if(proof)await releaseOwnedProcess(proof);await fixture.cleanup();});await closed;
  assert.deepEqual(posixSupervisorExit(child),{code,signal:null});assert.equal(stdout,'原生输出');assert.equal(stderr,'原生诊断');
  assert.equal(existsSync(proof!.completionFile!),true,'监督进程在组排空后自行发布完成凭据');
  assert.equal(await ownedRecordState(proof!),'dead');
});

test('POSIX 启动归属尚未提交时丢失所有者，监督进程主动回收已启动的子进程',options,async t=>{
  const fixture=temporaryDirectory(),home=fixture.directory,ready=path.join(home,'started.json');
  const script="require('node:fs').writeFileSync(process.argv[1],JSON.stringify({pid:process.pid}));setInterval(()=>{},1000);";
  const supervisor=spawnPosixSupervisor(process.execPath,['-e',script,ready],{stdio:'ignore',waitForNative:true}),closed=once(supervisor,'close');
                                                      
  const proof=await recordOwnedProcess(home,{role:'host-control',identity:await processIdentity(supervisor.pid!),parent:await processIdentity(process.pid),posixGroup:true,proof:{kind:'spawn'}});
  t.after(async()=>{await releaseOwnedProcess(proof);await fixture.cleanup();});
  for(let i=0;!existsSync(ready)&&i<100;i++)await delay(20);
  const native=await processIdentity(JSON.parse(readFileSync(ready,'utf8')).pid);
  (supervisor.stdio[3] as import('node:net').Socket).destroy();await closed;
  assert.equal(await ownedProcessState(native),'dead');assert.equal(await ownedRecordState(proof),'dead');
});

test('POSIX 包装器先退出时保留已声明宿主，宿主退出后回收忽略 TERM 的后代',options,async t=>{
  const fixture=temporaryDirectory(),home=fixture.directory,ready=path.join(home,'native.json'),stop=path.join(home,'native-exit');
  const native="const{spawn}=require('node:child_process'),fs=require('node:fs');const child=spawn(process.execPath,['-e',\"process.on('SIGTERM',()=>{});setInterval(()=>{},1000);\"],{stdio:'ignore'});child.once('spawn',()=>fs.writeFileSync(process.argv[1],JSON.stringify({native:process.pid,child:child.pid})));setInterval(()=>{if(fs.existsSync(process.argv[2]))process.exit(0);},25);";
  const wrapper="const{spawn}=require('node:child_process');const child=spawn(process.execPath,['-e',"+JSON.stringify(native)+",...process.argv.slice(1)],{stdio:'ignore'});child.unref();";
  const supervisor=spawnPosixSupervisor(process.execPath,['-e',wrapper,ready,stop],{stdio:'ignore',waitForNative:true}),closed=once(supervisor,'close'),proof=await rememberOwnedChild(home,supervisor,'host-control',{posixGroup:true});
  t.after(async()=>{if(proof)await releaseOwnedProcess(proof);await fixture.cleanup();});
  for(let i=0;!existsSync(ready)&&i<100;i++)await delay(20);
  const pids=JSON.parse(readFileSync(ready,'utf8')),identity=await processIdentity(pids.native),descendant=await processIdentity(pids.child);await watchPosixNative(supervisor,identity);
  await delay(300);assert.equal(await ownedRecordState(proof!),'alive');assert.equal(await ownedProcessState(identity),'alive');
  writeFileSync(stop,'退出','utf8');await closed;
                                                    
  const deadline=performance.now()+2000;let state=await ownedProcessState(descendant),group=await ownedRecordState(proof!);
  while((state!=='dead'||group!=='dead')&&performance.now()<deadline){await delay(20);state=await ownedProcessState(descendant);group=await ownedRecordState(proof!);}
  assert.equal(state,'dead',`后代进程 ${descendant.pid} 在组长退出后仍未结束，状态 ${state}`);assert.equal(group,'dead',`监督进程 ${proof!.identity.pid} 的进程组仍未结束，状态 ${group}`);
});

test('POSIX 启动通道断开后其他进程可重复交接，错误代次或外部宿主不能替换容器身份',options,async t=>{
  const fixture=temporaryDirectory(),home=fixture.directory,ready=path.join(home,'native.json'),stop=path.join(home,'native-exit');
  const native="const fs=require('node:fs');fs.writeFileSync(process.argv[1],JSON.stringify({pid:process.pid}));setInterval(()=>{if(fs.existsSync(process.argv[2]))process.exit(0);},25);";
  const wrapper="const{spawn}=require('node:child_process');const child=spawn(process.execPath,['-e',"+JSON.stringify(native)+",...process.argv.slice(1)],{stdio:'ignore'});child.unref();";
  const supervisor=spawnPosixSupervisor(process.execPath,['-e',wrapper,ready,stop],{stdio:'ignore',waitForNative:true}),closed=once(supervisor,'close'),proof=await rememberOwnedChild(home,supervisor,'codex-runtime',{posixGroup:true});assert.ok(proof);
  t.after(async()=>{await releaseOwnedProcess(proof);await fixture.cleanup();});
  for(let i=0;!existsSync(ready)&&i<100;i++)await delay(20);
  const identity=await processIdentity(JSON.parse(readFileSync(ready,'utf8')).pid);
  assert.equal(path.dirname(proof.completionFile!),processRegistryDirectory(home),'完成凭据保存在持久归属目录');
  assert.notEqual(path.dirname(proof.completionFile!),path.dirname(proof.posixControl!),'临时目录仅保存控制 socket');
  assert.ok(proof.posixControl);(supervisor.stdio[3] as import('node:net').Socket).destroy();
  for(const invalid of [{pid:2147483647,startedAt:identity.startedAt},{...identity,startedAt:identity.startedAt+'0'},await processIdentity(process.pid)]){
    await assert.rejects(declareOwnedNative(proof,invalid),{code:'process_launch_unverified'});assert.equal(await ownedProcessState(identity),'alive');
  }
  const module=JSON.stringify(new URL('../process/owned-processes.js',import.meta.url).href),script=`import{declareOwnedNative,ownedProcesses}from ${module};const record=ownedProcesses(${JSON.stringify(home)}).records.find(value=>value.id===${JSON.stringify(proof.id)});await declareOwnedNative(record,${JSON.stringify(identity)});`;
  await promisify(execFile)(process.execPath,['--input-type=module','-e',script],{timeout:10000});
  const current=ownedProcesses(home).records.find(value=>value.id===proof.id)!;await declareOwnedNative(current,identity);
  await assert.rejects(declareOwnedNative(current,await processIdentity(process.pid)),{code:'process_launch_unverified'});
  assert.deepEqual(current.native,{pid:identity.pid,startedAt:identity.startedAt});
  writeFileSync(stop,'退出','utf8');await closed;assert.equal(await ownedRecordState(proof),'dead');
  await releaseOwnedProcess(proof);assert.equal(existsSync(path.dirname(proof.posixControl!)),false);
});

test('POSIX 监督进程被强制结束后，只保留未知组，不能按数字组号杀死未登记后代',options,async t=>{
  const fixture=temporaryDirectory(),home=fixture.directory,evidence=path.join(home,'独立测试凭据'),ready=path.join(home,'ready.json');mkdirSync(evidence);
  const script="const{spawn}=require('node:child_process'),{writeFileSync}=require('node:fs');const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});child.once('spawn',()=>writeFileSync(process.argv[1],JSON.stringify({native:process.pid,child:child.pid})));setInterval(()=>{},1000);";
  const supervisor=spawnPosixSupervisor(process.execPath,['-e',script,ready],{stdio:'ignore'}),closed=once(supervisor,'close'),root=await rememberOwnedChild(home,supervisor,'host-control',{posixGroup:true});
  const proofs:OwnedProcessRecord[]=[];
  t.after(async()=>{for(const proof of proofs.reverse())await releaseOwnedProcess(proof);if(root)await releaseOwnedProcess(root);await fixture.cleanup();});
  for(let i=0;!existsSync(ready)&&i<100;i++)await delay(20);
  const pids=JSON.parse(readFileSync(ready,'utf8')) as {native:number;child:number};
  for(const pid of [pids.native,pids.child])proofs.push(await recordOwnedProcess(evidence,{role:'host-control',identity:await processIdentity(pid),parent:root!.identity,proof:{kind:'spawn'}}));
  supervisor.kill('SIGKILL');await closed;
  assert.equal(await ownedRecordState(root!),'unknown');await assert.rejects(releaseOwnedProcess(root!),{code:'process_identity_unknown'});
  for(const proof of proofs)assert.equal(await ownedProcessState(proof.identity),'alive','业务账本没有这些代次，不能从仍存在的数字组号扩张停止权限');
});
