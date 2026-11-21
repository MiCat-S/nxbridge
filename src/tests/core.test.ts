import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './support/broker-fixture.js';
import { registration } from './support/registration.js';
import {DeliveryError} from '../shared/errors.js';
import { codexIdentity } from '../integration/mcp/server.js';
import { threadRegistration } from '../hosts/codex/adapter.js';

test('双向独立发信、宿主调用幂等与关联回复',async t=>{
  const {store,broker,c,x,claude}=fixture(t);
  store.pair(c.id,x.id);
  const a=broker.send({actor:{host:'claude',sessionId:'c',callId:'c1'},message:'接口更新'}) as any;
  assert.deepEqual(Object.keys(a),['message_id']);
  const again=broker.send({actor:{host:'claude',sessionId:'c',callId:'c1'},message:'接口更新'}) as any;
  assert.equal(a.message_id,again.message_id);
  const b=broker.send({actor:{host:'codex',sessionId:'x',callId:'x1'},message:'测试已更新',in_reply_to:a.message_id}) as any;
  assert.equal(store.message(a.message_id).state,'responded');
  await broker.pump();
  assert.equal(claude.delivered[0]?.id,b.message_id);
  assert.equal(store.message(b.message_id).state,'runtimeQueued');
  assert.throws(()=>broker.send({actor:{host:'claude',sessionId:'c',callId:'c1'},message:'偷偷换正文'}),/同一次工具调用/);
  assert.equal(store.currentPair()?.claude,c.id);assert.equal(store.currentPair()?.codex,x.id);
});

test('暂停时仍持久化；恢复后双忙会话均能独立投递',async t=>{
  const {store,broker,c,x,codex,claude}=fixture(t);store.pair(c.id,x.id);store.setPaused(true);
  store.updatePeer(c.id,{state:'busy'});store.updatePeer(x.id,{state:'busy'});
  broker.send({actor:{host:'claude',sessionId:'c',callId:'c1'},message:'A'});
  broker.send({actor:{host:'codex',sessionId:'x',callId:'x1'},message:'B'});
  await broker.pump();assert.equal(codex.delivered.length+claude.delivered.length,0);
  store.setPaused(false);await broker.pump();assert.equal(codex.delivered.length,0);assert.equal(claude.delivered.length,1);
  assert.equal((broker.receive({host:'codex',sessionId:'x',callId:'busy-pickup'}) as any).messages[0].message,'A');
});

test('多候选不猜测；新窗口不抢当前配对',t=>{
  const {store,broker,c,x}=fixture(t);const x2=store.register(registration('codex','x2'));
  assert.throws(()=>broker.send({actor:{host:'claude',sessionId:'c',callId:'c1'},message:'问题'}),{code:'selection_required'});
  assert.equal(store.currentPair(),undefined);
  store.pair(c.id,x.id);
  assert.throws(()=>broker.send({actor:{host:'codex',sessionId:'x2',callId:'x2-1'},message:'抢配对'}),{code:'partner_missing'});
  assert.equal(store.pairFor(x2.id),undefined);assert.equal(store.pairFor(c.id)?.codex,x.id);
  assert.throws(()=>store.pair(c.id,x2.id),/替换必须/);
  assert.equal(store.pair(c.id,x2.id,true).codex,x2.id);
});

test('fork 与子代理通过实际父链区分，不使用 sessionId 猜测',async t=>{
  const {store,broker,c,x}=fixture(t);store.pair(c.id,x.id);
  const fork=threadRegistration({id:'fork',cwd:x.cwd,forkedFromId:'x',threadSource:'user'},'unix://test-server')!;
  store.register(fork);
  assert.throws(()=>broker.send({actor:{host:'codex',sessionId:'fork',callId:'f'},message:'不继承授权'}),{code:'partner_missing'});
  assert.equal(store.pairFor(store.find('codex','fork')!.id),undefined);
  store.register(threadRegistration({id:'child',cwd:x.cwd,parentThreadId:'x',threadSource:'subagent'},'unix://test-server')!);
  assert.throws(()=>broker.send({actor:{host:'codex',sessionId:'child',callId:'child-call'},message:'子代理发现'}),{code:'subagent_denied'});
  assert.equal(store.messages().length,0);
  assert.equal(codexIdentity({threadId:'fork',sessionId:'x',callId:'new'}).registration.kind,'unknown');
});

test('子代理重复登记时保留既有根归属和活动时间，父链暂时歧义不抹除证明',t=>{
  const {store,x}=fixture(t),window={host:'codex' as const,configHome:'/isolated-codex',pid:111,procStart:'native-root'};
  const binding=store.bindings.activate(window,x.id,'x','test');
  const input=registration('codex','child',{kind:'subagent',parentId:'x',endpoint:{mode:'embedded',address:'',epoch:'child',pid:111,procStart:'native-root',configHome:window.configHome}});
  const child=store.register(input),proof={key:binding.key,epoch:binding.epoch};assert.deepEqual(child.rootBinding,proof);assert.equal(child.rootPeerId,x.id);
  store.updatePeer(child.id,{activityAt:123});
  store.savePeer({...store.peer(x.id),id:'ambiguous-parent',rootPeerId:x.id,rootBinding:proof});
  const again=store.register(input);assert.equal(again.id,child.id);assert.deepEqual(again.rootBinding,proof);assert.equal(again.rootPeerId,x.id);assert.equal(again.activityAt,123);
});

test('MCP 登记不能覆盖 App Server 核验的身份和端点',async t=>{
  const {store,broker,x}=fixture(t);
  await broker.dispatch('mcp.register',codexIdentity({threadId:'x',sessionId:'x',callId:'c'}).registration);
  assert.equal(store.endpoint(x.id)?.mode,'app-server');assert.equal(store.peer(x.id).cwd,x.cwd);
});

test('唤醒回执丢失不认领正文，真实取件仍可消费且不重放',async t=>{
  const {store,broker,c,x,codex}=fixture(t);store.pair(c.id,x.id);codex.fail=new DeliveryError('lost','远端可能已接受',true);
  const peer=store.find('codex','x')!;store.saveEndpoint({...store.endpoint(peer.id)!,address:'ws://remote-test'});
  const response=broker.send({actor:{host:'claude',sessionId:'c',callId:'call'},message:'不能重发'}) as any;
  await broker.pump();assert.equal(store.message(response.message_id).state,'accepted');assert.equal(store.pending().length,1);
  assert.deepEqual(broker.send({actor:{host:'claude',sessionId:'c',callId:'call'},message:'不能重发'}),{message_id:response.message_id});
  const received=broker.receive({host:'codex',sessionId:'x',callId:'pickup'}) as any;assert.equal(received.messages[0].message_id,response.message_id);assert.equal(store.message(response.message_id).state,'unknown');
});

test('崩溃恢复仅将提交中的消息标为不确定',t=>{
  const {store,c,x}=fixture(t),pair=store.pair(c.id,x.id);
  const first=store.accept(pair,c,'A','call-a'),second=store.accept(pair,c,'B','call-b');
  store.claim(first.id);store.recover();assert.equal(store.message(first.id).state,'unknown');assert.equal(store.message(second.id).state,'accepted');
});

test('embedded 取件独占消费，取件重试复用原结果',t=>{
  const {store,broker,c,x}=fixture(t);store.deactivate(x.id);
  store.register(registration('codex','x',{endpoint:{mode:'embedded',address:'',epoch:'embedded-x',pid:process.pid,procStart:'test'}}));store.pair(c.id,x.id);
  const send=broker.send({actor:{host:'claude',sessionId:'c',callId:'s'},message:'只在工具结果出现'}) as any;
  const actor={host:'codex' as const,sessionId:'x',callId:'receive-1'};
  const first=broker.receive(actor) as any;assert.equal(first.messages[0].message_id,send.message_id);
  assert.deepEqual(broker.receive(actor),first);
  assert.equal((broker.receive({...actor,callId:'receive-2'}) as any).messages.length,0);
  assert.equal(store.message(send.message_id).state,'unknown');
});

test('同一 ID 的多个活端点拒绝模糊路由',t=>{
  const {store,c}=fixture(t);store.register(registration('claude','c',{endpoint:{mode:'claude-inbox',address:'another-inbox',epoch:'second-instance',pid:process.ppid,procStart:'second'}}));
  assert.throws(()=>store.endpoint(c.id),/多个存活端点/);
  store.deactivate(c.id,'second-instance');assert.equal(store.endpoint(c.id)?.address,'test-inbox');
});

test('用户中断阻止唤醒和取件，不以收到消息解除暂停',async t=>{
  const {store,broker,c,x,codex}=fixture(t);store.pair(c.id,x.id);
  await broker.dispatch('hook',{session_id:'x',hook_event_name:'Interrupt'});
  broker.send({actor:{host:'claude',sessionId:'c',callId:'s'},message:'暂停期间保留'});
  await broker.pump();assert.equal(codex.delivered.length,0);assert.equal(store.pending(x.id).length,1);
  assert.equal((broker.receive({host:'codex',sessionId:'x',callId:'r'}) as any).status,'paused');
});
