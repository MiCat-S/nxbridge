import test from 'node:test';
import assert from 'node:assert/strict';
import { CodexDirectDelivery } from '../hosts/codex/codex-direct.js';
import { CodexAdapter, threadRegistration } from '../hosts/codex/adapter.js';
import {DeliveryError} from '../shared/errors.js';
import {DEFAULT_CONFIG} from '../config/defaults.js';
import { fixture } from './support/broker-fixture.js';
import { temporary } from './support/temporary.js';
import path from 'node:path';
import {writeFileSync,appendFileSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import {saveManagedRuntime} from '../hosts/managed-runtimes.js';
import {managedMarker} from '../install/installation.js';

test('429 失败后的 systemError 仍可注入新消息并续跑；回执和正文均只有一次',async t=>{
  const f=fixture(t),pair=f.store.pair(f.c.id,f.x.id),endpoint=f.store.endpoint(f.x.id)!,message=f.store.accept(pair,f.c,'失败后新来信','after-429');
  const read=f.codex.injectionState.bind(f.codex);
  f.codex.injectionState=async(...args)=>{const value=await read(...args);return{...value,thread:{...value.thread,status:{type:'systemError'},turns:[{id:'failed-429',status:'failed',error:{message:'exceeded retry limit, last status: 429 Too Many Requests'}}]}};};
  const delivery=new CodexDirectDelivery(f.store,f.codex),run=()=>delivery.deliver(f.x,endpoint,f.store.pending(f.x.id),async m=>JSON.stringify({messages:[{message_id:m.id,message:m.body}]}),()=>true,receipt=>f.store.transition(receipt.messageId,'contextObserved','已验证原生记录'));
  assert.equal(threadRegistration((await f.codex.injectionState(f.x,endpoint)).thread,endpoint.address)?.state,'ready');
  await run();await run();assert.equal(f.store.message(message.id).state,'contextObserved');assert.equal(f.store.message(message.id).attempts,1);assert.equal(f.codex.injected.length,1);assert.equal(f.codex.woken.length,1);
});

test('协调器在取件后冷启动，按实际持久调用对补证旧 unknown，不重投也不误结算无回执消息',async t=>{
  const f=fixture(t),pair=f.store.pair(f.c.id,f.x.id),home=temporary(t),file=path.join(home,'cold-receipt.jsonl'),message=f.store.accept(pair,f.c,'重启前已取件','cold-receipt'),unseen=f.store.accept(pair,f.c,'没有原生回执','no-receipt');
  for(const value of [message,unseen]){f.store.claim(value.id);f.store.transition(value.id,'unknown');}
  const row=(payload:unknown,type='response_item')=>({timestamp:new Date().toISOString(),type,payload});writeFileSync(file,[row({id:f.x.sessionId},'session_meta'),row({type:'function_call',name:'receive_messages',namespace:'claude',call_id:'native-receive'}),row({type:'function_call_output',call_id:'native-receive',output:JSON.stringify({messages:[{message_id:message.id}]})})].map(value=>JSON.stringify(value)).join('\n')+'\n','utf8');
  const adapter=new CodexAdapter(DEFAULT_CONFIG,home);t.after(()=>adapter.close());adapter.connect=async()=>({request:async(method:string)=>method==='thread/read'?{thread:{id:f.x.sessionId,path:file,status:{type:'idle'}}}:{data:[]}}) as any;f.codex.reconcile=adapter.reconcile.bind(adapter);
  await f.broker.reconcile(f.x.id);await f.broker.reconcile(f.x.id);assert.equal(f.store.message(message.id).state,'contextObserved');assert.equal(f.store.message(message.id).attempts,1);assert.equal(f.store.message(unseen.id).state,'unknown');assert.equal(f.codex.injected.length,0);assert.equal(f.codex.woken.length,0);
});

test('首次注入前没有历史游标时按提交时间找到新落盘调用对，清除预约并只续跑一次',async t=>{
  t.mock.timers.enable({apis:['Date'],now:1000000});
  const f=fixture(t),pair=f.store.pair(f.c.id,f.x.id),home=temporary(t),file=path.join(home,'first-materialized.jsonl'),endpoint=f.store.endpoint(f.x.id)!,message=f.store.accept(pair,f.c,'新线程的第一条来信','first-materialized');
  const adapter=new CodexAdapter(DEFAULT_CONFIG,home);t.after(()=>adapter.close());adapter.connect=async()=>({request:async(method:string)=>method==='thread/read'?{thread:{id:f.x.sessionId,path:file,status:{type:'idle'}}}:{data:[]}}) as any;
  let injected=0,continued=0;adapter.inject=async(_peer,_endpoint,callId,output)=>{injected++;const row=(payload:unknown,type='response_item')=>({timestamp:new Date().toISOString(),type,payload});writeFileSync(file,[row({id:f.x.sessionId},'session_meta'),row({type:'function_call',name:'receive_messages',namespace:'claude',call_id:callId}),row({type:'function_call_output',call_id:callId,output})].map(value=>JSON.stringify(value)).join('\n')+'\n','utf8');};adapter.continueInjected=async()=>{continued++;return'first-turn';};
  const delivery=new CodexDirectDelivery(f.store,adapter),run=()=>delivery.deliver(f.x,endpoint,f.store.pending(f.x.id),async m=>JSON.stringify({messages:[{message_id:m.id,message:m.body}]}),()=>true,receipt=>f.store.transition(receipt.messageId,'contextObserved'));
  await run();await run();assert.equal(f.store.message(message.id).state,'contextObserved');assert.equal(f.store.message(message.id).attempts,1);assert.equal(injected,1);assert.equal(continued,1);assert.equal(delivery.status(f.x.id)?.attempts.length,0);assert.equal(delivery.pending(f.x.id),false);
});

test('活动轮次、等待标记或未知状态保留原消息，并去重记录等待原因供 status 和模型读取',async t=>{
  const f=fixture(t),pair=f.store.pair(f.c.id,f.x.id),endpoint=f.store.endpoint(f.x.id)!,message=f.store.accept(pair,f.c,'先等原生状态','native-wait');
  const read=f.codex.injectionState.bind(f.codex);let type='systemError',flags:string[]=[],running=true;
  f.codex.injectionState=async(...args)=>{const value=await read(...args);return{...value,thread:{...value.thread,status:{type,activeFlags:flags},turns:[{id:'native-turn',status:running?'inProgress':'failed'}]}};};
  const delivery=(f.broker as any).codexDirect as CodexDirectDelivery,run=()=>delivery.deliver(f.x,endpoint,f.store.pending(f.x.id),async m=>JSON.stringify({messages:[{message_id:m.id,message:m.body}]}),()=>true,receipt=>f.store.transition(receipt.messageId,'contextObserved'));
  for(const scenario of [{type:'systemError',flags:[],running:true,state:'busy'},{type:'idle',flags:[],running:true,state:'busy'},{type:'systemError',flags:['waitingOnApproval'],running:false,state:'needsHuman'},{type:'systemError',flags:['waitingOnUserInput'],running:false,state:'needsHuman'},{type:'systemError',flags:['futureFlag'],running:false,state:'unknown'},{type:'futureStatus',flags:[],running:false,state:'unknown'},{type:'active',flags:[],running:false,state:'busy'}]){
    ({type,flags,running}=scenario);assert.equal(threadRegistration((await f.codex.injectionState(f.x,endpoint)).thread,endpoint.address)?.state,scenario.state);
    await run();await run();assert.equal(f.store.message(message.id).state,'accepted');assert.equal(f.store.message(message.id).attempts,0);
    const view=(f.broker.status() as any).peers.find((peer:any)=>peer.id===f.x.id).delivery_wait;assert.equal(view.reason,'native_thread_state');assert.equal(view.native_status,type);assert.match(view.message,/消息保留/);
  }
  assert.equal(f.store.events(0,1000).filter(event=>event.type==='codex.delivery.wait').length,7);assert.equal(f.codex.injected.length,0);assert.equal(f.codex.woken.length,0);
  type='systemError';flags=[];running=false;await run();assert.equal(f.store.message(message.id).state,'contextObserved');assert.equal(delivery.status(f.x.id)?.wait,undefined);assert.equal(f.store.events(0,1000).filter(event=>event.type==='codex.delivery.resumed').length,1);
  assert.equal((f.broker.status() as any).peers.find((peer:any)=>peer.id===f.x.id).delivery_wait,undefined);
});

for(const authenticated of [false,true])test('回环端点只有托管认证证明才使用本机注入与持久历史：'+authenticated,async t=>{
  const f=fixture(t),home=f.broker.home,pair=f.store.pair(f.c.id,f.x.id),endpoint={...f.store.endpoint(f.x.id)!,address:'ws://127.0.0.1:12345'},history=path.join(home,'history.jsonl');
  f.store.saveEndpoint(endpoint);
  saveManagedRuntime(home,{id:randomUUID(),owner:managedMarker(home),kind:'owned',state:'ready',endpoint:endpoint.address,createdAt:Date.now(),authenticatedLoopback:authenticated});
  const message=f.store.accept(pair,f.c,'回环正文','loopback');await f.broker.pump();
  assert.equal(f.store.message(message.id).state,authenticated?'contextObserved':'accepted');assert.equal(f.codex.injected.length,authenticated?1:0);assert.equal(f.codex.woken.length,1);
  writeFileSync(history,[{type:'session_meta',payload:{id:f.x.sessionId}},{type:'response_item',payload:{type:'function_call',call_id:'proof',name:'receive_messages',namespace:'claude',arguments:'{}'}},{type:'response_item',payload:{type:'function_call_output',call_id:'proof',output:JSON.stringify({messages:[{message_id:message.id}]})}}].map(row=>JSON.stringify(row)).join('\n')+'\n','utf8');
  const adapter=new CodexAdapter(DEFAULT_CONFIG,home);t.after(()=>adapter.close());
  adapter.attach=adapter.connect=async()=>({request:async()=>({thread:{id:f.x.sessionId,path:history,status:{type:'idle'},turns:[]}})}) as any;
  assert.equal((await adapter.injectionState(f.x,endpoint)).history.status,authenticated?'supported':'unavailable');
  assert.deepEqual((await adapter.reconcile(f.x,endpoint)).map(receipt=>receipt.messageId),[],'常规核验从尾部建立增量边界');
  appendFileSync(history,[{type:'response_item',payload:{type:'function_call',call_id:'new-proof',name:'receive_messages',namespace:'claude',arguments:'{}'}},{type:'response_item',payload:{type:'function_call_output',call_id:'new-proof',output:JSON.stringify({messages:[{message_id:message.id}]})}}].map(row=>JSON.stringify(row)).join('\n')+'\n','utf8');
  assert.deepEqual((await adapter.reconcile(f.x,endpoint)).map(receipt=>receipt.messageId),authenticated?[message.id]:[]);
});

test('正文持久化与续跑分别记账；续跑失败及协调器重启均只重试启动',async t=>{
  t.mock.timers.enable({apis:['Date'],now:1000000});
  const f=fixture(t),pair=f.store.pair(f.c.id,f.x.id),message=f.store.accept(pair,f.c,'原文','call'),endpoint=f.store.endpoint(f.x.id)!;
  let starts=0;f.codex.continueInjected=async()=>{starts++;if(starts===1)throw new DeliveryError('rpc_error','已确认未启动',false);return'turn';};
  const run=(delivery:CodexDirectDelivery)=>delivery.deliver(f.x,endpoint,f.store.pending(f.x.id),async m=>JSON.stringify({messages:[{message_id:m.id,message:m.body}]}),()=>true,receipt=>f.store.transition(receipt.messageId,'contextObserved','已验证原生记录'));
  await run(new CodexDirectDelivery(f.store,f.codex));assert.equal(f.store.message(message.id).state,'contextObserved');assert.equal(f.codex.delivered.length,1);assert.equal(starts,1);
  t.mock.timers.tick(30000);await run(new CodexDirectDelivery(f.store,f.codex));assert.equal(starts,2);assert.equal(f.codex.delivered.length,1);
});

for(const terminal of ['interrupted','completed','failed'])test('真实取件先认领时不注入；完整历史确认 '+terminal+' 活动队列丢弃后才补投',async t=>{
  t.mock.timers.enable({apis:['Date'],now:1000000});
  const f=fixture(t),pair=f.store.pair(f.c.id,f.x.id),endpoint=f.store.endpoint(f.x.id)!,message=f.store.accept(pair,f.c,'保持编号','once');
  const delivery=new CodexDirectDelivery(f.store,f.codex),original=f.codex.inject.bind(f.codex),read=f.codex.injectionState.bind(f.codex);let state='idle',attempts=0;
  let complete=false;
  f.codex.injectionState=async(peer,ep)=>{const value=await read(peer,ep);return{...value,history:{...value.history,complete},thread:{...value.thread,status:{type:state==='busy'?'active':state==='failed'?'systemError':'idle'},turns:state==='idle'?[]:[{id:'race-turn',status:state==='busy'?'inProgress':terminal}]}};};
  f.codex.inject=async(...args)=>{attempts++;if(attempts===1){state='busy';return;}await original(...args);};
  const run=()=>delivery.deliver(f.x,endpoint,f.store.pending(f.x.id),async m=>JSON.stringify({messages:[{message_id:m.id,message:m.body}]}),()=>true,receipt=>f.store.transition(receipt.messageId,'contextObserved'));
  await run();assert.equal(f.store.message(message.id).state,'sending');await run();assert.equal(attempts,1);
  for(let i=0;i<4;i++){t.mock.timers.tick(30000);await run();}
  assert.equal(delivery.status(f.x.id)?.attempts.length,1,'长轮次仍在执行时不能用未知结果核验上限遗失补投预约');
  state=terminal;t.mock.timers.tick(10000);await run();assert.equal(attempts,1);assert.equal(f.store.message(message.id).state,'unknown');
  complete=true;t.mock.timers.tick(10000);await run();assert.equal(f.store.message(message.id).state,'accepted');await run();assert.equal(attempts,2);assert.equal(f.store.message(message.id).state,'contextObserved');
  const next=f.store.accept(pair,f.c,'并发取件','pull');
  await delivery.deliver(f.x,endpoint,[next],async m=>{f.store.claim(m.id);f.store.transition(m.id,'unknown','真实工具已领取');return JSON.stringify({messages:[{message_id:m.id}]});},()=>true,()=>{});
  assert.equal(attempts,2);
});

test('超时续跑在同一空闲轮次下限次重试；未知注入核验有上限且不重投正文',async t=>{
  t.mock.timers.enable({apis:['Date'],now:1000000});
  const f=fixture(t),pair=f.store.pair(f.c.id,f.x.id),endpoint=f.store.endpoint(f.x.id)!,message=f.store.accept(pair,f.c,'只注入一次','uncertain');
  let starts=0;f.codex.continueInjected=async()=>{starts++;throw new DeliveryError('timeout','启动结果未知',true);};
  const delivery=new CodexDirectDelivery(f.store,f.codex),run=()=>delivery.deliver(f.x,endpoint,f.store.pending(f.x.id),async m=>JSON.stringify({messages:[{message_id:m.id,message:m.body}]}),()=>true,receipt=>f.store.transition(receipt.messageId,'contextObserved'));
  await run();for(let i=0;i<6;i++){t.mock.timers.tick(30000);await run();}
  assert.equal(starts,3);assert.equal(f.codex.delivered.length,1);assert.equal(f.store.message(message.id).state,'contextObserved');
  assert.equal(delivery.pending(f.x.id),false,'达到上限后不再逐次轮询原生历史');
  await f.broker.dispatch('health.monitor',{actor:{host:'claude',sessionId:f.c.sessionId!,callId:'monitor'}});
  assert.ok((f.broker.status() as any).capabilities.integrationIssues.some((issue:any)=>issue.code==='continuation_failed'));
  const next=f.store.accept(pair,f.c,'结果不明时保留','park');f.codex.inject=async()=>{throw new DeliveryError('timeout','注入结果未知',true);};
  await run();for(let i=0;i<6;i++){t.mock.timers.tick(30000);await run();}
  assert.equal(f.store.message(next.id).state,'unknown');assert.deepEqual(delivery.status(f.x.id)?.parked,[next.id]);assert.equal(delivery.status(f.x.id)?.attempts.length,0);
});

test('新线程基础读取不缓存为已订阅，首次历史落盘后重新 resume',async t=>{
  const f=fixture(t),adapter=new CodexAdapter(DEFAULT_CONFIG,temporary(t)),endpoint=f.store.endpoint(f.x.id)!;t.after(()=>adapter.close());
  let persisted=false,resumes=0;
  const rpc={closed:false,request:async(method:string)=>{
    if(method==='thread/resume'){resumes++;if(!persisted)throw new Error('no rollout found');}
    if(method==='thread/loaded/list')return{data:[f.x.sessionId]};
    return{thread:{id:f.x.sessionId,cwd:f.x.cwd,status:{type:'idle'}}};
  }};
  adapter.connect=async()=>rpc as any;
  await adapter.attach(f.x,endpoint);persisted=true;await adapter.attach(f.x,endpoint);await adapter.attach(f.x,endpoint);
  assert.equal(resumes,2);
});
