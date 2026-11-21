import test from 'node:test';
import assert from 'node:assert/strict';
import { FaultBoundary, SKIPPED } from '../broker/fault-boundary.js';
import { RuntimeIncidents, faultCause } from '../broker/health/runtime-incidents.js';
import {DeliveryHealth} from '../broker/health/delivery.js';
import {emptyDeliveryCounts} from '../broker/health/contracts.js';
import {DeliveryError} from '../shared/errors.js';
import { fixture } from './support/broker-fixture.js';

test('同步与异步跳过均保留故障次数，真正完成才解除退避',async()=>{
  let now=1000000;const faults=new FaultBoundary(()=>{},()=>now);
  for(const asyncMode of [false,true]){
    const stage=String(asyncMode),run=(work:()=>unknown)=>asyncMode?faults.run(stage,work):Promise.resolve(faults.sync(stage,work));
    for(let count=1;count<=4;count++){
      await run(()=>{throw Error('持续失败');});assert.equal(faults.status().find(v=>v.stage===stage)?.count,count);
      await run(()=>SKIPPED);assert.equal(faults.status().find(v=>v.stage===stage)?.count,count);now+=10000;
    }
    for(let tick=0;tick<16;tick++){now+=60000;await run(()=>SKIPPED);assert.equal(faults.status().find(v=>v.stage===stage)?.count,4,'持续核对但跳过的故障不会过期或冒充恢复');}
    await run(()=>true);assert.equal(faults.status().some(v=>v.stage===stage),false);
  }
});

test('broker 重试门槛不清零故障，握手不清除投递事件，实际送达并稳定后恢复',async t=>{
  t.mock.timers.enable({apis:['Date'],now:1000000});const f=fixture(t),pair=f.store.pair(f.c.id,f.x.id);
  const message=f.store.accept(pair,f.x,'须投递','fault');f.claude.fail=new DeliveryError('timeout','等待超时',false);
  for(let count=1;count<=3;count++){
    await f.broker.pump();assert.equal(f.broker.incidents.current(f.c,f.store.endpoint(f.c.id))?.attempts,count);
    for(let skip=0;skip<3;skip++)await f.broker.pump();
    assert.equal(f.store.faults.status().find(v=>v.stage==='delivery:'+f.c.id)?.count,count);
    t.mock.timers.tick(10001);
  }
  const incident=f.broker.incidents.current(f.c,f.store.endpoint(f.c.id))!;
  await f.broker.dispatch('status',{host:'codex',sessionId:'x',callId:'status'});
  assert.equal(f.broker.incidents.current(f.c,f.store.endpoint(f.c.id))?.id,incident.id);
  f.claude.fail=undefined;await f.broker.pump();assert.equal(f.store.message(message.id).state,'runtimeQueued');
  assert.equal(f.broker.incidents.current(f.c,f.store.endpoint(f.c.id))?.state,'recovering');
  t.mock.timers.tick(30000);assert.equal(f.broker.incidents.current(f.c,f.store.endpoint(f.c.id)),undefined);
});

test('瞬断观察五分钟，只为真实依赖生成一次被动提醒；功能恢复不制造恢复轮次',t=>{
  t.mock.timers.enable({apis:['Date'],now:1000000});const f=fixture(t),pair=f.store.pair(f.c.id,f.x.id),ledger=new RuntimeIncidents(f.store),health=new DeliveryHealth(f.store),counts={...emptyDeliveryCounts(),accepted:1};
  f.store.accept(pair,f.c,'实际待投递消息','dependency');
  const incident=ledger.failed(f.x,f.store.endpoint(f.x.id),new DeliveryError('disconnected','断连'));
  const observe=(state:'unknown'|'reachable'='unknown',functionalSuccessAt?:number)=>health.observe(pair,f.c,f.x,counts,{state,reasons:['disconnected'],checked_at:Date.now(),incident:ledger.current(f.x,f.store.endpoint(f.x.id)),functionalSuccessAt});
  observe();t.mock.timers.tick(299999);observe();assert.deepEqual(health.peek(pair.id,f.c.id),[]);
  t.mock.timers.tick(1);observe();const notice=health.peek(pair.id,f.c.id)[0]!;assert.equal(notice.tier,3);assert.equal(notice.wake,false);assert.equal(notice.incidentId,incident.id);
  assert.ok(health.prepare(pair.id,f.c.id,notice.id));health.outcome(pair.id,f.c.id,notice.id,'submitted');
  t.mock.timers.tick(600001);observe('reachable');assert.equal(health.active(pair.id,f.c.id),true);assert.deepEqual(health.peek(pair.id,f.c.id),[]);
  ledger.succeeded(f.x,f.store.endpoint(f.x.id));const at=Date.now();observe('reachable',at);t.mock.timers.tick(30000);observe('reachable',at);
  assert.equal(health.active(pair.id,f.c.id),false);assert.deepEqual(health.peek(pair.id,f.c.id),[]);
});

test('无任务的持续断连只供状态显示，确定性故障及时提醒并允许十五分钟后重新核验',t=>{
  t.mock.timers.enable({apis:['Date'],now:1000000});const f=fixture(t),pair=f.store.pair(f.c.id,f.x.id),ledger=new RuntimeIncidents(f.store),health=new DeliveryHealth(f.store);
  let incident=ledger.failed(f.x,f.store.endpoint(f.x.id),new DeliveryError('response_too_large','过大'));
  health.observe(pair,f.c,f.x,emptyDeliveryCounts(),{state:'blocked',reasons:[],checked_at:Date.now(),incident},true);
  t.mock.timers.tick(600000);health.observe(pair,f.c,f.x,emptyDeliveryCounts(),{state:'blocked',reasons:[],checked_at:Date.now(),incident},true);assert.deepEqual(health.peek(pair.id,f.c.id),[]);
  health.observe(pair,f.c,f.x,emptyDeliveryCounts(),{state:'blocked',reasons:[],checked_at:Date.now(),incident},true,undefined,true);assert.equal(health.peek(pair.id,f.c.id)[0]?.tier,3);
  assert.equal(ledger.canAttempt(f.x,f.store.endpoint(f.x.id)),false);t.mock.timers.tick(300000);assert.equal(ledger.canAttempt(f.x,f.store.endpoint(f.x.id)),true);
  incident=ledger.failed(f.x,f.store.endpoint(f.x.id),new DeliveryError('timeout','超时'));assert.equal(incident.attempts,2);
  assert.equal(faultCause(new DeliveryError('permission_probe_timeout','查询超时')).causeClass,'transient');
  assert.equal(faultCause(new DeliveryError('trust_required','需信任')).causeClass,'human');
});

test('托管恢复开始时撤销尚未准入的旧投递提醒',t=>{
  t.mock.timers.enable({apis:['Date'],now:1000000});const f=fixture(t),pair=f.store.pair(f.c.id,f.x.id),health=new DeliveryHealth(f.store),counts={...emptyDeliveryCounts(),unknown:1};
  const message=f.store.accept(pair,f.c,'实际待核验消息','dependency');f.store.claim(message.id);f.store.transition(message.id,'unknown');
  const observe=()=>health.observe(pair,f.c,f.x,counts,{state:'blocked',reasons:['断开'],checked_at:Date.now()});
  observe();t.mock.timers.tick(300001);observe();assert.equal(health.peek(pair.id,f.c.id).length,1);
  f.store.setSetting('managedRecovery:'+f.x.id,{pairId:pair.id,state:'recovering'});observe();assert.deepEqual(health.peek(pair.id,f.c.id),[]);assert.equal(health.active(pair.id,f.c.id),false);
});

test('仅显式回复约定进入依赖账本，FYI 不遮蔽待办，排队期间的发信不能结清未读约定',t=>{
  t.mock.timers.enable({apis:['Date'],now:1000000});const f=fixture(t),pair=f.store.pair(f.c.id,f.x.id);
  const task=f.store.accept(pair,f.c,'处理任务','task',undefined,undefined,'explicit',true);f.store.transition(task.id,'contextObserved');
  for(let i=0;i<5;i++){const info=f.store.accept(pair,f.c,'仅供参考','info'+i);f.store.transition(info.id,'contextObserved');}
  assert.deepEqual(f.store.expectedReplyFacts(pair.id,f.x.id).map(v=>v.id),[task.id]);
  const queued=f.store.accept(pair,f.c,'下一任务','queued',undefined,undefined,'explicit',true);t.mock.timers.tick(1);f.store.accept(pair,f.x,'处理完成','done',task.id);t.mock.timers.tick(1);f.store.transition(queued.id,'contextObserved');
  assert.deepEqual(f.store.expectedReplyFacts(pair.id,f.x.id).map(v=>v.id),[queued.id]);
  t.mock.timers.tick(1);f.store.accept(pair,f.x,'后续回复','reply');assert.deepEqual(f.store.expectedReplyFacts(pair.id,f.x.id),[]);
  assert.throws(()=>f.store.accept(pair,f.c,'处理任务','task',undefined,undefined,'explicit',false),{code:'idempotency_conflict'});
});
