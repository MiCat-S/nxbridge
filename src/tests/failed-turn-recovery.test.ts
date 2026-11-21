import test from 'node:test';
import assert from 'node:assert/strict';
import type {TestContext} from 'node:test';
import {Broker} from '../broker/coordinator.js';
import {DEFAULT_CONFIG} from '../config/defaults.js';
import {DeliveryError} from '../shared/errors.js';
import { fixture } from './support/broker-fixture.js';

function failedFixture(t:TestContext){
  const f=fixture(t),pair=f.store.pair(f.c.id,f.x.id),endpoint=f.store.endpoint(f.x.id)!;
  f.store.updatePeer(f.x.id,{owner:'nxbridge',state:'ready'});
  const thread:any={id:'x',status:{type:'systemError',activeFlags:[]},turns:[{id:'failed-turn',status:'failed',items:[],error:{message:'模型请求失败'}}]},calls:string[]=[];
  f.codex.connect=async()=>({request:async(method:string)=>{
    calls.push(method);
    if(method==='thread/read')return{thread};
    if(method==='thread/turns/list')return{data:[...thread.turns].reverse()};
    if(method==='thread/items/list')return{data:[]};
    throw Error('不应调用原生中断或直接构造新轮次：'+method);
  }}) as any;
  return{...f,pair,endpoint,thread,calls,recover:(request='recover-failed')=>f.broker.dispatch('codex.recover',{turn_id:'failed-turn',request_id:request})};
}

test('最新失败轮次按用户要求继续，不中断、不伪造搭档消息，重建协调器后仍只提交一次',async t=>{
  const f=failedFixture(t),task=f.store.accept(f.pair,f.c,'旧任务正文不得重放','original');f.store.transition(task.id,'contextObserved','真实旧回执');
  const before=f.store.messages(),preview:any=await f.broker.dispatch('codex.recover',{preview:true});
  assert.match(preview.recoveryCommand,/--turn failed-turn$/);
  const result:any=await f.recover();assert.equal(result.recovered,true);assert.equal(result.action,'continue_failed');
  const notice=f.codex.injectedNotices[0]!;assert.equal(result.notice_id,notice.id);
  assert.match(notice.body,/user explicitly requested recovery after failed native turn failed-turn/);
  assert.match(notice.body,/inspect partial file changes and existing command sessions/);
  assert.doesNotMatch(notice.body,/旧任务正文不得重放/);
  assert.deepEqual(f.store.messages(),before);assert.equal(f.codex.delivered.length,0);assert.equal(f.codex.woken.length,1);assert.ok(!f.calls.includes('turn/interrupt'));
  assert.equal(f.store.setting('codexRecoveryFence:'+f.x.id),undefined,'结束轮次不留下中断豁免');
  const after:any=await f.broker.dispatch('codex.recover',{preview:true});assert.equal(after.recoveryCommand,null);assert.equal(after.recoveryBlocked,'recovery_already_requested');
  const restored=new Broker(f.store,{...DEFAULT_CONFIG,implicit:'never'},{codex:f.codex,claude:f.claude} as any,f.broker.home);
  try{await assert.rejects(restored.dispatch('codex.recover',{turn_id:'failed-turn',request_id:'after-restart'}),{code:'recovery_already_requested'});}finally{await restored.stop();}
  assert.equal(f.codex.injectedNotices.length,1);assert.equal(f.codex.woken.length,1);
});

test('正常结束、原生等待、暂停及上下文切换均不能作为失败恢复目标',async t=>{
  for(const kind of ['completed','active','approval','pair-paused','member-paused','context','question'] as const){
    const f=failedFixture(t);
    if(kind==='completed')f.thread.turns[0].status='completed';
    if(kind==='active')f.thread.status={type:'active',activeFlags:[]};
    if(kind==='approval')f.thread.status={type:'systemError',activeFlags:['waitingOnApproval']};
    if(kind==='pair-paused')f.store.setPaused(true,f.pair.id);
    if(kind==='member-paused')f.store.updatePeer(f.x.id,{state:'paused'});
    if(kind==='context')f.store.saveEndpoint({...f.endpoint,pendingContext:true});
    if(kind==='question')t.mock.method(f.store,'questions',()=>[{from:f.x.id,to:f.c.id}] as any);
    await assert.rejects(f.recover(),error=>{assert.ok(['turn_recovered','turn_waiting','unowned_runtime'].includes((error as any).code),kind);return true;});
    assert.equal(f.codex.woken.length,0,kind);assert.equal(f.codex.injectedNotices.length,0,kind);assert.equal(f.store.setting('codexFailedRecovery:'+f.x.id),undefined,kind);
  }
});

test('复核期间开始的新轮次不能被旧失败恢复请求覆盖',async t=>{
  const f=failedFixture(t),connect=f.codex.connect.bind(f.codex);let connects=0;
  f.codex.connect=async(address:string)=>{
    const rpc=await connect(address);
    if(++connects===2)f.broker.health.observe(f.endpoint.address,{method:'turn/started',params:{threadId:'x',turn:{id:'newer-turn'}}});
    return rpc;
  };
  await assert.rejects(f.recover(),{code:'turn_recovered'});
  assert.equal(f.codex.injectedNotices.length,0);assert.equal(f.store.setting('codexFailedRecovery:'+f.x.id),undefined);
});

test('复核期间配对暂停或端点更换，保持原有历史且不提交继续指令',async t=>{
  for(const change of ['pair','endpoint'] as const){
    const f=failedFixture(t),connect=f.codex.connect.bind(f.codex);let connects=0;
    f.codex.connect=async(address:string)=>{const rpc=await connect(address);if(++connects===2){if(change==='pair')f.store.setPaused(true,f.pair.id);else{f.store.saveEndpoint({...f.endpoint,active:false});f.store.saveEndpoint({...f.endpoint,epoch:'new-endpoint'});}}return rpc;};
    await assert.rejects(f.recover(),error=>{assert.ok(['turn_waiting','session_changed'].includes((error as any).code),change+': '+String(error)+' ('+(error as any).code+')');return true;});
    assert.equal(f.codex.injectedNotices.length,0);assert.equal(f.store.setting('codexFailedRecovery:'+f.x.id),undefined);
  }
});

test('新的失败轮次可以再次由用户恢复，不被上一轮恢复或自动告警的退避阻挡',async t=>{
  const f=failedFixture(t);await f.recover();
  f.thread.turns[0].id='next-failed';
  f.broker.health.observe(f.endpoint.address,{method:'turn/started',params:{threadId:'x',turn:{id:'next-failed'}}});
  f.broker.health.observe(f.endpoint.address,{method:'turn/completed',params:{threadId:'x',turn:{id:'next-failed',status:'failed'}}});
  const result:any=await f.broker.dispatch('codex.recover',{turn_id:'next-failed',request_id:'new-user-request'});
  assert.equal(result.recovered,true);assert.equal(f.codex.injectedNotices.length,2);assert.equal(f.codex.woken.length,2);
  assert.notEqual(f.codex.injectedNotices[0]!.id,f.codex.injectedNotices[1]!.id);
});

test('并发恢复同一失败轮次只能创建一次继续请求',async t=>{
  const f=failedFixture(t),results=await Promise.allSettled([f.recover('one'),f.recover('two')]);
  assert.equal(results.filter(value=>value.status==='fulfilled').length,1);
  const rejected=results.find(value=>value.status==='rejected') as PromiseRejectedResult;
  assert.ok(['restart_in_progress','recovery_already_requested'].includes(rejected.reason.code));
  assert.equal(f.codex.injectedNotices.length,1);assert.equal(f.codex.woken.length,1);
});

test('提交结果未知时保留持久请求，不因再次执行恢复命令重发',async t=>{
  const f=failedFixture(t),wake=t.mock.method(f.broker as any,'signalCodexWake',async()=>{throw new DeliveryError('native_unknown','原生提交结果未知',true);});
  await assert.rejects(f.recover(),{code:'native_unknown'});
  assert.equal((f.store.setting<any>('codexRecovery:recover-failed')).state,'uncertain');
  assert.ok(f.store.setting('codexFailedRecovery:'+f.x.id));
  await assert.rejects(f.recover('do-not-repeat'),{code:'recovery_already_requested'});
  assert.equal(wake.mock.callCount(),1);
});

test('恢复预约与通知写入同一事务，未提交的存储错误不会留下永久重复闸门',async t=>{
  const f=failedFixture(t),enqueue=t.mock.method(f.broker.deliveryHealth,'enqueue',()=>{throw Error('隔离存储写入故障');});
  await assert.rejects(f.recover(),/隔离存储写入故障/);assert.equal(f.store.setting('codexFailedRecovery:'+f.x.id),undefined);
  enqueue.mock.restore();assert.equal((await f.recover('retry-unsent') as any).recovered,true);assert.equal(f.codex.injectedNotices.length,1);
});
