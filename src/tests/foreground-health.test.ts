import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './support/broker-fixture.js';
import { registration } from './support/registration.js';
import { temporary } from './support/temporary.js';
import path from 'node:path';
import { mkdirSync, writeFileSync, appendFileSync } from 'node:fs';
import { ForegroundHealth } from '../broker/health/foreground-health.js';
import { SILENCE_MS } from '../broker/health/turn-health.js';

test('嵌入窗口的原生开始、工具、审批和结束实际生成健康记录，普通状态查询不刷新进展',async t=>{
  t.mock.timers.enable({apis:['Date'],now:2000000});
  const f=fixture(t);f.store.saveEndpoint({...f.store.endpoint(f.x.id)!,mode:'embedded'});
  const peer=f.store.updatePeer(f.x.id,{activityAt:1,state:'ready'}),pair=f.store.pair(f.c.id,peer.id);
  const hook=(event:string,extra:Record<string,unknown>={})=>f.broker.dispatch('hook',{session_id:'x',hook_event_name:event,context_key:process.pid+':test:x',...extra});
  await hook('SessionStart');await hook('UserPromptSubmit',{prompt:'当前任务',turn_id:'current'});
  const health=()=>new ForegroundHealth(f.store).get(f.store.peer(peer.id))!;
  assert.equal(health().source,'native-hook');assert.equal(health().turnId,'current');assert.equal(health().lastProgressAt,Date.now());
  t.mock.timers.tick(1000);await hook('PreToolUse',{turn_id:'current',tool_use_id:'command',tool_name:'functions.exec'});
  assert.equal(health().state,'waitingTool');assert.deepEqual(health().tools,['command']);const progressAt=health().lastProgressAt;
  t.mock.timers.tick(1000);f.broker.status();f.broker.status();assert.equal(health().lastProgressAt,progressAt);
  await hook('PermissionRequest',{turn_id:'current'});assert.equal(health().state,'needsHuman');
  await hook('PostToolUse',{turn_id:'current',tool_use_id:'command',tool_name:'functions.exec'});assert.equal(health().state,'running');
  assert.equal(f.store.peer(peer.id).state,'busy','完成审批工具后同步解除成员等待');
  const workAt=health().lastProgressAt;t.mock.timers.tick(1000);
  await hook('PostToolUse',{turn_id:'current',tool_use_id:'pickup',tool_name:'claude.receive_messages'});assert.equal(health().lastProgressAt,workAt,'取件不冒充继续执行任务');
  await hook('PostToolUse',{turn_id:'current',agent_id:'child',tool_name:'functions.exec'});assert.equal(health().lastProgressAt,workAt);
  f.broker.pairAnomalies.observe(pair,f.store.peer(peer.id),health());assert.deepEqual(f.broker.pairAnomalies.issues(peer.id),[]);
  await hook('Stop',{turn_id:'previous'});assert.equal(health().state,'running','旧轮结束不能结束新轮');
  await hook('Stop',{turn_id:'current'});assert.equal(health().state,'ready');
});

test('结束 hook 丢失后从同一原生历史结束事件校正，跨协调器重建和十一小时空闲不再误报',async t=>{
  t.mock.timers.enable({apis:['Date'],now:2000000});const f=fixture(t),home=temporary(t);mkdirSync(path.join(home,'sessions'));
  f.store.saveEndpoint({...f.store.endpoint(f.x.id)!,mode:'embedded',configHome:home});f.store.pair(f.c.id,f.x.id);
  f.broker.foregroundHealth.observe(f.x,'start','active');t.mock.timers.tick(1000);
  const file=path.join(home,'sessions','x.jsonl'),line=(type:string,payload:any)=>JSON.stringify({timestamp:new Date().toISOString(),type,payload})+'\n';
  writeFileSync(file,line('session_meta',{id:'x'})+line('turn_context',{approval_policy:'on-request',approvals_reviewer:'user',sandbox_policy:{type:'workspace_write'}})+line('event_msg',{type:'task_started',turn_id:'active'})+line('event_msg',{type:'task_complete',turn_id:'active'}),'utf8');
  t.mock.timers.tick(SILENCE_MS);assert.equal(new ForegroundHealth(f.store).get(f.x)?.state,'silent');
  await(f.broker as any).runtimeHealth.checkPairTurnHealth(f.store.pairFor(f.x.id));assert.equal(new ForegroundHealth(f.store).get(f.x)?.state,'ready');assert.equal(f.store.peer(f.x.id).permission,'prompting','权限刷新不能把结束状态写回旧快照');
  t.mock.timers.tick(11*60*60*1000);assert.equal(f.broker.foregroundHealth.get(f.x)?.state,'ready');
  f.broker.foregroundHealth.observe(f.x,'start','next');
  await(f.broker as any).runtimeHealth.checkPairTurnHealth(f.store.pairFor(f.x.id));assert.equal(f.broker.foregroundHealth.get(f.x)?.state,'running','旧结束记录不能结束新轮次');
  appendFileSync(file,line('event_msg',{type:'task_started',turn_id:'next'}),'utf8');await(f.broker as any).runtimeHealth.checkPairTurnHealth(f.store.pairFor(f.x.id));assert.equal(f.broker.foregroundHealth.get(f.x)?.state,'running');
  const canceled=t.mock.method(f.broker.questions,'cancelPeer');
  t.mock.timers.tick(1000);appendFileSync(file,line('event_msg',{type:'turn_aborted',turn_id:'next'}),'utf8');await(f.broker as any).runtimeHealth.checkPairTurnHealth(f.store.pairFor(f.x.id));assert.equal(f.store.peer(f.x.id).state,'paused','中断 hook 丢失时也尊重原生中断');assert.equal(canceled.mock.callCount(),1);
});

test('并行审批只解除匹配工具，旧轮次、无关回调和进展不能清除剩余人工等待',async t=>{
  const {store,broker,c,x}=fixture(t);store.pair(c.id,x.id);store.saveEndpoint({...store.endpoint(x.id)!,mode:'embedded'});
  const hook=(event:string,extra:Record<string,unknown>={})=>broker.dispatch('hook',{session_id:'x',hook_event_name:event,...extra});
  await hook('UserPromptSubmit',{prompt:'任务',turn_id:'current'});
  for(const id of ['a','b']){await hook('PreToolUse',{turn_id:'current',tool_use_id:id});await hook('PermissionRequest',{turn_id:'current',tool_use_id:id});}
  const check=()=>assert.equal(store.peer(x.id).state,'needsHuman');check();
  await hook('PostToolUse',{turn_id:'old',tool_use_id:'a'});check();
  await hook('PostToolUse',{turn_id:'current',tool_use_id:'unrelated'});check();
  await hook('PostToolUse',{turn_id:'current',tool_use_id:'a'});check();
  assert.equal((broker.receive({host:'codex',sessionId:'x',callId:'pending'}) as any).status,'paused');
  await hook('Stop',{turn_id:'old'});check();
  await hook('PostToolUse',{turn_id:'current',tool_use_id:'b',tool_response:{exit_code:1}});
  assert.equal(store.peer(x.id).state,'busy');assert.equal(broker.foregroundHealth.get(x)?.nativeIssue?.kind,'tool_failed');
  assert.equal((broker.receive({host:'codex',sessionId:'x',callId:'resumed'}) as any).status,'received');
  store.updatePeer(x.id,{state:'paused'});await hook('Stop',{turn_id:'current'});assert.equal(store.peer(x.id).state,'paused');
});

test('前台健康记录跨协调器对象保留，重新登记不擦除；切换上下文不沿用旧进展',t=>{
  t.mock.timers.enable({apis:['Date'],now:2000000});
  const f=fixture(t),input=registration('codex','window',{endpoint:{mode:'embedded',address:'',epoch:'native',pid:process.pid,procStart:'generation',configHome:'/foreground-health'}});
  const peer=f.store.register(input),before=f.store.bindings.current(peer.id)!;
  f.broker.foregroundHealth.observe(peer,'start','turn');t.mock.timers.tick(1000);f.broker.foregroundHealth.observe(peer,'tool_start','turn','tool');
  const saved=f.broker.foregroundHealth.get(peer)!;f.store.register(input);
  assert.deepEqual(new ForegroundHealth(f.store).get(peer),saved);
  t.mock.timers.tick(SILENCE_MS);assert.equal(new ForegroundHealth(f.store).get(peer)?.state,'waitingTool');
  const fresh=f.store.register({...input,sessionId:'new',contextStart:true});
  assert.notEqual(f.store.bindings.current(peer.id)?.epoch,before.epoch);assert.equal(new ForegroundHealth(f.store).get(fresh),undefined);
  f.broker.foregroundHealth.observe(fresh,'start','new-turn');assert.equal(f.broker.foregroundHealth.get(fresh)?.turnId,'new-turn');
});
