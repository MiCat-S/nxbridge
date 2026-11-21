import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdirSync, writeFileSync } from 'node:fs';
import { CodexDaemons, daemonPermission, daemonRegistration, type DaemonDomain } from '../hosts/codex/codex-daemon.js';
import { processIdentity } from '../process/process.js';
import { normalizedHome, windowKey } from '../integration/hooks/session-bindings.js';
import { codexIdentity } from '../integration/mcp/server.js';
import {fixture, lifecycle} from './support/broker-fixture.js';
import { registration } from './support/registration.js';
import { temporary } from './support/temporary.js';
import type { Actor, Endpoint } from '../types.js';
import type { CodexThread } from '../hosts/codex/adapter.js';

const thread=(id:string,extra:Partial<CodexThread>={}):CodexThread=>({id,cwd:path.resolve('/project'),source:'cli',status:{type:'idle'},...extra});
const actor=(id:string,sessionId:string,binding:{key:string;epoch:string}):Actor=>({host:'codex',memberId:id,sessionId,callId:'call-'+sessionId,binding});
async function setup(t:Parameters<typeof fixture>[0]){
  const f=fixture(t,{compatibilityWake:'notify'}),native=await processIdentity(process.pid),domain:DaemonDomain={configHome:temporary(t),pid:process.pid,procStart:native.startedAt,address:'unix://daemon-test'};
  mkdirSync(path.join(domain.configHome,'app-server-daemon'));writeFileSync(path.join(domain.configHome,'app-server-daemon','daemon.pid'),JSON.stringify({pid:domain.pid}),'utf8');
  const client=new CodexDaemons(f.store,f.broker.config,domain.configHome,async input=>(f.broker as any).register(input));t.after(()=>client.close());
  return{...f,client,domain};
}

test('共享进程内按原生线程及项目分别登记，线程元数据覆盖 MCP 启动目录',async t=>{
  const f=await setup(t),other=path.resolve('/other');
  await f.client.applySnapshot(f.domain,[thread('a'),thread('b',{cwd:other})]);
  const a=f.store.find('codex','a')!,b=f.store.find('codex','b')!,ba=f.store.bindings.current(a.id)!,bb=f.store.bindings.current(b.id)!;
  assert.notEqual(ba.key,bb.key);assert.equal(ba.threadId,'a');assert.equal(bb.threadId,'b');assert.equal(b.cwd,other);
  assert.equal(f.store.resolve(actor(a.id,'a',ba))!.id,a.id);
  assert.throws(()=>f.store.resolve(actor(b.id,'b',ba)),{code:'stale_context'});
  const raw=codexIdentity({threadId:'b',sessionId:'b','x-codex-turn-metadata':{sandbox_mode:'read-only'}},'/stale-cwd',{...f.domain,appServer:true,managedDaemon:true});
  assert.ok(raw.registration.endpoint.daemon);assert.equal(raw.registration.permission,'prompting');
  assert.notEqual(windowKey(ba),windowKey({...ba,configHome:temporary(t)}));
});

test('daemon 消息只在目标线程取件，空闲与忙碌均不提交队列唤醒',async t=>{
  const f=await setup(t);await f.client.applySnapshot(f.domain,[thread('a'),thread('b')]);
  const a=f.store.find('codex','a')!,b=f.store.find('codex','b')!,pair=f.store.pair(f.c.id,a.id),ba=f.store.bindings.current(a.id)!,bb=f.store.bindings.current(b.id)!;
  const message=f.store.accept(pair,f.c,'只送给 a','first');let queued=0;(f.broker as any).wakeSignals={signal:async()=>{queued++;}};
  for(const state of ['ready','busy'] as const){f.store.updatePeer(a.id,{state});await f.broker.pump();await (f.broker as any).signalEmbeddedWake(f.store.peer(a.id),f.store.endpoint(a.id));}
  assert.equal(queued,0);assert.equal(f.codex.delivered.length,0);assert.equal(f.store.message(message.id).state,'accepted');
  assert.throws(()=>f.broker.receive(actor(b.id,'b',bb)),{code:'unpaired'});
  const received=f.broker.receive(actor(a.id,'a',ba)) as any;assert.equal(received.messages[0].message,'只送给 a');assert.equal(f.store.message(message.id).state,'unknown');
  f.store.updatePeer(a.id,{permission:'prompting'});                             
  f.store.saveEndpoint({...f.store.endpoint(a.id)!,codexPermission:{sandbox:'read-only'}});
  await f.broker.dispatch('hook',{actor:actor(a.id,'a',ba),session_id:'a',hook_event_name:'PostToolUse',tool_name:'claude.receive_messages',tool_response:received,permission_mode:'bypassPermissions'});
  assert.equal(f.store.message(message.id).state,'contextObserved');assert.equal(f.store.peer(a.id).permission,'unknown','审批变化后旧沙箱失效；仅有 hook 不能推断完整访问');
  const fresh=daemonRegistration(thread('a'),f.domain);Object.assign(fresh.endpoint.daemon!,{approval:'bypass',sandbox:'read-only',autoReview:false});
  await (f.broker as any).register(fresh);assert.equal(f.store.peer(a.id).permission,'prompting','同一时刻的完整原生证据恢复准确类别');
});

test('daemon 仅被发现不告警回复协议；恢复重置宽限，真实交互后才检查并提示原窗口继续',async t=>{
  const f=await setup(t);t.mock.timers.enable({apis:['Date'],now:1000000});
  await f.client.applySnapshot(f.domain,[thread('old-contract')]);const peer=f.store.find('codex','old-contract')!,pair=f.store.pair(f.c.id,peer.id),binding=f.store.bindings.current(peer.id)!;
  const observe=()=>{f.broker.pairAnomalies.observe(pair,f.store.peer(peer.id));return f.broker.pairAnomalies.issues(peer.id).find(issue=>issue.kind==='contract_inactive');};
  t.mock.timers.tick(300000);assert.equal(observe(),undefined);
  const input={actor:actor(peer.id,peer.sessionId!,binding),session_id:peer.sessionId};
  await f.broker.dispatch('hook',{...input,hook_event_name:'SessionStart',source:'resume'});t.mock.timers.tick(300000);assert.equal(observe(),undefined);
  await f.broker.dispatch('hook',{...input,hook_event_name:'UserPromptSubmit',prompt:'继续原会话'});t.mock.timers.tick(119999);assert.equal(observe(),undefined);
  t.mock.timers.tick(2);const issue=observe();assert.ok(issue);assert.match(issue.message,/existing Codex window/);assert.match(issue.message,/discovery\/resume alone does not/);
  await f.broker.dispatch('hook',{...input,hook_event_name:'SessionStart',source:'resume'});assert.equal(observe(),undefined);
  f.store.adoptReplyContract(peer.id,'mcp');t.mock.timers.tick(300000);assert.equal(observe(),undefined);
});

test('同一线程只合并仍有效的权限证据；审批变化使旧沙箱和审核者失效，完整证据恢复准确类别',async t=>{
  const f=await setup(t),root=thread('permission');
  const observe=async(evidence:Partial<NonNullable<Endpoint['daemon']>>)=>{
    const input=daemonRegistration(root,f.domain);Object.assign(input.endpoint.daemon!,evidence);
    return (f.broker as any).register(input);
  };
  let peer=await observe({approval:'bypass'});assert.equal(peer.permission,'unknown');
  const mcp=codexIdentity({threadId:root.id,'x-codex-turn-metadata':{sandbox_mode:'read-only',auto_review_enabled:false}},root.cwd,{...f.domain,appServer:true,managedDaemon:true}).registration;
  peer=await observe(mcp.endpoint.daemon!);assert.equal(peer.permission,'prompting');
  peer=await observe({approval:'bypass'});assert.equal(peer.permission,'prompting');
  peer=await observe({});assert.equal(peer.permission,'prompting');
  peer=await observe({sandbox:'danger-full-access'});assert.equal(peer.permission,'bypass');
  peer=await observe({approval:'prompting'});assert.equal(peer.permission,'prompting');
  peer=await observe({approval:'bypass',autoReview:true});assert.equal(peer.permission,'unknown');
  peer=await observe({autoReview:false});assert.equal(peer.permission,'unknown','不能将新审核者与审批变化前的旧沙箱拼成完整访问');
  peer=await observe({approval:'bypass',sandbox:'danger-full-access',autoReview:false});assert.equal(peer.permission,'bypass');
  peer=await observe({sandbox:'workspace-write'});assert.equal(peer.permission,'prompting');
  const changed=daemonRegistration(thread('different'),f.domain);assert.equal(daemonPermission(changed.endpoint.daemon!),'unknown');
  const next=await (f.broker as any).register(changed);assert.equal(next.permission,'unknown');
});

test('官方卸载保留原配对及未提交消息；新线程不能自动承接，旧回调失效',async t=>{
  const f=await setup(t);await f.client.applySnapshot(f.domain,[thread('old')]);const old=f.store.find('codex','old')!,binding=f.store.bindings.current(old.id)!,pair=f.store.pair(f.c.id,old.id),message=f.store.accept(pair,f.c,'保留任务','held');
  await f.client.applySnapshot(f.domain,[thread('new')]);
  assert.equal(f.store.pairFor(f.c.id)?.id,pair.id);assert.equal(f.store.message(message.id).state,'accepted');assert.equal(f.store.peer(old.id).state,'offline');
  assert.throws(()=>f.store.resolve(actor(old.id,'old',binding)),{code:'stale_context'});
  assert.ok(!f.store.setting('pairLoss:'+f.c.id));assert.equal(f.store.find('codex','new')!.owner,'user');assert.equal(f.store.pairFor(f.store.find('codex','new')!.id),undefined);
});

test('fork 只在父线程正式结束且后继唯一时继承，活父或多个后继保留用户选择',async t=>{
  const f=await setup(t),parent=thread('parent'),fork=thread('fork',{forkedFromId:'parent'});
  await f.client.applySnapshot(f.domain,[parent,fork]);const root=f.store.find('codex','parent')!,pair=f.store.pair(f.c.id,root.id);
  await f.client.applySnapshot(f.domain,[parent,fork]);assert.equal(f.store.pairFor(root.id)!.id,pair.id);assert.equal(f.store.peer(root.id).sessionId,'parent');
  await f.client.applySnapshot(f.domain,[fork]);assert.equal(f.store.peer(root.id).sessionId,'fork');assert.equal(f.store.pairFor(root.id)!.id,pair.id);assert.equal(f.store.peers().filter(peer=>peer.sessionId==='fork').length,1);
  const c=f.store.register(registration('claude','other-c'));await f.client.applySnapshot(f.domain,[fork,thread('p2')]);const p2=f.store.find('codex','p2')!;f.store.pair(c.id,p2.id);
  await f.client.applySnapshot(f.domain,[fork,thread('f2',{forkedFromId:'p2'}),thread('f3',{forkedFromId:'p2'})]);assert.equal(f.store.pairFor(c.id)?.codex,p2.id);
  const message=f.store.accept(pair,f.c,'父结束后交给后继的任务','after-fork');
  await f.client.applySnapshot(f.domain,[]);assert.equal(f.store.pairFor(root.id)?.id,pair.id);assert.equal(f.store.message(message.id).state,'accepted');
});

test('结束 hook 与卸载扫描交叠仍结束当前线程，不重复解析已切换上下文',async t=>{
  const f=await setup(t);await f.client.applySnapshot(f.domain,[thread('ending')]);
  const peer=f.store.find('codex','ending')!,binding=f.store.bindings.current(peer.id)!,pair=f.store.pair(f.c.id,peer.id),message=f.store.accept(pair,f.c,'原线程结束后保留','end-overlap');
  await f.broker.dispatch('hook',{actor:actor(peer.id,peer.sessionId!,binding),session_id:peer.sessionId,hook_event_name:'SessionEnd'});
  assert.equal(f.store.pairFor(peer.id)?.id,pair.id);assert.equal(f.store.message(message.id).state,'accepted');assert.equal(f.store.bindings.current(peer.id)?.transitioning,true);
  await f.client.applySnapshot(f.domain,[]);assert.equal(f.store.endpoint(peer.id),undefined);assert.equal(f.store.peer(peer.id).state,'offline');
  await f.client.applySnapshot(f.domain,[thread('transitioning')]);const next=f.store.find('codex','transitioning')!;
  f.store.endContext({host:'codex',memberId:next.id,sessionId:next.sessionId!,callId:'earlier-end'});
  await f.client.applySnapshot(f.domain,[]);assert.equal(f.store.peer(next.id).state,'offline');assert.equal(f.store.bindings.current(next.id),undefined);
});

test('实际入站不使用发现缓存复活已卸载线程，子线程父链逐级取当前原生证据',async t=>{
  const f=await setup(t),root=thread('current'),child=thread('nested',{parentThreadId:root.id}),calls:string[]=[];
  let loaded=false,endDuringRead=false;
  const rpc={closed:false,close(){this.closed=true;},request:async(_method:string,params:{threadId:string})=>{calls.push(params.threadId);if(endDuringRead&&params.threadId===root.id)await f.client.ended(f.store.find('codex',root.id)!);return{thread:{...(params.threadId===child.id?child:root),status:{type:loaded?'idle':'notLoaded'}}};}};
  (f.client as any).clients.set(normalizedHome(f.domain.configHome),{...f.domain,rpc,at:Date.now(),revision:0,threads:[root,child]});
  await assert.rejects(f.client.registration(f.domain.configHome,f.domain,root.id),{code:'daemon_thread_ended'});assert.deepEqual(calls,[root.id]);
  loaded=true;calls.length=0;
  const input=await f.client.registration(f.domain.configHome,f.domain,child.id);
  assert.deepEqual(calls,[child.id,root.id]);assert.equal(input.kind,'subagent');assert.equal(input.endpoint.daemon?.rootSessionId,root.id);
  endDuringRead=true;
  await assert.rejects(f.client.registration(f.domain.configHome,f.domain,child.id),{code:'daemon_thread_ended'});
  assert.equal(f.store.peer(f.store.find('codex',root.id)!.id).state,'offline');
});

test('无关线程的慢后台扫描不阻塞目标注册，父链仍逐级核验且完整快照照常应用',async t=>{
  const f=await setup(t),root=thread('target-root'),child=thread('target-child',{parentThreadId:root.id});
  const unrelated=Array.from({length:64},(_,index)=>thread('unrelated-'+index)),threads=new Map([...unrelated,root,child].map(value=>[value.id,value])),calls:string[]=[];
  let release!:()=>void,entered!:()=>void;
  const gate=new Promise<void>(resolve=>release=resolve),scanning=new Promise<void>(resolve=>entered=resolve);
  const rpc={closed:false,close(){this.closed=true;},request:async(method:string,params:{threadId:string})=>{
    if(method==='thread/loaded/list')return{data:gateReleased?[...threads.keys()]:unrelated.map(value=>value.id)};
    calls.push(params.threadId);if(params.threadId.startsWith('unrelated-')){entered();await gate;}
    return{thread:threads.get(params.threadId)};
  }};
  let gateReleased=false;
  (f.client as any).clients.set(normalizedHome(f.domain.configHome),{...f.domain,rpc,at:0,revision:0,threads:[]});
  const background=f.client.scan(f.domain.configHome,f.domain);await scanning;
  try{
    const input=await f.client.registration(f.domain.configHome,f.domain,child.id);
    assert.deepEqual(calls,['unrelated-0',child.id,root.id]);assert.equal(input.kind,'subagent');assert.equal(input.endpoint.daemon?.rootSessionId,root.id);
    assert.equal(f.store.find('codex','unrelated-0'),undefined,'入站核验不能提前应用未完成的后台快照');
  }finally{gateReleased=true;release();await background;}
  assert.ok(f.store.bindings.current(f.store.find('codex',root.id)!.id),'旧列表缺少刚核验的目标，不能结束其租约');
  await f.client.scan(f.domain.configHome,f.domain,true);
  assert.ok(unrelated.every(value=>f.store.find('codex',value.id)),'慢读取结束后后台仍应用全部线程');
  assert.ok(f.store.find('codex',root.id));
});

test('打断的完整扫描不能把仍加载的托管会话判为死亡，并列核验返回未知',async t=>{
  const f=await setup(t),held=thread('external-held'),newcomer=thread('newcomer');await f.client.applySnapshot(f.domain,[held]);
  let release!:()=>void,entered!:()=>void,holderEntered!:()=>void;
  const gate=new Promise<void>(resolve=>release=resolve),scanning=new Promise<void>(resolve=>entered=resolve),checking=new Promise<void>(resolve=>holderEntered=resolve);
  const rpc={closed:false,close(){this.closed=true;},request:async(method:string,params:{threadId:string})=>{
    if(method==='thread/loaded/list')return{data:['slow-unrelated']};
    if(params.threadId==='slow-unrelated'){entered();await gate;return{thread:thread(params.threadId)};}
    return{thread:params.threadId===held.id?held:newcomer};
  }};
  (f.client as any).clients.set(normalizedHome(f.domain.configHome),{...f.domain,rpc,at:0,revision:0,threads:[]});
  t.mock.method(f.broker.daemons,'scan',(...args:Parameters<typeof f.client.scan>)=>f.client.scan(...args));const background=f.client.scan(f.domain.configHome,f.domain,true),backgroundRejected=assert.rejects(background,{code:'daemon_snapshot_changed'});await scanning;
  const scan=f.client.scan.bind(f.client);t.mock.method(f.client,'scan',(...args:Parameters<typeof scan>)=>{if(args[2])holderEntered();return scan(...args);});
  const holder=lifecycle(f.broker).nativeSessionState(f.store.find('codex',held.id)!);
  try{await checking;await f.client.registration(f.domain.configHome,f.domain,newcomer.id);}finally{release();await backgroundRejected;}
  assert.equal(await holder,'unknown','被打断的旧列表不能被用作放行第二持有者的死亡证明');
});

test('状态变化不饿死后台扫描，新鲜入站状态覆盖同轮旧读取',async t=>{
  const f=await setup(t),root=thread('active-target'),active=thread(root.id,{status:{type:'active'}});let reads=0,release!:()=>void,entered!:()=>void;
  const gate=new Promise<void>(resolve=>release=resolve),scanning=new Promise<void>(resolve=>entered=resolve);
  const rpc={closed:false,close(){this.closed=true;},request:async(method:string)=>{
    if(method==='thread/loaded/list')return{data:[root.id]};
    if(++reads===1){entered();await gate;return{thread:root};}return{thread:active};
  }};
  const connection={...f.domain,rpc,at:0,revision:0,threads:[root]};(f.client as any).clients.set(normalizedHome(f.domain.configHome),connection);
  const background=f.client.scan(f.domain.configHome,f.domain,true);await scanning;
  try{for(let index=0;index<4;index++)await f.client.registration(f.domain.configHome,f.domain,root.id);assert.equal(connection.revision,0);}finally{release();await background;}
  assert.ok(connection.at>0);assert.equal(connection.threads[0]!.status?.type,'active');assert.equal(f.store.find('codex',root.id)?.state,'busy');
});

test('新鲜扫描加入缓存查询时另取完整列表，不能把刚加载的无 hook 会话判为死亡',async t=>{
  const f=await setup(t),loaded=thread('hookless-loaded'),calls:string[]=[];
  const rpc={closed:false,close(){this.closed=true;},request:async(method:string)=>{calls.push(method);return method==='thread/loaded/list'?{data:[loaded.id]}:{thread:loaded};}};
  const connection={...f.domain,rpc,at:Date.now(),revision:0,threads:[]};(f.client as any).clients.set(normalizedHome(f.domain.configHome),connection);
  const cached=f.client.scan(f.domain.configHome),fresh=f.client.scan(f.domain.configHome,f.domain,true);await cached;
  assert.ok((await fresh)!.threads.some(thread=>thread.id===loaded.id));assert.deepEqual(calls,['thread/loaded/list','thread/read']);
});

test('旧连接快照不能借用新连接相同的修订号，过时代次不连累并列有效调用',async t=>{
  const f=await setup(t),root=thread('generation-target'),rpc={closed:false,close(){this.closed=true;},request:async()=>({thread:root})};
  const old={...f.domain,rpc,at:Date.now(),revision:0,threads:[]},current={...old};(f.client as any).clients.set(normalizedHome(f.domain.configHome),current);
  await f.client.applySnapshot(old,[thread('stale-snapshot')],0);assert.equal(f.store.find('codex','stale-snapshot'),undefined);
  await assert.rejects(f.client.registration(f.domain.configHome,{...f.domain,procStart:f.domain.procStart+'-stale'},root.id),{code:'daemon_identity_changed'});
  assert.equal(rpc.closed,false,'过时调用者不能替换或关闭已核验的共享连接');assert.equal((f.client as any).clients.get(normalizedHome(f.domain.configHome)),current);
  const [stale,valid]=await Promise.allSettled([f.client.registration(f.domain.configHome,{...f.domain,pid:f.domain.pid+1},root.id),f.client.registration(f.domain.configHome,f.domain,root.id)]);
  assert.equal(stale.status,'rejected');assert.equal((stale as PromiseRejectedResult).reason.code,'daemon_identity_changed');assert.equal(valid.status,'fulfilled');
});

test('持续连接扫描复用已核验原生代次，断线或调用代次变化仍重新核验',async t=>{
  const f=await setup(t),root=thread('connected'),calls:string[]=[];
  mkdirSync(path.join(f.domain.configHome,'app-server-daemon'),{recursive:true});
  writeFileSync(path.join(f.domain.configHome,'app-server-daemon','daemon.pid'),JSON.stringify({pid:f.domain.pid}),'utf8');
  const rpc={closed:false,close(){this.closed=true;},request:async(method:string)=>{calls.push(method);return method==='thread/loaded/list'?{data:[root.id]}:{thread:root};}};
  const connection={...f.domain,rpc,at:0,revision:0,threads:[]};
  (f.client as any).clients.set(normalizedHome(f.domain.configHome),connection);
  for(let index=0;index<2;index++)assert.equal(await f.client.scan(f.domain.configHome,f.domain,true),connection);
  assert.deepEqual(calls,['thread/loaded/list','thread/read','thread/loaded/list','thread/read']);
                                                    
  await assert.rejects(f.client.scan(f.domain.configHome,{...f.domain,procStart:f.domain.procStart+'0'},true),{code:'daemon_identity_changed'});
  rpc.closed=true;
                                                   
  await assert.rejects(f.client.scan(f.domain.configHome,f.domain,true),error=>['daemon_identity_changed',...(process.platform==='win32'?['process_identity_unknown']:[])].includes((error as {code:string}).code));
});

test('原生子线程保留父链与根租约，不成为独立候选',async t=>{
  const f=await setup(t),root=thread('root');await f.client.applySnapshot(f.domain,[root]);
  const child=f.store.register(daemonRegistration(thread('child',{source:{subAgent:{spawn:{parentThreadId:'root'}}},parentThreadId:'root'}),f.domain,'root')),parent=f.store.find('codex','root')!;
  assert.equal(child.kind,'subagent');assert.equal(child.rootPeerId,parent.id);assert.equal(child.rootBinding?.epoch,f.store.bindings.current(parent.id)!.epoch);
  assert.ok(!f.store.candidates('codex',root.cwd).some(peer=>peer.id===child.id));
  assert.equal((f.broker as any).actor({...actor(child.id,'child',child.rootBinding!),via:'child'}).id,parent.id);
  await f.client.applySnapshot(f.domain,[]);assert.throws(()=>(f.broker as any).actor({...actor(child.id,'child',child.rootBinding!),via:'child'}),{code:'stale_context'});
});

test('正式结束的同一线程跨 daemon 代次恢复原成员历史，旧租约和权限不复用',async t=>{
  const f=await setup(t),root=thread('resume');await f.client.applySnapshot({...f.domain,procStart:f.domain.procStart+'-old'},[root]);
  const peer=f.store.find('codex',root.id)!,binding=f.store.bindings.current(peer.id)!;f.store.pair(f.c.id,peer.id);
  await f.client.applySnapshot(f.domain,[]);
  await f.client.applySnapshot(f.domain,[root]);
  const restored=f.store.find('codex',root.id)!;assert.equal(restored.id,peer.id);assert.equal(restored.permission,'unknown');
  assert.notEqual(f.store.bindings.current(peer.id)!.epoch,binding.epoch);assert.ok(!f.store.setting('pairLoss:'+peer.id));
  assert.ok(f.store.pairFor(peer.id));assert.throws(()=>f.store.resolve(actor(peer.id,root.id,binding)),{code:'stale_context'});
});

test('daemon 已死且端点先被停用仍结束持久租约；同一线程新代次保留配对与未提交任务',async t=>{
  const f=await setup(t),root=thread('continuity'),old={...f.domain,procStart:'0'};
  await f.client.applySnapshot(old,[root]);const peer=f.store.find('codex',root.id)!,pair=f.store.pair(f.c.id,peer.id),message=f.store.accept(pair,f.c,'原线程未提交的任务','keep');
  f.store.deactivate(peer.id);await (f.client as any).endDead(f.domain.configHome,f.domain);
  assert.equal(f.store.bindings.current(peer.id),undefined);assert.equal(f.store.pairFor(peer.id)?.id,pair.id);assert.equal(f.store.message(message.id).state,'accepted');
  await f.client.applySnapshot(f.domain,[root]);assert.equal(f.store.find('codex',root.id)!.id,peer.id);assert.equal(f.store.pairFor(peer.id)?.id,pair.id);assert.equal(f.store.message(message.id).state,'accepted');
});

test('未变化 daemon 快照不写数据库；其他线程结束不误拒当前入站，结束墓碑阻止旧列表复活',async t=>{
  const f=await setup(t),a=thread('stable'),b=thread('ended');await f.client.applySnapshot(f.domain,[a,b]);
  let endOther=false;const rpc={closed:false,close(){this.closed=true;},request:async(_method:string,params:{threadId:string})=>{if(endOther&&params.threadId===a.id){endOther=false;await f.client.ended(f.store.find('codex',b.id)!);}return{thread:params.threadId===a.id?a:b};}};
  const connection={...f.domain,rpc,at:Date.now(),revision:0,threads:[a,b]};(f.client as any).clients.set(normalizedHome(f.domain.configHome),connection);
  const changes=()=>Number((f.store as any).db.prepare('SELECT total_changes() AS n').get().n),before=changes();
  for(let i=0;i<3;i++)await f.client.applySnapshot(connection,[a,b],connection.revision);
  assert.equal(changes(),before);
  endOther=true;assert.equal((await f.client.registration(f.domain.configHome,f.domain,a.id)).sessionId,a.id);
  await f.client.applySnapshot(connection,[a,b],connection.revision);assert.equal(f.store.find('codex',b.id)?.state,'offline');assert.equal(f.store.bindings.current(f.store.find('codex',b.id)!.id),undefined);
});

test('同一线程 ID 在独立 daemon home 中不能合并；历史和临时子线程不进入候选',async t=>{
  const f=await setup(t),root=thread('same');await f.client.applySnapshot(f.domain,[root,thread('ephemeral',{ephemeral:true}),thread('child',{parentThreadId:root.id}),thread('history',{source:'exec'})]);
  const first=f.store.find('codex',root.id)!,other={...f.domain,configHome:temporary(t)};
  await f.client.applySnapshot(other,[root]);const peers=f.store.peers().filter(peer=>peer.sessionId===root.id);
  assert.equal(peers.length,2);assert.notEqual(f.store.bindings.current(first.id)!.key,f.store.bindings.current(peers.find(peer=>peer.id!==first.id)!.id)!.key);
  assert.deepEqual(f.store.candidates('codex',root.cwd).filter(peer=>peer.sessionId!=='x').map(peer=>peer.sessionId),['same','same']);
});
