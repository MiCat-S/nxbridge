import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './support/broker-fixture.js';
import {BridgeError} from '../shared/errors.js';
import { formatStatus } from '../integration/mcp/presentation.js';

test('后台启动失败可见且保留未提交消息，普通泵不重复启动，明确重试恢复原配对',async t=>{
  const f=fixture(t,{implicit:'on-demand'});f.store.deactivate(f.x.id);f.store.updatePeer(f.x.id,{state:'offline'});
  let launches=0;const create=f.codex.create.bind(f.codex);f.codex.create=async()=>{launches++;throw new BridgeError('launch_owner_unverified','启动父链仍有两个独立候选');};
  const actor={host:'claude' as const,sessionId:f.c.sessionId!,callId:'failed-launch'},sent=f.broker.send({actor,message:'不得重放的任务'}),pair=f.store.pairFor(f.c.id)!;
  await f.broker.pump();const failed=f.store.peer(pair.codex);assert.equal(launches,1);assert.ok(failed.launchFailure);assert.equal(failed.state,'offline');
  assert.equal(f.store.message(sent.message_id).state,'accepted');assert.equal(f.codex.delivered.length,0);
  const status=f.broker.status(actor) as any;assert.match(formatStatus(status),/启动失败.*启动父链.*nxbridge open codex/s);
  await f.broker.pump();assert.equal(launches,1);assert.ok(f.broker.pairAnomalies.issues(failed.id).some(issue=>issue.kind==='launch_failed'));
  f.codex.create=create;await f.broker.dispatch('open',{host:'codex',actor});await f.broker.pump();
  assert.equal(f.store.peer(failed.id).launchFailure,undefined);assert.equal(f.store.pairFor(f.c.id)!.id,pair.id);assert.equal(f.codex.woken.length,1);
  assert.equal(f.codex.delivered[0]?.id,sent.message_id);assert.equal(f.store.message(sent.message_id).state,'contextObserved');
});
