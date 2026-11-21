import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { writeFileSync } from 'node:fs';
import { Broker } from '../broker/coordinator.js';
import { Store } from '../storage/store.js';
import {DEFAULT_CONFIG} from '../config/defaults.js';
import { FakeAdapter } from './support/fake-adapter.js';
import { registration } from './support/registration.js';
import { temporary } from './support/temporary.js';
import {atomicJson} from '../shared/files.js';
import { profileState } from '../hosts/launch-profiles.js';

test('普通 RPC 复用启动首选缓存，配对和成员归属改变仍刷新且保留采集记录',async t=>{
  const home=temporary(t),store=new Store(':memory:'),broker=new Broker(store,DEFAULT_CONFIG,{codex:new FakeAdapter(),claude:new FakeAdapter()} as any,home);
  t.after(async()=>{await broker.stop();store.close();});
  const c=store.register(registration('claude','c')),x=store.register(registration('codex','x'));store.pair(c.id,x.id);
  await broker.dispatch('ping',{});assert.deepEqual(profileState(home).preferred,{codex:'x',claude:'c'});
  const filename=path.join(home,'launch-profiles.json'),state=profileState(home);
  writeFileSync(filename,'临时不可解析的采集文件','utf8');
  await broker.dispatch('ping',{});                          
  atomicJson(filename,{...state,observations:[]});
  store.updatePeer(c.id,{owner:'nxbridge'});await broker.dispatch('ping',{});assert.deepEqual(profileState(home).preferred,{codex:'x'});
  const c2=store.register(registration('claude','c2')),x2=store.register(registration('codex','x2'));store.pair(c2.id,x2.id);
  await (broker as any).syncLaunchPreferences();assert.deepEqual(profileState(home).preferred,{});assert.deepEqual(profileState(home).observations,[]);
  store.unpair(c2.id);store.updatePeer(x.id,{sessionId:'next'});await (broker as any).syncLaunchPreferences();assert.deepEqual(profileState(home).preferred,{codex:'next'});
});

for(const switched of [false,true])test('启动环境异步核验'+(switched?'不能把旧元数据写入新上下文':'只合并元数据，不覆盖已完成的原生健康状态'),async t=>{
  const home=temporary(t),store=new Store(':memory:'),broker=new Broker(store,{...DEFAULT_CONFIG,implicit:'never'},{codex:new FakeAdapter(),claude:new FakeAdapter()} as any,home);
  t.after(async()=>{await broker.stop();store.close();});
  const health={turnId:'turn-a',lastProgressAt:100,lastEventAt:100,state:'running' as const,tools:[]};
  const input=registration('claude','session-a',{cwd:home,endpoint:{mode:'claude-inbox',address:'inbox',epoch:'native-window',pid:process.pid,procStart:'native-generation',configHome:home,nativeHealth:health}}),peer=store.register(input);
  let entered!:()=>void,finish!:(value:any)=>void;
  const started=new Promise<void>(resolve=>entered=resolve),result=new Promise<any>(resolve=>finish=resolve);
  t.mock.method(broker as any,'captureLaunch',()=>{entered();return result;});
  const pending=broker.dispatch('launch.capture',{host:'claude',sessionId:peer.sessionId,nativePid:process.pid,nativeGeneration:'native-generation',sourcePid:process.pid,sourceGeneration:'source-generation',env:{}});await started;
  const latest={turnId:switched?'turn-b':'turn-a',lastProgressAt:200,lastEventAt:200,observedProgressAt:200,state:'ready' as const,completion:'completed',tools:[]};
  if(switched)store.register({...input,sessionId:'session-b',endpoint:{...input.endpoint,nativeHealth:latest}});
  else store.saveEndpoint({...store.endpoint(peer.id)!,nativeHealth:latest,modRevision:'1'.repeat(16)});
  finish({owned:false,configHome:path.join(home,'captured'),profile:{id:'profile-a',host:'claude',exe:process.execPath,version:'test',configHome:home,cwd:home,env:{},sourceSession:'session-a',sourcePid:process.pid,sourceGeneration:'native-generation',capturedAt:300,dropped:[]}});await pending;
  const current=store.endpoint(peer.id)!;assert.deepEqual(current.nativeHealth,latest);
  assert.equal(current.configHome,switched?home:path.join(home,'captured'));assert.equal(current.launchProfileId,switched?undefined:'profile-a');
  if(!switched)assert.equal(current.modRevision,'1'.repeat(16));
});

test('同一原生上下文的晚登记保留较新轮次证据，真实换对话仍重置',t=>{
  const store=new Store(':memory:');t.after(()=>store.close());const home=temporary(t);
  const health={turnId:'turn-a',lastProgressAt:200,lastEventAt:200,observedProgressAt:200,state:'ready' as const,completion:'completed',tools:[]};
  const input=registration('claude','session-a',{cwd:home,endpoint:{mode:'claude-inbox',address:'inbox',epoch:'native-window',pid:process.pid,procStart:'native-generation',configHome:home,nativeHealth:health}}),peer=store.register(input);
  store.saveEndpoint({...store.endpoint(peer.id)!,bindingEpoch:undefined});
  const stale={turnId:'turn-a',lastProgressAt:100,lastEventAt:100,state:'running' as const,tools:[]};
  store.register({...input,endpoint:{...input.endpoint,nativeHealth:stale}});assert.deepEqual(store.endpoint(peer.id)!.nativeHealth,health);
  store.register({...input,sessionId:'session-b',endpoint:{...input.endpoint,nativeHealth:stale}});assert.deepEqual(store.endpoint(peer.id)!.nativeHealth,stale);assert.equal(store.peer(peer.id).sessionId,'session-b');
});
