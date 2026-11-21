import test from 'node:test';
import assert from 'node:assert/strict';
import {BridgeError} from '../shared/errors.js';
import { fixture } from './support/broker-fixture.js';

test('恢复阶段异常不会拒绝无人等待的 pump，原消息保留且下一轮仍能投递',async t=>{
  const {store,broker,c,x,claude}=fixture(t),pair=store.pair(c.id,x.id),message=store.accept(pair,x,'故障后仍需送达','pump-regression');
  const recovery=(broker as any).windowRecovery,retry=recovery.retry.bind(recovery);let fail=true;
  recovery.retry=async(...args:unknown[])=>{if(fail){fail=false;throw new BridgeError('peer_missing','隔离的旧记录故障');}return retry(...args);};
  await broker.pump();assert.equal(store.message(message.id).state,'accepted');
  const event=store.events().find(event=>event.type==='pump.failed');assert.equal((event?.data as any)?.stage,'window_recovery');assert.equal((event?.data as any)?.code,'peer_missing');
  await broker.pump();assert.equal(store.message(message.id).state,'runtimeQueued');assert.equal(claude.delivered.length,1);
});

test('pump 最外层的同步异常也被集中记录，释放本轮占位后仍可继续',async t=>{
  const {store,broker}=fixture(t),pump=(broker as any).pumpOnce.bind(broker);let fail=true;
  (broker as any).pumpOnce=async(...args:unknown[])=>{if(fail){fail=false;throw Error('意外的阶段之外异常');}return pump(...args);};
  await broker.pump();await broker.pump();
  assert.equal((broker as any).pumping,undefined);assert.ok(store.events().some(event=>event.type==='pump.failed'&&(event.data as any).stage==='pump'));
});
