import { copyNodeBinary } from './support/node-binary.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { once } from 'node:events';
import { pathToFileURL } from 'node:url';
import { fixture } from './support/broker-fixture.js';
import { FakeAdapter } from './support/fake-adapter.js';
import { recordFixtureLaunch } from './support/native-launch.js';
import { registration } from './support/registration.js';
import { temporary, temporaryDirectory } from './support/temporary.js';
import { disabledMember, memberOffResultFor, writeMemberControls } from '../broker/member-control.js';
import { Broker } from '../broker/coordinator.js';
import { Store } from '../storage/store.js';
import {DEFAULT_CONFIG} from '../config/defaults.js';
import {type Actor,type Host} from '../types.js';
import {ensureHome} from '../ipc/home.js';
import {PACKAGE_ROOT} from '../shared/package-location.js';
import { processIdentity } from '../process/process.js';
import { recordOwnedProcess, releaseOwnedProcess, type OwnedProcessRecord } from '../process/owned-processes.js';
import { CodexDirectDelivery } from '../hosts/codex/codex-direct.js';
import { listenBroker } from '../ipc/ipc.js';

const actor=(host:Host,sessionId:string):Actor=>({host,sessionId,callId:'control'});
const change=(broker:Broker,who:Actor,target:'self'|'partner',enabled:boolean,human=false)=>broker.dispatch('member.switch',{actor:who,target,enabled,user_requested:true,...(human?{origin:'composer'}:{})});

for(const host of ['codex','claude'] as const)test(host+' 关闭后保留配对和消息，拒绝新发送、窗口退出不恢复，自己开启后继续原消息',async t=>{
  const f=fixture(t),target=host==='codex'?f.x:f.c,source=host==='codex'?f.c:f.x,pair=f.store.pair(f.c.id,f.x.id),message=f.store.accept(pair,source,'关闭前的原消息','before');
  const original=f.store.message(message.id),who=actor(source.host,source.sessionId!);
  const outgoing=f.store.accept(pair,target,'关闭侧已有的发出消息','outgoing');
  await change(f.broker,who,'partner',false);await f.broker.pump();
  assert.equal(f.store.message(outgoing.id).state,'accepted');
  assert.equal(f.store.pairFor(target.id)?.id,pair.id);assert.deepEqual(f.store.message(message.id),original);
  await assert.rejects(f.broker.dispatch('send',{actor:who,message:'关闭后禁止入队'}),error=>{
    assert.equal((error as any).code,'member_disabled');assert.equal((error as any).enable_command,`nxbridge on ${target.host} --member ${target.id}`);return true;
  });
  const status=await f.broker.dispatch('status',{actor:who,model_view:true}) as any;
  assert.equal(status.self.enabled,true);assert.equal(status.partner.enabled,false);
  f.store.deactivate(target.id);f.store.updatePeer(target.id,{owner:'nxbridge',state:'offline'});
  recordFixtureLaunch(f.store,f.broker.home,target);
  f.store.unpair(pair.id,{reason:'window_exit'});await f.broker.pump();
  assert.equal(f.store.pairFor(target.id)?.id,pair.id);assert.equal(f.codex.created.length+f.claude.created.length,0);
  assert.equal(f.codex.delivered.length+f.claude.delivered.length,0);
  assert.deepEqual(await f.broker.dispatch('receive',{actor:actor(target.host,target.sessionId!)}),{...memberOffResultFor(target),messages:[]});
  await change(f.broker,who,'partner',true,true);await f.broker.pump();
  assert.equal(f.store.peer(target.id).sessionId,target.sessionId);assert.equal(f.store.pairFor(target.id)?.id,pair.id);
  assert.equal(f.store.message(message.id).attempts,1);assert.ok(f[host].delivered.some(item=>item.id===message.id));
});

test('开关只接受明确要求的根窗口，搭档不能开启另一侧；独立终端可开启未配对成员',async t=>{
  const f=fixture(t);f.store.pair(f.c.id,f.x.id);const who=actor('claude','c');
  await assert.rejects(f.broker.dispatch('member.switch',{actor:who,target:'partner',enabled:false,user_requested:false}));
  await assert.rejects(change(f.broker,{...who,via:'child'},'partner',false),{code:'subagent_denied'});
  await change(f.broker,who,'partner',false);
  await assert.rejects(change(f.broker,who,'partner',true),{code:'member_enable_human_required'});
  await assert.rejects(change(f.broker,actor('codex','x'),'self',true),{code:'member_enable_human_required'});
  assert.equal(f.store.peer(f.x.id).enabled,false);
  f.store.unpair(f.store.pairFor(f.x.id)!.id);
  const terminal={host:'codex',peer_id:f.x.id,enabled:true},identity=await processIdentity(process.pid),terminal_origin={pid:identity.pid,procStart:identity.startedAt,tty:true as const};
  await assert.rejects(f.broker.dispatch('member.switch.terminal',{...terminal,peer_id:'不可访问的目标'}),{code:'user_terminal_required'});
  await assert.rejects(f.broker.dispatch('member.switch.terminal',{...terminal,terminal_origin:{...terminal_origin,procStart:'错误代次'}}),{code:'user_terminal_required'});
  assert.equal(f.store.peer(f.x.id).enabled,false);
                                            
  const home=temporary(t),launcher=spawn(process.execPath,['-e',"const{spawn}=require('node:child_process');const c=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{windowsHide:true,detached:true,stdio:'ignore'});c.unref();c.on('spawn',()=>process.send(c.pid));process.on('message',()=>process.exit());"],{windowsHide:true,stdio:['ignore','ignore','ignore','ipc']}),closed=once(launcher,'close');
  let proof:OwnedProcessRecord|undefined;
  try{
    const [pid]=await once(launcher,'message'),external=await processIdentity(pid);
    proof=await recordOwnedProcess(home,{role:'host-control',identity:external,parent:identity,proof:{kind:'spawn'}});
    launcher.send('退出');await closed;
    await f.broker.dispatch('member.switch.terminal',{...terminal,terminal_origin:{pid:external.pid,procStart:external.startedAt,tty:true}});
    assert.equal(f.store.peer(f.x.id).enabled,true);assert.equal(f.codex.created.length,0);
  }finally{
    if(launcher.exitCode===null&&launcher.signalCode===null)launcher.kill();
    await closed;
    if(proof)await releaseOwnedProcess(proof);
  }
});

test('关闭状态持久化，broker 重启不改待发和提交中消息、不访问或替换关闭侧',async t=>{
  const temp=temporaryDirectory(),home=temp.directory,file=path.join(home,'state.db');await ensureHome(home);
  let store=new Store(file),codex=new FakeAdapter(),claude=new FakeAdapter(),broker=new Broker(store,DEFAULT_CONFIG,{codex,claude} as any,home);
  const c=store.register(registration('claude','persist-c')),x=store.register(registration('codex','persist-x',{state:'offline'})),pair=store.pair(c.id,x.id);
  store.updatePeer(x.id,{owner:'nxbridge'});
  const pending=store.accept(pair,c,'已排队','pending'),sending=store.accept(pair,c,'提交中','sending');store.claim(sending.id);
  await change(broker,actor('claude','persist-c'),'partner',false);
  const before=[store.message(pending.id),store.message(sending.id)];await broker.stop();store.close();
  store=new Store(file);codex=new FakeAdapter();claude=new FakeAdapter();broker=new Broker(store,DEFAULT_CONFIG,{codex,claude} as any,home);
  t.after(async()=>{await broker.stop();store.close();await temp.cleanup();});await broker.start();await broker.pump();
  assert.equal(store.peer(x.id).enabled,false);assert.equal(store.pairFor(x.id)?.id,pair.id);
  assert.deepEqual([store.message(pending.id),store.message(sending.id)],before);
  assert.equal(codex.connected.length+codex.attached.length+codex.created.length+codex.woken.length+codex.released.length,0);
  assert.equal(disabledMember(home,{host:'codex',sessionId:'persist-x'})?.peerId,x.id);
});

test('关闭侧不会重新登记、采集环境、处理事件或生成健康告警，原端点不变',async t=>{
  const f=fixture(t);f.store.pair(f.c.id,f.x.id);
  await change(f.broker,actor('claude','c'),'partner',false);const before=f.store.peer(f.x.id),endpoints=f.store.endpoints(f.x.id);
  const registered=await f.broker.dispatch('mcp.register',registration('codex','x',{state:'busy'})) as any;
  assert.equal(registered.id,f.x.id);assert.equal(registered.enabled,false);
  f.codex.emit('state','x','busy',endpoints[0]!.address);f.codex.emit('native',{address:endpoints[0]!.address,message:{method:'turn/started',params:{threadId:'x',turn:{id:'new-turn'}}}});
  await f.broker.dispatch('hook',{hook_event_name:'SessionEnd',session_id:'x'});await f.broker.pump();
  assert.deepEqual(f.store.peer(f.x.id),before);assert.deepEqual(f.store.endpoints(f.x.id),endpoints);
  assert.deepEqual((f.broker.status() as any).capabilities.integrationIssues,[]);
});

test('本地关闭标记核对进程代次，前台切换线程仍关闭，共享 daemon 不影响其他线程',t=>{
  const f=fixture(t),home=temporary(t);f.store.updatePeer(f.x.id,{enabled:false});
  const endpoint=f.store.endpoint(f.x.id)!;f.store.saveEndpoint({...endpoint,mode:'embedded',processKind:'foreground',pid:123,procStart:'generation'});writeMemberControls(home,f.store);
  assert.equal(disabledMember(home,{host:'codex',sessionId:'new-thread',pid:123,procStart:'generation'})?.peerId,f.x.id);
  assert.equal(disabledMember(home,{host:'codex',sessionId:'x',pid:123,procStart:'reused-pid'}),undefined);
  assert.equal(disabledMember(home,{host:'codex',sessionId:'x',pid:999,procStart:'new-process'})?.peerId,f.x.id);
  f.store.saveEndpoint({...endpoint,mode:'embedded',daemon:{address:'shared'},pid:123,procStart:'generation'});writeMemberControls(home,f.store);
  assert.equal(disabledMember(home,{host:'codex',sessionId:'other-thread',pid:123,procStart:'generation'}),undefined);
  assert.equal(disabledMember(home,{host:'codex',sessionId:'x',pid:123,procStart:'generation'})?.peerId,f.x.id);
});

test('同一个原生会话的两个窗口，关闭一个成员不会影响另一个窗口',t=>{
  const f=fixture(t),home=temporary(t),configHome=path.join(home,'codex');
  const input=(pid:number)=>registration('codex','twins',{endpoint:{mode:'embedded',address:'',epoch:'window-'+pid,pid,procStart:'generation-'+pid,configHome,processKind:'foreground'}});
  const one=f.store.register(input(101)),two=f.store.register(input(202));assert.notEqual(one.id,two.id);f.store.updatePeer(one.id,{enabled:false});writeMemberControls(home,f.store);
  assert.equal(disabledMember(home,{host:'codex',sessionId:'twins'}),undefined);
  assert.equal(disabledMember(home,{host:'codex',sessionId:'twins',pid:101,procStart:'generation-101',configHome})?.peerId,one.id);
  assert.equal(disabledMember(home,{host:'codex',sessionId:'twins',pid:202,procStart:'generation-202',configHome}),undefined);
  assert.equal((f.broker as any).disabledRegistration(input(202)),undefined);
});

test('关闭期间不结束问题或改写问题消息，开启后才恢复时限处理',async t=>{
  const f=fixture(t),pair=f.store.pair(f.c.id,f.x.id),who=actor('codex','x');
  const result=f.broker.questions.create(pair,f.x,who,{questions:[{id:'one',header:'确认',question:'保留这个问题吗？'}]}) as any;
  await change(f.broker,actor('claude','c'),'partner',false);
  const q=f.store.question(result.request_id)!;q.expiresAt=0;f.store.saveQuestion(q);const message=f.store.message(q.messageId);
  f.broker.questions.sweep();f.broker.questions.recover();assert.equal(f.store.question(q.id)!.status,'pending');assert.deepEqual(f.store.message(q.messageId),message);
  await change(f.broker,who,'self',true,true);f.broker.questions.sweep();assert.equal(f.store.question(q.id)!.status,'timed_out');
});

test('长期关闭的成员和消息不会被历史保留策略清除',t=>{
  const f=fixture(t),pair=f.store.pair(f.c.id,f.x.id),message=f.store.accept(pair,f.c,'保留关闭时的账本','retention');f.store.claim(message.id);f.store.transition(message.id,'runtimeQueued','宿主 PostToolUse 确认取件工具完成');
  f.store.updatePeer(f.x.id,{enabled:false,state:'offline'});f.store.unpair(pair.id);f.store.deactivate(f.x.id);
  const before=f.store.message(message.id);f.store.recoverEmbeddedReceipts();f.store.maintain({maxMessages:0},Date.now()+365*86400000);
  assert.equal(f.store.peer(f.x.id).enabled,false);assert.deepEqual(f.store.message(message.id),before);
});

test('MCP 缺少权限元数据时不清掉原生已核验权限，不能因 unknown 阻塞其他侧通信',async t=>{
  const f=fixture(t);f.store.updatePeer(f.x.id,{permission:'bypass'});const endpoint=f.store.endpoint(f.x.id)!;
  await f.broker.dispatch('mcp.register',registration('codex','x',{permission:'unknown',endpoint:{...endpoint,mode:'embedded',processKind:'app-server',codexPermission:{}}}));
  assert.equal(f.store.peer(f.x.id).permission,'bypass');
});

test('关闭后的真实 hook 入口直接返回空输出，不登记窗口或注入恢复上下文',async t=>{
  const f=fixture(t),home=temporary(t);f.store.updatePeer(f.x.id,{enabled:false});writeMemberControls(home,f.store);
  for(const event of ['SessionStart','SessionEnd','PreToolUse']){
    const child=spawn(process.execPath,[path.join(PACKAGE_ROOT,'dist/hook-entry.js'),'hook','--host','codex'],{env:{...process.env,NXBRIDGE_HOME:home},windowsHide:true,stdio:['pipe','pipe','pipe']});let out='',err='';child.stdout.on('data',data=>out+=data);child.stderr.on('data',data=>err+=data);const ended=once(child,'close');child.stdin.end(JSON.stringify({hook_event_name:event,session_id:'x',tool_name:'send_message',tool_input:{message:'nxref:msg:missing'}}));
    const [code]=await ended;assert.equal(code,0,err);assert.deepEqual(JSON.parse(out),{});assert.equal(err,'');
  }
  assert.equal(existsSync(path.join(home,'nxbridge.db')),false);
});

test('原生历史读取期间关闭成员，不再认领、注入、续跑或结算消息',async t=>{
  const f=fixture(t),pair=f.store.pair(f.c.id,f.x.id),message=f.store.accept(pair,f.c,'并发关闭','race'),endpoint=f.store.endpoint(f.x.id)!;
  let release!:(state:any)=>void,entered!:()=>void;const started=new Promise<void>(resolve=>entered=resolve);
  const adapter={injectionState:async()=>{entered();return new Promise<any>(resolve=>release=resolve);},inject:async()=>assert.fail('已关闭时不得注入'),continueInjected:async()=>assert.fail('已关闭时不得续跑')};
  const delivery=new CodexDirectDelivery(f.store,adapter),work=delivery.deliver(f.x,endpoint,[message],async()=>'{"messages":[]}',()=>true,()=>assert.fail('已关闭时不得结算'));
  await started;f.store.updatePeer(f.x.id,{enabled:false});release({thread:{id:'x',status:{type:'idle'},turns:[]},history:{status:'supported',calls:[],receipts:[]}});await work;
  assert.equal(f.store.message(message.id).state,'accepted');assert.equal(f.store.message(message.id).attempts,0);
});

test('用户亲自在已关闭 Codex 的输入框开启另一侧，hook 不登记窗口或注入上下文',async t=>{
  const f=fixture(t),temp=temporaryDirectory(),home=f.broker.home,configHome=path.join(temp.directory,'codex'),binary=path.join(temp.directory,process.platform==='win32'?'codex.exe':'codex');copyNodeBinary(binary);
  const script=`process.title='codex';process.on('message',p=>{const c=require('node:child_process').spawn(p.node,[p.entry,'hook','--host','codex'],{env:process.env,windowsHide:true,stdio:['pipe','pipe','pipe']});let out='',err='';c.stdout.on('data',d=>out+=d);c.stderr.on('data',d=>err+=d);c.on('close',code=>process.send({code,out,err}));c.stdin.end(JSON.stringify(p.input));});process.send('ready');`;
  const native=spawn(binary,['-e',script],{env:{...process.env,NXBRIDGE_HOME:home,CODEX_HOME:configHome},windowsHide:true,stdio:['ignore','ignore','ignore','ipc']}),closed=once(native,'close');let server:Awaited<ReturnType<typeof listenBroker>>|undefined;
  t.after(async()=>{if(native.exitCode===null&&native.signalCode===null)native.kill();await closed;await server?.close();await temp.cleanup();});await once(native,'message');
  const identity=await processIdentity(native.pid!);f.store.saveEndpoint({...f.store.endpoint(f.x.id)!,mode:'embedded',processKind:'foreground',pid:native.pid!,procStart:identity.startedAt,configHome});f.store.pair(f.c.id,f.x.id);f.store.updatePeer(f.c.id,{enabled:false});f.store.updatePeer(f.x.id,{enabled:false});writeMemberControls(home,f.store);
  await ensureHome(home);server=await listenBroker(home,(method,params)=>f.broker.dispatch(method,params));
  const done=once(native,'message');native.send({node:process.execPath,entry:path.join(PACKAGE_ROOT,'dist/hook-entry.js'),input:{hook_event_name:'UserPromptSubmit',session_id:'x',prompt:'nxbridge on claude'}});const value=(await done)[0];assert.equal(value.code,0,value.err);assert.equal(value.err,'');const result=JSON.parse(value.out);assert.equal(result.decision,'block');assert.equal(result.hookSpecificOutput,undefined);assert.equal(f.store.peer(f.c.id).enabled,true);assert.equal(f.store.peer(f.x.id).enabled,false);
});

test('关闭后的真实 MCP 入口不连接 broker、所有业务工具简短返回 off，保留控制入口',async t=>{
  const f=fixture(t),temp=temporaryDirectory(),home=temp.directory,binary=path.join(home,process.platform==='win32'?'codex.exe':'codex');copyNodeBinary(binary);
  const script=`process.title='codex';process.send('ready');process.on('message',async p=>{try{const{Client}=await import(p.client);const{StdioClientTransport}=await import(p.transport);const c=new Client({name:'off-test',version:'1'});const tr=new StdioClientTransport({command:p.node,args:[p.entry,'mcp','--host','codex'],env:process.env,stderr:'pipe'});let err='';tr.stderr?.on('data',d=>err+=d);await c.connect(tr);const list=await c.listTools();const values=[];for(const name of ['send_message','receive_messages','checkpoint'])values.push(await c.callTool({name,arguments:name==='send_message'?{message:'不应发送'}:{},_meta:{threadId:'x',sessionId:'x'}}));await c.close();process.send({names:list.tools.map(t=>t.name),values,err});}catch(e){process.send({error:String(e)});}});`;
  const native=spawn(binary,['-e',script],{env:{...process.env,NXBRIDGE_HOME:home,CODEX_HOME:path.join(home,'codex-home')},windowsHide:true,stdio:['ignore','ignore','ignore','ipc']}),closed=once(native,'close');
  t.after(async()=>{if(native.exitCode===null&&native.signalCode===null)native.kill();await closed;await temp.cleanup();});await once(native,'message');
  const identity=await processIdentity(native.pid!);f.store.saveEndpoint({...f.store.endpoint(f.x.id)!,mode:'embedded',processKind:'foreground',pid:native.pid!,procStart:identity.startedAt});f.store.updatePeer(f.x.id,{enabled:false});writeMemberControls(home,f.store);
  const done=once(native,'message'),sdk=path.join(PACKAGE_ROOT,'node_modules/@modelcontextprotocol/sdk/dist/esm/client');native.send({node:process.execPath,entry:path.join(PACKAGE_ROOT,'dist/mcp-entry.js'),client:pathToFileURL(path.join(sdk,'index.js')).href,transport:pathToFileURL(path.join(sdk,'stdio.js')).href});
  const value=(await done)[0];assert.equal(value.error,undefined);assert.ok(value.names.includes('set_enabled'));
  for(const result of value.values){const output=JSON.parse(result.content[0].text);assert.equal(output.code,'member_disabled');assert.equal(output.enable_command,`nxbridge on codex --member ${f.x.id}`);}
  assert.equal(value.err,'');assert.equal(existsSync(path.join(home,'nxbridge.db')),false);
});
