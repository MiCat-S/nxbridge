import test from 'node:test';
import assert from 'node:assert/strict';
import { codexIdentity, codexPartnerActor } from '../integration/mcp/server.js';
import { threadRegistration } from '../hosts/codex/adapter.js';
import type { Actor, Peer } from '../types.js';
import { fixture } from './support/broker-fixture.js';
import { registration } from './support/registration.js';

const cx:Actor={host:'codex',sessionId:'x',callId:'codex'},cc:Actor={host:'claude',sessionId:'c',callId:'claude'};
const questions=[{id:'scope',header:'范围',question:'处理哪些内容？'}];
const claudeQuestions=[{header:'范围',question:'处理哪些内容？',options:[{label:'甲',description:'第一项'},{label:'乙',description:'第二项'}],multiSelect:false}];

test('MCP 使用登记后的真实种类，元数据不能提升子代理，独立 fork 保留自己的配对',async t=>{
  const f=fixture(t);f.store.pair(f.c.id,f.x.id);
  const fork=f.store.register(threadRegistration({id:'fork',cwd:f.x.cwd,forkedFromId:'x',threadSource:'user'},'unix://test-server')!);
  const other=f.store.register(registration('claude','fork-partner'));f.store.pair(other.id,fork.id);
  f.store.register(threadRegistration({id:'child',cwd:f.x.cwd,parentThreadId:'x',threadSource:'subagent'},'unix://test-server')!);
  for(const id of ['x','fork','child']){
    const identity=codexIdentity({threadId:id,sessionId:id==='child'?id:'metadata-parent',callId:id},f.x.cwd,{pid:process.pid,procStart:'test',appServer:true});
    const registered=await f.broker.dispatch('mcp.register',identity.registration) as Peer;
    if(id==='child'){
      assert.equal(identity.registration.kind,'root');assert.equal(registered.kind,'subagent');
      assert.throws(()=>codexPartnerActor(identity.actor,registered),{code:'subagent_denied'});
    }else{
      const actor=codexPartnerActor(identity.actor,registered);assert.equal(actor.via,undefined);
      const sent=f.broker.send({actor,message:'独立会话发送'},false),message=f.store.message(sent.message_id);
      assert.equal(message.from,id==='fork'?fork.id:f.x.id);assert.equal(message.to,id==='fork'?other.id:f.c.id);
    }
  }
  for(const kind of ['unknown',undefined] as const)assert.throws(()=>codexPartnerActor(cx,{id:f.x.id,kind}),{code:'unverified_identity'});
});

for(const subagentSend of ['allow-verified','deny'] as const)test('Codex 子代理在 '+subagentSend+' 下均不能通过发信和提问入口产生副作用',async t=>{
  const f=fixture(t,{subagentSend,implicit:'on-demand'});
  const child=f.store.register(registration('codex','child',{kind:'subagent',parentId:'x'}));
  const initialPeers=f.store.peers().length;
  for(const via of [undefined,'child']){
    const actor:Actor={host:'codex',sessionId:'child',memberId:child.id,callId:'child-'+String(via),via};
    assert.throws(()=>f.broker.send({actor,message:'不应发送'},false),{code:'subagent_denied'});
    await assert.rejects(f.broker.dispatch('send',{actor,message:'不应启动配对或候选流程'}),{code:'subagent_denied'});
    await assert.rejects(f.broker.dispatch('question.create',{actor,questions}),{code:'subagent_denied'});
  }
  assert.equal(f.store.peers().length,initialPeers);assert.equal(f.store.pairs().length,0);
  assert.equal(f.store.messages().length,0);assert.equal(f.store.questions().length,0);assert.equal(f.claude.created.length,0);
});

test('Codex 回答、用户回答及取消旁路均拒绝子代理，根会话仍能正常回答',async t=>{
  const f=fixture(t);f.store.pair(f.c.id,f.x.id);
  f.store.register(registration('codex','child',{kind:'subagent',parentId:'x'}));
  const origin=f.broker.send({actor:cx,message:'交给 Claude 的任务'},false);
  const made=await f.broker.dispatch('question.create',{actor:cc,questions:claudeQuestions,task_message_id:origin.message_id}) as {request_id:string};
  const input={request_id:made.request_id,answers:{q1:{answers:['甲']}},rationale:'处理第一项。'},before=f.store.messages().length;
  for(const method of ['question.answer','question.answer_user'])await assert.rejects(f.broker.dispatch(method,{actor:{host:'codex',sessionId:'child',callId:method},input}),{code:'subagent_denied'});
  await assert.rejects(f.broker.dispatch('question.cancel',{actor:{host:'codex',sessionId:'child',callId:'cancel'},request_id:made.request_id}),{code:'subagent_denied'});
  await assert.rejects(f.broker.dispatch('question.cancel_turn',{actor:{host:'codex',sessionId:'child',callId:'cancel-turn'}}),{code:'subagent_denied'});
  assert.equal(f.store.question(made.request_id).status,'pending');assert.equal(f.store.messages().length,before);
  assert.equal((await f.broker.dispatch('question.answer',{actor:cx,input}) as {status:string}).status,'answered');
});

for(const processKind of ['app-server','foreground'] as const)test('失活路由和前台元数据不能改写已核验的子线程：'+processKind,async t=>{
  const f=fixture(t),configHome=f.x.cwd;
  const root=f.store.register(registration('codex','native-root',{endpoint:{mode:'embedded',address:'',epoch:'root-native',pid:process.pid,procStart:'test',configHome,processKind:'foreground'}}));
  const child=f.store.register(threadRegistration({id:'native-child',cwd:configHome,parentThreadId:'native-root',threadSource:'subagent'},'unix://test-server')!);
  for(const endpoint of f.store.endpoints(child.id)){f.store.saveEndpoint({...endpoint,native:{pid:process.pid,procStart:'test'}});f.store.deactivate(child.id,endpoint.epoch);}
  const before=f.store.bindings.current(root.id)!;
  const identity=codexIdentity({threadId:'native-child',sessionId:'native-child'},configHome,{pid:process.pid,procStart:'test',appServer:processKind==='app-server'});
  const registered=await f.broker.dispatch('mcp.register',identity.registration) as Peer;
  assert.equal(registered.id,child.id);assert.equal(registered.kind,'subagent');assert.equal(registered.parentId,'native-root');
  assert.equal(f.store.peer(root.id).sessionId,'native-root');assert.deepEqual(f.store.bindings.current(root.id),before);
  assert.throws(()=>codexPartnerActor(identity.actor,registered),{code:'subagent_denied'});
});

test('子线程取件不会消费主会话的待收消息',async t=>{
  const f=fixture(t);f.store.pair(f.c.id,f.x.id);
  const child=f.store.register(registration('codex','child',{kind:'subagent',parentId:'x'})),actor:Actor={host:'codex',sessionId:'child',memberId:child.id,callId:'pickup'};
  const sent=f.broker.send({actor:cc,message:'只交给主会话'},false),before=f.store.message(sent.message_id);
  assert.throws(()=>f.broker.receive(actor),{code:'subagent_denied'});
  await assert.rejects(f.broker.dispatch('receive',actor),{code:'subagent_denied'});
  assert.deepEqual(f.store.message(sent.message_id),before);assert.equal(f.store.pendingCount(f.x.id),1);
});

test('缺失 sessionId 不视作主会话，历史查询区分未登记和身份未知',async t=>{
  const f=fixture(t);
  assert.equal(codexIdentity({threadId:'legacy'}).registration.kind,'unknown');
  f.store.register(registration('codex','unknown',{kind:'unknown'}));
  for(const [sessionId,code] of [['missing','unregistered'],['unknown','unverified_identity']])await assert.rejects(f.broker.dispatch('messages.read',{actor:{...cx,sessionId},message_ids:['missing']}),{code});
});

test('缺失、未核验、伪造成员和过期租约不能绕过 Codex 出站身份检查',async t=>{
  const f=fixture(t);f.store.pair(f.c.id,f.x.id);
  f.store.register(registration('codex','unknown',{kind:'unknown'}));
  f.store.register(registration('codex','child',{kind:'subagent',parentId:'x'}));
  const window={host:'codex' as const,configHome:'/isolated-boundary',pid:111,procStart:'generation'};
  const previous=f.store.bindings.activate(window,f.x.id,'x','startup'),binding={key:previous.key,epoch:previous.epoch};
  f.store.bindings.activate(window,f.x.id,'x','reset');
  const cases:[Actor,string][]=[
    [{...cx,sessionId:'missing'},'unregistered'],
    [{...cx,sessionId:'unknown'},'unverified_identity'],
    [{...cx,sessionId:'child',memberId:f.x.id},'stale_context'],
    [{...cx,binding},'stale_context'],
  ];
  for(const [actor,code] of cases){
    assert.throws(()=>f.broker.send({actor,message:'无效身份'},false),{code});
    await assert.rejects(f.broker.dispatch('question.create',{actor,questions}),{code});
  }
  assert.equal(f.store.messages().length,0);assert.equal(f.store.questions().length,0);
});

for(const subagentSend of ['allow-verified','deny'] as const)test('Claude 子代理继续遵守全局 '+subagentSend+'，Codex 根会话不受影响',async t=>{
  const f=fixture(t,{subagentSend});f.store.pair(f.c.id,f.x.id);
  f.store.register(registration('claude','claude-child',{kind:'subagent',parentId:'c'}));
  const actor:Actor={host:'claude',sessionId:'claude-child',callId:'child'},created=await f.broker.dispatch('question.create',{actor:cx,questions}) as {request_id:string};
  const input={request_id:created.request_id,answers:{'处理哪些内容？':'甲'},rationale:'子代理核对完成。'};
  if(subagentSend==='deny'){
    assert.throws(()=>f.broker.send({actor,message:'子代理结果'},false),{code:'subagent_denied'});
    await assert.rejects(f.broker.dispatch('question.answer',{actor,input}),{code:'subagent_denied'});
  }else{
    const sent=f.broker.send({actor,message:'子代理结果'},false),message=f.store.message(sent.message_id);
    assert.equal(message.from,f.c.id);assert.equal(message.to,f.x.id);assert.equal(message.via,'claude-child');
    assert.equal((await f.broker.dispatch('question.answer',{actor,input}) as {status:string}).status,'answered');
  }
  const sent=f.broker.send({actor:{...cx,callId:'root-send'},message:'根会话继续工作'},false);assert.equal(f.store.message(sent.message_id).from,f.x.id);
});

test('Codex 子代理被禁止外联后，内部引用、提示及根会话结果登记继续正常工作',async t=>{
  const f=fixture(t);f.store.pair(f.c.id,f.x.id);
  const child=f.store.register(registration('codex','child',{kind:'subagent',parentId:'x'})),actor:Actor={host:'codex',memberId:child.id,sessionId:'child',callId:'internal'};
  await f.broker.dispatch('ref.capture',{actor:cx,agent_id:'completed',text:'已完成的子任务结论'});
  const expanded=await f.broker.dispatch('ref.expand',{actor,text:'引用 nxref:agent:completed'}) as {text:string};
  assert.equal(expanded.text,'引用 [nxref agent:completed]\n已完成的子任务结论\n[/nxref]');
  await f.broker.dispatch('tip.agent',{actor,text:'独立工作简报'});
  assert.deepEqual(await f.broker.dispatch('tip.sync',{actor}),{});
  assert.equal((await f.broker.dispatch('mcp.register',registration('codex','child',{kind:'root'})) as Peer).kind,'subagent');
  assert.throws(()=>f.broker.send({actor,message:'仍然不能外联'},false),{code:'subagent_denied'});
});
