import {lifecycle} from './support/broker-fixture.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {writeFileSync} from 'node:fs';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {WebSocketServer} from 'ws';
import {Store} from '../storage/store.js';
import {Broker,type Adapters} from '../broker/coordinator.js';
import {SessionTransfers,hostingGate,hostingRecord,hostingStatus,writeHosting} from '../broker/recovery/session-hosting.js';
import {managedCodexRegistration,reconcileManagedCodexConflict} from '../hosts/managed-registration.js';
import {addManagedConflict,clearManagedConflict} from '../broker/recovery/managed-conflicts.js';
import {saveManagedRuntime,runtimeFor,removeManagedRuntime,createRuntimeToken,type ManagedRuntime} from '../hosts/managed-runtimes.js';
import {managedMarker} from '../install/installation.js';
import {processIdentity} from '../process/process.js';
import {CodexAdapter,threadRegistration} from '../hosts/codex/adapter.js';
import {daemonRegistration} from '../hosts/codex/codex-daemon.js';
import {DEFAULT_CONFIG} from '../config/defaults.js';
import {type RegisterInput} from '../types.js';
import { FakeAdapter } from './support/fake-adapter.js';
import { registration, codexInitializeResult } from './support/registration.js';
import { temporary } from './support/temporary.js';

async function setup(t:Parameters<typeof temporary>[0],persist=false){
  const home=temporary(t),filename=persist?path.join(home,'nxbridge.db'):':memory:',store=new Store(filename),identity=await processIdentity(process.pid);
  const c=store.register(registration('claude','c',{cwd:home})),x=store.register(registration('codex','root',{cwd:home,endpoint:{mode:'app-server',address:'ws://127.0.0.1:1234',epoch:'runtime',pid:identity.pid,procStart:identity.startedAt,configHome:home}})),pair=store.pair(c.id,x.id);
  store.updatePeer(x.id,{owner:'nxbridge',state:'busy'});
  const runtime:ManagedRuntime={id:randomUUID(),peerId:x.id,owner:managedMarker(home),kind:'owned',state:'ready',dedicated:true,endpoint:store.endpoint(x.id)!.address,configHome:home,pid:identity.pid,procStart:identity.startedAt,createdAt:Date.now()};saveManagedRuntime(home,runtime);
  const input=(id:string,kind:RegisterInput['kind']='root',parentId?:string)=>registration('codex',id,{cwd:home,kind,parentId,endpoint:{mode:'embedded',address:'',epoch:'hook-'+id,pid:identity.pid,procStart:identity.startedAt,configHome:home}});
  return{home,filename,store,c,x:store.peer(x.id),pair,runtime,input};
}

for(const source of [{subAgent:{thread_spawn:{parent_thread_id:'root'}}},{subAgent:{spawn:{parentThreadId:'root'}}}])test('原生子代理字段同时用于专用运行时和共享 daemon',()=>{
  const thread={id:'child',cwd:'/project',source,status:{type:'active'}};
  for(const result of [threadRegistration(thread,'unix://owned'),daemonRegistration(thread,{configHome:'/config',address:'unix://daemon',pid:1,procStart:'one'})]){assert.equal(result?.kind,'subagent');assert.equal(result?.parentId,'root');}
});

test('自有后台收到 kind=root 的 hook 登记，以原生父链登记子代理并保留根会话',async t=>{
  let broker:Broker|undefined;t.after(async()=>{if(broker)await broker.stop();});const f=await setup(t);t.after(()=>f.store.close());const reads:string[]=[],codex=new FakeAdapter();
  Object.assign(codex,{inspectThread:async(runtime:ManagedRuntime,id:string)=>{assert.equal(runtime.id,f.runtime.id);reads.push(id);return{id,source:{subAgent:{thread_spawn:{parent_thread_id:'root'}}}};}});
  broker=new Broker(f.store,DEFAULT_CONFIG,{codex,claude:new FakeAdapter()} as unknown as Adapters,f.home);
  const child=await broker.dispatch('mcp.register',f.input('child')) as any;
  assert.equal(child?.kind,'subagent');assert.equal(child?.parentId,'root');assert.equal(child?.rootPeerId,f.x.id);assert.deepEqual(reads,['child']);
  const again=await broker.dispatch('mcp.register',f.input('child','subagent','root')) as any;
  assert.equal(again.id,child.id);assert.equal(again.rootPeerId,f.x.id);assert.equal(f.store.peers().filter(row=>row.sessionId==='child').length,1);
  assert.equal(f.store.peer(f.x.id).sessionId,'root');assert.equal(f.store.peer(f.x.id).state,'busy');assert.equal(hostingGate(f.store,f.x),false);assert.equal(f.store.bindings.current(child!.id),undefined);
});

test('遗留外来根线程的元数据已不可读时，仍按原生卸载证据解除冲突',async t=>{
  let broker:Broker|undefined;t.after(async()=>{if(broker)await broker.stop();});const f=await setup(t);t.after(()=>f.store.close());
  const key='managedRuntimeConflict:'+f.x.id;f.store.setSetting(key,{runtimeId:f.runtime.id,sessionId:'foreign',at:1});const codex=new FakeAdapter();
  Object.assign(codex,{inspectThread:async()=>{throw Error('原线程已卸载');},sessionState:async()=> 'dead'});
  broker=new Broker(f.store,DEFAULT_CONFIG,{codex,claude:new FakeAdapter()} as unknown as Adapters,f.home);
  await lifecycle(broker).observeManagedExits();assert.equal(f.store.setting(key),null);assert.equal(hostingGate(f.store,f.x),false);assert.equal(codex.ensured,0);
});

test('深层子代理沿原生父链核验，登记声明不能伪装另一根线程',async t=>{
  const f=await setup(t);t.after(()=>f.store.close());
  const read=async(_runtime:ManagedRuntime,id:string)=>({id,source:id==='foreign'?'cli':{subAgent:{thread_spawn:{parent_thread_id:id==='child'?'parent':'root'}}}});
  const child=await managedCodexRegistration(f.store,f.home,f.input('child','unknown'),read);assert.equal(child?.rootPeerId,f.x.id);
  await assert.rejects(managedCodexRegistration(f.store,f.home,f.input('foreign','subagent','root'),read),{code:'session_conflict'});
  assert.equal(hostingGate(f.store,f.x),true);assert.equal(f.store.find('codex','foreign'),undefined);
  const conflict=f.store.setting('managedRuntimeConflict:'+f.x.id);
  await reconcileManagedCodexConflict(f.store,f.home,f.x,read);assert.deepEqual(f.store.setting('managedRuntimeConflict:'+f.x.id),conflict);
});

test('核验期间运行时代次变化，不能清除冲突或登记线程',async t=>{
  const f=await setup(t);t.after(()=>f.store.close());
  const key='managedRuntimeConflict:'+f.x.id,conflict={runtimeId:f.runtime.id,sessionId:'child',at:1};f.store.setSetting(key,conflict);
  const read=async()=>{saveManagedRuntime(f.home,{...f.runtime,procStart:'changed'});return{id:'child',parentThreadId:'root'};};
  await assert.rejects(managedCodexRegistration(f.store,f.home,f.input('child'),read),{code:'managed_proof_unverified'});assert.deepEqual(f.store.setting(key),conflict);assert.equal(f.store.find('codex','child'),undefined);
  saveManagedRuntime(f.home,f.runtime);await reconcileManagedCodexConflict(f.store,f.home,f.x,read);assert.deepEqual(f.store.setting(key),conflict);
});

test('启动巡检解除持久假冲突与 adopting，原消息仅领取一次且不恢复或重启会话',async t=>{
  let broker:Broker|undefined,store:Store|undefined;t.after(async()=>{if(broker)await broker.stop();store?.close();});
  const f=await setup(t,true),key='managedRuntimeConflict:'+f.x.id;
  f.store.setSetting(key,{runtimeId:f.runtime.id,sessionId:'child',at:1});writeHosting(f.store,f.x,{background:true,phase:'adopting',reason:'session_changed',attempts:1,nextAt:Date.now()+300000},f.home);
  const pending=f.store.accept(f.pair,f.c,'原消息','once');f.store.close();store=new Store(f.filename);const codex=new FakeAdapter(),claude=new FakeAdapter();
  Object.assign(codex,{inspectThread:async(_runtime:ManagedRuntime,id:string)=>({id,...(id==='child'?{source:{subAgent:{thread_spawn:{parent_thread_id:'root'}}}}:{source:'cli'}),status:{type:'active'}}),sessionState:async()=> 'alive'});
  broker=new Broker(store,{...DEFAULT_CONFIG,implicit:'never'},{codex,claude} as unknown as Adapters,f.home);
  await broker.start();await lifecycle(broker).observeManagedExits();assert.equal(store.setting(key),null);assert.equal(hostingRecord(store,store.peer(f.x.id))?.phase,undefined);assert.equal(hostingGate(store,store.peer(f.x.id)),false);
  assert.equal(store.peer(f.x.id).state,'busy');assert.equal(store.endpoint(f.x.id)?.pid,f.runtime.pid);assert.equal(runtimeFor(f.home,{peerId:f.x.id})?.value.procStart,f.runtime.procStart);
  const actor={host:'codex' as const,memberId:f.x.id,sessionId:'root',callId:'first'};
  const first=broker.receive(actor) as any;assert.deepEqual(first.messages.map((row:any)=>row.message_id),[pending.id]);
  assert.deepEqual((broker.receive({...actor,callId:'second'}) as any).messages,[]);await lifecycle(broker).observeManagedExits();assert.equal(store.message(pending.id).attempts,1);
  assert.equal(codex.ensured,0);assert.equal(codex.created.length,0);assert.equal(codex.released.length,0);assert.equal(codex.runtimeReleased,false);assert.equal(codex.attached.length,0);assert.equal(codex.woken.length,0);
});

for(const gate of ['verifying','policy','release','takeover','foreign'] as const)test('已加载后台的 adopting 不绕过 '+gate+' 门禁',async t=>{
  const f=await setup(t);t.after(()=>f.store.close());writeHosting(f.store,f.x,{background:true,phase:'adopting'},f.home);
  if(gate==='verifying')writeHosting(f.store,f.x,{verifying:true});
  if(gate==='policy')saveManagedRuntime(f.home,{...f.runtime,sessionVerification:{sessionId:'root',profile:{} as any}});
  if(gate==='release')writeHosting(f.store,f.x,{released:true});
  if(gate==='takeover')f.store.setSetting('takeover:'+f.x.id,{id:'lease'});
  if(gate==='foreign')f.store.setSetting('managedRuntimeConflict:'+f.x.id,{runtimeId:f.runtime.id,sessionId:'foreign'});
  const transfers=new SessionTransfers(f.store,DEFAULT_CONFIG,f.home,{holder:async()=>assert.fail('不能探测用户窗口'),prepare:async()=>assert.fail('不能恢复或重启'),stop:async()=>assert.fail('不能停止'),enabled:()=>{},inspect:async()=>({id:'root',status:{type:'active'}})});
  assert.equal(await transfers.reconcileOwned(f.x),false);await transfers.adopt(f.x);assert.equal(hostingRecord(f.store,f.x)?.phase,'adopting');assert.equal(hostingGate(f.store,f.x),true);
});

test('托管选择不把已托管成员重新标记为 adopting',async t=>{
  const f=await setup(t);t.after(()=>f.store.close());writeHosting(f.store,f.x,{background:true},f.home);
  const actor={host:'claude' as const,memberId:f.c.id,sessionId:f.c.sessionId!,callId:'choose'};
  const view=f.store.selections.hosting(f.c,actor,DEFAULT_CONFIG) as any;
  f.store.selections.commit(actor,{selection_id:view.selection_id,action:'adopt'},DEFAULT_CONFIG,()=>assert.fail('无需发送新消息'));
  assert.equal(hostingRecord(f.store,f.x)?.phase,undefined);assert.equal(hostingGate(f.store,f.x),false);
});

test('托管暂存计数来自目标成员收到的消息，不把其发出的不确定消息算进入站',async t=>{
  const f=await setup(t);t.after(()=>f.store.close());writeHosting(f.store,f.x,{background:true,phase:'adopting'},f.home);
  f.store.accept(f.pair,f.c,'入站待发一','incoming-one');f.store.accept(f.pair,f.c,'入站待发二','incoming-two');
  const outgoing=f.store.accept(f.pair,f.x,'出站状态未知','outgoing');f.store.claim(outgoing.id);f.store.transition(outgoing.id,'unknown');
  const status=hostingStatus(f.store,f.x);assert.equal(status?.held_unsent,2);assert.equal(status?.uncertain,0);
});

test('切换检查忽略心跳与权限观察更新，仍识别实际持有者变化',async t=>{
  const f=await setup(t);t.after(()=>f.store.close());f.store.updatePeer(f.x.id,{owner:'user'});
  let finish!:(state:'alive')=>void;const held=new Promise<'alive'>(resolve=>finish=resolve);
  const transfers=new SessionTransfers(f.store,DEFAULT_CONFIG,f.home,{holder:()=>held,prepare:async()=>assert.fail('窗口还在运行'),stop:async()=>{},enabled:()=>{}});
  const work=transfers.adopt(f.store.peer(f.x.id)),endpoint=f.store.endpoint(f.x.id)!;
  f.store.saveEndpoint({...endpoint,seenAt:endpoint.seenAt+1,codexPermissionObservation:{value:{approval:'prompting'},source:'native-hook',context:'updated',observedAt:Date.now()}});finish('alive');await work;
  assert.equal(hostingRecord(f.store,f.x)?.reason,'holder_active');assert.equal(hostingRecord(f.store,f.x)?.phase,undefined);
});

test('已加载后台核验抛错时，巡检和显式接手均保留暂存并可重试',async t=>{
  const f=await setup(t);t.after(()=>f.store.close());writeHosting(f.store,f.x,{background:true,phase:'adopting',reason:'session_changed',attempts:1},f.home);
  const transfers=new SessionTransfers(f.store,DEFAULT_CONFIG,f.home,{holder:async()=>assert.fail('不能探测用户窗口'),prepare:async()=>assert.fail('不能恢复或重启'),stop:async()=>assert.fail('不能停止'),enabled:()=>{},inspect:async()=>{throw Error('原生读取超时');}});
  assert.equal(await transfers.reconcileOwned(f.x),false);assert.equal((await transfers.adopt(f.x) as any).status,'held');assert.equal(hostingGate(f.store,f.x),true);assert.equal(hostingRecord(f.store,f.x)?.attempts,1);
});

for(const unavailable of ['抛错','缺失','身份不符'] as const)test('外来线程核验'+unavailable+'时先保存冲突，未登记成主窗口',async t=>{
  const f=await setup(t);t.after(()=>f.store.close());
  const read=async()=>{if(unavailable==='抛错')throw Error('读取超时');return unavailable==='身份不符'?{id:'other'}:undefined;};
  await assert.rejects(managedCodexRegistration(f.store,f.home,f.input('foreign','subagent','root'),read),{code:'managed_proof_unverified'});
  assert.equal(hostingGate(f.store,f.x),true);assert.equal(f.store.setting<any>('managedRuntimeConflict:'+f.x.id).sessionId,'foreign');assert.equal(f.store.find('codex','foreign'),undefined);
});

for(const mode of ['starting','legacy'] as const)test(mode+' 后台无法原生核验时不信任 MCP 子代理声明，保留冲突',async t=>{
  const f=await setup(t);t.after(()=>f.store.close());
  if(mode==='starting')saveManagedRuntime(f.home,{...f.runtime,state:'starting'});
  else{removeManagedRuntime(runtimeFor(f.home,{id:f.runtime.id})!);writeFileSync(path.join(f.home,'run','codex-runtime.json'),JSON.stringify(f.runtime),'utf8');}
  const adapter=new CodexAdapter(DEFAULT_CONFIG,f.home);t.after(()=>adapter.close());
  await assert.rejects(managedCodexRegistration(f.store,f.home,f.input('child','subagent','root'),(runtime,id)=>adapter.inspectThread(runtime,id)),{code:'managed_proof_unverified'});
  assert.equal(hostingGate(f.store,f.x),true);assert.equal(f.store.find('codex','child'),undefined);assert.equal(f.store.peer(f.x.id).sessionId,'root');
});

test('核验期间新代次取代旧代次，失败的旧登记不会污染新运行时',async t=>{
  const f=await setup(t);t.after(()=>f.store.close());
  await assert.rejects(managedCodexRegistration(f.store,f.home,f.input('foreign'),async()=>{saveManagedRuntime(f.home,{...f.runtime,procStart:'new'});throw Error('旧代次断开');}),{code:'managed_proof_unverified'});
  assert.equal(f.store.setting('managedRuntimeConflict:'+f.x.id),undefined);assert.equal(f.store.find('codex','foreign'),undefined);
});

for(const source of ['review','compact'])test('无父字段的原生 '+source+' 子代理不会冒充主会话或阻塞根投递',async t=>{
  const f=await setup(t);t.after(()=>f.store.close());const key='managedRuntimeConflict:'+f.x.id;
  f.store.setSetting(key,{runtimeId:f.runtime.id,sessionId:'child',at:1});
  const child=await managedCodexRegistration(f.store,f.home,f.input('child'),async()=>({id:'child',source:{subAgent:source}}));
  assert.equal(child?.kind,'subagent');assert.equal(child?.parentId,null);assert.equal(child?.rootPeerId,undefined);assert.equal(f.store.bindings.current(child!.id),undefined);assert.equal(hostingGate(f.store,f.x),false);
});

test('包装器登记统一使用已证明的原生 PID，不在 hook 与适配器之间反复切换',async t=>{
  const f=await setup(t);t.after(()=>f.store.close());saveManagedRuntime(f.home,{...f.runtime,wrapperPid:2147483647,wrapperProcStart:'wrapper'});
  const input=f.input('root');input.endpoint.pid=2147483647;input.endpoint.procStart='wrapper';
  const root=await managedCodexRegistration(f.store,f.home,input);assert.equal(root?.id,f.x.id);assert.equal(f.store.endpoint(f.x.id)?.pid,f.runtime.pid);assert.equal(f.store.endpoint(f.x.id)?.procStart,f.runtime.procStart);
});

test('托管选择提交后接手已加载的 adopting 成员，只读复核即可恢复原配对',async t=>{
  const f=await setup(t);t.after(()=>f.store.close());writeHosting(f.store,f.x,{background:true,phase:'adopting',reason:'session_changed'},f.home);
  const actor={host:'claude' as const,memberId:f.c.id,sessionId:f.c.sessionId!,callId:'commit-adopt'},view=f.store.selections.hosting(f.c,actor,DEFAULT_CONFIG) as any;
  f.store.selections.commit(actor,{selection_id:view.selection_id,action:'adopt'},DEFAULT_CONFIG,()=>assert.fail('无需新消息'));assert.equal(hostingRecord(f.store,f.x)?.phase,'adopting');
  const transfers=new SessionTransfers(f.store,DEFAULT_CONFIG,f.home,{holder:async()=>assert.fail('不能探测用户窗口'),prepare:async()=>assert.fail('不能恢复或重启'),stop:async()=>assert.fail('不能停止'),enabled:()=>{},inspect:async()=>({id:'root',status:{type:'active'}})});
  assert.equal((await transfers.adopt(f.store.peer(f.x.id)) as any).status,'paired');assert.equal(hostingRecord(f.store,f.x)?.phase,undefined);assert.equal(f.store.pairFor(f.x.id)?.id,f.pair.id);assert.equal(f.store.peer(f.x.id).state,'busy');
});

test('原生子代理父链按运行时代次缓存，根线程状态每次只读获取',async t=>{
  const f=await setup(t);t.after(()=>f.store.close());const server=new WebSocketServer({host:'127.0.0.1',port:0}),adapter=new CodexAdapter(DEFAULT_CONFIG,f.home),calls:string[]=[];
  t.after(async()=>{adapter.close();for(const socket of server.clients)socket.terminate();await new Promise<void>(resolve=>server.close(()=>resolve()));});await once(server,'listening');
  const runtime={...f.runtime,endpoint:`ws://127.0.0.1:${(server.address() as {port:number}).port}`,authenticatedLoopback:true};saveManagedRuntime(f.home,runtime);createRuntimeToken(f.home,runtime);
  let rootState='active';server.on('connection',socket=>socket.on('message',raw=>{const request=JSON.parse(raw.toString());if(request.id===undefined)return;
    assert.ok(['initialize','thread/read'].includes(request.method),'只能发起只读请求');calls.push(request.method+':'+(request.params?.threadId??''));const id=request.params?.threadId;
    socket.send(JSON.stringify({id:request.id,result:request.method==='initialize'?codexInitializeResult:{thread:{id,cwd:f.home,status:{type:rootState},...(id==='child'?{source:{subAgent:{spawn:{parentThreadId:'root'}}}}:{source:'cli'})}}}));
  }));
  await adapter.inspectThread(runtime,'child');await adapter.inspectThread(runtime,'child');assert.equal(calls.filter(call=>call==='thread/read:child').length,1);
  assert.equal((await adapter.inspectThread(runtime,'root'))?.status?.type,'active');rootState='idle';assert.equal((await adapter.inspectThread(runtime,'root'))?.status?.type,'idle');assert.equal(calls.filter(call=>call==='thread/read:root').length,2);
  const changed={...runtime,configHome:path.join(f.home,'other')};saveManagedRuntime(f.home,changed);await adapter.inspectThread(changed,'child');assert.equal(calls.filter(call=>call==='thread/read:child').length,2);
  const restarted={...changed,procStart:'new-generation'};saveManagedRuntime(f.home,restarted);await assert.rejects(adapter.inspectThread(restarted,'child'),{code:'runtime_endpoint_unverified'});assert.equal(calls.filter(call=>call==='thread/read:child').length,2);
});

test('旧冲突卸载核验等待期间新增外来根线程，不会清除新冲突',async t=>{
  let broker:Broker|undefined;t.after(async()=>{if(broker)await broker.stop();});const f=await setup(t);t.after(()=>f.store.close());
  const key='managedRuntimeConflict:'+f.x.id;addManagedConflict(f.store,f.x.id,f.runtime.id,'old');const codex=new FakeAdapter();let entered!:()=>void,finish!:()=>void;
  const waiting=new Promise<void>(resolve=>entered=resolve),held=new Promise<'dead'>(resolve=>finish=()=>resolve('dead'));
  Object.assign(codex,{inspectThread:async()=>{throw Error('旧元数据不可读');},sessionState:async()=>{entered();return held;}});
  broker=new Broker(f.store,DEFAULT_CONFIG,{codex,claude:new FakeAdapter()} as unknown as Adapters,f.home);
  const sweep=lifecycle(broker).observeManagedExits();await waiting;codex.emit('register',{...f.input('foreign'),endpoint:{...f.store.endpoint(f.x.id)!}});finish();await sweep;
  assert.equal(hostingGate(f.store,f.x),true);assert.equal(f.store.setting<any>(key).sessionId,'old');assert.equal(f.store.setting<any>(key).pending[0].sessionId,'foreign');
  Object.assign(codex,{sessionState:async(peer:any)=>peer.sessionId==='old'?'dead':'alive'});await lifecycle(broker).observeManagedExits();assert.equal(f.store.setting<any>(key).sessionId,'foreign');assert.equal(hostingGate(f.store,f.x),true);
});

test('子代理瞬时核验失败不覆盖外来根冲突，已核验子代理只解除自身记录',async t=>{
  const f=await setup(t);t.after(()=>f.store.close());const key='managedRuntimeConflict:'+f.x.id;addManagedConflict(f.store,f.x.id,f.runtime.id,'foreign');
  await assert.rejects(managedCodexRegistration(f.store,f.home,f.input('child'),async()=>{throw Error('读取超时');}),{code:'managed_proof_unverified'});
  assert.equal(f.store.setting<any>(key).sessionId,'foreign');assert.equal(f.store.setting<any>(key).pending[0].sessionId,'child');
  await managedCodexRegistration(f.store,f.home,f.input('child'),async()=>({id:'child',parentThreadId:'root'}));assert.equal(f.store.setting<any>(key).sessionId,'foreign');assert.equal(f.store.setting<any>(key).pending,undefined);assert.equal(hostingGate(f.store,f.x),true);
});

test('旧运行时保留 peerId 的原生子代理沿同代次 Unix 端点只读核验',async t=>{
  const f=await setup(t);t.after(()=>f.store.close());const http=createServer(),server=new WebSocketServer({server:http}),socket=path.join(f.home,'legacy.sock');
  const adapter=new CodexAdapter({...DEFAULT_CONFIG,...(process.platform==='win32'?{codexBinary:path.join(f.home,'proxy.mjs')}:{})},f.home);
  t.after(async()=>{adapter.close();for(const client of server.clients)client.terminate();await new Promise<void>(resolve=>server.close(()=>http.close(()=>resolve())));});
  http.listen(process.platform==='win32'?{host:'127.0.0.1',port:0}:socket);await once(http,'listening');
  if(process.platform==='win32')writeFileSync(path.join(f.home,'proxy.mjs'),`import net from 'node:net';const socket=net.createConnection(${(http.address() as {port:number}).port},'127.0.0.1');process.stdin.pipe(socket);socket.pipe(process.stdout);socket.on('close',()=>process.exit());socket.on('error',()=>process.exit(1));`,'utf8');
  server.on('connection',client=>client.on('message',raw=>{const request=JSON.parse(raw.toString());if(request.id===undefined)return;assert.ok(['initialize','thread/read'].includes(request.method));client.send(JSON.stringify({id:request.id,result:request.method==='initialize'?codexInitializeResult:{thread:{id:'child',cwd:f.home,source:{subAgent:{thread_spawn:{parent_thread_id:'root'}}}}}}));}));
  removeManagedRuntime(runtimeFor(f.home,{id:f.runtime.id})!);writeFileSync(path.join(f.home,'run','codex-runtime.json'),JSON.stringify({...f.runtime,endpoint:'unix://'+socket}),'utf8');
  const child=await managedCodexRegistration(f.store,f.home,f.input('child'),(runtime,id)=>adapter.inspectThread(runtime,id));assert.equal(child?.kind,'subagent');assert.equal(child?.rootPeerId,f.x.id);assert.equal(hostingGate(f.store,f.x),false);
});

test('托管选择返回 held 后读取已存回执仍为 held',async t=>{
  let broker:Broker|undefined;t.after(async()=>{if(broker)await broker.stop();});const f=await setup(t);t.after(()=>f.store.close());writeHosting(f.store,f.x,{background:true,phase:'adopting'},f.home);
  const codex=new FakeAdapter();Object.assign(codex,{inspectThread:async()=>{throw Error('暂不可读');}});broker=new Broker(f.store,DEFAULT_CONFIG,{codex,claude:new FakeAdapter()} as unknown as Adapters,f.home);
  const actor={host:'claude' as const,memberId:f.c.id,sessionId:f.c.sessionId!,callId:'held-receipt'},view=f.store.selections.hosting(f.c,actor,DEFAULT_CONFIG) as any;
  const receipt=await broker.dispatch('pair.selection.commit',{actor,selection_id:view.selection_id,action:'adopt'}) as any;assert.equal(receipt.status,'held');assert.deepEqual(f.store.selections.view(actor,view.selection_id,DEFAULT_CONFIG),JSON.parse(JSON.stringify(receipt)));
});

test('超过 64 个托管线程冲突仍逐条保存，全部核验后即可继续，无需退出运行时',async t=>{
  const f=await setup(t);t.after(()=>f.store.close());const key='managedRuntimeConflict:'+f.x.id;
  for(let index=0;index<100;index++)addManagedConflict(f.store,f.x.id,f.runtime.id,'foreign-'+index);
  addManagedConflict(f.store,f.x.id,f.runtime.id,'foreign-99');
  assert.equal(f.store.setting<any>(key).pending.length,99);assert.equal(f.store.setting<any>(key).overflowRuntimeIds,undefined);
  for(let index=0;index<99;index++)assert.equal(clearManagedConflict(f.store,f.x.id,f.runtime.id,'foreign-'+index),true);
  assert.equal(hostingGate(f.store,f.x),true);assert.equal(f.store.setting<any>(key).sessionId,'foreign-99');
  assert.equal(clearManagedConflict(f.store,f.x.id,f.runtime.id,'foreign-99'),true);assert.equal(hostingGate(f.store,f.x),false);
});

for(const proof of ['账本','重启后端点'] as const)test('升级前已丢失线程明细的饱和标记仍凭'+proof+'整代退出解除',async t=>{
  const f=await setup(t);t.after(()=>f.store.close());const key='managedRuntimeConflict:'+f.x.id;
  f.store.setSetting(key,{runtimeId:f.runtime.id,sessionId:'legacy-foreign',at:1,overflowRuntimeIds:[f.runtime.id]});
  assert.equal(clearManagedConflict(f.store,f.x.id,f.runtime.id,'legacy-foreign'),false);assert.equal(hostingGate(f.store,f.x),true);
  if(proof==='账本')saveManagedRuntime(f.home,{...f.runtime,procStart:'exited-generation'});
  else{const endpoint=f.store.endpoint(f.x.id)!;f.store.saveEndpoint({...endpoint,runtimeId:f.runtime.id,procStart:'exited-generation',native:{pid:f.runtime.pid!,procStart:'exited-generation'}});removeManagedRuntime(runtimeFor(f.home,{id:f.runtime.id})!);}
  await reconcileManagedCodexConflict(f.store,f.home,f.x,async()=>assert.fail('整代退出不必查询线程'));assert.equal(hostingGate(f.store,f.x),false);
});
