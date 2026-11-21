import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './support/broker-fixture.js';
import { registration } from './support/registration.js';
import { temporary } from './support/temporary.js';
import {HEALTH_WAKE_NOTICE} from '../types.js';
import {deliveryHealthKey,type RuntimeNotice} from '../broker/health/contracts.js';

for(const mode of ['embedded','websocket','unix'] as const)test(mode+'：Claude 终态失败唤醒 Codex，原生取件只消费一次且不伪造搭档消息',async t=>{
  t.mock.timers.enable({apis:['Date'],now:1000000});const f=fixture(t),input=registration('codex','terminal-'+mode);
  input.endpoint={...input.endpoint,mode:mode==='embedded'?'embedded':'app-server',address:mode==='unix'?'unix://terminal-test':mode==='websocket'?'ws://terminal-test':'',configHome:temporary(t)};
  const x=f.store.register(input),pair=f.store.pair(f.c.id,x.id),failed={turnId:'failed-turn',state:'failed' as const,completion:'failed',lastProgressAt:Date.now(),lastEventAt:Date.now(),tools:[],error:'模型重试已经耗尽'};
  f.store.saveEndpoint({...f.store.endpoint(f.c.id)!,nativeHealth:failed});
  let queued=0;(f.broker as any).wakeSignals={signal:async()=>{queued++;return null;},consumed:()=>{}};
  (f.broker as any).runtimeHealth.refreshNoticeConditions(pair,'terminal-test');
  assert.equal(f.broker.deliveryHealth.peek(pair.id,x.id).some(n=>n.kind?.endsWith(':turn_failed')),false,'给原生新轮次和正常投递保留稳定期');
  t.mock.timers.tick(31000);(f.broker as any).runtimeHealth.refreshNoticeConditions(pair,'terminal-test');
  const notice=f.broker.deliveryHealth.peek(pair.id,x.id).find(n=>n.kind?.endsWith(':turn_failed'))!;
  assert.ok(notice);assert.equal(notice.tier,4);assert.equal(notice.wake,true);
  await(f.broker as any).runtimeHealth.checkDeliveryHealth();
  assert.equal(queued+f.codex.woken.length,1);
  const binding=f.store.bindings.current(x.id),actor={host:'codex' as const,sessionId:x.sessionId!,callId:'notice-pickup',...(binding?{binding:{key:binding.key,epoch:binding.epoch}}:{})};
  if(mode==='unix'){
    assert.match(f.codex.injectedNotices[0]!.body,/failed-turn/);
  }else{
    const pickup=mode==='embedded'?await f.broker.dispatch('hook',{session_id:x.sessionId,actor,hook_event_name:'UserPromptSubmit',prompt:HEALTH_WAKE_NOTICE}):await f.broker.dispatch('receive',actor);
    assert.match(JSON.stringify(pickup),/failed-turn/);
    if(mode==='embedded')assert.match((pickup as any).hookSpecificOutput.additionalContext,/source=pair_anomaly/);
    else{
      const receipt={content:[{type:'text',text:JSON.stringify(pickup)}]};
      await f.broker.dispatch('hook',{session_id:x.sessionId,actor:{...actor,callId:'receipt'},hook_event_name:'PostToolUse',tool_name:'claude.receive_messages',tool_response:receipt});
    }
    await f.broker.dispatch('hook',{session_id:x.sessionId,actor,hook_event_name:'Stop'});
  }
  const recorded=f.store.setting<{notices:RuntimeNotice[]}>(deliveryHealthKey(pair.id,x.id))!.notices.find(n=>n.id===notice.id)!;
  assert.equal(recorded.admitted,true);assert.equal(f.broker.deliveryHealth.get(pair.id,x.id,notice.id),undefined);
  assert.equal(f.broker.deliveryHealth.due(pair.id,x.id),false);
  assert.equal(f.store.peer(x.id).state,'ready','验证去重前收件方已经空闲，不能靠忙碌门槛阻止重复唤醒');
  t.mock.timers.tick(600001);(f.broker as any).runtimeHealth.refreshNoticeConditions(pair,'terminal-repeat');await(f.broker as any).runtimeHealth.checkDeliveryHealth();
  assert.equal(queued+f.codex.woken.length,1,'同一失败即使跨过同类限频也不会再次唤醒');
  assert.equal(f.store.messages().length,0,'系统事实不写入搭档发信账本');
});
