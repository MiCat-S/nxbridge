import {lifecycle} from './support/broker-fixture.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdirSync } from 'node:fs';
import { temporaryDirectory, temporary } from './support/temporary.js';
import { registration } from './support/registration.js';
import { FakeAdapter } from './support/fake-adapter.js';
import { ClaudeAdapter } from '../hosts/claude/adapter.js';
import { Broker } from '../broker/coordinator.js';
import {DEFAULT_CONFIG} from '../config/defaults.js';
import { Store } from '../storage/store.js';
import { beginNativeLaunch, bindNativeLaunch, captureNativeProcess, failNativeLaunch, forgetNativeOwnership, nativeLaunchHandle, nativeOwnership, saveNativeOwnership } from '../process/owned-native.js';

test('后台意图登记后权限关闭或提交守卫拒绝均立即结算，不留下每分钟重试的无身份意图',async t=>{
  const home=temporary(t),store=new Store(':memory:'),peer=store.placeholder('claude',home),adapter=new ClaudeAdapter(DEFAULT_CONFIG,home);t.after(()=>{adapter.close();store.close();});
  const launch={host:'claude',executable:{command:process.execPath,prefix:[]},configHome:home,cwd:home,env:{...process.env},method:'pin',notes:[],environment:{source:'test',dropped:[],replaced:[],inheritedLoopbackProxy:[]}};
  let intent=await beginNativeLaunch(home,peer,home);adapter.setEnabled(peer,undefined,false);
  await assert.rejects((adapter as any).submitLaunch(peer,intent,launch,[]),{code:'member_disabled'});assert.equal(nativeOwnership(home,peer.id)?.phase,'failed');
  adapter.setEnabled(peer,undefined,true);intent=await beginNativeLaunch(home,peer,home);
  await assert.rejects((adapter as any).submitLaunch(peer,intent,launch,[],()=>{throw new Error('提交前已解除配对');}),/提交前已解除配对/);assert.equal(nativeOwnership(home,peer.id)?.phase,'failed');
});

test('原生启动回执先于 PID 时持久绑定；前台、错误 handle 和陈旧回执不能认领',{timeout:30000},async t=>{
  const temp=temporaryDirectory(),home=path.join(temp.directory,'bridge'),previous=process.env.NXBRIDGE_PROCESS_REGISTRY;
  mkdirSync(home);process.env.NXBRIDGE_PROCESS_REGISTRY=path.join(temp.directory,'evidence');
  const store=new Store(path.join(home,'nxbridge.db')),peer=store.placeholder('claude',temp.directory);
  t.after(async()=>{
    try{const binding=nativeOwnership(home,peer.id);if(binding)forgetNativeOwnership(binding);}
    finally{
      store.close();
                                      
      if(previous===undefined)delete process.env.NXBRIDGE_PROCESS_REGISTRY;else process.env.NXBRIDGE_PROCESS_REGISTRY=previous;
      await temp.cleanup();
    }
  });
  const intent=await beginNativeLaunch(home,peer,path.join(temp.directory,'claude'));
  assert.equal(nativeOwnership(home,peer.id)?.phase,'intent');
  assert.equal(failNativeLaunch(intent,Object.assign(new Error('超时'),{exitCode:null,signal:'SIGTERM'})),false);
  assert.equal(failNativeLaunch(intent,Object.assign(new Error('非零但有回执'),{exitCode:1,cause:{stdout:'backgrounded · abc00001 · 启动'}})),false);
  assert.equal(nativeOwnership(home,peer.id)?.handle,'abc00001','非零退出中的可核验回执仍要保存');
  assert.equal(failNativeLaunch(intent,Object.assign(new Error('无名称的恢复回执'),{exitCode:1,cause:{stdout:'backgrounded · abc00001 (idle — send a prompt to start)'}})),false);
  assert.equal(failNativeLaunch(intent,Object.assign(new Error('明确拒绝'),{exitCode:1,cause:{stdout:''}})),true);assert.equal(nativeOwnership(home,peer.id)?.phase,'failed');saveNativeOwnership(intent);
  assert.throws(()=>nativeLaunchHandle('后台命令已返回，但没有可核验 handle'),{code:'claude_launch_unverified'});
  assert.equal(nativeLaunchHandle('backgrounded · abc00001 (idle — send a prompt to start)'),'abc00001');
  assert.throws(()=>nativeLaunchHandle('backgrounded · abc00001oops (idle)'),{code:'claude_launch_unverified'});
  const launched={...intent,handle:nativeLaunchHandle('backgrounded · abc00001 · 临时后台 (idle)')};saveNativeOwnership(launched);
  const agent={id:'abc00001',sessionId:'abc00001-0000-4000-8000-000000000001',kind:'background'};
  await assert.rejects(bindNativeLaunch(launched,{...agent,kind:'foreground'}),{code:'claude_launch_unverified'});
  await assert.rejects(bindNativeLaunch(launched,{...agent,id:'另一个 handle'}),{code:'claude_launch_unverified'});
  const bound=await bindNativeLaunch(launched,agent);assert.equal(bound.native,undefined);assert.equal(nativeOwnership(home,peer.id)?.sessionId,agent.sessionId);
  const codex=store.register(registration('codex','source')),pair=store.pair(peer.id,codex.id),adapter=new ClaudeAdapter(DEFAULT_CONFIG,home);
  store.setSetting('claudeAutoFallback:'+peer.id,{phase:'binding',pair_id:pair.id,old_session_id:'original'});
  const original=store.updatePeer(peer.id,{sessionId:'original'}),broker=new Broker(store,DEFAULT_CONFIG,{claude:adapter,codex:new FakeAdapter()} as any,home);
  await assert.rejects(lifecycle(broker).prepare(original),{code:'claude_start_pending'});
  assert.equal(nativeOwnership(home,peer.id)?.id,bound.id,'普通恢复不能覆盖副本启动记录');
  await broker.stop();
  store.unpair(pair.id);adapter.close();
  await assert.rejects(captureNativeProcess(bound,{...agent,kind:'foreground'}),{code:'claude_launch_unverified'});
  const transferred={...bound,releasedToUser:true};saveNativeOwnership(transferred);
  await assert.rejects(captureNativeProcess(transferred,agent),{code:'claude_launch_unverified'});
});
