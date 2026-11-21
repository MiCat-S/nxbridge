import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { EmbeddedWakeSignals, readWakeQueue, type WakeQueue } from '../ipc/embedded-wake.js';
import { Store } from '../storage/store.js';
import { WAKE_NOTICE, HEALTH_WAKE_NOTICE } from '../types.js';
import { fixture } from './support/broker-fixture.js';
import { registration } from './support/registration.js';
import { temporary, temporaryDirectory } from './support/temporary.js';

test('原生唤醒队列只读当前线程的精确通知，未知协议明确报错',t=>{
  const temp=temporaryDirectory(),home=temp.directory;assert.deepEqual(readWakeQueue(home,'target'),{items:[]});
  const db=new DatabaseSync(path.join(home,'queue_1.sqlite'));t.after(async()=>{db.close();await temp.cleanup();});
  db.exec('CREATE TABLE queued_items(id TEXT,thread_id TEXT,payload_json TEXT)');
  const add=(id:string,thread:string,text:string)=>db.prepare('INSERT INTO queued_items VALUES(?,?,?)').run(id,thread,JSON.stringify({UserInput:{client_id:'client-'+id,content:[{type:'text',text}]}}));
  add('own','target',WAKE_NOTICE);add('health','target',HEALTH_WAKE_NOTICE);add('foreign','other',WAKE_NOTICE);add('user','target','用户正常输入');
  assert.deepEqual(readWakeQueue(home,'target'),{items:[{id:'own',clientId:'client-own'},{id:'health',clientId:'client-health'}]});
  assert.equal(db.prepare('SELECT count(*) AS n FROM queued_items').get()!.n,4);
  db.prepare('INSERT INTO queued_items VALUES(?,?,?)').run('future','target',JSON.stringify({UserInput:{content:'未知结构'}}));
  assert.match(readWakeQueue(home,'target').error!,/协议/);
});

test('同一窗口只预约一次：跨重启、并发及一分钟通知租约续期均不增加原生队列',async t=>{
  t.mock.timers.enable({apis:['Date'],now:1000000});
  const store=new Store(':memory:');t.after(()=>store.close());let submitted=0,queue:WakeQueue={items:[]};
  const submit=async()=>{submitted++;queue={items:[{id:'native',clientId:'client'}]};};
  let signals=new EmbeddedWakeSignals(store,()=>queue);
  await Promise.all(Array.from({length:20},()=>signals.signal('peer','scope','home','session',submit)));
  for(let i=0;i<10;i++){t.mock.timers.tick(61000);signals=new EmbeddedWakeSignals(store,()=>queue);await signals.signal('peer','scope','home','session',submit);}
  assert.equal(submitted,1);assert.equal(store.setting<any>('embeddedWake:peer').nativeId,'native');
  queue={items:[]};await signals.signal('peer','scope','home','session',submit);assert.equal(submitted,2,'核验用户清空队列后可重新唤醒');
});

test('原生消费交接保留短暂预约，队列协议未知最多十分钟回退一次并返回诊断',async t=>{
  t.mock.timers.enable({apis:['Date'],now:1000000});
  const store=new Store(':memory:');t.after(()=>store.close());let submitted=0,queue:WakeQueue={items:[]};
  const signals=new EmbeddedWakeSignals(store,()=>queue),run=()=>signals.signal('peer','scope','home','session',async()=>{submitted++;});
  await run();t.mock.timers.tick(29999);await run();assert.equal(submitted,1);
  t.mock.timers.tick(1);await run();assert.equal(submitted,2);
  queue={error:'未知队列协议'};
  for(let i=0;i<9;i++){t.mock.timers.tick(60000);assert.equal(await run(),'未知队列协议');}
  assert.equal(submitted,2);t.mock.timers.tick(60000);await run();assert.equal(submitted,3);
  signals.consumed('peer');assert.equal(store.setting('embeddedWake:peer'),null);
});

test('忙碌和暂停窗口不提交唤醒，转为空闲后只走共享入口',async t=>{
  const f=fixture(t),endpoint={mode:'embedded' as const,address:'',epoch:'embed',pid:process.pid,procStart:'test',configHome:temporary(t)},x=f.store.register(registration('codex','embedded',{endpoint})),pair=f.store.pair(f.c.id,x.id);let count=0;
  (f.broker as any).wakeSignals={signal:async()=>{count++;return null;}};
  const signal=()=> (f.broker as any).signalEmbeddedWake(f.store.peer(x.id),f.store.endpoint(x.id));
  f.store.updatePeer(x.id,{state:'busy'});await signal();assert.equal(count,0);
  f.store.updatePeer(x.id,{state:'ready'});f.store.setPaused(true,pair.id);await signal();assert.equal(count,0);
  f.store.accept(pair,f.c,'待处理的真实消息','wake-task');
  f.store.setPaused(false,pair.id);await signal();assert.equal(count,1);
});

test('过期和暂停的原生唤醒静默停止，正常用户输入和新消息继续工作',async t=>{
  const f=fixture(t),x=f.store.register(registration('codex','embedded',{endpoint:{mode:'embedded',address:'',epoch:'embed',pid:process.pid,procStart:'test'}})),pair=f.store.pair(f.c.id,x.id),binding=f.store.bindings.current(x.id),actor={host:'codex' as const,sessionId:'embedded',callId:'wake-hook',...(binding?{binding:{key:binding.key,epoch:binding.epoch}}:{})};
  const prompt=(text:string)=>f.broker.dispatch('hook',{session_id:'embedded',hook_event_name:'UserPromptSubmit',actor,prompt:text});
  assert.deepEqual(await prompt(WAKE_NOTICE),{continue:false});assert.equal(f.store.peer(x.id).state,'ready');
  const message=f.store.accept(pair,f.c,'有效的新任务','new');
  f.store.setPaused(true,pair.id);assert.deepEqual(await prompt(WAKE_NOTICE),{continue:false});assert.equal(f.store.message(message.id).attempts,0);
  f.store.setPaused(false,pair.id);const fresh=await prompt(WAKE_NOTICE) as any;assert.notEqual(fresh.continue,false);assert.match(fresh.hookSpecificOutput.additionalContext,/receive_messages/);
  assert.equal(f.store.peer(x.id).activityAt,x.activityAt,'系统唤醒不伪造用户工作');
  const ordinary=await prompt('用户自己的任务') as any;assert.notEqual(ordinary.continue,false);assert.ok(f.store.peer(x.id).activityAt);
});

test('可行动的嵌入通知不提前领取，唤醒当次提供正文且已消费通知不再触发空轮次',async t=>{
  const f=fixture(t),x=f.store.register(registration('codex','embedded-health',{endpoint:{mode:'embedded',address:'',epoch:'health',pid:process.pid,procStart:'test',configHome:temporary(t)}})),pair=f.store.pair(f.c.id,x.id),binding=f.store.bindings.current(x.id)!,actor={host:'codex' as const,sessionId:x.sessionId!,callId:'health-hook',binding:{key:binding.key,epoch:binding.epoch}};
  let wakes=0;(f.broker as any).signalEmbeddedWake=async()=>{wakes++;};
  f.broker.deliveryHealth.enqueue(pair.id,x.id,{id:'health-fact',state:'pending',source:'turn_health',kind:'explicit_recovery',message:'精确健康事实'});
  await (f.broker as any).runtimeHealth.checkDeliveryHealth();assert.equal(wakes,1);assert.equal(f.broker.deliveryHealth.peek(pair.id,x.id).length,1,'提交信号不能占用正文租约');
  const input={session_id:x.sessionId,hook_event_name:'UserPromptSubmit',actor,prompt:HEALTH_WAKE_NOTICE};
  const result=await f.broker.dispatch('hook',input) as any;
  assert.notEqual(result.continue,false);assert.match(result.hookSpecificOutput.additionalContext,/精确健康事实/);assert.doesNotMatch(result.hookSpecificOutput.additionalContext,/claude msg pending/);
  assert.equal(f.store.peer(x.id).activityAt,x.activityAt);assert.equal(f.broker.deliveryHealth.due(pair.id,x.id),false);
  f.store.updatePeer(x.id,{state:'ready'});assert.deepEqual(await f.broker.dispatch('hook',input),{continue:false});
});

test('未到期的通知领取租约不产生唤醒信号，租约到期后才重新可取',t=>{
  t.mock.timers.enable({apis:['Date'],now:1000000});const f=fixture(t),pair=f.store.pair(f.c.id,f.x.id);
  f.broker.deliveryHealth.enqueue(pair.id,f.x.id,{id:'lease',state:'pending',message:'事实'});assert.equal(f.broker.deliveryHealth.due(pair.id,f.x.id),true);
  f.broker.deliveryHealth.take(pair.id,f.x.id);assert.equal(f.broker.deliveryHealth.due(pair.id,f.x.id),false);t.mock.timers.tick(60000);assert.equal(f.broker.deliveryHealth.due(pair.id,f.x.id),true);
});
