import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './support/broker-fixture.js';
import { registration } from './support/registration.js';
import { assertNoPendingCodexWork, manualCodexRestart, restartArguments } from '../hosts/codex/codex-restart.js';
import { RpcClient } from '../ipc/rpc.js';
import {BridgeError} from '../shared/errors.js';
import {type Endpoint,type Peer,type DeliveryState} from '../types.js';

test('重启参数只接受 Codex 和可选的原会话 ID，用户窗口仅给出原生步骤',async t=>{
  assert.deepEqual(restartArguments(['codex']),{});
  assert.deepEqual(restartArguments(['codex','--session','same']),{session_id:'same'});
  for(const args of [[],['claude'],['codex','--session'],['codex','--session','--all'],['codex','extra'],['codex','--session','same','extra']])assert.throws(()=>restartArguments(args),{code:'invalid_arguments'});
  const {store,broker,x,codex}=fixture(t);store.updatePeer(x.id,{cwd:"C:\\项目's dir",model:'gpt-6.1-sol',effort:'xhigh'});
  const before=store.peer(x.id),result=await broker.dispatch('codex.restart',{session_id:'x'}) as any;
  assert.equal(result.restarted,false);assert.match(result.text,/\/quit/);assert.match(result.text,/--no-daemon/);assert.match(result.text,/resume 'x'/);
  assert.match(manualCodexRestart(before,'win32'),/项目''s dir/);
  assert.match(manualCodexRestart(before,'linux'),/项目'"'"'s dir/);
  assert.match(result.text,/gpt-6.1-sol/);assert.match(result.text,/xhigh/);
  assert.deepEqual(store.peer(x.id),before);assert.equal(codex.attached.length,0);assert.equal(codex.ensured,0);assert.equal(codex.released.length,0);
});

test('默认只选择当前配对；显式指定也不能选择未知会话或子代理',async t=>{
  const {store,broker,c,x}=fixture(t);
  await assert.rejects(broker.dispatch('codex.restart',{}),{code:'session_missing'});
  store.pair(c.id,x.id);assert.equal((await broker.dispatch('codex.restart',{}) as any).session_id,'x');
  await assert.rejects(broker.dispatch('codex.restart',{session_id:'unknown'}),{code:'session_missing'});
  store.register(registration('codex','child',{kind:'subagent',parentId:'x'}));
  await assert.rejects(broker.dispatch('codex.restart',{session_id:'child'}),{code:'invalid_restart_target'});
});

test('忙碌、审批、挂起问题、共享宿主和未确认消息都阻止自动重启',async t=>{
  const {store,broker,c,x,codex}=fixture(t);const pair=store.pair(c.id,x.id);store.updatePeer(x.id,{owner:'nxbridge'});
  let called=0;(codex as any).restart=async()=>{called++;throw Error('不应启动');};
  for(const state of ['busy','needsHuman','offline','unknown','starting'] as const){store.updatePeer(x.id,{state});await assert.rejects(broker.dispatch('codex.restart',{}),{code:'session_busy'});}
  store.updatePeer(x.id,{state:'ready'});
  broker.questions.create(pair,x,{host:'codex',sessionId:'x',callId:'pending'},{questions:[{header:'选择',id:'q',question:'选择方案？',options:[{label:'甲',description:'甲'},{label:'乙',description:'乙'}]}]});
  await assert.rejects(broker.dispatch('codex.restart.target',{}),{code:'question_pending'});await assert.rejects(broker.dispatch('codex.restart',{}),{code:'question_pending'});broker.questions.cancelPeer(x.id);
  for(const state of ['sending','runtimeQueued','held'] as DeliveryState[]){
    const message=store.accept(pair,c,'保留未确认消息',state);store.claim(message.id);if(state!=='sending')store.transition(message.id,state);
    await assert.rejects(broker.dispatch('codex.restart',{}),{code:'delivery_unsettled'});
    assert.equal(store.message(message.id).state,state);store.transition(message.id,'contextObserved');
  }
  const other=store.register(registration('codex','other'));
  await assert.rejects(broker.dispatch('codex.restart',{}),{code:'shared_runtime'});
  store.deactivate(other.id);assert.equal(called,0);assert.equal(store.currentPair()?.id,pair.id);
});

test('中断后的 paused peer 可交给原生空闲核验，重启保留配对暂停',async t=>{
  const {store,broker,c,x,codex}=fixture(t);const pair=store.pair(c.id,x.id);store.updatePeer(x.id,{owner:'nxbridge',state:'paused'});
  await broker.dispatch('pause',{});
  (codex as any).restart=async(peer:Peer,endpoint:Endpoint,guard:()=>void)=>{
    guard();assert.equal(peer.state,'paused');
    store.adopt(peer.id,registration('codex','x',{state:'ready',endpoint:{...endpoint,address:'new',epoch:'new'}}));
    return{endpoint:'new',oldPid:1,pid:2,resumed:{model:'gpt-6.1-sol',reasoningEffort:'xhigh'}};
  };
  const result=await broker.dispatch('codex.restart',{}) as any;
  assert.equal(result.restarted,true);assert.equal(store.currentPair()?.id,pair.id);assert.equal(store.currentPair()?.paused,true);
  assert.equal(store.peer(x.id).state,'ready');
});

test('重启隔离目标投递，其他方向照常，新来信仅在恢复后投递一次',async t=>{
  const {store,broker,c,x,codex,claude}=fixture(t);const pair=store.pair(c.id,x.id);
  store.updatePeer(x.id,{owner:'nxbridge',model:'gpt-6.1-sol',effort:'xhigh'});
  let entered!:()=>void,finish!:()=>void;
  const waiting=new Promise<void>(resolve=>entered=resolve),resume=new Promise<void>(resolve=>finish=resolve);
  (codex as any).restart=async(peer:Peer,endpoint:Endpoint,guard:()=>void)=>{
    entered();await resume;guard();
    store.adopt(peer.id,registration('codex','x',{model:peer.model,effort:peer.effort,state:'ready',endpoint:{...endpoint,address:'unix://new',epoch:'new'}}));
    return{endpoint:'new',oldPid:1,pid:2,resumed:{model:peer.model,reasoningEffort:peer.effort}};
  };
  const restarting=broker.dispatch('codex.restart',{});await waiting;
  await assert.rejects(broker.dispatch('codex.restart',{}),{code:'restart_in_progress'});
  await assert.rejects(broker.dispatch('open',{host:'codex'}),{code:'restart_in_progress'});
  const incoming=store.accept(pair,c,'重启期间的新消息','during'),outgoing=store.accept(pair,x,'另一方向仍能投递','other-direction');
  await broker.pump();assert.equal(store.message(incoming.id).state,'accepted');assert.equal(codex.delivered.length,0);assert.equal(claude.delivered[0]?.id,outgoing.id);
  finish();assert.equal((await restarting as any).restarted,true);await broker.pump();
  assert.equal(codex.delivered.length,1);assert.equal(codex.delivered[0]?.id,incoming.id);assert.equal(store.message(incoming.id).attempts,1);
  assert.equal(store.peer(x.id).sessionId,'x');assert.equal(store.peer(x.id).model,'gpt-6.1-sol');assert.equal(store.peer(x.id).effort,'xhigh');
  assert.equal(store.currentPair()?.id,pair.id);assert.equal(store.peer(x.id).owner,'nxbridge');assert.equal(codex.created.length,0);
});

test('停止前重新核验状态，晚到的任务和所有权变化阻止停止进程',async t=>{
  const {store,broker,c,x,codex}=fixture(t);const pair=store.pair(c.id,x.id);store.updatePeer(x.id,{owner:'nxbridge'});
  let stopped=0;
  (codex as any).restart=async(_peer:Peer,_endpoint:Endpoint,guard:()=>void)=>{store.updatePeer(x.id,{state:'busy'});guard();stopped++;};
  await assert.rejects(broker.dispatch('codex.restart',{}),{code:'session_busy'});
  store.updatePeer(x.id,{state:'ready'});
  (codex as any).restart=async(_peer:Peer,_endpoint:Endpoint,guard:()=>void)=>{store.updatePeer(x.id,{owner:'user'});guard();stopped++;};
  await assert.rejects(broker.dispatch('codex.restart',{}),{code:'session_changed'});assert.equal(stopped,0);
  store.updatePeer(x.id,{owner:'nxbridge',state:'ready'});
  const waiting=store.accept(pair,c,'失败后不得自动投递','failed-restart');
  (codex as any).restart=async()=>{throw new BridgeError('restart_incomplete','原 ID 尚未恢复');};
  await assert.rejects(broker.dispatch('codex.restart',{}),{code:'restart_incomplete'});await broker.pump();
  codex.emit('state','x','ready');codex.emit('register',registration('codex','x',{state:'ready'}));
  assert.equal(store.peer(x.id).state,'paused');assert.equal(store.message(waiting.id).state,'accepted');assert.equal(codex.delivered.length,0);assert.equal(codex.created.length,0);
});

test('原生队列和后台终端单独阻止停止；核验只读，不清队列或终止任务',async()=>{
  const calls:string[]=[];let queue:any[]=[],terminals:any[]=[];
  const rpc=new RpcClient(message=>{calls.push(message.method!);queueMicrotask(()=>rpc.receive({id:message.id,result:{data:message.method==='thread/queue/list'?queue:terminals}}));},()=>{});
  try{
    queue=[{id:'queued'}];await assert.rejects(assertNoPendingCodexWork(rpc,'x'),{code:'delivery_unsettled'});
    queue=[];terminals=[{processId:'running'}];await assert.rejects(assertNoPendingCodexWork(rpc,'x'),{code:'session_busy'});
    terminals=[];await assertNoPendingCodexWork(rpc,'x');
    assert.ok(calls.every(method=>method==='thread/queue/list'||method==='thread/backgroundTerminals/list'));
  }finally{rpc.close();}
});

test('按请求查询重启完成与失败，后续请求不会覆盖前一次结果',async t=>{
  const {store,broker,c,x,codex}=fixture(t);store.pair(c.id,x.id);store.updatePeer(x.id,{owner:'nxbridge'});
  await assert.rejects(broker.dispatch('codex.restart',{request_id:'changed-broker',broker_pid:process.pid,broker_generation:'另一个代次'}),{code:'broker_changed'});
  (codex as any).restart=async()=>{throw new BridgeError('history_not_persisted','历史未落盘，未停止宿主');};
  await assert.rejects(broker.dispatch('codex.restart',{request_id:'failed-request'}),{code:'history_not_persisted'});
  (codex as any).restart=async()=>({endpoint:'new',oldPid:1,pid:2,resumed:{model:'gpt-6.1-sol',reasoningEffort:'xhigh'}});
  const completed=await broker.dispatch('codex.restart',{request_id:'completed-request'});
  await assert.rejects(broker.dispatch('codex.restart.result',{request_id:'failed-request'}),{code:'history_not_persisted',uncertain:false});
  assert.deepEqual(await broker.dispatch('codex.restart.result',{request_id:'completed-request'}),completed);
  await assert.rejects(broker.dispatch('codex.restart.result',{request_id:'unknown-request'}),{code:'restart_result_missing'});
});

test('已卸载线程的终端表明确不存在时只读复核，重载、排队和其他失败仍阻止停止',async()=>{
  let status='notLoaded',loaded:string[]=[],queue:any[]=[],failure='thread not found: x';
  const methods:string[]=[];
  const rpc=new RpcClient(message=>{methods.push(message.method!);queueMicrotask(()=>{
    if(message.method==='thread/backgroundTerminals/list')rpc.receive({id:message.id,error:{code:-32600,message:failure}});
    else rpc.receive({id:message.id,result:message.method==='thread/read'?{thread:{id:'x',status:{type:status}}}:{data:message.method==='thread/loaded/list'?loaded:queue}});
  });},()=>{});
  try{
    await assert.rejects(assertNoPendingCodexWork(rpc,'x'),{message:failure});
    await assertNoPendingCodexWork(rpc,'x',{allowUnloaded:true});
    status='idle';await assert.rejects(assertNoPendingCodexWork(rpc,'x',{allowUnloaded:true}),{code:'session_busy'});
    status='notLoaded';loaded=['x'];await assert.rejects(assertNoPendingCodexWork(rpc,'x',{allowUnloaded:true}),{code:'session_busy'});
    loaded=[];queue=[{id:'pending'}];await assert.rejects(assertNoPendingCodexWork(rpc,'x',{allowUnloaded:true}),{code:'delivery_unsettled'});
    queue=[];for(const message of ['thread not found: other','连接已断开','permission denied']){failure=message;await assert.rejects(assertNoPendingCodexWork(rpc,'x',{allowUnloaded:true}),{message});}
    assert.ok(methods.every(method=>['thread/read','thread/loaded/list','thread/queue/list','thread/backgroundTerminals/list'].includes(method)));
  }finally{rpc.close();}
});
