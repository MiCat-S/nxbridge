import test from 'node:test';
import assert from 'node:assert/strict';
import { connectBroker, listenBroker } from '../ipc/ipc.js';
import {ensureHome} from '../ipc/home.js';
import { fixture } from './support/broker-fixture.js';
import { registration } from './support/registration.js';
import { temporary } from './support/temporary.js';
import type { Actor, Host } from '../types.js';

type ReceiveResult={messages:{message_id:string;message:string}[];status:string};
const budget=1024*1024;

for(const target of ['claude','codex'] as Host[])for(const [label,body] of [
  ['ASCII','a'.repeat(256*1024)],
  ['Unicode','汉🙂'.repeat(Math.floor(256*1024/7))],
  ['JSON 转义','\u0001'.repeat(256*1024)]
] as const)test(`${target} embedded 大批 ${label} 消息按序分批，超额不认领，同次取件重试不增次数`,async t=>{
  const {store,broker,c,x}=fixture(t),home=temporary(t);await ensureHome(home);
  const peer=target==='claude'?c:x,sender=target==='claude'?x:c;
  store.deactivate(peer.id);store.register(registration(target,peer.sessionId!,{endpoint:{mode:'embedded',address:'',epoch:'embedded',pid:process.pid,procStart:'test'}}));
  const pair=store.pair(c.id,x.id),ids=Array.from({length:12},(_,index)=>store.accept(pair,sender,body,'large-'+index).id);
  const server=await listenBroker(home,async(_method,actor)=>broker.receive(actor as Actor)),rpc=await connectBroker(home);
  t.after(async()=>{rpc.close();await server.close();});
  const actor={host:target,sessionId:peer.sessionId!,callId:'first'},first=await rpc.request<ReceiveResult>('receive',actor);
  assert.ok(first.messages.length>0&&first.messages.length<ids.length);
  assert.deepEqual(first.messages.map(message=>message.message_id),ids.slice(0,first.messages.length));
  const fits=Buffer.byteLength(JSON.stringify(first))<=budget;
  assert.ok(fits||first.messages.length===1,'转义后超过预算的单条消息仍可取出');
  if(label==='Unicode')assert.equal(first.messages.length,3,'预算按 UTF-8 字节计算，不能按 UTF-16 字符计算');
  for(const [index,id] of ids.entries()){
    const message=store.message(id),claimed=index<first.messages.length;
    assert.equal(message.state,claimed?'unknown':'accepted');assert.equal(message.attempts,claimed?1:0);
  }
  assert.deepEqual(await rpc.request('receive',actor),first);
  const received=[...first.messages];
  for(let index=1;received.length<ids.length;index++){
    const result=await rpc.request<ReceiveResult>('receive',{...actor,callId:'next-'+index});
    assert.ok(result.messages.length>0);received.push(...result.messages);
    assert.ok(Buffer.byteLength(JSON.stringify(result))<=budget||result.messages.length===1);
  }
  assert.deepEqual(received.map(message=>message.message_id),ids);
  assert.ok(received.every(message=>message.message===body));
  assert.ok(ids.every(id=>store.message(id).attempts===1),'同次重试及后续取件都不能重复认领');
  assert.deepEqual((await rpc.request<ReceiveResult>('receive',{...actor,callId:'empty'})).messages,[]);
});

test('短消息仍每批最多二十条，取件缓存不会吞掉后来到达的消息',t=>{
  const {store,broker,c,x}=fixture(t),pair=store.pair(c.id,x.id);
  const ids=Array.from({length:21},(_,index)=>store.accept(pair,c,'消息 '+index,'small-'+index).id),actor={host:'codex' as const,sessionId:'x',callId:'first'};
  const first=broker.receive(actor) as ReceiveResult;assert.equal(first.messages.length,20);
  const last=store.accept(pair,c,'后来到达','later');assert.deepEqual(broker.receive(actor),first);
  assert.deepEqual((broker.receive({...actor,callId:'next'}) as ReceiveResult).messages.map(message=>message.message_id),[ids[20],last.id]);
});
