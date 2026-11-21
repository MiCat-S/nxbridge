import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import { temporaryDirectory } from './support/temporary.js';
import { FakeAdapter } from './support/fake-adapter.js';
import { registration } from './support/registration.js';
import {ensureHome} from '../ipc/home.js';
import {PACKAGE_ROOT} from '../shared/package-location.js';
import { windowKey } from '../integration/hooks/session-bindings.js';
import { openModReadReceipt, bindModReadReceipt } from '../integration/mod/mod-read-receipt.js';
import { ModReadServer, type ModReadTransport } from '../integration/mod/mod-read-server.js';
import { acknowledgeRuntimeNotice } from '../broker/health/runtime-monitor.js';
import { Store } from '../storage/store.js';
import { Broker, type Adapters } from '../broker/coordinator.js';
import {DEFAULT_CONFIG} from '../config/defaults.js';
import {type Actor} from '../types.js';
import { ForegroundHealth } from '../broker/health/foreground-health.js';

async function window(home:string,configHome:string,pid:number){
  mkdirSync(path.join(configHome,'sessions'),{recursive:true});
  const record={sessionId:'same-conversation',cwd:configHome,procStart:'generation-'+pid};
  writeFileSync(path.join(configHome,'sessions',pid+'.json'),JSON.stringify(record),'utf8');
  const credential=await openModReadReceipt(home,configHome,{pid,record,native:{pid,parentPid:1,name:'claude',startedAt:record.procStart,procStart:record.procStart}});
  const actor:Actor={host:'claude',sessionId:record.sessionId,callId:randomUUID(),binding:{key:windowKey({host:'claude',configHome,pid,procStart:record.procStart}),epoch:'binding-'+pid}};
  return{credential,actor,record,receipt:bindModReadReceipt(home,credential,record.sessionId,actor.binding)};
}
function request(transport:ModReadTransport,operation:'status'|'monitor',change:Record<string,unknown>={}){
  return{body:JSON.stringify({operation,...change}),headers:{'Content-Type':'application/json','X-Nxbridge-Id':transport.id,Authorization:'Bearer '+transport.secret}};
}
const send=(transport:ModReadTransport,input:ReturnType<typeof request>)=>fetch(transport.url,{method:'POST',...input});

test('Mod 等待读取凭据时切换对话会取消旧发送，长正文证据通过现有发送进程的标准输入传递',async()=>{
  const native=await import(pathToFileURL(path.join(PACKAGE_ROOT,'plugins/claude/hooks/mod-control.js')).href);native.setModVersion(undefined);
  let sessionId='before',entered!:()=>void,release!:()=>void;
  const started=new Promise<void>(resolve=>entered=resolve),gate=new Promise<void>(resolve=>release=resolve),calls:{operation:string;args:string[];options:any;input:any}[]=[];
  const sdk={session:{id:async()=>sessionId,cwd:async()=>'/project'},env:{get:async(key:string)=>key==='CLAUDE_CODE_MESSAGING_SOCKET'?'/inbox':undefined},plugin:{root:'/plugin'},
    http:{fetch:async()=>{}},clock:{now:async()=>Date.now(),sleep:async()=>{}},process:{run:async(args:string[],options:any)=>{
      const input=JSON.parse(options?.stdin??args.at(-1)!);calls.push({operation:input.operation,args,options,input});
      if(input.operation==='control-open'){entered();await gate;}
      return{exitCode:0,stdout:JSON.stringify(input.operation==='control-open'?{credential:{id:'a'.repeat(64),secret:'b'.repeat(64)}}:{message_id:'saved'})};
    }}};
  const payload={message:'回复'.repeat(20000),auto_reply_to:'source',auto_reply_text:'追加正文'.repeat(20000)};
  const pending=native.call(sdk,'send',payload);await started;sessionId='after';release();
  await assert.rejects(pending,{code:'session_changed',uncertain:false});assert.deepEqual(calls.map(c=>c.operation),['control-open']);
  assert.deepEqual(await native.call(sdk,'send',payload),{message_id:'saved'});
  const sent=calls.find(c=>c.operation==='send')!;assert.equal(sent.args.at(-1),'-');assert.equal(sent.options.timeoutMs,135000);
  assert.deepEqual({message:sent.input.message,auto_reply_to:sent.input.auto_reply_to,auto_reply_text:sent.input.auto_reply_text},payload);
  assert.equal(sent.input.sessionId,'after');assert.equal(calls.filter(c=>c.operation==='send').length,1);
});

test('去重与事务合并保持同序列状态和通知等价，每次响应前保存精确进展，重启不变',async t=>{
  t.mock.timers.enable({apis:['Date'],now:2000000});
  const start=Date.now();
  const exercise=async(legacy:boolean)=>{
    t.mock.timers.setTime(start);
    const temp=temporaryDirectory(),home=path.join(temp.directory,'bridge'),configHome=path.join(temp.directory,'claude');await ensureHome(home);
    const file=path.join(home,'equivalence.sqlite'),store=new Store(file),broker=new Broker(store,DEFAULT_CONFIG,{codex:new FakeAdapter(),claude:new FakeAdapter()} as unknown as Adapters,home);
    let stopped=false;
    try{
      const a=await window(home,configHome,104),c=store.register(registration('claude',a.record.sessionId,{cwd:configHome,endpoint:{mode:'claude-inbox',address:'isolated',epoch:'native',pid:104,procStart:a.record.procStart,configHome,questionSupport:true}})),x=store.register(registration('codex','partner',{cwd:configHome}));store.pair(c.id,x.id);
      const binding=store.bindings.current(c.id)!,actor={...a.actor,binding:{key:binding.key,epoch:binding.epoch}},transport=await broker.dispatch('mod.read.open',{actor,credential:a.credential}) as ModReadTransport;
      if(legacy){
                                             
        const current=(broker.pairAnomalies as any).currentEvidence.bind(broker.pairAnomalies),integration=broker.pairAnomalies.integration.bind(broker.pairAnomalies);
        broker.pairAnomalies.evidence=peer=>{const value=current(peer);store.setSetting('integration:'+peer.id,value);return value;};
        broker.pairAnomalies.integration=(peer,input)=>{broker.pairAnomalies.evidence(peer);integration(peer,input);};
        store.transaction=fn=>fn();
      }
      const outputs:unknown[]=[],snapshots:unknown[]=[];
      for(const state of ['running','waitingTool','needsHuman','running','ready','failed'] as const){
        t.mock.timers.tick(1000);const now=Date.now(),nativeHealth={turnId:state==='failed'?'second':'first',state,lastProgressAt:now,lastEventAt:now,observedProgressAt:now,tools:state==='waitingTool'||state==='needsHuman'?['tool']:[],...(state==='ready'?{completion:'completed'}:{}),...(state==='failed'?{completion:'failed',error:'原生诊断'}:{})};
        const status=await (await send(transport,request(transport,'status',{nativeHealth}))).json() as any;
        if(status.partner?.hosting)status.partner.hosting={...status.partner.hosting,pair_id:'pair',member_id:'partner',cwd:'project'};
        outputs.push({...status,self:{...status.self,id:'self'}});
        outputs.push(await (await send(transport,request(transport,'monitor',{nativeHealth}))).json());
        assert.deepEqual(store.endpoint(c.id)?.nativeHealth,{...nativeHealth,source:'native-mod'},'HTTP 返回前原值已经落盘');
        snapshots.push(store.endpoint(c.id)?.nativeHealth);
      }
      const before=new ForegroundHealth(store).get(store.peer(c.id));
      await broker.stop();store.close();stopped=true;
      const reopened=new Store(file);
      try{assert.deepEqual(new ForegroundHealth(reopened).get(reopened.peer(c.id)),before);snapshots.push(reopened.endpoint(c.id)?.nativeHealth);}
      finally{reopened.close();}
      return{outputs,snapshots};
    }finally{if(!stopped){await broker.stop();store.close();}await temp.cleanup();}
  };
  assert.deepEqual(await exercise(false),await exercise(true));
});

test('Mod HTTP 能力隔离窗口与上下文，只接受本机 bearer 读取信号，浏览器与业务操作均被拒绝',async t=>{
  const temp=temporaryDirectory(),home=path.join(temp.directory,'bridge'),configHome=path.join(temp.directory,'claude');await ensureHome(home);
  const calls:string[]=[],server=new ModReadServer(home,async(actor,operation)=>{calls.push(operation);return{sessionId:actor.sessionId,operation,notices:[]};});
  const anotherBroker=new ModReadServer(home,async()=>({}));
  t.after(async()=>{await server.close();await anotherBroker.close();await temp.cleanup();});
  const a=await window(home,configHome,101),b=await window(home,configHome,102);
  const first=await server.open(a.receipt,a.actor,'endpoint-101'),second=await server.open(b.receipt,b.actor,'endpoint-102');
  const otherEpoch=await anotherBroker.open(a.receipt,a.actor,'endpoint-101');
  assert.equal((await send(otherEpoch,request({...otherEpoch,secret:first.secret},'status'))).status,401,'另一 broker 代次不能复用旧 bearer');
  assert.equal(first.url,second.url);assert.notEqual(first.secret,second.secret);
  const input=request(first,'status'),response=await send(first,input);assert.equal(response.status,200);
  assert.deepEqual(await response.json(),{sessionId:a.actor.sessionId,operation:'status',notices:[]});
  assert.equal((await send(second,request(second,'monitor'))).status,200);
  assert.equal((await send(first,input)).status,200,'信号读取可以重复，不消费通知');
  const forged=request(first,'status');forged.headers.Authorization='Bearer '+'0'.repeat(64);
  const denied=await send(first,forged);assert.equal(denied.status,401);assert.deepEqual(await denied.json(),{error:'mod_read_unavailable'});
  for(const change of [{operation:'send'},{sessionId:'another-window'}])assert.equal((await send(first,request(first,'status',change))).status,401);
  for(const change of [{headers:{...input.headers,Origin:'http://localhost'}},{headers:{...input.headers,Authorization:''}},{headers:{...input.headers,'Content-Type':'text/plain'}},{method:'OPTIONS'}]){
    const browser=await fetch(first.url,{method:'POST',...input,...change});assert.equal(browser.status,401);assert.equal(browser.headers.has('access-control-allow-origin'),false);
  }
  const replacement=await server.open(a.receipt,a.actor,'endpoint-101');
  assert.equal((await send(first,request(first,'status'))).status,401);
  assert.equal((await send(second,request(second,'monitor'))).status,200);
  writeFileSync(path.join(configHome,'sessions','101.json'),JSON.stringify({...a.record,sessionId:'rotated'}),'utf8');
  assert.equal((await send(replacement,request(replacement,'status'))).status,200,'已签发信号读取不重读会话文件');
  assert.throws(()=>bindModReadReceipt(home,a.credential,a.actor.sessionId,a.actor.binding),{code:'mod_read_unavailable'});
  server.revoke(a.actor.binding);assert.equal((await send(replacement,request(replacement,'status'))).status,401);
  assert.deepEqual(calls,['status','monitor','status','monitor','status']);
});

test('Mod 原生读取保留慢请求槽位、独立回退及迟到上下文围栏',async t=>{
  const temp=temporaryDirectory(),home=path.join(temp.directory,'bridge'),configHome=path.join(temp.directory,'claude');await ensureHome(home);
  let release!:()=>void,entered!:()=>void,current=true;
  const started=new Promise<void>(resolve=>entered=resolve),pending=new Promise<void>(resolve=>release=resolve);
  const server=new ModReadServer(home,async(_actor,operation)=>{if(operation==='status'){entered();await pending;}return{operation,notices:[]};});
  t.after(async()=>{release();await server.close();await temp.cleanup();});
  const a=await window(home,configHome,103),transport=await server.open(a.receipt,a.actor,'endpoint-103'),context={sessionId:a.actor.sessionId,binding:a.actor.binding};
  const native=await import(pathToFileURL(path.join(PACKAGE_ROOT,'plugins/claude/hooks/mod-read.js')).href);
  let starts=0;
  const sdk={env:{get:async()=>undefined},clock:{now:async()=>Date.now(),sleep:(ms:number,options:{signal:AbortSignal})=>sleep(ms,undefined,options)},http:{fetch:async(url:string,options:RequestInit)=>{starts++;const result=await fetch(url,options);return{status:result.status,headers:Object.fromEntries(result.headers),text:await result.text()};}}};
  await native.prepareRead(sdk,context,async()=>({credential:a.credential}));native.attachRead(context,transport);
  const slow=native.smallRead(sdk,context,'status',async()=>current);await started;
  assert.deepEqual(await native.smallRead(sdk,context,'status',async()=>current),{handled:true});assert.equal(starts,1);
  assert.equal((await native.smallRead(sdk,context,'monitor',async()=>current)).value.operation,'monitor');assert.equal(starts,2);
  current=false;release();assert.deepEqual(await slow,{handled:false});
  assert.equal((await native.smallRead(sdk,context,'status',async()=>current)).handled,false);assert.equal(starts,2);
});

test('Mod 快速读取挂起超过 5 秒时放弃通道改走进程路径，协调器不应答也不会一直读不到监测',async t=>{
  let expire!:()=>void,release!:(value:unknown)=>void;const stalled=new Promise<unknown>(resolve=>release=resolve);
  t.after(()=>release({status:200,text:'{"notices":[]}'}));
  const context={sessionId:'stalled',binding:{key:'window',epoch:'epoch'}},transport={url:'http://127.0.0.1:1/mod-read',id:'a'.repeat(64),secret:'b'.repeat(64),bindingEpoch:'epoch'};
  const native=await import(pathToFileURL(path.join(PACKAGE_ROOT,'plugins/claude/hooks/mod-read.js')).href);
  let now=Date.now(),starts=0;
  const sdk={env:{get:async()=>undefined},clock:{now:async()=>now,sleep:async()=>new Promise<void>(resolve=>expire=resolve)},http:{fetch:async()=>{starts++;return stalled;}}};
  await native.prepareRead(sdk,context,async()=>({credential:{id:'c'.repeat(64),secret:'d'.repeat(64)}}));native.attachRead(context,transport);
  const first=native.smallRead(sdk,context,'monitor',async()=>true);while(!expire)await sleep(0);
  now+=4000;assert.deepEqual(await native.smallRead(sdk,context,'monitor',async()=>true),{handled:true});
  now+=2000;expire();assert.deepEqual(await first,{handled:false});
  assert.deepEqual(await native.smallRead(sdk,context,'monitor',async()=>true),{handled:false});assert.equal(starts,1);
});

test('Mod 健康 HTTP 超过原 350ms 预算仍直接返回结果，不并发启动回退进程',async()=>{
  const native=await import(pathToFileURL(path.join(PACKAGE_ROOT,'plugins/claude/hooks/mod-read.js')).href),context={sessionId:'slow',binding:{key:'window',epoch:'epoch'}};
  const transport={url:'http://127.0.0.1:1/mod-read',id:'a'.repeat(64),secret:'b'.repeat(64),bindingEpoch:'epoch'};
  const sdk={env:{get:async()=>undefined},clock:{now:async()=>Date.now(),sleep:(ms:number,options:{signal:AbortSignal})=>sleep(ms,undefined,options)},http:{fetch:async()=>{await sleep(400);return{status:200,text:'{"paired":true}'};}}};
  await native.prepareRead(sdk,context,async()=>({credential:{id:'c'.repeat(64),secret:'d'.repeat(64)}}));native.attachRead(context,transport);
  assert.deepEqual(await native.smallRead(sdk,context,'status',async()=>true),{handled:true,value:{paired:true}});
});

test('Mod 只读投影不读取正文，绑定、端点及加载版本变化撤销能力',async t=>{
  const temp=temporaryDirectory(),home=path.join(temp.directory,'bridge'),configHome=path.join(temp.directory,'claude');await ensureHome(home);
  const store=new Store(path.join(home,'nxbridge.db')),codex=new FakeAdapter(),claude=new FakeAdapter(),broker=new Broker(store,DEFAULT_CONFIG,{codex,claude} as unknown as Adapters,home);
  t.after(async()=>{await broker.stop();store.close();await temp.cleanup();});
  const a=await window(home,configHome,104);
  const c=store.register(registration('claude',a.record.sessionId,{cwd:configHome,endpoint:{mode:'claude-inbox',address:'isolated-inbox',epoch:'endpoint-104',pid:104,procStart:a.record.procStart,configHome,questionSupport:true}}));
  const x=store.register(registration('codex','other',{cwd:configHome})),pair=store.pair(c.id,x.id),binding=store.bindings.current(c.id)!;
  const actor={...a.actor,binding:{key:binding.key,epoch:binding.epoch}};
  store.accept(pair,x,'私有正文不得进入快通道','private-body');
  broker.deliveryHealth.enqueue(pair.id,c.id,{id:'pending-read',message:'通知正文只在最终准备时生成',state:'pending'});
  const transport=await broker.dispatch('mod.read.open',{actor,credential:a.credential}) as ModReadTransport;
  for(const method of ['messages','messagesFor','pending'] as const)t.mock.method(store,method,()=>{throw Error('快通道不得物化消息正文');});
  const questionRead=t.mock.method(store,'questions',()=>{throw Error('状态投影不得物化问答');});
  const nativeHealth={turnId:'native-turn',lastProgressAt:Date.now()-1000,lastEventAt:Date.now()-1000,state:'running',tools:[]};
  const response=await send(transport,request(transport,'status',{nativeHealth}));assert.equal(response.status,200);
  assert.equal(store.endpoint(c.id)?.nativeHealth?.turnId,'native-turn');assert.equal(store.endpoint(c.id)?.nativeHealth?.source,'native-mod');
  const value=await response.json() as any;assert.equal(value.paired,true);assert.equal(value.self.id,c.id);assert.equal(value.pending,undefined);assert.equal(JSON.stringify(value).includes('私有正文'),false);
  questionRead.mock.restore();
  const monitor=await send(transport,request(transport,'monitor'));assert.equal(monitor.status,200);
  assert.deepEqual(await monitor.json(),{notices:[{id:'pending-read',tier:3,wake:false}]});
  assert.equal(broker.deliveryHealth.get(pair.id,c.id,'pending-read')?.state,'pending','HTTP 响应丢失不能令原有回退路径丢失通知信号');
  assert.deepEqual(await (await send(transport,request(transport,'monitor'))).json(),{notices:[{id:'pending-read',tier:3,wake:false}]});
  assert.equal(store.endpoint(c.id)?.nativeHealth?.lastProgressAt,nativeHealth.lastProgressAt,'只读时钟和心跳不能重置原生进展');
  const official=path.join(configHome,'sessions','104.json');
  writeFileSync(official,JSON.stringify({...a.record,sessionId:'same-pid-new-session'}),'utf8');
  await assert.rejects(broker.dispatch('health.monitor',{actor,notice_id:'pending-read',admit:true}),{code:'session_changed'});
  assert.equal(broker.deliveryHealth.get(pair.id,c.id,'pending-read')?.admitted,undefined,'同 PID 切换会话后，旧 actor 的下一次领取必须重新核验官方记录');
  await assert.rejects(acknowledgeRuntimeNotice(home,'claude',a.actor.sessionId,{pid:104,procStart:a.record.procStart},'pending-read','submitted'),{code:'session_changed'});
  assert.equal(broker.deliveryHealth.get(pair.id,c.id,'pending-read')?.state,'pending','旧会话的迟到确认不能消费当前窗口的通知');
  writeFileSync(official,JSON.stringify(a.record),'utf8');
  const endpoint=store.endpoint(c.id)!;store.deactivate(c.id,endpoint.epoch);store.saveEndpoint({...endpoint,epoch:'replacement-endpoint'});
  assert.equal((await send(transport,request(transport,'status'))).status,401);
  const next=await broker.dispatch('mod.read.open',{actor,credential:a.credential}) as ModReadTransport;
  store.saveEndpoint({...store.endpoint(c.id)!,modRevision:'1234567890abcdef'});
  assert.equal((await send(next,request(next,'monitor'))).status,401);
});

test('Mod 缺失原生接口或收到无效响应时回退，不改写业务上下文',async()=>{
  const native=await import(pathToFileURL(path.join(PACKAGE_ROOT,'plugins/claude/hooks/mod-read.js')).href);
  for(const kind of ['missing-http','missing-clock','invalid-response']){
    const context={sessionId:'original',binding:{key:'window',epoch:'epoch'}};
    const transport={url:'http://127.0.0.1:1/mod-read',id:'a'.repeat(64),secret:'b'.repeat(64),bindingEpoch:'epoch'};
    const sdk={env:{get:async()=>undefined},clock:{now:async()=>Date.now(),...(kind==='missing-clock'?{}:{sleep:(ms:number,options:{signal:AbortSignal})=>sleep(ms,undefined,options)})},
      ...(kind==='missing-http'?{}:{http:{fetch:async()=>({status:200,text:'invalid-json'})}})};
    await native.prepareRead(sdk,context,async()=>({credential:{id:'c'.repeat(64),secret:'d'.repeat(64)}}));native.attachRead(context,transport);
    assert.deepEqual(await native.smallRead(sdk,context,'status',async()=>true),{handled:false},kind);
    assert.deepEqual(context,{sessionId:'original',binding:{key:'window',epoch:'epoch'}});
  }
});

test('Mod 响应按 UTF-8 字节限额，边界可读且超限后安静回退',async()=>{
  const native=await import(pathToFileURL(path.join(PACKAGE_ROOT,'plugins/claude/hooks/mod-read.js')).href);
  const limit=32*1024,overhead=Buffer.byteLength(JSON.stringify({text:''})),budget=limit-overhead;
  const boundary='中'.repeat(Math.floor(budget/3))+'x'.repeat(budget%3);
  for(const [value,accepted]of [[boundary,true],['x'.repeat(budget+1),false],[boundary+'中',false]] as const){
    const text=JSON.stringify({text:value}),context={sessionId:'original',binding:{key:'window',epoch:'epoch'}};
    const transport={url:'http://127.0.0.1:1/mod-read',id:'a'.repeat(64),secret:'b'.repeat(64),bindingEpoch:'epoch'};
    let requests=0,validated=0;
    const sdk={env:{get:async()=>undefined},clock:{now:async()=>Date.now(),sleep:(ms:number,options:{signal:AbortSignal})=>sleep(ms,undefined,options)},http:{fetch:async(_url:string,options:RequestInit)=>{
      requests++;assert.equal((options.headers as Record<string,string>).Authorization,'Bearer '+transport.secret);
      return{status:200,text};
    }}};
    await native.prepareRead(sdk,context,async()=>({credential:{id:'c'.repeat(64),secret:'d'.repeat(64)}}));native.attachRead(context,transport);
    const result=await native.smallRead(sdk,context,'status',async()=>{validated++;return true;});
    assert.equal(result.handled,accepted);assert.equal(validated,accepted?1:0);
    if(accepted)assert.equal(result.value.text,value);
    else{assert.deepEqual(result,{handled:false});assert.deepEqual(await native.smallRead(sdk,context,'status',async()=>true),{handled:false});}
    assert.equal(requests,1);assert.deepEqual(context,{sessionId:'original',binding:{key:'window',epoch:'epoch'}});
  }
});
