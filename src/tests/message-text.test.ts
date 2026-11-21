import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Store } from '../storage/store.js';
import { References } from '../broker/delivery/references.js';
import type { NativeApproval } from '../hosts/claude/claude-inbound.js';
import { registration } from './support/registration.js';
import { temporaryDirectory } from './support/temporary.js';

test('含 NUL 的 UTF-8 正文持久保存后完整读取，重试仍幂等且保留 TEXT 格式',t=>{
  const temp=temporaryDirectory(),filename=path.join(temp.directory,'messages.db');let store=new Store(filename);
  t.after(async()=>{store.close();await temp.cleanup();});
  const c=store.register(registration('claude','nul-c')),x=store.register(registration('codex','nul-x')),pair=store.pair(c.id,x.id);
  const bodies=['\0开头\0中文🙂结尾\0','\uFEFF前缀\0后缀'];
  const messages=bodies.map((body,index)=>{
    const message=store.accept(pair,c,body,'nul-'+index);assert.equal(message.body,body);
    assert.equal(store.accept(pair,c,body,'nul-'+index).id,message.id);
    assert.equal(store.messageByCall(c.id,'nul-'+index)?.body,body);
    return message;
  });
  assert.deepEqual(store.messages().map(message=>message.body),bodies);
  assert.deepEqual(store.messagesFor(pair.id).map(message=>message.body),bodies);
  assert.deepEqual(store.pending(x.id).map(message=>message.body),bodies);
  assert.deepEqual(store.pendingFacts(x.id).map(facts=>store.pendingMessage(facts)?.body),bodies);
  const db=new DatabaseSync(filename,{readOnly:true});
  try{
    const rows=db.prepare('SELECT typeof(body) AS storage,hex(body) AS bytes FROM messages ORDER BY rowid').all();
    assert.deepEqual(rows.map(row=>row.storage),['text','text']);
    assert.deepEqual(rows.map(row=>row.bytes),bodies.map(body=>Buffer.from(body).toString('hex').toUpperCase()));
  }finally{db.close();}
  store.close();store=new Store(filename);
  for(const [index,message] of messages.entries()){
    assert.equal(store.message(message.id).body,bodies[index]);
    assert.equal(store.accept(pair,c,bodies[index]!,'nul-'+index).id,message.id);
  }
  assert.equal(store.messages().length,bodies.length);
});

test('含 NUL 正文在未答、未知、审批及引用候选查询中保持完整',t=>{
  const store=new Store(':memory:');t.after(()=>store.close());
  const c=store.register(registration('claude','nul-c')),x=store.register(registration('codex','nul-x')),pair=store.pair(c.id,x.id),body='原始\0中文🙂正文';
  store.setSetting('replyContract:'+x.id,{at:0,boundary:[]});
  const seen=store.accept(pair,c,body,'seen');store.transition(seen.id,'contextObserved');
  assert.equal(store.seenUnanswered(pair.id,x.id)[0]?.body,body);
  const uncertain=store.accept(pair,x,body,'unknown');store.claim(uncertain.id);store.transition(uncertain.id,'unknown');
  assert.equal(store.uncertain()[0]?.body,body);
  const approval:NativeApproval={receivedAt:Date.now(),durationVerified:true,scope:'nul-test',noticeIds:[]};
  store.setSetting('claudeApproval:'+uncertain.id,approval);
  assert.equal(store.inboundApprovals()[0]?.message.body,body);
  assert.deepEqual(store.referenceCandidates(c.id,pair.id).map(candidate=>candidate.text),[body,body]);
  const refs=new References(store),expanded='\uFEFF展开\0快照🙂';refs.snapshot(seen,expanded);refs.capture(c,'agent','子代理\0答案');
  const candidates=store.referenceCandidates(c.id,pair.id);
  assert.equal(candidates.find(candidate=>candidate.id===seen.id)?.text,expanded);
  assert.equal(candidates.find(candidate=>candidate.id==='agent')?.text,'子代理\0答案');
  assert.equal(refs.message(store.message(seen.id)),expanded);
});
