import test from 'node:test';
import { VERSION } from '../version.js';
import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';
import { spawn } from 'node:child_process';
import { fixture } from './support/broker-fixture.js';
import { registration } from './support/registration.js';
import { temporaryDirectory } from './support/temporary.js';
import { Store } from '../storage/store.js';
import { References } from '../broker/delivery/references.js';
import {PACKAGE_ROOT} from '../shared/package-location.js';
import path from 'node:path';
import { encodePeerMessage } from '../hosts/claude/claude-inbox.js';

const database=(store:Store)=>(store as unknown as {db:DatabaseSync}).db;

test('自动回复核对冻结的引用展开正文，引用字面量或缺失快照不会建立关联',async t=>{
  const {store,broker,c,x}=fixture(t);store.pair(c.id,x.id);
  broker.references.capture(x,'child','原始</cross-session-message>任务');
  const original=broker.send({actor:{host:'codex',sessionId:'x',callId:'task'},message:'nxref:agent:child'},false),task=store.message(original.message_id);
  const appended=(encodePeerMessage({...task,body:broker.references.message(task)},x,'c').message as {content:string}).content;
  broker.references.capture(x,'child','更新后的答案');
  const send=(callId:string,auto_reply_text:string)=>broker.send({actor:{host:'claude',sessionId:'c',callId},message:'回复',auto_reply_to:task.id,auto_reply_text},false);
  assert.equal(store.message(send('literal',`[nxbridge message_id=${task.id}]${task.body}`).message_id).inReplyTo,null);
  assert.equal(store.message(send('snapshot',appended).message_id).inReplyTo,task.id);
  database(store).prepare('DELETE FROM settings WHERE key=?').run('ref:message:'+task.id);
  assert.equal(store.message(send('expired',appended).message_id).inReplyTo,null,'软关联证据失效不能阻断正常发信');
});

test('embedded 单条快照缺失不会回滚整批，坏记录不占 20 条取件额度',t=>{
  const {store,broker,c,x}=fixture(t),pair=store.pair(c.id,x.id),bad=[];
  store.saveEndpoint({...store.endpoint(c.id)!,mode:'embedded'});
  for(let i=0;i<21;i++){
    const m=store.accept(pair,x,'nxref:agent:child','missing-'+i);broker.references.snapshot(m,'完整正文');
                                    
    database(store).prepare('DELETE FROM settings WHERE key=?').run('ref:message:'+m.id);bad.push(m.id);
  }
  const good=store.accept(pair,x,'正常正文','good'),actor={host:'claude' as const,sessionId:'c',callId:'receive'};
  const result=broker.receive(actor) as any;assert.deepEqual(result.messages.map((m:any)=>m.message_id),[good.id]);
  for(const id of bad){const m=store.message(id);assert.equal(m.state,'expired');assert.ok(m.error);assert.equal(m.attempts,0);}
  assert.deepEqual(broker.receive(actor),result);assert.equal(store.message(good.id).state,'unknown');
});

test('自动投递在 claim 前隔离缺失快照，正常消息继续，坏记录不误标 unknown',async t=>{
  const {store,broker,c,x,codex}=fixture(t),pair=store.pair(c.id,x.id),bad=store.accept(pair,c,'nxref:agent:child','bad');
  broker.references.snapshot(bad,'完整正文');database(store).prepare('DELETE FROM settings WHERE key=?').run('ref:message:'+bad.id);
  const good=store.accept(pair,c,'正常正文','good');await broker.pump();
  assert.equal(store.message(bad.id).state,'expired');assert.equal(store.message(bad.id).attempts,0);assert.deepEqual(codex.delivered.map(m=>m.id),[good.id]);
});

for(const embedded of [false,true])test(`系统问答和结果中的引用语法始终是原文，${embedded?'embedded':'自动'}投递均可用`,async t=>{
  const {store,broker,c,x,claude,codex}=fixture(t);store.pair(c.id,x.id);
  if(embedded)for(const peer of [c,x])store.saveEndpoint({...store.endpoint(peer.id)!,mode:'embedded'});
  const question='解释 nxref: 和 nxref:msg:missing，保留原文',answer='答案包含 nxref:agent:missing 和 nxref:';
  const created:any=await broker.dispatch('question.create',{actor:{host:'codex',sessionId:'x',callId:'literal-question'},questions:[{id:'q',header:'引用',question}]});
  const q=store.question(created.request_id);assert.equal(store.snapshotRequired(q.messageId),false);await broker.pump();
  const incoming=embedded?(broker.receive({host:'claude',sessionId:'c',callId:'q'}) as any).messages[0].message:claude.delivered[0]!.body;
  assert.equal(JSON.parse(incoming).questions[0].question,question);
  await broker.dispatch('question.answer',{actor:{host:'claude',sessionId:'c',callId:'answer'},input:{request_id:q.id,answers:{[question]:answer},rationale:'仅讨论语法，不展开引用'}});await broker.pump();
  const outgoing=embedded?(broker.receive({host:'codex',sessionId:'x',callId:'a'}) as any).messages[0].message:codex.delivered[0]!.body;
  assert.equal(JSON.parse(outgoing).answers.q.answers[0],answer);
});

test('引用在反引号、代码块和中英文引号中为字面量，其外仍展开并保留英文缩写',async t=>{
  const {broker,c}=fixture(t);broker.references.capture(c,'child','完整正文');
  const literal='`nxref:` ``示例 ` nxref:msg:missing`` "nxref:bad:quoted" \'nxref:agent:missing\' “nxref:” ‘nxref:msg:missing’\n```txt\nnxref:msg:missing\n```\n~~~txt\nnxref:agent:missing\n~~~';
  assert.equal(broker.references.expand(c,literal),literal);
  assert.equal(broker.references.expand(c,`don't alter ${literal}\n任务 nxref:agent:child`),`don't alter ${literal}\n任务 [nxref agent:child]\n完整正文\n[/nxref]`);
  const actor={host:'claude' as const,sessionId:'c',callId:'bare'};
  assert.deepEqual(await broker.dispatch('ref.expand',{actor,text:'裸前缀 nxref:'}),{text:'裸前缀 nxref:'});
  await assert.rejects(broker.dispatch('ref.expand',{actor,text:'实际引用 nxref:msg:missing'}),{code:'ref_missing'});
});

test('旧库区分系统原文和已展开消息，遗失快照仍能被识别',async t=>{
  const temp=temporaryDirectory(),filename=path.join(temp.directory,'migration.db');let store=new Store(filename);
  t.after(async()=>{store.close();await temp.cleanup();});
  const c=store.register(registration('claude','c')),x=store.register(registration('codex','x')),pair=store.pair(c.id,x.id);
  const raw=store.accept(pair,x,JSON.stringify({question:'nxref:msg:missing 和 nxref:'}),'question:old');
  const expanded=store.accept(pair,c,'nxref:agent:missing','user-old');
  database(store).exec('ALTER TABLE messages DROP COLUMN snapshot_required');store.close();store=new Store(filename);
  const refs=new References(store);assert.equal(refs.message(store.message(raw.id)),raw.body);assert.throws(()=>refs.message(store.message(expanded.id)),/快照已过期/);
});

test('两端 bridge 启动 CLI 时不把 SQLite warning 混入 stderr',async()=>{
  for(const host of ['claude','codex']){
    const child=spawn(process.execPath,[path.join(PACKAGE_ROOT,'plugins',host,'bridge.cjs'),'--version'],{stdio:['ignore','pipe','pipe'],windowsHide:true});
    let stdout='',stderr='';child.stdout!.on('data',chunk=>{stdout+=chunk;});child.stderr!.on('data',chunk=>{stderr+=chunk;});
    const code=await new Promise<number|null>((resolve,reject)=>{child.once('error',reject);child.once('exit',resolve);});
    assert.equal(code,0);assert.equal(stdout.trim(),'nxbridge '+VERSION);assert.equal(stderr,'');
  }
});
