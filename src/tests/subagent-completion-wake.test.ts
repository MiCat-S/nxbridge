import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fixture } from './support/broker-fixture.js';
import { temporary } from './support/temporary.js';
import { registration } from './support/registration.js';
import { SubagentCompletions } from '../broker/subagent-completions.js';
import { CODEX_WAKE_RETRY_MS } from '../hosts/codex/codex-wake.js';
import { BridgeError, DeliveryError } from '../shared/errors.js';
import { HEALTH_WAKE_NOTICE, WAKE_NOTICE } from '../types.js';
import { hook as nativeHook } from '../integration/hooks/hook-control.js';
import { hookClient } from '../integration/hooks/hook-client.js';
import { overrideEnvironment } from './support/environment.js';

function setup(t:TestContext){
  const f=fixture(t),pair=f.store.pair(f.c.id,f.x.id),broker=f.broker as any;
                                   
  broker.pump=async()=>{};
  let native=0,queued=0;
  (f.codex as any).wakeSubagents=async(_p:any,_e:any,_s:any,authorize:()=>Promise<boolean>)=>await authorize()?'wake-'+(++native):undefined;
  (f.codex as any).queueWake=async(_p:any,_e:any,authorize:()=>Promise<void>,spawn:()=>void)=>{await authorize();spawn();queued++;};
  (f.codex as any).queueWakeReady=async()=>true;
  const peer=()=>f.store.peer(f.x.id),endpoint=()=>f.store.endpoint(f.x.id)!,ledger=f.broker.subagentCompletions;
  const hook=(event:string,fields:Record<string,unknown>={})=>f.broker.dispatch('hook',{session_id:'x',actor:{host:'codex',sessionId:'x',callId:'completion-hook'},hook_event_name:event,...fields}) as Promise<any>;
  const child=(id='child',turn='run',file?:string)=>hook('SubagentStop',{agent_id:id,turn_id:turn,...(file?{transcript_path:file}:{})});
  const signal=()=>broker.signalCodexWake(peer(),endpoint());
  const prompt=(text=HEALTH_WAKE_NOTICE)=>hook('UserPromptSubmit',{prompt:text,turn_id:'parent-next'});
  return{...f,broker,pair,peer,endpoint,ledger,hook,child,signal,prompt,counts:()=>({native,queued})};
}

test('多个直属子结果跨实例和并发只提交一轮，带上已有搭档消息，重复输入静默丢弃',async t=>{
  const f=setup(t);
  await f.child('first','run-1');await f.child('second','run-2');await f.child('first','run-1');
  assert.equal(new SubagentCompletions(f.store).pending(f.peer()),true);
  f.store.accept(f.pair,f.c,'搭档工作','partner-task');
  await Promise.all(Array.from({length:12},f.signal));
  assert.deepEqual(f.counts(),{native:1,queued:0});
  assert.equal(f.ledger.pending(f.peer()),false,'已提交的提醒不自动重放');
  assert.equal(f.ledger.available(f.peer()),true,'提交不等于已读取或 hook 消费');
  const delivered=await f.prompt(WAKE_NOTICE),context=delivered.hookSpecificOutput.additionalContext;
  assert.match(context,/first/);assert.match(context,/second/);assert.match(context,/receive_messages/);
  assert.match(context,/Do not restart or rerun/);assert.match(context,/within this turn/);
  assert.equal(f.ledger.available(f.peer()),false);
  f.store.updatePeer(f.x.id,{state:'ready'});
  await f.signal();assert.equal(f.counts().native,1);
                                      
  await f.broker.dispatch('receive',{host:'codex',sessionId:'x',callId:'read-partner'});
  f.store.updatePeer(f.x.id,{state:'ready'});
  assert.deepEqual(await f.prompt(),{continue:false});
});

test('相同子代理的新轮次可再提醒；缺少原生终止身份、不配对和子线程均不启用',async t=>{
  const f=setup(t);
  await f.child();await f.signal();await f.prompt();
  f.store.updatePeer(f.x.id,{state:'ready'});
  await f.child();await f.signal();assert.equal(f.counts().native,1);
  await f.child('child','followup');await f.signal();assert.equal(f.counts().native,2);
  const other=f.store.register(registration('codex','unpaired'));
  f.ledger.record(other,'child','run',undefined,undefined);assert.equal(f.ledger.pending(other),false);
  const nested=f.store.register(registration('codex','nested',{kind:'subagent',parentId:'x'}));
  f.ledger.record(nested,'grandchild','run',undefined,undefined);assert.equal(f.ledger.pending(nested),false);
  await f.hook('SubagentStop',{agent_id:'weak'});assert.equal(f.ledger.batch(f.peer()),undefined);
});

test('结果在父模型最后一步后到达仍唤醒，已有后续模型输出则不额外唤醒',async t=>{
  for(const read of [false,true])await t.test(String(read),async sub=>{
    const f=setup(sub),file=path.join(temporary(sub),'parent.jsonl'),row=(value:unknown)=>JSON.stringify(value)+'\n';
    writeFileSync(file,row({type:'session_meta',payload:{id:'x'}})+row({type:'event_msg',payload:{type:'task_started',turn_id:'parent'}}),'utf8');
    const output={type:'response_item',payload:{type:'message',role:'assistant',content:[{type:'output_text',text:'父线程输出'}]}};
    appendFileSync(file,row(output),'utf8');
    f.store.updatePeer(f.x.id,{state:'busy'});await f.child('child','run',file);await f.signal();assert.equal(f.counts().native,0);
    appendFileSync(file,row({type:'response_item',payload:{type:'message',role:'user',content:[{type:'input_text',text:'<subagent_notification>\n'+JSON.stringify({agent_path:'child',status:{completed:'结果'}})+'\n</subagent_notification>'}],internal_chat_message_metadata_passthrough:{content_item_kinds:['multi_agent.subagent_notification']}}}), 'utf8');
    if(read)appendFileSync(file,row(output),'utf8');
    await f.hook('Stop',{turn_id:'parent',transcript_path:file});
    f.store.updatePeer(f.x.id,{state:'ready'});await f.signal();
    assert.equal(f.counts().native,read?0:1);
  });
});

test('运行时闸门同时抑制自动提交和系统输入消费，用户正常恢复可领取事实',async t=>{
  const gates=['pair_pause','interrupt','human','self_disabled','partner_disabled','pending_context','profile','conflict'] as const;
  for(const gate of gates)await t.test(gate,async sub=>{
    const f=setup(sub);await f.child();
    if(gate==='pair_pause')f.store.setPaused(true,f.pair.id);
    if(gate==='interrupt')await f.hook('Interrupt',{turn_id:'parent'});
    if(gate==='human')f.store.updatePeer(f.x.id,{state:'needsHuman'});
    if(gate==='self_disabled')f.store.updatePeer(f.x.id,{enabled:false});
    if(gate==='partner_disabled')f.store.updatePeer(f.c.id,{enabled:false});
    if(gate==='pending_context')f.store.saveEndpoint({...f.endpoint(),pendingContext:true});
    if(gate==='profile')f.broker.profiles.blocks=()=>true;
    if(gate==='conflict')f.store.setSetting('managedSessionConflict:'+f.x.id,{conflict:true});
    if(gate==='self_disabled')await assert.rejects(f.signal(),{code:'member_disabled'});else await f.signal();
    assert.deepEqual(f.counts(),{native:0,queued:0});
    const input=await f.prompt();
    assert.equal(input.continue,false);
    assert.equal(f.ledger.available(f.peer()),gate!=='pending_context','切换中的旧上下文事实作废，其余保留');
  });
  const f=setup(t);await f.child();await f.hook('Interrupt',{turn_id:'parent'});
  const user=await f.prompt('继续刚才的任务');assert.match(user.hookSpecificOutput.additionalContext,/own_subagents_completed/);
});

test('异步最后核验期间暂停或原生跳过不消耗提醒预算，也不留下假提交',async t=>{
  const f=setup(t);await f.child();let skipped=0;
  (f.codex as any).wakeSubagents=async(_p:any,_e:any,_s:any,authorize:()=>Promise<boolean>)=>{skipped++;await authorize();return undefined;};
  for(let i=0;i<5;i++)await f.signal();
  assert.equal(skipped,5);assert.equal(f.ledger.pending(f.peer()),true);assert.equal(f.ledger.blocked(f.peer()),false);
  (f.codex as any).wakeSubagents=async(_p:any,_e:any,_s:any,authorize:()=>Promise<boolean>)=>{f.store.setPaused(true,f.pair.id);assert.equal(await authorize(),false);return undefined;};
  await f.signal();assert.equal(f.ledger.pending(f.peer()),true);assert.equal(f.counts().queued,0);
});

test('禁用时排队输入在 hook 入口停止，旧预约取消且不吞掉完成事实',async t=>{
  const f=setup(t);await f.child();await f.signal();assert.equal(f.ledger.blocked(f.peer()),true);
  f.broker.switchMember(f.peer(),false);assert.equal(f.ledger.blocked(f.peer()),false);assert.equal(f.ledger.available(f.peer()),true);
  const input={session_id:'x',hook_event_name:'UserPromptSubmit',prompt:HEALTH_WAKE_NOTICE};
  const result=await nativeHook('codex',input,()=>{},{home:f.broker.home,configHome:f.broker.config.codexHome,runtime:{pid:process.pid,procStart:'test',appServer:true} as any,call:(async()=>assert.fail('禁用的系统输入不能启动或联系 broker')) as any});
  assert.deepEqual(result,{continue:false});
  assert.deepEqual(await f.prompt(),{continue:false});
  const restore=overrideEnvironment({NXBRIDGE_HOME:f.broker.home});
  try{assert.deepEqual(await hookClient('codex',input,()=>{},async()=>assert.fail('轻量客户端不应回退或访问 broker')),{continue:false});}finally{restore();}
});

test('系统输入等待健康核验时先占住回合，切换端点不能消费新上下文的完成事实',async t=>{
  const f=setup(t);await f.child();
  f.broker.runtimeHealth.prepareNotices=async()=>{assert.equal(f.peer().state,'busy');await f.signal();assert.equal(f.counts().native,0);return[];};
  assert.notEqual((await f.prompt()).continue,false);
  const g=setup(t);await g.child();
  g.broker.runtimeHealth.prepareNotices=async()=>{
    const old=g.endpoint();g.store.deactivate(g.x.id,old.epoch);g.store.saveEndpoint({...old,epoch:'new-hook-context'});
    g.ledger.record(g.peer(),'new-child','run',undefined,undefined);return[];
  };
  assert.deepEqual(await g.prompt(),{continue:false});assert.equal(g.ledger.available(g.peer()),true);
});

test('确定未写入的传输拒绝走一次队列；已排队后自然恢复不丢失原预约',async t=>{
  const f=setup(t);await f.child();let primary=0;
  (f.codex as any).wakeSubagents=async()=>{primary++;throw new DeliveryError('-32601','不支持唤醒');};
  await f.signal();await f.signal();assert.equal(primary,1);assert.deepEqual(f.counts(),{native:0,queued:1});
  const natural=await f.prompt('继续');assert.match(natural.hookSpecificOutput.additionalContext,/child/);
  f.store.updatePeer(f.x.id,{state:'ready'});await f.child('late','run-2');await f.signal();
  assert.equal(primary,1,'自然输入后旧队列尚未消费，新完成加入旧预约');
  const queued=await f.prompt();assert.match(queued.hookSpecificOutput.additionalContext,/late/);
  f.store.updatePeer(f.x.id,{state:'ready'});assert.deepEqual(await f.prompt(),{continue:false});
  await f.child('next','run-3');await f.signal();assert.equal(f.counts().queued,2,'丢弃过期系统输入也必须释放已消费的预约');
});

test('主通道和队列提交结果不明都不重放，明确写入前失败则释放预约并受原预算限制',async t=>{
  for(const channel of ['native','queue'] as const)await t.test(channel,async sub=>{
    const f=setup(sub);await f.child();let calls=0;
    (f.codex as any).wakeSubagents=async(_p:any,_e:any,_s:any,authorize:()=>Promise<boolean>)=>{
      if(channel==='queue')throw new DeliveryError('-32601','不支持');
      calls++;await authorize();throw new DeliveryError('timeout','确认超时',true);
    };
    (f.codex as any).queueWake=async(_p:any,_e:any,authorize:()=>Promise<void>)=>{calls++;await authorize();throw new DeliveryError('queue_result_unknown','入队未知',true);};
    await f.signal();assert.equal(calls,1);
    assert.equal(new SubagentCompletions(f.store).pending(f.peer()),false);
    await f.signal();assert.equal(calls,1);assert.equal(f.ledger.available(f.peer()),true);
  });
  t.mock.timers.enable({apis:['Date'],now:1000000});
  const f=setup(t);await f.child();let attempts=0;
  (f.codex as any).wakeSubagents=async()=>{throw new DeliveryError('-32601','不支持');};
  (f.codex as any).queueWake=async(_p:any,_e:any,authorize:()=>Promise<void>)=>{attempts++;await authorize();throw new BridgeError('queue_route_unverified','写入前路由失效');};
  for(let i=0;i<6;i++){await f.signal();t.mock.timers.tick(30000);}
  assert.equal(attempts,3);assert.equal(f.ledger.pending(f.peer()),true);assert.equal(f.ledger.blocked(f.peer()),false);
});

test('未知完成唤醒超过合并期限后，新搭档消息仍能续跑且不重放完成提醒',async t=>{
  for(const channel of ['native','queue'] as const)await t.test(channel,async sub=>{
    sub.mock.timers.enable({apis:['Date'],now:1000000});
    const f=setup(sub);await f.child();let attempts=0;
    (f.codex as any).wakeSubagents=async(_p:any,_e:any,_s:any,authorize:()=>Promise<boolean>)=>{
      if(channel==='queue')throw new DeliveryError('-32601','不支持');
      attempts++;await authorize();throw new DeliveryError('timeout','确认超时',true);
    };
    (f.codex as any).queueWake=async(_p:any,_e:any,authorize:()=>Promise<void>)=>{attempts++;await authorize();throw new DeliveryError('queue_result_unknown','入队未知',true);};
    await f.signal();assert.equal(attempts,1);
    sub.mock.timers.tick(CODEX_WAKE_RETRY_MS);
    await f.signal();assert.equal(attempts,1,'过期只释放合并占用，不能重放未知的完成提醒');
    assert.equal(f.ledger.pending(f.peer()),false);assert.equal(f.ledger.available(f.peer()),true);
    const message=f.store.accept(f.pair,f.c,'新的搭档任务','after-unknown');
    await f.signal();await f.signal();
    assert.equal(f.codex.delivered.filter(row=>row.id===message.id).length,1,'新消息必须进入原父会话');
    assert.equal(f.codex.woken.length,1,'原父会话仍须为新搭档任务续跑');
    assert.equal(attempts,1,'新消息不能重复提交旧的子代理完成提醒');
    assert.match((await f.prompt(WAKE_NOTICE)).hookSpecificOutput.additionalContext,/own_subagents_completed/);
  });
});

test('没有消费边界的历史唤醒预约有期限，完成事实和通知去重不随占用过期',async t=>{
  for(const state of ['submitting','unknown','queued','submitted'] as const)await t.test(state,async sub=>{
    sub.mock.timers.enable({apis:['Date'],now:1000000});
    const f=setup(sub);await f.child();
    const id=f.ledger.reserve(f.peer(),'native');assert.ok(id);
    if(state!=='submitting')f.ledger.outcome(f.peer(),id,state);
    const restored=new SubagentCompletions(f.store);
    assert.equal(restored.blocked(f.peer()),true);
    assert.equal(restored.reserve(f.peer(),'native_existing'),undefined);
    sub.mock.timers.tick(CODEX_WAKE_RETRY_MS);
    assert.equal(restored.blocked(f.peer()),false);
    assert.equal(f.ledger.status(f.peer())?.wake?.state,state,'保留未确认唤醒的诊断事实');
    assert.equal(f.ledger.pending(f.peer()),false,'同一完成提醒仍然不能自动重放');
    assert.equal(f.ledger.available(f.peer()),true,'未读结果仍可随之后的正常输入领取');
    assert.ok(restored.reserve(f.peer(),'native_existing'),'既有搭档投递也必须能取得合并预约');
  });
});

test('提交超过合并窗口仍不能并发预约，提交返回后才开始计算占用期限',async t=>{
  t.mock.timers.enable({apis:['Date'],now:1000000});
  const f=setup(t);await f.child();
  let entered!:()=>void,finish!:(turn:string)=>void;
  const started=new Promise<void>(resolve=>entered=resolve),submitted=new Promise<string>(resolve=>finish=resolve);
  (f.codex as any).wakeSubagents=async(_p:any,_e:any,_s:any,authorize:()=>Promise<boolean>)=>{await authorize();entered();return submitted;};
  const work=f.signal();await started;
  try{
    t.mock.timers.tick(CODEX_WAKE_RETRY_MS+1000);
    assert.equal(f.ledger.blocked(f.peer()),true,'在途 RPC 不能因年龄放出第二次唤醒');
    assert.equal(f.ledger.reserve(f.peer(),'native_existing'),undefined,'未走信号串行队列的直接投递也不能重入');
  }finally{finish('slow-native-turn');}
  await work;
  assert.equal(f.ledger.blocked(f.peer()),true,'回执返回后重新起算合并期限');
  t.mock.timers.tick(CODEX_WAKE_RETRY_MS-1);assert.equal(f.ledger.blocked(f.peer()),true);
  t.mock.timers.tick(1);assert.equal(f.ledger.blocked(f.peer()),false);
});

test('合并期限过后仍按原生忙碌状态等待，慢启动的已接受唤醒不会重复续跑',async t=>{
  for(const stalePeer of [false,true])await t.test(stalePeer?'登记状态滞后':'登记为忙碌',async sub=>{
    sub.mock.timers.enable({apis:['Date'],now:1000000});
    const f=setup(sub);await f.child();await f.signal();
    const original=f.codex.injectionState.bind(f.codex);
    f.codex.injectionState=async(...args)=>{
      const value=await original(...args);
      value.thread.status.type='active';value.thread.turns=[{id:'wake-1',status:'inProgress'}];return value;
    };
    if(!stalePeer)f.store.updatePeer(f.x.id,{state:'busy'});
    sub.mock.timers.tick(CODEX_WAKE_RETRY_MS+1000);
    const message=f.store.accept(f.pair,f.c,'等待原轮次领取的新任务','slow-start');
    await f.signal();
    assert.equal(f.ledger.blocked(f.peer()),false,'合并占用已到期，真正的原生忙碌闸门仍生效');
    assert.deepEqual(f.counts(),{native:1,queued:0});assert.equal(f.codex.woken.length,0);
    assert.equal(f.store.message(message.id).state,'accepted');assert.equal(f.codex.delivered.length,0);
    if(stalePeer)assert.equal(f.broker.codexDirect.status(f.x.id).wait.native_status,'active');
    f.codex.injectionState=original;
    const input=await f.prompt(WAKE_NOTICE);assert.match(input.hookSpecificOutput.additionalContext,/own_subagents_completed/);
    await f.broker.dispatch('receive',{host:'codex',sessionId:'x',callId:'read-slow-start'});
    await f.hook('Stop',{turn_id:'wake-1'});f.store.updatePeer(f.x.id,{state:'ready'});await f.signal();
    assert.deepEqual(f.counts(),{native:1,queued:0});assert.equal(f.codex.woken.length,0,'消息由原来的唯一轮次领取');
  });
});

test('审批或身份拒绝不借队列绕过；最后入队边界重新核验配对',async t=>{
  for(const code of ['pending_approval','session_changed','codex_identity_conflict'])await t.test(code,async sub=>{
    const f=setup(sub);await f.child();(f.codex as any).wakeSubagents=async()=>{throw new DeliveryError(code,'拒绝');};
    await f.signal();assert.equal(f.counts().queued,0);
  });
  const f=setup(t);await f.child();(f.codex as any).wakeSubagents=async()=>{throw new DeliveryError('attach_failed','离线');};
  (f.codex as any).queueWake=async(_p:any,_e:any,authorize:()=>Promise<void>)=>{f.store.setPaused(true,f.pair.id);await authorize();assert.fail('暂停后不能入队');};
  await f.signal();assert.equal(f.ledger.pending(f.peer()),true);assert.equal(f.ledger.blocked(f.peer()),false);
  const noIdle=setup(t);await noIdle.child();
  (noIdle.codex as any).wakeSubagents=async()=>{throw new DeliveryError('-32601','不支持');};
  (noIdle.codex as any).queueWakeReady=async()=>false;
  await noIdle.signal();assert.equal(noIdle.counts().queued,0);assert.equal(noIdle.ledger.pending(noIdle.peer()),true);
});

test('完成受阻出现在状态和 Claude 的一次被动通知中，恢复后旧提示撤销',async t=>{
  const f=setup(t);await f.child();
  (f.codex as any).wakeSubagents=async()=>{throw new DeliveryError('attach_failed','离线');};
  (f.codex as any).queueWakeReady=async()=>false;
  await f.signal();
  const actor={host:'claude' as const,sessionId:'c',callId:'held-status'},status=f.broker.status(actor) as any;
  const issue=status.integrationIssues.find((issue:any)=>issue.code==='subagent_completion_held');
  assert.ok(issue);assert.equal(issue.owner,'user');assert.equal(issue.session_id,'x');assert.equal(issue.name,'x');
  assert.match(status.partner.childCompletions.hold.reason,/未通过核验/);
  const notices=f.broker.deliveryHealth.peek(f.pair.id,f.c.id).filter((notice:any)=>notice.kind?.endsWith(':subagent_completion_held'));
  assert.equal(notices.length,1);assert.equal(notices[0].wake,false);
  f.broker.status(actor);assert.equal(f.broker.deliveryHealth.peek(f.pair.id,f.c.id).filter((notice:any)=>notice.kind?.endsWith(':subagent_completion_held')).length,1);
  assert.equal(f.claude.delivered.length,0);
  await f.prompt('继续');f.broker.status(actor);
  assert.equal(f.broker.deliveryHealth.peek(f.pair.id,f.c.id).some((notice:any)=>notice.kind?.endsWith(':subagent_completion_held')),false);
});

test('搭档直接投递期间到达的结果加入既有续跑，健康提醒也共用一轮',async t=>{
  const f=setup(t),original=f.codex.continueInjected.bind(f.codex);
  f.codex.continueInjected=async(peer,endpoint)=>{await f.child();return original(peer,endpoint);};
  f.store.accept(f.pair,f.c,'真实任务','direct');
  await f.signal();await f.signal();assert.equal(f.codex.woken.length,1);assert.equal(f.counts().native,0);
  const result=await f.prompt();assert.match(result.hookSpecificOutput.additionalContext,/own_subagents_completed/);
  const g=setup(t);await g.child();
  g.broker.deliveryHealth.enqueue(g.pair.id,g.x.id,{id:'health',kind:'explicit_recovery',state:'pending',message:'继续已有任务'});
  await (g.broker as any).runtimeHealth.checkDeliveryHealth();await g.signal();assert.equal(g.counts().native,1);
  const mixed=await g.prompt();assert.match(mixed.hookSpecificOutput.additionalContext,/继续已有任务/);assert.match(mixed.hookSpecificOutput.additionalContext,/own_subagents_completed/);
});

test('端点或配对改变后旧结果不再成为新会话的行动',async t=>{
  const f=setup(t);await f.child();const old=f.endpoint();f.store.deactivate(f.x.id,old.epoch);f.store.saveEndpoint({...old,epoch:'replacement'});
  await f.signal();assert.equal(f.ledger.pending(f.peer()),false);assert.equal(f.counts().native,0);
  await f.child('new-child','run-2');const other=f.store.register(registration('claude','other'));f.store.pair(other.id,f.x.id,true);
  await f.signal();assert.equal(f.ledger.pending(f.peer()),false);assert.equal(f.counts().native,0);
});
