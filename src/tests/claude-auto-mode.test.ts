import {lifecycle} from './support/broker-fixture.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Store } from '../storage/store.js';
import { Broker, type Adapters } from '../broker/coordinator.js';
import {DEFAULT_CONFIG} from '../config/defaults.js';
import {type RegisterInput} from '../types.js';
import {ensureHome} from '../ipc/home.js';
import { claudeAutoKey, claudeAutoStatus, claudeAutoHolds, observeClaudeAuto, type ClaudeAutoFallback } from '../hosts/claude/claude-auto-mode.js';
import {BridgeError} from '../shared/errors.js';
import { nativeOwnership, saveNativeOwnership, type NativeOwnership } from '../process/owned-native.js';
import { FakeAdapter } from './support/fake-adapter.js';
import { registration } from './support/registration.js';
import { temporary } from './support/temporary.js';
import type { TestContext } from 'node:test';

async function setup(t:TestContext){
  const home=temporary(t);await ensureHome(home);const store=new Store(':memory:'),claude=new FakeAdapter(),codex=new FakeAdapter();
  const broker=new Broker(store,DEFAULT_CONFIG,{claude,codex} as unknown as Adapters,home);
  t.after(async()=>{await broker.stop();store.close();});
  const source=registration('claude',randomUUID(),{state:'ready'});Object.assign(source.endpoint,{configHome:path.join(home,'claude'),nativePermission:{mode:'auto',permission:'prompting',observedAt:1},nativeAutoMode:{observedAt:2,unavailable:{at:2,tool:'Agent'}},nativeBackground:{tasks:0,crons:0,observedAt:3},nativeHealth:{turnId:'done',state:'ready',tools:[],lastEventAt:3,lastProgressAt:3}});
  const c=store.register(source),x=store.register(registration('codex','sender'));store.updatePeer(c.id,{owner:'nxbridge'});const pair=store.pair(c.id,x.id);
  const proof:NativeOwnership={version:1,id:randomUUID(),home,peerId:c.id,configHome:source.endpoint.configHome!,phase:'bound',createdAt:1,handle:'11111111',sessionId:c.sessionId!,native:{pid:process.pid,startedAt:'test'}};saveNativeOwnership(proof);
  let launches=0,stops=0;
  const target: RegisterInput={...registration('claude',randomUUID(),{state:'ready'}),contextReason:'fork',endpoint:{...source.endpoint,epoch:'new-generation',pid:process.pid+1,procStart:'new-generation',nativePermission:{mode:'default',permission:'prompting',observedAt:4},nativeAutoMode:{observedAt:4}}};
  (claude as any).release=async(_peer:unknown,guard:Function)=>{await guard({status:'idle'});stops++;};
  (claude as any).createManualCopy=async(_peer:unknown,_source:unknown,guard:Function)=>{await guard();launches++;saveNativeOwnership({...proof,id:randomUUID(),sessionId:target.sessionId,handle:'22222222',native:{pid:target.endpoint.pid!,startedAt:target.endpoint.procStart!}});store.register(target);return target.sessionId;};
  (claude as any).manualCopyRegistration=async()=>target;
  const sweep=()=> lifecycle(broker).sweepClaudeAuto() as Promise<void>;
  return{home,store,broker,claude,c:store.peer(c.id),x,pair,source,proof,target,sweep,counts:()=>({launches,stops})};
}

test('自动模式故障只处理自有会话；空闲、后台任务和未结算投递都必须满足',async t=>{
  const f=await setup(t),{store,c,sweep}=f;
  store.updatePeer(c.id,{owner:'user'});await sweep();assert.equal(claudeAutoStatus(store,store.peer(c.id)),undefined);
  store.updatePeer(c.id,{owner:'nxbridge',state:'busy'});await sweep();assert.equal(claudeAutoStatus(store,c)?.phase,'pending');
  store.updatePeer(c.id,{state:'ready'});
  for(const background of [{tasks:1,crons:0},{tasks:0,crons:1},{tasks:0}]){store.saveEndpoint({...store.endpoint(c.id)!,nativeBackground:{...background,observedAt:4}});await sweep();assert.deepEqual(f.counts(),{launches:0,stops:0});}
  store.saveEndpoint({...store.endpoint(c.id)!,nativeBackground:{tasks:0,crons:0,observedAt:5}});
  const sent=f.broker.send({actor:{host:'codex',sessionId:'sender',callId:'unsettled'},message:'结果不明时不重复投递'},false);store.claim(sent.message_id);store.transition(sent.message_id,'unknown');
  await sweep();assert.deepEqual(f.counts(),{launches:0,stops:0});assert.equal(store.message(sent.message_id).attempts,1);
});

test('普通恢复异步等待期间开始权限恢复时，提交守卫阻止再次启动原会话',async t=>{
  const f=await setup(t),{store,c,broker}=f;observeClaudeAuto(store,c,store.endpoint(c.id)!);
  const value=store.setting<ClaudeAutoFallback>(claudeAutoKey(c.id))!;
  store.setSetting(claudeAutoKey(c.id),{...value,phase:'resolved'});
  let submitted=false;
  (f.claude as any).wake=async(_peer:unknown,_endpoint:unknown,_signal:unknown,beforeLaunch:()=>Promise<void>)=>{
    store.setSetting(claudeAutoKey(c.id),{...value,phase:'binding'});
    await beforeLaunch();submitted=true;
  };
  await assert.rejects(lifecycle(broker).prepare(c),{code:'claude_start_pending'});
  assert.equal(submitted,false);assert.equal(nativeOwnership(f.home,c.id)?.id,f.proof.id);
});

test('原生副本接续原成员和配对，保留消息回执、旧租约与新旧会话状态；重载不再次复制',async t=>{
  const f=await setup(t),{store,c,sweep}=f;
  const sent=f.broker.send({actor:{host:'codex',sessionId:'sender',callId:'held'},message:'新消息等接续完成'},false);
  const oldBinding=store.bindings.current(c.id);await sweep();
  assert.deepEqual(f.counts(),{launches:1,stops:1});assert.equal(store.peer(c.id).sessionId,f.target.sessionId);assert.equal(store.pairFor(c.id)?.id,f.pair.id);
  assert.equal(store.peer(c.id).owner,'nxbridge');assert.equal(store.peers().filter(p=>p.sessionId===f.target.sessionId).length,1);
  assert.equal(store.message(sent.message_id).state,'accepted');assert.equal(store.message(sent.message_id).attempts,0);
  if(oldBinding)assert.equal(store.bindings.get(oldBinding.key)?.active,false);
  const status=claudeAutoStatus(store,store.peer(c.id));assert.equal(status?.phase,'ready');assert.equal(status.old_session_id,c.sessionId);assert.equal(status.session_id,f.target.sessionId);
  await sweep();await sweep();assert.deepEqual(f.counts(),{launches:1,stops:1});assert.equal(nativeOwnership(f.home,c.id)?.sessionId,f.target.sessionId);
});

test('停止前宿主再次忙碌时保留原进程；暂停和关闭成员不启动替代后台',async t=>{
  const f=await setup(t);(f.claude as any).release=async(_peer:unknown,guard:Function)=>guard({status:'busy'});
  await f.sweep();assert.equal(claudeAutoStatus(f.store,f.c)?.phase,'pending');assert.equal(nativeOwnership(f.home,f.c.id)?.id,f.proof.id);
  f.store.setPaused(true,f.pair.id);await f.sweep();assert.deepEqual(f.counts(),{launches:0,stops:0});
});

test('崩溃后的已知 handle 只接续已启动副本，未知启动结果只保留并通知',async t=>{
  const f=await setup(t),{store,c}=f;observeClaudeAuto(store,c,store.endpoint(c.id)!);
  const value=store.setting<ClaudeAutoFallback>(claudeAutoKey(c.id))!;
  store.setSetting(claudeAutoKey(c.id),{...value,phase:'launching',source:f.proof});
  saveNativeOwnership({...f.proof,id:randomUUID(),phase:'intent',handle:undefined,native:undefined});
  await f.sweep();assert.equal(claudeAutoStatus(store,c)?.phase,'unknown');assert.deepEqual(f.counts(),{launches:0,stops:0});
  await f.sweep();assert.deepEqual(f.counts(),{launches:0,stops:0});
  store.setSetting(claudeAutoKey(c.id),{...value,phase:'launching',source:f.proof});
  saveNativeOwnership({...f.proof,id:randomUUID(),sessionId:f.target.sessionId,handle:'22222222'});store.register(f.target);
  await f.sweep();assert.equal(claudeAutoStatus(store,store.peer(c.id))?.phase,'ready');assert.deepEqual(f.counts(),{launches:0,stops:0});
});

test('显式切换权限结束故障处理；换过代次的后台不使用旧观察执行停止',async t=>{
  const f=await setup(t);observeClaudeAuto(f.store,f.c,f.store.endpoint(f.c.id)!);
  const endpoint=f.store.endpoint(f.c.id)!;
  f.store.saveEndpoint({...endpoint,nativePermission:{mode:'default',permission:'prompting',observedAt:6}});
  await f.sweep();assert.equal(claudeAutoStatus(f.store,f.c)?.phase,'resolved');assert.deepEqual(f.counts(),{launches:0,stops:0});
  const g=await setup(t);observeClaudeAuto(g.store,g.c,g.store.endpoint(g.c.id)!);
  g.store.deactivate(g.c.id);g.store.saveEndpoint({...g.store.endpoints(g.c.id)[0]!,epoch:'another-process',active:true});
  await g.sweep();assert.equal(claudeAutoStatus(g.store,g.c)?.phase,'blocked');assert.deepEqual(g.counts(),{launches:0,stops:0});
});

test('空闲副本可凭原生启动证明接续；实际模式矛盾时保留记录且不重复启动',async t=>{
  const f=await setup(t);delete f.target.endpoint.nativePermission;
  await f.sweep();assert.equal(claudeAutoStatus(f.store,f.store.peer(f.c.id))?.phase,'ready');assert.equal(f.store.peer(f.c.id).sessionId,f.target.sessionId);assert.deepEqual(f.counts(),{launches:1,stops:1});
  f.target.endpoint.nativePermission={mode:'bypassPermissions',permission:'bypass',observedAt:7};
  f.store.saveEndpoint({...f.store.endpoint(f.c.id)!,nativePermission:f.target.endpoint.nativePermission});
  await f.sweep();assert.equal(claudeAutoStatus(f.store,f.store.peer(f.c.id))?.phase,'unknown');await f.sweep();assert.deepEqual(f.counts(),{launches:1,stops:1});
});

test('等待期间关闭成员以及停止后关闭配对都不会创建替代后台',async t=>{
  const f=await setup(t);f.store.updatePeer(f.c.id,{enabled:false});await f.sweep();assert.deepEqual(f.counts(),{launches:0,stops:0});
  f.store.updatePeer(f.c.id,{enabled:true});
  (f.claude as any).release=async(_peer:unknown,guard:Function)=>{await guard({status:'idle'});f.store.setPaused(true,f.pair.id);};
  await f.sweep();assert.equal(claudeAutoStatus(f.store,f.c)?.phase,'unknown');assert.deepEqual(f.counts(),{launches:0,stops:0});
});

test('保留有定时任务的原会话；旧后台计数和过期等待都不会形成永久投递阻塞',async t=>{
  const f=await setup(t);f.store.saveEndpoint({...f.store.endpoint(f.c.id)!,nativeBackground:{tasks:0,crons:1,observedAt:4}});
  await f.sweep();assert.equal(claudeAutoStatus(f.store,f.c)?.phase,'blocked');assert.equal(claudeAutoHolds(f.store,f.c),false);assert.deepEqual(f.counts(),{launches:0,stops:0});
  const g=await setup(t);g.store.saveEndpoint({...g.store.endpoint(g.c.id)!,nativeBackground:{tasks:0,crons:0,observedAt:1}});
  await g.sweep();assert.equal(claudeAutoStatus(g.store,g.c)?.phase,'pending');assert.deepEqual(g.counts(),{launches:0,stops:0});
  g.store.setSetting(claudeAutoKey(g.c.id),{...g.store.setting<ClaudeAutoFallback>(claudeAutoKey(g.c.id))!,idle_at:Date.now()-120001});
  await g.sweep();assert.equal(claudeAutoStatus(g.store,g.c)?.phase,'blocked');assert.equal(claudeAutoHolds(g.store,g.c),false);
});

test('副本身份查询瞬时失败继续核验；超时后不重启旧会话，显式打开可接续已证明的副本',async t=>{
  const f=await setup(t);let query=0;
  (f.claude as any).manualCopyRegistration=async()=>{const at=query++;if(at===0)throw new BridgeError('control_timeout','原生清单查询超时');return at===1?undefined:f.target;};
  await f.sweep();assert.equal(claudeAutoStatus(f.store,f.c)?.phase,'binding');assert.deepEqual(f.counts(),{launches:1,stops:1});
  f.store.setSetting(claudeAutoKey(f.c.id),{...f.store.setting<ClaudeAutoFallback>(claudeAutoKey(f.c.id))!,phase_at:Date.now()-60001});
  await f.sweep();assert.equal(claudeAutoStatus(f.store,f.c)?.phase,'unknown');
  await lifecycle(f.broker).observeManagedExits();assert.deepEqual(f.claude.woken,[]);
  (f.claude as any).handle=async()=> '22222222';
  const opened=await f.broker.dispatch('open',{host:'claude'}) as any;
  assert.equal(opened.peer.id,f.c.id);assert.equal(opened.peer.sessionId,f.target.sessionId);assert.equal(f.store.pairFor(f.c.id)?.id,f.pair.id);assert.equal(claudeAutoHolds(f.store,f.store.peer(f.c.id)),false);assert.deepEqual(f.counts(),{launches:1,stops:1});
});

test('首次核验手动模式后用户可切换模式；超时重载先检查已运行副本',async t=>{
  const f=await setup(t);await f.sweep();
  f.store.saveEndpoint({...f.store.endpoint(f.c.id)!,nativePermission:{mode:'acceptEdits',permission:'prompting',observedAt:8}});
  await f.sweep();assert.equal(claudeAutoStatus(f.store,f.store.peer(f.c.id))?.phase,'ready');assert.equal(claudeAutoHolds(f.store,f.store.peer(f.c.id)),false);
  const g=await setup(t);observeClaudeAuto(g.store,g.c,g.store.endpoint(g.c.id)!);
  g.store.setSetting(claudeAutoKey(g.c.id),{...g.store.setting<ClaudeAutoFallback>(claudeAutoKey(g.c.id))!,phase:'binding',phase_at:Date.now()-60001,source:g.proof});
  await g.sweep();assert.equal(claudeAutoStatus(g.store,g.store.peer(g.c.id))?.phase,'ready');assert.deepEqual(g.counts(),{launches:0,stops:0});
});

test('解除配对时回收已启动副本；旧故障状态不影响用户窗口或新配对',async t=>{
  const f=await setup(t);(f.claude as any).manualCopyRegistration=async()=>undefined;
  await f.sweep();assert.equal(claudeAutoStatus(f.store,f.c)?.phase,'binding');
  const released:string[]=[];(f.claude as any).release=async(peer:any)=>released.push(peer.sessionId);
  f.store.unpair(f.pair.id);await lifecycle(f.broker).releaseOwned([f.c.id]);assert.deepEqual(released,[f.target.sessionId]);assert.equal(claudeAutoHolds(f.store,f.c),false);
  f.store.pair(f.c.id,f.x.id);assert.equal(claudeAutoStatus(f.store,f.c),undefined);
  f.store.updatePeer(f.c.id,{owner:'user'});assert.equal(claudeAutoHolds(f.store,f.store.peer(f.c.id)),false);
});
