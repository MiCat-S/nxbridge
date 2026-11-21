import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdirSync, readFileSync, statSync, utimesSync, writeFileSync, unlinkSync, rmdirSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { pruneDeadProcessRecords } from '../process/process-records.js';
import { pruneProcessOwnership } from '../process/process-cleanup.js';
import { processIdentity, liveProcess } from '../process/process.js';
import { forgetOwnedProcess, ownedProcesses, processRegistryRoot, recordOwnedProcess, completeOwnedContainer, ownedContainerComplete, processRegistryDirectory, prepareProcessRegistry } from '../process/owned-processes.js';
import {atomicJson} from '../shared/files.js';
import { managedMarker } from '../install/installation.js';
import { Store } from '../storage/store.js';
import { Broker, type Adapters } from '../broker/coordinator.js';
import {DEFAULT_CONFIG} from '../config/defaults.js';
import { FakeAdapter } from './support/fake-adapter.js';
import { temporaryDirectory } from './support/temporary.js';

test('周期回收删除已死及复用 PID 的旧代次记录，保留活进程、外来及损坏证据',async t=>{
  const temp=temporaryDirectory(),home=path.join(temp.directory,'bridge'),run=path.join(home,'run');mkdirSync(run,{recursive:true});
  const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore',windowsHide:true}),closed=once(child,'close');
  t.after(async()=>{if(child.exitCode===null&&child.signalCode===null)child.kill();await closed;for(const record of ownedProcesses(home).records)if(record.identity.pid===process.pid)forgetOwnedProcess(record);await temp.cleanup();});
  const store=new Store(path.join(home,'nxbridge.db'));store.close();
  await once(child,'spawn');const parent=await processIdentity(process.pid),identity=await processIdentity(child.pid!);
  await recordOwnedProcess(home,{role:'proxy',identity,parent,proof:{kind:'spawn'}});
  await recordOwnedProcess(home,{role:'broker',identity:parent,proof:{kind:'spawn'}});
  const runtime=(name:string,pid:number,generation:string,owner=managedMarker(home))=>{const file=path.join(run,`runtime-${name}.json`);atomicJson(file,{owner,pid,generation,entry:process.execPath});return file;};
  const dead=runtime('dead',identity.pid,identity.startedAt),reused=runtime('reused',parent.pid,parent.startedAt+'0'),live=runtime('live',parent.pid,parent.startedAt),foreign=runtime('foreign',identity.pid,identity.startedAt,'other-owner');
  const broken=path.join(run,'runtime-broken.json');writeFileSync(broken,'{未完成的记录','utf8');
  child.kill();await closed;
  const result=await pruneDeadProcessRecords(home);
  assert.equal(result.owned,1);assert.equal(result.runtime,2);assert.equal(result.notes.length,1);assert.match(result.notes[0]!,/runtime-broken/);
  assert.equal(existsSync(dead),false);assert.equal(existsSync(reused),false);
  for(const file of [live,foreign,broken])assert.equal(existsSync(file),true);
  assert.deepEqual(ownedProcesses(home).records.map(record=>record.identity.pid),[process.pid]);assert.equal(liveProcess(process.pid),true);
});

test('退出后保留最小归属快照但不再授权回收，周期维护只删除本安装过期快照',async t=>{
  const temp=temporaryDirectory(),home=path.join(temp.directory,'bridge'),other=path.join(temp.directory,'other'),now=Date.now(),identity=await processIdentity(process.pid);
  t.after(temp.cleanup);
  const recent=await recordOwnedProcess(home,{role:'proxy',identity,proof:{kind:'spawn',launchId:'owned-proxy'}}),old=await recordOwnedProcess(home,{role:'host-control',identity,proof:{kind:'spawn'}}),foreign=await recordOwnedProcess(other,{role:'proxy',identity,proof:{kind:'spawn'}});
  for(const record of [recent,old,foreign])forgetOwnedProcess(record,'child-exited');
  assert.deepEqual(ownedProcesses(home).records,[]);assert.equal(liveProcess(process.pid),true);
  const retired=path.join(processRegistryRoot(),'retired'),file=(id:string)=>path.join(retired,id+'.json'),snapshot=JSON.parse(readFileSync(file(recent.id),'utf8'));
  assert.deepEqual(snapshot,{version:1,id:recent.id,home:path.resolve(home),role:'proxy',pid:identity.pid,generation:identity.startedAt,launchId:'owned-proxy',retiredAt:snapshot.retiredAt,reason:'child-exited'});
  assert.ok(snapshot.retiredAt>=now);forgetOwnedProcess(recent,'owned-release');assert.equal(readFileSync(file(recent.id),'utf8'),JSON.stringify(snapshot,null,2)+'\n','重复退出回调不覆盖最初原因');
  for(const record of [old,foreign])atomicJson(file(record.id),{...JSON.parse(readFileSync(file(record.id),'utf8')),retiredAt:now-8*86400000});
  const result=await pruneDeadProcessRecords(home);assert.deepEqual(result.notes,[]);assert.equal(result.artifacts,1);
  assert.equal(existsSync(file(old.id)),false);assert.equal(existsSync(file(recent.id)),true);assert.equal(existsSync(file(foreign.id)),true);
});

test('容器凭据随归属退休迁出安装目录，旧监督快照仍能确认完成并允许立即清理目录',async t=>{
  const temp=temporaryDirectory(),home=path.join(temp.directory,'bridge'),identity=await processIdentity(process.pid);t.after(temp.cleanup);
  const record=await recordOwnedProcess(home,{role:'host-control',identity,proof:{kind:'spawn'},posixGroup:true}),captured=structuredClone(record);
  completeOwnedContainer(record);forgetOwnedProcess(record);
  assert.equal(existsSync(record.completionFile!),false);assert.equal(ownedContainerComplete(captured),true);
  const retired=path.join(processRegistryRoot(),'retired',record.id+'.json'),snapshot=JSON.parse(readFileSync(retired,'utf8'));
  assert.equal(snapshot.completionFile,path.join(processRegistryRoot(),'retired',record.id+'.done'));assert.equal(existsSync(snapshot.completionFile),true);
  completeOwnedContainer(captured);assert.equal(existsSync(record.completionFile!),false,'迟到回调不得重新创建安装目录内的凭据');
  const result=await pruneProcessOwnership(home);assert.deepEqual(result.notes,[]);assert.equal(result.removed,true);assert.equal(ownedContainerComplete(captured),true);
});

test('旧版和迟到的退休凭据按本 home 迁移，不让孤立 done 文件阻塞卸载',async t=>{
  const temp=temporaryDirectory(),home=path.join(temp.directory,'bridge'),identity=await processIdentity(process.pid);t.after(temp.cleanup);
  const record=await recordOwnedProcess(home,{role:'host-control',identity,proof:{kind:'spawn'},posixGroup:true});forgetOwnedProcess(record);
  writeFileSync(record.completionFile!,'','utf8');
  const unknown=path.join(processRegistryDirectory(home),'unknown.done');writeFileSync(unknown,'未知证据','utf8');
  const first=await pruneProcessOwnership(home);assert.equal(first.removed,false);assert.match(first.notes.join(' '),/无法核验/);assert.equal(existsSync(unknown),true);
  assert.equal(existsSync(record.completionFile!),false);assert.equal(ownedContainerComplete(record),true);
                               
  const {unlinkSync}=await import('node:fs');unlinkSync(unknown);
  const result=await pruneProcessOwnership(home);assert.deepEqual(result.notes,[]);assert.equal(result.removed,true);
});

test('只在显式 purge 删除写在归属记录之前的空孤立完成凭据',async t=>{
  const temp=temporaryDirectory(),home=path.join(temp.directory,'bridge');t.after(temp.cleanup);await prepareProcessRegistry(home);
  const orphan=path.join(processRegistryDirectory(home),randomUUID()+'.json.done');writeFileSync(orphan,'','utf8');
  const normal=await pruneProcessOwnership(home);assert.equal(normal.removed,false);assert.equal(normal.orphanReceiptsRemoved,0);assert.equal(existsSync(orphan),true);
  const purge=await pruneProcessOwnership(home,true);assert.equal(purge.removed,true);assert.deepEqual(purge.notes,[]);assert.equal(purge.orphanReceiptsRemoved,1);assert.equal(existsSync(orphan),false);
});

test('purge 保留已有归属的完成证明、损坏账本对应凭据及无法识别的文件',async t=>{
  const temp=temporaryDirectory(),home=path.join(temp.directory,'bridge'),identity=await processIdentity(process.pid);t.after(temp.cleanup);
  const owned=await recordOwnedProcess(home,{role:'host-control',identity,proof:{kind:'spawn'},posixGroup:true});completeOwnedContainer(owned);
  const directory=processRegistryDirectory(home),brokenId=randomUUID(),broken=path.join(directory,brokenId+'.json'),referenced=broken+'.done',unknown=path.join(directory,'unknown.done'),content=path.join(directory,randomUUID()+'.json.done'),subdirectory=path.join(directory,randomUUID()+'.json.done'),orphan=path.join(directory,randomUUID()+'.json.done');
  writeFileSync(broken,'{未完成的归属记录','utf8');writeFileSync(referenced,'','utf8');writeFileSync(unknown,'','utf8');writeFileSync(content,'未知文件内容','utf8');mkdirSync(subdirectory);writeFileSync(orphan,'','utf8');
  try{
    const result=await pruneProcessOwnership(home,true);assert.equal(result.removed,false);assert.equal(result.orphanReceiptsRemoved,1);assert.equal(ownedContainerComplete(owned),true);assert.equal(existsSync(path.join(processRegistryRoot(),'retired',owned.id+'.done')),true);
    for(const file of [broken,referenced,unknown,content,subdirectory])assert.equal(existsSync(file),true);assert.equal(existsSync(orphan),false);
  }finally{for(const file of [broken,referenced,unknown,content])if(existsSync(file))unlinkSync(file);rmdirSync(subdirectory);}
});

test('旧版临时完成目录已丢失时，确认退出的事实仍能保存并允许退休',async t=>{
  const temp=temporaryDirectory(),home=temp.directory,identity=await processIdentity(process.pid);t.after(temp.cleanup);
  const record=await recordOwnedProcess(home,{role:'host-control',identity,proof:{kind:'spawn'},posixGroup:true,completionFile:path.join(home,'missing-temporary','complete.done')});
  completeOwnedContainer(record);assert.equal(ownedContainerComplete(record),true);assert.equal(existsSync(path.dirname(record.completionFile!)),false);
  forgetOwnedProcess(record);assert.equal(ownedContainerComplete(record),true);assert.deepEqual((await pruneProcessOwnership(home)).notes,[]);
});

test('协调器启动维护回收失效运行时记录，关闭等待维护完成',async t=>{
  const temp=temporaryDirectory(),home=path.join(temp.directory,'bridge'),run=path.join(home,'run');mkdirSync(run,{recursive:true});
  const identity=await processIdentity(process.pid),file=path.join(run,'runtime-stale.json');atomicJson(file,{owner:managedMarker(home),pid:identity.pid,generation:identity.startedAt+'0',entry:process.execPath});
  const store=new Store(path.join(home,'nxbridge.db')),broker=new Broker(store,DEFAULT_CONFIG,{codex:new FakeAdapter(),claude:new FakeAdapter()} as unknown as Adapters,home);
  t.after(async()=>{await broker.stop();store.close();await temp.cleanup();});
  await broker.start();await broker.stop();assert.equal(existsSync(file),false);
  assert.ok(store.events().some(event=>event.type==='process.records.maintained'));
});

test('卸载本 home 的归属目录时保留仍含其他安装证据的共用根',async t=>{
  const temp=temporaryDirectory(),home=path.join(temp.directory,'bridge'),root=path.join(temp.directory,'registry'),other=path.join(root,'other-home','proof.json'),previous=process.env.NXBRIDGE_PROCESS_REGISTRY;
  process.env.NXBRIDGE_PROCESS_REGISTRY=root;mkdirSync(path.dirname(other),{recursive:true});writeFileSync(other,'其他安装的证据','utf8');
  t.after(async()=>{if(previous===undefined)delete process.env.NXBRIDGE_PROCESS_REGISTRY;else process.env.NXBRIDGE_PROCESS_REGISTRY=previous;await temp.cleanup();});
  const result=await pruneProcessOwnership(home);assert.deepEqual(result.notes,[]);assert.equal(existsSync(other),true);assert.equal(existsSync(root),true);
});

test('维护回收过期孤立子进程记录和旧日志，保留引用、活代次及最近诊断',async t=>{
  const temp=temporaryDirectory(),home=path.join(temp.directory,'bridge'),run=path.join(home,'run');mkdirSync(run,{recursive:true});
  t.after(async()=>{for(const record of ownedProcesses(home).records)if(record.identity.pid===process.pid)forgetOwnedProcess(record);await temp.cleanup();});
  const identity=await processIdentity(process.pid),active=randomUUID(),now=Date.now(),old=now-10*86400000;
  await recordOwnedProcess(home,{role:'codex-runtime',identity,proof:{kind:'spawn',launchId:active}});
  const files=new Map<string,string>();
  for(const [index,peerId] of ['orphan','referenced','live','active-phase'].entries()){
    const file=path.join(run,'claude-child-'+(index+1)+'.json');files.set(peerId,file);atomicJson(file,{version:1,peerId,updatedAt:old,phase:peerId==='active-phase'?'active':'released',...(peerId==='live'?{native:identity}:{})});
  }
  const logs=[active,...Array.from({length:5},()=>randomUUID())].map((id,index)=>{const file=path.join(run,'codex-'+id+'.log');writeFileSync(file,'x'.repeat(200)+'tail','utf8');const stamp=new Date(id===active?old:now-index*1000);utimesSync(file,stamp,stamp);return file;});
  const result=await pruneDeadProcessRecords(home,{referencedPeers:new Set(['referenced']),retention:{logMaxBytes:64}});
  assert.deepEqual(result.notes,[]);assert.equal(existsSync(files.get('orphan')!),false);
  for(const id of ['referenced','live','active-phase'])assert.equal(existsSync(files.get(id)!),true);
  for(const file of logs.slice(0,4)){assert.equal(existsSync(file),true);assert.ok(statSync(file).size<=64);assert.ok(readFileSync(file,'utf8').endsWith('tail'));}
  for(const file of logs.slice(4))assert.equal(existsSync(file),false);
});
