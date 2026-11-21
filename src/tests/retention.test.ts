import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { Store } from '../storage/store.js';
import { References } from '../broker/delivery/references.js';
import {DEFAULT_RETENTION} from '../config/defaults.js';
import {loadConfig} from '../config/load.js';
import { rotateLog } from '../storage/logs.js';
import { fixture } from './support/broker-fixture.js';
import { registration } from './support/registration.js';
import { temporaryDirectory } from './support/temporary.js';

test('旧健康告警正文指纹分批移除，不改其他诊断与消息，重复维护幂等',t=>{
  const {store,c,x}=fixture(t),pair=store.pair(c.id,x.id),message=store.accept(pair,c,'正常通信正文保留','privacy-retention');
  for(let index=0;index<19;index++)store.event('health.alert',{id:index,health:{state:'silent',fingerprint:'旧正文',error:'诊断保留'}});
  const remaining=()=>store.events(0,100).filter(event=>event.type==='health.alert'&&(event.data as any).health.fingerprint!==undefined).length;
  store.maintain();assert.equal(remaining(),11);store.maintain();assert.equal(remaining(),3);store.maintain();assert.equal(remaining(),0);
  const clean=store.events(0,100);store.maintain();assert.deepEqual(store.events(0,100),clean);
  assert.equal(store.message(message.id).body,'正常通信正文保留');
  assert.ok(clean.filter(event=>event.type==='health.alert').every(event=>(event.data as any).health.error==='诊断保留'));
});

test('历史按年龄和数量裁剪，保护待处理状态、回复祖先及其快照',t=>{
  const {store,c,x}=fixture(t),pair=store.pair(c.id,x.id),refs=new References(store);
  const old=store.accept(pair,c,'旧终态','old');store.transition(old.id,'responded');
  const parent=store.accept(pair,c,'祖先','parent');store.transition(parent.id,'contextObserved');
  const reply=store.accept(pair,x,'回复','reply',parent.id);store.transition(reply.id,'responded');
  const pending=store.accept(pair,c,'等待中的 nxref:agent:a','pending',reply.id);refs.snapshot(pending,'不能丢失的正文');
  const uncertain=store.accept(pair,c,'未知结果','unknown');store.claim(uncertain.id);store.transition(uncertain.id,'unknown');
  store.setSetting('receive:'+x.id+':unknown',{messages:[{message_id:uncertain.id,message:'未知结果'}]});
  const held=store.accept(pair,c,'等待准许','held');store.transition(held.id,'held');
  for(let i=0;i<10;i++)store.event('fixture',{i});
  const now=Date.now()+2000;
  store.maintain({historyMaxAgeMs:1000,eventMaxAgeMs:1000,maxEvents:3,maxMessages:1,referenceMaxAgeMs:1,maxReferences:1,maxReferenceBytes:1},now);
  assert.throws(()=>store.message(old.id),/不存在/);
  for(const m of [parent,reply,pending,uncertain,held])assert.equal(store.message(m.id).id,m.id);
  assert.equal(refs.message(store.message(pending.id)),'不能丢失的正文');assert.equal(store.events(0,100).length,0);
  assert.ok(store.setting('receive:'+x.id+':unknown'));
  for(let i=0;i<10;i++)store.event('recent',{i});store.maintain({maxEvents:3},Date.now());assert.equal(store.events(0,100).length,3);
});

test('活跃问答及来源通知不受历史配额影响',async t=>{
  const {store,broker,c,x}=fixture(t);store.pair(c.id,x.id);
  const created:any=await broker.dispatch('question.create',{actor:{host:'codex',sessionId:'x',callId:'question'},questions:[{id:'q',header:'选择',question:'选哪个？',options:[{label:'甲',description:'一'},{label:'乙',description:'二'}]}]});
  await broker.pump();const question=store.question(created.request_id),message=store.message(question.messageId);
  store.maintain({historyMaxAgeMs:1,maxMessages:1,maxQuestions:1},Date.now()+2000);
  assert.equal(store.question(question.id).status,'pending');assert.equal(store.message(message.id).id,message.id);
});

test('一个不可解析的问答记录不阻止裁剪无关终态正文，待处理消息仍受保护',async t=>{
  const {store,broker,c,x}=fixture(t),pair=store.pair(c.id,x.id);
  const old=store.accept(pair,c,'应当过期的正文','old-unrelated');store.transition(old.id,'responded');
  const pending=store.accept(pair,c,'仍需投递的正文','pending-protected');
  const created:any=await broker.dispatch('question.create',{actor:{host:'codex',sessionId:'x',callId:'broken-question'},questions:[{id:'q',header:'输入',question:'请输入内容'}]});
  (store as any).db.prepare('UPDATE questions SET data=? WHERE id=?').run('{invalid',created.request_id);
  store.maintain({historyMaxAgeMs:1,maxMessages:1},Date.now()+2000);
  assert.throws(()=>store.message(old.id),{code:'message_missing'});assert.equal(store.message(pending.id).body,'仍需投递的正文');
});

test('持续终态回复链仍受数量限制，原始回复 ID 与调用幂等保留',t=>{
  const {store,c,x}=fixture(t),pair=store.pair(c.id,x.id);let previous:string|undefined;
  const rows=[];
  for(let i=0;i<20;i++){
    const sender=i%2===0?c:x,m=store.accept(pair,sender,'回复 '+i,'chain-'+i,previous);store.transition(m.id,'contextObserved');
    rows.push({m,sender,previous});previous=m.id;
  }
  store.maintain({maxMessages:2});assert.equal(store.messages(100).length,2);
  const survivor=rows.at(-2)!;assert.equal(store.message(survivor.m.id).inReplyTo,survivor.previous);
  assert.throws(()=>store.message(survivor.previous!),/不存在/);
  assert.equal(store.accept(pair,survivor.sender,survivor.m.body,survivor.m.callId,survivor.previous).id,survivor.m.id);
});

test('nxref 和取件缓存共享数量/字节/年龄额度；终态快照过期后拒绝原始引用',t=>{
  const {store,c,x}=fixture(t),pair=store.pair(c.id,x.id),refs=new References(store);
  refs.capture(c,'a','甲'.repeat(20));refs.capture(c,'b','乙'.repeat(20));refs.capture(c,'c','丙'.repeat(20));
  store.maintain({maxReferences:2,maxReferenceBytes:200});
  assert.equal(['a','b','c'].filter(id=>store.setting('ref:agent:'+c.id+':'+id)!==undefined).length,2);
  const m=store.accept(pair,c,'nxref:agent:a','snapshot');refs.snapshot(m,'正确正文');store.transition(m.id,'runtimeQueued');
  store.setSetting('receive:'+x.id+':old',{messages:[{message_id:m.id,message:'缓存正文'}]});
  store.maintain({maxReferences:1,maxReferenceBytes:1});
  assert.throws(()=>refs.message(store.message(m.id)),/快照已过期/);assert.equal(store.setting('receive:'+x.id+':old'),undefined);
  refs.capture(c,'new','新答案');store.maintain({referenceMaxAgeMs:1},Date.now()+10);assert.equal(store.setting('ref:agent:'+c.id+':new'),undefined);
});

test('归档空配对和长期离线死会话被回收，当前配对与活进程保留',t=>{
  const temp=temporaryDirectory(),home=temp.directory,filename=path.join(home,'history.db'),store=new Store(filename);t.after(async()=>{store.close();await temp.cleanup();});
  const c=store.register(registration('claude','c')),x=store.register(registration('codex','x'));store.pair(c.id,x.id);store.unpair();
  store.deactivate(c.id);store.updatePeer(c.id,{state:'offline'});
  const live=store.register(registration('claude','live')),current=store.pair(live.id,x.id);
  const dead=store.register(registration('codex','dead'));store.deactivate(dead.id);store.updatePeer(dead.id,{state:'offline'});
  store.setSetting('windowRecoveryPending',{[dead.id]:{peerId:dead.id},[live.id]:{peerId:live.id}});
  store.setSetting('managedSessionConflict:'+live.id,{memberId:dead.id});store.setSetting('managedSessionConflict:'+dead.id,{memberId:c.id});
  const later=Date.now()+2000;store.maintain({historyMaxAgeMs:1000,peerMaxIdleMs:1000},later);
  assert.equal(store.currentPair()?.id,current.id);assert.equal(store.peer(live.id).id,live.id);assert.equal(store.peer(x.id).id,x.id);
  assert.throws(()=>store.peer(dead.id),/不存在/);assert.throws(()=>store.peer(c.id),/不存在/);
  assert.deepEqual(store.setting('windowRecoveryPending'),{[live.id]:{peerId:live.id}});assert.equal(store.setting('managedSessionConflict:'+live.id),undefined);assert.equal(store.setting('managedSessionConflict:'+dead.id),undefined);
});

test('旧数据库迁移保留引用，配置只合并默认值，轮转保留指定备份',t=>{
  assert.equal(DEFAULT_RETENTION.maxReferences,1024);assert.equal(DEFAULT_RETENTION.maxReferenceBytes,128*1024*1024);assert.equal(DEFAULT_RETENTION.logMaxBytes,8*1024*1024);assert.equal(DEFAULT_RETENTION.logBackups,2);
  const temp=temporaryDirectory(),home=temp.directory,filename=path.join(home,'legacy.db');
  const db=new DatabaseSync(filename);db.exec('CREATE TABLE settings(key TEXT PRIMARY KEY,value TEXT NOT NULL)');db.prepare('INSERT INTO settings VALUES(?,?)').run('ref:agent:legacy:a',JSON.stringify('旧答案'));db.close();
  const store=new Store(filename);t.after(async()=>{store.close();await temp.cleanup();});assert.equal(store.setting('ref:agent:legacy:a'),'旧答案');store.maintain();assert.equal(store.setting('ref:agent:legacy:a'),'旧答案');
  const configFile=path.join(home,'config.json'),raw=JSON.stringify({retention:{maxEvents:42}});writeFileSync(configFile,raw,'utf8');
  assert.equal(loadConfig(home).retention?.maxEvents,42);assert.equal(loadConfig(home).retention?.maxReferenceBytes,DEFAULT_RETENTION.maxReferenceBytes);assert.equal(readFileSync(configFile,'utf8'),raw);
  assert.equal(loadConfig(home).retention?.maxReferences,1024);assert.equal(loadConfig(home).retention?.logMaxBytes,8*1024*1024);
  writeFileSync(configFile,JSON.stringify({retention:{maxReferences:19,maxReferenceBytes:1024,logMaxBytes:2048}}),'utf8');
  const overridden=loadConfig(home).retention!;assert.equal(overridden.maxReferences,19);assert.equal(overridden.maxReferenceBytes,1024);assert.equal(overridden.logMaxBytes,2048);
  writeFileSync(configFile,JSON.stringify({retention:{logBackups:0}}),'utf8');assert.throws(()=>loadConfig(home),/retention/);
  const log=path.join(home,'broker.log');
  for(const text of ['第一代','第二代','第三代']){writeFileSync(log,text,'utf8');assert.equal(rotateLog(log,1,2),true);}
  assert.equal(readFileSync(log+'.1','utf8'),'第三代');assert.equal(readFileSync(log+'.2','utf8'),'第二代');assert.equal(existsSync(log+'.3'),false);
});
