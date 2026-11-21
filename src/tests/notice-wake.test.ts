import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdirSync } from 'node:fs';
import { fixture } from './support/broker-fixture.js';
import { registration } from './support/registration.js';
import { temporary } from './support/temporary.js';
import {DeliveryHealth} from '../broker/health/delivery.js';
import {emptyDeliveryCounts,type RuntimeNotice} from '../broker/health/contracts.js';
import { noticeCanWake,noticeTier } from '../broker/health/notice-policy.js';
import { HEALTH_WAKE_NOTICE } from '../types.js';

const passiveIssues=['contract_inactive','mod_missing','mod_stale','inbound_hold','inbound_refuse','launch_failed','history_receipt_unverified','continuation_failed','pickup_exhausted','wake_queue_unverified','hooks_blocked','hooks_timeout','hooks_missing','hooks_trust_required','hooks_untrusted','turn_failed','native_denied','delivery_accepted','delivery_sending','delivery_runtimeQueued','delivery_held','delivery_unknown','delivery_refused','delivery_expired','context_stuck','turn_retrying','tool_wait','turn_silent','progress_unverified'];
const passiveNotices=(subject:string):Partial<RuntimeNotice>[]=>[
  ...['bridge_restart','pair_lost','pair_changed','context_rotation','turn_health','future_kind'].map(kind=>({kind})),
  ...passiveIssues.map(issue=>({source:'pair_anomaly' as const,kind:`pair_anomaly:${subject}:${issue}`})),
];

for(const mode of ['embedded','websocket','unix'] as const)test(`${mode} 空闲 Codex 的信息类通知不启动轮次，旧信号被撤销，正常取件仍见事实`,async t=>{
                                      
  const parent=temporary(t);
  for(const [index,fields] of passiveNotices('claude-subject').entries())await t.test(fields.kind!,async sub=>{
    const f=fixture(sub),input=registration('codex','passive-'+index),home=path.join(parent,String(index));mkdirSync(home);
    input.endpoint={...input.endpoint,mode:mode==='embedded'?'embedded':'app-server',address:mode==='unix'?'unix://passive-test':mode==='websocket'?'ws://passive-test':'',configHome:home};
    const x=f.store.register(input),pair=f.store.pair(f.c.id,x.id),binding=f.store.bindings.current(x.id),actor={host:'codex' as const,sessionId:x.sessionId!,callId:'natural',...(binding?{binding:{key:binding.key,epoch:binding.epoch}}:{})};
    let queued=0;(f.broker as any).wakeSignals={signal:async()=>{queued++;return null;},consumed:()=>{}};
    const marker='保留到正常取件的事实'+index;
    f.broker.deliveryHealth.enqueue(pair.id,x.id,{id:'passive',state:'pending',message:marker,...fields});
    await (f.broker as any).runtimeHealth.checkDeliveryHealth();
    await (f.broker as any)[mode==='embedded'?'signalEmbeddedWake':'signalCodexWake'](x,f.store.endpoint(x.id));
    assert.equal(queued+f.codex.woken.length+f.codex.injected.length+f.claude.delivered.length,0);
    assert.equal(f.broker.deliveryHealth.get(pair.id,x.id,'passive')?.wake,false);
    const stale=await f.broker.dispatch('hook',{session_id:x.sessionId,actor,hook_event_name:'UserPromptSubmit',prompt:HEALTH_WAKE_NOTICE});
    assert.deepEqual(stale,{continue:false});
    assert.equal(f.broker.deliveryHealth.get(pair.id,x.id,'passive')?.admitted,undefined,'旧系统输入不能提前消耗信息通知');
    const received=await f.broker.dispatch('receive',actor) as any;
    assert.equal((received.notices??[]).some((n:any)=>n.message.includes(marker)),noticeTier({id:'passive',state:'pending',message:marker,...fields})>=3);
  });
});

test('明确行动类别按接收方判定，恢复和未知类别均静默',()=>{
  const notice=(fields:Partial<RuntimeNotice>):RuntimeNotice=>({id:'fact',state:'pending',message:'事实',...fields});
  assert.equal(noticeCanWake(notice({source:'idle_unanswered',kind:'idle_unanswered:other'}),'self'),false,'旧提醒缺少工作事件身份，只保留被动事实');
  assert.equal(noticeCanWake(notice({source:'idle_unanswered',kind:'idle_unanswered:other',wake:true,issueKey:'episode'}),'self'),false);
  assert.equal(noticeCanWake(notice({kind:'explicit_recovery'}),'self'),true);
  for(const issue of ['mod_missing','mod_stale']){
    const own=notice({source:'pair_anomaly',kind:'pair_anomaly:claude:'+issue});
    assert.equal(noticeCanWake(own,'claude'),false);assert.equal(noticeCanWake(own,'codex'),false);
  }
  assert.equal(noticeCanWake(notice({kind:'pair_anomaly:other:busy_unanswered'}),'self'),false);
  assert.equal(noticeCanWake(notice({kind:'pair_anomaly:other:busy_unanswered',phase:'recovery'}),'self'),false);
  assert.equal(noticeCanWake(notice({wake:true,kind:'future_kind'}),'self'),false,'旧字段不能绕过中央策略');
});

test('混合批次不依赖首项；最终行动已撤销时不消耗其余信息',t=>{
  const f=fixture(t),pair=f.store.pair(f.c.id,f.x.id),health=f.broker.deliveryHealth;
  health.enqueue(pair.id,f.x.id,{id:'info',kind:'runtime',state:'pending',message:'信息'});
  health.enqueue(pair.id,f.x.id,{id:'action',kind:'explicit_recovery',state:'pending',message:'行动'});
  assert.equal(health.peek(pair.id,f.x.id)[0]!.wake,true);
  health.cancel(pair.id,f.x.id,'action');
  assert.equal(health.prepare(pair.id,f.x.id,'info',undefined,false,true),undefined);
  assert.equal(health.get(pair.id,f.x.id,'info')?.admitted,undefined);
  assert.equal(health.prepare(pair.id,f.x.id,'info')?.message,'信息');
});

test('重启的事实身份使用消息编号和状态，跨实例及历史裁剪仍只提供一次',t=>{
  t.mock.timers.enable({apis:['Date'],now:1000000});
  const f=fixture(t),pair=f.store.pair(f.c.id,f.x.id),counts={...emptyDeliveryCounts(),unknown:2},facts=[{id:'first',state:'unknown'},{id:'second',state:'unknown'}];
  let health=new DeliveryHealth(f.store);health.restarted(pair,f.x,counts,facts,1);
  assert.equal(health.peek(pair.id,f.x.id).length,0);assert.equal(health.notes(pair.id,f.x.id).length,1);
  health.enqueue(pair.id,f.x.id,{id:'later',state:'pending',kind:'runtime',message:'后续信息'});
  t.mock.timers.tick(600001);health=new DeliveryHealth(f.store);health.restarted(pair,f.x,counts,[...facts].reverse(),0);
  assert.equal(health.peek(pair.id,f.x.id)[0]?.message,'后续信息');
  assert.equal(f.store.events(0,1000).filter(e=>e.type==='health.delivery.restart').length,1);
  health.restarted(pair,f.x,counts,[facts[0]!,{id:'new-message-same-count',state:'unknown'}],0);
  assert.equal(f.store.events(0,1000).filter(e=>e.type==='health.delivery.restart').length,2);
  assert.match(health.notes(pair.id,f.x.id)[0]!.text,/bridge restarted/);
});

test('真实 Mod 缺失路由的 Codex 副本是被动通知，不借助旧回执故障唤醒',async t=>{
  const f=fixture(t),pair=f.store.pair(f.c.id,f.x.id);
  f.broker.pairAnomalies.integration(f.c,{mcp:true});f.broker.pairAnomalies.observe(pair,f.c);
  const pending=f.broker.deliveryHealth.peek(pair.id,f.x.id)[0]!;
  assert.match(pending.message,/Mod/);assert.equal(pending.wake,false);
  await (f.broker as any).runtimeHealth.checkDeliveryHealth();
  assert.equal(f.codex.woken.length+f.codex.injected.length,0);
  const result=await f.broker.dispatch('receive',{host:'codex',sessionId:f.x.sessionId,callId:'natural-mod'}) as any;
  assert.ok(result.notices.some((n:any)=>n.message.includes('Mod')));
});

test('升级前的信息类注入续跑预约被撤销，原生历史仍保留',async t=>{
  const f=fixture(t),pair=f.store.pair(f.c.id,f.x.id),endpoint=f.store.endpoint(f.x.id)!,health=f.broker.deliveryHealth;
  health.enqueue(pair.id,f.x.id,{id:'old-info',state:'pending',kind:'bridge_restart',message:'已注入的信息',admitted:true});
  f.store.setSetting('codexDirect:'+f.x.id,{scope:JSON.stringify([pair.id,JSON.stringify([f.x.sessionId,endpoint.epoch])]),attempts:[],continuation:{anchor:'nxbridge-old-info',attempts:0,at:0}});
  await (f.broker as any).signalCodexWake(f.x,endpoint);
  assert.equal(f.codex.woken.length,0);assert.equal((f.broker as any).codexDirect.status(f.x.id).continuation,undefined);
});

test('未知消息的同一事实重新建立事件也不重复提交，新消息集合仍可通知',t=>{
  t.mock.timers.enable({apis:['Date'],now:1000000});
  const f=fixture(t),pair=f.store.pair(f.c.id,f.x.id),notice={id:'before',state:'pending' as const,source:'pair_anomaly' as const,kind:`pair_anomaly:${f.c.id}:delivery_unknown`,factKey:JSON.stringify([pair.id,'old']),message:'旧未知消息'};
  let health=new DeliveryHealth(f.store);health.enqueue(pair.id,f.x.id,notice);assert.ok(health.prepare(pair.id,f.x.id,notice.id));
  t.mock.timers.tick(600001);health=new DeliveryHealth(f.store);health.enqueue(pair.id,f.x.id,{...notice,id:'after',message:'重启后重新建立的同一事实'});
  assert.equal(health.hasPending(pair.id,f.x.id),false);
  health.enqueue(pair.id,f.x.id,{...notice,id:'changed',factKey:JSON.stringify([pair.id,'new'])});assert.equal(health.peek(pair.id,f.x.id).length,1);
});

test('新的可达性故障只撤销旧故障分量，不吞掉待取件的重启事实',t=>{
  const f=fixture(t),pair=f.store.pair(f.c.id,f.x.id),health=f.broker.deliveryHealth;
  health.enqueue(pair.id,f.x.id,{id:'restart',state:'pending',kind:'bridge_restart',message:'仍须正常取件的重启事实'});
  health.observe(pair,f.x,f.c,emptyDeliveryCounts(),{state:'blocked',reasons:['inbox unreachable'],checked_at:Date.now()},true);
  assert.deepEqual(health.peek(pair.id,f.x.id),[]);assert.match(health.notes(pair.id,f.x.id)[0]!.text,/仍须正常取件的重启事实/);
});

for(const mode of ['embedded','websocket','unix'] as const)test(`${mode} 明确授权恢复仍能唤醒一次并保留被动分量`,async t=>{
  const f=fixture(t),input=registration('codex','action-'+mode);input.endpoint={...input.endpoint,mode:mode==='embedded'?'embedded':'app-server',address:mode==='unix'?'unix://action-test':mode==='websocket'?'ws://action-test':'',configHome:temporary(t)};
  const x=f.store.register(input),pair=f.store.pair(f.c.id,x.id);let queued=0;
  (f.broker as any).wakeSignals={signal:async()=>{queued++;return null;}};
  f.broker.deliveryHealth.enqueue(pair.id,x.id,{id:'first-passive',state:'pending',kind:'info',message:'附带信息'});
  f.broker.deliveryHealth.enqueue(pair.id,x.id,{id:'required-action',state:'pending',kind:'explicit_recovery',message:'继续已授权任务'});
  await (f.broker as any).runtimeHealth.checkDeliveryHealth();
  assert.equal(queued+f.codex.woken.length,1);
  if(mode==='unix')assert.match(f.codex.injectedNotices[0]!.body,/附带信息\n继续已授权任务/);
});
