import { copyNodeBinary } from './support/node-binary.js';
import test, {type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import net from 'node:net';
import { randomUUID } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { WebSocketServer } from 'ws';
import { Store } from '../storage/store.js';
import { Broker } from '../broker/coordinator.js';
import {BridgeError} from '../shared/errors.js';
import {DEFAULT_CONFIG} from '../config/defaults.js';
import {type Peer} from '../types.js';
import {PACKAGE_ROOT} from '../shared/package-location.js';
import {ensureHome} from '../ipc/home.js';
import {ipcAddress} from '../shared/local-paths.js';
import { processIdentity, probeProcesses } from '../process/process.js';
import {DeliveryHealth} from '../broker/health/delivery.js';
import {emptyDeliveryCounts,type RuntimeAvailability} from '../broker/health/contracts.js';
import {probePeerRuntime,probeAppServer} from '../broker/health/probe.js';
import {readHealthSnapshot,updateHealthSnapshot} from '../broker/health/snapshot.js';
import { collectRuntimeNotices } from '../broker/health/runtime-monitor.js';
import { fixture } from './support/broker-fixture.js';
import { registration } from './support/registration.js';
import { temporary, temporaryDirectory } from './support/temporary.js';
import { FakeAdapter } from './support/fake-adapter.js';
import { listenBroker } from '../ipc/ipc.js';
import { brokerOutageState } from '../broker/broker-outage.js';

async function sleeper(t:TestContext):Promise<ChildProcess>{
  const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{windowsHide:true,stdio:'ignore'});await once(child,'spawn');
  t.after(async()=>{if(child.exitCode===null&&child.signalCode===null){const exit=once(child,'exit');child.kill();await exit;}});return child;
}
const availability=(state:RuntimeAvailability['state']):RuntimeAvailability=>({state,reasons:state==='blocked'?['native host exited']:[],checked_at:Date.now()});

test('真实进程与端点探测分别核验代次、死亡和套接字，不把查询失败叫作死亡',async t=>{
  const child=await sleeper(t),native=await processIdentity(child.pid!),directory=temporary(t),address=process.platform==='win32'?'\\\\.\\pipe\\nxbridge-health-'+randomUUID():path.join(directory,'inbox.sock');
  const server=net.createServer(socket=>{socket.on('error',()=>{});socket.end();});await new Promise<void>(resolve=>server.listen(address,resolve));
  let listening=true;t.after(async()=>{if(listening)await new Promise<void>(resolve=>server.close(()=>resolve()));});
  const peer:Peer={id:'target',host:'claude',sessionId:'target',cwd:directory,name:'target',owner:'user',state:'ready',parentId:null,updatedAt:Date.now(),permission:'prompting',kind:'root'};
  const endpoint={...registration('claude','target').endpoint,address,pid:child.pid!,procStart:native.startedAt,active:true,seenAt:Date.now(),peerId:peer.id};
  assert.deepEqual(await probeProcesses([{pid:child.pid!,procStart:native.startedAt},{pid:child.pid!,procStart:'wrong-generation'},{pid:child.pid!,procStart:''}]),['alive','dead','unknown']);
  assert.equal((await probePeerRuntime(peer,endpoint)).state,'reachable');
  await new Promise<void>(resolve=>server.close(()=>resolve()));listening=false;
  const transport=await probePeerRuntime(peer,endpoint);assert.equal(transport.state,'blocked');assert.match(transport.reasons.join(),/inbox endpoint unreachable/);
  const exit=once(child,'exit');child.kill();await exit;
  const dead=await probePeerRuntime(peer,endpoint);assert.match(dead.reasons.join(),/native host exited or PID generation changed/);
  const ws=new WebSocketServer({host:'127.0.0.1',port:0});await once(ws,'listening');
  const wsAddress=`ws://127.0.0.1:${(ws.address() as net.AddressInfo).port}`;assert.equal(await probeAppServer(wsAddress),true);
  for(const socket of ws.clients)socket.terminate();await new Promise<void>(resolve=>ws.close(()=>resolve()));assert.equal(await probeAppServer(wsAddress),false);
});

test('正常双向发信回执由 nxbridge 承接投递，结构字段仍保留未读事实',async t=>{
  const {store,broker,c,x}=fixture(t);store.pair(c.id,x.id);
  store.saveEndpoint({...store.endpoint(c.id)!,nativeInbound:{policy:'accept',observedAt:Date.now()}});
  for(const actor of [{host:'claude',sessionId:'c',callId:'normal-c'},{host:'codex',sessionId:'x',callId:'normal-x'}]){
    const sent:any=await broker.dispatch('send',{actor,message:'正常任务'});
    assert.deepEqual({persisted:sent.persisted,status:sent.status,delivery_state:sent.delivery_state,read_confirmed:sent.read_confirmed,message:sent.message},
      {persisted:true,status:'queued',delivery_state:'accepted',read_confirmed:false,message:'handed to nxbridge; it delivers + reports problems itself (routine, not user news)'});
  }
});

test('发送结果区分保存、受阻、unknown 和上下文证据；同调用不产生第二条任务',async t=>{
  const f=fixture(t),pair=f.store.pair(f.c.id,f.x.id);f.store.updatePeer(f.x.id,{state:'offline'});
  f.codex.probe=async()=>availability('blocked');
  const input={actor:{host:'claude',sessionId:'c',callId:'send'},message:'原任务'};
  const sent:any=await f.broker.dispatch('send',input);assert.equal(sent.persisted,true);assert.equal(sent.status,'selection_required');assert.equal(sent.reason,'hosting');assert.equal(sent.delivery_state,'accepted');assert.equal(sent.read_confirmed,false);
  assert.equal(f.store.message(sent.message_id).attempts,0);
  f.store.claim(sent.message_id);f.store.transition(sent.message_id,'unknown');
  const unknown:any=await f.broker.dispatch('send',input);assert.equal(unknown.status,'unknown');assert.match(unknown.message,/NEVER automatically replayed/);
  await f.broker.pump();assert.equal(f.store.message(sent.message_id).attempts,1);assert.equal(f.store.messages().length,1);
  f.store.transition(sent.message_id,'contextObserved','原生证据');assert.equal((await f.broker.dispatch('send',input) as any).status,'observed');
  assert.equal(f.store.deliveryCounts(pair.id,f.c.id).unknown,0);
});

test('故障观察五分钟后随正常取件提供，投递稳定恢复不额外通知',async t=>{
  t.mock.timers.enable({apis:['Date'],now:100000});
  const f=fixture(t),pair=f.store.pair(f.c.id,f.x.id);f.store.updatePeer(f.x.id,{state:'offline'});
  f.codex.probe=async()=>availability('blocked');
  for(let i=0;i<4;i++)f.broker.send({actor:{host:'claude',sessionId:'c',callId:String(i)},message:'消息'+i});
  await f.broker.pump();assert.equal(f.claude.delivered.length,0);t.mock.timers.tick(300000);
  const first=await f.broker.dispatch('health.monitor',{actor:{host:'claude',sessionId:'c',callId:'fault'}}) as any;assert.equal(first.notices.length,1);assert.match(first.notices[0].message,/pending: unsent=4/);assert.doesNotMatch(first.notices[0].message,/(?:sending|queued-unread|held|unknown)=0/);
  t.mock.timers.tick(5000);await f.broker.pump();assert.equal(f.claude.delivered.length,0);
  f.codex.probe=async()=>availability('reachable');f.store.updatePeer(f.x.id,{state:'ready'});
  t.mock.timers.tick(55000);await f.broker.pump();assert.equal(f.claude.delivered.length,0);
  const recovered=await f.broker.dispatch('health.monitor',{actor:{host:'claude',sessionId:'c',callId:'recovered'}}) as any;assert.equal(recovered.notices.length,0);
  t.mock.timers.tick(5000);await f.broker.pump();assert.equal(f.claude.delivered.length,0);assert.equal(f.store.messages().length,4);
  assert.equal(f.store.events(0,1000).filter(e=>e.type==='health.delivery.alert').length,1);
  assert.equal(f.store.deliveryCounts(pair.id,f.c.id).runtimeQueued,0);assert.ok(f.store.messages().every(message=>message.state==='contextObserved'));
});

test('重启清点安全重试 accepted，sending 变 unknown；通知失败不重放任务',async t=>{
  const f=fixture(t),pair=f.store.pair(f.c.id,f.x.id),a=f.store.accept(pair,f.c,'安全队列','safe'),b=f.store.accept(pair,f.c,'在途','inflight');f.store.claim(b.id);
  await f.broker.start();await f.broker.pump();
  assert.equal(f.store.message(a.id).state,'contextObserved');assert.equal(f.store.message(a.id).attempts,1);assert.equal(f.store.message(b.id).state,'unknown');assert.equal(f.store.message(b.id).attempts,1);
  assert.equal(f.claude.delivered.length,0);const pickup=await f.broker.dispatch('health.monitor',{actor:{host:'claude',sessionId:'c',callId:'restart-fact'}}) as any;
  assert.equal(pickup.notices.length,0);const status=f.broker.status({host:'claude',sessionId:'c',callId:'requested-status'}) as any;
  const notice=status.notes.find((n:any)=>n.text.includes('bridge restarted'));assert.ok(notice);assert.match(notice.text,/1 interrupted sends now unknown/);
  assert.equal(f.store.messages().length,2);await f.broker.pump();assert.equal(f.store.message(b.id).attempts,1);
});

test('通知发送租约到期复用原 ID，成功或拒绝回执后不再领取，也不重放任务',t=>{
  t.mock.timers.enable({apis:['Date'],now:100000});
  const f=fixture(t),pair=f.store.pair(f.c.id,f.x.id),task=f.store.accept(pair,f.c,'原任务','lease');
  const health=new DeliveryHealth(f.store);health.observe(pair,f.c,f.x,f.store.deliveryCounts(pair.id,f.c.id),availability('blocked'));
  t.mock.timers.tick(300000);health.observe(pair,f.c,f.x,f.store.deliveryCounts(pair.id,f.c.id),availability('blocked'));
  const first=health.take(pair.id,f.c.id);assert.equal(first.length,1);assert.equal(health.take(pair.id,f.c.id).length,0);
  t.mock.timers.tick(59999);assert.equal(health.take(pair.id,f.c.id).length,0);
  t.mock.timers.tick(1);assert.equal(health.take(pair.id,f.c.id)[0]!.id,first[0]!.id);
  health.outcome(pair.id,f.c.id,first[0]!.id,'submitted');t.mock.timers.tick(60000);assert.equal(health.take(pair.id,f.c.id).length,0);
  health.enqueue(pair.id,f.c.id,{id:'denied',message:'另一通知',kind:'another',state:'pending'});const denied=health.take(pair.id,f.c.id)[0]!;health.outcome(pair.id,f.c.id,denied.id,'denied','宿主拒绝');
  t.mock.timers.tick(60000);assert.equal(health.take(pair.id,f.c.id).length,0);
  assert.equal(f.store.messages().length,1);assert.equal(f.store.message(task.id).attempts,0);
});

test('健康事件与通知共用账本外元数据，暂停、换配对和身份不符均不消费通知',async t=>{
  const temp=temporaryDirectory(),home=temp.directory,store=new Store(path.join(home,'nxbridge.db'));t.after(async()=>{store.close();await temp.cleanup();});
  const native=await processIdentity(process.pid),r=registration('codex','root');r.endpoint={mode:'embedded',address:'',epoch:'root',pid:process.pid,procStart:native.startedAt};
  const x=store.register(r),c=store.register(registration('claude','partner')),pair=store.pair(c.id,x.id),context=`${process.pid}:${native.startedAt}:transcript`;
  store.setSetting('hookContext:'+context,'root');store.accept(pair,x,'任务','out');
  const health=new DeliveryHealth(store);health.observe(pair,x,c,store.deliveryCounts(pair.id,x.id),availability('blocked'));
  t.mock.timers.enable({apis:['Date'],now:Date.now()+300000});health.observe(pair,x,c,store.deliveryCounts(pair.id,x.id),availability('blocked'));
  assert.equal(readHealthSnapshot(home,'codex','root','foreign'),undefined);
  assert.deepEqual(await collectRuntimeNotices(home,'codex','root',{pid:process.pid,procStart:'foreign'},context),[]);
  store.setPaused(true);assert.equal(readHealthSnapshot(home,'codex','root',context),undefined);store.setPaused(false);
  const notices=updateHealthSnapshot(home,'codex','root',context,(monitor,value)=>monitor.take(value.pair.id,value.sender.id));assert.equal(notices?.length,1);
  assert.equal(updateHealthSnapshot(home,'codex','root',context,(monitor,value)=>monitor.take(value.pair.id,value.sender.id))?.length,0);
  const other=store.register(registration('claude','other'));store.pair(other.id,x.id,true);assert.equal(new DeliveryHealth(store).hasPending(store.currentPair()!.id,x.id),false);
  assert.equal(store.messages().length,1);
});

test('协调器离线时已读但明确待回复的依赖仍保留原时钟，回复后撤回未提交通知',async t=>{
  t.mock.timers.enable({apis:['Date'],now:1000000});
  const temp=temporaryDirectory(),home=temp.directory,store=new Store(path.join(home,'nxbridge.db'));t.after(async()=>{store.close();await temp.cleanup();});
  const native=await processIdentity(process.pid),identity={pid:process.pid,procStart:native.startedAt};
  const x=store.register(registration('codex','offline-reply',{endpoint:{mode:'embedded',address:'',epoch:'offline-reply',...identity}})),c=store.register(registration('claude','partner')),pair=store.pair(c.id,x.id);
  const task=store.accept(pair,x,'明确要求答复的任务','reply-needed',undefined,undefined,'explicit',true);store.transition(task.id,'contextObserved');
  assert.deepEqual(store.deliveryCounts(pair.id,x.id),emptyDeliveryCounts());
  const observedAt=Date.now(),health=new DeliveryHealth(store);health.observe(pair,x,c,emptyDeliveryCounts(),availability('blocked'),true);
  t.mock.timers.tick(300001);
  assert.equal(readHealthSnapshot(home,'codex',x.sessionId!,undefined,identity)?.sender.id,x.id);
  assert.equal(updateHealthSnapshot(home,'codex',x.sessionId!,undefined,(_health,value)=>value.dependencySince,identity),observedAt);
  const signal=await collectRuntimeNotices(home,'codex',x.sessionId!,identity,undefined,undefined,undefined,{admit:false});
  assert.equal(signal.length,1);assert.equal(signal[0]!.tier,3);assert.equal(signal[0]!.wake,false);
  const pending=health.peek(pair.id,x.id)[0]!;assert.match(pending.message,/awaiting partner reply/);assert.doesNotMatch(pending.message,/pending: none/);
  store.accept(pair,c,'已完成，请查收','reply-finished',task.id);
  assert.equal(updateHealthSnapshot(home,'codex',x.sessionId!,undefined,(_health,value)=>value.dependencySince,identity),undefined);
  assert.deepEqual(await collectRuntimeNotices(home,'codex',x.sessionId!,identity,undefined,undefined,undefined,{admit:false}),[]);
  assert.equal(health.get(pair.id,x.id,pending.id),undefined);assert.equal(store.messages().length,2);
});

test('协调器协议或内部错误保留真实原因，不伪造离线投递事件',async t=>{
  const temp=temporaryDirectory(),home=temp.directory;await ensureHome(home);const store=new Store(path.join(home,'nxbridge.db'));
  const native=await processIdentity(process.pid),x=store.register(registration('codex','monitor-root',{endpoint:{mode:'embedded',address:'',epoch:'monitor',pid:process.pid,procStart:native.startedAt}}));
  const c=store.register(registration('claude','monitor-partner',{endpoint:{mode:'claude-inbox',address:ipcAddress(home),epoch:'partner',pid:process.pid,procStart:native.startedAt}})),pair=store.pair(c.id,x.id),context='monitor-context';store.setSetting('hookContext:'+context,x.sessionId);
  let code='unknown_method';const server=await listenBroker(home,async()=>{if(code==='timeout')return new Promise(()=>{});throw new BridgeError(code,'真实监控错误');});
  t.after(async()=>{await server.close();store.close();await temp.cleanup();});
  for(const value of ['unknown_method','internal_error']){code=value;await assert.rejects(collectRuntimeNotices(home,'codex',x.sessionId!,{pid:process.pid,procStart:native.startedAt},context),{code:value});}
  code='timeout';await assert.rejects(collectRuntimeNotices(home,'codex',x.sessionId!,{pid:process.pid,procStart:native.startedAt},context),{code:'timeout',uncertain:true});
  assert.deepEqual(await collectRuntimeNotices(home,'codex',x.sessionId!,{pid:process.pid,procStart:native.startedAt},context,undefined,undefined,{admit:false}),[]);
  assert.deepEqual(new DeliveryHealth(store).peek(pair.id,x.id),[],'未知探测只进入状态，不能伪造离线模型告警');
});

test('原生 hook 在 MCP 与 broker 均死亡时注入可读通知，不启动 broker、不重发或污染子线程',async t=>{
  const temp=temporaryDirectory(),home=temp.directory;await ensureHome(home);
  let store:Store|undefined,broker:Broker|undefined,server:Awaited<ReturnType<typeof listenBroker>>|undefined;
  const executable=path.join(home,process.platform==='win32'?'codex.exe':'codex');if(process.platform==='win32')copyNodeBinary(executable);else symlinkSync(process.execPath,executable);
  const driver=spawn(executable,['-e',`process.title='codex';const {spawn}=require('node:child_process');process.on('message',p=>{const c=spawn(${JSON.stringify(process.execPath)},['--no-warnings',${JSON.stringify(path.join(PACKAGE_ROOT,'publish','nxbridge.mjs'))},'hook','--host','codex'],{env:process.env,windowsHide:true,stdio:['pipe','pipe','pipe']});let stdout='',stderr='';c.stdout.on('data',d=>stdout+=d);c.stderr.on('data',d=>stderr+=d);c.on('exit',code=>process.send({code,stdout,stderr}));c.stdin.end(JSON.stringify(p));});process.send('ready');`],{env:{...process.env,NXBRIDGE_HOME:home},windowsHide:true,stdio:['ignore','ignore','pipe','ipc']});
  let driverError='';driver.stderr!.on('data',piece=>driverError+=piece);
  const exit=once(driver,'exit');t.after(async()=>{if(driver.exitCode===null&&driver.signalCode===null)driver.kill();await exit;await server?.close();await broker?.stop();store?.close();await temp.cleanup();});
  await Promise.race([once(driver,'message'),exit.then(()=>{throw Error('隔离原生驱动提前退出：'+driverError);})]);
  const native=await processIdentity(driver.pid!);assert.match(native.name,/^codex(?:\.exe)?$/i);
  const dead=await sleeper(t),deadIdentity=await processIdentity(dead.pid!);const deadExit=once(dead,'exit');dead.kill();await deadExit;
  store=new Store(path.join(home,'nxbridge.db'));
  const x=store.register(registration('codex','root',{endpoint:{mode:'embedded',address:'',epoch:'native',pid:driver.pid!,procStart:native.startedAt,bridge:{pid:dead.pid!,procStart:deadIdentity.startedAt}}}));
  const c=store.register(registration('claude','partner',{endpoint:{mode:'claude-inbox',address:'absent',epoch:'dead',pid:dead.pid!,procStart:deadIdentity.startedAt}})),pair=store.pair(c.id,x.id);
  const queued=store.accept(pair,x,'不得重发的任务','out'),unknown=store.accept(pair,x,'在途任务','unknown');store.claim(unknown.id);store.transition(unknown.id,'unknown');
  const transcript=path.join(home,'root.jsonl'),context=`${driver.pid}:${native.startedAt}:${transcript}`;store.setSetting('hookContext:'+context,'root');
  const invoke=async(extra:Record<string,unknown>={})=>{const response=once(driver,'message');driver.send({session_id:'root',hook_event_name:'PostToolUse',transcript_path:transcript,tool_name:'exec_command',...extra});return(await response)[0];};
  assert.deepEqual(JSON.parse((await invoke({agent_id:'child'})).stdout),{});
  assert.deepEqual(JSON.parse((await invoke({transcript_path:'foreign'})).stdout),{});
  assert.deepEqual(JSON.parse((await invoke()).stdout),{});const observed=store.setting<any>('turnHealthDelivery:'+pair.id+':'+x.id);store.setSetting('turnHealthDelivery:'+pair.id+':'+x.id,{...observed,since:Date.now()-300001,dependencySince:Date.now()-300001});
                                             
  const clockDb=new DatabaseSync(path.join(home,'nxbridge.db'));try{clockDb.prepare('UPDATE messages SET created_at=? WHERE pair_id=?').run(Date.now()-300001,pair.id);}finally{clockDb.close();}
  const result=await invoke(),parsed=JSON.parse(result.stdout);assert.ok(parsed.hookSpecificOutput,'原生 hook 没有上下文：'+result.stderr);const contextText=parsed.hookSpecificOutput.additionalContext;
  assert.equal(result.code,0);assert.match(contextText,/system_notice source=runtime_monitor/);assert.match(contextText,/delivery remains unconfirmed/);assert.match(contextText,/unknown=1/);
  const reasons=store.setting<any>('turnHealthDelivery:'+pair.id+':'+x.id).reasons.join();assert.match(reasons,/broker endpoint unavailable/);assert.match(reasons,/sender MCP bridge exited/);
  assert.deepEqual(JSON.parse((await invoke()).stdout),{});assert.equal(store.message(queued.id).attempts,0);assert.equal(store.message(unknown.id).attempts,1);assert.equal(store.message(unknown.id).state,'unknown');assert.equal(existsSync(path.join(home,'run','launch-broker.json')),false);
                                                 
  const outage=new DatabaseSync(path.join(home,'run','broker-outage.db'));
  try{outage.prepare("UPDATE outage SET data=json_set(data,'$.since',?) WHERE slot=1").run(Date.now()-120001);}finally{outage.close();}
  const task=JSON.parse((await invoke()).stdout).hookSpecificOutput.additionalContext;
  assert.match(task,/source=broker_outage/);assert.match(task,/doctor once.*bootstrap once/);
  assert.deepEqual(JSON.parse((await invoke()).stdout),{});
  assert.deepEqual(JSON.parse((await invoke({agent_id:'child'})).stdout),{});
  assert.equal(store.message(unknown.id).state,'unknown');assert.equal(store.message(unknown.id).attempts,1);
  assert.equal(existsSync(path.join(home,'run','launch-broker.json')),false);
  const codex=new FakeAdapter(),claude=new FakeAdapter();broker=new Broker(store,{...DEFAULT_CONFIG,implicit:'never'},{codex,claude} as any,home);server=await listenBroker(home,(method,params)=>broker!.dispatch(method,params));
  const endpoint=store.endpoint(x.id)!;store.saveEndpoint({...endpoint,bridge:{pid:driver.pid!,procStart:native.startedAt}});
                                                     
  const admission=store.setting<any>('healthNoticeAdmission:'+x.id);store.setSetting('healthNoticeAdmission:'+x.id,{...admission,lastAt:Date.now()-60000});
  assert.deepEqual(JSON.parse((await invoke()).stdout),{},'自动巡检不追加恢复上下文');assert.deepEqual(JSON.parse((await invoke()).stdout),{});
});

test('后台 Claude 不能领取面向用户的恢复任务，启动预约损坏也不静默压住用户窗口',async t=>{
  const temp=temporaryDirectory(),home=temp.directory;await ensureHome(home);const store=new Store(path.join(home,'nxbridge.db'));
  t.after(async()=>{store.close();await temp.cleanup();});
  const identity=await processIdentity(process.pid),native={pid:process.pid,procStart:identity.startedAt};
  const configHome=path.join(home,'claude');mkdirSync(path.join(configHome,'sessions'),{recursive:true});writeFileSync(path.join(configHome,'sessions',native.pid+'.json'),JSON.stringify({sessionId:'monitor-user',procStart:native.procStart}),'utf8');
  const c=store.register(registration('claude','monitor-user',{endpoint:{mode:'claude-inbox',address:'absent',epoch:'native',configHome,...native}})),x=store.register(registration('codex','partner'));store.pair(c.id,x.id);store.updatePeer(c.id,{owner:'nxbridge'});
  writeFileSync(path.join(home,'run','broker-startup.db'),'invalid sqlite','utf8');t.mock.timers.enable({apis:['Date'],now:1000});
  await collectRuntimeNotices(home,'claude',c.sessionId!,native);t.mock.timers.tick(40000);await collectRuntimeNotices(home,'claude',c.sessionId!,native);t.mock.timers.tick(40000);await collectRuntimeNotices(home,'claude',c.sessionId!,native);t.mock.timers.tick(40001);
  const passive=await collectRuntimeNotices(home,'claude',c.sessionId!,native);assert.equal(passive.find(value=>value.source==='broker_outage')?.wake,false);assert.equal(brokerOutageState(home)?.claim,undefined);
  store.updatePeer(c.id,{owner:'user'});const task=await collectRuntimeNotices(home,'claude',c.sessionId!,native);
  assert.equal(task.find(value=>value.source==='broker_outage')?.wake,true);assert.equal(brokerOutageState(home)?.claim?.state,'admitted');assert.equal(existsSync(path.join(home,'run','launch-broker.json')),false);
});
