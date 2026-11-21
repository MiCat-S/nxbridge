import test from 'node:test';
import assert from 'node:assert/strict';
import { pairIssues, MOD_STALE_GRACE_MS, type PairObservation } from '../broker/pairing/pair-anomalies.js';
import { SILENCE_MS } from '../broker/health/turn-health.js';
import { fixture } from './support/broker-fixture.js';
import { registration } from './support/registration.js';
import { MOD_REVISION } from '../mod-revision.js';

test('单次或被成功 hook 清除的超时不冒充信任错误，连续三次才进状态栏（第 1 档，不排队给模型）',async t=>{
  t.mock.timers.enable({apis:['Date'],now:1000000});
  const f=fixture(t),pair=f.store.pair(f.c.id,f.x.id),detect=()=>f.broker.pairAnomalies.observe(pair,f.store.peer(f.x.id));
  const timeout=()=>f.broker.pairAnomalies.integration(f.x,{hookError:'hook timed out after 3s'});
  timeout();detect();assert.deepEqual(f.broker.pairAnomalies.issues(f.x.id),[]);
  f.broker.pairAnomalies.integration(f.x,{hook:true});detect();assert.equal(f.broker.pairAnomalies.evidence(f.x).hookTimeouts,undefined);
  timeout();f.broker.pairAnomalies.integration(f.x,{hookSeen:true});timeout();detect();assert.deepEqual(f.broker.pairAnomalies.issues(f.x.id),[]);
  timeout();detect();assert.deepEqual(f.broker.pairAnomalies.issues(f.x.id),[],'三次瞬时超时仍不足六十秒');
  t.mock.timers.tick(60000);detect();assert.match(f.broker.pairAnomalies.issues(f.x.id)[0]!.message,/^hook timeout after \d+s; info only/);
  assert.equal(f.broker.deliveryHealth.hasPending(pair.id,f.c.id),false,'hook 超时只给用户看（第 1 档），不排队给模型');assert.equal(f.claude.delivered.length,0);
  f.broker.pairAnomalies.integration(f.x,{hook:true});detect();assert.deepEqual(f.broker.pairAnomalies.issues(f.x.id),[]);
  f.broker.pairAnomalies.integration(f.x,{hookError:'plugin untrusted'});detect();assert.equal(f.broker.pairAnomalies.issues(f.x.id)[0]!.kind,'hooks_blocked');
});

test('逐类异常有故障与正常对照：投递、上下文、Mod、hooks、停滞、长工具和无观测',t=>{
  const f=fixture(t),pair=f.store.pair(f.c.id,f.x.id),now=2000000;
  const base:PairObservation={pair,peer:{...f.c,state:'busy',stateSince:now,activityAt:now},endpoint:{...f.store.endpoint(f.c.id)!,questionSupport:true},now,messages:[],transitioning:false,questionPending:false,integration:{scope:'test',since:now-120001,turnsWithoutHook:0,modVersion:'0.1.1',modSeenAt:now},version:'0.1.1'};
  assert.deepEqual(pairIssues(base),[]);
  for(const state of ['accepted','sending','runtimeQueued','held','unknown','refused','expired'] as const){
    const message=f.store.accept(pair,f.x,'任务',state),value={...base,peer:{...base.peer,state:'ready' as const},messages:[{...message,state,updatedAt:now-120001}]};
    assert.ok(pairIssues(value).some(issue=>issue.kind==='delivery_'+state),state);
    assert.deepEqual(pairIssues({...value,messages:[{...message,state,updatedAt:now-119999}]}),[],state);
  }
  const health={turnId:'native-turn',lastProgressAt:now-SILENCE_MS-1,lastEventAt:now,state:'running' as const,tools:[]};
  for(const state of ['accepted','sending','runtimeQueued'] as const){
    const value={...base,messages:[{...f.store.messages()[0]!,state,updatedAt:now-120001}]};
    for(const healthy of [undefined,{...health,lastProgressAt:now},{...health,lastProgressAt:now,state:'waitingTool' as const,tools:['cmd']}])assert.equal(pairIssues({...value,health:healthy}).some(issue=>issue.kind==='delivery_'+state),false,state+' 有近期进展或无停滞证据');
    for(const stalled of [health,{...health,state:'waitingTool' as const,tools:['cmd']}])assert.ok(pairIssues({...value,health:stalled}).some(issue=>issue.kind==='delivery_'+state),state+' 长时间无进展');
  }
  const cases:{kind:string;fault:Partial<PairObservation>;normal:Partial<PairObservation>}[]=[
    {kind:'contract_inactive',fault:{replyContractActive:false},normal:{replyContractActive:true}},
    {kind:'context_stuck',fault:{transitioning:true,messages:[{...f.store.messages()[0]!,state:'accepted',updatedAt:now-120001}]},normal:{transitioning:true}},
    {kind:'mod_missing',fault:{endpoint:{...base.endpoint!,questionSupport:false}},normal:{}},
    {kind:'mod_stale',fault:{integration:{...base.integration,modVersion:'0.1.0'}},normal:{}},
    {kind:'hooks_blocked',fault:{peer:{...f.x},integration:{...base.integration,hookError:'plugin contents changed; hook approval required'}},normal:{peer:{...f.x}}},
    {kind:'hooks_missing',fault:{peer:{...f.x},integration:{...base.integration,turnsWithoutHook:2}},normal:{peer:{...f.x},integration:{...base.integration,turnsWithoutHook:0,lastHookAt:now}}},
    {kind:'turn_silent',fault:{health},normal:{health:{...health,lastProgressAt:now}}},
    {kind:'tool_wait',fault:{health:{...health,state:'waitingTool',tools:['cmd']}},normal:{health:{...health,lastProgressAt:now,state:'waitingTool',tools:['cmd']}}},
    {kind:'turn_retrying',fault:{health:{...health,state:'networkRetrying',retry:{message:'Reconnecting 1/5',since:now}}},normal:{health:{...health,lastProgressAt:now}}},
    {kind:'turn_failed',fault:{health:{...health,state:'failed',error:'真实错误'}},normal:{health:{...health,state:'ready'}}},
    {kind:'progress_unverified',fault:{peer:{...base.peer,stateSince:now-SILENCE_MS-1,activityAt:now-SILENCE_MS-1}},normal:{peer:{...base.peer,activityAt:now-SILENCE_MS-1}}},
  ];
  for(const entry of cases){assert.ok(pairIssues({...base,...entry.fault}).some(issue=>issue.kind===entry.kind),entry.kind);assert.equal(pairIssues({...base,...entry.normal}).some(issue=>issue.kind===entry.kind),false,entry.kind);}
  assert.equal(pairIssues({...base,health,questionPending:true}).some(issue=>issue.kind==='turn_silent'),false);
  assert.equal(pairIssues({...base,health,peer:{...base.peer,state:'needsHuman'}}).some(issue=>issue.kind==='turn_silent'),false);
  assert.equal(pairIssues({...base,health:{...health,state:'ready'}}).some(issue=>issue.kind==='turn_silent'),false,'原生轮次已经结束，不能用旧进展时间报告停滞');
  assert.equal(pairIssues({...base,peer:{...f.x,state:'busy'},endpoint:{...f.store.endpoint(f.x.id)!,mode:'embedded'},health}).some(issue=>issue.kind==='turn_silent'),true,'前台 Codex 没有 App Server 的轮次监测，仍须保留原生进展停滞提醒');
  assert.deepEqual(pairIssues({...base,peer:{...base.peer,state:'offline'},integration:{...base.integration,hookError:'错误',modVersion:'0.1.0',modSeenAt:0}}),[],'关闭的窗口不报告 Mod 或 hooks 缺失');
});

test('原生 hooks 证据按成员和上下文计数，恢复清除问题；旧 Mod 每种状态只通知一次',async t=>{
  t.mock.timers.enable({apis:['Date'],now:1000000});
  const f=fixture(t),pair=f.store.pair(f.c.id,f.x.id);
  f.broker.pairAnomalies.integration(f.x,{turn:true});f.broker.pairAnomalies.integration(f.x,{turn:true});
  f.broker.pairAnomalies.observe(pair,f.x);assert.ok(f.broker.pairAnomalies.issues(f.x.id).some(issue=>issue.kind==='hooks_missing'));
  f.broker.pairAnomalies.observe(pair,f.x);assert.equal(f.store.events(0,1000).filter(event=>event.type==='health.pair.alert').length,0,'hooks 缺失只进状态栏');assert.equal(f.broker.deliveryHealth.hasPending(pair.id,f.c.id),false);
  f.broker.pairAnomalies.integration(f.x,{hook:true});f.broker.pairAnomalies.observe(pair,f.x);assert.deepEqual(f.broker.pairAnomalies.issues(f.x.id),[]);assert.equal(f.broker.deliveryHealth.hasPending(pair.id,f.c.id),false);
  f.broker.pairAnomalies.evidence(f.c);f.store.saveEndpoint({...f.store.endpoint(f.c.id)!,questionSupport:true});t.mock.timers.tick(120001);
  f.broker.pairAnomalies.integration(f.c,{mod:true,modVersion:'0.1.0'});f.broker.pairAnomalies.observe(pair,f.store.peer(f.c.id));assert.ok(f.broker.pairAnomalies.issues(f.c.id).some(issue=>issue.kind==='mod_stale'));
  assert.equal(f.broker.deliveryHealth.hasPending(pair.id,f.c.id),false,'短暂版本变化先等待稳定，避免重载期间误报');
  t.mock.timers.tick(MOD_STALE_GRACE_MS);f.broker.pairAnomalies.integration(f.c,{mod:true});f.broker.pairAnomalies.observe(pair,f.store.peer(f.c.id));
  assert.equal(f.broker.deliveryHealth.hasPending(pair.id,f.c.id),true,'旧 Mod 的原窗口也能通过 monitor 收到自身异常');
  assert.equal(f.broker.deliveryHealth.hasPending(pair.id,f.x.id),false,'原窗口的 Mod 可用时只在该窗口处理，避免对端重复转述');
  f.broker.pairAnomalies.observe(pair,f.c);assert.equal(f.store.events(0,1000).filter(event=>event.type==='health.pair.alert'&&(event.data as any).kind==='mod_stale').length,1,'受影响窗口只通知一次');
  const monitored:any=await f.broker.dispatch('health.monitor',{actor:{host:'claude',sessionId:'c',callId:'old-mod-monitor'}});
                                               
  const ownNotice=monitored.notices.find((notice:any)=>/Claude Mod is outdated \(loaded 0\.1\.0[\s\S]*Call reload_plugins once now/.test(notice.message));assert.ok(ownNotice,'旧 Mod 已有的 monitor 入口实际返回自身异常');
  f.broker.deliveryHealth.outcome(pair.id,f.c.id,ownNotice.id,'submitted');
  f.broker.pairAnomalies.integration(f.c,{mod:true,modVersion:'0.1.1',modRevision:MOD_REVISION});f.broker.pairAnomalies.observe(pair,f.c);assert.deepEqual(f.broker.pairAnomalies.issues(f.c.id),[]);
  assert.equal(f.broker.deliveryHealth.hasPending(pair.id,f.c.id),false);assert.equal(f.broker.deliveryHealth.hasPending(pair.id,f.x.id),false);
  f.store.updatePeer(f.x.id,{sessionId:'new'});assert.equal(f.broker.pairAnomalies.evidence(f.store.peer(f.x.id)).turnsWithoutHook,0);
});

test('原生完成里的保护器 Warning 仍记为超时，正常成功才清除',t=>{
  const f=fixture(t),address=f.store.endpoint(f.x.id)!.address;
  const emit=(status:string,entries:any[])=>f.codex.emit('native',{address,message:{method:'hook/completed',params:{threadId:f.x.sessionId,run:{source:'plugin',sourcePath:'nxbridge/hooks',status,eventName:'interrupt',durationMs:2700,entries}}}});
  emit('completed',[{kind:'warning',text:'nxbridge hook timed out after 3s; result unconfirmed'}]);
  assert.equal(f.broker.pairAnomalies.evidence(f.x).hookTimeouts?.count,1);assert.equal(f.broker.pairAnomalies.evidence(f.x).hookTimeouts?.limitSeconds,3);
  emit('failed',[{kind:'error',text:'nxbridge hook timed out after 3s'}]);assert.equal(f.broker.pairAnomalies.evidence(f.x).hookTimeouts?.count,2);
  emit('completed',[{kind:'warning',text:'普通系统提示'}]);assert.equal(f.broker.pairAnomalies.evidence(f.x).hookTimeouts,undefined);
  const timing=(f.broker.status() as any).capabilities.hookTimings[0];assert.equal(timing.source,'codex hook/completed');assert.deepEqual(timing.events[0].samplesMs,[2700,2700,2700]);
  for(let index=0;index<50;index++)emit('completed',[]);assert.equal(f.broker.pairAnomalies.evidence(f.x).nativeHookDurations?.length,40);
});

test('同轮 UserPromptSubmit 在 turn/started 前完成仍是有效证据，下一轮真正缺失仍告警',t=>{
  t.mock.timers.enable({apis:['Date'],now:1000000});
  const f=fixture(t),pair=f.store.pair(f.c.id,f.x.id),address=f.store.endpoint(f.x.id)!.address;
  const emit=(method:string,turnId:string,params:Record<string,unknown>={})=>f.codex.emit('native',{address,message:{method,params:{threadId:f.x.sessionId,turnId,...params}}});
  emit('hook/completed','covered',{run:{source:'plugin',sourcePath:'nxbridge/hooks',status:'completed',eventName:'userPromptSubmit'}});
  t.mock.timers.tick(31);emit('turn/started','covered',{turn:{id:'covered'}});
  t.mock.timers.tick(120001);f.broker.pairAnomalies.observe(pair,f.x);
  assert.equal(f.broker.pairAnomalies.evidence(f.x).turnsWithoutHook,0);assert.deepEqual(f.broker.pairAnomalies.issues(f.x.id),[]);
  emit('turn/started','missing',{turn:{id:'missing'}});t.mock.timers.tick(120001);f.broker.pairAnomalies.observe(pair,f.x);
  assert.ok(f.broker.pairAnomalies.issues(f.x.id).some(issue=>issue.kind==='hooks_missing'));
  emit('hook/completed','missing',{run:{source:'plugin',sourcePath:'nxbridge/hooks',status:'completed'}});f.broker.pairAnomalies.observe(pair,f.x);
  assert.deepEqual(f.broker.pairAnomalies.issues(f.x.id),[]);assert.equal(f.broker.deliveryHealth.hasPending(pair.id,f.c.id),false);
                                                                
  t.mock.timers.tick(1);emit('turn/started','long',{turn:{id:'long'}});f.store.updatePeer(f.x.id,{state:'busy'});t.mock.timers.tick(30*60000);f.broker.pairAnomalies.observe(pair,f.store.peer(f.x.id));
  assert.equal(f.broker.pairAnomalies.issues(f.x.id).some(issue=>issue.kind==='hooks_missing'),false,'进行中的长轮次不报 hooks 缺失');
  f.store.updatePeer(f.x.id,{state:'ready'});f.broker.pairAnomalies.observe(pair,f.store.peer(f.x.id));
  assert.ok(f.broker.pairAnomalies.issues(f.x.id).some(issue=>issue.kind==='hooks_missing'),'本轮结束仍没有任何 hook（包括 Stop）才报');
});

test('以失败结束、没有 hook 的轮次不算 hooks 失效：时间分支和连续计数都不计；之后正常结束却没有 hook 的一轮仍告警',t=>{
  t.mock.timers.enable({apis:['Date'],now:1000000});
  const f=fixture(t),pair=f.store.pair(f.c.id,f.x.id),address=f.store.endpoint(f.x.id)!.address;
  const emit=(method:string,turnId:string,params:Record<string,unknown>={})=>f.codex.emit('native',{address,message:{method,params:{threadId:f.x.sessionId,turnId,...params}}});
  const missing=()=>{f.broker.pairAnomalies.observe(pair,f.store.peer(f.x.id));return f.broker.pairAnomalies.issues(f.x.id).some(issue=>issue.kind==='hooks_missing');};
  f.store.updatePeer(f.x.id,{state:'ready'});
                                                                
  emit('turn/started','ok',{turn:{id:'ok'}});emit('hook/completed','ok',{run:{source:'plugin',sourcePath:'nxbridge/hooks',status:'completed',eventName:'stop'}});
  t.mock.timers.tick(1000);emit('turn/started','f1',{turn:{id:'f1'}});t.mock.timers.tick(4000);
  emit('turn/completed','f1',{turn:{id:'f1',status:'failed',error:{message:'exceeded retry limit, last status: 429 Too Many Requests'}}});
  t.mock.timers.tick(120001);assert.equal(missing(),false,'失败的一轮没有 hook 不是 hooks 失效的证据');
  assert.equal(f.broker.pairAnomalies.evidence(f.store.peer(f.x.id)).turnsWithoutHook,0);
  emit('turn/started','f2',{turn:{id:'f2'}});emit('turn/completed','f2',{turn:{id:'f2',status:'failed'}});
  t.mock.timers.tick(120001);assert.equal(missing(),false,'连续两轮都失败也不算');
  emit('turn/started','done',{turn:{id:'done'}});emit('turn/completed','done',{turn:{id:'done',status:'completed'}});
  t.mock.timers.tick(120001);assert.ok(missing(),'正常结束却仍没有任何 hook：照常告警');
                                     
  const base:PairObservation={pair,peer:{...f.x,state:'ready'},endpoint:f.store.endpoint(f.x.id),now:Date.now(),messages:[],transitioning:false,questionPending:false,integration:{scope:'test',since:0,turnsWithoutHook:1,lastTurnAt:Date.now()-120001,lastTurnId:'x',lastHookAt:Date.now()-200000,lastHookTurnId:'w'},version:'0.1.1'};
  assert.ok(pairIssues(base).some(issue=>issue.kind==='hooks_missing'));
  assert.equal(pairIssues({...base,health:{turnId:'x',lastProgressAt:0,lastEventAt:0,state:'failed',tools:[]}}).some(issue=>issue.kind==='hooks_missing'),false);
});

test('服务拒绝请求本身（4xx，如模型要求更新版本的 Codex）：叫醒时说明通常会重复、请用户处理，最多再试一次、不反复重发',t=>{
  t.mock.timers.enable({apis:['Date'],now:1000000});
  const error=JSON.stringify({type:'error',status:400,error:{type:'invalid_request_error',message:"The 'gpt-6.1-sol' model requires a newer version of Codex. Please upgrade to the latest app or CLI and try again."}});
                                                                                  
  for(const parsed of [false,true]){
    const f=fixture(t),pair=f.store.pair(f.c.id,f.x.id);f.store.updatePeer(f.x.id,{state:'ready'});
    const modelRequest=parsed?{state:'failed' as const,kind:'http' as const,statusCode:400,at:Date.now(),source:'native-log' as const}:{state:'succeeded' as const,kind:'http' as const,statusCode:200,at:Date.now()-180000,source:'native-log' as const};
    const health={turnId:'t400',lastProgressAt:Date.now()-60000,lastEventAt:Date.now(),state:'failed' as const,tools:[],completion:'failed',error,modelRequest};
    f.broker.pairAnomalies.observe(pair,f.store.peer(f.x.id),health);t.mock.timers.tick(30000);f.broker.pairAnomalies.observe(pair,f.store.peer(f.x.id),health);
    const [notice]=f.broker.deliveryHealth.peek(pair.id,f.c.id);assert.equal(notice?.wake,true,String(parsed));
    assert.match(notice!.message,/provider refused the request \(400 invalid_request_error\)/);assert.match(notice!.message,/requires a newer version of Codex/);
    assert.match(notice!.message,/this usually repeats\. Tell the user the exact error[\s\S]*do not upgrade it yourself[\s\S]*at most one short resume msg[\s\S]*never loop resends/);assert.doesNotMatch(notice!.message,/send it one short resume msg|Quota\/auth/);
  }
});

test('忙碌且持续有进展仍可能做错任务：明确要求回复的任务在同步提示后再过一个周期才向委托方报告',async t=>{
  t.mock.timers.enable({apis:['Date'],now:1000000});
  const f=fixture(t),pair=f.store.pair(f.c.id,f.x.id),tips=f.broker.communicationTips;f.store.updatePeer(f.x.id,{effort:'xhigh'});
  const task=f.broker.send({actor:{host:'claude',sessionId:'c',callId:'task'},message:'当前任务',reply_expected:true},false);
  await f.broker.dispatch('observe',{actor:{host:'codex',sessionId:'x',callId:'seen'},message_id:task.message_id,state:'contextObserved'});
  f.store.updatePeer(f.x.id,{state:'busy'});
  const detect=(minutes=1)=>f.broker.pairAnomalies.observe(pair,f.store.peer(f.x.id),{turnId:'work',lastProgressAt:Date.now(),lastEventAt:Date.now(),state:'running',tools:[]},tips.syncReminder(f.x,minutes));
  t.mock.timers.tick(120000);detect();assert.deepEqual(f.broker.pairAnomalies.issues(f.x.id),[],'本地同步提示还未触发');
  assert.match(tips.syncTip(f.x,1)!,/no contact 2m/);t.mock.timers.tick(59999);detect();assert.deepEqual(f.broker.pairAnomalies.issues(f.x.id),[]);
  t.mock.timers.tick(1);detect();assert.match(f.broker.pairAnomalies.issues(f.x.id).find(issue=>issue.kind==='busy_unanswered')!.message,new RegExp(task.message_id));
  detect();assert.equal(f.store.events(0,1000).filter(event=>event.type==='health.pair.alert').length,1);
  assert.equal(f.broker.deliveryHealth.hasPending(pair.id,f.c.id),true);assert.equal(f.broker.deliveryHealth.hasPending(pair.id,f.x.id),false,'不打断忙碌的接收方');
  detect(0);assert.deepEqual(f.broker.pairAnomalies.issues(f.x.id),[],'同步提醒配置关闭时不升级');
  detect();f.broker.send({actor:{host:'codex',sessionId:'x',callId:'reply'},message:'当前结果'},false);
  detect();assert.deepEqual(f.broker.pairAnomalies.issues(f.x.id),[]);assert.equal(f.broker.deliveryHealth.hasPending(pair.id,f.c.id),false);
  assert.equal(f.store.messages().length,2,'系统提醒不成为搭档消息');
});

test('MCP 注册和监测使用同一同步提醒，不能撤回仍在等回复的通知',async t=>{
  t.mock.timers.enable({apis:['Date'],now:1000000});
  const f=fixture(t,{syncTipMinutes:1}),pair=f.store.pair(f.c.id,f.x.id),tips=f.broker.communicationTips;
  const task=f.broker.send({actor:{host:'codex',sessionId:'x',callId:'pending-task'},message:'当前任务',reply_expected:true},false);
  await f.broker.dispatch('observe',{actor:{host:'claude',sessionId:'c',callId:'seen-task'},message_id:task.message_id,state:'contextObserved'});
  f.store.updatePeer(f.c.id,{state:'busy',effort:'xhigh'});
  t.mock.timers.tick(120000);assert.ok(tips.syncTip(f.c,1));t.mock.timers.tick(60000);
  const detect=()=>f.broker.pairAnomalies.observe(pair,f.store.peer(f.c.id),undefined,tips.syncReminder(f.c,1));
  detect();const first=f.broker.pairAnomalies.issues(f.c.id).find(issue=>issue.kind==='busy_unanswered');assert.ok(first);
  await f.broker.dispatch('register',{...registration('claude','c',{state:'busy'}),mcpInteraction:true});
  assert.equal(f.broker.pairAnomalies.issues(f.c.id).find(issue=>issue.kind==='busy_unanswered')?.firstSeenAt,first.firstSeenAt);
  detect();assert.equal(f.store.events(0,1000).filter(event=>event.type==='health.pair.alert'&&(event.data as any).kind==='busy_unanswered').length,1,'不同入口刷新仍沿用同一条通知');
});

                                                                       
test('无待投递消息时宿主故障不打扰模型，正常空闲无告警；系统通知不写成任务消息',async t=>{
  t.mock.timers.enable({apis:['Date'],now:1000000});
  const f=fixture(t);f.store.pair(f.c.id,f.x.id);await f.broker.pump();assert.equal(f.claude.delivered.length,0);
  f.codex.probe=async()=>({state:'blocked',reasons:['native host exited'],checked_at:Date.now()});t.mock.timers.tick(30001);await f.broker.pump();
  assert.equal(f.claude.delivered.length,0);const picked=await f.broker.dispatch('health.monitor',{actor:{host:'claude',sessionId:'c',callId:'runtime-fact'}}) as any;
  assert.deepEqual(picked.notices,[],'没有依赖时不排队给模型');assert.equal(f.store.messages().length,0);
                                                           
  t.mock.timers.tick(6*60000);await f.broker.pump();assert.equal(f.claude.delivered.length,0);
  const later=(await f.broker.dispatch('health.monitor',{actor:{host:'claude',sessionId:'c',callId:'runtime-again'}}) as any).notices;
  assert.equal(later.filter((notice:any)=>/native host exited|undeliverable|runtime/.test(notice.message)&&!/Mod registration/.test(notice.message)).length,0,'持续故障但仍无依赖：依旧不打扰模型');
});

test('关闭期间到达的后台探测结果不能继续向宿主提交通知',async t=>{
  const f=fixture(t);f.store.pair(f.c.id,f.x.id);
  let release!:()=>void,started!:()=>void;const waiting=new Promise<void>(resolve=>{started=resolve;}),blocked=new Promise<void>(resolve=>{release=resolve;});
  f.codex.probe=async()=>{started();await blocked;return{state:'blocked',reasons:['native endpoint unavailable'],checked_at:Date.now()};};
  const pumping=f.broker.pump();await waiting;const stopping=f.broker.stop();release();await Promise.all([pumping,stopping]);
  assert.equal(f.codex.delivered.length+f.claude.delivered.length,0);assert.equal(f.store.messages().length,0);
});

test('对方模型服务重试只进状态栏；本方确实在等且持续 5 分钟才提醒一次，正文时间变化和短暂离线不重置起点',t=>{
  t.mock.timers.enable({apis:['Date'],now:1000000});
  const f=fixture(t),pair=f.store.pair(f.c.id,f.x.id);f.store.updatePeer(f.x.id,{state:'busy'});
  const health=()=>({turnId:'t',lastProgressAt:Date.now()-1000,lastEventAt:Date.now(),state:'running' as const,tools:[],modelRequest:{state:'retrying' as const,kind:'http' as const,statusCode:503,at:Date.now(),source:'native-log' as const}});
  const detect=()=>f.broker.pairAnomalies.observe(pair,f.store.peer(f.x.id),health());
  detect();assert.ok(f.broker.pairAnomalies.issues(f.x.id).some(issue=>issue.kind==='provider_retry'));
  t.mock.timers.tick(10*60000);detect();assert.equal(f.broker.deliveryHealth.hasPending(pair.id,f.c.id),false,'没人在等：常规 503 重试不打扰模型');
  const task=f.store.accept(pair,f.c,'需要回复的任务','task',undefined,undefined,'explicit',true);f.store.transition(task.id,'contextObserved');
  const first=f.broker.pairAnomalies.issues(f.x.id).find(issue=>issue.kind==='provider_retry')!.firstSeenAt;
                       
  f.store.updatePeer(f.x.id,{state:'offline'});detect();t.mock.timers.tick(30000);f.store.updatePeer(f.x.id,{state:'busy'});detect();
  assert.equal(f.broker.pairAnomalies.issues(f.x.id).find(issue=>issue.kind==='provider_retry')!.firstSeenAt,first,'正文里的时间变化和短暂离线不当作新问题');
                                                    
  assert.equal(f.broker.deliveryHealth.hasPending(pair.id,f.c.id),false,'依赖刚开始，不立即提醒');
  t.mock.timers.tick(4*60000);detect();assert.equal(f.broker.deliveryHealth.hasPending(pair.id,f.c.id),false);
  t.mock.timers.tick(60000);detect();
  assert.equal(f.broker.deliveryHealth.peek(pair.id,f.c.id).length,1,'从开始等待起已满 5 分钟：提醒一次');
  const notice=f.broker.deliveryHealth.peek(pair.id,f.c.id)[0]!;assert.equal(f.broker.deliveryHealth.get(pair.id,f.c.id,notice.id)?.tier,3);assert.equal(f.broker.deliveryHealth.get(pair.id,f.c.id,notice.id)?.wake,false);
  t.mock.timers.tick(60000);detect();assert.equal(f.store.events(0,1000).filter(event=>event.type==='health.pair.alert'&&(event.data as any).kind==='provider_retry').length,1,'持续重试不重复排队');
});

test('对方长时间没有进展：旧的沉默遇上新的等待不立即提醒；对方真实联系后从联系起重新计时',t=>{
  t.mock.timers.enable({apis:['Date'],now:1000000});
  const f=fixture(t),pair=f.store.pair(f.c.id,f.x.id);f.store.updatePeer(f.x.id,{state:'busy'});
  const progressAt=Date.now(),health=()=>({turnId:'t',lastProgressAt:progressAt,lastEventAt:Date.now(),state:'running' as const,tools:['long-command']});
  const detect=()=>f.broker.pairAnomalies.observe(pair,f.store.peer(f.x.id),health());
  t.mock.timers.tick(20*60000);detect();assert.ok(f.broker.pairAnomalies.issues(f.x.id).some(issue=>issue.kind==='tool_wait'));
  assert.equal(f.broker.deliveryHealth.hasPending(pair.id,f.c.id),false,'没人在等：长命令只进状态栏');
  const task=f.store.accept(pair,f.c,'需要回复的任务','task',undefined,undefined,'explicit',true);f.store.transition(task.id,'contextObserved');
  t.mock.timers.tick(4*60000);detect();assert.equal(f.broker.deliveryHealth.hasPending(pair.id,f.c.id),false,'沉默已 24 分钟，但才等了 4 分钟：不提醒');
  t.mock.timers.tick(11*60000);detect();assert.equal(f.broker.deliveryHealth.peek(pair.id,f.c.id).length,1,'等待满 15 分钟仍无进展：提醒一次');
  const notice=f.broker.deliveryHealth.peek(pair.id,f.c.id)[0]!;assert.equal(f.broker.deliveryHealth.get(pair.id,f.c.id,notice.id)?.wake,false);
                           
  f.store.accept(pair,f.x,'结果如下','reply',task.id);t.mock.timers.tick(1000);detect();
  assert.equal(f.broker.deliveryHealth.hasPending(pair.id,f.c.id),false,'对方已回复，撤回未送出的提醒');
});

test('拿不到最新一步的进度证据时只说无法观测，不当作没有进展',t=>{
  const f=fixture(t),pair=f.store.pair(f.c.id,f.x.id),now=2000000;
  const base:PairObservation={pair,peer:{...f.x,state:'busy',stateSince:now-700000,activityAt:now-700000},endpoint:{...f.store.endpoint(f.x.id)!,mode:'embedded'},now,messages:[],transitioning:false,questionPending:false,integration:{scope:'test',since:now-120001,turnsWithoutHook:0},version:'0.1.1'};
  const health={turnId:'t',lastProgressAt:now-660000,lastEventAt:now,state:'running' as const,tools:[]};
  const kinds=(value:any)=>pairIssues({...base,health:value}).map(issue=>issue.kind);
  assert.ok(kinds(health).includes('turn_silent'),'有进度证据时照旧判定没有进展');
  const unverified=kinds({...health,progressEvidence:false});
  assert.ok(unverified.includes('progress_unverified'));assert.equal(unverified.includes('turn_silent'),false,'只读到摘要时不断言没有进展');
});

test('搭档这一轮失败（原生重试用尽）：停下 30 秒后叫醒对方一次，不要求本方在等回复；短暂离线不撤回，同一轮不重复，新的失败轮次限频后再提醒',t=>{
  t.mock.timers.enable({apis:['Date'],now:1000000});
  const f=fixture(t),pair=f.store.pair(f.c.id,f.x.id);f.store.updatePeer(f.x.id,{state:'ready'});
  const failed=(turnId:string)=>({turnId,lastProgressAt:Date.now()-60000,lastEventAt:Date.now(),state:'failed' as const,tools:[],completion:'failed',error:'exceeded retry limit, last status: 429 Too Many Requests',modelRequest:{state:'failed' as const,kind:'quota' as const,statusCode:429,at:Date.now(),source:'native-log' as const}});
  let health:any=failed('t1');const detect=()=>f.broker.pairAnomalies.observe(pair,f.store.peer(f.x.id),health);
  const alerts=()=>f.store.events(0,1000).filter(event=>event.type==='health.pair.alert'&&(event.data as any).kind==='turn_failed').length;
  assert.equal(f.store.messages().length,0,'没有任何待回复的消息（实测 agscan 账本同样如此）');
  detect();assert.ok(f.broker.pairAnomalies.issues(f.x.id).some(issue=>issue.kind==='turn_failed'&&issue.terminal));
  assert.equal(f.broker.deliveryHealth.hasPending(pair.id,f.c.id),false,'刚失败：先等 30 秒，排队的消息或新一轮可能马上接上');
  t.mock.timers.tick(30000);detect();
  const [notice]=f.broker.deliveryHealth.peek(pair.id,f.c.id);assert.ok(notice,'停下满 30 秒：提醒对方');
  assert.equal(notice!.tier,4);assert.equal(notice!.wake,true,'没人会接着做：叫醒对方');
  assert.match(notice!.message,/turn t1 failed/);assert.match(notice!.message,/rate limit\/quota \(429\)/);assert.match(notice!.message,/will not resume this work by itself/);assert.match(notice!.message,/Quota\/auth errors usually persist/);
  assert.equal(alerts(),1);
                                           
  f.store.updatePeer(f.x.id,{state:'offline'});detect();assert.equal(f.broker.deliveryHealth.peek(pair.id,f.c.id)[0]?.id,notice!.id,'短暂离线不撤回');
  f.store.updatePeer(f.x.id,{state:'ready'});detect();assert.equal(f.broker.deliveryHealth.peek(pair.id,f.c.id)[0]?.id,notice!.id);assert.equal(alerts(),1);
                     
  assert.ok(f.broker.deliveryHealth.prepare(pair.id,f.c.id,notice!.id,f.broker.deliveryHealth.get(pair.id,f.c.id,notice!.id)!.scope));f.broker.deliveryHealth.outcome(pair.id,f.c.id,notice!.id,'submitted');
  t.mock.timers.tick(60000);detect();assert.equal(f.broker.deliveryHealth.hasPending(pair.id,f.c.id),false,'同一轮只提醒一次');assert.equal(alerts(),1);
                                                       
  health={...failed('t2'),state:'running' as const};f.store.updatePeer(f.x.id,{state:'busy'});detect();
  health=failed('t2');f.store.updatePeer(f.x.id,{state:'ready'});detect();assert.equal(f.broker.deliveryHealth.hasPending(pair.id,f.c.id),false,'新的失败轮次重新等 30 秒');
  t.mock.timers.tick(30000);detect();assert.equal(alerts(),2,'新的失败轮次是一件新的事');
  assert.equal(f.broker.deliveryHealth.peek(pair.id,f.c.id).length,0,'距上次提醒不到 10 分钟：先不送');
  t.mock.timers.tick(10*60000);detect();const [second]=f.broker.deliveryHealth.peek(pair.id,f.c.id);
  assert.notEqual(second?.id,notice!.id);assert.equal(second?.wake,true);assert.match(second!.message,/turn t2 failed/);
});

test('失败方又忙起来、有待答问题或被用户暂停时不叫醒；Claude 这一轮失败同样叫醒 Codex',t=>{
  t.mock.timers.enable({apis:['Date'],now:1000000});
  const f=fixture(t),pair=f.store.pair(f.c.id,f.x.id);
  const failed={turnId:'t',lastProgressAt:Date.now(),lastEventAt:Date.now(),state:'failed' as const,tools:[],error:'API Error: 529 overloaded'};
  for(const state of ['busy','paused','needsHuman','starting'] as const){
    f.store.updatePeer(f.x.id,{state});f.broker.pairAnomalies.observe(pair,f.store.peer(f.x.id),failed);t.mock.timers.tick(31000);f.broker.pairAnomalies.observe(pair,f.store.peer(f.x.id),failed);
    assert.equal(f.broker.deliveryHealth.peek(pair.id,f.c.id).length,0,state);
  }
  const base:PairObservation={pair,peer:{...f.x,state:'ready'},endpoint:f.store.endpoint(f.x.id),now:Date.now(),messages:[],transitioning:false,questionPending:true,integration:{scope:'test',since:0,turnsWithoutHook:0},version:'0.1.1',health:failed};
  assert.equal(pairIssues(base).some(issue=>issue.kind==='turn_failed'),false,'有待答问题：回答会开启新一轮');
                                                        
  f.store.updatePeer(f.c.id,{state:'ready'});
  f.broker.pairAnomalies.observe(pair,f.store.peer(f.c.id),failed);t.mock.timers.tick(30000);f.broker.pairAnomalies.observe(pair,f.store.peer(f.c.id),failed);
  const [notice]=f.broker.deliveryHealth.peek(pair.id,f.x.id);assert.equal(notice?.wake,true);assert.match(notice!.message,/\(claude\) turn t failed[\s\S]*native error: API Error: 529 overloaded/);
});

test('续跑或唤醒次数用完才叫醒发信方一次；仍在重试或结果不明只进状态；后台搭档与用户窗口给不同的下一步',t=>{
  t.mock.timers.enable({apis:['Date'],now:1000000});
  const f=fixture(t),pair=f.store.pair(f.c.id,f.x.id);f.store.updatePeer(f.x.id,{state:'ready'});
  const detect=()=>f.broker.pairAnomalies.observe(pair,f.store.peer(f.x.id));
  const direct=(continuation:object)=>f.store.setSetting('codexDirect:'+f.x.id,{scope:'direct-scope',attempts:[],continuation:{anchor:'nxbridge-m1',at:Date.now(),...continuation}});
  direct({attempts:1,error:'启动超时'});detect();
  const issue=f.broker.pairAnomalies.issues(f.x.id).find(issue=>issue.kind==='continuation_failed');
  assert.ok(issue);assert.equal(issue!.terminal,undefined);assert.match(issue!.message,/仍会自动重试/);assert.equal(f.broker.deliveryHealth.hasPending(pair.id,f.c.id),false,'还有重试次数：只进状态');
  direct({attempts:3,error:'启动超时',uncertain:true});detect();assert.equal(f.broker.deliveryHealth.hasPending(pair.id,f.c.id),false,'最后一次结果不明：可能已经续上');
  direct({attempts:3,error:'启动超时'});detect();
  const [notice]=f.broker.deliveryHealth.peek(pair.id,f.c.id);assert.equal(notice?.wake,true);
  assert.match(notice!.message,/starting its model failed 3 times \(启动超时\)/);assert.match(notice!.message,/do not resend the body/);
  assert.equal(f.store.peer(f.x.id).owner==='nxbridge',false);assert.match(notice!.message,/user-owned window: AI cannot restart it[\s\S]*no restart, no resend/);
  f.store.setSetting('codexDirect:'+f.x.id,null);detect();assert.equal(f.broker.deliveryHealth.hasPending(pair.id,f.c.id),false,'续跑恢复：撤回');
                                                        
  f.store.updatePeer(f.x.id,{state:'busy'});f.broker.pairAnomalies.integration(f.x,{pickup:{exhausted:true,attempts:3,anchor:'m1',scope:'wake-scope'}});detect();
  assert.ok(f.broker.pairAnomalies.issues(f.x.id).some(issue=>issue.kind==='pickup_exhausted'));assert.equal(f.broker.deliveryHealth.hasPending(pair.id,f.c.id),false,'对方忙：本轮结束可能取件');
  f.store.updatePeer(f.x.id,{state:'ready',owner:'nxbridge'});t.mock.timers.tick(10*60000);detect();
  const [pickup]=f.broker.deliveryHealth.peek(pair.id,f.c.id);assert.equal(pickup?.wake,true);
  assert.match(pickup!.message,/not picked up your msg\(s\) after 3 wake attempts/);assert.match(pickup!.message,/nxbridge-owned background partner: decide whether one short resume msg/);
});

test('传输断开期间才首次看到的失败轮次：端点仍存活时照常 30 秒后叫醒；端点已注销（进程退出）时不拿旧记录提醒',t=>{
  t.mock.timers.enable({apis:['Date'],now:1000000});
  const f=fixture(t),pair=f.store.pair(f.c.id,f.x.id);f.store.updatePeer(f.x.id,{state:'offline'});
  const failed={turnId:'t-offline',lastProgressAt:Date.now(),lastEventAt:Date.now(),state:'failed' as const,tools:[],error:'stream disconnected'};
  const detect=()=>f.broker.pairAnomalies.observe(pair,f.store.peer(f.x.id),failed);
  detect();t.mock.timers.tick(30000);detect();
  const [notice]=f.broker.deliveryHealth.peek(pair.id,f.c.id);assert.equal(notice?.wake,true,'端点仍存活：失败是同一会话的原生终态');
  f.store.deactivate(f.x.id);detect();
  assert.equal(f.broker.pairAnomalies.issues(f.x.id).some(issue=>issue.kind==='turn_failed'),false);assert.equal(f.broker.deliveryHealth.hasPending(pair.id,f.c.id),false,'端点已注销：撤回，不按旧记录提醒');
});
