import { copyNodeBinary } from './support/node-binary.js';
import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { Worker } from 'node:worker_threads';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import net from 'node:net';
import { temporaryDirectory } from './support/temporary.js';
import { processIdentity } from '../process/process.js';
import { ownedProcessState, stopOwnedProcess } from '../process/process-stop.js';
import { ownedProcesses, processRegistryDirectory, processRegistryRoot, recordOwnedProcess, releaseOwnedProcess, rememberOwnedChild, transferOwnedPeerToUser, recordSpawnedProcess, ownedRecordState, forgetOwnedProcess, declareOwnedNative, ownedRecordPredatesBoot, ownedContainerComplete } from '../process/owned-processes.js';
import { spawnPosixSupervisor } from '../process/posix/posix-supervisor.js';
import { uptime } from 'node:os';
import { Store } from '../storage/store.js';
import { pruneProcessOwnership, releaseOwnedOffline } from '../process/process-cleanup.js';
import { migrateLegacyOwnership } from '../process/legacy-owned.js';
import {atomicJson} from '../shared/files.js';
import { managedMarker } from '../install/installation.js';
import {DEFAULT_CONFIG} from '../config/defaults.js';
import { ClaudeAdapter } from '../hosts/claude/adapter.js';

async function scope(t:TestContext){
  const temp=temporaryDirectory(),home=path.join(temp.directory,'bridge'),previous=process.env.NXBRIDGE_PROCESS_REGISTRY;
  mkdirSync(home);process.env.NXBRIDGE_PROCESS_REGISTRY=path.join(temp.directory,'external-evidence');
  const store=new Store(path.join(home,'nxbridge.db'));store.close();
  t.after(async()=>{if(previous===undefined)delete process.env.NXBRIDGE_PROCESS_REGISTRY;else process.env.NXBRIDGE_PROCESS_REGISTRY=previous;await temp.cleanup();});
  const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{windowsHide:true,stdio:'ignore'}),closed=once(child,'close');
  await once(child,'spawn');
  t.after(async()=>{if(child.exitCode===null&&child.signalCode===null)child.kill();await closed;});
  const identity=await processIdentity(child.pid!),parent=await processIdentity(process.pid);
  return{home,child,identity,parent};
}

test('持久归属副本在 home 删除后仍能核验并释放本次启动进程',async t=>{
  const {home,child,identity,parent}=await scope(t);
  const record=await recordOwnedProcess(home,{role:'claude-child',identity,parent,proof:{kind:'spawn'}});
  assert.equal(ownedProcesses(home).records.length,1);
  rmSync(home,{recursive:true,force:true});
  assert.equal(ownedProcesses(home).records[0]?.identity.startedAt,identity.startedAt);
  await releaseOwnedProcess(record);assert.equal(await ownedProcessState(identity),'dead');
  assert.equal(ownedProcesses(home).records.length,0);assert.notEqual(child.exitCode===null&&child.signalCode===null,true);
});

test('归属目录枚举后记录消失视为撤销，权限错误仍报告',async t=>{
  const {home,identity,parent}=await scope(t),record=await recordOwnedProcess(home,{role:'host-control',identity,parent,proof:{kind:'spawn'}}),file=path.join(processRegistryDirectory(home),record.id+'.json'),original=fs.readFileSync;
  let code='ENOENT';
  t.mock.method(fs,'readFileSync',(...args:any[])=>{if(args[0]===file)throw Object.assign(Error('并发删除或读取拒绝'),{code});return Reflect.apply(original,fs,args);});
  syncBuiltinESMExports();
  try{
    assert.deepEqual(ownedProcesses(home).records,[]);
    code='EACCES';assert.throws(()=>ownedProcesses(home),{code:'EACCES'});
  }finally{t.mock.restoreAll();syncBuiltinESMExports();}
});

test('归属只读快照等待并发独占事务，不把短暂锁冲突报告为证据损坏',async t=>{
  const {home,identity,parent}=await scope(t),record=await recordOwnedProcess(home,{role:'host-control',identity,parent,proof:{kind:'spawn'}});
  const worker=new Worker(`
    const {DatabaseSync}=require('node:sqlite'),{parentPort,workerData}=require('node:worker_threads');
    const db=new DatabaseSync(workerData);db.exec('PRAGMA journal_mode=DELETE; BEGIN EXCLUSIVE');
    parentPort.postMessage('locked');
    setTimeout(()=>{db.exec('COMMIT');db.close();},300);
  `,{eval:true,workerData:path.join(home,'nxbridge.db')}),closed=once(worker,'exit');
  t.after(async()=>{await worker.terminate();await closed;});
  assert.equal((await once(worker,'message'))[0],'locked');
  assert.deepEqual(ownedProcesses(home),{records:[record],notes:[]});
});

test('两个回收入口并发停止同一代次时均完成，结果仍核验为已退出',async t=>{
  const {identity}=await scope(t);
  await Promise.all([stopOwnedProcess(identity),stopOwnedProcess(identity)]);
  assert.equal(await ownedProcessState(identity),'dead');
});

test('回收只比较停止权限，字段重排和迟到原生声明不改变同一容器的归属',async t=>{
  const {home,identity,parent}=await scope(t);
  const record=await recordOwnedProcess(home,{role:'host-control',identity,parent,proof:{kind:'spawn'}});
  const reordered=Object.fromEntries(Object.entries(record).reverse());
  atomicJson(path.join(processRegistryDirectory(home),record.id+'.json'),{...reordered,native:{pid:identity.pid,startedAt:identity.startedAt},handle:'迟到的宿主元数据'});
  await releaseOwnedProcess(record);
  assert.equal(await ownedProcessState(identity),'dead');assert.equal(ownedProcesses(home).records.length,0);
});

test('回收期间实际代次、容器或外部持有器改变时不发送信号，当前用户接管仍受保护',async t=>{
  const {home,identity,parent}=await scope(t);
  const record=await recordOwnedProcess(home,{role:'host-control',identity,parent,peerId:'当前归属',proof:{kind:'spawn'}}),file=path.join(processRegistryDirectory(home),record.id+'.json');
  try{
    for(const changed of [{identity:{...identity,startedAt:'另一代次'}},{windowsJob:'另一启动容器'},{posixGroup:true},{windowsHolder:{pid:parent.pid,startedAt:parent.startedAt}}]){
      atomicJson(file,{...record,...changed});
      await assert.rejects(releaseOwnedProcess(record),{code:'process_record_changed'});
      assert.equal(await ownedProcessState(identity),'alive');
    }
    transferOwnedPeerToUser(home,'当前归属');
    await assert.rejects(releaseOwnedProcess(ownedProcesses(home).records[0]!),{code:'process_owned_by_user'});
    assert.equal(await ownedProcessState(identity),'alive');
  }finally{atomicJson(file,record);}
  await releaseOwnedProcess(record);
});

test('其他入口撤销归属后，旧快照没有停止权限，也不伪造完成凭据',async t=>{
  const {home,identity,parent}=await scope(t),completionFile=path.join(home,'revoked.done');
  const record=await recordOwnedProcess(home,{role:'host-control',identity,parent,completionFile,proof:{kind:'spawn'}});
  forgetOwnedProcess(record,'authority-revoked');
  await releaseOwnedProcess(record);
  assert.equal(await ownedProcessState(identity),'alive');assert.equal(ownedContainerComplete(record),false);
});

test('并发回收已经退休并清除完成凭据的 POSIX 容器时，旧快照不再重新核验或终止',{skip:process.platform==='win32'},async t=>{
  const temp=temporaryDirectory(),home=path.join(temp.directory,'bridge');mkdirSync(home);t.after(temp.cleanup);
  const child=spawnPosixSupervisor(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});
  const record=await rememberOwnedChild(home,child,'host-control',{posixGroup:true});assert.ok(record);
  await releaseOwnedProcess(record);assert.equal(await ownedProcessState(record.identity),'dead');
  rmSync(path.join(processRegistryRoot(),'retired',record.id+'.done'));
  assert.equal(ownedContainerComplete(record),false);
  await releaseOwnedProcess(record);assert.equal(ownedContainerComplete(record),false);
});

test('PID 仍存活但代次改变时不发送终止信号；用户接管的记录也不释放',async t=>{
  const {home,identity,parent}=await scope(t);
  const record=await recordOwnedProcess(home,{role:'claude-child',identity,parent,peerId:'测试搭档',proof:{kind:'spawn'}});
  await assert.rejects(releaseOwnedProcess({...record,identity:{...identity,startedAt:'失效代次'}}),{code:'process_record_changed'});
  await stopOwnedProcess({...identity,startedAt:'失效代次'});
  assert.equal(await ownedProcessState(identity),'alive');
  assert.equal(ownedProcesses(home).records.length,1);
  transferOwnedPeerToUser(home,'测试搭档');
  await assert.rejects(releaseOwnedProcess(ownedProcesses(home).records[0]!),{code:'process_owned_by_user'});
  assert.equal(await ownedProcessState(identity),'alive');
});

test('当前调用进程不可被释放；没有启动父链的进程不能登记为自有',async t=>{
  const {home,identity,parent}=await scope(t);
  await assert.rejects(stopOwnedProcess(parent),{code:'process_is_caller'});
  await assert.rejects(recordOwnedProcess(home,{role:'claude-child',identity,parent:{pid:parent.pid,startedAt:'其他代次'},proof:{kind:'spawn'}}),{code:'process_launch_unverified'});
  assert.equal(await ownedProcessState(identity),'alive');assert.equal(ownedProcesses(home).records.length,0);
});

test('broker 不在线时只释放持久证明中的进程，清除空的外部归属目录',async t=>{
  const {home,identity,parent}=await scope(t);
  await recordOwnedProcess(home,{role:'host-control',identity,parent,proof:{kind:'spawn'}});
  assert.deepEqual(await releaseOwnedOffline(home,DEFAULT_CONFIG),[]);
  assert.equal(await ownedProcessState(identity),'dead');
  const cleanup=await pruneProcessOwnership(home,true);assert.deepEqual(cleanup.notes,[]);assert.equal(cleanup.removed,true);assert.equal(existsSync(cleanup.directory),false);
});

test('离线卸载同样释放已有启动证明的隔离 supervisor',async t=>{
  const {home,identity,parent}=await scope(t);
  await recordOwnedProcess(home,{role:'test-daemon',identity,parent,proof:{kind:'spawn'}});
  assert.deepEqual(await releaseOwnedOffline(home,DEFAULT_CONFIG),[]);
  assert.equal(await ownedProcessState(identity),'dead');assert.equal(ownedProcesses(home).records.length,0);
});

test('旧版本运行时证据冻结后迁移，后来的同名记录不会认领用户进程',async t=>{
  const {home,identity,parent}=await scope(t);mkdirSync(path.join(home,'run'));
  const file=path.join(home,'run','runtime-legacy.json'),store=new Store(path.join(home,'nxbridge.db'));
  try{
    atomicJson(file,{owner:managedMarker(home),pid:identity.pid,generation:identity.startedAt});
    assert.deepEqual(await migrateLegacyOwnership(home,store),[]);assert.equal(ownedProcesses(home).records[0]?.identity.startedAt,identity.startedAt);
    atomicJson(file,{owner:managedMarker(home),pid:parent.pid,generation:parent.startedAt});
    assert.deepEqual(await migrateLegacyOwnership(home,store),[]);assert.equal(ownedProcesses(home).records.length,1);
  }finally{store.close();}
  assert.equal(await ownedProcessState(parent),'alive');
});

test('主账本无法打开时仍核验外部归属并释放自有进程，保留损坏数据及诊断',async t=>{
  const {home,identity,parent}=await scope(t);
  await recordOwnedProcess(home,{role:'host-control',identity,parent,proof:{kind:'spawn'}});
  const database=path.join(home,'nxbridge.db');rmSync(database);mkdirSync(database);
  const proof=ownedProcesses(home);assert.equal(proof.records.length,1);assert.deepEqual(proof.notes,[]);
  const notes=await releaseOwnedOffline(home,DEFAULT_CONFIG);
  assert.equal(await ownedProcessState(identity),'dead');assert.ok(existsSync(database));assert.match(notes.join('；'),/账本无法读取/);
});

for(const selector of ['--session-id','--resume'])test('Windows 旧 Claude 端点的同代专属 PTY 父链一并迁移，首次释放不遗留宿主：'+selector,{skip:process.platform!=='win32',timeout:30000},async t=>{
                                                       
  const temp=temporaryDirectory(),home=path.join(temp.directory,'bridge'),configHome=path.join(temp.directory,'claude-home'),official=path.join(temp.directory,process.platform==='win32'?'claude.exe':'claude'),sessionId=randomUUID();
  mkdirSync(home);copyNodeBinary(official);
  const store=new Store(path.join(home,'nxbridge.db')),adapter=new ClaudeAdapter({...DEFAULT_CONFIG,claudeHome:configHome},home);
  const launcher=spawn(official,['-e',"const{spawn}=require('node:child_process');const c=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore',windowsHide:true});console.log(c.pid);setInterval(()=>{},1000);",'--','--bg-pty-host',selector,sessionId],{stdio:['ignore','pipe','pipe'],windowsHide:true}),closed=once(launcher,'close');
  let native:Awaited<ReturnType<typeof processIdentity>>|undefined,parent:Awaited<ReturnType<typeof processIdentity>>|undefined;
  t.after(async()=>{adapter.close();try{if(native)await stopOwnedProcess(native);if(parent)await stopOwnedProcess(parent);else if(launcher.exitCode===null&&launcher.signalCode===null)launcher.kill();await closed;}finally{store.close();await temp.cleanup();}});
  const pid=new Promise<number>((resolve,reject)=>{launcher.stdout!.once('data',value=>resolve(Number(value.toString().trim())));launcher.once('error',reject);});
  await rememberOwnedChild(home,launcher,'host-control');native=await processIdentity(await pid);parent=await processIdentity(launcher.pid!);
  const peer=store.register({host:'claude',sessionId,cwd:temp.directory,kind:'root',endpoint:{mode:'claude-inbox',address:'fixture',epoch:'legacy',pid:native.pid,procStart:native.startedAt,configHome}});store.updatePeer(peer.id,{owner:'nxbridge'});
  assert.deepEqual(await migrateLegacyOwnership(home,store),[]);
  const migrated=ownedProcesses(home).records.filter(value=>value.peerId===peer.id);assert.equal(migrated.length,2);
  await adapter.release(store.peer(peer.id));
  assert.equal(await ownedProcessState(native),'dead');assert.equal(await ownedProcessState(parent),'dead');
});

test('短命控制进程在采集归属期间正常退出，不误报身份核验失败',async t=>{
  const {home}=await scope(t);
  const child=spawn(process.execPath,['-e','setTimeout(()=>{},100)'],{windowsHide:true,stdio:'ignore'}),closed=once(child,'close');
  await once(child,'spawn');await rememberOwnedChild(home,child,'host-control');await closed;
  assert.equal(child.exitCode,0);assert.equal(ownedProcesses(home).records.filter(value=>value.identity.pid===child.pid).length,0);
});

test('重启前缺失 Job 的记录可退休，同代存活根或宿主不能被启动时间推断覆盖',{skip:process.platform!=='win32'},async t=>{
  const {home,identity,parent,child}=await scope(t),record=await recordSpawnedProcess(home,{role:'codex-runtime',identity,parent,windowsJob:'Global\\nxbridge-job-'+randomUUID(),proof:{kind:'spawn'}});
  const save=()=>atomicJson(path.join(processRegistryDirectory(home),record.id+'.json'),record);
  t.after(()=>forgetOwnedProcess(record));
  record.bootTime=Date.now()-uptime()*1000-86400000;save();
  assert.equal(await ownedRecordState(record),'unknown','时钟漂移不能覆盖仍活着的根代次');
  child.kill();await once(child,'close');record.native={pid:parent.pid,startedAt:parent.startedAt};save();
  assert.equal(await ownedRecordState(record),'unknown','存活的精确原生宿主仍阻止退休');
  delete record.native;record.bootTime=Date.now()-uptime()*1000;save();assert.equal(await ownedRecordState(record),'unknown','同一次启动中丢失持有器仍需保留证据');
  record.bootTime-=86400000;save();assert.equal(await ownedRecordState(record),'dead');
  await releaseOwnedProcess(record);assert.equal(ownedProcesses(home).records.length,0);
});

test('原生交接等待确认期间的转交、删除及元数据更新不能被旧快照覆盖',async t=>{
  const temp=temporaryDirectory(),home=temp.directory,identity=await processIdentity(process.pid),address=process.platform==='win32'?'\\\\.\\pipe\\nxbridge-declaration-'+randomUUID():path.join(home,'declare.sock');
  let arrived:(()=>void)|undefined,confirm:(()=>void)|undefined,connections=0;
  const server=net.createServer(socket=>{connections++;socket.on('error',()=>{});socket.once('data',()=>{confirm=()=>socket.end('{"ok":true}\n');arrived?.();});});server.listen(address);await once(server,'listening');
  t.after(async()=>{await new Promise<void>(resolve=>server.close(()=>resolve()));for(const record of ownedProcesses(home).records)forgetOwnedProcess(record);await temp.cleanup();});
  for(const change of ['转交','删除','元数据']){
    const peerId=randomUUID(),record=await recordOwnedProcess(home,{role:'host-control',identity,peerId,posixControl:address,proof:{kind:'spawn'}}),received=new Promise<void>(resolve=>{arrived=resolve;});
    const pending=declareOwnedNative(record,identity);await received;
    if(change==='转交')transferOwnedPeerToUser(home,peerId);
    else if(change==='删除')forgetOwnedProcess(record);
    else atomicJson(path.join(processRegistryDirectory(home),record.id+'.json'),{...record,configHome:path.join(home,'已更新配置')});
    confirm!();
    if(change==='元数据'){await pending;assert.equal(ownedProcesses(home).records.find(value=>value.id===record.id)?.configHome,path.join(home,'已更新配置'));const before=connections;await declareOwnedNative(record,identity);assert.equal(connections,before,'已经确认的同代宿主不依赖通道再次应答');}
    else{await assert.rejects(pending,{code:'process_launch_unverified'});const current=ownedProcesses(home).records.find(value=>value.id===record.id);if(change==='删除')assert.equal(current,undefined);else assert.equal(current?.releasedToUser,true);}
    forgetOwnedProcess(record);
  }
});

test('Linux 重启代号阻止复用的 PID/tick 获得旧权限，同一启动的时钟变化不覆盖存活身份',{skip:process.platform!=='linux'},async t=>{
  const {home,identity,parent}=await scope(t),record=await recordOwnedProcess(home,{role:'host-control',identity,parent,proof:{kind:'spawn'}});
  assert.ok(record.bootId);record.bootTime!-=86400000;atomicJson(path.join(processRegistryDirectory(home),record.id+'.json'),record);
  assert.equal(ownedRecordPredatesBoot(record),false);assert.equal(await ownedRecordState(record),'alive');
  record.bootId='previous-boot';atomicJson(path.join(processRegistryDirectory(home),record.id+'.json'),record);
  assert.equal(ownedRecordPredatesBoot(record),true);assert.equal(await ownedRecordState(record),'dead');
  await releaseOwnedProcess(record);assert.equal(await ownedProcessState(identity),'alive','旧启动记录不能停止数值身份恰好相同的新进程');
});
