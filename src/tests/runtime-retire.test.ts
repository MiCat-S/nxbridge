import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture, lifecycle} from './support/broker-fixture.js';
import {BridgeError} from '../shared/errors.js';
import {unknownContainerFixture} from './unknown-container-fixture.js';
import {forgetOwnedProcess,ownedProcesses,processRegistryDirectory} from '../process/owned-processes.js';
import {saveManagedRuntime,runtimeFor} from '../hosts/managed-runtimes.js';
import {managedMarker} from '../install/installation.js';
import {existsSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import path from 'node:path';
import {atomicJson} from '../shared/files.js';

test('无可推进身份的原生启动记录立即停止自动重试，显式回收仍可重新核验',async t=>{
  const f=fixture(t);f.store.updatePeer(f.c.id,{owner:'nxbridge'});
  (f.claude as any).release=async()=>{throw new BridgeError('claude_release_unresolved','仅剩未结算记录');};
  await lifecycle(f.broker).releaseOwned([f.c.id]);
  const pending=f.store.setting<any>('processRetirements')[f.c.id];assert.equal(pending.attempts,1);assert.equal(pending.nextAt,Number.MAX_SAFE_INTEGER);
  await f.broker.pump();assert.equal(f.store.setting<any>('processRetirements')[f.c.id].attempts,1);
  (f.claude as any).release=async()=>{};assert.equal((await f.broker.dispatch('runtime.retire',{peer_id:f.c.id})as any).released,true);
});

test('残留后台区分历史失败与当前归属诊断，活动配对及用户窗口拒绝回收',async t=>{
  const f=fixture(t),pair=f.store.pair(f.c.id,f.x.id);
  await assert.rejects(f.broker.dispatch('runtime.retire',{peer_id:f.x.id}),{code:'runtime_in_use'});
  f.store.updatePeer(f.x.id,{owner:'nxbridge'});await assert.rejects(f.broker.dispatch('runtime.retire',{peer_id:f.x.id}),{code:'runtime_in_use'});
  f.store.unpair(pair.id);(f.codex as any).releaseRuntime=async()=> 'socket 对端独占性无法核验';
  for(let index=0;index<3;index++)await lifecycle(f.broker).releaseOwned([f.x.id]);
  const status:any=await f.broker.dispatch('status',{}),retired=status.capabilities.retirements.find((value:any)=>value.peerId===f.x.id);
  assert.equal(retired.exhausted,true);assert.equal(retired.nextAt,Number.MAX_SAFE_INTEGER);assert.match(retired.lastFailure,/socket 对端独占性无法核验/);assert.equal(retired.action,'nxbridge retire --member '+f.x.id);
  assert.equal(retired.state,'record-only');assert.deepEqual(retired.processes,[]);assert.match(retired.currentReason,/未结算记录/);assert.equal(retired.error,undefined);
  (f.codex as any).releaseRuntime=async()=>undefined;
  assert.equal((await f.broker.dispatch('runtime.retire',{peer_id:f.x.id}) as any).released,true);assert.equal(f.store.setting<any>('processRetirements')[f.x.id],undefined);
});

test('显式 retire 可以撤销未知容器，自动回收继续保留且不报告整组退出',{skip:process.platform!=='win32'},async t=>{
  const f=fixture(t),home=(f.broker as any).home as string;f.store.updatePeer(f.x.id,{owner:'nxbridge'});
  const record=await unknownContainerFixture(home,f.x.id);saveManagedRuntime(home,{id:record.proof.launchId!,peerId:f.x.id,owner:managedMarker(home),kind:'owned',state:'starting',createdAt:Date.now(),endpoint:f.store.endpoint(f.x.id)!.address});
  const sibling={...record,id:randomUUID(),role:'host-control' as const,windowsJob:undefined,completionFile:undefined};atomicJson(path.join(processRegistryDirectory(home),sibling.id+'.json'),sibling);
  try{
    (f.codex as any).releaseRuntime=async()=> '容器归属未知';
    await lifecycle(f.broker).releaseOwned([f.x.id]);assert.equal(ownedProcesses(home).records.length,2);assert.ok(runtimeFor(home,{peerId:f.x.id}));
    const result=await f.broker.dispatch('runtime.retire',{peer_id:f.x.id}) as any;
    assert.equal(result.released,true);assert.equal(result.unconfirmedContainersRetired,true);assert.match(result.notes.join(' '),/未确认.*全部退出/);assert.equal(f.store.setting<any>('processRetirements')[f.x.id],undefined);
    assert.deepEqual(ownedProcesses(home).records,[]);assert.equal(runtimeFor(home,{peerId:f.x.id}),undefined);assert.equal(existsSync(record.completionFile!),false);
  }finally{forgetOwnedProcess(record);forgetOwnedProcess(sibling);}
});

test('显式 retire 不能删除已有但尚无法核验的原生 PID 预约',{skip:process.platform!=='win32'},async t=>{
  const f=fixture(t),home=(f.broker as any).home as string;f.store.updatePeer(f.x.id,{owner:'nxbridge'});
  const record=await unknownContainerFixture(home,f.x.id);saveManagedRuntime(home,{id:record.proof.launchId!,peerId:f.x.id,owner:managedMarker(home),kind:'owned',state:'starting',createdAt:Date.now(),endpoint:f.store.endpoint(f.x.id)!.address,pid:process.pid,procStart:''});
  try{
    (f.codex as any).releaseRuntime=async()=> '原生代次尚无法核验';
    const result=await f.broker.dispatch('runtime.retire',{peer_id:f.x.id}) as any;
    assert.equal(result.released,false);assert.equal(result.unconfirmedContainersRetired,undefined);assert.ok(runtimeFor(home,{peerId:f.x.id}));assert.equal(ownedProcesses(home).records.length,1);assert.ok(f.store.setting<any>('processRetirements')[f.x.id]);
  }finally{forgetOwnedProcess(record);}
});
