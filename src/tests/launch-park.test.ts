import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {writeFileSync} from 'node:fs';
import {launchInputFingerprint,parkLaunchFailure} from '../hosts/launch-park.js';
import {saveUserProfile,type LaunchProfile} from '../hosts/launch-profiles.js';
import {BridgeError} from '../shared/errors.js';
import {DEFAULT_CONFIG} from '../config/defaults.js';
import {fixture, lifecycle} from './support/broker-fixture.js';
import { temporary } from './support/temporary.js';
import {writeHosting,hostingRecord} from '../broker/recovery/session-hosting.js';

test('暂停只随原会话来源、配置和入口改变；其他窗口新记录不能重新启动旧会话',t=>{
  const home=temporary(t),exe=path.join(home,'codex'),peer={host:'codex' as const,sessionId:'original',cwd:home};writeFileSync(exe,'原入口','utf8');
  const record:LaunchProfile={id:'original',host:'codex',exe,version:'0.167.1',configHome:home,cwd:home,env:{},sourceSession:'original',sourcePid:1,sourceGeneration:'one',capturedAt:1,dropped:[]};saveUserProfile(home,record);
  const before=launchInputFingerprint(home,DEFAULT_CONFIG,peer,home,{executable:exe});
  saveUserProfile(home,{...record,id:'other',exe:path.join(home,'other'),sourceSession:'other',capturedAt:2});
  assert.equal(launchInputFingerprint(home,DEFAULT_CONFIG,peer,home,{executable:exe}),before);
  writeFileSync(exe,'已更新的原入口','utf8');assert.notEqual(launchInputFingerprint(home,DEFAULT_CONFIG,peer,home,{executable:exe}),before);
  assert.equal(parkLaunchFailure(new BridgeError('holder_unknown','共享持有者尚不明确'),home,DEFAULT_CONFIG,peer,home),undefined);
});

test('broker 保持确定失败暂停，相关配置改变后重查而不丢失配对或消息',async t=>{
  const f=fixture(t),home=f.broker.home,pair=f.store.pair(f.c.id,f.x.id),peer=f.store.updatePeer(f.x.id,{owner:'nxbridge',state:'offline'}),message=f.store.accept(pair,f.c,'保留原消息','original-message');
  const broker=f.broker as any;
  const launchPark=parkLaunchFailure(new BridgeError('profile_version_unsupported','原入口版本较旧'),home,f.broker.config,peer,home)!;
  writeHosting(f.store,peer,{phase:'adopting',verified:false,nextAt:Number.MAX_SAFE_INTEGER,launchPark},home);
  let adopted=0;broker.transfers.adopt=async()=>{adopted++;return{};};
  assert.equal(await lifecycle(broker).recover(peer),false);assert.equal(await lifecycle(broker).recover(peer),false);assert.equal(adopted,0);
  const exe=path.join(home,'codex');writeFileSync(exe,'更新后的入口','utf8');f.broker.config.codexBinary=exe;lifecycle(broker).launchInputsChanged();
  assert.equal(await lifecycle(broker).recover(peer),true);assert.equal(adopted,1);assert.equal(hostingRecord(f.store,peer)?.launchPark,undefined);
  assert.equal(f.store.pairFor(peer.id)?.id,pair.id);assert.equal(f.store.message(message.id).state,'accepted');
});

test('暂停重查保留创建时的 home 与启动证明，不受后续不同写法影响',async t=>{
  t.mock.timers.enable({apis:['Date'],now:100000});let monotonic=1000;t.mock.method(performance,'now',()=>monotonic);
  const f=fixture(t),home=f.broker.home,peer=f.store.updatePeer(f.x.id,{owner:'nxbridge',state:'offline'});f.store.pair(f.c.id,peer.id);
  const broker=f.broker as any;
  const proof={profileId:'original'},launchPark=parkLaunchFailure(new BridgeError('profile_version_unsupported','较旧入口'),home,f.broker.config,peer,home,proof)!;
  writeHosting(f.store,peer,{phase:'adopting',verified:false,nextAt:Number.MAX_SAFE_INTEGER,launchPark},home+path.sep);
  f.store.setSetting('managedLaunchProof:'+peer.id,{profileId:'later'});
  let attempts=0;broker.transfers.adopt=async()=>{attempts++;return{};};
  assert.equal(await lifecycle(broker).recover(peer),false);assert.equal(attempts,0);assert.equal(launchPark.configHome,home);assert.deepEqual(launchPark.proof,proof);
  const exe=path.join(home,'codex');writeFileSync(exe,'更新后的入口','utf8');f.broker.config.codexBinary=exe;
  t.mock.timers.tick(60000);assert.equal(await lifecycle(broker).recover(peer),false,'墙钟跳变不能提前解除重查节流');assert.equal(attempts,0);
  monotonic+=30001;assert.equal(await lifecycle(broker).recover(peer),true);assert.equal(attempts,1);
});

test('Claude 界面或认证统计更新不解除暂停，原生信任变更会重新核验',t=>{
  const home=temporary(t),peer={host:'claude' as const,sessionId:'original',cwd:home},file=path.join(home,'.claude.json');
  const config={hasCompletedOnboarding:true,projects:{[home.replaceAll('\\','/')]:{hasTrustDialogAccepted:false}},numStartups:1};writeFileSync(file,JSON.stringify(config),'utf8');
  const before=launchInputFingerprint(home,DEFAULT_CONFIG,peer,home);
  writeFileSync(file,JSON.stringify({...config,numStartups:52,oauthAccount:{emailAddress:'test@example.invalid'}}),'utf8');assert.equal(launchInputFingerprint(home,DEFAULT_CONFIG,peer,home),before);
  config.projects[home.replaceAll('\\','/')]!.hasTrustDialogAccepted=true;writeFileSync(file,JSON.stringify(config),'utf8');assert.notEqual(launchInputFingerprint(home,DEFAULT_CONFIG,peer,home),before);
});

test('无关配置热更新保留正在等待的恢复退避',async t=>{
  t.mock.timers.enable({apis:['Date'],now:100000});
  const f=fixture(t),broker=f.broker as any,coordinator=lifecycle(f.broker),peer=f.store.updatePeer(f.x.id,{state:'offline'});let attempts=0;
  f.store.pair(f.c.id,peer.id);t.mock.method(f.codex,'connect',async()=>{attempts++;throw Error('原观察通道暂不可达');});
  assert.equal(await coordinator.recover(peer),false);assert.equal(attempts,1);
  coordinator.delayRetry(peer.id,60000);broker.stopped=true;
  const state=coordinator as any,retryAt=state.retryAt.get(peer.id),recoveryAt=state.recoveryAt.get(peer.id);state.parkChecks.set(peer.id,789);
  const invalidate=t.mock.method(coordinator,'launchInputsChanged');broker.applyConfiguration();
  assert.equal(state.retryAt.get(peer.id),retryAt);assert.equal(state.recoveryAt.get(peer.id),recoveryAt);assert.equal(state.parkChecks.size,0);
  assert.equal(coordinator.retryPending(peer.id),true);assert.equal(invalidate.mock.callCount(),1);
  assert.equal(await coordinator.recover(peer),false);assert.equal(attempts,1,'配置热更新不能提前解除独立恢复退避');
  t.mock.timers.tick(1001);assert.equal(await coordinator.recover(peer),false);assert.equal(attempts,2);
});
