import test from 'node:test';
import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';
import type { PendingMessageFacts, Store } from '../storage/store.js';
import {DeliveryError} from '../shared/errors.js';
import {type Message} from '../types.js';
import {fixture, lifecycle} from './support/broker-fixture.js';
import { registration } from './support/registration.js';

const facts=(message:Message):PendingMessageFacts=>({id:message.id,pairId:message.pairId,to:message.to,attempts:message.attempts});
const database=(store:Store)=>(store as unknown as {db:DatabaseSync}).db;
const reachable=()=>({state:'reachable' as const,reasons:[],checked_at:Date.now()});

test('待投递元数据与完整队列保持相同筛选、顺序和首次编号，重新排队或消失后旧快照失效',t=>{
  const {store,c,x}=fixture(t),pair=store.pair(c.id,x.id);
  for(let i=0;i<6;i++)store.accept(pair,i%2?c:x,'中文🙂正文'+i,'queue-'+i);
  const otherC=store.register(registration('claude','other-c')),otherX=store.register(registration('codex','other-x')),other=store.pair(otherC.id,otherX.id);
  store.accept(other,otherC,'另一配对','other');
  const check=()=>{
    for(const id of [undefined,c.id,x.id,otherC.id,otherX.id]){
      assert.deepEqual(store.pendingFacts(id),store.pending(id).map(facts));
      if(id)assert.equal(store.firstPendingId(id),store.pending(id)[0]?.id);
    }
  };
  check();
  const snapshot=store.pendingFacts(c.id),first=snapshot[0]!,second=snapshot[1]!;
  assert.deepEqual(store.pendingMessage(first),store.message(first.id));
  store.claim(first.id);check();assert.equal(store.pendingMessage(first),undefined);
  store.transition(first.id,'accepted');check();assert.equal(store.pendingMessage(first),undefined,'同编号的新尝试不能沿用旧快照');
  assert.ok(store.pendingMessage(store.pendingFacts(c.id)[0]!));
  database(store).prepare('DELETE FROM messages WHERE id=?').run(second.id);
  assert.equal(store.pendingMessage(second),undefined);check();
  store.transition(snapshot[2]!.id,'held');check();
  const current=store.pendingFacts(c.id)[0]!;
  store.setPaused(true,pair.id);check();assert.equal(store.pendingMessage(current),undefined);
  store.setPaused(false,pair.id);check();
  store.unpair(pair.id);check();assert.deepEqual(store.pendingFacts(c.id),[]);
});

test('完整快照与元数据快照作出相同有序投递决定，保留中文、引用快照、回复和来源字段',async t=>{
  const run=async(legacy:boolean)=>{
    const {store,broker,c,x,claude}=fixture(t),pair=store.pair(c.id,x.id);
    if(legacy){const pending=store.pending.bind(store);t.mock.method(store,'pendingFacts',(id?:string)=>pending(id).map(facts));}
    const original=store.accept(pair,c,'原任务','original');store.transition(original.id,'contextObserved');
    broker.references.capture(x,'child','最初的中文🙂答案');
    const reply=broker.send({actor:{host:'codex',sessionId:'x',callId:'reply'},message:'回复 nxref:agent:child\n第二行',in_reply_to:original.id,reply_expected:true},false);
    broker.references.capture(x,'child','后续答案不能改写已接受快照');
    store.accept(pair,x,'字面 nxref:msg:missing🙂','literal',undefined,'/root/child');
    const bad=store.accept(pair,x,'nxref:agent:missing','bad');broker.references.snapshot(bad,'原快照');
    database(store).prepare('DELETE FROM settings WHERE key=?').run('ref:message:'+bad.id);
    store.accept(pair,x,'正常消息继续','last');
    await broker.pump();
    assert.equal(store.message(reply.message_id).state,'runtimeQueued');assert.equal(store.message(bad.id).state,'expired');assert.equal(store.message(bad.id).attempts,0);
    const messages=new Map(store.messagesFor(pair.id).map(message=>[message.id,message.callId]));
    return claude.delivered.map(message=>({callId:message.callId,body:message.body,via:message.via,inReplyTo:message.inReplyTo?messages.get(message.inReplyTo):null,replyExpected:message.replyExpected,state:store.message(message.id).state,attempts:store.message(message.id).attempts}));
  };
  const legacy=await run(true),metadata=await run(false);assert.deepEqual(metadata,legacy);
  assert.deepEqual(metadata.map(message=>message.callId),['x:reply','literal','last']);
  assert.equal(metadata[0]!.body,'回复 [nxref agent:child]\n最初的中文🙂答案\n[/nxref]\n第二行');
  assert.equal(metadata[0]!.inReplyTo,'original');assert.equal(metadata[0]!.replyExpected,true);assert.equal(metadata[1]!.via,'/root/child');
});

for(const gate of ['paused','needsHuman','retry','disabled','embedded','remote'] as const)test('跳过或仅唤醒的路径不读取队列正文：'+gate,async t=>{
  const {store,broker,c,x,codex,claude}=fixture(t),pair=store.pair(c.id,x.id),target=gate==='remote'?x:c,sender=gate==='remote'?c:x;
  const message=store.accept(pair,sender,'长中文🙂'.repeat(4096),'gated');
  if(gate==='paused'||gate==='needsHuman')store.updatePeer(target.id,{state:gate});
  if(gate==='retry')lifecycle(broker).delayRetry(target.id,60000);
  if(gate==='disabled')store.updatePeer(target.id,{enabled:false});
  if(gate==='embedded')store.saveEndpoint({...store.endpoint(target.id)!,mode:'embedded'});
  if(gate==='remote')store.saveEndpoint({...store.endpoint(target.id)!,address:'ws://example.invalid:4123'});
  const pending=t.mock.method(store,'pending',()=>{throw Error('不应物化完整队列正文');});
  const pendingMessage=t.mock.method(store,'pendingMessage',()=>{throw Error('不应读取跳过路径的单条正文');});
  const anchor=t.mock.method(store,'firstPendingId',store.firstPendingId.bind(store));
  await broker.pump();if(gate==='remote')await broker.pump();
  assert.equal(pending.mock.callCount(),0);assert.equal(pendingMessage.mock.callCount(),0);
  assert.equal(store.message(message.id).attempts,0);assert.equal(store.message(message.id).state,'accepted');assert.equal(claude.delivered.length,0);
  if(gate==='remote'){assert.equal(codex.woken.length,1);assert.equal(anchor.mock.callCount(),2);assert.equal((store.setting<any>('codexWake:'+x.id)).anchor,message.id);}
  else assert.equal(codex.woken.length,0);
  assert.deepEqual(store.faults.status().filter(stage=>stage.degraded),[]);
});

test('异步探测后只读取原快照中仍为同次 accepted 的消息，消失、已读和新消息各自保留状态',async t=>{
  const {store,broker,c,x,claude}=fixture(t),pair=store.pair(c.id,x.id);
  const requeued=store.accept(pair,x,'重新排队','requeued'),vanished=store.accept(pair,x,'已消失','vanished'),observed=store.accept(pair,x,'已收到','observed'),good=store.accept(pair,x,'原队列正常消息','good');
  t.mock.method((broker as any).runtimeHealth,'deliveryAvailability',async()=>reachable());
  let late:Message|undefined,changed=false;
  t.mock.method(claude,'probe',async()=>{
    if(!changed){changed=true;store.claim(requeued.id);store.transition(requeued.id,'accepted');database(store).prepare('DELETE FROM messages WHERE id=?').run(vanished.id);store.transition(observed.id,'contextObserved');late=store.accept(pair,x,'探测期间新接受','late');await Promise.resolve();}
    return reachable();
  });
  const loaded=t.mock.method(store,'pendingMessage',store.pendingMessage.bind(store));
  await broker.pump();
  assert.deepEqual(claude.delivered.map(message=>message.id),[good.id]);assert.equal(store.message(requeued.id).attempts,1);assert.equal(store.message(requeued.id).state,'accepted');
  assert.equal(store.message(observed.id).state,'contextObserved');assert.equal(store.message(late!.id).attempts,0);
  assert.equal(loaded.mock.calls.filter(call=>call.result!==undefined).length,1);
  await broker.pump();assert.deepEqual(claude.delivered.map(message=>message.id),[good.id,requeued.id,late!.id]);
  assert.deepEqual(store.faults.status().filter(stage=>stage.degraded),[]);
});

for(const race of ['paused','disabled','session','transition','pairPaused','unpaired','restarting'] as const)test('异步探测期间资格改变后仍在正文读取前阻止投递：'+race,async t=>{
  const {store,broker,c,x,claude}=fixture(t),pair=store.pair(c.id,x.id),message=store.accept(pair,x,'不能投递','race');
  let releaseRestart:(()=>void)|undefined;
  t.mock.method((broker as any).runtimeHealth,'deliveryAvailability',async()=>reachable());
  t.mock.method(claude,'probe',async()=>{
    if(race==='paused')store.updatePeer(c.id,{state:'paused'});
    if(race==='disabled')store.updatePeer(c.id,{enabled:false});
    if(race==='session')store.updatePeer(c.id,{sessionId:'changed'});
    if(race==='transition'){const binding=store.bindings.activate({host:'claude',configHome:c.cwd,pid:process.pid,procStart:'test'},c.id,c.sessionId!,'test');store.bindings.save({...binding,transitioning:true});}
    if(race==='pairPaused')store.setPaused(true,pair.id);
    if(race==='unpaired')store.unpair(pair.id);
    if(race==='restarting')releaseRestart=lifecycle(broker).beginRestart(c.id);
    await Promise.resolve();return reachable();
  });
  const loaded=t.mock.method(store,'pendingMessage',store.pendingMessage.bind(store));
  try{await broker.pump();}finally{releaseRestart?.();}
  assert.equal(loaded.mock.callCount(),0);assert.equal(claude.delivered.length,0);assert.equal(store.message(message.id).attempts,0);
  assert.deepEqual(store.faults.status().filter(stage=>stage.degraded),[]);
});

test('提交边界仍撤销异步期间失效的发送资格，保留原编号且不误记成功',async t=>{
  const {store,broker,c,x,claude}=fixture(t),pair=store.pair(c.id,x.id),message=store.accept(pair,x,'提交前撤销','before-submit');
  t.mock.method(claude,'deliver',async(...args:Parameters<typeof claude.deliver>)=>{
    const delivery=args[2];
    store.updatePeer(x.id,{enabled:false});await Promise.resolve();
    assert.equal(await delivery.beforeSubmit?.(),false);return{state:'expired' as const,evidence:'提交前资格已撤销'};
  });
  await broker.pump();assert.equal(store.message(message.id).state,'accepted');assert.equal(store.message(message.id).attempts,1);assert.equal(store.setting('functionalDelivery:'+c.id),undefined);
});

test('投递失败仍归因于有序初始快照，新接受消息不加入旧失败事件',async t=>{
  const {store,broker,c,x,claude}=fixture(t),pair=store.pair(c.id,x.id),first=store.accept(pair,x,'第一条','first'),second=store.accept(pair,x,'第二条','second');
  t.mock.method((broker as any).runtimeHealth,'deliveryAvailability',async()=>reachable());let late:Message|undefined;
  t.mock.method(claude,'probe',async()=>{late=store.accept(pair,x,'稍后接受','late');await Promise.resolve();return reachable();});
  claude.fail=new DeliveryError('disconnected','模拟提交前连接中断',false);
  await broker.pump();
  assert.deepEqual(broker.incidents.current(store.peer(c.id),store.endpoint(c.id))?.affectedMessageIds,[first.id,second.id]);
  assert.equal(store.message(first.id).state,'accepted');assert.equal(store.message(first.id).attempts,1);assert.equal(store.message(second.id).attempts,0);assert.equal(store.message(late!.id).attempts,0);
});
