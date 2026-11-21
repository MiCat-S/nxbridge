import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './support/broker-fixture.js';
import {DeliveryHealth} from '../broker/health/delivery.js';
import {emptyDeliveryCounts} from '../broker/health/contracts.js';

const unknown=()=>({state:'unknown' as const,reasons:['receipt unverified'],checked_at:Date.now()});

test('无消息和回复依赖时只观察可达性；新依赖仍按自己的时钟升级，结清后撤回',t=>{
  t.mock.timers.enable({apis:['Date'],now:1000000});const f=fixture(t),pair=f.store.pair(f.c.id,f.x.id),health=f.broker.deliveryHealth;
  health.observe(pair,f.c,f.x,emptyDeliveryCounts(),unknown(),true);t.mock.timers.tick(600001);
  health.observe(pair,f.c,f.x,emptyDeliveryCounts(),unknown(),true);
  assert.equal(health.active(pair.id,f.c.id),true,'仍可在状态中查看运行时不可达');
  assert.equal(f.store.events().filter(event=>event.type==='health.delivery.alert').length,0);assert.deepEqual(health.notes(pair.id,f.c.id),[]);
  const task=f.store.accept(pair,f.c,'新来的真实依赖','dependent');
  health.observe(pair,f.c,f.x,f.store.deliveryCounts(pair.id,f.c.id),unknown(),true);
  assert.deepEqual(health.peek(pair.id,f.c.id),[]);
  t.mock.timers.tick(300000);health.observe(pair,f.c,f.x,f.store.deliveryCounts(pair.id,f.c.id),unknown(),true);
  assert.equal(health.peek(pair.id,f.c.id).length,1);
  f.store.transition(task.id,'contextObserved');
  health.observe(pair,f.c,f.x,emptyDeliveryCounts(),unknown(),true);
  assert.deepEqual(health.peek(pair.id,f.c.id),[]);assert.deepEqual(health.notes(pair.id,f.c.id),[]);
});

test('消息已进入上下文但明确回复仍在等待时，最终通知复核保留真实依赖',async t=>{
  t.mock.timers.enable({apis:['Date'],now:1000000});const f=fixture(t),pair=f.store.pair(f.c.id,f.x.id),health=f.broker.deliveryHealth;
  const task=f.store.accept(pair,f.c,'需要回复的任务','reply-task',undefined,undefined,'explicit',true);f.store.transition(task.id,'contextObserved');
  (f.broker as any).runtimeHealth.deliveryAvailability=async()=>unknown();
  health.observe(pair,f.c,f.x,emptyDeliveryCounts(),unknown(),true,undefined,true);t.mock.timers.tick(300001);
  health.observe(pair,f.c,f.x,emptyDeliveryCounts(),unknown(),true,undefined,true);
  const notice=health.peek(pair.id,f.c.id)[0]!;assert.ok(notice);
  const prepared=await(f.broker as any).runtimeHealth.prepareNotices({host:'claude',sessionId:'c',callId:'final-review'},[notice.id],false);
  assert.equal(prepared.some((entry:any)=>entry.id===notice.id),true);
  assert.equal(health.get(pair.id,f.c.id,notice.id)?.state,'pending');
});

test('已读、取件 hook 和关联回复统一记录功能恢复，撤回未提交告警，旧 unknown 不重放',async t=>{
  t.mock.timers.enable({apis:['Date'],now:1000000});
  for(const path of ['observe','hook','reply'] as const){
    const f=fixture(t),pair=f.store.pair(f.c.id,f.x.id),old=f.store.accept(pair,f.c,'旧未知消息','old'),message=f.store.accept(pair,f.c,'当前消息','current');
    f.store.claim(old.id);f.store.transition(old.id,'unknown');f.store.claim(message.id);f.store.transition(message.id,'runtimeQueued');
    f.broker.deliveryHealth.observe(pair,f.c,f.x,f.store.deliveryCounts(pair.id,f.c.id),unknown(),true);
    t.mock.timers.tick(300001);f.broker.deliveryHealth.observe(pair,f.c,f.x,f.store.deliveryCounts(pair.id,f.c.id),unknown(),true);
    assert.equal(f.broker.deliveryHealth.peek(pair.id,f.c.id).length,1);
    if(path==='observe')await f.broker.dispatch('observe',{actor:{host:'codex',sessionId:'x',callId:'receipt'},message_id:message.id,state:'contextObserved'});
    else if(path==='hook')await f.broker.dispatch('hook',{actor:{host:'codex',sessionId:'x',callId:'pickup'},session_id:'x',hook_event_name:'PostToolUse',tool_name:'claude.receive_messages',tool_response:{messages:[{message_id:message.id,message:'当前消息'}]}});
    else f.broker.send({actor:{host:'codex',sessionId:'x',callId:'reply'},message:'已完成',in_reply_to:message.id},false);
    assert.equal(f.store.setting('functionalDelivery:'+f.x.id),Date.now(),path);
    assert.equal(f.broker.deliveryHealth.active(pair.id,f.c.id),false,path);
    assert.deepEqual(f.broker.deliveryHealth.peek(pair.id,f.c.id),[],path);
    assert.equal(f.store.message(old.id).state,'unknown');assert.equal(f.store.message(old.id).attempts,1);
  }
});

test('重启故障的旧时钟不升级刚发出的消息，真实依赖再持续五分钟仍会报告',t=>{
  t.mock.timers.enable({apis:['Date'],now:1000000});
  const f=fixture(t),pair=f.store.pair(f.c.id,f.x.id),health=new DeliveryHealth(f.store);
  health.observe(pair,f.c,f.x,emptyDeliveryCounts(),unknown(),true);t.mock.timers.tick(600001);
  const message=f.store.accept(pair,f.c,'新消息','fresh'),counts=f.store.deliveryCounts(pair.id,f.c.id);
  const observe=()=>health.observe(pair,f.c,f.x,counts,{state:'reachable',reasons:[],checked_at:Date.now()},true);
  observe();assert.deepEqual(health.peek(pair.id,f.c.id),[],'旧故障不让新消息立刻到第 3 档');
  t.mock.timers.tick(299999);observe();assert.deepEqual(health.peek(pair.id,f.c.id),[]);
  t.mock.timers.tick(1);observe();const notice=health.peek(pair.id,f.c.id)[0]!;assert.ok(notice);assert.match(notice.message,/5min \(awaiting context receipt\)/);assert.doesNotMatch(notice.message,/\(reachable\)/);
  assert.equal(f.store.message(message.id).state,'accepted');
});

test('后续已确认的投递不让历史 unknown 计入新依赖年龄；只有运行时入队不算上下文恢复',t=>{
  t.mock.timers.enable({apis:['Date'],now:1000000});
  const f=fixture(t),pair=f.store.pair(f.c.id,f.x.id),old=f.store.accept(pair,f.c,'旧消息','old');
  f.store.claim(old.id);f.store.transition(old.id,'unknown');t.mock.timers.tick(600001);
  const verified=f.store.accept(pair,f.c,'已确认消息','verified');f.store.transition(verified.id,'contextObserved');
  assert.equal(f.store.deliveryDependencySince(pair.id,f.x.id),undefined);
  t.mock.timers.tick(30001);const message=f.store.accept(pair,f.c,'新消息','fresh'),at=Date.now();f.store.transition(message.id,'runtimeQueued');
  assert.equal(f.store.setting('functionalDelivery:'+f.x.id),verified.updatedAt);
  assert.equal(f.store.deliveryDependencySince(pair.id,f.x.id),at);
  assert.equal(f.store.message(old.id).state,'unknown');
});

test('短暂故障恢复后，已经送达但尚未回复的长任务不冒充投递故障',t=>{
  t.mock.timers.enable({apis:['Date'],now:1000000});
  const f=fixture(t),pair=f.store.pair(f.c.id,f.x.id),health=f.broker.deliveryHealth;
  const task=f.broker.send({actor:{host:'claude',sessionId:'c',callId:'long-task'},message:'需要长时间处理的任务',reply_expected:true},false);
  f.store.transition(task.message_id,'contextObserved');assert.equal(f.store.expectedReplyFacts(pair.id,f.x.id).length,1);
  health.observe(pair,f.c,f.x,emptyDeliveryCounts(),unknown(),true,undefined,true);assert.equal(health.active(pair.id,f.c.id),true);
  t.mock.timers.tick(360000);health.observe(pair,f.c,f.x,emptyDeliveryCounts(),{state:'reachable',reasons:[],checked_at:Date.now()},true,undefined,true);
  assert.equal(health.active(pair.id,f.c.id),false);assert.deepEqual(health.peek(pair.id,f.c.id),[]);
  assert.equal(f.store.message(task.message_id).state,'contextObserved','任务仍在等回复，不伪造完成');
});
