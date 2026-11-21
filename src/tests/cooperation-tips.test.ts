import test from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync,writeFileSync } from 'node:fs';
import path from 'node:path';
import { CooperationTips,cooperationInterval } from '../broker/delivery/cooperation-tips.js';
import { readSessionProfile } from '../hosts/codex/codex-session-profile.js';
import {DEFAULT_CONFIG} from '../config/defaults.js';
import { fixture } from './support/broker-fixture.js';
import { registration } from './support/registration.js';
import { temporary } from './support/temporary.js';

const minute=60000;

test('账本状态变化通知双方，事件不为通知重复读取正文或问题',t=>{
  const {store,broker,c,x}=fixture(t),changes:string[][]=[];store.onCooperationChange=ids=>changes.push(ids);
  const pair=store.pair(c.id,x.id),both=()=>assert.deepEqual(changes.at(-1)?.slice().sort(),[c.id,x.id].sort());both();
  const messageReads=t.mock.method(store,'message'),questionReads=t.mock.method(store,'question');
  const message=store.accept(pair,c,'只读取必要正文','notify');both();assert.equal(messageReads.mock.callCount(),1);
  store.transition(message.id,'runtimeQueued');both();assert.equal(messageReads.mock.callCount(),2);
  store.retireQueuedDelivery(message.id,'原生队列已消失');both();assert.equal(messageReads.mock.callCount(),2);
  const q=broker.questions.create(pair,x,{host:'codex',sessionId:'x',callId:'q-notify'},{questions:[{id:'q',header:'问题',question:'需要什么？'}]}) as {request_id:string};
  const question=store.question(q.request_id),reads=questionReads.mock.callCount();changes.length=0;store.saveQuestion({...question,status:'timed_out'});both();assert.equal(questionReads.mock.callCount(),reads);
  store.setPaused(true,pair.id);both();store.setPaused(false,pair.id);both();store.unpair(pair.id);both();store.restorePair(pair.id);both();
});
                               
function pulse(t:Parameters<typeof fixture>[0],f:ReturnType<typeof fixture>,ms:number):void{
  while(ms>0){const step=Math.min(ms,60000);t.mock.timers.tick(step);for(const peer of f.store.peers())f.broker.communicationTips.cooperation.observe(peer);ms-=step;}
}
function working(t:Parameters<typeof fixture>[0],overrides:Parameters<typeof fixture>[1]={}){
  const f=fixture(t,overrides);f.store.updatePeer(f.c.id,{state:'ready'});f.store.updatePeer(f.x.id,{state:'busy',effort:'xhigh'});const pair=f.store.pair(f.c.id,f.x.id);
  return{...f,pair,tips:f.broker.communicationTips,coop:f.broker.communicationTips.cooperation};
}

test('从未联系的忙碌根窗口也会提醒，三次封顶；入信推迟但不补次数，真正发信重置',t=>{
  t.mock.timers.enable({apis:['Date'],now:1000000});const f=working(t),tip=()=>f.tips.syncTip(f.x,30);
  pulse(t,f,30*minute-1);assert.equal(tip(),undefined);pulse(t,f,1);assert.match(tip()!,/partner idle 30m, no contact 30m/);
  assert.equal(tip(),undefined);pulse(t,f,30*minute);assert.match(tip()!,/tip 2\/3/);
  const incoming=f.store.accept(f.pair,f.c,'不用猜测这是不是任务','incoming');f.store.transition(incoming.id,'contextObserved');f.tips.partnerReceived(f.x,f.store.message(incoming.id));
  pulse(t,f,29*minute);assert.equal(tip(),undefined);pulse(t,f,minute);assert.match(tip()!,/tip 3\/3/);
  pulse(t,f,60*minute);assert.equal(tip(),undefined);
  const own=f.store.accept(f.pair,f.x,'简短同步','own');f.tips.partnerSent(f.x,own);f.store.transition(own.id,'contextObserved');
  pulse(t,f,30*minute);assert.match(tip()!,/recheck split/);assert.doesNotMatch(tip()??'',/tip 2\/3/);
  f.tips.partnerSent(f.x,own);pulse(t,f,30*minute);assert.match(tip()!,/tip 2\/3/,'重试旧发信不补次数');
});

test('强度在检查时生效，未知和数字预算取较早提醒；配置按比例缩放且零关闭',t=>{
  assert.deepEqual(['none','minimal','low',undefined,12000,'future','medium','high','xhigh','max'].map(e=>cooperationInterval(30,e)/minute),[15,15,15,15,15,15,20,25,30,30]);
  assert.equal(cooperationInterval(2,'low'),minute);
  t.mock.timers.enable({apis:['Date'],now:1000000});const f=working(t);pulse(t,f,16*minute);assert.equal(f.tips.syncTip(f.x,30),undefined);
  f.store.updatePeer(f.x.id,{effort:'low'});assert.match(f.tips.syncTip(f.x,30)!,/no contact 16m/);assert.equal(f.tips.syncTip(f.x,0),undefined);
});

test('只累计搭档可用且自己忙碌的时间，等待搭档、隔夜空闲、暂停和提问不增加时钟',t=>{
  t.mock.timers.enable({apis:['Date'],now:1000000});const f=working(t);pulse(t,f,10*minute);
  f.store.updatePeer(f.c.id,{state:'busy'});pulse(t,f,100*minute);assert.equal(f.tips.syncTip(f.x,30),undefined);
  f.store.updatePeer(f.c.id,{state:'ready'});pulse(t,f,5*minute);f.store.updatePeer(f.x.id,{state:'ready'});pulse(t,f,600*minute);
  f.store.updatePeer(f.x.id,{state:'busy'});assert.equal(f.tips.syncTip(f.x,30),undefined);
  f.store.setPaused(true,f.pair.id);pulse(t,f,100*minute);assert.equal(f.tips.syncTip(f.x,30),undefined);f.store.setPaused(false,f.pair.id);
  pulse(t,f,15*minute);assert.match(f.tips.syncTip(f.x,30)!,/no contact 30m/);
  f.broker.questions.create(f.pair,f.x,{host:'codex',sessionId:'x',callId:'q'},{questions:[{header:'问题',id:'q',question:'需要搭档决定吗？'}]});
  pulse(t,f,100*minute);assert.equal(f.tips.syncTip(f.x,30),undefined);
});

test('投递未明时不提醒，已读的知会不被猜成永久待办，子代理及过渡上下文不提醒',t=>{
  t.mock.timers.enable({apis:['Date'],now:1000000});const f=working(t),m=f.store.accept(f.pair,f.x,'FYI，不做语义分类','fyi');
  pulse(t,f,60*minute);assert.equal(f.tips.syncTip(f.x,30),undefined);f.store.transition(m.id,'unknown');assert.equal(f.tips.syncTip(f.x,30),undefined);
  f.store.transition(m.id,'contextObserved');pulse(t,f,30*minute);assert.match(f.tips.syncTip(f.x,30)!,/partner idle/);
  const child=f.store.register(registration('codex','child',{kind:'subagent',state:'busy'}));assert.equal(f.tips.syncTip(child,1),undefined);
  const binding=f.store.bindings.activate({host:'codex',pid:101,procStart:'generation',configHome:'/isolated'},f.x.id,'x','new');
  f.store.bindings.save({...binding,transitioning:true});pulse(t,f,60*minute);assert.equal(f.tips.syncTip(f.x,30),undefined);
});

test('上下文按真实输入绝对阈值、合并跃迁、共享冷却；只有真实压缩才重新启用档位',t=>{
  t.mock.timers.enable({apis:['Date'],now:1000000});const f=working(t),tip=()=>f.tips.syncTip(f.x,30),usage=(tokens:number)=>f.coop.usage(f.x,{tokens,at:Date.now()});
  usage(280000);pulse(t,f,15*minute);assert.equal(tip(),undefined);
  usage(900000);const first=tip()!;assert.match(first,/long context/);assert.equal((f.store.events(0,1000).filter(e=>e.type==='communication.syncTip').at(-1)!.data as any).contextBand,850000);assert.equal(tip(),undefined);
  usage(200000);usage(900000);pulse(t,f,15*minute);assert.equal(tip(),undefined,'上下文提醒已经要求核对分工，不额外提前补静默提醒');
  pulse(t,f,15*minute);assert.match(tip()!,/no contact 45m/);
  f.coop.compacted(f.x,'compact-1');usage(450000);assert.equal(tip(),undefined);pulse(t,f,15*minute);assert.equal(tip(),undefined,'压缩后的首份用量只建立基线');
  usage(600000);assert.match(tip()!,/long context/);assert.equal((f.store.events(0,1000).filter(e=>e.type==='communication.syncTip').at(-1)!.data as any).contextBand,600000);
  f.coop.compacted(f.x,'compact-1');usage(600000);pulse(t,f,15*minute);assert.equal(tip(),undefined,'重复压缩通知不能重新启用档位');
});

test('共享冷却不丢最后一个上下文档位，发信清除挂起提醒；强度和上下文不改变升级起点',t=>{
  t.mock.timers.enable({apis:['Date'],now:1000000});const f=working(t);pulse(t,f,30*minute);assert.ok(f.tips.syncTip(f.x,30));
  const first=f.tips.syncReminder(f.x,30)!;pulse(t,f,15*minute);f.coop.usage(f.x,{tokens:600000,at:Date.now()});assert.match(f.tips.syncTip(f.x,30)!,/long context/);
  pulse(t,f,15*minute);const due=f.tips.syncReminder(f.x,30)!;assert.equal(due.firedAt,first.firedAt);assert.ok(due.dueAt<=Date.now());
  f.coop.usage(f.x,{tokens:900000,at:Date.now()});const own=f.store.accept(f.pair,f.x,'同步','sent');f.tips.partnerSent(f.x,own);f.store.transition(own.id,'contextObserved');
  pulse(t,f,15*minute);assert.equal(f.tips.syncTip(f.x,30),undefined);assert.equal(f.tips.syncReminder(f.x,30),undefined);
});

test('未配对提醒允许按需发信，但尊重禁止隐式配对、解除和禁用；状态跨实例保存',t=>{
  t.mock.timers.enable({apis:['Date'],now:1000000});const f=fixture(t,{implicit:'on-demand'});f.store.updatePeer(f.x.id,{state:'busy',effort:'low'});
  pulse(t,f,15*minute);assert.match(f.broker.communicationTips.syncTip(f.x,30)!,/no partner yet/);
  const fresh=new CooperationTips(f.store,{config:()=>({...DEFAULT_CONFIG,implicit:'on-demand'})});assert.equal(fresh.tip(f.x,30),undefined);
  f.store.updatePeer(f.x.id,{enabled:false});pulse(t,f,60*minute);assert.equal(fresh.tip(f.x,30),undefined);
  f.store.updatePeer(f.x.id,{enabled:true});f.store.pair(f.c.id,f.x.id);f.store.unpair(f.x.id);pulse(t,f,60*minute);assert.equal(fresh.tip(f.x,30),undefined);
  const g=fixture(t);g.store.updatePeer(g.x.id,{state:'busy'});pulse(t,f,60*minute);assert.equal(g.broker.communicationTips.syncTip(g.x,30),undefined);
});

test('增量持久元数据读取最后请求的输入而非累计值，压缩失效旧用量，不缓存正文',async t=>{
  const file=path.join(temporary(t),'usage.jsonl'),line=(type:string,payload:unknown,at:number)=>JSON.stringify({timestamp:new Date(at).toISOString(),type,payload})+'\n';
  writeFileSync(file,line('session_meta',{id:'usage'},1000)+line('turn_context',{model:'m',effort:'low'},1001)+line('event_msg',{type:'token_count',info:{last_token_usage:{input_tokens:450000,cached_input_tokens:400000,output_tokens:5000},total_token_usage:{input_tokens:999999999}}},1002),'utf8');
  const first=await readSessionProfile(file,'usage');assert.equal(first.usage!.inputTokens,450000);assert.equal(first.settings.reasoningEffort,'low');
  appendFileSync(file,line('compacted',{replacement_history:[{secret:'正文不进入缓存'}]},1003),'utf8');const compact=await readSessionProfile(file,'usage');assert.equal(compact.usage,undefined);assert.ok(compact.compaction);assert.ok(!JSON.stringify(compact).includes('正文'));
  appendFileSync(file,line('event_msg',{type:'token_count',info:{last_token_usage:{input_tokens:280000}}},1004),'utf8');assert.equal((await readSessionProfile(file,'usage')).usage!.inputTokens,280000);
});

test('tip-sync 接受根用量与压缩信号，重复压缩不重置，迟到用量及旧 epoch 被拒绝',async t=>{
  t.mock.timers.enable({apis:['Date'],now:1000000});const f=working(t),actor={host:'codex' as const,sessionId:'x',callId:'usage'};
  const sync=(input:Record<string,unknown>={})=>f.broker.dispatch('tip.sync',{actor,...input}) as Promise<{tip?:string}>;
  await sync({usage:{tokens:450000,observedAt:Date.now()}});pulse(t,f,15*minute);assert.match((await sync()).tip!,/long context/);assert.equal(f.tips.syncReminder(f.x,30),undefined,'上下文提示不冒充首次静默升级起点');
  const at=Date.now();await sync({compaction:{id:'real',at},usage:{tokens:450000,observedAt:at}});
  pulse(t,f,15*minute);assert.equal((await sync({compaction:{id:'real',at}})).tip,undefined,'压缩基线已覆盖400k');
  assert.match((await sync({compaction:{id:'real',at},usage:{tokens:600000,observedAt:Date.now()}})).tip!,/long context/);
  await sync({usage:{tokens:900000,observedAt:at-1}});assert.equal((f.store.setting<any>('cooperation:'+f.x.id)).usage.tokens,600000);
  const binding=f.store.bindings.activate({host:'codex',pid:101,procStart:'generation',configHome:'/isolated'},f.x.id,'x','reset');f.store.saveEndpoint({...f.store.endpoints(f.x.id)[0]!,mode:'embedded'});
  f.coop.usage(f.x,{tokens:900000,at:Date.now()-1});assert.equal((f.store.setting<any>('cooperation:'+f.x.id))?.usage,undefined,'新 epoch 不继承旧用量');
  f.store.bindings.activate(binding,f.x.id,'x','reset');
  await assert.rejects(()=>f.broker.dispatch('tip.sync',{actor:{...actor,binding:{key:binding.key,epoch:binding.epoch}},usage:{tokens:900000,observedAt:Date.now()}}),{code:'stale_context'});
});

test('Codex 原生通知使用 last 输入含缓存，不把累计值或输出值当上下文；压缩后建立基线',t=>{
  t.mock.timers.enable({apis:['Date'],now:1000000});const f=working(t),address=f.store.endpoint(f.x.id)!.address;
  const emit=(method:string,params:Record<string,unknown>)=>f.codex.emit('native',{address,message:{method,params:{threadId:'x',...params}}});
  emit('thread/tokenUsage/updated',{tokenUsage:{last:{inputTokens:280000,cachedInputTokens:270000,outputTokens:200000},total:{inputTokens:999999999}}});
  pulse(t,f,15*minute);assert.equal(f.tips.syncTip(f.x,30),undefined);
  emit('thread/tokenUsage/updated',{tokenUsage:{last:{inputTokens:450000,cachedInputTokens:400000,outputTokens:1000}}});assert.match(f.tips.syncTip(f.x,30)!,/long context/);
  emit('item/completed',{item:{id:'real-native',type:'contextCompaction'}});emit('thread/tokenUsage/updated',{tokenUsage:{last:{inputTokens:450000}}});
  pulse(t,f,15*minute);assert.equal(f.tips.syncTip(f.x,30),undefined);emit('thread/tokenUsage/updated',{tokenUsage:{last:{inputTokens:600000}}});assert.match(f.tips.syncTip(f.x,30)!,/long context/);
});

test('协作和空闲账本提醒同时到期时合成一条，消费后不会重复提交空闲通知',t=>{
  t.mock.timers.enable({apis:['Date'],now:1000000});const f=working(t),message=f.store.accept(f.pair,f.x,'需要搭档处理并回复','coalesced',undefined,undefined,'explicit',true);
  f.tips.partnerSent(f.x,message);f.store.transition(message.id,'contextObserved');f.tips.partnerReceived(f.c,message);
  pulse(t,f,30*minute);f.broker.idleNotices.observe(f.pair,f.store.peer(f.c.id),2);
  const episode=f.store.setting<{noticeId:string}>('idleNotice:'+f.c.id)!;assert.ok(f.broker.deliveryHealth.get(f.pair.id,f.x.id,episode.noticeId));
  const line=f.tips.syncTip(f.x,30)!;assert.match(line,/recheck split/);assert.match(line,/expected reply still pending/);assert.ok(line.includes(message.id));assert.equal(line.split('nxbridge tip:').length,2);
  assert.equal(f.broker.deliveryHealth.get(f.pair.id,f.x.id,episode.noticeId),undefined);f.broker.idleNotices.observe(f.pair,f.store.peer(f.c.id),2);assert.equal(f.broker.deliveryHealth.get(f.pair.id,f.x.id,episode.noticeId),undefined);
});

test('频繁真实压缩不会饿死静默提醒，不补预算，也不重置首次升级起点',t=>{
  t.mock.timers.enable({apis:['Date'],now:1000000});const f=working(t),ordinals:number[]=[];let first:number|undefined;
  for(let i=1;i<=200;i++){
    pulse(t,f,minute);if(i%25===0)f.coop.compacted(f.x,'compact-'+i);
    if(f.tips.syncTip(f.x,30)){ordinals.push(i);first??=f.tips.syncReminder(f.x,30)!.firedAt;}
  }
  assert.deepEqual(ordinals,[30,60,90]);assert.equal(f.tips.syncReminder(f.x,30)!.firedAt,first);assert.ok(f.tips.syncReminder(f.x,30)!.dueAt<=Date.now());
});

test('休眠和后台停机的观测空档不累计，阻塞巡检只保留实际工作时间',t=>{
  t.mock.timers.enable({apis:['Date'],now:1000000});const f=working(t);pulse(t,f,10*minute);
  t.mock.timers.tick(600*minute);assert.equal(f.tips.syncTip(f.x,30),undefined,'睡眠十小时不冒充忙碌');
  f.coop.restarted();t.mock.timers.tick(minute);assert.equal(f.tips.syncTip(f.x,30),undefined,'重启后也不累计停机时间');
  pulse(t,f,19*minute);assert.equal(f.tips.syncTip(f.x,30),undefined);pulse(t,f,minute);assert.ok(f.tips.syncTip(f.x,30));
  let blocked=true;const gated=new CooperationTips(f.store,{blocked:()=>blocked});gated.changed(f.x);pulse(t,f,0);
  for(let i=0;i<60;i++){t.mock.timers.tick(minute);gated.observe(f.x);}assert.equal(gated.tip(f.x,30),undefined);
  blocked=false;gated.changed(f.x);t.mock.timers.tick(minute);assert.equal(gated.tip(f.x,30),undefined,'恢复后不立即重放阻塞期间的时间');
});

test('同一对话更换租约和配对保留上下文档位及压缩去重，新对话重新计量',t=>{
  t.mock.timers.enable({apis:['Date'],now:1000000});const f=working(t);f.coop.compacted(f.x,'compact');f.coop.usage(f.x,{tokens:280000,at:Date.now()});
  pulse(t,f,15*minute);f.coop.usage(f.x,{tokens:650000,at:Date.now()});assert.match(f.tips.syncTip(f.x,30)!,/long context/);
  const window={host:'codex' as const,pid:101,procStart:'generation',configHome:'/isolated'};f.store.bindings.activate(window,f.x.id,'x','resume');f.store.saveEndpoint({...f.store.endpoints(f.x.id)[0]!,mode:'embedded'});
  f.coop.usage(f.x,{tokens:650000,at:Date.now()});f.coop.compacted(f.x,'compact');assert.equal(f.store.setting<any>('cooperation:'+f.x.id).pendingBand,undefined);
  const other=f.store.register(registration('claude','replacement',{state:'ready'}));f.store.pair(other.id,f.x.id,true);f.coop.usage(f.x,{tokens:650000,at:Date.now()});assert.equal(f.store.setting<any>('cooperation:'+f.x.id).pendingBand,undefined,'更换配对也不重放同一对话的上下文档位');
  assert.equal(f.store.events(0,1000).filter(e=>e.type==='communication.contextReset').length,1);
  f.store.updatePeer(f.x.id,{sessionId:'new-context'});f.store.bindings.activate(window,f.x.id,'new-context','reset');f.coop.usage(f.store.peer(f.x.id),{tokens:650000,at:Date.now()});
  pulse(t,f,15*minute);assert.match(f.tips.syncTip(f.x,30)!,/long context/);
});

test('未配对时跨过的上下文档位在配对及租约变更后仍待提醒，但只使用新用量且只提醒一次',t=>{
  t.mock.timers.enable({apis:['Date'],now:1000000});const f=fixture(t),coop=f.broker.communicationTips.cooperation,tip=()=>f.broker.communicationTips.syncTip(f.x,30);
  f.store.updatePeer(f.x.id,{state:'busy',effort:'xhigh'});f.store.updatePeer(f.c.id,{state:'ready'});
  coop.usage(f.x,{tokens:450000,at:Date.now()});assert.equal(tip(),undefined);
  f.store.pair(f.c.id,f.x.id);const window={host:'codex' as const,pid:101,procStart:'generation',configHome:'/isolated'};
  f.store.bindings.activate(window,f.x.id,'x','resume');f.store.saveEndpoint({...f.store.endpoints(f.x.id)[0]!,mode:'embedded'});
  coop.observe(f.x);
  pulse(t,f,15*minute);assert.equal(tip(),undefined,'新租约必须等待新用量，不能直接使用未配对时的用量');
  coop.usage(f.x,{tokens:450000,at:Date.now()});assert.match(tip()!,/long context/);
  pulse(t,f,15*minute);coop.usage(f.x,{tokens:450000,at:Date.now()});assert.equal(tip(),undefined);
  const contextTips=f.store.events(0,1000).filter(e=>e.type==='communication.syncTip'&&(e.data as any).contextBand===400000);assert.equal(contextTips.length,1);
});

test('关闭配置不积攒工作时间，显式解除意图在配对历史被保留策略清理后仍生效',t=>{
  t.mock.timers.enable({apis:['Date'],now:1000000});const f=working(t);pulse(t,f,14*minute);f.broker.config.syncTipMinutes=0;pulse(t,f,100*minute);
  f.broker.config.syncTipMinutes=30;f.coop.observe(f.x);assert.equal(f.tips.syncTip(f.x,30),undefined);pulse(t,f,16*minute);assert.ok(f.tips.syncTip(f.x,30));
  f.broker.config.implicit='on-demand';f.store.unpair(f.x.id);t.mock.timers.tick(2);f.store.maintain({historyMaxAgeMs:1});assert.equal(f.store.hasPairHistory(f.x.id),false);
  pulse(t,f,60*minute);assert.equal(f.tips.syncTip(f.x,30),undefined);assert.equal(f.store.setting('cooperationUnpaired:'+f.x.id),true);
});

test('无变化的空闲、离线和关闭窗口巡检不重复写时钟，恢复工作才继续持久化',t=>{
  t.mock.timers.enable({apis:['Date'],now:1000000});const f=working(t);f.store.updatePeer(f.x.id,{state:'ready'});
  const writer=t.mock.method(f.store,'setSetting');
  for(const state of ['ready','offline','ready'] as const){f.store.updatePeer(f.x.id,{state});writer.mock.resetCalls();t.mock.timers.tick(5000);f.coop.observe(f.x);f.tips.syncReminder(f.x,30);assert.equal(writer.mock.callCount(),0);}
  f.store.updatePeer(f.x.id,{state:'busy'});writer.mock.resetCalls();t.mock.timers.tick(5000);f.coop.observe(f.x);assert.ok(writer.mock.callCount()>0);
});
