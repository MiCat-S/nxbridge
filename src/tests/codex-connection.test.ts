import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import net from 'node:net';
import { PassThrough } from 'node:stream';
import type { ChildProcess } from 'node:child_process';
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { EventEmitter, once } from 'node:events';
import { WebSocketServer } from 'ws';
import { CodexAdapter, connectAppServer } from '../hosts/codex/adapter.js';
import { brokerCall } from '../ipc/ipc.js';
import {delay} from '../shared/time.js';
import { Store } from '../storage/store.js';
import {DEFAULT_CONFIG} from '../config/defaults.js';
import {DeliveryError} from '../shared/errors.js';
import { proxySocket } from '../ipc/proxy-socket.js';
import { liveProcess } from '../process/process.js';
import { codexInitializeResult, registration } from './support/registration.js';
import { temporary, temporaryDirectory } from './support/temporary.js';
import { requireIndependentWindows } from './support/windows-job.js';

for(const [status,expected,snapshot] of [[{type:'idle'},'ready','active'],[{type:'active'},'busy','idle'],[{type:'active',activeFlags:['waitingForApproval']},'needsHuman','idle']] as const)test('延迟线程读取不能覆盖较新的原生状态：'+expected,async t=>{
  const home=temporary(t),adapter=new CodexAdapter(DEFAULT_CONFIG,home),address='ws://127.0.0.1:1234',registrations:any[]=[];
  let finish!:(value:any)=>void;const pending=new Promise(resolve=>finish=resolve),rpc={closed:false,request:()=>pending,close:()=>{}};
  (adapter as any).clients.set(address,rpc);t.after(()=>adapter.close());adapter.on('register',input=>registrations.push(input));
  (adapter as any).notify(address,{method:'turn/started',params:{threadId:'state-race',turn:{id:'turn-race'}}});
  (adapter as any).notify(address,{method:'thread/status/changed',params:{threadId:'state-race',status}});
  finish({thread:{id:'state-race',cwd:home,status:{type:snapshot}}});await new Promise<void>(resolve=>setImmediate(resolve));
  assert.ok(registrations.length>0);assert.ok(registrations.every(input=>input.state===expected),JSON.stringify(registrations));
});

test('原生线程重新加载后，新的开始事件替代此前卸载状态',t=>{
  const adapter=new CodexAdapter(DEFAULT_CONFIG,temporary(t)),address='ws://127.0.0.1:1234',registrations:any[]=[];t.after(()=>adapter.close());
  adapter.on('register',input=>registrations.push(input));
  (adapter as any).notify(address,{method:'thread/status/changed',params:{threadId:'reloaded',status:{type:'notLoaded'}}});
  (adapter as any).notify(address,{method:'thread/started',params:{thread:{id:'reloaded',cwd:process.cwd(),status:{type:'idle'}}}});
  assert.equal(registrations.at(-1).state,'ready');
});

test('新读取可以替代请求之前的原生状态，保留请求之后的事件优先级',async t=>{
  const adapter=new CodexAdapter(DEFAULT_CONFIG,temporary(t)),address='ws://127.0.0.1:1234',registrations:any[]=[];t.after(()=>adapter.close());
  adapter.on('register',input=>registrations.push(input));
  (adapter as any).notify(address,{method:'thread/status/changed',params:{threadId:'fresh-read',status:{type:'active'}}});
  (adapter as any).clients.set(address,{closed:false,request:async()=>({thread:{id:'fresh-read',cwd:process.cwd(),status:{type:'idle'}}}),close:()=>{}});
  await (adapter as any).discoverThread(address,'fresh-read');
  assert.equal(registrations.at(-1).state,'ready');
});

for(const stage of ['订阅前','提交后'] as const)test(`系统通知${stage}取消不会误报提交结果，也不取消共用订阅或重发通知`,async t=>{
  const home=temporary(t),adapter=new CodexAdapter(DEFAULT_CONFIG,home),server=new WebSocketServer({host:'127.0.0.1',port:0}),store=new Store(':memory:');
  t.after(async()=>{adapter.close();for(const socket of server.clients)socket.terminate();await new Promise<void>(resolve=>server.close(()=>resolve()));store.close();});
  await once(server,'listening');
  const address=`ws://127.0.0.1:${(server.address() as {port:number}).port}`,c=store.register(registration('claude','sender')),x=store.register(registration('codex','target'));store.pair(c.id,x.id);const endpoint={...store.endpoint(x.id)!,address};
  endpoint.configHome=home;mkdirSync(path.join(home,'sessions'));
  const file=path.join(home,'sessions','target.jsonl'),settings={permission_profile:{type:'disabled'},approval_policy:'on-request',approvals_reviewer:'user'},line=(type:string,payload:unknown)=>JSON.stringify({type,payload})+'\n';
  writeFileSync(file,line('session_meta',{id:'target'})+line('turn_context',settings),'utf8');
  let entered!:()=>void,release!:()=>void;const waiting=new Promise<void>(resolve=>{entered=resolve;}),outputs:any[]=[];
  server.on('connection',socket=>socket.on('message',raw=>{
    const request=JSON.parse(raw.toString());if(request.id===undefined)return;
    const respond=()=>{if(request.method==='thread/settings/update')appendFileSync(file,line('event_msg',{type:'thread_settings_applied',thread_id:'target',thread_settings:settings}),'utf8');socket.send(JSON.stringify({id:request.id,result:request.method==='initialize'?codexInitializeResult:request.method==='thread/loaded/list'?{data:[]}:request.method==='thread/resume'?{thread:{id:'target',path:file,cwd:home,status:{type:'idle'}},approvalPolicy:request.params.approvalPolicy,approvalsReviewer:request.params.approvalsReviewer}:request.method==='turn/start'?{turn:{id:'accepted'}}:{}}));};
    if(request.method==='turn/start')outputs.push(request.params);
    if(stage==='订阅前'&&request.method==='thread/resume'||stage==='提交后'&&request.method==='turn/start'&&outputs.length===1){release=respond;entered();return;}
    respond();
  }));
  const abort=new AbortController(),sending=adapter.wake(x,endpoint,abort.signal);
  await waiting;
  const rejected=assert.rejects(sending,error=>{assert.ok(error instanceof DeliveryError);assert.equal(error.uncertain,stage==='提交后');return true;});
  const task=stage==='订阅前'?adapter.wake(x,endpoint):undefined;
  abort.abort();await rejected;release();if(task)await task;
  assert.equal(outputs.length,1);assert.equal(outputs[0].toolOutput,undefined);assert.match(outputs[0].input[0].text,/pickup notice \(not user msg\)/);
});

test('proxy 原进程退出时关闭组合流，不等待仍被其他进程持有的标准流',async t=>{
  const input=new PassThrough(),output=new PassThrough(),child=Object.assign(new EventEmitter(),{stdin:input,stdout:output}) as unknown as ChildProcess,stream=proxySocket(child);
  stream.on('error',()=>{});t.after(()=>stream.destroy());
  assert.equal(output.destroyed,false);child.emit('exit',0,null);await new Promise<void>(resolve=>setImmediate(resolve));
  assert.equal(stream.destroyed,true);assert.equal((stream.errored as {code?:string})?.code,'proxy_closed');assert.equal(input.destroyed,true);assert.equal(output.destroyed,true);
});

test('proxy 组合流保留原生空闲超时、回调及取消语义，供 HTTP 握手使用',async t=>{
  const server=net.createServer(),peers=new Set<net.Socket>();server.on('connection',socket=>{peers.add(socket);socket.once('close',()=>peers.delete(socket));});
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));const output=net.createConnection((server.address() as net.AddressInfo).port,'127.0.0.1');await once(output,'connect');
  const child=Object.assign(new EventEmitter(),{stdin:new PassThrough(),stdout:output}) as unknown as ChildProcess,stream=proxySocket(child),callback=t.mock.fn();
  stream.on('error',()=>{});
  t.after(async()=>{stream.destroy();for(const peer of peers)peer.destroy();await new Promise<void>(resolve=>server.close(()=>resolve()));});
  stream.setTimeout(1,callback);stream.setTimeout(0,callback);await delay(20);assert.equal(callback.mock.callCount(),0);
  const timeout=once(stream,'timeout');assert.equal(stream.setTimeout(20,callback),stream);await timeout;stream.setTimeout(0);assert.equal(callback.mock.callCount(),1);
});

test('本地 App Server 不响应 HTTP 升级时沿用握手超时并回收连接', {timeout:30000}, async t=>{
  const temp=temporaryDirectory(),home=temp.directory,script=path.join(home,'stalled-proxy.mjs'),filename=path.join(home,'stalled.sock'),pidFile=path.join(home,'proxy.pid'),peers=new Set<net.Socket>();let server:net.Server|undefined,disconnected:Promise<unknown>|undefined;
  t.after(async()=>{try{if(server){for(const peer of peers)peer.destroy();await new Promise<void>(resolve=>server!.close(()=>resolve()));}}finally{await temp.cleanup();}});
  if(process.platform==='win32')writeFileSync(script,`import{writeFileSync}from'node:fs';writeFileSync(${JSON.stringify(pidFile)},String(process.pid));process.stdin.resume();setInterval(()=>{},1000);`,'utf8');
  else{
                                                   
    server=net.createServer(socket=>{peers.add(socket);disconnected=once(socket,'close');socket.once('close',()=>peers.delete(socket));socket.resume();});
    await new Promise<void>(resolve=>server!.listen(filename,resolve));
  }
  await assert.rejects(connectAppServer('unix://'+filename,{...DEFAULT_CONFIG,codexBinary:script,codexHome:home},undefined,home,{readOnly:true}),/Opening handshake has timed out/);
  if(process.platform==='win32'){
    const pid=Number(readFileSync(pidFile,'utf8')),deadline=Date.now()+10000;
    while(liveProcess(pid)&&Date.now()<deadline)await delay(25);
    assert.equal(liveProcess(pid),false,'握手超时后，生产回收应在夹具清理前结束自有 proxy');
  }else await disconnected;
});

test('Windows proxy 在初始化前退出时只拒绝连接，不终止协调器', {skip:process.platform!=='win32'}, async t=>{
  const home=temporary(t),script=path.join(home,'exited-proxy.mjs');
  writeFileSync(script,"process.exitCode=17;",'utf8');
  await assert.rejects(connectAppServer('unix://'+path.join(home,'absent.sock'),{...DEFAULT_CONFIG,codexBinary:script,codexHome:home},undefined,home),error=>{
                                                    
    assert.ok(['ERR_STREAM_PREMATURE_CLOSE','proxy_closed','ECONNRESET','EPIPE'].includes((error as {code:string}).code),String(error));return true;
  });
});

                                                       
                                    
test('Windows proxy 保留正常初始化、断线通知和关闭回收', {skip:process.platform!=='win32',timeout:90000}, async t=>{
  const temp=temporaryDirectory(),home=temp.directory,script=path.join(home,'proxy.mjs'),events=path.join(home,'proxy-events.jsonl'),server=new WebSocketServer({host:'127.0.0.1',port:0}),started=Date.now(),phases:{ms:number;phase:string}[]=[];
  const phase=(value:string)=>{phases.push({ms:Date.now()-started,phase:value});};
  t.signal.addEventListener('abort',()=>{if(phases.at(-1)?.phase==='清理完成')return;let proxyEvents:string;try{proxyEvents=readFileSync(events,'utf8');}catch(error){proxyEvents=String(error);}t.diagnostic(JSON.stringify({phases,proxyEvents}));},{once:true});
  t.after(async()=>{try{phase('关闭服务端');for(const socket of server.clients)socket.terminate();await new Promise<void>(resolve=>server.close(()=>resolve()));phase('服务端关闭完成');}finally{phase('清理夹具');await temp.cleanup();phase('清理完成');}});
  await once(server,'listening');
  const port=(server.address() as {port:number}).port;
  writeFileSync(script,`import net from'node:net';import{appendFileSync}from'node:fs';const log=event=>appendFileSync(${JSON.stringify(events)},JSON.stringify({pid:process.pid,event,at:Date.now()})+'\\n'),socket=net.createConnection(${port},'127.0.0.1');log('start');for(const event of['connect','end','close','error'])socket.on(event,()=>log('socket-'+event));process.stdin.on('end',()=>log('stdin-end'));process.stdout.on('finish',()=>log('stdout-finish'));process.on('exit',()=>log('exit'));process.stdin.pipe(socket);socket.pipe(process.stdout);socket.on('close',()=>process.exit(0));socket.on('error',()=>{process.exitCode=17;});`,'utf8');
  server.on('connection',socket=>socket.on('message',raw=>{const request=JSON.parse(raw.toString());if(request.id!==undefined)socket.send(JSON.stringify({id:request.id,result:request.method==='initialize'?codexInitializeResult:{accepted:true}}));}));
  const config={...DEFAULT_CONFIG,codexBinary:script,codexHome:home};
  phase('连接 RPC');const rpc=await connectAppServer('unix://fixture',config,undefined,home);phase('RPC 已连接');
  try{
    phase('读取 RPC');assert.deepEqual(await rpc.request('fixture/read',{}),{accepted:true});phase('RPC 读取完成');
    const disconnected=once(rpc,'disconnected');phase('终止服务端连接');for(const socket of server.clients)socket.terminate();await disconnected;phase('收到断线通知');
    assert.equal(rpc.closed,true);
  }finally{phase('关闭首个 RPC');rpc.close();}
  phase('重连 RPC');const replacement=await connectAppServer('unix://fixture',config,undefined,home);phase('重连完成');replacement.close();phase('关闭重连 RPC');
});

test('Windows 协调器恢复失效的 Unix 端点时保持可用和原配对', {skip:process.platform!=='win32'}, async t=>{
  if(!await requireIndependentWindows(t))return;
  const home=temporary(t),script=path.join(home,'exited-proxy.mjs');
  writeFileSync(script,"process.exitCode=17;",'utf8');
  writeFileSync(path.join(home,'config.json'),JSON.stringify({...DEFAULT_CONFIG,implicit:'never',codexBinary:script,codexHome:home}),'utf8');
  const store=new Store(path.join(home,'nxbridge.db'));
  const codex=store.register({host:'codex',sessionId:'stale-codex',cwd:home,kind:'root',endpoint:{mode:'app-server',epoch:'stale',address:'unix://absent.sock',pid:null,procStart:null}});
  const claude=store.register({host:'claude',sessionId:'stale-claude',cwd:home,kind:'root',endpoint:{mode:'claude-inbox',epoch:'fixture',address:'fixture',pid:null,procStart:null}});
  const pair=store.pair(claude.id,codex.id);store.close();
  const first=await brokerCall('ping',{}, {home});await delay(1500);
  const next=await brokerCall('ping',{}, {home,start:false});assert.equal(next.pid,first.pid);
  const status=await brokerCall('status',{}, {home,start:false});assert.equal(status.pair.id,pair.id);
});
