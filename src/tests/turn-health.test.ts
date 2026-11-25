import test,{type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import { TurnHealthTracker, SILENCE_MS, providerRetryInfo } from '../broker/health/turn-health.js';
import { fixture } from './support/broker-fixture.js';
import {writeFileSync} from 'node:fs';
import path from 'node:path';
import {temporary} from './support/temporary.js';
const boundedResult=(method:string|undefined,thread:any)=>method==='thread/turns/list'?{data:[...(thread.turns??[])].reverse()}:method==='thread/items/list'?{data:(thread.turns?.at(-1)?.items??[]).slice(-1).map((item:any)=>({turnId:thread.turns.at(-1).id,item}))}:{thread};
                                      
function nativeThread(t:TestContext,thread:any):any{
  const file=path.join(temporary(t),'native.jsonl');
  writeFileSync(file,JSON.stringify({type:'session_meta',payload:{id:thread.id}})+'\n'+JSON.stringify({timestamp:new Date().toISOString(),type:'event_msg',payload:{type:'task_started',turn_id:thread.turns.at(-1).id}})+'\n','utf8');
  return{...thread,path:file};
}

test('无法观测最新进展时撤回停滞提醒，不建议恢复；读取失败不能盖过同期原生进展',async t=>{
  t.mock.timers.enable({apis:['Date'],now:1000000});
  const f=fixture(t),pair=f.store.pair(f.c.id,f.x.id),endpoint=f.store.endpoint(f.x.id)!,thread=nativeThread(t,{id:'x',status:{type:'active'},turns:[{id:'t',status:'inProgress',items:[]}]});
  f.store.updatePeer(f.x.id,{owner:'nxbridge',state:'busy'});f.broker.health.read(endpoint.address,thread);
  const task=f.store.accept(pair,f.c,'明确依赖','dependent',undefined,undefined,'explicit',true);f.store.transition(task.id,'contextObserved');
  f.codex.connect=async()=>({request:async(method:string)=>boundedResult(method,thread)}) as any;
  t.mock.timers.tick(900001);await(f.broker as any).runtimeHealth.checkPairTurnHealth(pair);
  assert.equal(f.broker.deliveryHealth.peek(pair.id,f.c.id).filter(n=>n.source==='turn_health').length,1);
  f.codex.connect=async()=>({request:async(method:string)=>{if(method==='thread/items/list')throw{code:-32601,message:'method not found'};return boundedResult(method,thread);}}) as any;
  t.mock.timers.tick(30001);await(f.broker as any).runtimeHealth.checkPairTurnHealth(pair);
  assert.equal(f.broker.health.get(endpoint.address,'x')?.progressEvidence,false);assert.deepEqual(f.broker.deliveryHealth.peek(pair.id,f.c.id),[]);
  const preview:any=await f.broker.dispatch('codex.recover',{preview:true});assert.equal(preview.recoveryCommand,null);
  f.codex.connect=async()=>({request:async(method:string)=>{if(method==='thread/items/list'){f.broker.health.observe(endpoint.address,{method:'item/completed',params:{threadId:'x',turnId:'t',item:{id:'new',type:'agentMessage'}}});throw Error('临时断线');}return boundedResult(method,thread);}}) as any;
  t.mock.timers.tick(30001);await(f.broker as any).runtimeHealth.checkPairTurnHealth(pair);
  assert.equal(f.broker.health.get(endpoint.address,'x')?.progressEvidence,true);assert.equal(f.broker.health.get(endpoint.address,'x')?.lastProgressAt,Date.now());
  f.codex.connect=async()=>{throw Error('临时断线');};
  t.mock.timers.tick(30001);await(f.broker as any).runtimeHealth.checkPairTurnHealth(pair);
  assert.equal(f.broker.health.get(endpoint.address,'x')?.progressEvidence,false);
});

test('观察恢复后的相同条目不冒充新进展；缺少概要保留未知，空闲仍结束',()=>{
  let now=1000000;const health=new TurnHealthTracker(()=>now),thread={id:'x',status:{type:'active'},turns:[{id:'t',status:'inProgress',items:[{id:'item',type:'agentMessage',text:'原有进展'}]}]};
  health.read('endpoint',thread);const progress=health.get('endpoint','x')!.lastProgressAt;
  now+=SILENCE_MS;
  health.read('endpoint',{...thread,progressEvidence:false,turns:[{id:'t',status:'inProgress',items:[]}]});
  assert.equal(health.read('endpoint',thread)?.lastProgressAt,progress);
  assert.equal(health.read('endpoint',{id:'x',status:{type:'active'},turns:[],progressEvidence:false})?.progressEvidence,false);
  assert.equal(health.get('endpoint','x')!.lastProgressAt,progress);
  assert.equal(health.read('endpoint',{id:'x',status:{type:'idle'},turns:[],progressEvidence:false})?.state,'ready');
  const other=new TurnHealthTracker(()=>now);other.read('endpoint',{...thread,progressEvidence:false});
  now+=SILENCE_MS;assert.equal(other.read('endpoint',thread)?.lastProgressAt,now-SILENCE_MS,'首次真实条目只建立基线');
});

test('原生 sleep 扩展的开始与结束通知按工具生命周期处理，长等待不能变成无解释静默',()=>{
  let now=1000;const tracker=new TurnHealthTracker(()=>now),params={threadId:'x',turnId:'turn',item:{id:'native-sleep',type:'sleep',durationMs:1500000}};
  tracker.observe('endpoint',{method:'turn/started',params:{threadId:'x',turn:{id:'turn'}}});
  tracker.observe('endpoint',{method:'item/started',params});const progress=tracker.get('endpoint','x')!.lastProgressAt;
  now+=1500000;assert.equal(tracker.get('endpoint','x')?.state,'waitingTool');assert.equal(tracker.get('endpoint','x')?.lastProgressAt,progress);
  tracker.observe('endpoint',{method:'item/completed',params});assert.equal(tracker.get('endpoint','x')?.state,'running');assert.deepEqual(tracker.get('endpoint','x')?.tools,[]);
});

test('停滞提醒按真实依赖与联络共同计时，回复后即使历史读取限频也撤回旧提醒',async t=>{
  t.mock.timers.enable({apis:['Date'],now:1000000});
  const f=fixture(t),pair=f.store.pair(f.c.id,f.x.id),endpoint=f.store.endpoint(f.x.id)!,thread=nativeThread(t,{id:'x',status:{type:'active'},turns:[{id:'long-turn',status:'inProgress',items:[]}]});
  f.store.updatePeer(f.x.id,{state:'busy'});f.broker.health.read(endpoint.address,thread);
  f.codex.connect=async()=>({request:async(method:string)=>boundedResult(method,thread)}) as any;
  t.mock.timers.tick(360000);const task=f.store.accept(pair,f.c,'新来的显式任务','new-task',undefined,undefined,'explicit',true);f.store.transition(task.id,'contextObserved');
  t.mock.timers.tick(240000);await(f.broker as any).runtimeHealth.checkPairTurnHealth(pair);
  assert.deepEqual(f.broker.deliveryHealth.peek(pair.id,f.c.id),[],'原生静默十分钟，但依赖只有四分钟');
  t.mock.timers.tick(900001);await(f.broker as any).runtimeHealth.checkPairTurnHealth(pair);
  const notice=f.broker.deliveryHealth.take(pair.id,f.c.id).find(n=>n.source==='turn_health')!;assert.ok(notice,'真实依赖和静默都超过十五分钟仍提醒');
  const progress=f.broker.health.get(endpoint.address,'x')!.lastProgressAt;
  f.broker.send({actor:{host:'codex',sessionId:'x',callId:'result'},message:'任务已经处理',in_reply_to:task.id},false);
  assert.equal(await(f.broker as any).runtimeHealth.healthNotice(pair.id,f.x,notice.id,notice.message,notice.source),'denied');
  assert.deepEqual(f.broker.deliveryHealth.peek(pair.id,f.c.id),[]);assert.equal(f.claude.delivered.length,0);
  assert.equal(f.broker.health.get(endpoint.address,'x')!.lastProgressAt,progress,'联络不篡改原生任务进展事实');
});

test('unknown 成员的原生开放轮次继续核对，新工具进展解除误报，重复历史和入站不冒充进展',async t=>{
  t.mock.timers.enable({apis:['Date'],now:1000000});
  const f=fixture(t),pair=f.store.pair(f.c.id,f.x.id),address=f.store.endpoint(f.x.id)!.address;
  f.store.updatePeer(f.x.id,{owner:'nxbridge',state:'unknown'});
  const thread=nativeThread(t,{id:'x',status:{type:'active'},turns:[{id:'long-turn',status:'inProgress',items:[]}]});
  f.codex.connect=async()=>({request:async(method:string)=>boundedResult(method,thread)}) as any;
  f.broker.health.read(address,thread);t.mock.timers.tick(SILENCE_MS);
  thread.turns[0].items.push({id:'sent-reply',type:'mcpToolCall',status:'completed',server:'claude',tool:'send_message'});
  await(f.broker as any).runtimeHealth.checkPairTurnHealth(pair);
  assert.equal(f.broker.health.get(address,'x')?.state,'running');assert.equal(f.broker.health.get(address,'x')?.lastProgressAt,Date.now());assert.equal(f.store.events().some(event=>event.type==='health.alert'),false);
  t.mock.timers.tick(SILENCE_MS);
  thread.turns[0].items.push({id:'inbound',type:'functionCallOutput',namespace:'claude',name:'receive_messages',text:'只收到来信'});
  await(f.broker as any).runtimeHealth.checkPairTurnHealth(pair);
  assert.equal(f.broker.health.get(address,'x')?.state,'silent');assert.equal(f.store.events().filter(event=>event.type==='health.alert').length,1);assert.equal(f.codex.created.length,0);assert.equal(f.codex.woken.length,0);
});

test('新鲜原生事件不因 unknown 重读，陈旧状态读取恢复成员状态且通知轮询共用限频',async t=>{
  t.mock.timers.enable({apis:['Date'],now:1000000});
  const f=fixture(t),pair=f.store.pair(f.c.id,f.x.id),address=f.store.endpoint(f.x.id)!.address;
  f.store.updatePeer(f.x.id,{state:'unknown'});let reads=0;
  const thread=nativeThread(t,{id:'x',status:{type:'active'},turns:[{id:'t',status:'inProgress',items:[] as any[]}]});
  f.codex.connect=async()=>({request:async(method:string)=>{if(method==='thread/read')reads++;return boundedResult(method,thread);}}) as any;
  f.broker.health.observe(address,{method:'turn/started',params:{threadId:'x',turn:{id:'t'}}});
  await(f.broker as any).runtimeHealth.checkPairTurnHealth(pair);assert.equal(reads,0);
  t.mock.timers.tick(30000);await(f.broker as any).runtimeHealth.checkPairTurnHealth(pair);assert.equal(reads,1);assert.equal(f.store.peer(f.x.id).state,'busy');
  t.mock.timers.tick(SILENCE_MS);await(f.broker as any).runtimeHealth.checkPairTurnHealth(pair);assert.equal(reads,2);
  assert.equal(f.store.events().filter(event=>event.type==='health.alert').length,1);
  for(let index=0;index<3;index++)await f.broker.dispatch('health.monitor',{actor:{host:'claude',sessionId:'c',callId:'poll-'+index},admit:false});
  assert.equal(reads,2);
  t.mock.timers.tick(30000);thread.turns[0]!.items.push({id:'progress',type:'agentMessage',text:'继续'});
  await(f.broker as any).runtimeHealth.checkPairTurnHealth(pair);assert.equal(reads,3);
  assert.equal(f.store.events().filter(event=>event.type==='health.recovered').length,1);
  f.store.updatePeer(f.x.id,{state:'unknown'});
  await(f.broker as any).runtimeHealth.checkPairTurnHealth(pair);assert.equal(reads,3);assert.equal(f.codex.woken.length,0);
});

test('失败健康读取同样限频，读取期间的新原生状态保持优先',async t=>{
  t.mock.timers.enable({apis:['Date'],now:1000000});const f=fixture(t),pair=f.store.pair(f.c.id,f.x.id);
  f.store.updatePeer(f.x.id,{state:'unknown'});let reads=0;
  f.codex.connect=async()=>({request:async()=>{reads++;throw Error('临时断线');}}) as any;
  await(f.broker as any).runtimeHealth.checkPairTurnHealth(pair);await(f.broker as any).runtimeHealth.checkPairTurnHealth(pair);assert.equal(reads,1);
  t.mock.timers.tick(30000);f.codex.connect=async()=>({request:async(method:string)=>{if(method==='thread/read')reads++;f.store.updatePeer(f.x.id,{state:'needsHuman'});return boundedResult(method,{id:'x',status:{type:'active'},turns:[]});}}) as any;
  await(f.broker as any).runtimeHealth.checkPairTurnHealth(pair);assert.equal(reads,2);assert.equal(f.store.peer(f.x.id).state,'needsHuman');
});

test('事件创建后的首次历史快照只建立基线，不凭读取推迟停滞时间',()=>{
  let now=1000;const tracker=new TurnHealthTracker(()=>now);
  tracker.observe('native',{method:'turn/started',params:{threadId:'thread',turn:{id:'turn'}}});now+=SILENCE_MS;
  const health=tracker.read('native',{id:'thread',status:{type:'active'},turns:[{id:'turn',status:'inProgress',items:[]}]});
  assert.equal(health?.state,'silent');assert.equal(health?.lastProgressAt,1000);assert.equal(health?.observedProgressAt,undefined);assert.equal(health?.lastEventAt,now);
});

test('健康读取的旧快照不能覆盖读取期间的结束或新轮次，空闲十一小时仍保持就绪',async t=>{
  t.mock.timers.enable({apis:['Date'],now:1000000});const f=fixture(t),pair=f.store.pair(f.c.id,f.x.id),address=f.store.endpoint(f.x.id)!.address;
  const emit=(method:string,turn:any)=>f.codex.emit('native',{address,message:{method,params:{threadId:'x',turn}}});
  emit('turn/started',{id:'finished'});f.store.updatePeer(f.x.id,{state:'busy'});
  f.codex.connect=async()=>({request:async()=>{
    emit('turn/completed',{id:'finished',status:'completed'});f.store.updatePeer(f.x.id,{state:'ready'});
    return{thread:{id:'x',status:{type:'active'},turns:[{id:'finished',status:'inProgress',items:[]}]}};
  }}) as any;
  t.mock.timers.tick(30000);await(f.broker as any).runtimeHealth.checkPairTurnHealth(pair);
  t.mock.timers.tick(11*60*60*1000);await(f.broker as any).runtimeHealth.checkPairTurnHealth(pair);
  assert.equal(f.broker.health.get(address,'x')?.state,'ready');assert.equal(f.store.events().some(event=>event.type==='health.alert'),false);
  f.codex.connect=async()=>({request:async()=>{emit('turn/started',{id:'next'});return{thread:{id:'x',status:{type:'idle'},turns:[{id:'finished',status:'completed',items:[]}]}};}}) as any;
  const value=await(f.broker as any).runtimeHealth.probeTurnHealth(f.store.peer(f.x.id),f.store.endpoint(f.x.id));
  assert.equal(value.turnId,'next');assert.equal(value.state,'running');
});

test('终态轮次不被迟到工具或重复开始重开，空闲快照可结束遗留进展',()=>{
  let now=1000;const tracker=new TurnHealthTracker(()=>now),address='native',id='thread',turn={id:'turn',status:'completed',items:[]};
  tracker.read(address,{id,status:{type:'idle'},turns:[turn]});
  for(const method of ['turn/started','item/started','item/completed','item/agentMessage/delta','error']){
    tracker.observe(address,{method,params:{threadId:id,turnId:turn.id,turn,item:{id:'late',type:'commandExecution'},willRetry:true}});
  }
  now+=11*60*60*1000;assert.equal(tracker.get(address,id)?.state,'ready');
  tracker.read(address,{id,status:{type:'active'},turns:[{...turn,status:'inProgress'}]});assert.equal(tracker.get(address,id)?.state,'ready');
  for(const turns of [[],[{id:'next',status:'inProgress',items:[{id:'tool',type:'commandExecution',status:'inProgress'}]}]]){
    tracker.observe(address,{method:'turn/started',params:{threadId:id,turn:{id:'next'}}});
    tracker.read(address,{id,status:{type:'idle'},turns});assert.equal(tracker.get(address,id)?.state,'ready');assert.deepEqual(tracker.get(address,id)?.tools,[]);
  }
});

test('busy 事件断流后及时建立快照基线，迟到的首次读取也不误报告警',async t=>{
  t.mock.timers.enable({apis:['Date'],now:1000000});
  for(const firstDelay of [30000,SILENCE_MS]){
    const f=fixture(t),pair=f.store.pair(f.c.id,f.x.id),address=f.store.endpoint(f.x.id)!.address,startedAt=Date.now();
    f.store.updatePeer(f.x.id,{state:'busy'});let reads=0;
    const thread={id:'x',status:{type:'active'},turns:[{id:'t',status:'inProgress',items:[{id:'first',type:'agentMessage',text:'事件断流后仍在执行'}]}]};
    f.codex.connect=async()=>({request:async(method:string)=>{if(method==='thread/read')reads++;return boundedResult(method,thread);}}) as any;
    f.broker.health.observe(address,{method:'turn/started',params:{threadId:'x',turn:{id:'t'}}});
    t.mock.timers.tick(firstDelay);await(f.broker as any).runtimeHealth.checkPairTurnHealth(pair);
    assert.equal(reads,1);assert.equal(f.broker.health.hasSnapshot(address,'x'),true);assert.equal(f.broker.health.get(address,'x')?.lastProgressAt,startedAt);assert.equal(f.store.events().some(event=>event.type==='health.alert'),false);
    t.mock.timers.tick(30000);thread.turns[0]!.items.push({id:'next',type:'agentMessage',text:'继续产生结果'});
    await(f.broker as any).runtimeHealth.checkPairTurnHealth(pair);assert.equal(reads,2);assert.equal(f.broker.health.get(address,'x')?.observedProgressAt,Date.now());assert.equal(f.store.events().some(event=>event.type==='health.alert'||event.type==='health.recovered'),false);
    thread.status.type='idle';thread.turns[0]!.status='completed';t.mock.timers.tick(30000);await(f.broker as any).runtimeHealth.checkPairTurnHealth(pair);
    f.store.updatePeer(f.x.id,{state:'ready'});f.store.setSetting('turnHealthIncident:'+pair.id,{id:'recovered',pairId:pair.id,peerId:f.x.id,turnId:'t',lastProgressAt:startedAt,recovered:true});
    t.mock.timers.tick(30000);await(f.broker as any).runtimeHealth.checkPairTurnHealth(pair);assert.equal(reads,3);
  }
});

test('App Server 并行审批、原生状态和工具错误按当前轮次同步，不把失败工具当作任务失败',t=>{
  const {broker,store,c,x,codex}=fixture(t);store.pair(c.id,x.id);const address=store.endpoint(x.id)!.address,turnId='current';
  const emit=(method:string,params:any={},id?:number)=>codex.emit('native',{address,message:{method,params:{threadId:'x',turnId,...params},...(id===undefined?{}:{id})}});
  emit('turn/started',{turn:{id:turnId}});
  for(const [index,itemId] of ['a','b'].entries()){emit('item/started',{item:{id:itemId,type:'commandExecution'}});emit('item/commandExecution/requestApproval',{itemId},index+1);}
  store.updatePeer(x.id,{state:'needsHuman'});
  emit('item/completed',{item:{id:'unrelated',type:'commandExecution'}});assert.equal(store.peer(x.id).state,'needsHuman');
  emit('item/completed',{turnId:'old',item:{id:'a',type:'commandExecution'}});assert.equal(store.peer(x.id).state,'needsHuman');
  emit('item/completed',{item:{id:'a',type:'commandExecution',exitCode:1,aggregatedOutput:'approval_denied 字样不是原生拒绝'}});assert.equal(store.peer(x.id).state,'needsHuman');
  assert.equal(broker.health.get(address,'x')?.nativeIssue?.kind,'tool_failed');
  emit('item/completed',{item:{id:'b',type:'commandExecution',status:'declined'}});assert.equal(store.peer(x.id).state,'busy');
  emit('turn/completed',{turn:{id:turnId,status:'completed'}});assert.equal(broker.health.get(address,'x')?.state,'ready');
  const status=broker.status({host:'claude',sessionId:'c',callId:'status'}) as any;assert.equal(status.partner.native_issue.kind,'approval_denied');
  emit('turn/started',{turnId:'next',turn:{id:'next'}});assert.equal(broker.health.get(address,'x')?.nativeIssue,undefined);
});

test('正文只留私有哈希，同长度和 Unicode 改写仍推进，重复历史与取件不推进',()=>{
  let now=1000;const tracker=new TurnHealthTracker(()=>now),item={id:'message',type:'agentMessage',text:'私有正文甲'},turn={id:'turn',status:'inProgress',items:[item]},thread={id:'thread',turns:[turn]};
  const initial=tracker.read('endpoint',thread)!;
  assert.equal('fingerprint' in initial,false);assert.equal(JSON.stringify(initial).includes(item.text),false);
  const tracked=(tracker as any).turns.get(tracker.key('endpoint',thread.id));
  assert.match(tracked.fingerprint,/^[a-f0-9]{64}$/);assert.equal(JSON.stringify(tracked).includes(item.text),false);
  now+=SILENCE_MS;assert.equal(tracker.read('endpoint',thread)?.state,'silent');assert.equal(tracker.get('endpoint',thread.id)?.lastProgressAt,1000);
  item.text='私有正文乙';assert.equal(tracker.read('endpoint',thread)?.observedProgressAt,now);
  now++;assert.equal(tracker.read('endpoint',thread)?.lastProgressAt,now-1);
  (turn.items as any[]).push({id:'pickup',type:'functionCallOutput',namespace:'claude',name:'receive_messages',text:'入站内容'});
  assert.equal(tracker.read('endpoint',thread)?.lastProgressAt,now-1);
  for(const text of ['\uD800','\uFFFD','\uD801']){now++;item.text=text;assert.equal(tracker.read('endpoint',thread)?.observedProgressAt,now);}
});

test('轮次元数据变化仍推进，失败诊断有界，清理只释放失效范围',()=>{
  let now=1000;const tracker=new TurnHealthTracker(()=>now),turn={id:'turn',status:'inProgress',items:[{id:'item',type:'agentMessage',status:'inProgress',text:''}],error:{message:'错'.repeat(2000)}},thread={id:'current',turns:[turn]};
  tracker.read('endpoint',thread);now++;turn.items[0]!.status='completed';assert.equal(tracker.read('endpoint',thread)?.observedProgressAt,now);
  now++;turn.status='failed';assert.equal(tracker.read('endpoint',thread)?.state,'failed');assert.equal(tracker.get('endpoint','current')?.error?.length,1200);
  tracker.read('retired',{...thread,id:'old'});now++;tracker.read('starting',{...thread,id:'new'});
  tracker.prune(new Set([tracker.key('endpoint','current')]),now);
  assert.ok(tracker.get('endpoint','current'));assert.equal(tracker.get('retired','old'),undefined);assert.ok(tracker.get('starting','new'),'尚未登记的新事件保留到后续维护');
  tracker.forget('endpoint');assert.equal(tracker.get('endpoint','current'),undefined);assert.ok(tracker.get('starting','new'));
  tracker.observe('events',{method:'turn/completed',params:{threadId:'thread',turn:{id:'failed',status:'failed',error:{message:'错'.repeat(2000)}}}});
  assert.equal(tracker.get('events','thread')?.error?.length,1200);
});

test('原生进展与入站消息分开计时，运行中的工具和审批不会被判作无解释停滞',()=>{
  let now=1000000;const health=new TurnHealthTracker(()=>now),address='test',id='x',turnId='turn';
  const emit=(method:string,params:any={})=>health.observe(address,{method,params:{threadId:id,turnId,...params}});
  emit('turn/started',{turn:{id:turnId}});now+=SILENCE_MS;
  emit('item/completed',{item:{id:'incoming',type:'functionCallOutput',namespace:'claude',name:'receive_messages'}});
  emit('thread/status/changed',{status:{type:'active'}});assert.equal(health.get(address,id)?.state,'silent');
  emit('item/started',{item:{id:'cmd',type:'commandExecution'}});now+=SILENCE_MS;
  assert.equal(health.get(address,id)?.state,'waitingTool');
  emit('thread/status/changed',{status:{type:'active',activeFlags:['waitingOnApproval']}});assert.equal(health.get(address,id)?.state,'needsHuman');
  emit('item/completed',{item:{id:'cmd',type:'commandExecution'}});assert.equal(health.get(address,id)?.lastProgressAt,now);assert.equal(health.get(address,id)?.state,'running');
});

test('原生重连显示已知次数，失败结束不误报为恢复，重复读历史不刷新进展',()=>{
  let now=1000;const health=new TurnHealthTracker(()=>now),address='test';
  const thread:any={id:'x',status:{type:'active'},turns:[{id:'t',status:'inProgress',items:[]}]};
  health.read(address,thread);now+=SILENCE_MS;
  health.observe(address,{method:'error',params:{threadId:'x',turnId:'t',willRetry:true,error:{message:'Reconnecting... 3/150'}}});
  assert.deepEqual(health.get(address,'x')?.retry,{message:'Reconnecting... 3/150',attempt:3,max:150,since:now});
  health.read(address,thread);assert.equal(health.get(address,'x')?.state,'networkRetrying');assert.equal(health.get(address,'x')?.lastProgressAt,1000);
  health.observe(address,{method:'turn/completed',params:{threadId:'x',turn:{id:'t',status:'failed',error:{message:'连接失败'}}}});
  assert.equal(health.get(address,'x')?.state,'failed');assert.equal(health.get(address,'x')?.error,'连接失败');
  assert.deepEqual(providerRetryInfo({model_provider:'test',model_providers:{test:{request_max_retries:100,stream_max_retries:150}}}).requestMaxRetries,100);
});

test('托管端点未登记时说明无法核验，不误称为用户自管窗口',async t=>{
  const f=fixture(t);f.store.pair(f.c.id,f.x.id);f.store.updatePeer(f.x.id,{owner:'nxbridge'});f.store.deactivate(f.x.id);
  await assert.rejects(f.broker.dispatch('codex.recover',{preview:true}),error=>{assert.equal((error as any).code,'unowned_runtime');assert.match((error as Error).message,/尚未登记.*端点/);assert.doesNotMatch((error as Error).message,/用户窗口/);return true;});
  assert.equal(f.codex.connected.length,0);
});

test('恢复检查读取到最近进展时拒绝中断，不受旧 rollout 或旧 turn 状态误导',async t=>{
  const f=fixture(t);f.store.pair(f.c.id,f.x.id);f.store.updatePeer(f.x.id,{owner:'nxbridge',state:'busy'});
  const calls:string[]=[];
  f.codex.connect=async()=>({request:async(method?:string)=>{calls.push(method!);return boundedResult(method,{id:'x',status:{type:'active'},turns:[{id:'t',status:'inProgress',items:[{id:'new',type:'agentMessage',text:'已经恢复'}]}]});}}) as any;
  await assert.rejects(f.broker.dispatch('codex.recover',{turn_id:'t',request_id:'test'}),{code:'turn_recovered'});
  assert.deepEqual(calls,['thread/read','thread/turns/list','thread/items/list']);assert.equal(f.store.messages().length,0);
});

test('真实依赖停滞十五分钟后被动提醒，恢复只在主动状态查询中显示',async t=>{
  t.mock.timers.enable({apis:['Date'],now:1000000});
  const f=fixture(t),pair=f.store.pair(f.c.id,f.x.id);f.store.updatePeer(f.x.id,{owner:'nxbridge',state:'busy'});
  const task=f.store.accept(pair,f.c,'明确依赖','expected',undefined,undefined,'explicit',true);f.store.transition(task.id,'contextObserved');
  const address=f.store.endpoint(f.x.id)!.address,thread=nativeThread(t,{id:'x',status:{type:'active'},turns:[{id:'t',status:'inProgress',items:[{id:'secret',type:'agentMessage',text:'正文不得流入健康告警'}]}]});
  f.codex.connect=async()=>({request:async(method:string)=>boundedResult(method,thread)}) as any;
  f.broker.health.read(address,thread);t.mock.timers.tick(900000);
  await f.broker.pump();assert.equal(f.claude.delivered.length,0);
  const first=await f.broker.dispatch('health.monitor',{actor:{host:'claude',sessionId:'c',callId:'stall-fact'}}) as any;assert.equal(first.notices.length,1);assert.match(first.notices[0].message,/runtime monitor/);
  const alert=f.store.events().find(event=>event.type==='health.alert')!;
  assert.equal((alert.data as any).health.state,'silent');assert.equal(JSON.stringify(alert).includes('正文不得流入健康告警'),false);
  assert.equal('fingerprint' in (alert.data as any).health,false);assert.equal(JSON.stringify(f.broker.status()).includes('正文不得流入健康告警'),false);
  t.mock.timers.tick(30000);await f.broker.pump();assert.equal(f.claude.delivered.length,0);
  f.codex.emit('native',{address,message:{method:'item/completed',params:{threadId:'x',turnId:'t',item:{id:'progress',type:'agentMessage',text:'继续'}}}});
  t.mock.timers.tick(30000);await f.broker.pump();assert.equal(f.claude.delivered.length,0);
  const recovered=await f.broker.dispatch('health.monitor',{actor:{host:'claude',sessionId:'c',callId:'stall-recovery'}}) as any;assert.equal(recovered.notices.length,0);assert.ok((f.broker.status({host:'claude',sessionId:'c',callId:'status'}) as any).notes.some((n:any)=>n.text.includes('progress resumed')));
  t.mock.timers.tick(30000);await f.broker.pump();assert.equal(f.claude.delivered.length,0);assert.equal(f.store.messages().length,1);
});

test('明确恢复只中断指定 turn 并提交一次继续指令，不重放旧任务或改写送达证据',async t=>{
  t.mock.timers.enable({apis:['Date'],now:1000000});
  const f=fixture(t),pair=f.store.pair(f.c.id,f.x.id);f.store.updatePeer(f.x.id,{owner:'nxbridge',state:'busy'});
  const message=f.store.accept(pair,f.c,'已经完成的原任务','original');f.store.transition(message.id,'contextObserved','原生历史证据');
  const before=f.store.messages(),address=f.store.endpoint(f.x.id)!.address,turn:any={id:'t',status:'inProgress',items:[]},thread={id:'x',status:{type:'active'},turns:[turn]},calls:{method:string;params:any}[]=[];
  f.codex.connect=async()=>({request:async(method:string,params:any)=>{
    calls.push({method,params});
    if(method==='thread/read')return{thread};
    if(method==='thread/turns/list'||method==='thread/items/list')return boundedResult(method,thread);
    if(method==='turn/interrupt'){assert.equal(params.turnId,'t');turn.status='interrupted';return{};}
    assert.equal(method,'turn/start');return{turn:{id:'new'}};
  }}) as any;
  f.codex.continueInjected=async(peer,endpoint)=>{await((await f.codex.connect(endpoint.address)) as any).request('turn/start',{threadId:peer.sessionId,input:[]});return'new';};
  f.broker.health.read(address,thread);t.mock.timers.tick(31000);
  const result:any=await f.broker.dispatch('codex.recover',{turn_id:'t',request_id:'recover'});assert.equal(result.recovered,true);
  await f.broker.dispatch('hook',{hook_event_name:'Interrupt',session_id:'x',turn_id:'t'});
  f.codex.emit('interrupted','x',address,'t');
  assert.notEqual(f.store.peer(f.x.id).state,'paused','明确恢复导致的旧轮中断迟到后不得重新暂停');
  await f.broker.pump();
  assert.equal(calls.filter(call=>call.method==='turn/interrupt').length,1);const starts=calls.filter(call=>call.method==='turn/start');assert.equal(starts.length,1);
  assert.equal(starts[0]!.params.toolOutput,undefined);assert.deepEqual(starts[0]!.params.input,[]);const notice=f.codex.injectedNotices[0]!;assert.match(notice.body,/inspect partial file changes/);assert.doesNotMatch(notice.body,/已经完成的原任务/);assert.equal(f.codex.delivered.length,0);
  assert.deepEqual(f.store.messages(),before);assert.equal((await f.broker.dispatch('codex.recover.result',{request_id:'recover'}) as any).state,'submitted');
  await f.broker.dispatch('hook',{hook_event_name:'Interrupt',session_id:'x',turn_id:'new'});assert.equal(f.store.peer(f.x.id).state,'paused','用户中断新轮次仍正常暂停');
});

test('原生新轮次先到时，落后的线程列表不能切回旧轮并丢弃新轮进展',()=>{
  const tracker=new TurnHealthTracker(),address='native',threadId='thread';
  tracker.observe(address,{method:'turn/started',params:{threadId,turn:{id:'B'}}});
  assert.equal(tracker.read(address,{id:threadId,status:{type:'active'},turns:[{id:'A',status:'completed'}]})?.turnId,'B');
  tracker.observe(address,{method:'item/started',params:{threadId,turnId:'B',item:{id:'tool',type:'commandExecution'}}});
  assert.deepEqual(tracker.get(address,threadId)?.tools,['tool']);
  assert.equal(tracker.read(address,{id:threadId,status:{type:'idle'},turns:[{id:'A',status:'completed'}]})?.state,'ready','真实空闲快照仍能结算缺失结束事件的轮次');
});

test('恢复在最终复核发现新进展时不留下中断豁免，后续真实用户中断仍暂停',async t=>{
  t.mock.timers.enable({apis:['Date'],now:1000000});const f=fixture(t);f.store.pair(f.c.id,f.x.id);const endpoint=f.store.endpoint(f.x.id)!;
  f.store.updatePeer(f.x.id,{owner:'nxbridge',state:'busy'});f.broker.health.observe(endpoint.address,{method:'turn/started',params:{threadId:'x',turn:{id:'t'}}});t.mock.timers.tick(31000);
  f.codex.connect=async()=>{f.broker.health.observe(endpoint.address,{method:'item/agentMessage/delta',params:{threadId:'x',turnId:'t'}});return{request:async()=>({thread:{id:'x',status:{type:'active'},turns:[{id:'t',status:'inProgress'}]}})} as any;};
  await assert.rejects(f.broker.dispatch('codex.recover',{turn_id:'t',request_id:'stale'}),{code:'turn_recovered'});
  assert.equal(f.store.setting('codexRecoveryFence:'+f.x.id),undefined);
  f.codex.emit('interrupted','x',endpoint.address,'t');assert.equal(f.store.peer(f.x.id).state,'paused');
});
