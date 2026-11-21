import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fixture } from './support/broker-fixture.js';
import { registration } from './support/registration.js';
import { classifyCodexPermission, codexMetadataEvidence } from '../hosts/codex/codex-permission.js';
import { codexPermission } from '../hosts/codex/adapter.js';
import { permissionGuidance } from '../integration/mcp/permission-guidance.js';
import { nativeDeliveryWait } from '../broker/delivery/delivery-guidance.js';
import { pairIssues, MOD_STALE_GRACE_MS } from '../broker/pairing/pair-anomalies.js';
import { MOD_REVISION } from '../mod-revision.js';
import { VERSION } from '../version.js';
import { processIdentity } from '../process/process.js';

test('所有 Codex 原生证据共用分类器，完整访问本身不推断绕过，真实审查优先',()=>{
  for(const [sandbox,approval,autoReview,expected] of [
    ['read-only','bypass',false,'prompting'],['workspace-write','bypass',false,'prompting'],
    ['danger-full-access',undefined,undefined,'unknown'],['danger-full-access','bypass',false,'bypass'],
    ['danger-full-access','bypass',true,'bypass'],['danger-full-access','prompting',false,'prompting'],
  ] as const){
    assert.equal(classifyCodexPermission({sandbox,approval,autoReview}),expected);
    assert.equal(codexPermission({sandbox:{type:sandbox},approvalPolicy:approval==='bypass'?'never':approval==='prompting'?'on-request':undefined,autoReviewEnabled:autoReview}),expected);
    assert.equal(classifyCodexPermission(codexMetadataEvidence({sandbox_mode:sandbox,...(approval?{approval_policy:approval==='bypass'?'never':'on-request'}:{}),auto_review_enabled:autoReview})),expected);
  }
});

test('配对候选、提交、模型状态和 Mod 只读状态携带同一组权限事实，健康配对不告警',async t=>{
  const {store,broker,c,x}=fixture(t);store.updatePeer(c.id,{permission:'bypass'});
  const actor={host:'claude' as const,sessionId:'c',callId:'choose'};
  const selection=await broker.dispatch('send',{actor,message:'任务'}) as any;
  assert.equal(selection.candidates[0].permission_guidance.state,'class_mismatch');assert.match(selection.candidates[0].description,/权限类别不同/);
  const receipt=await broker.dispatch('pair.selection.commit',{actor,selection_id:selection.selection_id,key:selection.candidates[0].key}) as any;
  assert.equal(receipt.permission_guidance.sender_class,'prompting');assert.equal(receipt.permission_guidance.receiver_class,'bypass');
  assert.equal((await broker.dispatch('status',{actor,model_view:true}) as any).permission_guidance.state,'class_mismatch');
  const endpoint=store.endpoint(c.id)!,binding=store.bindings.activate({host:'claude',configHome:path.resolve('/permission-flow'),pid:endpoint.pid!,procStart:endpoint.procStart!},c.id,'c','test');
  store.saveEndpoint({...endpoint,bindingEpoch:binding.epoch,modRevision:MOD_REVISION});
  const mod=await (broker as any).modRead({...actor,binding:{key:binding.key,epoch:binding.epoch}},'status',{sessionId:'c',native:{pid:endpoint.pid,procStart:endpoint.procStart},revision:MOD_REVISION},endpoint.epoch);
  assert.equal(mod.permission_guidance.state,'class_mismatch');
  assert.equal(permissionGuidance(x,c,endpoint),undefined);
  assert.equal(permissionGuidance({...x,permission:'unknown'},{...c,permission:'prompting'},endpoint),undefined);
  assert.equal(permissionGuidance({...x,permission:'unknown'},{...c,permission:'bypass'},endpoint)?.state,'sender_unknown');
  for(const [policy,state] of [['hold','held'],['refuse','refused'],['accept',undefined]] as const)assert.equal(permissionGuidance(x,c,{...endpoint,nativeInbound:{policy,observedAt:Date.now()}})?.state,state);
});

test('待审批的后台发送返回暂停和原会话恢复入口，共享 daemon 与新空窗口准确区分',async t=>{
  const {store,broker,c,x}=fixture(t);store.pair(c.id,x.id);store.updatePeer(x.id,{owner:'nxbridge',state:'needsHuman'});
  const address=store.endpoint(x.id)!.address;
  broker.health.observe(address,{id:7,method:'item/commandExecution/requestApproval',params:{threadId:'x',turnId:'turn',itemId:'command'}});
  const result=await broker.dispatch('send',{actor:{host:'claude',sessionId:'c',callId:'approval'},message:'保留的任务'}) as any;
  assert.equal(result.status,'paused');assert.equal(result.delivery_wait.reason,'native_approval');assert.equal(result.delivery_wait.open_command,'nxbridge open codex --member '+x.id);
  assert.deepEqual(result.delivery_wait.native_request,{turn_id:'turn',item_id:'command',method:'item/commandExecution/requestApproval'});
  const peer=store.peer(x.id),endpoint=store.endpoint(x.id)!;
  assert.equal(nativeDeliveryWait({...peer,owner:'user'},endpoint,1).delivery_wait?.open_command,undefined);
  assert.equal(nativeDeliveryWait(peer,{...endpoint,daemon:{address:'native-daemon'}},1).delivery_wait?.open_command,undefined);
  const fresh=nativeDeliveryWait({...peer,sessionId:null,state:'ready'},{...endpoint,pendingContext:true},1).delivery_wait!;
  assert.equal(fresh.reason,'awaiting_first_prompt');assert.match(fresh.message,/输入一条消息/);
});

test('简短恢复命令只列同项目、存活、自有、正在等待的专用 Codex，多候选保留给终端选择',async t=>{
  const {store,broker,c,x}=fixture(t),native=await processIdentity(process.pid);store.pair(c.id,x.id);
  const activate=(id:string)=>{store.updatePeer(id,{owner:'nxbridge',state:'needsHuman'});store.saveEndpoint({...store.endpoint(id)!,pid:native.pid,procStart:native.startedAt});};
  activate(x.id);
  const list=async(cwd=c.cwd)=>(await broker.dispatch('open.candidates',{cwd}) as any).candidates;
  assert.deepEqual((await list()).map((row:any)=>row.member_id),[x.id]);assert.deepEqual(await list(path.resolve('/other-project')),[]);
  const other=store.register(registration('codex','other')),otherClaude=store.register(registration('claude','other-claude'));store.pair(otherClaude.id,other.id);activate(other.id);
  assert.equal((await list()).length,2);
  store.updatePeer(other.id,{owner:'user'});assert.equal((await list()).length,1);
  store.updatePeer(other.id,{owner:'nxbridge',state:'busy'});assert.equal((await list()).length,1);
  store.updatePeer(other.id,{state:'needsHuman'});store.saveEndpoint({...store.endpoint(other.id)!,daemon:{address:'native-daemon'}});assert.equal((await list()).length,1);
  store.saveEndpoint({...store.endpoint(x.id)!,procStart:'old-generation'});assert.deepEqual(await list(),[]);
});

test('实际纯 MCP 交互立即提示缺失 Mod，健康 Mod 和启动发现保留正常宽限',async t=>{
  const {store,broker,c,x}=fixture(t),pair=store.pair(c.id,x.id),detect=()=>{broker.pairAnomalies.observe(pair,store.peer(c.id));return broker.pairAnomalies.issues(c.id);};
  assert.deepEqual(detect(),[]);
  await broker.dispatch('register',{...registration('claude','c'),mcpInteraction:true});
  assert.equal((broker.status({host:'claude',sessionId:'c',callId:'mcp-status'}) as any).integrationIssues[0]?.code,'mod_missing');
  assert.equal(detect()[0]?.kind,'mod_missing');assert.match(detect()[0]!.message,/native \/reload-plugins/);
  store.saveEndpoint({...store.endpoint(c.id)!,questionSupport:true});broker.pairAnomalies.integration(c,{mod:true,modVersion:VERSION,modRevision:MOD_REVISION});
  assert.deepEqual(detect(),[]);
  await broker.dispatch('register',{...registration('claude','c'),mcpInteraction:true});assert.deepEqual(detect(),[]);
});

test('问答控制和不带修订的监测不抹去已核验 Mod；真正版本或上下文变化仍会失效',async t=>{
  t.mock.timers.enable({apis:['Date'],now:2000000});
  const {store,broker,c,x}=fixture(t),pair=store.pair(c.id,x.id),input=registration('claude','c',{endpoint:{...store.endpoint(c.id)!,questionSupport:true,modVersion:VERSION,modRevision:MOD_REVISION}});
  await broker.dispatch('register',input);t.mock.timers.tick(120001);
  await broker.dispatch('register',{...input,endpoint:{...input.endpoint,modVersion:undefined,modRevision:undefined}});
  await broker.dispatch('health.monitor',{actor:{host:'claude',sessionId:'c',callId:'question-monitor'},admit:false});
  broker.pairAnomalies.observe(pair,store.peer(c.id));assert.deepEqual(broker.pairAnomalies.issues(c.id),[]);
  assert.equal(broker.pairAnomalies.evidence(c).modRevision,MOD_REVISION);
  assert.equal(store.endpoint(c.id)!.modRevision,MOD_REVISION,'原生问答登记也不能破坏 Mod 只读通道的修订核验');
  await broker.dispatch('register',{...input,endpoint:{...input.endpoint,modVersion:'0.1.0',modRevision:undefined}});
  assert.equal(broker.pairAnomalies.evidence(c).modRevision,undefined);assert.equal(store.endpoint(c.id)!.modRevision,undefined);
  await broker.dispatch('register',input);
  const changed=await broker.dispatch('register',{...input,sessionId:'new-context',endpoint:{...input.endpoint,modVersion:undefined,modRevision:undefined}}) as typeof c;
  assert.equal(broker.pairAnomalies.evidence(changed).modRevision,undefined);assert.equal(store.endpoint(changed.id)!.modRevision,undefined);
});

test('Mod 异常只由本窗口处理；缺失或最近回执失败才给对端有界提示，恢复后撤销未送副本',async t=>{
  t.mock.timers.enable({apis:['Date'],now:2000000});
  const {store,broker,c,x}=fixture(t),pair=store.pair(c.id,x.id),input=registration('claude','c',{endpoint:{...store.endpoint(c.id)!,questionSupport:true}});
  const registered=await broker.dispatch('register',input) as typeof c;assert.equal(registered.id,c.id,'沿用夹具的原生配置目录，重复登记仍属于本窗口');
  broker.pairAnomalies.integration(c,{mod:true,modVersion:'0.1.0',modRevision:'0'.repeat(16)});t.mock.timers.tick(120001);
  const detect=()=>broker.pairAnomalies.observe(pair,store.peer(c.id));
  broker.pairAnomalies.integration(c,{mod:true});detect();assert.equal(broker.deliveryHealth.hasPending(pair.id,x.id),false);
  t.mock.timers.tick(MOD_STALE_GRACE_MS);broker.pairAnomalies.integration(c,{mod:true});detect();assert.equal(broker.deliveryHealth.hasPending(pair.id,c.id),true);
  const diagnostic={consecutive:1,last_error:{at:Date.now(),op:'state',code:'receipt_failed'}};
  await broker.dispatch('register',{...input,mod_operation:'state',mod_diagnostics:diagnostic});detect();
  const fallback=broker.deliveryHealth.peek(pair.id,x.id)[0]!;assert.match(fallback.message,/do not relay this to Claude/);assert.equal(broker.deliveryHealth.hasPending(pair.id,c.id),true);
  t.mock.timers.tick(1);await broker.dispatch('register',{...input,mod_operation:'state',mod_diagnostics:diagnostic});detect();
  assert.equal(broker.deliveryHealth.hasPending(pair.id,x.id),true,'同一次失败仍被上报时，不能让较新的心跳掩盖它');
  assert.equal(store.events().filter(event=>event.type==='mod.receipt.failure').length,1,'重复上报保留最新观察时间，不重复生成失败事件');
  t.mock.timers.tick(1);broker.pairAnomalies.integration(c,{mod:true});detect();assert.equal(broker.deliveryHealth.hasPending(pair.id,x.id),false,'修复回执但仍旧版时也撤销对端旧副本');
  const own=broker.deliveryHealth.peek(pair.id,c.id)[0]!;broker.deliveryHealth.outcome(pair.id,c.id,own.id,'submitted');detect();assert.equal(broker.deliveryHealth.hasPending(pair.id,c.id),false,'已递交提醒不重新排队');
  broker.pairAnomalies.integration(c,{mod:true,modVersion:VERSION,modRevision:MOD_REVISION});detect();assert.deepEqual(broker.pairAnomalies.issues(c.id),[]);
  assert.equal(broker.deliveryHealth.get(pair.id,x.id,fallback.id)?.state,undefined);
});

test('只有明确且尚未解决的原生拒绝在轮次结束后产生一次告警，非零退出仅为工具事实',t=>{
  const {store,broker,c,x}=fixture(t),pair=store.pair(c.id,x.id),base={turnId:'turn',lastProgressAt:Date.now(),lastEventAt:Date.now(),state:'ready' as const,tools:[]};
  const health={...base,nativeIssue:{kind:'approval_denied' as const,turn_id:'turn',item_id:'tool',at:Date.now()}},detect=(value=health)=>broker.pairAnomalies.observe(pair,x,value);
                             
  detect();detect();assert.equal(store.events().filter(event=>event.type==='health.pair.alert'&&(event.data as any).kind==='native_denied').length,0);assert.equal(broker.deliveryHealth.hasPending(pair.id,c.id),false);
  assert.equal(broker.pairAnomalies.issues(x.id)[0]?.kind,'native_denied');
  broker.pairAnomalies.observe(pair,x,{...base,nativeIssue:{...health.nativeIssue,kind:'tool_failed',exit_code:1}});assert.deepEqual(broker.pairAnomalies.issues(x.id),[]);
  assert.equal(pairIssues({pair,peer:x,now:Date.now(),messages:[],transitioning:false,questionPending:false,integration:{scope:'test',since:Date.now(),turnsWithoutHook:0},version:VERSION,health:{...health,state:'running'}}).some(issue=>issue.kind==='native_denied'),false);
});
