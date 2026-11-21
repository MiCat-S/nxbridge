import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fixture } from './support/broker-fixture.js';
import { registration } from './support/registration.js';
import { modelError } from '../integration/mcp/model-output.js';
import {BridgeError} from '../shared/errors.js';

test('嵌入取件的宿主完成回执结算精确收件 ID，重复回执不回退或重投',async t=>{
  const f=fixture(t),x=f.store.register(registration('codex','embedded-receipt',{endpoint:{mode:'embedded',address:'',epoch:'receipt',pid:process.pid,procStart:'test'}})),pair=f.store.pair(f.c.id,x.id),actor={host:'codex' as const,sessionId:x.sessionId!,callId:'receive'};
  const message=f.store.accept(pair,f.c,'需要确认的正文','receipt'),other=f.store.accept(pair,x,'另一方向','other'),unproved=f.store.accept(pair,f.c,'没有工具输出证据','unproved');
  const response=f.broker.receive(actor) as any;assert.equal(f.store.message(message.id).state,'unknown');
  response.messages=response.messages.filter((m:any)=>m.message_id===message.id);response.messages.push({message_id:other.id});
  const hook={actor,session_id:x.sessionId,hook_event_name:'PostToolUse',tool_name:'mcp__claude__receive_messages',tool_response:{content:[{type:'text',text:JSON.stringify(response)}]}};
  await f.broker.dispatch('hook',hook);assert.equal(f.store.message(message.id).state,'contextObserved');assert.equal(f.store.message(other.id).state,'accepted');assert.equal(f.store.message(unproved.id).state,'unknown');
  f.store.transition(message.id,'responded','明确回信');await f.broker.dispatch('hook',hook);assert.equal(f.store.message(message.id).state,'responded');assert.equal(f.store.message(message.id).attempts,1);assert.equal(f.codex.delivered.length,0);
});

test('升级只修正持久宿主完成回执，不把 inbox 接受或其他未知投递冒充已见',t=>{
  const f=fixture(t),pair=f.store.pair(f.c.id,f.x.id),proof=f.store.accept(pair,f.c,'旧版工具完成','proof'),queued=f.store.accept(pair,f.c,'只有入队','queued'),unknown=f.store.accept(pair,f.c,'结果未知','unknown'),reverse=f.store.accept(pair,f.x,'非 Codex 方向','reverse');
  for(const m of [proof,queued,unknown,reverse]){f.store.claim(m.id);f.store.transition(m.id,m.id===unknown.id?'unknown':'runtimeQueued',m.id===proof.id||m.id===reverse.id?'宿主 PostToolUse 确认取件工具完成':'仅投递证据');}
  f.store.recoverEmbeddedReceipts();f.store.recoverEmbeddedReceipts();
  assert.equal(f.store.message(proof.id).state,'contextObserved');assert.equal(f.store.message(queued.id).state,'runtimeQueued');assert.equal(f.store.message(unknown.id).state,'unknown');assert.equal(f.store.message(reverse.id).state,'runtimeQueued');assert.equal(f.store.message(proof.id).attempts,1);
});

test('后续同方向上下文证据结束旧传输告警但保留历史未知，待投递消息仍告警',t=>{
  const f=fixture(t),pair=f.store.pair(f.c.id,f.x.id),old=f.store.accept(pair,f.c,'旧未知','old'),queued=f.store.accept(pair,f.c,'确实还在队列','queued');
  f.store.claim(old.id);f.store.transition(old.id,'unknown');f.store.claim(queued.id);f.store.transition(queued.id,'runtimeQueued');
  const reverse=f.store.accept(pair,f.x,'反向已见','reverse');f.store.transition(reverse.id,'contextObserved');assert.ok(f.store.deliveryIssueFacts(pair.id,f.x.id).some(m=>m.id===old.id));
  const newer=f.store.accept(pair,f.c,'后续已见','newer');f.store.transition(newer.id,'contextObserved');
  assert.deepEqual(f.store.deliveryIssueFacts(pair.id,f.x.id).map(m=>m.id),[queued.id]);assert.equal(f.store.message(old.id).state,'unknown');assert.equal(f.store.message(old.id).attempts,1);
  const recent=f.store.accept(pair,f.c,'新的未知仍需报告','recent');f.store.claim(recent.id);f.store.transition(recent.id,'unknown');assert.ok(f.store.deliveryIssueFacts(pair.id,f.x.id).some(m=>m.id===recent.id));
});

test('上下文切换通知只读不领取，最终提交保留未知且不在每个 hook 重放',async t=>{
  const f=fixture(t),endpoint={mode:'claude-inbox' as const,address:'inbox',epoch:'before',pid:123,procStart:'generation',configHome:path.resolve('/isolated','claude')},c=f.store.register(registration('claude','before',{endpoint}));f.store.pair(c.id,f.x.id);
  f.store.register(registration('claude','after',{endpoint:{...endpoint,epoch:'after'},contextStart:true,contextReason:'reset'}));
  const actor={host:'codex' as const,sessionId:f.x.sessionId!,callId:'monitor'},context_key='receipt-context';f.store.setSetting('hookContext:'+context_key,actor.sessionId);
  for(let i=0;i<2;i++){const r=await f.broker.dispatch('health.monitor',{actor,context_key,admit:false}) as any;assert.equal(r.notices.filter((n:any)=>n.source==='context_rotation').length,1);}
  const first=await f.broker.dispatch('health.monitor',{actor,context_key}) as any;assert.equal(first.notices.filter((n:any)=>n.source==='context_rotation').length,1);
  const again=await f.broker.dispatch('health.monitor',{actor,context_key}) as any;assert.equal(again.notices.filter((n:any)=>n.source==='context_rotation').length,0);
  assert.equal((f.store.events().find(e=>e.type==='context.notice.admitted')?.data as any)?.state,'unknown');
});

test('宿主身份错误保留根因，自更新不可核验指向原窗口而非插件重载',()=>{
  const generic=modelError(new BridgeError('process_identity_unknown','native ancestor generation changed'));
  assert.match(generic.message,/native ancestor generation changed/);assert.doesNotMatch(generic.message,/left running/);
  const update=modelError(new BridgeError('host_update_unverified','同目录入口不存在'));assert.match(update.message,/reopen.*original session/);assert.match(update.message,/reload cannot fix/);
});
