import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fixture } from './support/broker-fixture.js';
import { registration } from './support/registration.js';
import { formatGlobalStatus } from '../integration/mcp/presentation.js';

test('多组管理拒绝默认及未知目标，原生窗口和显式选择只作用于对应配对',async t=>{
  const {store,broker,c,x}=fixture(t),p1=store.pair(c.id,x.id);
  const c2=store.register(registration('claude','other-c',{cwd:path.resolve('/other')})),x2=store.register(registration('codex','other-x',{cwd:c2.cwd})),p2=store.pair(c2.id,x2.id);
  const b=store.bindings.activate({host:'claude',configHome:path.resolve('/isolated'),pid:101,procStart:'g'},c2.id,'other-c','verified');
  for(const method of ['pause','resume','unpair','open','codex.restart.target'])await assert.rejects(broker.dispatch(method,method==='open'?{host:'codex'}:{}),{code:'pair_selector_required'});
  await assert.rejects(broker.dispatch('pause',{pair_id:'missing'}),{code:'unpaired'});
  await assert.rejects(broker.dispatch('pause',{session_id:'missing'}),{code:'ambiguous_context'});
  await assert.rejects(broker.dispatch('pause',{native:{host:'claude',pid:101,procStart:'reused'}}),{code:'ambiguous_context'});
  await broker.dispatch('pause',{native:{host:b.host,pid:b.pid,procStart:b.procStart}});
  assert.equal(store.pairFor(c.id)?.paused,false);assert.equal(store.pairFor(c2.id)?.paused,true);
  await broker.dispatch('resume',{peer_id:x2.id});assert.equal(store.pairFor(c2.id)?.paused,false);
  assert.equal((await broker.dispatch('codex.restart.target',{pair_id:p1.id}) as any).peer_id,x.id);
  await broker.dispatch('unpair',{session_id:'other-x'});assert.equal(store.pairFor(c2.id),undefined);assert.equal(store.pairFor(c.id)?.id,p1.id);
  assert.ok(formatGlobalStatus(broker.status()).includes('配对 1'));assert.equal(store.pairById(p2.id)?.archived,true);
});
