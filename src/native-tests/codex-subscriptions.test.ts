import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import path from 'node:path';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { readModelBody } from './model-http-fixture.js';
import { stringify } from 'smol-toml';
import { CodexAdapter, connectAppServer, threadRegistration } from '../hosts/codex/adapter.js';
import { Broker, type Adapters } from '../broker/coordinator.js';
import { Store } from '../storage/store.js';
import {DEFAULT_CONFIG} from '../config/defaults.js';
import {delay} from '../shared/time.js';
import {ensureHome} from '../ipc/home.js';
import { liveProcess, processIdentity } from '../process/process.js';
import { rememberOwnedChild } from '../process/owned-processes.js';
import { runtimeFor, saveManagedRuntime } from '../hosts/managed-runtimes.js';
import { FakeAdapter } from '../tests/support/fake-adapter.js';
import { registration } from '../tests/support/registration.js';
import { temporaryDirectory } from '../tests/support/temporary.js';
import { releaseNativeTestLaunches } from '../tests/support/native-launch.js';

async function wait(check:()=>Promise<boolean>,description:string):Promise<void>{
  const until=Date.now()+15000;
  while(!await check()){if(Date.now()>until)assert.fail(description);await delay(50);}
}

test('原生零卸载宽限期仅释放无订阅的空闲线程，同一后台的其他订阅保持可用',{timeout:90000},async t=>{
  const temp=temporaryDirectory(),home=path.join(temp.directory,'bridge'),codexHome=path.join(temp.directory,'codex');
  mkdirSync(codexHome);await ensureHome(home);
  writeFileSync(path.join(codexHome,'config.toml'),stringify({thread_unload_delay_secs:0,features:{apps:false,remote_plugin:false}}),'utf8');
  const config={...DEFAULT_CONFIG,codexHome,...(process.env.NXBRIDGE_TEST_CODEX_BINARY?{codexBinary:process.env.NXBRIDGE_TEST_CODEX_BINARY}:{})},adapter=new CodexAdapter(config,home);
  let window:Awaited<ReturnType<typeof connectAppServer>>|undefined;
  t.after(async()=>{window?.close();adapter.close();assert.deepEqual(await releaseNativeTestLaunches(home),[]);await temp.cleanup();});
  const endpoint=await adapter.ensureEndpoint(temp.directory),service=await adapter.connect(endpoint);
  window=await connectAppServer(endpoint,config,undefined,home);
  const first=(await service.request('thread/start',{cwd:temp.directory,ephemeral:true})).thread;
  const second=(await window.request('thread/start',{cwd:temp.directory,ephemeral:true})).thread;
  assert.equal((await adapter.loadedRuntime(second.id,codexHome))?.endpoint,endpoint,'明确加载的旧后台会话必须保留即时接入路径');
  await service.request('thread/unsubscribe',{threadId:first.id});
  await wait(async()=>!(await service.request('thread/loaded/list',{limit:100})).data.includes(first.id),'零宽限期没有卸载空闲线程');
  assert.ok((await window.request('thread/loaded/list',{limit:100})).data.includes(second.id));
  assert.equal((await window.request('thread/read',{threadId:second.id,includeTurns:false})).thread.status.type,'idle');
  const legacy=runtimeFor(home,{endpoint})!.value;delete legacy.threadUnloadDelaySecs;saveManagedRuntime(home,legacy);
  assert.equal(await adapter.ensureEndpoint(temp.directory,undefined,undefined,second.id),endpoint,'旧后台只复用仍然加载的明确 UUID');
  const current=await adapter.ensureEndpoint(temp.directory);assert.notEqual(current,endpoint,'无 UUID 的选择器不能继续进入旧后台');
  assert.equal(runtimeFor(home,{endpoint:current})!.value.threadUnloadDelaySecs,0);assert.equal(await adapter.ensureEndpoint(temp.directory),current,'后续前台复用已经创建的新后台');
  assert.ok((await window.request('thread/loaded/list',{limit:100})).data.includes(second.id));assert.equal(liveProcess(legacy.pid!),true);
  t.diagnostic('零值表示立即卸载；另一个客户端仍订阅的线程保持加载。');
});

test('用户观察租约自动释放后仍可唤醒；关闭窗口后原 ID 可从另一后台恢复，同后台另一线程继续运行',{timeout:150000},async t=>{
  const temp=temporaryDirectory(),root=temp.directory,home=path.join(root,'bridge'),codexHome=path.join(root,'codex');
  mkdirSync(codexHome);await ensureHome(home);
  let requests=0,responseHold:Promise<void>|undefined;
  const model=http.createServer(async(req,res)=>{
    if(!req.url?.includes('/responses')){res.writeHead(200,{'content-type':'application/json'});res.end('{"data":[]}');return;}
    try{
      const raw=await readModelBody(req);JSON.parse(raw.toString());
      const id='subscription-'+(++requests),item={id:'message-'+id,type:'message',role:'assistant',status:'completed',content:[{type:'output_text',text:'线程释放验收持久历史'}]};
      await responseHold;
      res.writeHead(200,{'content-type':'text/event-stream'});
      for(const event of [{type:'response.created',response:{id,status:'in_progress',output:[]}},{type:'response.output_item.added',output_index:0,item},{type:'response.output_item.done',output_index:0,item},{type:'response.completed',response:{id,status:'completed',output:[item],usage:{input_tokens:1,output_tokens:1,total_tokens:2}}}])res.write('data: '+JSON.stringify(event)+'\n\n');res.end();
    }catch(error){res.writeHead(500);res.end(String(error));}
  });
  await new Promise<void>(resolve=>model.listen(0,'127.0.0.1',resolve));
  const configText=stringify({model:'gpt-5.1-codex',model_provider:'subscription_test',approval_policy:'never',sandbox_mode:'danger-full-access',web_search:'disabled',analytics:{enabled:false},features:{apps:false,remote_plugin:false,daemon_auto_start:false,code_mode:false},model_providers:{subscription_test:{name:'本地线程释放验收',base_url:'http://127.0.0.1:'+(model.address() as any).port+'/v1',wire_api:'responses',requires_openai_auth:false}}});
  writeFileSync(path.join(codexHome,'config.toml'),configText,'utf8');
  const config={...DEFAULT_CONFIG,codexHome,...(process.env.NXBRIDGE_TEST_CODEX_BINARY?{codexBinary:process.env.NXBRIDGE_TEST_CODEX_BINARY}:{})},adapter=new CodexAdapter(config,home),store=new Store(':memory:'),broker=new Broker(store,config,{codex:adapter,claude:new FakeAdapter()} as unknown as Adapters,home);
  const windows:Awaited<ReturnType<typeof connectAppServer>>[]=[];
  t.after(async()=>{for(const rpc of windows)rpc.close();await broker.stop();assert.deepEqual(await releaseNativeTestLaunches(home),[]);model.closeAllConnections();await new Promise<void>(resolve=>model.close(()=>resolve()));store.close();await temp.cleanup();});
  const endpoint=await adapter.ensureEndpoint(root),runtime=runtimeFor(home,{endpoint})!.value;
  assert.equal(runtime.threadUnloadDelaySecs,0);
  const window=await connectAppServer(endpoint,config,undefined,home);windows.push(window);
  const first=await window.request('thread/start',{cwd:root});
  await window.request('turn/start',{threadId:first.thread.id,input:[{type:'text',text:'生成持久历史'}]});
  await wait(async()=>requests>0&&(await window.request('thread/read',{threadId:first.thread.id,includeTurns:false})).thread.status.type==='idle','本地轮次没有完成');
  const peer=store.register({...threadRegistration(first.thread,endpoint,first)!,endpoint:{...threadRegistration(first.thread,endpoint,first)!.endpoint,configHome:codexHome}}),other=store.register(registration('claude','subscription-partner',{cwd:root}));store.pair(other.id,peer.id);
  await adapter.attach(store.peer(peer.id),store.endpoint(peer.id)!);
  await (broker as any).releaseIdleCodexSubscriptions();
  assert.equal((await window.request('thread/read',{threadId:first.thread.id,includeTurns:false})).thread.status.type,'idle');
  assert.equal(store.endpoint(peer.id)?.active,true,'其他订阅仍在，不能结束前台路由');
  const events:any[]=[];adapter.on('native',event=>{if(event.message.params?.threadId===first.thread.id)events.push(event.message);});
  let finishResponse!:()=>void;responseHold=new Promise(resolve=>finishResponse=resolve);
  const userTurn=await window.request('turn/start',{threadId:first.thread.id,input:[{type:'text',text:'用户窗口开始新一轮'}]});
  try{
    await wait(async()=>requests===2&&adapter.hasSubscription(store.peer(peer.id),store.endpoint(peer.id)!)&&(broker as any).health.get(endpoint,first.thread.id)?.turnId===userTurn.turn.id,'全局忙碌通知没有恢复用户线程的事件观察');
    assert.equal((broker as any).health.get(endpoint,first.thread.id).state,'running');
  }finally{finishResponse();responseHold=undefined;}
  await wait(async()=>events.some(event=>event.method==='item/completed')&&events.some(event=>event.method==='turn/completed')&&(broker as any).health.get(endpoint,first.thread.id)?.state==='ready','恢复运行中观察后未收到正文及轮次结束事件');
  await (broker as any).releaseIdleCodexSubscriptions();assert.equal(adapter.hasSubscription(peer,store.endpoint(peer.id)!),false);
  await adapter.wake(store.peer(peer.id),store.endpoint(peer.id)!);
  await wait(async()=>requests===3&&(await window.request('thread/read',{threadId:first.thread.id,includeTurns:false})).thread.status.type==='idle','释放观察租约后没有正常重新订阅并唤醒');
  assert.equal(adapter.hasSubscription(peer,store.endpoint(peer.id)!),true);
  await (broker as any).releaseIdleCodexSubscriptions();
  assert.equal(adapter.hasSubscription(peer,store.endpoint(peer.id)!),false);
                                                   
  const retained=await connectAppServer(endpoint,config,undefined,home);windows.push(retained);
  const second=await retained.request('thread/start',{cwd:root,ephemeral:true});
  const foreground=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore',windowsHide:true});
  await once(foreground,'spawn');await rememberOwnedChild(home,foreground,'host-control');const identity=await processIdentity(foreground.pid!);
  t.after(async()=>{if(foreground.exitCode===null&&foreground.signalCode===null){const exited=once(foreground,'exit');foreground.kill();await exited;}});
  await broker.dispatch('codex.foreground.started',{endpoint,session_id:first.thread.id,foreground:{pid:identity.pid,procStart:identity.startedAt}});
  responseHold=new Promise(resolve=>finishResponse=resolve);await window.request('turn/start',{threadId:first.thread.id,input:[{type:'text',text:'关闭窗口时正在执行的工作'}]});
  await wait(async()=>requests===4&&adapter.hasSubscription(peer,store.endpoint(peer.id)!),'关闭前的用户轮次没有恢复观察');
  const pending=store.accept(store.pairFor(peer.id)!,store.peer(other.id),'等原窗口重新打开后处理','native-closed-pending');window.close();
  const exited=once(foreground,'exit');foreground.kill();await exited;
  await broker.pump();assert.equal(requests,4,'退出后不能因排队消息开始新轮次');finishResponse();responseHold=undefined;
  await wait(async()=>{await (broker as any).releaseIdleCodexSubscriptions();return !(await retained.request('thread/loaded/list',{limit:100})).data.includes(first.thread.id);},'关闭中的用户线程完成后没有释放观察');
  await (broker as any).releaseIdleCodexSubscriptions();assert.equal(store.message(pending.id).state,'accepted');assert.equal(store.endpoint(peer.id),undefined);
  await wait(async()=>!(await retained.request('thread/loaded/list',{limit:100})).data.includes(first.thread.id),'窗口关闭后线程仍被服务观察订阅占用');
  assert.ok((await retained.request('thread/loaded/list',{limit:100})).data.includes(second.thread.id));assert.equal(liveProcess(runtime.pid!),true);
                                            
  const freshEndpoint=await adapter.ensureEndpoint(root,'subscription-reopen'),fresh=await adapter.connect(freshEndpoint),resumed=await fresh.request('thread/resume',{threadId:first.thread.id});
  assert.equal(resumed.thread.id,first.thread.id);assert.match(JSON.stringify(resumed.thread.turns),/线程释放验收持久历史/);
  assert.equal(readFileSync(path.join(codexHome,'config.toml'),'utf8'),configText,'启动覆盖不得改写用户配置');
  t.diagnostic(JSON.stringify({unloaded:first.thread.id,retained:second.thread.id,sharedRuntimeAlive:liveProcess(runtime.pid!),reopenedOnAnotherRuntime:true,requests}));
});
