import test from 'node:test';
import assert from 'node:assert/strict';
import { CodexAdapter } from '../hosts/codex/adapter.js';
import {DEFAULT_CONFIG} from '../config/defaults.js';
import { Store } from '../storage/store.js';
import { fixture as baseFixture } from './support/broker-fixture.js';
import { registration } from './support/registration.js';
import { temporary } from './support/temporary.js';
import { FakeAdapter } from './support/fake-adapter.js';
import { saveManagedRuntime } from '../hosts/managed-runtimes.js';
import { managedMarker } from '../install/installation.js';
import { randomUUID } from 'node:crypto';
import { Broker, type Adapters } from '../broker/coordinator.js';
import { hostingGate, codexForegroundEndKey } from '../broker/recovery/session-hosting.js';
import { processIdentity } from '../process/process.js';

                                     
const runtimeIdentity=await processIdentity(process.pid);
function fixture(...args:Parameters<typeof baseFixture>){const value=baseFixture(...args);for(const endpoint of value.store.endpoints(value.x.id))value.store.saveEndpoint({...endpoint,procStart:runtimeIdentity.startedAt});return value;}

for(const [status,expected] of [[{type:'idle'},'released'],[{type:'systemError'},'released'],[{type:'active'},'retained'],[{type:'active',activeFlags:['waitingForApproval']},'retained'],[{type:'idle',activeFlags:['waitingForUserInput']},'retained'],[{type:'notLoaded'},'unloaded'],[{},'retained']] as const)test('观察租约按原生状态退订：'+JSON.stringify(status),async t=>{
  const adapter=new CodexAdapter(DEFAULT_CONFIG,temporary(t)),store=new Store(':memory:');t.after(()=>{adapter.close();store.close();});
  const peer=store.register(registration('codex','subscription')),endpoint=store.endpoint(peer.id)!,calls:string[]=[];
  const rpc={closed:false,close:()=>{},request:async(method:string)=>{calls.push(method);return{thread:{id:peer.sessionId,status}};}};
  (adapter as any).clients.set(endpoint.address,rpc);(adapter as any).attached.add(endpoint.address+'|'+peer.sessionId);
  assert.equal(await adapter.releaseIdle(peer,endpoint,()=>true),expected);assert.equal(calls.includes('thread/unsubscribe'),expected==='released');
  assert.equal(rpc.closed,false);
});

test('用户状态观察只读取线程，不建立恢复订阅',async t=>{
  const adapter=new CodexAdapter(DEFAULT_CONFIG,temporary(t)),store=new Store(':memory:');t.after(()=>{adapter.close();store.close();});
  const peer=store.register(registration('codex','observe')),endpoint=store.endpoint(peer.id)!,calls:string[]=[];
  adapter.connect=async()=>({request:async(method:string)=>{calls.push(method);return{thread:{id:peer.sessionId,cwd:peer.cwd,status:{type:'idle'}}};}} as any);
  await adapter.observe(peer,endpoint);assert.deepEqual(calls,['thread/read']);assert.equal(adapter.hasSubscription(peer,endpoint),false);
});

test('owner=user 的子代理不属于用户窗口观察租约，也不被自动退订',async t=>{
  const adapter=new CodexAdapter(DEFAULT_CONFIG,temporary(t)),store=new Store(':memory:');t.after(()=>{adapter.close();store.close();});
  const peer=store.register(registration('codex','child-subscription',{kind:'subagent',parentId:'background-root'})),endpoint=store.endpoint(peer.id)!,key=endpoint.address+'|'+peer.sessionId,calls:string[]=[];
  const rpc={closed:false,close:()=>{},request:async(method:string)=>{calls.push(method);return{thread:{id:peer.sessionId,cwd:peer.cwd,parentThreadId:'background-root',status:{type:'active'}}};}};
  (adapter as any).clients.set(endpoint.address,rpc);(adapter as any).attached.add(key);(adapter as any).subscriptionOwners.set(key,{peer,endpoint});
  assert.deepEqual(adapter.userSubscriptions(),[]);assert.equal(await adapter.releaseIdle(peer,endpoint,()=>true,true),'retained');assert.deepEqual(calls,[]);
  await adapter.observeActive(peer,endpoint);assert.deepEqual(calls,['thread/read']);assert.equal(adapter.hasSubscription(peer,endpoint),true);
});

for(const exact of [false,true])test('前台退出不阻止同后台子代理继续工作，也不关闭它的路由：'+exact,async t=>{
  const {store,broker,x,codex}=fixture(t),home=broker.home,endpoint=store.endpoint(x.id)!;store.updatePeer(x.id,{owner:'nxbridge'});
  const child=store.register(registration('codex','background-child',{kind:'subagent',parentId:x.sessionId!,endpoint:{...endpoint,epoch:'child'}})),window=store.register(registration('codex','sibling-window',{endpoint:{...endpoint,epoch:'sibling'}}));store.updatePeer(child.id,{rootPeerId:x.id});
  const childEndpoint=store.endpoint(child.id)!,swept:string[]=[];saveManagedRuntime(home,{id:randomUUID(),owner:managedMarker(home),kind:'owned',state:'ready',endpoint:endpoint.address,createdAt:Date.now(),threadUnloadDelaySecs:0});
  codex.userSubscriptions=()=>[{peer:exact?{...store.peer(child.id),kind:'root' as const}:store.peer(child.id),endpoint:childEndpoint}];codex.hasSubscription=peer=>peer.id===child.id;
  codex.releaseIdle=async peer=>{assert.notEqual(peer.id,child.id);swept.push(peer.id);return'unloaded';};
  await broker.dispatch('codex.foreground.end',{endpoint:endpoint.address,...(exact?{session_id:child.sessionId}:{}),foreground:{pid:process.pid,procStart:'已退出的旧代次'}});
  assert.deepEqual(swept,[window.id]);assert.equal(store.endpoint(child.id)?.active,true);assert.equal(store.endpoint(x.id)?.active,true);assert.equal(store.setting(codexForegroundEndKey(endpoint.address,child.sessionId!)),undefined);
  store.setSetting(codexForegroundEndKey(endpoint.address,child.sessionId!),{epoch:childEndpoint.epoch,exact:true});assert.equal(hostingGate(store,store.peer(child.id)),false);
  codex.observeActive=async()=>assert.fail('子代理不能触发用户窗口的忙碌观察');codex.emit('state',child.sessionId,'busy',endpoint.address);assert.equal((broker as any).codexObservationChecks.size,0);
});

test('观察读取期间出现审批或待投递任务时保留租约',async t=>{
  const adapter=new CodexAdapter(DEFAULT_CONFIG,temporary(t)),store=new Store(':memory:');t.after(()=>{adapter.close();store.close();});
  const peer=store.register(registration('codex','race')),endpoint=store.endpoint(peer.id)!;let allowed=true,unsubscribed=0;
  (adapter as any).attached.add(endpoint.address+'|'+peer.sessionId);
  (adapter as any).clients.set(endpoint.address,{closed:false,close:()=>{},request:async(method:string)=>{if(method==='thread/read')allowed=false;else unsubscribed++;return{thread:{id:peer.sessionId,status:{type:'idle'}}};}});
  assert.equal(await adapter.releaseIdle(peer,endpoint,()=>allowed),'retained');assert.equal(unsubscribed,0);
});

test('退订等待正在提交的唤醒完成，取消等待不提前释放原生提交租约',async t=>{
  const adapter=new CodexAdapter(DEFAULT_CONFIG,temporary(t)),store=new Store(':memory:');t.after(()=>{adapter.close();store.close();});
  const peer=store.register(registration('codex','inflight')),endpoint=store.endpoint(peer.id)!;let finish!:()=>void,entered!:()=>void,unsubscribed=0;
  const pending=new Promise<void>(resolve=>finish=resolve),started=new Promise<void>(resolve=>entered=resolve);
  const rpc={closed:false,close:()=>{},request:async(method:string)=>{if(method==='turn/start'){entered();await pending;}if(method==='thread/unsubscribe')unsubscribed++;return{thread:{id:peer.sessionId,cwd:peer.cwd,status:{type:'idle'}},turn:{id:'turn'}};}};
  adapter.connect=async()=>rpc as any;(adapter as any).clients.set(endpoint.address,rpc);
  const abort=new AbortController(),work=adapter.wake(peer,endpoint,abort.signal);await started;
  const rejected=assert.rejects(work,(error:any)=>error.uncertain===true);abort.abort();await rejected;
  assert.equal(await adapter.releaseIdle(peer,endpoint,()=>true),'retained');assert.equal(unsubscribed,0);
  finish();await (adapter as any).threadOperations.get(endpoint.address+'|'+peer.sessionId);
  assert.equal(await adapter.releaseIdle(peer,endpoint,()=>true),'released');assert.equal(unsubscribed,1);
});

for(const hold of ['后台托管','待投递消息','待续跑','挂起问题','待唤醒通知','原生审批'] as const)test('后台轮询保留仍有工作或所有权的线程：'+hold,async t=>{
  const {store,broker,c,x,codex}=fixture(t),pair=store.pair(c.id,x.id);let released=0;
  codex.releaseIdle=async(_peer,_endpoint,guard)=>{if(guard())released++;return'released';};
  if(hold==='后台托管')store.updatePeer(x.id,{owner:'nxbridge'});
  if(hold==='待投递消息')store.accept(pair,c,'待处理消息','subscription-hold');
  if(hold==='待续跑')store.setSetting('codexDirect:'+x.id,{scope:'scope',attempts:[{id:'pending'}]});
  if(hold==='挂起问题')t.mock.method(store,'questions',()=>[{pairId:pair.id}] as any);
  if(hold==='待唤醒通知')t.mock.method(broker.deliveryHealth,'peek',()=>[{wake:true}] as any);
  if(hold==='原生审批')store.updatePeer(x.id,{state:'needsHuman'});
  await (broker as any).releaseIdleCodexSubscriptions();assert.equal(released,0);
});

test('无 UUID 的选择器退出仅扫用户观察订阅，原生证明卸载后才结束路由',async t=>{
  const {store,broker,x,codex}=fixture(t),endpoint=store.endpoint(x.id)!;
  const second=store.register(registration('codex','other-window',{endpoint:{...endpoint,epoch:'other-window'}})),managed=store.register(registration('codex','managed',{endpoint:{...endpoint,epoch:'managed'}}));store.updatePeer(managed.id,{owner:'nxbridge'});
  const swept:string[]=[];let unloaded=false;
  codex.releaseIdle=async(peer,_ep,guard)=>{assert.equal(guard(),true);swept.push(peer.id);return unloaded&&peer.id===x.id?'unloaded':'released';};
  const input={endpoint:endpoint.address,foreground:{pid:process.pid,procStart:'已退出的旧代次'}};
  await broker.dispatch('codex.foreground.end',input);
  assert.deepEqual(swept.sort(),[x.id,second.id].sort());assert.equal(store.endpoint(x.id)?.active,true);assert.equal(store.endpoint(second.id)?.active,true);
  unloaded=true;await broker.dispatch('codex.foreground.end',input);
  assert.equal(store.endpoint(x.id),undefined);assert.equal(store.endpoint(second.id)?.active,true);assert.equal(store.endpoint(managed.id)?.active,true);
});

test('窗口内切换会话后仍退订旧线程，旧线程卸载不会关闭新会话路由',async t=>{
  const {store,broker,x,codex}=fixture(t),endpoint=store.endpoint(x.id)!,seen:string[]=[];
  codex.userSubscriptions=()=>[{peer:x,endpoint}];store.updatePeer(x.id,{sessionId:'switched-session'});
  codex.releaseIdle=async(peer,_ep,guard)=>{assert.equal(guard(),true);seen.push(peer.sessionId!);return peer.sessionId===x.sessionId?'unloaded':'retained';};
  await (broker as any).releaseIdleCodexSubscriptions();assert.ok(seen.includes(x.sessionId!));assert.equal(store.endpoint(x.id)?.active,true);assert.equal(store.peer(x.id).sessionId,'switched-session');
});

for(const delay of [undefined,0])test('明确 UUID 的旧窗口退出仅对旧后台提前关闭路由：'+String(delay),async t=>{
  const {store,broker,x,codex}=fixture(t),home=broker.home,endpoint=store.endpoint(x.id)!;
  saveManagedRuntime(home,{id:randomUUID(),owner:managedMarker(home),kind:'owned',state:'ready',endpoint:endpoint.address,createdAt:Date.now(),...(delay===undefined?{}:{threadUnloadDelaySecs:delay})});
  codex.releaseIdle=async()=> 'released';
  await broker.dispatch('codex.foreground.end',{endpoint:endpoint.address,session_id:x.sessionId,foreground:{pid:process.pid,procStart:'已退出的旧代次'}});
  assert.equal(store.endpoint(x.id)?.active,delay===0?true:undefined);
});

test('慢线程的观察清理并行推进，定时轮询不等待原生读取',async t=>{
  const {store,broker,x,codex}=fixture(t),endpoint=store.endpoint(x.id)!;store.register(registration('codex','parallel-thread',{endpoint:{...endpoint,epoch:'parallel'}}));
  let finish!:()=>void,started=0;const pending=new Promise<void>(resolve=>finish=resolve);
  codex.releaseIdle=async()=>{started++;await pending;return'retained';};
  await (broker as any).releaseIdleCodexSubscriptions(undefined,undefined,false);
  assert.equal(started,2);await (broker as any).releaseIdleCodexSubscriptions(undefined,undefined,false);assert.equal(started,2);
  finish();await Promise.all((broker as any).codexSubscriptionChecks.values());
});

test('明确退出的旧后台线程先完成运行中的任务，再由轮询关闭原路由',async t=>{
  const {store,broker,x,codex}=fixture(t),home=broker.home,endpoint=store.endpoint(x.id)!;
  saveManagedRuntime(home,{id:randomUUID(),owner:managedMarker(home),kind:'owned',state:'ready',endpoint:endpoint.address,createdAt:Date.now()});
  let idle=false;codex.releaseIdle=async()=>idle?'released':'retained';
  await broker.dispatch('codex.foreground.end',{endpoint:endpoint.address,session_id:x.sessionId,foreground:{pid:process.pid,procStart:'已退出的旧代次'}});
  assert.equal(store.endpoint(x.id)?.active,true);idle=true;await (broker as any).releaseIdleCodexSubscriptions();assert.equal(store.endpoint(x.id),undefined);
});

for(const changed of [false,true])test('退出意图跨协调器重启保留，且只适用于原运行时代次：'+changed,async t=>{
  const home=temporary(t),store=new Store(':memory:'),codex=new FakeAdapter(),adapters={codex,claude:new FakeAdapter()} as unknown as Adapters;
  let broker=new Broker(store,DEFAULT_CONFIG,adapters,home);
  t.after(async()=>{await broker.stop();store.close();});
  const peer=store.register(registration('codex','restart-close')),endpoint=store.endpoint(peer.id)!,runtime={id:randomUUID(),owner:managedMarker(home),kind:'owned' as const,state:'ready' as const,endpoint:endpoint.address,createdAt:Date.now(),pid:process.pid,procStart:'原代次'};
  store.saveEndpoint({...endpoint,procStart:runtimeIdentity.startedAt});
  saveManagedRuntime(home,runtime);codex.releaseIdle=async()=> 'retained';
  await broker.dispatch('codex.foreground.end',{endpoint:endpoint.address,session_id:peer.sessionId,foreground:{pid:process.pid,procStart:'已退出的旧代次'}});
  await broker.stop();if(changed)saveManagedRuntime(home,{...runtime,procStart:'新代次'});
  broker=new Broker(store,DEFAULT_CONFIG,adapters,home);codex.releaseIdle=async()=> 'released';
  await (broker as any).releaseIdleCodexSubscriptions();assert.equal(store.endpoint(peer.id)?.active,changed?true:undefined);
});

test('原会话显式重新打开会清除尚待空闲的退出意图',async t=>{
  const {store,broker,x,codex}=fixture(t),home=broker.home,endpoint=store.endpoint(x.id)!;
  saveManagedRuntime(home,{id:randomUUID(),owner:managedMarker(home),kind:'owned',state:'ready',endpoint:endpoint.address,createdAt:Date.now()});
  codex.releaseIdle=async()=> 'retained';(codex as any).resumeForeground=async()=>{};
  await broker.dispatch('codex.foreground.end',{endpoint:endpoint.address,session_id:x.sessionId,foreground:{pid:process.pid,procStart:'已退出的旧代次'}});
  await broker.dispatch('codex.foreground.prepare',{endpoint:endpoint.address,session_id:x.sessionId,cwd:x.cwd,home});
  codex.releaseIdle=async()=> 'released';await (broker as any).releaseIdleCodexSubscriptions();assert.equal(store.endpoint(x.id)?.active,true);
});

for(const status of ['active','idle','notLoaded'])test('运行中观察只订阅仍然活跃的原生线程：'+status,async t=>{
  const adapter=new CodexAdapter(DEFAULT_CONFIG,temporary(t)),store=new Store(':memory:');t.after(()=>{adapter.close();store.close();});
  const peer=store.register(registration('codex','active-observer')),endpoint=store.endpoint(peer.id)!,calls:string[]=[];
  const rpc={closed:false,close:()=>{},request:async(method:string)=>{calls.push(method);return{thread:{id:peer.sessionId,cwd:peer.cwd,status:{type:status}}};}};
  (adapter as any).clients.set(endpoint.address,rpc);await adapter.observeActive(peer,endpoint);
  assert.equal(calls.includes('thread/resume'),status==='active');assert.equal(adapter.hasSubscription(peer,endpoint),status==='active');
});

test('用户轮次的全局忙碌通知恢复观察，补回轮次健康和切换间隙的工具回执',async t=>{
  const {store,broker,x,c,codex}=fixture(t),pair=store.pair(c.id,x.id),endpoint=store.endpoint(x.id)!,message=store.accept(pair,c,'观察恢复期间的消息','observer-receipt');
  store.transition(message.id,'runtimeQueued','原生已接受');
  let subscriptions=0,finish!:()=>void;const waiting=new Promise<void>(resolve=>finish=resolve);
  codex.observeActive=async()=>{subscriptions++;await waiting;};
  codex.injectionState=async()=>({thread:{id:x.sessionId!,cwd:x.cwd,status:{type:'active'},turns:[{id:'user-turn',status:'inProgress',items:[{id:'output',type:'functionCallOutput',namespace:'claude',name:'receive_messages',output:JSON.stringify({messages:[{message_id:message.id}]})},{id:'command',type:'commandExecution',status:'inProgress'}]}]},history:{status:'supported',receipts:[],calls:[]}} as any);
  codex.emit('state',x.sessionId,'busy',endpoint.address);codex.emit('state',x.sessionId,'needsHuman',endpoint.address);finish();
  await Promise.all((broker as any).codexObservationChecks.values());
  assert.equal(subscriptions,1);assert.equal(store.message(message.id).state,'contextObserved');assert.equal((broker as any).health.get(endpoint.address,x.sessionId).turnId,'user-turn');
  codex.emit('native',{address:endpoint.address,message:{method:'thread/status/changed',params:{threadId:x.sessionId,status:{type:'active',activeFlags:['waitingForApproval']}}}});
  assert.equal((broker as any).health.get(endpoint.address,x.sessionId).state,'needsHuman');
});

for(const [state,completed] of [['busy',false],['needsHuman',false],['busy',true]] as const)test('旧观察读取期间出现新一轮活动后补读最新轮次：'+state+'/'+completed,async t=>{
  const {store,broker,x,c,codex}=fixture(t),endpoint=store.endpoint(x.id)!,pair=store.pair(c.id,x.id),message=store.accept(pair,c,'补回新轮次的回执','observer-new-turn');
  store.transition(message.id,'runtimeQueued','原生已接受');
  let observations=0,reads=0,finish!:()=>void,entered!:()=>void;
  const pending=new Promise<void>(resolve=>finish=resolve),reading=new Promise<void>(resolve=>entered=resolve);
  codex.observeActive=async()=>{observations++;};
  codex.injectionState=async()=>{
    if(++reads===1){entered();await pending;return{thread:{id:x.sessionId!,cwd:x.cwd,status:{type:'idle'},turns:[{id:'old-turn',status:'completed',items:[]}]},history:{status:'supported',receipts:[],calls:[]}} as any;}
    return{thread:{id:x.sessionId!,cwd:x.cwd,status:{type:completed?'idle':'active'},turns:[{id:'new-turn',status:completed?'completed':'inProgress',items:[{id:'new-receipt',type:'functionCallOutput',namespace:'claude',name:'receive_messages',output:JSON.stringify({messages:[{message_id:message.id}]})}]}]},history:{status:'supported',receipts:[],calls:[]}} as any;
  };
  codex.emit('state',x.sessionId,'busy',endpoint.address);await reading;
  codex.emit('state',x.sessionId,'ready',endpoint.address);codex.emit('state',x.sessionId,state,endpoint.address);
  if(completed)codex.emit('state',x.sessionId,'ready',endpoint.address);
  finish();await Promise.all((broker as any).codexObservationChecks.values());
  assert.equal(observations,2);assert.equal(reads,2);
  assert.equal((broker as any).health.get(endpoint.address,x.sessionId).turnId,'new-turn');assert.equal(store.message(message.id).state,'contextObserved');
});

test('从未运行的原生线程明确未加载时关闭路由，不把其他读取失败当作卸载',async t=>{
  const adapter=new CodexAdapter(DEFAULT_CONFIG,temporary(t)),store=new Store(':memory:');t.after(()=>{adapter.close();store.close();});
  const peer=store.register(registration('codex','empty-thread')),endpoint=store.endpoint(peer.id)!;let unloaded=true;
  (adapter as any).clients.set(endpoint.address,{closed:false,close:()=>{},request:async()=>{throw Object.assign(Error(unloaded?'thread not loaded: '+peer.sessionId:'database unavailable'),{code:-32600});}});
  assert.equal(await adapter.releaseIdle(peer,endpoint,()=>true),'unloaded');unloaded=false;await assert.rejects(adapter.releaseIdle(peer,endpoint,()=>true),/database unavailable/);
});

test('已退出的窗口不因待投递消息继续后台运行，原生卸载后关闭路由并保留消息',async t=>{
  const {store,broker,x,c,codex}=fixture(t),pair=store.pair(c.id,x.id),endpoint=store.endpoint(x.id)!,home=broker.home;
  saveManagedRuntime(home,{id:randomUUID(),owner:managedMarker(home),kind:'owned',state:'ready',endpoint:endpoint.address,createdAt:Date.now(),threadUnloadDelaySecs:0});
  const pending=store.accept(pair,c,'等待原窗口再次打开','closed-window-pending');let finished=false;
  codex.releaseIdle=async(_peer,_endpoint,guard,closing)=>{assert.equal(guard(),true);assert.equal(closing,true);return finished?'unloaded':'retained';};
  await broker.dispatch('codex.foreground.end',{endpoint:endpoint.address,session_id:x.sessionId,foreground:{pid:process.pid,procStart:'已退出的旧代次'}});
  assert.equal(hostingGate(store,store.peer(x.id)),true);await broker.pump();assert.equal(codex.woken.length,0);assert.equal(codex.injected.length,0);
  finished=true;await (broker as any).releaseIdleCodexSubscriptions();assert.equal(store.endpoint(x.id),undefined);assert.equal(store.message(pending.id).state,'accepted');
});

test('零宽限期退订后另一个窗口仍订阅同一线程才恢复投递',async t=>{
  const {store,broker,x,codex}=fixture(t),endpoint=store.endpoint(x.id)!,home=broker.home;
  saveManagedRuntime(home,{id:randomUUID(),owner:managedMarker(home),kind:'owned',state:'ready',endpoint:endpoint.address,createdAt:Date.now(),threadUnloadDelaySecs:0});
  codex.releaseIdle=async()=> 'released';await broker.dispatch('codex.foreground.end',{endpoint:endpoint.address,session_id:x.sessionId,foreground:{pid:process.pid,procStart:'已退出的旧代次'}});
  assert.equal(hostingGate(store,store.peer(x.id)),true);codex.releaseIdle=async()=> 'idle';await (broker as any).releaseIdleCodexSubscriptions();assert.equal(hostingGate(store,store.peer(x.id)),false);assert.equal(store.endpoint(x.id)?.active,true);
});

for(const restart of [false,true])test('终端强退没有 finally 时仍阻止排队消息唤醒，且窗口记录跨重启：'+restart,async t=>{
  const home=temporary(t),store=new Store(':memory:'),codex=new FakeAdapter(),adapters={codex,claude:new FakeAdapter()} as unknown as Adapters;
  let broker=new Broker(store,DEFAULT_CONFIG,adapters,home);t.after(async()=>{await broker.stop();store.close();});
  const peer=store.register(registration('codex','closed-console')),partner=store.register(registration('claude','console-partner')),pair=store.pair(partner.id,peer.id),endpoint=store.endpoint(peer.id)!;
  store.saveEndpoint({...endpoint,procStart:runtimeIdentity.startedAt});saveManagedRuntime(home,{id:randomUUID(),owner:managedMarker(home),kind:'owned',state:'ready',endpoint:endpoint.address,createdAt:Date.now(),threadUnloadDelaySecs:0});
  const pending=store.accept(pair,partner,'原窗口回来后再处理','console-pending');let unloaded=false;
  codex.releaseIdle=async(_peer,_endpoint,guard,closing)=>{assert.equal(guard(),true);assert.equal(closing,true);return unloaded?'unloaded':'retained';};
  await broker.dispatch('codex.foreground.started',{endpoint:endpoint.address,session_id:peer.sessionId,foreground:{pid:process.pid,procStart:'已退出的终端代次'}});
  if(restart){await broker.stop();broker=new Broker(store,DEFAULT_CONFIG,adapters,home);}
  await broker.pump();assert.equal(hostingGate(store,store.peer(peer.id)),true);assert.equal(codex.woken.length+codex.injected.length,0);assert.equal(store.message(pending.id).state,'accepted');
  unloaded=true;await (broker as any).releaseIdleCodexSubscriptions();assert.equal(store.endpoint(peer.id),undefined);
  const reopened=await broker.dispatch('register',registration('codex',peer.sessionId!,{endpoint:{mode:'embedded',epoch:'native-reopened',address:'embedded:new',pid:process.pid,procStart:runtimeIdentity.startedAt,processKind:'foreground'}})) as {id:string};
  assert.equal(reopened.id,peer.id);assert.equal(hostingGate(store,store.peer(peer.id)),false,'官方原生 hooks 重新登记后不受旧远程端点的退出屏障阻拦');
});

test('刚解除配对的专属后台不返回直接接入端点，正常用户后台仍可使用',async t=>{
  const {store,broker,x,c,codex}=fixture(t),endpoint=store.endpoint(x.id)!,pair=store.pair(c.id,x.id);store.updatePeer(x.id,{owner:'nxbridge'});
  store.saveEndpoint({...endpoint,configHome:'/original-home'});
  let owned=true;(codex as any).loadedRuntime=async()=>({endpoint:endpoint.address,...(owned?{peerId:x.id}:{})});
  const input={session_id:x.sessionId,home:'/original-home',loaded_only:true};
  const ready=await broker.dispatch('hosting.resolve',input) as any;assert.equal(ready.member_id,x.id);
  store.unpair(pair.id);const result=await broker.dispatch('hosting.resolve',input) as any;assert.equal(result.endpoint,undefined);assert.match(result.unavailable,/稍等.*nxbridge status/);
  owned=false;assert.equal((await broker.dispatch('hosting.resolve',input) as any).endpoint,endpoint.address);
});
