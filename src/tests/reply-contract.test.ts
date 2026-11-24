import test from 'node:test';
import { VERSION } from '../version.js';
import assert from 'node:assert/strict';
import path from 'node:path';
import { Store } from '../storage/store.js';
import { fixture } from './support/broker-fixture.js';
import { registration } from './support/registration.js';
import { temporaryDirectory } from './support/temporary.js';
import { codexIdentity } from '../integration/mcp/server.js';
import {deliveryHealthKey,type RuntimeNotice} from '../broker/health/contracts.js';

test('回复协议分界持久保留，排除启用前已读，同毫秒晚投递仍计入，成员相互独立',async t=>{
  t.mock.timers.enable({apis:['Date'],now:1000000});
  const temp=temporaryDirectory(),file=path.join(temp.directory,'nxbridge.db');let store=new Store(file);
  t.after(async()=>{store.close();await temp.cleanup();});
  const c=store.register(registration('claude','c',{replyContract:undefined})),x=store.register(registration('codex','x',{replyContract:undefined})),pair=store.pair(c.id,x.id);
  const old=store.accept(pair,c,'历史已读','old'),queued=store.accept(pair,c,'先排队，启用后投递','queued');store.transition(old.id,'contextObserved');
  assert.deepEqual(store.seenUnanswered(pair.id,x.id),[]);
  store.adoptReplyContract(x.id,'mcp');const contract=store.setting('replyContract:'+x.id);
  store.transition(queued.id,'contextObserved');const fresh=store.accept(pair,c,'启用后的任务','fresh');store.transition(fresh.id,'contextObserved');
  assert.deepEqual(store.seenUnanswered(pair.id,x.id).map(m=>m.id),[queued.id,fresh.id]);
  const reverse=store.accept(pair,x,'另一成员尚未启用','reverse');store.transition(reverse.id,'contextObserved');assert.deepEqual(store.seenUnanswered(pair.id,c.id),[]);
  t.mock.timers.tick(1000);store.adoptReplyContract(x.id,'mod');store.close();store=new Store(file);
  store.updatePeer(x.id,{sessionId:'resumed'});store.adoptReplyContract(x.id,'mcp');assert.deepEqual(store.setting('replyContract:'+x.id),contract);
  assert.deepEqual(store.seenUnanswered(pair.id,x.id).map(m=>m.id),[queued.id,fresh.id]);
  store.accept(pair,store.peer(x.id),'完成','done',fresh.id);
  assert.deepEqual(store.seenUnanswered(pair.id,x.id).map(m=>m.id),[queued.id]);assert.equal(store.message(old.id).state,'contextObserved','历史账本没有补写回复');
});

test('迟到回执、重复观察、维护和重开不能使启用前已读消息重新进入未回复检测',async t=>{
  t.mock.timers.enable({apis:['Date'],now:1000000});
  const temp=temporaryDirectory(),file=path.join(temp.directory,'nxbridge.db');let store=new Store(file);
  t.after(async()=>{store.close();await temp.cleanup();});
  const c=store.register(registration('claude','c',{replyContract:undefined})),x=store.register(registration('codex','x',{replyContract:undefined})),pair=store.pair(c.id,x.id);
  const old=store.accept(pair,c,'启用前已读','old'),queued=store.accept(pair,c,'启用前排队，启用后才观察','queued');store.transition(old.id,'contextObserved');
  t.mock.timers.tick(1000);
  const boundary=store.accept(pair,c,'分界同毫秒已读','boundary');store.transition(boundary.id,'contextObserved');
  const observed=[old,boundary].map(message=>store.message(message.id));
  store.adoptReplyContract(x.id,'mcp');const contract=store.setting('replyContract:'+x.id);
  t.mock.timers.tick(1000);
  for(const message of observed){
    assert.equal(store.claim(message.id),false);
    for(const state of ['contextObserved','runtimeQueued','unknown','accepted','sending','held','refused','expired'] as const)store.transition(message.id,state,'迟到的回执');
    store.requireSnapshot(message.id);
  }
  store.recover();store.maintain();store.close();store=new Store(file);
  store.updatePeer(x.id,{sessionId:'resumed'});store.adoptReplyContract(x.id,'mod');
  assert.deepEqual(store.setting('replyContract:'+x.id),contract);
  for(const message of observed){
    assert.equal(store.message(message.id).state,'contextObserved');
    assert.equal(store.message(message.id).updatedAt,message.updatedAt,'保持已读状态的行不能改写首次观察时间');
  }
  store.transition(queued.id,'contextObserved');
  assert.deepEqual(store.seenUnanswered(pair.id,x.id).map(message=>message.id),[queued.id],'旧已读持续排除，启用后首次观察的积压仍能检出');
});

test('未加载回复协议的旧成员明确告警，已验证的新 MCP 或 Mod 才启用检测',async t=>{
  t.mock.timers.enable({apis:['Date'],now:1000000});
  const f=fixture(t),x=f.store.register(registration('codex','old',{replyContract:undefined})),pair=f.store.pair(f.c.id,x.id);
  f.broker.pairAnomalies.evidence(x);t.mock.timers.tick(120001);
  f.broker.pairAnomalies.observe(pair,x);f.broker.pairAnomalies.observe(pair,x);
  assert.ok(f.broker.pairAnomalies.issues(x.id).some(issue=>issue.kind==='contract_inactive'));
                               
  assert.equal(f.store.events(0,1000).filter(e=>e.type==='health.pair.alert'&&(e.data as any).kind==='contract_inactive').length,0);assert.equal(f.broker.deliveryHealth.hasPending(pair.id,f.c.id),false);
  const status:any=f.broker.status({host:'claude',sessionId:'c',callId:'status'});assert.ok(status.integrationIssues.some((issue:any)=>issue.code==='contract_inactive'));
  const current=codexIdentity({threadId:'old'},'/project',{pid:process.pid,procStart:'test',appServer:true});assert.equal(current.registration.replyContract,1);
  const registered:any=await f.broker.dispatch('mcp.register',current.registration);assert.equal(registered.id,x.id);assert.ok(f.store.setting('replyContract:'+x.id));
  assert.equal(f.store.endpoint(x.id)!.address,'unix://test-server','能力登记不能改写已验证的原生路由');
  f.broker.pairAnomalies.observe(pair,f.store.peer(x.id));assert.equal(f.broker.pairAnomalies.issues(x.id).some(issue=>issue.kind==='contract_inactive'),false);
  assert.equal(f.broker.deliveryHealth.hasPending(pair.id,f.c.id),false);
  const c=f.store.register(registration('claude','old-mod',{replyContract:undefined}));
  for(const modVersion of [undefined,'0.1.0','unknown']){f.broker.pairAnomalies.integration(c,{mod:true,modVersion});assert.equal(f.store.setting('replyContract:'+c.id),undefined);}
  f.broker.pairAnomalies.integration(c,{mod:true,modVersion:VERSION});assert.ok(f.store.setting('replyContract:'+c.id));
});

test('升级后的空闲检测不重复历史积压，启用后的真实未回复仍告警并可由关联回复撤销',async t=>{
  t.mock.timers.enable({apis:['Date'],now:1000000});
  const f=fixture(t),x=f.store.register(registration('codex','upgraded',{replyContract:undefined})),pair=f.store.pair(f.c.id,x.id);
  const old=f.store.accept(pair,f.c,'升级前积压','old',undefined,undefined,'explicit',true);f.store.transition(old.id,'contextObserved');
  await f.broker.dispatch('register',registration('codex','upgraded'));
  t.mock.timers.tick(300001);f.broker.idleNotices.observe(pair,f.store.peer(x.id),2);assert.equal(f.broker.deliveryHealth.hasPending(pair.id,f.c.id),false);
  const task=f.store.accept(pair,f.c,'升级后的当前任务','new',undefined,undefined,'explicit',true);f.store.transition(task.id,'contextObserved');
  t.mock.timers.tick(300001);f.broker.idleNotices.observe(pair,f.store.peer(x.id),2);
  const notices=f.store.setting<{notices:RuntimeNotice[]}>(deliveryHealthKey(pair.id,f.c.id))!.notices;assert.equal(notices.length,1);assert.match(notices[0]!.message,new RegExp(task.id));assert.doesNotMatch(notices[0]!.message,new RegExp(old.id));
  f.store.accept(pair,f.store.peer(x.id),'完成当前任务','done',task.id);f.broker.idleNotices.observe(pair,f.store.peer(x.id),2);
  assert.equal(f.broker.deliveryHealth.hasPending(pair.id,f.c.id),false);assert.equal(f.store.message(old.id).state,'contextObserved');
});
