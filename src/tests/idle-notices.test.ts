import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './support/broker-fixture.js';
import { registration } from './support/registration.js';
import { temporaryDirectory } from './support/temporary.js';
import { Store } from '../storage/store.js';
import { IdleNotices } from '../broker/health/idle-notices.js';
import {DeliveryHealth} from '../broker/health/delivery.js';
import path from 'node:path';
import type { Message, Pair, Peer } from '../types.js';
import { encodePeerMessage } from '../hosts/claude/claude-inbox.js';

async function ordinaryInput(f:ReturnType<typeof fixture>,peer:Peer):Promise<void>{
  if(peer.host==='claude')await f.broker.dispatch('peer.prompt',{actor:{host:'claude',sessionId:peer.sessionId,callId:'ordinary-input'}});
  else f.codex.emit('native',{address:f.store.endpoint(peer.id)!.address,message:{method:'item/started',params:{threadId:peer.sessionId,turnId:'ordinary-turn',item:{type:'userMessage',id:'ordinary-input',content:[{type:'text',text:'继续当前任务'}]}}}});
}

                                                                              
                                                           
const IDLE=300001;
function ask(f:ReturnType<typeof fixture>,pair:Pair,sender:Peer,body:string,callId:string,expected=true,inReplyTo?:string):Message{
  const message=f.store.accept(pair,sender,body,callId,inReplyTo,undefined,'explicit',expected);f.store.transition(message.id,'contextObserved','原生上下文证据');return message;
}

test('只有明确要求回复的消息在对方空闲满 5 分钟后提醒一次：第 3 档被动、不唤醒；汇报和通知不提醒；观察器重建不重置',async t=>{
  t.mock.timers.enable({apis:['Date'],now:1000000});
  for(const host of ['codex','claude'] as const){
    const f=fixture(t),pair=f.store.pair(f.c.id,f.x.id),partner=host==='codex'?f.x:f.c,delegator=host==='codex'?f.c:f.x,health=f.broker.deliveryHealth;
    f.store.updatePeer(delegator.id,{state:'busy'});
    ask(f,pair,partner,'工作已完成','report',false);const fyi=ask(f,pair,delegator,'进度通知，不需要回复','fyi',false);
    t.mock.timers.tick(IDLE);f.broker.idleNotices.observe(pair,f.store.peer(partner.id),2);
    assert.equal(health.hasPending(pair.id,delegator.id),false,'汇报、通知不产生回复义务');
    const task=ask(f,pair,delegator,'请检查并回复结论','task');
    t.mock.timers.tick(120001);f.broker.idleNotices.observe(pair,f.store.peer(partner.id),2);
    assert.equal(health.hasPending(pair.id,delegator.id),false,'配置 2 分钟也至少等满 5 分钟');
    t.mock.timers.tick(180000);f.broker.idleNotices.observe(pair,f.store.peer(partner.id),2);
    const pending=health.peek(pair.id,delegator.id)[0]!;assert.ok(pending);const notice=health.get(pair.id,delegator.id,pending.id)!;
    assert.equal(notice.tier,3);assert.equal(notice.wake,false);assert.equal(notice.source,'idle_unanswered');assert.deepEqual(notice.affectedMessageIds,[task.id]);
    assert.match(notice.message,/Expected reply still pending/);assert.ok(notice.message.includes(task.id));assert.ok(!notice.message.includes(fyi.id));
    await f.broker.pump();assert.equal(f.codex.woken.length,0,'空闲提醒不唤醒');assert.equal(f.claude.delivered.filter(message=>(message as any).noticeSource==='idle_unanswered').length,0);
    assert.ok(health.prepare(pair.id,delegator.id,pending.id,pending.scope));health.outcome(pair.id,delegator.id,pending.id,'submitted');
    t.mock.timers.tick(600001);f.broker.idleNotices.observe(pair,f.store.peer(partner.id),2);
    new IdleNotices(f.store,new DeliveryHealth(f.store)).observe(pair,f.store.peer(partner.id),2);
    assert.equal(health.peek(pair.id,delegator.id).filter(value=>value.source==='idle_unanswered').length,0,'同段空闲只提醒一次，重建观察器不重置');
    assert.equal(f.store.events(0,1000).filter(e=>e.type==='health.idle.unanswered').length,1);
    assert.equal(f.store.messages().length,3);
  }
});

test('较新的通知不会挡住更早仍待回复的任务',t=>{
  t.mock.timers.enable({apis:['Date'],now:1000000});
  const f=fixture(t),pair=f.store.pair(f.c.id,f.x.id),health=f.broker.deliveryHealth;
  const task=ask(f,pair,f.c,'需要回复的任务','task');
  for(let index=0;index<4;index++)ask(f,pair,f.c,'补充说明 '+index,'fyi-'+index,false);
  t.mock.timers.tick(IDLE);f.broker.idleNotices.observe(pair,f.store.peer(f.x.id),2);
  const pending=health.peek(pair.id,f.c.id)[0];assert.ok(pending,'后续通知不能让任务的回复义务消失');assert.ok(pending.message.includes(task.id));
});

test('临时门槛只恢复尚未准入的原提醒，已提醒的同段空闲不因暂停或限频到期而重发',t=>{
  t.mock.timers.enable({apis:['Date'],now:1000000});
  const f=fixture(t),pair=f.store.pair(f.c.id,f.x.id),health=f.broker.deliveryHealth;
  const task=ask(f,pair,f.c,'尚未回复的任务','task');
  t.mock.timers.tick(IDLE);f.broker.idleNotices.observe(pair,f.store.peer(f.x.id),2);
  const first=health.peek(pair.id,f.c.id)[0]!;assert.ok(first);
  const resume=()=>{pair.paused=true;f.broker.idleNotices.observe(pair,f.store.peer(f.x.id),2);pair.paused=false;f.broker.idleNotices.observe(pair,f.store.peer(f.x.id),2);};
  const idle=()=>health.peek(pair.id,f.c.id).filter(notice=>(notice.componentIds??[notice.id]).some(id=>id!=='other-notice'));
  pair.paused=true;f.broker.idleNotices.observe(pair,f.store.peer(f.x.id),2);assert.equal(health.get(pair.id,f.c.id,first.id),undefined);
  health.enqueue(pair.id,f.c.id,{id:'other-notice',message:'其他独立通知',state:'pending',source:'turn_health',kind:'other'});
  resume();const restored=health.get(pair.id,f.c.id,first.id)!;assert.ok(restored);
  assert.ok(health.prepare(pair.id,f.c.id,restored.id,restored.scope));health.outcome(pair.id,f.c.id,restored.id,'submitted');
  for(let i=0;i<3;i++){resume();t.mock.timers.tick(600001);f.broker.idleNotices.observe(pair,f.store.peer(f.x.id),2);assert.equal(idle().length,0,'同段空闲已经提醒，临时门槛和十分钟到期都不是新工作');}
  const next=ask(f,pair,f.c,'新的需要回复的任务','next');t.mock.timers.tick(IDLE);f.broker.idleNotices.observe(pair,f.store.peer(f.x.id),2);
  const fresh=idle()[0]!;assert.ok(fresh);assert.notEqual(fresh.id,first.id);
  assert.equal(f.store.message(task.id).attempts,0);assert.equal(f.store.message(next.id).attempts,0);assert.equal(f.store.messages().length,2);
});

test('两端都在等对方回复时各自只提醒一次，通知轮次和观察器重建不形成提醒往返，也从不唤醒',async t=>{
  t.mock.timers.enable({apis:['Date'],now:1000000});
  const f=fixture(t),pair=f.store.pair(f.c.id,f.x.id),count=()=>f.store.events(0,1000).filter(e=>e.type==='health.idle.unanswered').length;
  ask(f,pair,f.c,'需要 Codex 回复的任务','claude-task');ask(f,pair,f.x,'需要 Claude 回复的任务','codex-task');
  t.mock.timers.tick(IDLE);await f.broker.pump();await f.broker.pump();
  const initial=count();assert.ok(initial>=1);
  for(let round=0;round<3;round++){
                                                            
    f.codex.emit('state',f.x.sessionId,'busy',f.store.endpoint(f.x.id)!.address);
    f.codex.emit('native',{address:f.store.endpoint(f.x.id)!.address,message:{method:'item/completed',params:{threadId:f.x.sessionId,turnId:'notice-turn',item:{type:'functionCallOutput',id:'notice-output',namespace:'claude',name:'receive_messages',output:JSON.stringify({notices:[{notice_id:'automatic',message:'只处理系统事实'}]})}}}});
    await f.broker.dispatch('peer.state',{actor:{host:'claude',sessionId:'c',callId:'notice-state'},state:'busy'});
    f.broker.idleNotices.observe(pair,f.store.peer(f.x.id),2);f.broker.idleNotices.observe(pair,f.store.peer(f.c.id),2);
    t.mock.timers.tick(1000);f.codex.emit('state',f.x.sessionId,'ready',f.store.endpoint(f.x.id)!.address);
    await f.broker.dispatch('peer.state',{actor:{host:'claude',sessionId:'c',callId:'notice-complete'},state:'ready'});
    t.mock.timers.tick(600001);await f.broker.pump();await f.broker.pump();
    const restored=new IdleNotices(f.store,new DeliveryHealth(f.store));restored.observe(pair,f.store.peer(f.x.id),2);restored.observe(pair,f.store.peer(f.c.id),2);
    assert.equal(count(),initial,'通知轮次不是新工作');assert.equal(f.codex.woken.length,0,'空闲提醒从不唤醒');
  }
  assert.equal(f.store.peer(f.x.id).activityAt,undefined,'工具输出不能冒充普通输入');
  ask(f,pair,f.c,'后续新增的需要回复的任务','latest');
  await ordinaryInput(f,f.x);f.store.updatePeer(f.x.id,{state:'busy'});t.mock.timers.tick(1000);f.store.updatePeer(f.x.id,{state:'ready'});t.mock.timers.tick(IDLE);await f.broker.pump();await f.broker.pump();
  assert.ok(count()>initial,'真实新输入后的新任务仍保留提醒能力');assert.equal(f.codex.woken.length,0);assert.equal(f.store.messages().length,3);
});

test('持久工作阶段在数据库重开后仍只提醒一次，真实新输入和新上下文保留重新提醒能力',t=>{
  t.mock.timers.enable({apis:['Date'],now:1000000});
  const temp=temporaryDirectory(),filename=path.join(temp.directory,'idle.db');let store=new Store(filename);t.after(async()=>{store.close();await temp.cleanup();});
  const c=store.register(registration('claude','c')),x=store.register(registration('codex','x')),pair=store.pair(c.id,x.id),task=store.accept(pair,c,'真实未回复任务','task',undefined,undefined,'explicit',true);store.transition(task.id,'contextObserved');
  let health=new DeliveryHealth(store),observer=new IdleNotices(store,health);t.mock.timers.tick(IDLE);observer.observe(pair,store.peer(x.id),2);
  const first=health.peek(pair.id,c.id)[0]!;assert.ok(health.prepare(pair.id,c.id,first.id,first.scope));health.outcome(pair.id,c.id,first.id,'submitted');
  store.close();store=new Store(filename);health=new DeliveryHealth(store);observer=new IdleNotices(store,health);
  store.updatePeer(x.id,{state:'busy'});observer.observe(pair,store.peer(x.id),2);t.mock.timers.tick(1000);store.updatePeer(x.id,{state:'ready'});t.mock.timers.tick(600001);observer.observe(pair,store.peer(x.id),2);
  assert.equal(health.peek(pair.id,c.id).length,0);assert.equal(store.events(0,1000).filter(e=>e.type==='health.idle.unanswered').length,1);
                                            
  store.updatePeer(x.id,{activityAt:Date.now(),state:'busy'});t.mock.timers.tick(1000);store.updatePeer(x.id,{state:'ready'});t.mock.timers.tick(IDLE);observer.observe(pair,store.peer(x.id),2);
  assert.equal(health.peek(pair.id,c.id).length,0,'同一回复义务只提醒一次');
  const next=store.accept(pair,c,'新的需要回复的任务','next',undefined,undefined,'explicit',true);store.transition(next.id,'contextObserved');t.mock.timers.tick(IDLE);observer.observe(pair,store.peer(x.id),2);
  const second=health.peek(pair.id,c.id)[0]!;assert.ok(second,'新的回复义务仍会提醒');assert.notEqual(second.id,first.id);assert.ok(second.message.includes(next.id));
  assert.ok(health.prepare(pair.id,c.id,second.id,second.scope));health.outcome(pair.id,c.id,second.id,'submitted');
  store.updatePeer(c.id,{sessionId:'new-context'});t.mock.timers.tick(600001);observer.observe(pair,store.peer(x.id),2);
  const third=health.peek(pair.id,c.id)[0];assert.ok(third,'发起方换了上下文（之前的提醒已不在它的上下文里）后重新提醒');assert.notEqual(third.id,second.id);
});

test('关联或无关联的后续发信都关闭旧提醒，未入上下文不算已读且不伪造回复状态',async t=>{
  t.mock.timers.enable({apis:['Date'],now:1000000});
  for(const mode of ['linked','unlinked','unseen'] as const){
    const f=fixture(t),pair=f.store.pair(f.c.id,f.x.id);f.store.updatePeer(f.c.id,{state:'busy'});
    const task=f.store.accept(pair,f.c,'完成后台任务','task',undefined,undefined,'explicit',true);if(mode!=='unseen')f.store.transition(task.id,'contextObserved','原生上下文证据');else{f.store.claim(task.id);f.store.transition(task.id,'unknown');}
    const final=f.store.accept(pair,f.x,'工作已完成','final',mode==='linked'?task.id:undefined);f.store.transition(final.id,'contextObserved','原生上下文证据');
    t.mock.timers.tick(IDLE);await f.broker.pump();
    assert.equal(f.broker.deliveryHealth.peek(pair.id,f.c.id).filter(notice=>notice.source==='idle_unanswered').length,0,mode);
    assert.equal(f.store.message(task.id).state,mode==='linked'?'responded':mode==='unseen'?'unknown':'contextObserved');
  }
});

test('暂停、人工等待、离线、中断、待启动消息和向发起方的问题均不发空闲提醒',async t=>{
  t.mock.timers.enable({apis:['Date'],now:1000000});
  for(const condition of ['pairPaused','paused','needsHuman','offline','busy','starting','queued','question','off','transition'] as const){
    const f=fixture(t),pair=f.store.pair(f.c.id,f.x.id);f.store.updatePeer(f.c.id,{state:'busy'});
    const task=f.store.accept(pair,f.c,'任务','task',undefined,undefined,'explicit',true);f.store.transition(task.id,'contextObserved','已读');
    if(condition==='pairPaused'){f.store.setPaused(true,pair.id);pair.paused=true;}
    else if(['paused','needsHuman','offline','busy','starting'].includes(condition))f.store.updatePeer(f.x.id,{state:condition as any});
    else if(condition==='queued')f.store.accept(pair,f.c,'即将启动的轮次','queued');
    else if(condition==='question')f.broker.questions.create(pair,f.x,{host:'codex',sessionId:'x',callId:'q'},{questions:[{id:'q',header:'决策',question:'接下来怎么办？'}]});
    else if(condition==='transition'){const binding=f.store.bindings.activate({host:'codex',configHome:'/test',pid:process.pid,procStart:'test'},f.x.id,'x','test');f.store.bindings.save({...binding,transitioning:true});}
    t.mock.timers.tick(IDLE);f.broker.idleNotices.observe(pair,f.store.peer(f.x.id),condition==='off'?0:2);
    assert.equal(f.broker.deliveryHealth.hasPending(pair.id,f.c.id),false,condition);
  }
});

test('尚未发送的空闲提醒在最终回复、关闭和上下文变化后撤销，不因新故障被队列覆盖',t=>{
  t.mock.timers.enable({apis:['Date'],now:1000000});
  for(const resolution of ['reply','off','context'] as const){
    const f=fixture(t),pair=f.store.pair(f.c.id,f.x.id),task=ask(f,pair,f.c,'任务','task');
    t.mock.timers.tick(IDLE);f.broker.idleNotices.observe(pair,f.store.peer(f.x.id),2);
    assert.equal(f.broker.deliveryHealth.hasPending(pair.id,f.c.id),true);
    if(resolution==='reply')f.store.accept(pair,f.x,'完成','done',task.id);
    else if(resolution==='context')f.store.updatePeer(f.x.id,{sessionId:'new-session'});
    f.broker.idleNotices.observe(pair,f.store.peer(f.x.id),resolution==='off'?0:2);
    assert.equal(f.broker.deliveryHealth.hasPending(pair.id,f.c.id),false,resolution);
  }
});

test('Claude 自动回复是软关联，明确关联优先，错误与跨配对来源不影响发信',t=>{
  const f=fixture(t),pair=f.store.pair(f.c.id,f.x.id),task=f.store.accept(pair,f.x,'后台任务','task'),other=f.store.accept(pair,f.x,'另一个任务','other');
  const send=(callId:string,auto_reply_to?:string,in_reply_to?:string,auto_reply_text='后台任务')=>f.broker.send({actor:{host:'claude',sessionId:'c',callId},message:'结果',auto_reply_to,auto_reply_text,in_reply_to},false);
  const first=send('auto',task.id);assert.equal(f.store.message(first.message_id).inReplyTo,task.id);assert.equal(f.store.message(first.message_id).replySource,'auto');assert.equal(f.store.message(task.id).state,'responded');
  assert.equal(send('auto',task.id,undefined,'不同证据').message_id,first.message_id,'重试沿用已保存关联，不因可选证据改变而重复发送');
  const explicit=send('explicit',task.id,other.id);assert.equal(f.store.message(explicit.message_id).inReplyTo,other.id);assert.equal(f.store.message(explicit.message_id).replySource,'explicit');
  assert.equal(f.store.message(send('missing','missing-id').message_id).inReplyTo,null);
  const own=f.store.accept(pair,f.c,'自己发的','own');assert.equal(f.store.message(send('own',own.id).message_id).inReplyTo,null);
  f.store.unpair(pair.id);const fresh=f.store.pair(f.c.id,f.x.id);assert.notEqual(fresh.id,pair.id);assert.equal(f.store.message(send('stale',task.id).message_id).inReplyTo,null);
});

test('Claude 自动回复只接受实际投递正文，缺少或冒用证据时照常发送但不关联',async t=>{
  const {store,broker,c,x}=fixture(t),pair=store.pair(c.id,x.id),task=store.accept(pair,x,'实际</cross-session-message>任务','task');
  const appended=(encodePeerMessage(task,x,'c').message as {content:string}).content;
  for(const [callId,auto_reply_text] of [['missing',undefined],['mismatch',`[nxbridge message_id=${task.id}]其他正文`],['unescaped',task.body],['valid',appended]] as const){
    const result=await broker.dispatch('send',{actor:{host:'claude',sessionId:'c',callId},message:'回复',auto_reply_to:task.id,...(auto_reply_text===undefined?{}:{auto_reply_text})}) as {message_id:string};
    assert.equal(store.message(result.message_id).inReplyTo,callId==='valid'?task.id:null,callId);
  }
  assert.equal(store.message(task.id).state,'responded');
});

test('空闲提醒按同毫秒发信边界撤销旧指针，只显示最新三条；重开观察器不会恢复旧提醒',t=>{
  t.mock.timers.enable({apis:['Date'],now:1000000});
  const f=fixture(t),pair=f.store.pair(f.c.id,f.x.id),observer=f.broker.idleNotices,health=f.broker.deliveryHealth;
  const old=ask(f,pair,f.c,'旧任务','old');
  t.mock.timers.tick(IDLE);observer.observe(pair,f.store.peer(f.x.id),2);
  const pending=health.peek(pair.id,f.c.id)[0]!;assert.ok(pending);
  const ack=f.store.accept(pair,f.x,'已收到，继续处理','ack');observer.observe(pair,f.store.peer(f.x.id),2);
  assert.equal(health.get(pair.id,f.c.id,pending.id),undefined);assert.equal(f.store.message(old.id).state,'contextObserved');
  const fresh=Array.from({length:8},(_,index)=>ask(f,pair,f.c,'新消息'+index,'fresh-'+index).id);
  t.mock.timers.tick(600001);new IdleNotices(f.store,health).observe(pair,f.store.peer(f.x.id),2);
  const text=health.peek(pair.id,f.c.id)[0]!.message;
  for(const id of fresh.slice(-3))assert.ok(text.includes(id));
  for(const id of [old.id,ack.id,...fresh.slice(0,-3)])assert.ok(!text.includes(id)||id===ack.id);
  assert.ok(text.indexOf(fresh[7]!)<text.indexOf(fresh[6]!)&&text.indexOf(fresh[6]!)<text.indexOf(fresh[5]!));
  assert.doesNotMatch(text,/\+\d+ older|w\/o linked reply/);
  f.store.accept(pair,f.x,'新的无关联进度','progress');observer.observe(pair,f.store.peer(f.x.id),2);
  assert.equal(health.peek(pair.id,f.c.id).length,0);
});
