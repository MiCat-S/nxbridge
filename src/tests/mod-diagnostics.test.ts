import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fixture } from './support/broker-fixture.js';
import { registration } from './support/registration.js';

test('回执与状态拒绝均记录原因；失效租约仍能带回诊断，不能执行原操作',async t=>{
  const {store,broker,x}=fixture(t),input=registration('claude','diagnostic-root',{endpoint:{mode:'claude-inbox',address:'inbox',epoch:'diag',pid:123,procStart:'generation',configHome:path.resolve('/diag')}});
  const peer=await broker.dispatch('register',input) as any,binding=peer.binding,actor={host:'claude',sessionId:peer.sessionId,callId:'diagnostic',binding:{...binding,epoch:'stale'}};
  const pair=store.pair(peer.id,x.id),message=store.accept(pair,x,'回执失败时不可谎称已读','incoming');
  const diagnostic={consecutive:3,last_error:{op:'observe',code:'stale_context',at:100}};
  await assert.rejects(broker.dispatch('register',{...input,expectedBinding:actor.binding,mod_operation:'observe',mod_diagnostics:diagnostic}),{code:'stale_context'});
  for(const [method,payload]of [['observe',{message_id:message.id,state:'contextObserved'}],['peer.state',{state:'busy'}]] as const)await assert.rejects(broker.dispatch(method,{actor,...payload}),{code:'stale_context'});
  assert.equal(store.message(message.id).state,'accepted');assert.equal(store.peer(peer.id).state,'ready');
  const rejected=store.events(0,1000).filter(e=>e.type==='mod.rpc.rejected');
  assert.deepEqual(rejected.map(e=>(e.data as any).method),['register','observe','peer.state']);
  assert.ok(rejected.every(e=>(e.data as any).code==='stale_context'&&(e.data as any).peerId===peer.id));
  const saved=store.setting<any>('modReceiptDiagnostic:'+peer.id);assert.deepEqual(saved.diagnostic,diagnostic);assert.deepEqual(saved.binding,binding);assert.equal(saved.reportedBinding.epoch,'stale');
  await broker.dispatch('register',{...input,mod_operation:'state',mod_diagnostics:diagnostic});
  assert.equal(store.events(0,1000).filter(e=>e.type==='mod.receipt.failure').length,1,'同一客户端失败记录在重试中只记一次');
  await broker.dispatch('observe',{actor:{...actor,binding},message_id:message.id,state:'contextObserved'});assert.equal(store.message(message.id).state,'contextObserved');
  const trace=[{p:'append',at:200,id:message.id,r:'origin_error',code:'stale_context'},{p:'ask',at:201,source:false}];
  await broker.dispatch('register',{...input,question_diagnostics:trace});
  const source=store.events(0,1000).find(e=>e.type==='mod.question_source')?.data as any;
  assert.equal(source.peerId,peer.id);assert.deepEqual(source.trace,trace);
  await broker.dispatch('register',{...input,question_diagnostics:[{...trace[0],body:'不得保存正文'}]});
  assert.equal(store.events(0,1000).filter(e=>e.type==='mod.question_source').length,1);
});
