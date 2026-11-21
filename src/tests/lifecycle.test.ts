import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { Store } from '../storage/store.js';
import {fixture, lifecycle} from './support/broker-fixture.js';
import { recordFixtureLaunch } from './support/native-launch.js';
import { registration } from './support/registration.js';
import { temporaryDirectory } from './support/temporary.js';
import { formatMessage } from '../integration/mcp/presentation.js';
import {canonicalPipe,encodePeerMessage} from '../hosts/claude/claude-inbox.js';
import { matchesProcess, processIdentity } from '../process/process.js';
import { codexPermission, threadRegistration } from '../hosts/codex/adapter.js';
import { launchMode } from '../hosts/launch.js';

test('同进程无配置登记保留原生权限，审批变化作废旧沙箱，完整新快照恢复核验',async t=>{
  const {store,broker,x}=fixture(t),endpoint=store.endpoint(x.id)!,thread={id:'x',cwd:x.cwd,status:{type:'idle'}};
  const snapshot=threadRegistration(thread,endpoint.address,{approvalPolicy:'never',sandbox:{type:'dangerFullAccess'}})!;
  assert.deepEqual(snapshot.endpoint.codexPermission,{sandbox:'danger-full-access',approval:'bypass'});
  const identify=(input:typeof snapshot)=>({...input,endpoint:{...input.endpoint,pid:endpoint.pid,procStart:endpoint.procStart}});
  store.adopt(x.id,identify(snapshot));store.updatePeer(x.id,{permission:'bypass'});
  store.adopt(x.id,identify(threadRegistration(thread,endpoint.address)!));
  assert.deepEqual(store.endpoint(x.id)!.codexPermission,snapshot.endpoint.codexPermission);
  for(const [mode,expected] of [['bypassPermissions','bypass'],['default','prompting'],['bypassPermissions','unknown']] as const){
    await broker.dispatch('hook',{session_id:'x',hook_event_name:'PreToolUse',permission_mode:mode});assert.equal(store.peer(x.id).permission,expected);
  }
  assert.equal(store.endpoint(x.id)!.codexPermission!.sandbox,undefined);
  await broker.dispatch('register',identify(threadRegistration(thread,endpoint.address,{approvalPolicy:'never',sandbox:{type:'dangerFullAccess'}})!));assert.equal(store.peer(x.id).permission,'bypass');assert.equal(store.endpoint(x.id)!.codexPermission!.sandbox,'danger-full-access');
  const restricted=threadRegistration(thread,endpoint.address,{approvalPolicy:'never',sandbox:{type:'readOnly'}})!;
  store.adopt(x.id,identify(restricted));await broker.dispatch('hook',{session_id:'x',hook_event_name:'PreToolUse',permission_mode:'bypassPermissions'});
  assert.equal(store.peer(x.id).permission,'prompting');assert.equal(store.endpoint(x.id)!.codexPermission!.sandbox,'read-only');
});

for(const change of ['generation','context'] as const)test('原生权限证据不能跨进程代次或线程继承：'+change,t=>{
  const {store,x}=fixture(t),endpoint=store.endpoint(x.id)!;
  store.saveEndpoint({...endpoint,codexPermission:{sandbox:'danger-full-access',approval:'bypass'}});
  store.adopt(x.id,registration('codex',change==='context'?'next-context':'x',{endpoint:{...endpoint,...(change==='generation'?{procStart:'next-generation'}:{})}}));
  assert.equal(store.endpoint(x.id)!.codexPermission,undefined);
});

test('首次实际发信才创建隐式根线程，并收养到持久配对',async t=>{
  const {store,broker,c,x,codex}=fixture(t,{implicit:'on-demand'});store.updatePeer(x.id,{state:'offline'});
  broker.status({host:'claude',sessionId:'c',callId:'status'});assert.equal(codex.created.length,0);
  const response=await broker.dispatch('send',{actor:{host:'claude',sessionId:'c',callId:'send'},message:'隐式搭档任务'}) as any;
  assert.equal(response.notice,'no partner for this window -> started NEW codex partner (no prior context; brief fully). expected an existing partner? tell user: nxbridge pair');
  assert.equal(store.message(response.message_id).state,'accepted');
  await broker.pump();
  const pair=store.currentPair()!,partner=store.peer(pair.codex);
  assert.equal(pair.claude,c.id);assert.equal(partner.owner,'nxbridge');assert.equal(partner.kind,'root');assert.equal(partner.parentId,null);
  assert.equal(codex.created.length,1);assert.equal(codex.woken.length,1);assert.equal(codex.delivered[0]?.id,response.message_id);assert.equal(store.message(response.message_id).state,'contextObserved');
});

test('卸载停止只回收自有后台会话，保留用户会话及消息历史',async t=>{
  const {store,broker,c,x,codex,claude}=fixture(t);store.updatePeer(c.id,{owner:'nxbridge'});
  const pair=store.pair(c.id,x.id),message=store.accept(pair,x,'卸载前的消息','before-uninstall');
  assert.deepEqual(await broker.stop(true),[]);
  assert.equal(claude.released.length,1);assert.equal(codex.released.length,0);assert.equal(codex.runtimeReleased,true);
  assert.equal(store.currentPair(),undefined);assert.equal(store.message(message.id).body,'卸载前的消息');assert.equal(store.peer(x.id).owner,'user');
  await broker.pump();assert.equal(claude.delivered.length,0);
});

for(const mode of ['create','wake'] as const)test('后台 Claude '+mode+' 与原生登记竞态按已核验端点接续原成员',async t=>{
  const {store,broker,x,claude}=fixture(t),owned=store.placeholder('claude',x.cwd),input=registration('claude','managed-native',{endpoint:{mode:'claude-inbox',address:'native-managed',epoch:'native-managed',pid:process.pid,procStart:'fixture-generation',configHome:path.resolve('/claude-test'),nativePermission:{mode:'bypassPermissions',permission:'bypass',observedAt:Date.now()},nativeInbound:{policy:'accept',observedAt:Date.now()}}});
  if(mode==='wake')store.updatePeer(owned.id,{sessionId:input.sessionId,state:'offline'});
  const pair=store.pair(owned.id,x.id);
  claude.create=(async (peer:typeof owned)=>{store.updatePeer(peer.id,{sessionId:input.sessionId});store.register(input);return input.sessionId;}) as any;
  claude.wake=async()=>{store.register(input);};claude.discover=async()=>input;
  const message=store.accept(pair,x,'原生登记与后台接续并发',mode);await broker.pump();
  assert.equal(store.find('claude',input.sessionId)?.id,owned.id);assert.equal(store.bindings.current(owned.id)?.peerId,owned.id);
  assert.equal(store.pairFor(owned.id)?.id,pair.id);assert.equal(claude.delivered[0]?.id,message.id);
});

test('解除配对立即提交；旧创建结束前新配对可用，旧成员不会在回收期间再次认领',async t=>{
  const {store,broker,c,x,codex}=fixture(t,{implicit:'on-demand'});store.updatePeer(x.id,{state:'offline'});
  let complete!:(value:ReturnType<typeof registration>)=>void,start!:()=>void;
  const started=new Promise<void>(resolve=>start=resolve);
  codex.create=async peer=>{codex.created.push(peer);start();return new Promise(resolve=>complete=resolve);};
  broker.send({actor:{host:'claude',sessionId:'c',callId:'deferred'},message:'等待启动'});
  const pump=broker.pump();await started;
  const retiring=store.currentPair()!.codex,unpair=broker.dispatch('unpair',{});
  assert.throws(()=>broker.send({actor:{host:'claude',sessionId:'c',callId:'racing'},message:'竞态'}),{code:'pair_changing'});
  const pair=broker.dispatch('pair',{claude:c.id,codex:x.id});
  await unpair;await pair;assert.equal(store.currentPair()?.codex,x.id);
  const next=broker.send({actor:{host:'claude',sessionId:'c',callId:'new-pair'},message:'新配对不等旧创建'});assert.equal(store.message(next.message_id).to,x.id);
  await assert.rejects(broker.dispatch('pair',{claude:c.id,codex:retiring,replace:true}),{code:'peer_releasing'});
  complete(registration('codex','deferred-session'));
  await pump;await lifecycle(broker).waitForReleases();
  assert.deepEqual(codex.released.map(peer=>peer.id),[retiring]);assert.equal(codex.created.length,1);assert.ok(codex.delivered.every(message=>message.id===next.message_id));
  assert.equal(store.currentPair()?.codex,x.id);assert.equal(store.peer(retiring).state,'offline');
});

test('归档会话的释放失败持久退避，重试只回收而不恢复会话',async t=>{
  const {store,broker,c,x,claude}=fixture(t);store.updatePeer(c.id,{owner:'nxbridge'});store.pair(c.id,x.id);
  let attempts=0;claude.release=async peer=>{attempts++;if(attempts===1)throw Error('暂时不可访问');claude.released.push(peer);};
  const result=await broker.dispatch('unpair',{}) as any;assert.deepEqual(result.releasePending,[c.id]);await lifecycle(broker).waitForReleases();
  const pending=store.setting<Record<string,{attempts:number;nextAt:number}>>('processRetirements')!;
  assert.equal(pending[c.id]!.attempts,1);await broker.pump();assert.equal(attempts,1);
  pending[c.id]!.nextAt=0;store.setSetting('processRetirements',pending);await broker.pump();await lifecycle(broker).waitForReleases();
  assert.equal(attempts,2);assert.deepEqual(store.setting('processRetirements'),{});assert.equal(store.currentPair(),undefined);
  assert.equal(claude.created.length,0);assert.equal(claude.woken.length,0);
});

test('慢回收和失败不锁住已提交的新配对，并行结果不覆盖其他持久回收任务',async t=>{
  const {store,broker,c,x,claude,codex}=fixture(t);store.updatePeer(c.id,{owner:'nxbridge'});store.updatePeer(x.id,{owner:'nxbridge'});store.pair(c.id,x.id);
  const nextC=store.register(registration('claude','next-c')),nextX=store.register(registration('codex','next-x'));
  let entered!:()=>void,finish!:()=>void;const started=new Promise<void>(resolve=>entered=resolve),gate=new Promise<void>(resolve=>finish=resolve);
  claude.release=async()=>{entered();await gate;throw Error('隔离回收失败');};
  try{
    const changed=await broker.dispatch('pair',{claude:nextC.id,codex:x.id,replace:true}) as any;await started;
    assert.equal(store.pairFor(x.id)?.id,changed.id);assert.equal((broker as any).changingMembers.size,0);
    const sent=broker.send({actor:{host:'claude',sessionId:'next-c',callId:'usable'},message:'新配对可继续工作'});assert.equal(store.message(sent.message_id).to,x.id);
    await broker.dispatch('pair',{claude:nextC.id,codex:nextX.id,replace:true});await lifecycle(broker).waitForRelease(x.id);
    assert.equal(codex.released.length,1);assert.ok(store.setting<Record<string,unknown>>('processRetirements')?.[c.id]);
  }finally{finish();await lifecycle(broker).waitForReleases();}
  const pending=store.setting<Record<string,{attempts:number;error:string}>>('processRetirements')!;assert.equal(pending[c.id]?.attempts,1);assert.match(pending[c.id]!.error,/隔离回收失败/);assert.equal(pending[x.id],undefined);
});

test('用户接管与解除配对顺序一致，接管后的原生窗口不回收',async t=>{
  const {store,broker,c,x,claude}=fixture(t);store.updatePeer(c.id,{owner:'nxbridge'});store.pair(c.id,x.id);
  const identity=await processIdentity(process.pid),lease=(broker as any).takeovers.begin(store.peer(c.id),store.endpoint(c.id));
  await broker.dispatch('open.claim',{peer_id:c.id,session_id:'c',lease_id:lease.id,foreground:{pid:identity.pid,procStart:identity.startedAt}});await broker.dispatch('unpair',{});
  assert.equal(store.peer(c.id).owner,'nxbridge');assert.equal(claude.released.length,0);
  await assert.rejects(broker.dispatch('open.claim',{peer_id:c.id,session_id:'c',lease_id:lease.id,foreground:{pid:identity.pid,procStart:identity.startedAt}}),{code:'session_changed'});
});

test('中断后迟到的 turn、Stop 和状态上报均不能撤销暂停',async t=>{
  const {store,broker,x,codex}=fixture(t);await broker.dispatch('hook',{session_id:'x',hook_event_name:'Interrupt'});
  codex.emit('turnStarted','x');await broker.dispatch('hook',{session_id:'x',hook_event_name:'Stop'});
  await broker.dispatch('peer.state',{actor:{host:'codex',sessionId:'x',callId:'late-human'},state:'needsHuman'});
  await broker.dispatch('peer.state',{actor:{host:'codex',sessionId:'x',callId:'state'},state:'ready'});
  assert.equal(store.peer(x.id).state,'paused');
});

test('真实新用户提示解除本窗口暂停，但不解除配对暂停及子代理隔离',async t=>{
  const {store,broker,c,x}=fixture(t);store.pair(c.id,x.id);store.setPaused(true);
  const context_key=`${process.pid}:test:x`;
  await broker.dispatch('hook',{session_id:'x',hook_event_name:'SessionStart',context_key});
  await broker.dispatch('hook',{session_id:'x',hook_event_name:'Interrupt',context_key});
  for(const extra of [{context_key:'foreign'},{context_key,agent_id:'child'}]){
    await broker.dispatch('hook',{session_id:'x',hook_event_name:'UserPromptSubmit',...extra});assert.equal(store.peer(x.id).state,'paused');
  }
  await broker.dispatch('hook',{session_id:'x',hook_event_name:'UserPromptSubmit',context_key});
  assert.equal(store.peer(x.id).state,'busy');assert.equal(store.currentPair()?.paused,true);
  store.updatePeer(c.id,{state:'paused'});
  await broker.dispatch('peer.state',{actor:{host:'claude',sessionId:'c',callId:'late'},state:'busy'});assert.equal(store.peer(c.id).state,'paused');
  store.register(registration('claude','child',{kind:'subagent',parentId:'c'}));
  await assert.rejects(broker.dispatch('peer.prompt',{actor:{host:'claude',sessionId:'child',callId:'child'}}),/子代理/);
  await broker.dispatch('peer.prompt',{actor:{host:'claude',sessionId:'c',callId:'human'}});
  assert.equal(store.peer(c.id).state,'busy');assert.equal(store.currentPair()?.paused,true);
  const outside=store.register(registration('claude','outside',{state:'paused'}));await broker.dispatch('resume',{});assert.equal(store.peer(outside.id).state,'paused');
});

test('自有闲置线程无需来信即可恢复原 ID，失败退避，用户窗口不复活',async t=>{
  const {store,broker,c,x,codex,claude}=fixture(t);store.pair(c.id,x.id);
  recordFixtureLaunch(store,broker.home,x);
  store.updatePeer(x.id,{owner:'nxbridge',state:'offline'});codex.attachFailure=Error('暂时断线');
  await broker.pump();assert.equal(codex.attached.length,2);assert.equal(codex.ensured,1);assert.equal(codex.created.length,0);
  await broker.pump();assert.equal(codex.attached.length,2,'退避期间不能反复连接');
                         
  (lifecycle(broker) as any).recoveryAt.delete(x.id);const incident=broker.managedRecovery.get(x.id)!;incident.nextAt=0;store.setSetting('managedRecovery:'+x.id,incident);codex.attachFailure=undefined;
  await broker.pump();assert.equal(store.peer(x.id).sessionId,'x');assert.equal(store.peer(x.id).state,'ready');assert.equal(codex.created.length,0);
  store.updatePeer(x.id,{owner:'user',state:'offline'});store.updatePeer(c.id,{state:'offline'});const count=codex.attached.length;
  await broker.pump();assert.equal(codex.attached.length,count);assert.equal(claude.woken.length,0);
});

test('App Server 更换端点后只恢复保存的线程；Claude 自有会话同样按原 ID 唤醒',async t=>{
  const {store,broker,c,x,codex,claude}=fixture(t);store.pair(c.id,x.id);
  recordFixtureLaunch(store,broker.home,c);recordFixtureLaunch(store,broker.home,x);
  store.updatePeer(x.id,{owner:'nxbridge',state:'offline'});store.updatePeer(c.id,{owner:'nxbridge',state:'offline'});
  const attach=codex.attach.bind(codex);codex.attach=async(peer,endpoint)=>{if(endpoint.address!=='new-endpoint')throw Error('旧进程已退出');return attach(peer,endpoint);};
  await broker.pump();assert.equal(codex.created.length,0);assert.equal(codex.ensured,1);assert.equal(codex.attached[0]?.peer.sessionId,'x');
  assert.equal(store.endpoint(x.id)?.address,'new-endpoint');assert.equal(store.endpoints(x.id).filter(e=>e.active).length,1);
  assert.equal(claude.woken[0]?.sessionId,'c');assert.equal(store.peer(c.id).sessionId,'c');assert.equal(store.peer(c.id).state,'ready');
});

test('用户 App Server 断线只重连观察通道，不 resume、启动宿主或新建线程',async t=>{
  const {store,broker,c,x,codex,claude}=fixture(t);store.pair(c.id,x.id);
  codex.emit('disconnected','unix://test-server');assert.equal(store.peer(x.id).state,'offline');
                                               
  await broker.pump();assert.deepEqual([...new Set(codex.connected)],['unix://test-server']);assert.equal(store.peer(x.id).state,'offline');assert.equal(store.peer(x.id).owner,'user');assert.equal(store.peer(x.id).sessionId,'x');
  assert.equal(codex.attached.length,0);assert.equal(codex.ensured,0);assert.equal(codex.created.length,0);assert.equal(claude.woken.length,0);
  await broker.pump();assert.equal(codex.attached.length,0);assert.equal(codex.ensured,0);assert.equal(codex.created.length,0);assert.equal(claude.woken.length,0);
});

test('未配对窗口退出和 fork hooks 不影响当前搭档',async t=>{
  const {store,broker,c,x}=fixture(t);store.pair(c.id,x.id);store.register(registration('codex','other'));
  await broker.dispatch('hook',{session_id:'other',hook_event_name:'SessionEnd'});
  await broker.dispatch('hook',{session_id:'x',hook_event_name:'SessionStart',source:'fork',context_key:`${process.pid}:test:x`});
  await broker.dispatch('hook',{session_id:'x',hook_event_name:'SessionEnd',context_key:`${process.pid}:test:x`});
  assert.equal(store.currentPair()?.paused,false);assert.equal(store.peer(x.id).state,'ready');
  await broker.dispatch('hook',{session_id:'x',hook_event_name:'SessionEnd'});assert.equal(store.currentPair()?.paused,false);assert.equal(store.currentPair()?.codex,x.id);
});

test('Claude 子会话结束不伪装成主会话中断，隐式休眠不暂停全局',async t=>{
  const {store,broker,c,x}=fixture(t);store.pair(c.id,x.id);store.updatePeer(c.id,{owner:'nxbridge'});
  await broker.dispatch('peer.state',{actor:{host:'claude',sessionId:'c',callId:'end'},state:'offline'});
  assert.equal(store.currentPair()?.paused,false);assert.equal(store.peer(c.id).state,'offline');
});

test('Claude 未知父链不能发信；允许外联的不同子线程使用相同调用 ID 不互相吞消息',t=>{
  const {store,broker,c,x}=fixture(t);store.pair(c.id,x.id);
  store.register(registration('claude','unknown',{kind:'unknown'}));store.register(registration('claude','unverified-child',{kind:'subagent',parentId:'unknown'}));
  assert.throws(()=>broker.send({actor:{host:'claude',sessionId:'unverified-child',callId:'same'},message:'不能发送'}),/父链/);
  for(const id of ['child-a','child-b'])store.register(registration('claude',id,{kind:'subagent',parentId:'c'}));
  const a=broker.send({actor:{host:'claude',sessionId:'child-a',callId:'same'},message:'发现'}) as any;
  const b=broker.send({actor:{host:'claude',sessionId:'child-b',callId:'same'},message:'发现'}) as any;
  assert.notEqual(a.message_id,b.message_id);
});

test('迟到回执不降低证据；hold 和拒收不会自动重发',t=>{
  const {store,c,x}=fixture(t),pair=store.pair(c.id,x.id),m=store.accept(pair,x,'正文','call');
  store.transition(m.id,'held','目标挂起');store.transition(m.id,'unknown','迟到传输结果');assert.equal(store.message(m.id).state,'held');assert.equal(store.pending().length,0);
  store.transition(m.id,'runtimeQueued','目标放行');store.transition(m.id,'contextObserved','上下文');store.transition(m.id,'runtimeQueued','迟到 ACK');assert.equal(store.message(m.id).state,'contextObserved');
  store.transition(m.id,'responded','明确回复');store.transition(m.id,'held','迟到 hold');assert.equal(store.message(m.id).state,'responded');
  const refused=store.accept(pair,x,'另一封','call-2');store.transition(refused.id,'refused');store.transition(refused.id,'runtimeQueued');assert.equal(store.message(refused.id).state,'refused');
});

test('SQLite 重启恢复正文和配对，提交中的消息保持不确定',t=>{
  const temp=temporaryDirectory(),filename=path.join(temp.directory,'ledger.db');let store=new Store(filename);t.after(async()=>{store.close();await temp.cleanup();});
  const c=store.register(registration('claude','c')),x=store.register(registration('codex','x')),pair=store.pair(c.id,x.id),m=store.accept(pair,c,'重启后仍保留的正文','id');
  store.claim(m.id);store.close();store=new Store(filename);store.recover();
  assert.equal(store.currentPair()?.id,pair.id);assert.equal(store.message(m.id).body,'重启后仍保留的正文');assert.equal(store.message(m.id).state,'unknown');assert.equal(store.pending().length,0);
});

test('进程代次更新退出旧端点，同时保留暂停',t=>{
  const {store,c}=fixture(t);store.updatePeer(c.id,{state:'paused'});
  store.register(registration('claude','c',{endpoint:{mode:'claude-inbox',address:'renewed',pid:process.pid,procStart:'new-start',epoch:'new-generation'}}));
  assert.equal(store.endpoint(c.id)?.address,'renewed');assert.equal(store.peer(c.id).state,'paused');
  const processInfo={pid:42,parentPid:1,name:'claude',startedAt:'ft',procStart:'legacy',procStartFt:'ft'};
  assert.equal(matchesProcess({procStartFt:'ft'},processInfo),true);assert.equal(matchesProcess({procStartFt:'old'},processInfo),false);assert.equal(matchesProcess({},processInfo),false);
});

test('完整正文面板保留多行内容并可见地转义终端控制字符',t=>{
  const {store,c,x}=fixture(t),m=store.accept(store.pair(c.id,x.id),c,'第一行\n第二行\u001b[2J','call');
  const rendered=formatMessage(m,store.peers());assert.match(rendered,/第一行\n第二行\\u001b\[2J/);assert.ok(rendered.includes(m.id));assert.match(rendered,/已持久化/);assert.equal(rendered.includes('\u001b'),false);
});

test('Claude 封套遵守官方地址和名称规范',t=>{
  const {store,c,x}=fixture(t),m=store.accept(store.pair(c.id,x.id),x,'正文','codec');
  for(const pipe of ['\\\\.\\pipe\\.','\\\\.\\pipe\\..','\\\\.\\pipe\\name.','\\\\?\\pipe/foo'])assert.throws(()=>canonicalPipe(pipe),/无效/);
  assert.equal(canonicalPipe('\\\\.\\pipe\\ÄABC'),'\\\\.\\pipe\\Äabc');
  const encoded=encodePeerMessage(m,{...x,name:'字'.repeat(90)},'c','/tmp/含空 格.sock') as any;
  assert.match(encoded.from,/%E5/);assert.equal(encoded.from.includes(' '),false);
  const label=/from-name="([^"]+)"/.exec(encoded.message.content)![1]!;assert.equal([...label].length,65);assert.ok(label.endsWith('…'));
  assert.equal(codexPermission({approvalPolicy:'never',sandbox:{type:'dangerFullAccess'}}),'bypass');
  assert.equal(codexPermission({approvalPolicy:'never',sandbox:{type:'readOnly'}}),'prompting');assert.equal(codexPermission({approvalPolicy:'never',sandbox:{type:'externalSandbox'}}),'unknown');
});

test('启动解析保留短参数、子命令、工作目录和显式正文',()=>{
  assert.equal(launchMode([]).mode,'native','无参数启动保持官方新会话语义，不连接已有运行时');
  assert.equal(launchMode(['-pwork','resume','id']).mode,'native');assert.equal(launchMode(['-cmodel=x','任务']).mode,'native');
  assert.equal(launchMode(['--model','review','任务']).mode,'native');assert.equal(launchMode(['-C','/project','doctor']).mode,'native');
  assert.equal(launchMode(['-C/project','任务']).mode,'native');assert.equal(launchMode(['--','--worktree']).mode,'native');
  assert.equal(launchMode(['--model','resume','任务']).mode,'native');assert.equal(launchMode(['--','resume']).mode,'native');
  assert.equal(launchMode(['--yolo']).mode,'native');assert.equal(launchMode(['fork','id']).mode,'native');
  assert.equal(launchMode(['--remote','wss://localhost','--remote-auth-token-env','NX_TOKEN']).tokenEnv,'NX_TOKEN');
});
