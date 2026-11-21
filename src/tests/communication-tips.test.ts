import test from 'node:test';
import assert from 'node:assert/strict';
import { CommunicationTips } from '../broker/delivery/communication-tips.js';
import { fixture } from './support/broker-fixture.js';
import { registration } from './support/registration.js';

test('收到搭档任务后忙碌满当前强度阈值才提醒，收信推迟时钟且重复回执不重复计量',async t=>{
  let now=1000000;t.mock.method(Date,'now',()=>now);
  const advance=(ms:number)=>{while(ms>0){const step=Math.min(ms,60000);now+=step;for(const peer of f.store.peers())f.broker.communicationTips.cooperation.observe(peer);ms-=step;}};
  const f=fixture(t);f.store.pair(f.c.id,f.x.id);f.store.updatePeer(f.x.id,{state:'busy',effort:'xhigh'});
  const actor={host:'codex' as const,sessionId:'x',callId:'tip'},tip=async()=>(await f.broker.dispatch('tip.sync',{actor}) as any).tip;
  const incoming=async(callId:string)=>{const m=f.broker.send({actor:{host:'claude',sessionId:'c',callId},message:'搭档任务'},false);await f.broker.dispatch('observe',{actor,message_id:m.message_id,state:'contextObserved'});return m;};
  assert.equal(await tip(),undefined,'没有本上下文交互时保持安静');
  const first=await incoming('task');advance(30*60000-1);assert.equal(await tip(),undefined);advance(1);
  assert.match(await tip(),/no contact 30m/);
  advance(30*60000);await incoming('more');assert.equal(await tip(),undefined,'新收信推迟提醒，但不补次数');advance(30*60000);assert.match(await tip(),/tip 2\/3/);
  const send={actor:{...actor,callId:'own-send'},message:'中途同步'},sent=f.broker.send(send,false);await f.broker.dispatch('observe',{actor:{host:'claude',sessionId:'c',callId:'see'},message_id:sent.message_id,state:'contextObserved'});
  advance(10*60000);const latest=await incoming('later');advance(20*60000);assert.equal(await tip(),undefined);
  await f.broker.dispatch('observe',{actor,message_id:latest.message_id,state:'contextObserved'});
  await f.broker.dispatch('observe',{actor,message_id:first.message_id,state:'contextObserved'});
  advance(10*60000);assert.match(await tip(),/no contact 30m/,'重复回执不能推迟时钟');
  f.broker.send(send,false);advance(30*60000);assert.match(await tip(),/tip 2\/3/,'重试同一次发信不能补次数');
});

test('同步提醒按配对和根上下文隔离，暂停、空闲、人工等待和关闭配置均不消耗提醒',async t=>{
  let now=1000000;t.mock.method(Date,'now',()=>now);
  const advance=(ms:number)=>{while(ms>0){const step=Math.min(ms,60000);now+=step;for(const peer of f.store.peers())f.broker.communicationTips.cooperation.observe(peer);ms-=step;}};
  const f=fixture(t,{syncTipMinutes:7}),pair=f.store.pair(f.c.id,f.x.id),tips=f.broker.communicationTips;
  f.store.updatePeer(f.c.id,{state:'ready'});f.store.updatePeer(f.x.id,{state:'busy',effort:'xhigh'});
  for(const state of ['ready','needsHuman','paused','offline','starting','unknown'] as const){f.store.updatePeer(f.x.id,{state});assert.equal(tips.syncTip(f.x,7),undefined);}
  f.store.updatePeer(f.x.id,{state:'busy'});assert.equal(tips.syncTip(f.x,0),undefined);
  f.store.setPaused(true,pair.id);assert.equal(tips.syncTip(f.x,7),undefined);f.store.setPaused(false,pair.id);
  const child=f.store.register(registration('codex','child',{kind:'subagent',parentId:'x'}));
  assert.equal((await f.broker.dispatch('tip.sync',{actor:{host:'codex',sessionId:child.sessionId,callId:'child',via:'child'}}) as any).tip,undefined);
  const c2=f.store.register(registration('claude','c2',{state:'ready'})),x2=f.store.register(registration('codex','x2',{state:'busy',effort:'xhigh'}));f.store.pair(c2.id,x2.id);
  assert.equal(tips.syncTip(x2,7),undefined);advance(7*60000);assert.match(tips.syncTip(f.x,7)!,/no contact 7m/);
  assert.match(tips.syncTip(x2,7)!,/no contact 7m/);assert.equal(tips.syncTip(f.x,7),undefined);
  const binding=f.store.bindings.activate({host:'codex',pid:101,procStart:'generation',configHome:'/isolated'},f.x.id,'x','reset');
  f.store.saveEndpoint({...f.store.endpoints(f.x.id)[0]!,mode:'embedded'});
  assert.equal(tips.syncTip(f.x,7),undefined,'同一会话 ID 的新 epoch 不继承旧工作');
  const m=f.store.accept(pair,f.c,'新上下文的任务','fresh');
  await f.broker.dispatch('observe',{actor:{host:'codex',sessionId:'x',callId:'observe',binding:{key:binding.key,epoch:binding.epoch}},message_id:m.id,state:'contextObserved'});
  advance(7*60000);assert.match(tips.syncTip(f.x,7)!,/no contact 7m/);
});

test('Codex 根工具完成先提示取件，真实收信后才启动协作时钟；子代理及重复 hook 不重复提醒',async t=>{
  let now=1000000;t.mock.method(Date,'now',()=>now);
  const advance=(ms:number)=>{while(ms>0){const step=Math.min(ms,60000);now+=step;for(const peer of f.store.peers())f.broker.communicationTips.cooperation.observe(peer);ms-=step;}};
  const f=fixture(t);f.store.pair(f.c.id,f.x.id);
  f.store.register(registration('codex','x',{endpoint:{mode:'embedded',address:'',epoch:'x',pid:process.pid,procStart:'test'}}));
  const hook={session_id:'x',context_key:process.pid+':test:x'};
  await f.broker.dispatch('hook',{...hook,hook_event_name:'SessionStart'});
  await f.broker.dispatch('hook',{...hook,hook_event_name:'UserPromptSubmit'});
  f.store.updatePeer(f.x.id,{effort:'xhigh'});
  const pending=f.broker.send({actor:{host:'claude',sessionId:'c',callId:'pending'},message:'还有任务'},false);advance(30*60000);
  const event={...hook,hook_event_name:'PostToolUse',tool_name:'exec_command'};
  assert.deepEqual(await f.broker.dispatch('hook',{...event,agent_id:'child'}),{});
  const pickup:any=await f.broker.dispatch('hook',event);assert.match(pickup.hookSpecificOutput.additionalContext,/claude msg pending/);assert.doesNotMatch(pickup.hookSpecificOutput.additionalContext,/nxbridge tip/);
  await f.broker.dispatch('observe',{actor:{host:'codex',sessionId:'x',callId:'seen'},message_id:pending.message_id,state:'contextObserved'});advance(30*60000);
  const first:any=await f.broker.dispatch('hook',event);assert.match(first.hookSpecificOutput.additionalContext,/no contact 30m/);
  const again:any=await f.broker.dispatch('hook',event);assert.doesNotMatch(again.hookSpecificOutput?.additionalContext??'',/nxbridge tip/);
});

test('历史核对跨越同一会话的新 epoch 时，迟到回执不启动新工作的提醒',async t=>{
  let now=1000000;t.mock.method(Date,'now',()=>now);
  const advance=(ms:number)=>{while(ms>0){const step=Math.min(ms,60000);now+=step;for(const peer of f.store.peers())f.broker.communicationTips.cooperation.observe(peer);ms-=step;}};
  const f=fixture(t),pair=f.store.pair(f.c.id,f.x.id),window={host:'codex' as const,pid:101,procStart:'generation',configHome:'/isolated'};
  f.store.bindings.activate(window,f.x.id,'x','startup');
  const message=f.store.accept(pair,f.c,'旧对话任务','old');f.store.claim(message.id);f.store.transition(message.id,'runtimeQueued');
  let entered!:()=>void,finish!:()=>void;const started=new Promise<void>(resolve=>entered=resolve),gate=new Promise<void>(resolve=>finish=resolve);
  f.codex.reconcile=async()=>{entered();await gate;return[{messageId:message.id,turnId:'old-turn',itemId:'old-item'}];};
  const pending=f.broker.reconcile();await started;
  f.store.bindings.activate(window,f.x.id,'x','resume');f.store.updatePeer(f.x.id,{state:'busy'});finish();await pending;
  assert.equal(f.store.message(message.id).state,'contextObserved','旧消息的真实历史证据仍保留');
  advance(30*60000);assert.equal(f.broker.communicationTips.syncTip(f.x,30),undefined);
});

test('长报告使用原文 Unicode 字符阈值，提醒服从轮次、十次间隔且同一上下文只提醒一次，重试不重复计量',t=>{
  const f=fixture(t),tips=f.broker.communicationTips;
  assert.equal(tips.record(f.x,'😀'.repeat(2200),'partner','boundary','turn-1'),undefined);
  const tip=tips.record(f.x,'😀'.repeat(2201),'partner','long','turn-1');assert.match(tip!,/auto length check, not judgment: msg 2201 chars/);assert.match(tip!,/if you intended, keep going/);
  for(let i=0;i<12;i++)assert.equal(tips.record(f.x,'新报告'.repeat(800),'partner','same-turn-'+i,'turn-1'),undefined);
  assert.equal(tips.record(f.x,'报告'.repeat(1200),'partner','next-turn','turn-2'),undefined,'同一上下文已提醒过，有意写长的工作不再反复提醒');
  const before=tips.summary(f.x.id);assert.equal(tips.record(f.x,'不同原文','partner','next-turn','turn-2'),tips.record(f.x,'报告'.repeat(1200),'partner','next-turn','turn-2'));assert.deepEqual(tips.summary(f.x.id),before);
  const stats:any=tips.summary(f.x.id);assert.equal(stats.firings.report,1);assert.equal(stats.following.report.samples,10);assert.equal(stats.total.samples,15);
  const fresh=new CommunicationTips(f.store);assert.deepEqual(fresh.summary(f.x.id),stats);
  for(let i=0;i<10;i++)tips.record(f.x,'短消息','partner','filler-'+i,'turn-2');
  assert.equal(tips.record(f.x,'报告'.repeat(1200),'partner','previous-turn','turn-1'),undefined);
});

test('复用查找连续三百字符，返回可用的消息或自有已完成代理引用，优先于长度提醒',t=>{
  const f=fixture(t);f.store.pair(f.c.id,f.x.id);
  const content=Array.from({length:650},(_,i)=>String.fromCodePoint(0x4e00+i)).join('');
  const sent=f.broker.send({actor:{host:'claude',sessionId:'c',callId:'source'},message:'来源前缀 '+content+' 来源后缀'});
  const original='新前缀 '.repeat(27)+content.slice(17,517)+' 新后缀';
  const tip=f.broker.communicationTips.record(f.x,original,'partner','reuse','turn-1');
  assert.match(tip!,/500 chars match msg/);assert.ok(tip!.includes('nxref:msg:'+sent.message_id));
  assert.equal(f.broker.references.expand(f.x,'nxref:msg:'+sent.message_id),'[nxref msg:'+sent.message_id+']\n来源前缀 '+content+' 来源后缀\n[/nxref]');
  const f2=fixture(t);f2.broker.references.capture(f2.x,'/root/finished',content);
  assert.equal(f2.broker.communicationTips.record(f2.x,content.slice(0,299),'agent','short'),undefined);
  assert.match(f2.broker.communicationTips.record(f2.x,content.slice(137,437),'agent','exact')!,/300 chars match agent \/root\/finished.*nxref:agent:\/root\/finished/);
  assert.equal(f2.broker.communicationTips.record(f2.c,content,'agent','foreign'),undefined);
  const f3=fixture(t);f3.store.pair(f3.c.id,f3.x.id);f3.broker.references.capture(f3.x,'long',content.repeat(4));
  assert.match(f3.broker.communicationTips.record(f3.x,content.repeat(4),'partner','priority')!,/auto match check/);
});

test('已识别逐字载荷、已有引用不触发复用，旧配对及过期快照不作为来源',t=>{
  const f=fixture(t),pair=f.store.pair(f.c.id,f.x.id),body='可复用长内容'.repeat(100);
  const sent=f.broker.send({actor:{host:'claude',sessionId:'c',callId:'old'},message:body});
  for(const [i,text]of['原文：\n'+body,'verbatim:\n'+body,'```txt\n'+body+'\n```',JSON.stringify({payload:body}),body+' `nxref:msg:example`'].entries())assert.equal(f.broker.communicationTips.record(f.x,text,'partner','literal-'+i),undefined);
  const other=f.store.register(registration('claude','other'));f.store.pair(other.id,f.x.id,true);
  assert.equal(f.broker.communicationTips.record(f.x,body,'partner','old-pair'),undefined);
  f.store.pair(f.c.id,f.x.id,true);assert.notEqual(f.store.currentPair()!.id,pair.id);
  const expired=f.broker.send({actor:{host:'claude',sessionId:'c',callId:'expired'},message:body});f.store.requireSnapshot(expired.message_id);
  assert.equal(f.broker.communicationTips.record(f.x,body,'partner','expired'),undefined);
  assert.equal(f.store.message(sent.message_id).body,body);
});

test('生产发信先保留投递真相，提示不改正文、展开快照或幂等，统计在状态可见',async t=>{
  const f=fixture(t);f.store.pair(f.c.id,f.x.id);f.codex.probe=async()=>({state:'blocked',reasons:['故障'],checked_at:Date.now()});
  const actor={host:'claude',sessionId:'c',callId:'long',turnId:'native-turn'},body='长报告 '.repeat(600);
  const first:any=await f.broker.dispatch('send',{actor,message:body});assert.equal(first.status,'blocked');assert.match(first.message,/saved; delivery blocked/);assert.match(first.tip,/auto length check/);
  assert.equal(f.store.message(first.message_id).body,body);assert.equal(f.broker.references.message(f.store.message(first.message_id)),body);
  for(let i=0;i<65;i++)await f.broker.dispatch('tip.agent',{actor:{...actor,callId:'agent-'+i},text:'短任务'});
  const before=f.broker.communicationTips.summary(f.c.id),retry:any=await f.broker.dispatch('send',{actor,message:body});assert.equal(retry.tip,first.tip);assert.deepEqual(f.broker.communicationTips.summary(f.c.id),before);
  f.broker.references.capture(f.c,'huge','独立代理内容'.repeat(1000));
  const ref:any=await f.broker.dispatch('send',{actor:{...actor,callId:'ref',turnId:'next'},message:'nxref:agent:huge'});assert.equal(ref.tip,undefined);assert.equal(f.store.message(ref.message_id).body,'nxref:agent:huge');
  const full:any=await f.broker.dispatch('status',{}),small:any=await f.broker.dispatch('status',{actor,model_view:true});assert.equal(full.communicationTips[0].firings.report,1);assert.equal(small.communicationTips.firings.report,1);assert.equal(small.communicationTips.recent,undefined);
  assert.equal(f.broker.communicationTips.summary(f.c.id)?.total&&(f.broker.communicationTips.summary(f.c.id)!.total as any).chars,body.length+65*3+'nxref:agent:huge'.length);
});

test('长度提醒冷却满十次且换了上下文（压缩）才再次提醒，后续测量记录引用采用情况且窗口有界',t=>{
  const f=fixture(t),tips=f.broker.communicationTips;f.store.pair(f.c.id,f.x.id);
  assert.match(tips.record(f.x,'报告'.repeat(1200),'partner','first')!,/auto length/);
  for(let i=1;i<10;i++)assert.equal(tips.record(f.x,'报告'.repeat(1200),'partner','cooldown-'+i),undefined);
  assert.equal(tips.record(f.x,'报告'.repeat(1200),'partner','same-context'),undefined,'冷却满十次但仍是同一上下文');
  tips.cooperation.compacted(f.store.peer(f.x.id),'compact-1');
  assert.match(tips.record(f.x,'报告'.repeat(1200),'partner','tenth')!,/auto length/);
  tips.record(f.x,'nxref:msg:used','partner','used');
  for(let i=0;i<40;i++)tips.record(f.x,'短','partner','sample-'+i);
  const stats:any=tips.summary(f.x.id);assert.equal(stats.firings.report,2);assert.equal(stats.following.report.nxref,1);assert.equal(stats.following.report.samples,20);assert.equal(stats.recent.length,32);assert.equal(stats.window.median,1);
});
