import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './support/broker-fixture.js';
import { registration } from './support/registration.js';

test('压缩后按编号重读双向及归档消息：正文快照和回复链接保留，账本完全不变',async t=>{
  const f=fixture(t),pair=f.store.pair(f.c.id,f.x.id),actor={host:'codex',sessionId:'x',callId:'history'};
  const incoming=f.store.accept(pair,f.c,'nxref:msg:source','incoming');f.broker.references.snapshot(incoming,'已展开的原任务');f.store.transition(incoming.id,'contextObserved');
  const outgoing=f.store.accept(pair,f.x,'原任务处理结果','outgoing',incoming.id);f.store.unpair(pair.id);
  const next=f.store.register(registration('claude','next')),current=f.store.pair(next.id,f.x.id),task=f.store.accept(current,next,'最新纠正','new');
  const before={messages:f.store.messages(),events:f.store.events(),facts:f.store.setting('healthNoticeAdmission:'+f.x.id)};
  const result:any=await f.broker.dispatch('messages.read',{actor,message_ids:[task.id,incoming.id,outgoing.id]});
  assert.deepEqual(result.messages.map((m:any)=>m.message_id),[task.id,incoming.id,outgoing.id]);assert.deepEqual(result.unavailable,[]);
  assert.equal(result.messages[1].message,'已展开的原任务');assert.equal(result.messages[1].direction,'incoming');assert.equal(result.messages[2].direction,'outgoing');assert.equal(result.messages[2].in_reply_to,incoming.id);
  assert.deepEqual({messages:f.store.messages(),events:f.store.events(),facts:f.store.setting('healthNoticeAdmission:'+f.x.id)},before);
});

test('历史读取不能跨窗口取私信；不存在和无权限统一返回 unavailable',async t=>{
  const f=fixture(t),c=f.store.register(registration('claude','other-c')),x=f.store.register(registration('codex','other-x')),other=f.store.pair(c.id,x.id),privateMessage=f.store.accept(other,c,'其他窗口的私密任务','private');
  const response:any=await f.broker.dispatch('messages.read',{actor:{host:'codex',sessionId:'x',callId:'denied'},message_ids:[privateMessage.id,'absent']});
  assert.deepEqual(response,{messages:[],unavailable:[privateMessage.id,'absent']});assert.doesNotMatch(JSON.stringify(response),/私密任务/);
  await assert.rejects(f.broker.dispatch('messages.read',{actor:{host:'codex',sessionId:'x',callId:'child',via:'subagent'},message_ids:[privateMessage.id]}),{code:'subagent_denied'});
  for(const message_ids of [[],Array(21).fill('id')])await assert.rejects(f.broker.dispatch('messages.read',{actor:{host:'codex',sessionId:'x',callId:'bound'},message_ids}));
});
