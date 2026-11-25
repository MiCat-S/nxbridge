import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './support/broker-fixture.js';
import { registration } from './support/registration.js';
import {DeliveryHealth} from '../broker/health/delivery.js';
import {emptyDeliveryCounts} from '../broker/health/contracts.js';
import { modMonitorAdmission } from '../integration/mod/mod-protocol.js';
import {writeFileSync} from 'node:fs';
import path from 'node:path';
import {temporary} from './support/temporary.js';

const availability=(blocked:boolean)=>({state:blocked?'blocked' as const:'reachable' as const,reasons:blocked?['隔离故障']:[],checked_at:Date.now()});

test('未上报 revision 的旧 Mod 获取已准入正文，继续遵守统一一分钟闸门',async t=>{
  t.mock.timers.enable({apis:['Date'],now:1000000});
  const f=fixture(t),pair=f.store.pair(f.c.id,f.x.id),actor={host:'claude',sessionId:'c',callId:'legacy-monitor'};
  f.codex.probe=async()=>availability(false);
  f.broker.pairAnomalies.integration(f.x,{hookError:'旧 Mod 正文验证'});f.broker.pairAnomalies.observe(pair,f.x);
  const read=()=>f.broker.dispatch('health.monitor',{actor,admit:modMonitorAdmission({operation:'monitor'})}) as Promise<any>;
  const first=await read();assert.equal(first.notices.length,1);assert.match(first.notices[0].message,/旧 Mod 正文验证/);
  assert.equal(f.store.setting<any>('healthNoticeAdmission:'+f.c.id)?.lastAt,Date.now());
  f.broker.pairAnomalies.integration(f.x,{hook:true});f.broker.pairAnomalies.observe(pair,f.x);
  f.broker.pairAnomalies.integration(f.x,{hookError:'已恢复后新发生的故障'});f.broker.pairAnomalies.observe(pair,f.x);
  assert.equal(f.broker.deliveryHealth.hasPending(pair.id,f.c.id),true,'新故障确实存在，不能把无通知当作限流');
  assert.deepEqual((await read()).notices,[],'旧协议也不能绕过统一准入间隔');
  assert.equal(f.store.setting<any>('healthNoticeAdmission:'+f.c.id)?.lastAt,Date.now());
});

test('已上报 revision 的当前 Mod 只获取信号，最终准备时撤销已恢复条件',async t=>{
  const f=fixture(t),pair=f.store.pair(f.c.id,f.x.id),actor={host:'claude',sessionId:'c',callId:'current-monitor'},mod_revision='0123456789abcdef';
  f.codex.probe=async()=>availability(false);
  f.broker.pairAnomalies.integration(f.x,{hookError:'最终准备前已恢复'});f.broker.pairAnomalies.observe(pair,f.x);
  const picked:any=await f.broker.dispatch('health.monitor',{actor,admit:modMonitorAdmission({operation:'monitor',mod_revision})});
  assert.equal(picked.notices.length,1);assert.equal(picked.notices[0].message,undefined);
  assert.equal(f.broker.deliveryHealth.get(pair.id,f.c.id,picked.notices[0].id)?.state,'pending','只读信号不能提前领取通知，迟到响应仍可回退');
  assert.deepEqual((await f.broker.dispatch('health.monitor',{actor,admit:false}) as any).notices,picked.notices);
  assert.equal(f.store.setting('healthNoticeAdmission:'+f.c.id),undefined,'取信号时不得提前准入');
  f.broker.pairAnomalies.integration(f.x,{hook:true});
  const final:any=await f.broker.dispatch('health.monitor',{actor,notice_id:picked.notices[0].id,admit:modMonitorAdmission({operation:'monitor-prepare',mod_revision})});
  assert.deepEqual(final.notices,[]);assert.equal(f.store.setting('healthNoticeAdmission:'+f.c.id),undefined);
});

test('故障在领取前或领取后恢复，均丢弃未提交的告警和恢复',t=>{
  const f=fixture(t),pair=f.store.pair(f.c.id,f.x.id),health=new DeliveryHealth(f.store);
  for(const claimed of [false,true]){
    health.observe(pair,f.c,f.x,emptyDeliveryCounts(),availability(true),true);
    const notice=claimed?health.take(pair.id,f.c.id)[0]:undefined;
    health.observe(pair,f.c,f.x,emptyDeliveryCounts(),availability(false),true);
    assert.deepEqual(health.take(pair.id,f.c.id),[]);
    if(notice)assert.equal(health.prepare(pair.id,f.c.id,notice.id),undefined);
  }
  assert.equal(f.store.messages().length,0);
});

test('并行探测逆序返回不重新打开已由功能证据结清的事件',t=>{
  t.mock.timers.enable({apis:['Date'],now:1000000});
  const f=fixture(t),pair=f.store.pair(f.c.id,f.x.id),health=new DeliveryHealth(f.store),observe=(bad:boolean,at:number,functionalSuccessAt?:number)=>health.observe(pair,f.c,f.x,{...emptyDeliveryCounts(),accepted:1},{...availability(bad),checked_at:at,functionalSuccessAt},true);
  f.store.accept(pair,f.c,'尚未送达的真实依赖','pending');
  for(let round=0;round<2;round++){
    t.mock.timers.tick(600001);observe(true,Date.now());t.mock.timers.tick(300000);
    observe(true,Date.now());const alert=health.take(pair.id,f.c.id)[0]!;assert.ok(alert);assert.ok(health.prepare(pair.id,f.c.id,alert.id));health.outcome(pair.id,f.c.id,alert.id,'unknown');
    const functional=Date.now();observe(false,functional,functional);t.mock.timers.tick(30000);observe(false,Date.now(),functional);observe(true,functional-1);
    assert.equal(health.active(pair.id,f.c.id),false);assert.deepEqual(health.take(pair.id,f.c.id),[]);
  }
});

test('短暂无法核验保持静默，真实依赖持续五分钟才被动报告，文字不猜测死亡',t=>{
  t.mock.timers.enable({apis:['Date'],now:1000000});
  const f=fixture(t),pair=f.store.pair(f.c.id,f.x.id),health=new DeliveryHealth(f.store),observe=(state:'unknown'|'blocked')=>health.observe(pair,f.c,f.x,{...emptyDeliveryCounts(),accepted:1},{state,reasons:['generation query over budget'],checked_at:Date.now()},true);
  f.store.accept(pair,f.c,'尚未送达的真实依赖','pending');
  observe('unknown');for(let i=0;i<5;i++){t.mock.timers.tick(59999);observe('unknown');assert.deepEqual(health.take(pair.id,f.c.id),[]);}
  t.mock.timers.tick(5);observe('unknown');const alert=health.take(pair.id,f.c.id)[0]!;assert.match(alert.message,/delivery remains unconfirmed/);assert.doesNotMatch(alert.message,/undeliverable now|exited|offline/);assert.equal(alert.wake,false);
});

test('已提交但回执未知的告警不重放，功能恢复后不生成额外模型恢复消息',t=>{
  t.mock.timers.enable({apis:['Date'],now:1000000});
  const f=fixture(t),pair=f.store.pair(f.c.id,f.x.id),health=new DeliveryHealth(f.store);
  f.store.accept(pair,f.c,'尚未送达的真实依赖','pending');
  const counts={...emptyDeliveryCounts(),accepted:1};health.observe(pair,f.c,f.x,counts,availability(true),true);t.mock.timers.tick(300000);health.observe(pair,f.c,f.x,counts,availability(true),true);
  const alert=health.take(pair.id,f.c.id)[0]!;assert.ok(health.prepare(pair.id,f.c.id,alert.id));
  health.outcome(pair.id,f.c.id,alert.id,'unknown');assert.deepEqual(health.take(pair.id,f.c.id),[]);
  const functional=Date.now();health.observe(pair,f.c,f.x,counts,{...availability(false),functionalSuccessAt:functional},true);t.mock.timers.tick(30000);
  health.observe(pair,f.c,f.x,counts,{...availability(false),functionalSuccessAt:functional},true);assert.equal(health.active(pair.id,f.c.id),false);assert.deepEqual(health.take(pair.id,f.c.id),[]);
});

test('最终消费重查 hooks 证据，不提交已领取的陈旧正文',async t=>{
  const f=fixture(t),pair=f.store.pair(f.c.id,f.x.id);
  f.broker.pairAnomalies.integration(f.x,{hookError:'old-hook-error'});f.broker.pairAnomalies.observe(pair,f.x);
  const claimed=f.broker.deliveryHealth.take(pair.id,f.c.id)[0]!;assert.match(claimed.message,/old-hook-error/);
  f.broker.pairAnomalies.integration(f.x,{hook:true});
  const result=await (f.broker as any).runtimeHealth.healthNotice(pair.id,f.x,claimed.id,claimed.message,claimed.source);
  assert.equal(result,'denied');assert.equal(f.claude.delivered.length,0);assert.equal(f.broker.deliveryHealth.hasPending(pair.id,f.c.id),false);
});

test('异步探测中条件恢复，最后一次校验仍拒绝旧通知',async t=>{
  const f=fixture(t),pair=f.store.pair(f.c.id,f.x.id);f.broker.pairAnomalies.integration(f.x,{hookError:'stale'});f.broker.pairAnomalies.observe(pair,f.x);
  let entered!:()=>void,release!:()=>void;
  const ready=new Promise<void>(resolve=>entered=resolve),gate=new Promise<void>(resolve=>release=resolve);
  f.codex.probe=async()=>{entered();await gate;return availability(false);};
  const result=f.broker.dispatch('health.monitor',{actor:{host:'claude',sessionId:'c',callId:'probe'}});await ready;
  f.broker.pairAnomalies.integration(f.x,{hook:true});release();
  assert.deepEqual((await result as any).notices,[]);
  f.codex.probe=async()=>availability(false);
  const opaque:any=await f.broker.dispatch('health.monitor',{actor:{host:'claude',sessionId:'c',callId:'claim'},admit:false});
  assert.ok(opaque.notices.every((notice:any)=>notice.message===undefined));
});

test('旧 turn-health 路径在消费时复核进展，未提交的告警及恢复一并丢弃',async t=>{
  t.mock.timers.enable({apis:['Date'],now:1000000});
  const file=path.join(temporary(t),'native.jsonl');
  writeFileSync(file,JSON.stringify({type:'session_meta',payload:{id:'x'}})+'\n'+JSON.stringify({timestamp:new Date().toISOString(),type:'event_msg',payload:{type:'task_started',turn_id:'native-turn'}})+'\n','utf8');
  const f=fixture(t),pair=f.store.pair(f.c.id,f.x.id),endpoint=f.store.endpoint(f.x.id)!,thread={id:'x',path:file,turns:[{id:'native-turn',status:'inProgress',items:[]}]};
  const task=f.store.accept(pair,f.c,'仍阻塞的显式任务','task',undefined,undefined,'explicit',true);f.store.transition(task.id,'contextObserved');
  f.store.updatePeer(f.x.id,{state:'busy'});f.broker.health.read(endpoint.address,thread);t.mock.timers.tick(900001);
  f.codex.connect=async()=>({request:async(method:string)=>method==='thread/turns/list'?{data:thread.turns}:method==='thread/items/list'?{data:[]}:{thread}}) as any;
  await (f.broker as any).runtimeHealth.checkPairTurnHealth(pair,false);
  const notice=f.broker.deliveryHealth.take(pair.id,f.c.id).find(n=>n.source==='turn_health')!;assert.ok(notice);
  f.broker.health.observe(endpoint.address,{method:'item/agentMessage/delta',params:{threadId:'x',turnId:'native-turn',delta:'新进展'}});
  assert.equal(await (f.broker as any).runtimeHealth.healthNotice(pair.id,f.x,notice.id,notice.message,notice.source),'denied');assert.equal(f.claude.delivered.length,0);
  assert.deepEqual(f.broker.deliveryHealth.take(pair.id,f.c.id),[]);
});

test('已排队旧配对通知在最终出口被丢弃，新配对收不到已释放搭档的告警',async t=>{
  const f=fixture(t),old=f.store.pair(f.c.id,f.x.id);f.broker.pairAnomalies.integration(f.x,{hookError:'已归档搭档的告警'});f.broker.pairAnomalies.observe(old,f.x);
  const claimed=f.broker.deliveryHealth.take(old.id,f.c.id)[0]!;assert.ok(claimed);
  let entered!:()=>void,finish!:()=>void;const enteredDelivery=new Promise<void>(resolve=>entered=resolve),gate=new Promise<void>(resolve=>finish=resolve),deliver=f.claude.deliver.bind(f.claude);
  f.claude.deliver=async(...args)=>{entered();await gate;return deliver(...args);};
  const pending=(f.broker as any).runtimeHealth.healthNotice(old.id,f.x,claimed.id,claimed.message,claimed.source);await enteredDelivery;
  const replacement=f.store.register(registration('codex','replacement')),pair=f.store.pair(f.c.id,replacement.id,true);finish();
  assert.equal(await pending,'denied');assert.equal(f.claude.delivered.length,0);assert.equal(f.store.pairFor(f.c.id)?.id,pair.id);
  const monitor=await f.broker.dispatch('health.monitor',{actor:{host:'claude',sessionId:'c',callId:'old-pickup'},notice_id:claimed.id});assert.deepEqual((monitor as any).notices,[]);
});
