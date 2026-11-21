import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { writeFileSync } from 'node:fs';
import { Broker } from '../broker/coordinator.js';
import { Store } from '../storage/store.js';
import {BridgeError} from '../shared/errors.js';
import {DEFAULT_CONFIG} from '../config/defaults.js';
import { FakeAdapter } from './support/fake-adapter.js';
import { registration } from './support/registration.js';
import { temporary } from './support/temporary.js';
import { assertLaunchPreconditions, selectHostLaunch } from '../hosts/host-launch.js';
import {lifecycle} from './support/broker-fixture.js';

for(const fails of [false,true])test(`隐式启动在原生就绪前不提交配对或消息，${fails?'失败保留草稿':'就绪后接受一次'}`,async t=>{
  const home=temporary(t),store=new Store(':memory:'),codex=new FakeAdapter(),claude=new FakeAdapter(),broker=new Broker(store,{...DEFAULT_CONFIG,implicit:'on-demand',codexBinary:process.execPath,codexHome:home},{codex,claude} as any,home);
  t.after(async()=>{await broker.stop();store.close();});
  const source=store.register(registration('claude','source',{cwd:home}));let entered!:()=>void,finish!:()=>void;
  const started=new Promise<void>(resolve=>entered=resolve),gate=new Promise<void>(resolve=>finish=resolve),create=codex.create.bind(codex);
  codex.create=async peer=>{entered();await gate;if(fails)throw new BridgeError('workspace_untrusted','原生信任未完成');return create(peer);};
  const pending=broker.dispatch('send',{actor:{host:'claude',sessionId:source.sessionId,memberId:source.id,callId:'first'},message:'等原生就绪后才提交'});await started;
  assert.equal(store.pairs().length,0);assert.equal(store.messages().length,0);finish();const result=await pending as any;
  if(fails){
    assert.equal(store.pairs().length,0);assert.equal(store.messages().length,0);assert.equal(result.launch_precondition.code,'workspace_untrusted');assert.ok(result.selection_id);
    const again=await broker.dispatch('pair.selection.get',{actor:{host:'claude',sessionId:source.sessionId,memberId:source.id,callId:'read'},selection_id:result.selection_id}) as any;
    assert.deepEqual(again.launch_precondition,result.launch_precondition,'重读选择时仍保留具体启动原因');
    const held=(store as any).db.prepare('SELECT data FROM pair_selections WHERE id=?').get(result.selection_id) as {data:string};
    assert.equal(JSON.parse(held.data).draft.message,'等原生就绪后才提交');
    codex.create=create;const retried=await broker.dispatch('pair.selection.resolve',{actor:{host:'claude',sessionId:source.sessionId,memberId:source.id,callId:'retry'},selection_id:result.selection_id}) as any;
    assert.ok(retried.message_id);assert.equal(store.pairs().length,1);assert.equal(store.messages().length,1);assert.equal(store.messages()[0]!.body,'等原生就绪后才提交');
  }
  else{assert.equal(store.pairs().length,1);assert.equal(store.messages().length,1);assert.equal(store.messages()[0]!.body,'等原生就绪后才提交');assert.equal(codex.created.length,1);}
});

test('信任与配置预检只读，不修改原生权限；同一会话不能默默切到另一个固定 home',t=>{
  const home=temporary(t),config={...DEFAULT_CONFIG,claudeBinary:process.execPath,claudeHome:home},launch=selectHostLaunch('claude',config,{home,cwd:home});
  writeFileSync(path.join(home,'.claude.json'),JSON.stringify({hasCompletedOnboarding:true,projects:{[home.replaceAll('\\','/')]:{hasTrustDialogAccepted:false}}}),'utf8');
  assert.throws(()=>assertLaunchPreconditions(launch),{code:'workspace_untrusted'});
  assert.throws(()=>selectHostLaunch('codex',{...DEFAULT_CONFIG,codexBinary:process.execPath,codexHome:path.join(home,'other')},{home,cwd:home,sessionId:'original',configHome:home}),{code:'original_home_changed'});
});

test('自动续办草稿期间用户取消，后台就绪后也不配对或提交任务',async t=>{
  const home=temporary(t),store=new Store(':memory:'),codex=new FakeAdapter(),claude=new FakeAdapter(),broker=new Broker(store,{...DEFAULT_CONFIG,implicit:'on-demand',codexBinary:process.execPath,codexHome:home},{codex,claude} as any,home);
  t.after(async()=>{await broker.stop();store.close();});
  const source=store.register(registration('claude','cancel-source',{cwd:home})),actor={host:'claude' as const,sessionId:source.sessionId!,callId:'cancel-draft'};
  codex.create=async()=>{throw new BridgeError('workspace_untrusted','先保留草稿');};
  const selected=await broker.dispatch('send',{actor,message:'取消后不得提交'}) as any;
  let entered!:()=>void,finish!:()=>void;const started=new Promise<void>(resolve=>entered=resolve),gate=new Promise<void>(resolve=>finish=resolve);
  codex.create=async peer=>{entered();await gate;return registration('codex','created-'+peer.id);};
  const resumed=broker.dispatch('pair.selection.resolve',{actor,selection_id:selected.selection_id});await started;
  const provisional=store.setting<{peerId:string}>('implicitPartner:'+source.id)!.peerId;
  await broker.dispatch('pair.selection.commit',{actor,selection_id:selected.selection_id,action:'cancel'});finish();
  await assert.rejects(resumed,{code:'selection_expired'});assert.equal(store.pairs().length,0);assert.equal(store.messages().length,0);
  await lifecycle(broker).waitForRelease(provisional);assert.equal(codex.released.filter(peer=>peer.id===provisional).length,1);assert.equal(store.peer(provisional).state,'offline');
});

for(const action of ['create','choose','cancel'] as const)test(`后台准备期间出现真实候选时保留选择，${action==='create'?'新建复用已准备后台':action==='choose'?'改选回收已准备后台':'取消回收已准备后台'}`,async t=>{
  const home=temporary(t),store=new Store(':memory:'),codex=new FakeAdapter(),claude=new FakeAdapter(),broker=new Broker(store,{...DEFAULT_CONFIG,implicit:'on-demand',codexBinary:process.execPath,codexHome:home},{codex,claude} as any,home);
  t.after(async()=>{await broker.stop();store.close();});const source=store.register(registration('claude','new-window-source',{cwd:home}));
  let entered!:()=>void,finish!:()=>void;const started=new Promise<void>(resolve=>entered=resolve),gate=new Promise<void>(resolve=>finish=resolve);
  let launches=0;codex.create=async peer=>{launches++;entered();await gate;return registration('codex','prepared-'+peer.id,{cwd:home});};
  const actor={host:'claude' as const,sessionId:source.sessionId!,callId:'new-window'},pending=broker.dispatch('send',{actor,message:'出现选择后先保留'});await started;
  const window=store.register(registration('codex','arrived-window',{cwd:home}));finish();const result=await pending as any;
  assert.equal(result.status,'selection_required');assert.deepEqual(result.candidates.map((candidate:any)=>candidate.member_id),[window.id]);assert.equal(store.pairs().length,0);assert.equal(store.messages().length,0);
  const provisional=store.setting<{peerId:string}>('implicitPartner:'+source.id)!.peerId;
  const committed=await broker.dispatch('pair.selection.commit',{actor,selection_id:result.selection_id,action,...(action==='choose'?{key:result.candidates[0].key}:{})}) as any;
  await lifecycle(broker).waitForRelease(provisional);
  assert.equal(launches,1);assert.equal(store.setting('implicitPartner:'+source.id),null);
  if(action==='create'){assert.equal(store.pairFor(source.id)!.codex,provisional);assert.equal(codex.released.length,0);assert.equal(store.messages()[0]!.body,'出现选择后先保留');}
  else{assert.equal(codex.released.filter(peer=>peer.id===provisional).length,1);assert.equal(store.peer(provisional).state,'offline');if(action==='choose')assert.equal(store.pairFor(source.id)!.codex,window.id);else{assert.equal(committed.status,'selection_declined');assert.equal(store.messages().length,0);}}
});

test('同一草稿自动启动与手动新建并发时等待原启动并仅提交一次',async t=>{
  const home=temporary(t),store=new Store(':memory:'),codex=new FakeAdapter(),claude=new FakeAdapter(),broker=new Broker(store,{...DEFAULT_CONFIG,implicit:'on-demand',codexBinary:process.execPath,codexHome:home},{codex,claude} as any,home);
  t.after(async()=>{await broker.stop();store.close();});const source=store.register(registration('claude','race-source',{cwd:home})),window=store.register(registration('codex','old-window',{cwd:home})),actor={host:'claude' as const,sessionId:source.sessionId!,callId:'race'};
  const selected=await broker.dispatch('send',{actor,message:'并发也只接受一次'}) as any;store.updatePeer(window.id,{state:'offline'});
  let entered!:()=>void,finish!:()=>void,launches=0;const started=new Promise<void>(resolve=>entered=resolve),gate=new Promise<void>(resolve=>finish=resolve);
  codex.create=async peer=>{launches++;entered();await gate;return registration('codex','race-'+peer.id,{cwd:home});};
  const resumed=broker.dispatch('pair.selection.resolve',{actor,selection_id:selected.selection_id});await started;
  const committed=broker.dispatch('pair.selection.commit',{actor,selection_id:selected.selection_id,action:'create'});finish();
  const [automatic,manual]=await Promise.all([resumed,committed]) as any[];
  assert.equal(automatic.message_id,manual.message_id);assert.equal(launches,1);assert.equal(store.messages().length,1);assert.equal(store.pairs().length,1);assert.equal(codex.released.length,0);
  t.mock.method(broker as any,'requireIndependentBackground',()=>{throw new BridgeError('bootstrap_required','不应重新预检已提交选择');});
  const repeated=await broker.dispatch('pair.selection.commit',{actor,selection_id:selected.selection_id,action:'create'}) as any;assert.equal(repeated.message_id,manual.message_id);
});

test('候选消失后的启动前置失败保留具体原因，手动新建复用同一后台成员',async t=>{
  const home=temporary(t),store=new Store(':memory:'),codex=new FakeAdapter(),claude=new FakeAdapter(),broker=new Broker(store,{...DEFAULT_CONFIG,implicit:'on-demand',codexBinary:process.execPath,codexHome:home},{codex,claude} as any,home);
  t.after(async()=>{await broker.stop();store.close();});const source=store.register(registration('claude','failed-source',{cwd:home})),window=store.register(registration('codex','closing-window',{cwd:home})),actor={host:'claude' as const,sessionId:source.sessionId!,callId:'failed'};
  const selected=await broker.dispatch('send',{actor,message:'等待原生条件'}) as any;store.updatePeer(window.id,{state:'offline'});
  codex.create=async()=>{throw new BridgeError('workspace_untrusted','原生工作区未信任');};
  const failed=await broker.dispatch('pair.selection.resolve',{actor,selection_id:selected.selection_id}) as any;
  assert.equal(failed.status,'launch_precondition');assert.equal(failed.reason,'launch_precondition');assert.equal(failed.launch_precondition.code,'workspace_untrusted');
  const provisional=store.setting<{peerId:string}>('implicitPartner:'+source.id)!.peerId;codex.create=FakeAdapter.prototype.create.bind(codex);
  const committed=await broker.dispatch('pair.selection.commit',{actor,selection_id:selected.selection_id,action:'create'}) as any;
  assert.equal(store.pairFor(source.id)!.codex,provisional);assert.equal(codex.created.length,1);assert.equal(store.messages().length,1);assert.ok(committed.message_id);
});

test('候选核验临时失败只影响本次操作，启动受阻后原窗口恢复仍可再次选择',async t=>{
  const home=temporary(t),store=new Store(':memory:'),codex=new FakeAdapter(),claude=new FakeAdapter(),broker=new Broker(store,{...DEFAULT_CONFIG,implicit:'on-demand',codexBinary:process.execPath,codexHome:home},{codex,claude} as any,home);
  t.after(async()=>{await broker.stop();store.close();});const source=store.register(registration('claude','transient-source',{cwd:home})),window=store.register(registration('codex','transient-window',{cwd:home})),actor={host:'claude' as const,sessionId:source.sessionId!,callId:'transient'};
  const selection=await broker.dispatch('send',{actor,message:'等待原窗口恢复'}) as any;let available=false;
  codex.probe=async peer=>peer.id===window.id&&!available?{state:'unknown',nativeState:'unknown',reasons:['临时无法核验'],checked_at:Date.now()}:{state:'reachable',reasons:[],checked_at:Date.now()};
  codex.create=async()=>{throw new BridgeError('workspace_untrusted','原生条件未满足');};
  const failed=await broker.dispatch('pair.selection.resolve',{actor,selection_id:selection.selection_id}) as any;
  assert.equal(failed.status,'launch_precondition');assert.equal(failed.candidates.length,0);assert.equal(store.peer(window.id).state,'ready');available=true;
  const retry=await broker.dispatch('pair.selection.resolve',{actor,selection_id:selection.selection_id}) as any;
  assert.equal(retry.status,'selection_required');assert.equal(retry.candidates[0].member_id,window.id);assert.equal(store.pairs().length,0);assert.equal(store.messages().length,0);
});

test('自动启动尚未结束时改选真实窗口，原后台就绪后回收且不发送原任务两次',async t=>{
  const home=temporary(t),store=new Store(':memory:'),codex=new FakeAdapter(),claude=new FakeAdapter(),broker=new Broker(store,{...DEFAULT_CONFIG,implicit:'on-demand',codexBinary:process.execPath,codexHome:home},{codex,claude} as any,home);
  t.after(async()=>{await broker.stop();store.close();});const source=store.register(registration('claude','choose-source',{cwd:home})),window=store.register(registration('codex','old-window',{cwd:home})),actor={host:'claude' as const,sessionId:source.sessionId!,callId:'choose'};
  const selected=await broker.dispatch('send',{actor,message:'只发送到选中的窗口'}) as any;store.updatePeer(window.id,{state:'offline'});
  let entered!:()=>void,finish!:()=>void,launches=0;const started=new Promise<void>(resolve=>entered=resolve),gate=new Promise<void>(resolve=>finish=resolve);
  codex.create=async peer=>{launches++;entered();await gate;return registration('codex','unselected-'+peer.id,{cwd:home});};
  const resumed=broker.dispatch('pair.selection.resolve',{actor,selection_id:selected.selection_id});await started;
  const provisional=store.setting<{peerId:string}>('implicitPartner:'+source.id)!.peerId,newWindow=store.register(registration('codex','new-window',{cwd:home}));
  const refreshed=await broker.dispatch('pair.selection.refresh',{actor,selection_id:selected.selection_id}) as any;
  const result=await broker.dispatch('pair.selection.commit',{actor,selection_id:selected.selection_id,action:'choose',key:refreshed.candidates.find((candidate:any)=>candidate.member_id===newWindow.id).key}) as any;finish();
  await assert.rejects(resumed,{code:'selection_expired'});await lifecycle(broker).waitForRelease(provisional);
  assert.equal(store.pairFor(source.id)!.codex,newWindow.id);assert.equal(launches,1);assert.equal(codex.released.filter(peer=>peer.id===provisional).length,1);assert.equal(store.messages().length,1);assert.equal(store.message(result.message_id).to,newWindow.id);
});

for(const cause of ['expires','session','closed'] as const)test(`原选择${cause==='expires'?'过期':cause==='session'?'已换会话':'窗口关闭'}后回收未提交后台`,async t=>{
  const home=temporary(t),store=new Store(':memory:'),codex=new FakeAdapter(),claude=new FakeAdapter(),broker=new Broker(store,{...DEFAULT_CONFIG,implicit:'on-demand',codexBinary:process.execPath,codexHome:home},{codex,claude} as any,home);
  t.after(async()=>{await broker.stop();store.close();});const source=store.register(registration('claude','expire-source',{cwd:home})),actor={host:'claude' as const,sessionId:source.sessionId!,callId:'expire'};
  codex.create=async peer=>{store.register(registration('codex','arriving-window',{cwd:home}));return registration('codex','unselected-'+peer.id,{cwd:home});};
  const selected=await broker.dispatch('send',{actor,message:'用户尚未选择'}) as any;assert.equal(selected.status,'selection_required');
  const provisional=store.setting<{peerId:string}>('implicitPartner:'+source.id)!.peerId;
  if(cause==='expires')(store as any).db.prepare("UPDATE pair_selections SET expires_at=0,data=json_set(data,'$.expiresAt',0) WHERE id=?").run(selected.selection_id);
  else store.updatePeer(source.id,cause==='session'?{sessionId:'changed-session'}:{state:'offline'});
  (broker as any).maintain();await lifecycle(broker).waitForRelease(provisional);
  assert.equal(codex.released.filter(peer=>peer.id===provisional).length,1);assert.equal(store.peer(provisional).state,'offline');assert.equal(store.setting('implicitPartner:'+source.id),null);assert.equal(store.messages().length,0);
});
