import test from 'node:test';
import assert from 'node:assert/strict';
import {DeliveryHealth} from '../broker/health/delivery.js';
import {deliveryHealthKey,emptyDeliveryCounts} from '../broker/health/contracts.js';
import { fixture } from './support/broker-fixture.js';

test('不同健康来源合并一次提交，共用持久的接收方一分钟闸门',t=>{
  t.mock.timers.enable({apis:['Date'],now:1000000});
  const f=fixture(t),pair=f.store.pair(f.c.id,f.x.id),health=f.broker.deliveryHealth;
  for(const [id,source] of [['hooks','pair_anomaly'],['idle','idle_unanswered'],['turn','turn_health']] as const)health.enqueue(pair.id,f.c.id,{id,source,kind:id,message:id,state:'pending'});
  const batch=health.take(pair.id,f.c.id);assert.equal(batch.length,1);assert.deepEqual(batch[0]!.componentIds,['hooks','idle','turn']);
  const submitted=health.prepare(pair.id,f.c.id,batch[0]!.id)!;assert.equal(submitted.message,'hooks\nidle\nturn');
  health.outcome(pair.id,f.c.id,submitted.id,'submitted');
  assert.ok(f.store.setting<any>(deliveryHealthKey(pair.id,f.c.id)).notices.every((n:any)=>n.state==='submitted'));
  const restarted=new DeliveryHealth(f.store);restarted.enqueue(pair.id,f.c.id,{id:'other',source:'pair_anomaly',kind:'other',message:'新条件',state:'pending'});
  t.mock.timers.tick(59999);assert.deepEqual(restarted.take(pair.id,f.c.id),[]);assert.equal(restarted.prepare(pair.id,f.c.id,'other'),undefined);
  restarted.enqueue(pair.id,f.x.id,{id:'independent',message:'另一接收方',state:'pending'});assert.ok(restarted.prepare(pair.id,f.x.id,'independent'));
  t.mock.timers.tick(1);assert.ok(restarted.prepare(pair.id,f.c.id,'other'));assert.equal(f.store.messages().length,0);
});

test('同类反复故障十分钟内保持待定，真实恶化也不能越过一分钟硬闸门',t=>{
  t.mock.timers.enable({apis:['Date'],now:1000000});
  const f=fixture(t),pair=f.store.pair(f.c.id,f.x.id),health=f.broker.deliveryHealth;
  const enqueue=(id:string,severity=1)=>health.enqueue(pair.id,f.c.id,{id,kind:'runtime',severity,message:id,state:'pending'});
  enqueue('unknown');assert.ok(health.prepare(pair.id,f.c.id,'unknown'));
  enqueue('worse',2);t.mock.timers.tick(59999);assert.equal(health.prepare(pair.id,f.c.id,'worse'),undefined);
  t.mock.timers.tick(1);assert.ok(health.prepare(pair.id,f.c.id,'worse'));
  enqueue('flap',2);t.mock.timers.tick(599999);assert.equal(health.prepare(pair.id,f.c.id,'flap'),undefined);
  t.mock.timers.tick(1);assert.ok(new DeliveryHealth(f.store).prepare(pair.id,f.c.id,'flap'));
  t.mock.timers.tick(600000);assert.deepEqual(health.take(pair.id,f.c.id),[],'已提交但回执未知的正文仍然不能重放');
});

test('用户明确恢复不受自动通知时钟限制，也不提前夹带仍限频的自动通知',t=>{
  t.mock.timers.enable({apis:['Date'],now:1000000});
  const f=fixture(t),pair=f.store.pair(f.c.id,f.x.id),health=f.broker.deliveryHealth;
  health.enqueue(pair.id,f.x.id,{id:'auto-old',kind:'runtime',state:'pending',message:'旧自动通知'});
  assert.ok(health.prepare(pair.id,f.x.id,'auto-old'));
  health.enqueue(pair.id,f.x.id,{id:'auto-new',kind:'runtime',state:'pending',message:'限频自动通知'});
  const recovery=(id:string,factKey:string)=>health.enqueue(pair.id,f.x.id,{id,kind:'explicit_recovery',source:'turn_health',factKey,state:'pending',message:id});
  recovery('requested','failed-1');
  const prepared=health.prepare(pair.id,f.x.id,'requested')!;
  assert.deepEqual(prepared.componentIds,['requested']);assert.equal(prepared.wake,true);
  assert.equal(health.prepare(pair.id,f.x.id,'auto-new'),undefined);
  recovery('duplicate','failed-1');assert.equal(health.prepare(pair.id,f.x.id,'duplicate'),undefined);
  recovery('next-failed-turn','failed-2');assert.ok(health.prepare(pair.id,f.x.id,'next-failed-turn'));
  assert.equal(health.prepare(pair.id,f.x.id,'auto-new'),undefined);
});

test('最终合并排除已恢复分量，并发消费者只有一个能推进提交时钟',t=>{
  const f=fixture(t),pair=f.store.pair(f.c.id,f.x.id),health=f.broker.deliveryHealth;
  for(const id of ['a','b','c'])health.enqueue(pair.id,f.c.id,{id,kind:id,message:id,state:'pending'});
  assert.equal(health.take(pair.id,f.c.id).length,1);health.cancel(pair.id,f.c.id,'b');
  const first=health.prepare(pair.id,f.c.id,'a')!;assert.equal(first.message,'a\nc');assert.deepEqual(first.componentIds,['a','c']);
  assert.equal(new DeliveryHealth(f.store).prepare(pair.id,f.c.id,'c'),undefined);
  health.outcome(pair.id,f.c.id,'a','unknown');assert.deepEqual(health.take(pair.id,f.c.id),[]);
});

test('短暂握手恢复不结清投递故障，稳定功能恢复不追加模型通知',t=>{
  t.mock.timers.enable({apis:['Date'],now:1000000});
  const f=fixture(t),pair=f.store.pair(f.c.id,f.x.id),health=f.broker.deliveryHealth;
  f.store.accept(pair,f.c,'实际待投递消息','dependency');
  const observe=(state:'reachable'|'blocked',functionalSuccessAt?:number)=>health.observe(pair,f.c,f.x,{...emptyDeliveryCounts(),accepted:1},{state,reasons:state==='blocked'?['真实故障']:[],checked_at:Date.now(),functionalSuccessAt},true);
  observe('blocked');t.mock.timers.tick(300000);observe('blocked');const alert=health.take(pair.id,f.c.id)[0]!;assert.ok(health.prepare(pair.id,f.c.id,alert.id));
  t.mock.timers.tick(1000);observe('reachable');assert.deepEqual(health.take(pair.id,f.c.id),[]);
  t.mock.timers.tick(1000);observe('blocked');t.mock.timers.tick(60000);
  assert.deepEqual(health.take(pair.id,f.c.id),[],'旧恢复已撤销，新同类告警处于十分钟限频');
  const functional=Date.now();observe('reachable',functional);t.mock.timers.tick(30000);observe('reachable',functional);assert.deepEqual(health.take(pair.id,f.c.id),[]);assert.equal(health.active(pair.id,f.c.id),false);
});
