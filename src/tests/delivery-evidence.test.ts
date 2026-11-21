import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { WebSocketServer } from 'ws';
import { Broker, type Adapters } from '../broker/coordinator.js';
import { CodexAdapter, codexContextReceipts } from '../hosts/codex/adapter.js';
import { Store } from '../storage/store.js';
import {BridgeError} from '../shared/errors.js';
import {DEFAULT_CONFIG} from '../config/defaults.js';
import {type Endpoint,type Peer} from '../types.js';
import { codexInitializeResult, registration } from './support/registration.js';
import { FakeAdapter } from './support/fake-adapter.js';
import { fixture } from './support/broker-fixture.js';
import { temporary } from './support/temporary.js';

const item=(messageId:string,id='native-output')=>({type:'functionCallOutput',id,namespace:'claude',name:'receive_messages',output:JSON.stringify({messages:[{message_id:messageId,message:'正文'}]})});

test('上下文证据只解析原生取件输出中的精确 ID，不匹配正文、错误命名空间或坏 JSON',()=>{
  const valid=item('actual');valid.output=JSON.stringify({messages:[{message_id:'actual',message:'正文引用 quoted-id'},null,{message_id:'actual'},{message_id:12}]});
  assert.deepEqual(codexContextReceipts(valid,'turn'),[{messageId:'actual',turnId:'turn',itemId:'native-output'}]);
  for(const value of [null,{...valid,type:'agentMessage'},{...valid,namespace:'other'},{...valid,name:'send_message'},{...valid,id:''},{...valid,output:'坏 JSON'},{...valid,output:JSON.stringify({message_id:'quoted-id'})}])assert.deepEqual(codexContextReceipts(value,'turn'),[]);
  assert.deepEqual(codexContextReceipts(valid,undefined),[]);
});

test('真实 RPC 的原生输出回执先于 ACK 或断连错误，也不会降回 queued/unknown 或重发',async t=>{
  const server=new WebSocketServer({host:'127.0.0.1',port:0});await once(server,'listening');
  const address=`ws://127.0.0.1:${(server.address() as {port:number}).port}`,methods:string[]=[];let fail=false,broker:Broker;
  server.on('connection',socket=>socket.on('message',raw=>{
    const request=JSON.parse(raw.toString());methods.push(request.method);if(request.id===undefined)return;
    if(request.method==='turn/start'){
      const result=broker.receive({host:'codex',sessionId:'x',callId:fail?'uncertain-pickup':'ack-pickup'});
      socket.send(JSON.stringify({method:'item/completed',params:{threadId:'x',turnId:'native-turn',item:{type:'mcpToolCall',id:'native-output',server:'claude',tool:'receive_messages',status:'completed',result:{content:[{type:'text',text:JSON.stringify(result)}]}}}}));
      socket.send(JSON.stringify({id:request.id,...(fail?{error:{code:'lost_ack',message:'提交后丢失回执',data:{uncertain:true}}}:{result:{turn:{id:'native-turn'}}})}));return;
    }
    const result=request.method==='initialize'?codexInitializeResult:request.method==='thread/loaded/list'?{data:[]}:request.method==='thread/resume'?{thread:{id:'x',cwd:process.cwd(),status:{type:'idle'}}}:{};
    socket.send(JSON.stringify({id:request.id,result}));
  }));
  const home=temporary(t),config={...DEFAULT_CONFIG,implicit:'never' as const},store=new Store(':memory:'),codex=new CodexAdapter(config,home);broker=new Broker(store,config,{codex,claude:new FakeAdapter()} as unknown as Adapters,home);
  t.after(async()=>{await broker.stop();store.close();for(const socket of server.clients)socket.terminate();await new Promise<void>(resolve=>server.close(()=>resolve()));});
  const c=store.register(registration('claude','c')),x=store.register(registration('codex','x',{endpoint:{mode:'app-server',address,epoch:address,pid:null,procStart:null}}));store.pair(c.id,x.id);
  for(const callId of ['ack','uncertain']){
    fail=callId==='uncertain';const result=broker.send({actor:{host:'claude',sessionId:'c',callId},message:'实际投递'} ) as any;await broker.pump();
    const message=store.message(result.message_id);assert.equal(message.state,'contextObserved');assert.equal(message.attempts,1);assert.match(message.evidence!,/item\/completed.*turn=native-turn.*item=native-output/);
    await broker.pump();
  }
  assert.equal(methods.filter(method=>method==='turn/start').length,2);
});

test('上下文回执核验线程、端点及收件人，迟到回执不降低 responded',async t=>{
  const {store,broker,c,x,codex}=fixture(t);const pair=store.pair(c.id,x.id),message=store.accept(pair,c,'正文','receipt');store.claim(message.id);store.transition(message.id,'unknown');
  const receipt={messageId:message.id,turnId:'turn',itemId:'output',sessionId:'x',address:'unix://test-server'};
  codex.emit('contextObserved',{...receipt,address:'unregistered'});assert.equal(store.message(message.id).state,'unknown');
  const foreign=store.register(registration('codex','foreign',{endpoint:{mode:'app-server',address:'foreign',epoch:'foreign',pid:null,procStart:null}}));
  codex.emit('contextObserved',{...receipt,sessionId:foreign.sessionId,address:'foreign'});assert.equal(store.message(message.id).state,'unknown');
  codex.emit('contextObserved',receipt);assert.equal(store.message(message.id).state,'contextObserved');
  store.transition(message.id,'responded','明确回复');codex.emit('contextObserved',receipt);assert.equal(store.message(message.id).state,'responded');
  assert.equal(store.message(message.id).body,'正文');assert.equal(store.message(message.id).attempts,1);await broker.reconcile();
});

test('历史核对合并并发且每线程只读一次，仅结算有原生输出证据的 queued/unknown',async t=>{
  const {store,broker,c,x,codex}=fixture(t);const pair=store.pair(c.id,x.id);
  const queued=store.accept(pair,c,'已进入上下文','queued'),unknown=store.accept(pair,c,'回执丢失','unknown'),unproved=store.accept(pair,c,'只在正文引用，不能证明','unproved'),other=store.accept(pair,x,'另一方向','claude');
  for(const message of [queued,unknown,unproved,other]){store.claim(message.id);store.transition(message.id,message.id===unknown.id?'unknown':'runtimeQueued');}
  let reads=0;codex.reconcile=async()=>{reads++;await Promise.resolve();return[queued,unknown,other].map(message=>({messageId:message.id,turnId:'completed-turn',itemId:'output-'+message.id}));};
  await Promise.all([broker.reconcile(),broker.reconcile(x.id)]);
  assert.equal(reads,1);assert.equal(store.message(queued.id).state,'contextObserved');assert.equal(store.message(unknown.id).state,'contextObserved');
  assert.equal(store.message(unproved.id).state,'runtimeQueued');assert.equal(store.message(other.id).state,'runtimeQueued');
  assert.match(store.message(unknown.id).evidence!,/thread\/read.*turn=completed-turn/);assert.equal(store.message(unknown.id).attempts,1);assert.equal(codex.delivered.length,0);
});

test('归档线程只读已登记端点补证，不恢复线程、宿主或旧配对',async t=>{
  const {store,broker,c,x,codex,claude}=fixture(t),old=store.register(registration('codex','archived'));
  const oldPair=store.pair(c.id,old.id),message=store.accept(oldPair,c,'归档前已经进入上下文','archived');store.claim(message.id);store.transition(message.id,'runtimeQueued');
  const current=store.pair(c.id,x.id,true);store.deactivate(old.id);store.updatePeer(old.id,{state:'offline'});
  codex.reconcile=async(peer,endpoint)=>{assert.equal(peer.id,old.id);assert.equal(endpoint.active,false);return[{messageId:message.id,turnId:'old-completed',itemId:'old-output'}];};
  await broker.reconcile();assert.equal(store.message(message.id).state,'contextObserved');assert.equal(store.peer(old.id).state,'offline');assert.equal(store.endpoint(old.id),undefined);
  assert.equal(store.currentPair()?.id,current.id);assert.equal(codex.attached.length,0);assert.equal(codex.created.length,0);assert.equal(codex.ensured,0);assert.equal(claude.woken.length,0);
});

for(const code of ['ERR_STREAM_PREMATURE_CLOSE','ECONNREFUSED'])test(`旧离线端点 ${code} 静默退避，重新登记立即恢复补证且未知消息不重放`,async t=>{
  let now=Date.now();t.mock.method(Date,'now',()=>now);
  const {store,broker,c,x,codex}=fixture(t),pair=store.pair(c.id,x.id),message=store.accept(pair,c,'原生接受情况未知','old-offline');
  store.claim(message.id);store.transition(message.id,'unknown');store.deactivate(x.id);store.updatePeer(x.id,{state:'offline'});
  let reads=0;codex.reconcile=async()=>{reads++;throw Object.assign(Error('旧端点已关闭'),{code});};
  await broker.reconcile();await broker.reconcile();assert.equal(reads,1);assert.deepEqual(store.faults.status(),[]);
  now+=60001;await broker.reconcile();assert.equal(reads,2);assert.deepEqual(store.faults.status(),[]);
  assert.equal(store.events().filter(value=>value.type==='reconcile.offline').length,1);
  assert.equal(store.message(message.id).state,'unknown');assert.equal(store.message(message.id).attempts,1);
  now++;store.register(registration('codex','x'));codex.reconcile=async()=>{reads++;return[{messageId:message.id,turnId:'reconnected',itemId:'native-output'}];};
  await broker.reconcile();assert.equal(reads,3);assert.equal(store.message(message.id).state,'contextObserved');
  assert.equal(store.message(message.id).attempts,1);assert.equal(codex.woken.length,0);assert.equal(codex.created.length,0);assert.equal(codex.delivered.length,0);
});

for(const inactive of [false,true])test(`${inactive?'旧离线端点的语义错误':'活动端点的传输错误'}仍进入隔离降级`,async t=>{
  const {store,broker,c,x,codex}=fixture(t),pair=store.pair(c.id,x.id),message=store.accept(pair,c,'继续保留','real-reconcile-fault');
  store.claim(message.id);store.transition(message.id,'unknown');
  if(inactive){store.deactivate(x.id);store.updatePeer(x.id,{state:'offline'});}
  codex.reconcile=async()=>{throw inactive?new BridgeError('session_changed','返回了其他线程'):Object.assign(Error('当前连接损坏'),{code:'EPIPE'});};
  for(let i=0;i<3;i++)await broker.reconcile();
  assert.ok(store.faults.status().some(value=>value.stage==='reconcile:'+x.id&&value.degraded));
  assert.equal(store.message(message.id).state,'unknown');assert.equal(store.message(message.id).attempts,1);
});

test('重启前按精确历史补证；未找到 ID 的旧消息仍拒绝，不以晚完成的 turn 推断已读',async t=>{
  const {store,broker,c,x,codex}=fixture(t);const pair=store.pair(c.id,x.id);store.updatePeer(x.id,{owner:'nxbridge'});
  const proved=store.accept(pair,c,'历史已包含','proved');store.claim(proved.id);store.transition(proved.id,'runtimeQueued');
  codex.reconcile=async()=>[{messageId:proved.id,turnId:'later-completed-turn',itemId:'actual-output'}];
  let restarted=0;(codex as any).restart=async(peer:Peer,endpoint:Endpoint,guard:()=>void)=>{guard();restarted++;store.adopt(peer.id,registration('codex','x',{endpoint:{...endpoint,address:'new',epoch:'new'}}));return{oldPid:1,pid:2,resumed:{model:'test',reasoningEffort:'high'}};};
  assert.equal((await broker.dispatch('codex.restart',{}) as any).restarted,true);assert.equal(store.message(proved.id).state,'contextObserved');
  assert.equal(store.message(proved.id).attempts,1);assert.equal(codex.delivered.length,0);
  const missing=store.accept(pair,c,'更老但没有证据','missing');store.claim(missing.id);store.transition(missing.id,'runtimeQueued');
  await assert.rejects(broker.dispatch('codex.restart',{}),{code:'delivery_unsettled'});assert.equal(restarted,1);assert.equal(store.message(missing.id).state,'runtimeQueued');assert.equal(store.message(missing.id).attempts,1);
});
