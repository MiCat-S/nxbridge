import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { DEFAULT_CONFIG } from '../config/defaults.js';
import { CodexAdapter, type CodexThread } from '../hosts/codex/adapter.js';
import type { RpcClient } from '../ipc/rpc.js';
import { DeliveryError } from '../shared/errors.js';
import { HEALTH_WAKE_NOTICE, type Endpoint, type Peer } from '../types.js';
import { temporary } from './support/temporary.js';

function fixture(t:TestContext){
  const home=temporary(t),adapter=new CodexAdapter(DEFAULT_CONFIG,home),address='unix://'+path.join(home,'native.sock');
  t.after(()=>adapter.close());
  const peer:Peer={id:'peer',host:'codex',kind:'root',owner:'nxbridge',sessionId:'parent',cwd:home,name:'测试',parentId:null,permission:'prompting',state:'ready',updatedAt:0};
  const endpoint:Endpoint={peerId:peer.id,address,epoch:'epoch',mode:'app-server',pid:process.pid,procStart:'测试原生代次',seenAt:0,active:true};
  const thread:CodexThread={id:peer.sessionId!,cwd:home,status:{type:'idle'}},calls:string[]=[];
  const rpc={closed:false,close(){this.closed=true;},request:async(method:string,params:unknown,options:unknown):Promise<unknown>=>{
    calls.push(method);
    if(method==='thread/read'){
      assert.deepEqual(params,{threadId:peer.sessionId,includeTurns:false});
      return{thread};
    }
    assert.equal(method,'turn/start');
    assert.deepEqual(params,{threadId:peer.sessionId,input:[{type:'text',text:HEALTH_WAKE_NOTICE}]});
    assert.deepEqual(options,{mutation:true});
    return{turn:{id:'实际接收唤醒的轮次'}};
  }};
  t.mock.method(adapter,'connect',async()=>rpc as unknown as RpcClient);
  return{adapter,endpoint,peer,thread,calls,rpc,wake:(guard:()=>Promise<boolean>=async()=>true,signal?:AbortSignal)=>adapter.wakeSubagents(peer,endpoint,signal,guard)};
}

test('仅已加载空闲父线程收到完成信号并返回原生轮次',async t=>{
  const f=fixture(t);t.mock.method(f.adapter as any,'completionNative',async(endpoint:Endpoint)=>assert.equal(endpoint,f.endpoint));
  assert.equal(await f.wake(async()=>{assert.deepEqual(f.calls,['thread/read']);return true;}),'实际接收唤醒的轮次');
  assert.deepEqual(f.calls,['thread/read','turn/start']);
  assert.equal(f.adapter.hasSubscription(f.peer,f.endpoint),false);
});

test('活跃、卸载、等待审批或输入的父线程不进入提交守卫',async t=>{
  const f=fixture(t);t.mock.method(f.adapter as any,'completionNative',async()=>{});
  for(const status of [{type:'active'},{type:'notLoaded'},{type:'idle',activeFlags:['waitingForApproval']},{type:'idle',activeFlags:['waitingForUserInput']}]){
    f.thread.status=status;
    assert.equal(await f.wake(async()=>assert.fail('忙碌或卸载的线程不应接受授权')),undefined);
  }
  assert.deepEqual(f.calls,['thread/read','thread/read','thread/read','thread/read']);
});

test('原生代次不匹配、授权拒绝和授权期间的新原生状态阻止提交',async t=>{
  const f=fixture(t);
  await assert.rejects(f.wake(),{code:'wake_route_unverified',uncertain:false});
  assert.deepEqual(f.calls,[]);
  t.mock.method(f.adapter as any,'completionNative',async()=>{});
  assert.equal(await f.wake(async()=>false),undefined);
  assert.equal(await f.wake(async()=>{
    (f.adapter as any).notify(f.endpoint.address,{method:'thread/status/changed',params:{threadId:f.peer.sessionId,status:{type:'active',activeFlags:['waitingForApproval']}}});
    return true;
  }),undefined);
  const controller=new AbortController();
  assert.equal(await f.wake(async()=>{controller.abort();return true;},controller.signal),undefined);
  assert.deepEqual(f.calls,['thread/read','thread/read','thread/read']);
});

test('原生提交后撤销等待或缺少轮次回执保留结果不确定',async t=>{
  const f=fixture(t);t.mock.method(f.adapter as any,'completionNative',async()=>{});
  const normal=f.rpc.request,controller=new AbortController();
  f.rpc.request=async(method,params,options)=>{
    const response=await normal(method,params,options);
    if(method==='turn/start'){controller.abort();return{};}
    return response;
  };
  await assert.rejects(f.wake(undefined,controller.signal),error=>error instanceof DeliveryError&&error.uncertain);
  await assert.rejects(f.wake(),{code:'wake_result_unknown',uncertain:true});
  assert.deepEqual(f.calls,['thread/read','turn/start','thread/read','turn/start']);
});

test('队列的最后空闲复核只用已有连接，断连、审批或新的原生进展都拒绝',async t=>{
  const f=fixture(t);
  assert.equal(await f.adapter.queueWakeReady(f.peer,f.endpoint),false);assert.deepEqual(f.calls,[]);
  (f.adapter as any).clients.set(f.endpoint.address,f.rpc);
  assert.equal(await f.adapter.queueWakeReady(f.peer,f.endpoint),true);
  f.thread.status={type:'active',activeFlags:['waitingForApproval']};
  assert.equal(await f.adapter.queueWakeReady(f.peer,f.endpoint),false);
  f.thread.status={type:'idle'};
  const normal=f.rpc.request;
  f.rpc.request=async(method,params,options)=>{
    const result=await normal(method,params,options);
    (f.adapter as any).notify(f.endpoint.address,{method:'thread/status/changed',params:{threadId:f.peer.sessionId,status:{type:'active'}}});
    return result;
  };
  assert.equal(await f.adapter.queueWakeReady(f.peer,f.endpoint),false);
  f.rpc.closed=true;assert.equal(await f.adapter.queueWakeReady(f.peer,f.endpoint),false);
  assert.ok(f.calls.every(method=>method==='thread/read'));
});
