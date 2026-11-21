import test from 'node:test';
import assert from 'node:assert/strict';
import { CodexWakeSignals, CODEX_WAKE_RETRY_MS } from '../hosts/codex/codex-wake.js';
import { codexContextReceipts } from '../hosts/codex/adapter.js';
import { fixture } from './support/broker-fixture.js';

test('专用宿主一批只唤醒一次；忽略取件后有限重试，重启协调器也不能无限重试',async t=>{
  t.mock.timers.enable({apis:['Date'],now:1000000});
  const f=fixture(t),pair=f.store.pair(f.c.id,f.x.id),first=f.store.accept(pair,f.c,'正文甲','a');f.store.accept(pair,f.c,'正文乙','b');
  f.store.saveEndpoint({...f.store.endpoint(f.x.id)!,address:'ws://remote-test'});
  await f.broker.pump();await f.broker.pump();assert.equal(f.codex.woken.length,1);assert.equal(f.store.message(first.id).state,'accepted');assert.equal(f.store.message(first.id).attempts,0);
  for(let i=0;i<3;i++){t.mock.timers.tick(CODEX_WAKE_RETRY_MS);await f.broker.pump();}
  assert.equal(f.codex.woken.length,3);assert.equal(f.store.pendingCount(f.x.id),2);
  const resumed=new CodexWakeSignals(f.store);let repeated=0;
  t.mock.timers.tick(CODEX_WAKE_RETRY_MS);await resumed.signal(f.x.id,resumed.status(f.x.id)!.scope,first.id,async()=>{repeated++;});assert.equal(repeated,0);
  await f.broker.pump();assert.ok(JSON.stringify(f.broker.status()).includes('pickup_exhausted'));
});

test('忙碌轮次中断不认领消息；原窗口下一次取件只消费一次，旧 queued 不自动重放',async t=>{
  const f=fixture(t),pair=f.store.pair(f.c.id,f.x.id),old=f.store.accept(pair,f.c,'旧版本不确定输出','old');f.store.claim(old.id);f.store.transition(old.id,'runtimeQueued');
  f.store.updatePeer(f.x.id,{state:'busy'});const pending=f.store.accept(pair,f.c,'新协议正文','new');
  await f.broker.pump();assert.equal(f.codex.woken.length,0);assert.equal(f.store.message(pending.id).state,'accepted');
  f.codex.emit('interrupted','x','unix://test-server');await f.broker.pump();assert.equal(f.store.message(pending.id).state,'accepted');
  f.store.updatePeer(f.x.id,{state:'ready'});await f.broker.pump();assert.equal(f.codex.woken.length,1);
  const actor={host:'codex' as const,sessionId:'x',callId:'real-pickup'},result=f.broker.receive(actor) as any;
  assert.deepEqual(result.messages,[]);assert.equal(f.store.message(pending.id).state,'contextObserved');assert.deepEqual(f.broker.receive(actor),result);assert.equal((f.broker.receive({...actor,callId:'next'}) as any).messages.length,0);assert.equal(f.store.message(old.id).state,'runtimeQueued');
});

test('真实 MCP 工具完成历史能补证；失败工具、其他服务器及正文引用不能冒充回执',()=>{
  const item={type:'mcpToolCall',id:'native-mcp',server:'claude',tool:'receive_messages',status:'completed',result:{content:[{type:'text',text:JSON.stringify({messages:[{message_id:'one',message:'quoted-id'}]})}]}};
  assert.deepEqual(codexContextReceipts(item,'turn'),[{messageId:'one',turnId:'turn',itemId:'native-mcp'}]);
  for(const change of [{server:'other'},{tool:'send_message'},{status:'failed'},{error:{message:'失败'}},{result:{content:[{type:'text',text:'quoted-id'}]}}])assert.deepEqual(codexContextReceipts({...item,...change},'turn'),[]);
});
