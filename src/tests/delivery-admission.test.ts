import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './support/broker-fixture.js';

test('准入状态按读取者方向和当前配对统计；过期时间不因新等待消息刷新',t=>{
  const f=fixture(t),pair=f.store.pair(f.c.id,f.x.id),actor={host:'codex' as const,memberId:f.x.id,sessionId:f.x.sessionId!,callId:'admission'},claude={host:'claude' as const,memberId:f.c.id,sessionId:f.c.sessionId!,callId:'admission'};
  const message=f.store.accept(pair,f.x,'等待审批','admission-held');f.store.claim(message.id);f.store.transition(message.id,'held');
  let status:any=f.broker.status(actor);assert.equal(status.delivery_admission.outbound.held,1);assert.equal(status.delivery_admission.inbound.held,0);assert.equal((f.broker.status(claude) as any).delivery_admission.inbound.held,1);
  f.store.transition(message.id,'expired','原生确认未送达');status=f.broker.status(actor);assert.equal(status.delivery_admission.outbound.expired,1);assert.equal(status.delivery_admission.outbound.held,0);const last=status.delivery_admission.outbound.latest_at;assert.equal(typeof last,'number');
  const another=f.store.accept(pair,f.x,'另一条待审批','admission-held-new');f.store.claim(another.id);f.store.transition(another.id,'held');assert.equal((f.broker.status(actor) as any).delivery_admission.outbound.latest_at,last);
  f.store.unpair(pair.id);const next=f.store.pair(f.c.id,f.x.id);assert.notEqual(next.id,pair.id);assert.equal((f.broker.status(actor) as any).delivery_admission.outbound.expired,0);
});
