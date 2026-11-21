import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdirSync, writeFileSync } from 'node:fs';
import { Store } from '../storage/store.js';
import { Recovery } from '../broker/recovery/recovery.js';
import { modelStatus } from '../integration/mcp/model-output.js';
import { formatGlobalStatus } from '../integration/mcp/presentation.js';
import {ensureHome} from '../ipc/home.js';
import { processIdentity } from '../process/process.js';
import { collectRuntimeNotices, acknowledgeRuntimeNotice } from '../broker/health/runtime-monitor.js';
import {readHealthSnapshot} from '../broker/health/snapshot.js';
import { pairLoss, pairLossKey } from '../broker/pairing/pair-loss.js';
import { fixture } from './support/broker-fixture.js';
import { registration } from './support/registration.js';
import { temporaryDirectory, temporary } from './support/temporary.js';
import { recordFixtureLaunch } from './support/native-launch.js';
import type { Actor } from '../types.js';

const actor=(host:Actor['host'],sessionId:string,callId='loss-send'):Actor=>({host,sessionId,callId});

test('配对丢失持久化到两端；broker 退出后仍按原生代次通知一次，恢复后撤销',async t=>{
  const temp=temporaryDirectory(),home=temp.directory;await ensureHome(home);
  let store=new Store(path.join(home,'nxbridge.db'));t.after(async()=>{store.close();await temp.cleanup();});
  const native=await processIdentity(process.pid),runtime={pid:process.pid,procStart:native.startedAt};
  const configHome=path.join(home,'claude');mkdirSync(path.join(configHome,'sessions'),{recursive:true});writeFileSync(path.join(configHome,'sessions',runtime.pid+'.json'),JSON.stringify({sessionId:'loss-claude',procStart:runtime.procStart}),'utf8');
  const c=store.register(registration('claude','loss-claude',{endpoint:{mode:'claude-inbox',address:'inbox',epoch:'c',configHome,...runtime}}));
  const x=store.register(registration('codex','loss-codex',{endpoint:{mode:'embedded',address:'',epoch:'x',...runtime}})),pair=store.pair(c.id,x.id),context='loss-context';
  store.setSetting('hookContext:'+context,x.sessionId);store.unpair(pair.id,{reason:'broker_shutdown',actor:'test cleanup pid 42'});
  store.close();store=new Store(path.join(home,'nxbridge.db'));
  for(const peer of [c,x]){
    const key=peer.host==='codex'?context:undefined;
    assert.deepEqual(await collectRuntimeNotices(home,peer.host,peer.sessionId!,{...runtime,procStart:'wrong'},key),[]);
    const signal=await collectRuntimeNotices(home,peer.host,peer.sessionId!,runtime,key,undefined,undefined,{admit:false});
    assert.equal(signal.length,1);assert.equal(signal[0]!.source,'pair_lost');assert.equal(signal[0]!.message,undefined);
    const notices=await collectRuntimeNotices(home,peer.host,peer.sessionId!,runtime,key);
    assert.equal(notices.length,1);assert.match(notices[0]!.message,/test cleanup pid 42/);assert.ok(notices[0]!.message.includes('nxbridge pair --restore '+pair.id));
    await acknowledgeRuntimeNotice(home,peer.host,peer.sessionId!,runtime,notices[0]!.id,'unknown','宿主结果未知',key);
    assert.deepEqual(await collectRuntimeNotices(home,peer.host,peer.sessionId!,runtime,key),[],'未知提交也不能重放');
  }
  store.restorePair(pair.id);
  assert.equal(readHealthSnapshot(home,'codex',x.sessionId!,context,runtime)?.loss,undefined);
});

test('意外丢失替换普通未配对提示并进入压缩恢复事实；发信保留草稿，不自动换人',async t=>{
  const {store,broker,c,x,codex}=fixture(t),pair=store.pair(c.id,x.id),a=actor('claude',c.sessionId!);
  store.unpair(pair.id,{reason:'identity_mismatch',actor:'native registration'});
  const status=broker.status(a) as any,model=modelStatus(status);
  assert.equal(status.pair_lost.pair_id,pair.id);assert.equal((model.pair_lost as any).reason,'identity_mismatch');
  assert.doesNotMatch(String(model.notice),/pairs on demand/);
  assert.ok(formatGlobalStatus(broker.status()).includes('nxbridge pair --restore '+pair.id));
  const binding=store.bindings.current(c.id)!;
  assert.ok(new Recovery(store).facts({...a,binding:{key:binding.key,epoch:binding.epoch}})!.text.includes('identity_mismatch'));
  const selected=await broker.dispatch('send',{actor:a,message:'保留原发送意图'}) as any;
  assert.equal(selected.status,'selection_required');assert.equal(selected.reason,'pair_lost');assert.equal(selected.candidates[0].former_partner,true);
  assert.equal(store.messages().length,0);assert.equal(store.pairs().length,0);assert.equal(codex.created.length,0);
  await broker.dispatch('pair.selection.commit',{actor:a,selection_id:selected.selection_id,action:'cancel'});
  assert.ok(pairLoss(store,c),'取消选择保留事故事实');
  await broker.dispatch('unpair',{peer_id:c.id});assert.equal(pairLoss(store,c),undefined);assert.ok(pairLoss(store,x),'解除提示只影响所选窗口');
});

test('选择恢复离线托管搭档保留原配对、原会话和一次发送；旧回收预约不能停止恢复后的成员',async t=>{
  const {store,broker,c,x,codex}=fixture(t),home=temporary(t),sessions=path.join(home,'sessions');mkdirSync(sessions);
  writeFileSync(path.join(sessions,x.sessionId+'.jsonl'),'{}\n','utf8');
  store.updatePeer(x.id,{owner:'nxbridge',state:'offline'});store.saveEndpoint({...store.endpoint(x.id)!,configHome:home});
  recordFixtureLaunch(store,broker.home,store.peer(x.id));
  const pair=store.pair(c.id,x.id);store.unpair(pair.id,{reason:'broker_shutdown'});store.setSetting('processRetirements',{[x.id]:{attempts:2,nextAt:Date.now()+60000}});
  const a=actor('claude',c.sessionId!),selected=await broker.dispatch('send',{actor:a,message:'继续原任务'}) as any,candidate=selected.candidates[0];
  assert.equal(candidate.restore_state,'resumable');
  const choice={actor:a,selection_id:selected.selection_id,key:candidate.key},result=await broker.dispatch('pair.selection.commit',choice) as any;
  assert.equal(result.pair_id,pair.id);assert.equal(store.pairFor(c.id)!.codex,x.id);assert.equal(store.peer(x.id).sessionId,x.sessionId);
  assert.equal(store.messages().length,1);assert.equal(codex.created.length,0);assert.ok(codex.attached.some(value=>value.peer.id===x.id));
  assert.equal((store.setting<any>('processRetirements')??{})[x.id],undefined);assert.equal(store.setting(pairLossKey(c.id)),null);
  assert.deepEqual(await broker.dispatch('pair.selection.commit',choice),result);assert.equal(store.messages().length,1);
});

test('历史缺失或原成员已有新搭档时拒绝恢复，不启动新会话；显式新建仍可选择',async t=>{
  const {store,broker,c,x,codex}=fixture(t,{implicit:'on-demand'}),home=temporary(t);store.updatePeer(x.id,{owner:'nxbridge',state:'offline'});store.saveEndpoint({...store.endpoint(x.id)!,configHome:home});
  const pair=store.pair(c.id,x.id);store.unpair(pair.id,{reason:'broker_shutdown'});
  await assert.rejects(broker.dispatch('pair.restore',{pair_id:pair.id}),{code:'pair_restore_unavailable'});
  const a=actor('claude',c.sessionId!),selected=await broker.dispatch('send',{actor:a,message:'尚未授权换人'}) as any;
  assert.equal(selected.pair_lost.restore_state,'gone');assert.equal(store.pairs().length,0);assert.equal(codex.created.length,0);
  const other=store.register(registration('claude','other'));store.pair(other.id,x.id);
  await assert.rejects(broker.dispatch('pair.restore',{pair_id:pair.id}),{code:'pair_exists'});
  await broker.dispatch('pair.selection.commit',{actor:a,selection_id:selected.selection_id,action:'create'});
  assert.notEqual(store.pairFor(c.id)!.id,pair.id);assert.notEqual(store.pairFor(c.id)!.codex,x.id);assert.equal(pairLoss(store,c),undefined);
});

test('显式解除和卸载保持安静；短暂重启保留配对',async t=>{
  const {store,broker,c,x}=fixture(t),pair=store.pair(c.id,x.id);store.unpair(pair.id);
  assert.equal(pairLoss(store,c),undefined);assert.equal(pairLoss(store,x),undefined);
  store.pair(c.id,x.id);await broker.stop(false);assert.ok(store.pairFor(c.id));assert.equal(pairLoss(store,c),undefined);
  await broker.stop(true,null);assert.equal(pairLoss(store,c),undefined);assert.equal(store.pairs().length,0);
});

test('成员切换或重新加载对话不绕过解除事实，新建仍需明确选择',async t=>{
  const {store,broker,c,x,codex}=fixture(t),pair=store.pair(c.id,x.id);store.unpair(pair.id,{reason:'broker_shutdown'});
  store.register(registration('claude','new-context',{contextStart:true,endpoint:{...store.endpoint(c.id)!}}));
  const binding=store.bindings.current(c.id)!,a={...actor('claude','new-context'),binding:{key:binding.key,epoch:binding.epoch}},status=broker.status(a) as any;
  assert.equal(status.pair_lost.pair_id,pair.id);assert.ok(new Recovery(store).facts(a)!.text.includes(pair.id));
  const result=await broker.dispatch('send',{actor:a,message:'新上下文仍需原搭档'}) as any;
  assert.equal(result.reason,'pair_lost');assert.equal(store.pairs().length,0);assert.equal(codex.created.length,0);
});
