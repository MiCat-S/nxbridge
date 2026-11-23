import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fixture } from './support/broker-fixture.js';
import { daemonDelivery } from '../broker/delivery/delivery-guidance.js';
import { formatStatus } from '../integration/mcp/presentation.js';
import { MOD_REVISION } from '../mod-revision.js';

test('共享 daemon 的发送、状态和选择回执明确等待目标窗口原生输入，取件后提示消失',async t=>{
  const {store,broker,c,x}=fixture(t,{compatibilityWake:'strict'});
  store.saveEndpoint({...store.endpoint(x.id)!,mode:'embedded',configHome:path.resolve('/isolated-codex'),daemon:{address:'unix://test-daemon'}});
  const actor={host:'claude' as const,sessionId:'c',callId:'first'},selection=await broker.dispatch('send',{actor,message:'等待明确选择的任务'}) as any;
  assert.equal(selection.status,'selection_required');assert.equal(selection.candidates[0].delivery_mode,'daemon-pull');assert.match(selection.candidates[0].description,/输入.*消息.*取件/);
  const committed=await broker.dispatch('pair.selection.commit',{actor,selection_id:selection.selection_id,key:selection.candidates[0].key}) as any;
  assert.equal(committed.status,'paired');assert.equal(committed.delivery_wait.state,'waiting_native_input');assert.equal(committed.delivery_wait.session_id,'x');assert.match(committed.message,/尚未确认进入 Codex 上下文/);
  const sent=await broker.dispatch('send',{actor:{...actor,callId:'second'},message:'追加任务'}) as any;
  assert.equal(sent.status,'waiting_native_input');assert.equal(sent.delivery_state,'accepted');assert.equal(sent.read_confirmed,false);assert.equal(sent.delivery_wait.pending,2);assert.match(sent.message,/Codex 窗口「x」.*会话 x/);assert.match(sent.message,/nxbridge pickup/);assert.match(sent.message,/codex resume x/);assert.doesNotMatch(sent.message,/--no-daemon/);
  store.setPaused(true,committed.pair_id);
  const paused=await broker.dispatch('send',{actor:{...actor,callId:'while-paused'},message:'配对暂停时保存的任务'}) as any;
  assert.ok(paused.delivery_wait,JSON.stringify(paused));assert.equal(paused.delivery_wait.state,'paused');assert.match(paused.delivery_wait.message,/配对已暂停.*恢复配对/);
  store.setPaused(false,committed.pair_id);
  const full=await broker.dispatch('status',{actor}) as any,small=await broker.dispatch('status',{actor,model_view:true}) as any;
  const endpoint=store.endpoint(c.id)!,binding=store.bindings.activate({host:'claude',configHome:path.resolve('/isolated-claude'),pid:endpoint.pid!,procStart:endpoint.procStart!},c.id,'c','test');
  store.saveEndpoint({...endpoint,bindingEpoch:binding.epoch,modRevision:MOD_REVISION});
  const mod=await (broker as any).modRead({...actor,binding:{key:binding.key,epoch:binding.epoch}},'status',{sessionId:'c',native:{pid:endpoint.pid,procStart:endpoint.procStart},revision:MOD_REVISION},endpoint.epoch);
  for(const value of [full,small,mod]){assert.equal(value.partner.delivery_mode,'daemon-pull');assert.equal(value.partner.delivery_wait.state,'waiting_native_input');assert.equal(value.partner.delivery_wait.pending,3);}
  assert.match(formatStatus(full),/在Codex 窗口.*nxbridge pickup/);
  const received=broker.receive({host:'codex',sessionId:'x',callId:'pickup'}) as any;assert.equal(received.messages.length,3);
  for(const message of received.messages)store.transition(message.message_id,'contextObserved','测试原生上下文回执');
  assert.equal((broker.status(actor) as any).partner.delivery_wait,undefined);
});

test('daemon 取件提示区分忙碌、暂停、人工等待、上下文切换和离线，不要求重开活跃窗口',async t=>{
  const {store,broker,c,x}=fixture(t,{compatibilityWake:'strict'});store.pair(c.id,x.id);
  const endpoint={...store.endpoint(x.id)!,mode:'embedded' as const,daemon:{address:'unix://test-daemon'}};store.saveEndpoint(endpoint);
  const actor={host:'claude',sessionId:'c',callId:'busy'};store.updatePeer(x.id,{state:'busy'});
  const sent=await broker.dispatch('send',{actor,message:'忙碌线程的任务'}) as any;
  assert.equal(sent.status,'waiting_native_interaction');assert.match(sent.message,/工具调用后取件/);
  for(const [state,expected] of [['ready','waiting_native_input'],['busy','waiting_native_interaction'],['paused','paused'],['needsHuman','needs_human'],['offline','offline']] as const){
    const guidance=daemonDelivery({...x,state},endpoint,1);assert.equal(guidance.delivery_wait?.state,expected);
    assert.match(guidance.delivery_wait!.message,/如原窗口已关闭.*codex resume x.*同一会话.*nxbridge pickup/);
    if(state==='needsHuman')assert.match(guidance.delivery_wait!.message,/不会自动批准/);
    assert.doesNotMatch(guidance.delivery_wait!.message,/重启/);
  }
  assert.equal(daemonDelivery(x,endpoint,1,true).delivery_wait?.state,'context_changing');
  assert.deepEqual(daemonDelivery(x,endpoint,0),{delivery_mode:'daemon-pull'});
  assert.deepEqual(daemonDelivery(x,store.endpoint(c.id),1),{});
});

test('status 文本：模型服务挡住 Codex 时显示原因而不是原因未知，不给恢复命令',()=>{
  const at=Date.parse('2026-11-09T07:28:00Z');
  const partner=(blocking:boolean)=>({id:'x',host:'codex',name:'Codex',state:'busy',health:{state:'silent',turnId:'t',lastProgressAt:at-600000,tools:[],modelRequest:{state:'retrying',kind:'http',statusCode:503,at,source:'native-log',blocking}}});
  const text=formatStatus({paired:true,self:{id:'c',host:'claude',name:'Claude',state:'ready'},partner:partner(true),pending:0,questions:0});
  assert.match(text,/模型服务暂时不可用（返回 503），正在自动重试/);assert.doesNotMatch(text,/原因未知|recover/);
  assert.match(formatStatus({paired:true,self:{id:'c',host:'claude',name:'Claude',state:'ready'},partner:partner(false),pending:0,questions:0}),/原因未知/);
});

test('status 文本：子代理已做完但没法确认主线程接着处理时写出原因，不说成没处理',()=>{
  const partner=(childCompletions?:any)=>({id:'x',host:'codex',name:'Codex',state:'ready',...(childCompletions?{childCompletions}:{})});
  const text=formatStatus({paired:true,self:{id:'c',host:'claude',name:'Claude',state:'ready'},partner:partner({unconfirmed:1,needsWake:1,awaitingContext:1,batchId:'b',hold:{batchId:'b',reason:'唤醒次数已用完，自动尝试已停止'}}),pending:0,questions:0});
  assert.match(text,/子代理已做完，尚未确认主线程接着处理：唤醒次数已用完，自动尝试已停止/);assert.doesNotMatch(text,/未读|没人/);
  assert.doesNotMatch(formatStatus({paired:true,self:{id:'c',host:'claude',name:'Claude',state:'ready'},partner:partner({unconfirmed:1,needsWake:0,awaitingContext:1,hold:null}),pending:0,questions:0}),/子代理/);
});

test('status 文本：Codex 结束一轮没告诉 Claude，只在达到上限或来源确认不了时提示；处理中的正常状态不显示',()=>{
  const text=(final_forward?:any)=>formatStatus({paired:true,self:{id:'c',host:'claude',name:'Claude',state:'ready'},partner:{id:'x',host:'codex',name:'Codex',state:'ready',...(final_forward?{final_forward}:{})},pending:0,questions:0});
  assert.match(text({pending:true,hold:'cap_reached',consecutive:2,cap:2,turn_id:'t'}),/已连续自动转给 Claude 2\/2 次，这次不再自动转/);
  assert.match(text({pending:true,hold:'history_unavailable',consecutive:0,cap:2}),/读不到它的历史记录来核对/);
  assert.match(text({pending:false,hold:'origin_unverified',consecutive:0,cap:2}),/确认不了这一轮是不是你自己开始的/);
  assert.doesNotMatch(text({pending:false,hold:'history_unavailable',consecutive:0,cap:2}),/结束一轮没告诉 Claude/,'没有待转的一轮时，历史读不到不能说成 Codex 没告诉 Claude');
  for(const hold of [null,'partner_not_read','children_pending','codex_turn_running','history_pending','question_pending','partner_reported'])assert.doesNotMatch(text({pending:hold!==null,hold,consecutive:1,cap:2}),/结束一轮没告诉 Claude/);
  assert.doesNotMatch(text(),/结束一轮没告诉 Claude/);
});

test('读不到最新一步时状态只说进度暂时无法观测，不说没有进展；有进度证据时照旧',()=>{
  const status=(health:any)=>formatStatus({paired:true,self:{id:'c',host:'claude',name:'Claude',state:'busy'},partner:{id:'x',host:'codex',name:'Codex',state:'busy',health},pending:0,questions:0});
  const silent={state:'silent',turnId:'t',lastProgressAt:Date.now()-11*60000,tools:[]};
  assert.match(status(silent),/分钟没有进展，原因未知/);
  const unverified=status({...silent,progressEvidence:false});
  assert.match(unverified,/进度暂时无法观测/);assert.doesNotMatch(unverified,/没有进展/);
});
