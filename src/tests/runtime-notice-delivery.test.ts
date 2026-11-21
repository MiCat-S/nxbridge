import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import path from 'node:path';
import { mkdirSync,writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { Store } from '../storage/store.js';
import { Broker, type Adapters } from '../broker/coordinator.js';
import {DEFAULT_CONFIG} from '../config/defaults.js';
import {ensureHome} from '../ipc/home.js';
import { processIdentity } from '../process/process.js';
import { peerKeyFile, deliverClaudeInbox } from '../hosts/claude/claude-inbox.js';
import { queueRuntimeNotice, RUNTIME_NOTICE_SUMMARY } from '../broker/health/runtime-notice-delivery.js';
import { claudeObservedPermission } from '../hosts/claude/claude-inbound.js';
import {DeliveryHealth} from '../broker/health/delivery.js';
import { brokerOutageNotice, brokerOutageState } from '../broker/broker-outage.js';
import { collectRuntimeNotices } from '../broker/health/runtime-monitor.js';
import { FakeAdapter } from './support/fake-adapter.js';
import { registration } from './support/registration.js';
import { temporaryDirectory } from './support/temporary.js';
import { listenBroker } from '../ipc/ipc.js';
import { StorageBusyError } from '../storage/storage-errors.js';

async function inboxFixture(t:TestContext){
  const temp=temporaryDirectory(),home=path.join(temp.directory,'bridge'),configHome=path.join(temp.directory,'claude');await ensureHome(home);mkdirSync(path.join(configHome,'sessions'),{recursive:true});
  const store=new Store(path.join(home,'nxbridge.db')),native=await processIdentity(process.pid),revision='0123456789abcdef';
  const address=process.platform==='win32'?'\\\\.\\pipe\\nxbridge-notice-'+randomUUID():path.join(temp.directory,'notice.sock'),payloads:any[]=[];
  const server=net.createServer(socket=>{let buffer='';socket.setEncoding('utf8');socket.on('error',()=>{});socket.on('data',chunk=>{buffer+=chunk;let at;while((at=buffer.indexOf('\n'))>=0){const row=JSON.parse(buffer.slice(0,at));buffer=buffer.slice(at+1);if(row.msgV)payloads.push(row);}});});
  const broker=new Broker(store,DEFAULT_CONFIG,{claude:new FakeAdapter(),codex:new FakeAdapter()} as unknown as Adapters,home);
  await new Promise<void>(resolve=>server.listen(address,resolve));t.after(async()=>{await broker.stop();await new Promise<void>(resolve=>server.close(()=>resolve()));store.close();await temp.cleanup();});
  const input=registration('claude','native-notice',{cwd:temp.directory,endpoint:{mode:'claude-inbox',address,epoch:'notice-endpoint',pid:native.pid,procStart:native.startedAt,configHome,modRevision:revision}});
  const c=store.register(input),x=store.register(registration('codex','partner'));
  store.saveEndpoint({...store.endpoint(c.id)!,modRevision:revision});const pair=store.pair(c.id,x.id),binding=store.bindings.current(c.id)!;
  writeFileSync(path.join(configHome,'sessions',native.pid+'.json'),JSON.stringify({sessionId:c.sessionId,cwd:temp.directory,procStart:native.startedAt}),'utf8');
  if(process.platform==='win32')writeFileSync(peerKeyFile(native.pid,address,configHome),JSON.stringify({peerToken:'a'.repeat(32),procStart:native.startedAt}),'utf8');
  const id=randomUUID(),identity={pid:native.pid,procStart:native.startedAt},lease={key:binding.key,epoch:binding.epoch};
  return{store,broker,input,c,pair,payloads,id,identity,lease,address,revision,home};
}

test('inbox 提交前 SQLite 繁忙保留类型和阶段，正文未写入；同步等待也受原投递截止约束',async t=>{
  const {store,c,pair,payloads}=await inboxFixture(t),sender=store.peer(pair.codex),endpoint=store.endpoint(c.id)!,message=store.accept(pair,sender,'不能重复发送的正文','busy-before-submit');
  await assert.rejects(deliverClaudeInbox(c,endpoint,{...message,beforeSubmit:async()=>{throw{code:'ERR_SQLITE_ERROR',errcode:5};}},sender,()=>endpoint.configHome!),error=>error instanceof StorageBusyError&&error.phase==='enqueue'&&!error.uncertain);
  assert.equal(payloads.length,0);
  await assert.rejects(deliverClaudeInbox(c,endpoint,{...message,beforeSubmit:async()=>{Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,3100);return true;}},sender,()=>endpoint.configHome!),{code:'inbox_timeout',uncertain:false});
  assert.equal(payloads.length,0);
});

test('Windows inbox 接受原生升级后的凭证格式，仍拒绝空凭证和错误代次',{skip:process.platform!=='win32'},async t=>{
  const {store,c,pair,payloads}=await inboxFixture(t),sender=store.peer(pair.codex),endpoint=store.endpoint(c.id)!,message=store.accept(pair,sender,'新版原生凭证','peer-token-upgrade');
  const file=peerKeyFile(endpoint.pid!,endpoint.address,endpoint.configHome!);
  writeFileSync(file,JSON.stringify({peerToken:'native-v2/token:longer-format',procStart:endpoint.procStart}),'utf8');
  await deliverClaudeInbox(c,endpoint,message,sender,()=>endpoint.configHome!);assert.equal(payloads.length,1);
  for(const patch of [{peerToken:'',procStart:endpoint.procStart},{peerToken:12,procStart:endpoint.procStart},{peerToken:'native-v2/token:longer-format',procStart:'other-generation'}]){
    writeFileSync(file,JSON.stringify(patch),'utf8');
    await assert.rejects(deliverClaudeInbox(c,endpoint,message,sender,()=>endpoint.configHome!),{code:'peer_key_mismatch'});
  }
  assert.equal(payloads.length,1);
});

test('broker 完全离线时 Mod 原生 inbox 仍能唤醒一次，消费时领取正文且不重排',async t=>{
  const {c,payloads,identity,lease,address,revision,home}=await inboxFixture(t),actor={host:'claude' as const,peerId:c.id,sessionId:c.sessionId!,...identity};
  const since=Date.now()-120001;for(const offset of [0,40000,80000])await brokerOutageNotice(home,actor,{now:since+offset,admit:false},async()=>['alive']);
  const signals=await collectRuntimeNotices(home,'claude',c.sessionId!,identity,undefined,undefined,revision,{admit:false,binding:lease});
  const signal=signals.find(notice=>notice.source==='broker_outage')!;assert.equal(signal.wake,true);
  assert.deepEqual(await queueRuntimeNotice(home,c.sessionId!,identity,lease,address,signal.id,revision),{queued:true});
  assert.ok('drop' in await queueRuntimeNotice(home,c.sessionId!,identity,lease,address,signal.id,revision));assert.equal(payloads.length,1);
  const prepared=await collectRuntimeNotices(home,'claude',c.sessionId!,identity,undefined,undefined,revision,{noticeId:signal.id,binding:lease});
  assert.equal(prepared[0]?.id,signal.id);assert.match(prepared[0]!.message,/doctor once.*bootstrap once/);assert.equal(brokerOutageState(home)?.claim?.state,'admitted');
  assert.equal((await collectRuntimeNotices(home,'claude',c.sessionId!,identity,undefined,undefined,revision,{noticeId:signal.id,binding:lease})).some(notice=>notice.source==='broker_outage'),false);
});

test('领取账本损坏不会丢弃正常协调器已经提供的通知',async t=>{
  const f=await inboxFixture(t),server=await listenBroker(f.home,(method,params)=>f.broker.dispatch(method,params));
  try{
    writeFileSync(path.join(f.home,'run','broker-outage.db'),'invalid sqlite','utf8');
    new DeliveryHealth(f.store).enqueue(f.pair.id,f.c.id,{id:f.id,message:'正常通知继续提供',state:'pending',kind:'explicit_recovery'});
    const notices=await collectRuntimeNotices(f.home,'claude',f.c.sessionId!,f.identity,undefined,undefined,f.revision,{binding:f.lease});
    assert.ok(notices.some(value=>value.id===f.id&&value.message==='正常通知继续提供'));
  }finally{await server.close();}
});

test('未知发送类别仍提交原生 inbox，连接后刷新证据且换上下文不借用旧类别',async t=>{
  const {store,c,pair,payloads}=await inboxFixture(t),sender=store.peer(pair.codex),endpoint=store.endpoint(c.id)!;
  const message=store.accept(pair,sender,'原生未知类别任务','unknown-class');store.updatePeer(sender.id,{permission:'unknown'});
  await deliverClaudeInbox(c,endpoint,message,{...sender,permission:'unknown'},()=>endpoint.configHome!);
  assert.equal(payloads.length,1);assert.doesNotMatch(payloads[0].message.content,/from-mode=/);
  await deliverClaudeInbox(c,endpoint,{...message,beforeSubmit:async()=>{store.updatePeer(sender.id,{permission:'prompting'});return true;},senderSnapshot:()=>store.peer(sender.id)},{...sender,permission:'unknown'},()=>endpoint.configHome!);
  assert.match(payloads[1].message.content,/from-mode="prompting"/);
  await deliverClaudeInbox(c,endpoint,{...message,senderSnapshot:()=>({...sender,sessionId:'changed',permission:'bypass'})},{...sender,permission:'unknown'},()=>endpoint.configHome!);
  assert.doesNotMatch(payloads[2].message.content,/from-mode=/);
});

test('原生通知显示简短说明，保留真实权限和会话围栏，不提前附入故障正文或准入',async t=>{
  const {store,c,pair,payloads,id,identity,lease,address,revision,home}=await inboxFixture(t);
  new DeliveryHealth(store).enqueue(pair.id,c.id,{id,message:'不得在排队时写入的故障正文',state:'pending',kind:'explicit_recovery'});
  for(const mode of ['default','acceptEdits','dontAsk','auto'])assert.equal(claudeObservedPermission(mode),'prompting');
  assert.equal(claudeObservedPermission('plan'),'bypass');
  assert.equal(claudeObservedPermission('bypassPermissions'),'bypass');assert.equal(claudeObservedPermission(),'unknown');assert.equal(claudeObservedPermission('future-mode'),'unknown');
  assert.deepEqual(await queueRuntimeNotice(home,c.sessionId!,identity,lease,address,id,revision,'prompting'),{queued:true});assert.equal(payloads.length,1);
  const payload=payloads[0];assert.match(payload.message.content,/system_notice source=runtime_monitor notice_id=/);assert.doesNotMatch(payload.message.content,/notice pickup|不得在排队时|from="/);assert.match(payload.message.content,/nxbridge runtime monitor.*from-mode="prompting"/);assert.equal(payload.from,undefined);
  assert.ok(payload.message.content.includes('\n'+RUNTIME_NOTICE_SUMMARY+'\n'),'原生界面必须有可见说明，不能只显示标题');
  for(const change of [{sessionId:'other'},{identity:{...identity,procStart:'wrong'}},{lease:{...lease,epoch:'stale'}},{address:address+'-other'},{revision:'fedcba9876543210'}]){
    await assert.rejects(queueRuntimeNotice(home,change.sessionId??c.sessionId!,change.identity??identity,change.lease??lease,change.address??address,id,change.revision??revision,'prompting'),{code:'session_changed'});
  }
  assert.deepEqual(await queueRuntimeNotice(home,c.sessionId!,identity,lease,address,id,revision,'unknown'),{queued:true});assert.doesNotMatch(payloads.at(-1).message.content,/from-mode=/);
  assert.equal(payloads.length,2);assert.equal(store.messages().length,0);assert.equal(store.setting('healthNoticeAdmission:'+c.id),undefined);
  assert.equal(new DeliveryHealth(store).get(pair.id,c.id,id)?.state,'pending');
});

test('重载后的空闲通知沿用同代次实际权限，明确未知或进程换代时不沿用',async t=>{
  const {store,broker,input,c,pair,payloads,id,identity,address,revision,home}=await inboxFixture(t);
  new DeliveryHealth(store).enqueue(pair.id,c.id,{id,message:'权限验收',state:'pending',kind:'explicit_recovery'});
  const enqueue=(permission?:'prompting'|'bypass'|'unknown')=>{const binding=store.bindings.current(c.id)!;return queueRuntimeNotice(home,c.sessionId!,identity,{key:binding.key,epoch:binding.epoch},address,id,revision,permission);};
                                
  assert.equal(store.peer(c.id).permission,'prompting');
  assert.deepEqual(await enqueue(),{queued:true});assert.doesNotMatch(payloads.at(-1).message.content,/from-mode=/);
  const observed={permission:'bypass' as const,observedAt:Date.now()};
  await broker.dispatch('register',{...input,permission:'bypass',endpoint:{...input.endpoint,nativePermission:observed,nativeInbound:{policy:'default',observedAt:Date.now()}}});
                                                    
  await broker.dispatch('register',{...input,permission:undefined,endpoint:{...input.endpoint,nativeInbound:{policy:'default',observedAt:Date.now()}}});
  assert.deepEqual(store.endpoint(c.id)!.nativePermission,observed);
  assert.equal(store.endpoint(c.id)!.nativeInbound?.permission,'bypass');
  assert.deepEqual(await enqueue(),{queued:true});assert.match(payloads.at(-1).message.content,/from-mode="bypass"/);
  assert.deepEqual(await enqueue('unknown'),{queued:true});assert.doesNotMatch(payloads.at(-1).message.content,/from-mode=/);
  await broker.dispatch('register',{...input,endpoint:{...input.endpoint,nativePermission:{permission:'unknown',observedAt:Date.now()}}});
  assert.deepEqual(await enqueue(),{queued:true});assert.doesNotMatch(payloads.at(-1).message.content,/from-mode=/);
  assert.equal(payloads.length,4);
                                                 
  store.adopt(c.id,{...input,endpoint:{...input.endpoint,procStart:'previous-generation',nativePermission:observed}});
  store.adopt(c.id,{...input,permission:undefined});
  assert.equal(store.endpoint(c.id)!.nativePermission,undefined);
  assert.equal(store.endpoint(c.id)!.nativeInbound,undefined);
  assert.deepEqual(await enqueue(),{queued:true});assert.doesNotMatch(payloads.at(-1).message.content,/from-mode=/);
  assert.equal(payloads.length,5);
});

test('升级前的端点权限观察只在同代次重载时保留，不从普通成员状态猜测',async t=>{
  const {store,broker,input,c,pair,payloads,id,identity,lease,address,revision,home}=await inboxFixture(t);
  new DeliveryHealth(store).enqueue(pair.id,c.id,{id,message:'权限验收',state:'pending',kind:'explicit_recovery'});
  store.saveEndpoint({...store.endpoint(c.id)!,nativeInbound:{policy:'default',permission:'prompting',observedAt:Date.now()}});
  store.updatePeer(c.id,{permission:'bypass'});
  await broker.dispatch('register',{...input,permission:undefined,endpoint:{...input.endpoint,nativeInbound:{policy:'default',observedAt:Date.now()}}});
  assert.deepEqual(await queueRuntimeNotice(home,c.sessionId!,identity,lease,address,id,revision),{queued:true});
  assert.match(payloads[0].message.content,/from-mode="prompting"/);
});

test('通知在连接前或实际写入前已撤销时不唤醒宿主，不登记准入或普通消息',async t=>{
  const f=await inboxFixture(t),health=new DeliveryHealth(f.store),enqueue=(id:string)=>queueRuntimeNotice(f.home,f.c.sessionId!,f.identity,f.lease,f.address,id,f.revision,'prompting');
  assert.deepEqual(await enqueue('missing'),{drop:'condition resolved before delivery'});
  for(const late of [false,true]){
    const id=randomUUID();health.enqueue(f.pair.id,f.c.id,{id,message:'已恢复故障',state:'pending',kind:'explicit_recovery'});
    if(!late)health.cancel(f.pair.id,f.c.id,id);
    const writing=enqueue(id);
    if(late)health.cancel(f.pair.id,f.c.id,id);
    assert.deepEqual(await writing,{drop:'condition resolved before delivery'});
  }
  assert.equal(f.payloads.length,0);assert.equal(f.store.messages().length,0);assert.equal(f.store.setting('healthNoticeAdmission:'+f.c.id),undefined);
});

test('原生队列拒绝信息类通知，正文保留给正常取件',async t=>{
  const f=await inboxFixture(t),health=new DeliveryHealth(f.store);health.enqueue(f.pair.id,f.c.id,{id:f.id,message:'仅供告知的事实',state:'pending',kind:'runtime'});
  assert.deepEqual(await queueRuntimeNotice(f.home,f.c.sessionId!,f.identity,f.lease,f.address,f.id,f.revision,'prompting'),{drop:'condition resolved before delivery'});
  assert.equal(f.payloads.length,0);assert.equal(health.get(f.pair.id,f.c.id,f.id)?.state,'pending');
});
