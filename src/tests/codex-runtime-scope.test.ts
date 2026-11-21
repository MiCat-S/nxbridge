import test, {type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {writeFileSync} from 'node:fs';
import {assertCodexRuntimeScope} from '../hosts/codex/codex-restart.js';
import {CodexAdapter, type CodexThread} from '../hosts/codex/adapter.js';
import {RpcClient} from '../ipc/rpc.js';
import {processIdentity} from '../process/process.js';
import {BridgeError} from '../shared/errors.js';
import {DEFAULT_CONFIG,DEFAULT_RETENTION} from '../config/defaults.js';
import {type Endpoint,type Peer} from '../types.js';
import {modelError} from '../integration/mcp/model-output.js';
import { fixture } from './support/broker-fixture.js';
import { registration } from './support/registration.js';
import { temporary } from './support/temporary.js';

function native(t:TestContext,values:CodexThread[],loaded=values.map(thread=>thread.id)){
  const threads=new Map(values.map(thread=>[thread.id,thread])),queue=new Map<string,unknown[]>(),terminals=new Map<string,unknown[]>(),calls:string[]=[];
  const rpc=new RpcClient(message=>{
    calls.push(message.method!);const id=message.params?.threadId,thread=threads.get(id);
    let result:unknown;
    switch(message.method){
      case'thread/loaded/list':result={data:loaded};break;
      case'thread/read':result={thread};break;
      case'thread/turns/list':if(thread?.ephemeral){queueMicrotask(()=>rpc.receive({id:message.id,error:{code:-32600,message:'ephemeral threads do not support thread/turns/list'}}));return;}result={data:[...(thread?.turns??[])].reverse()};break;
      case'thread/queue/list':result={data:queue.get(id)??[]};break;
      case'thread/backgroundTerminals/list':result={data:terminals.get(id)??[]};break;
      default:assert.fail('不应调用原生变更：'+message.method);
    }
    queueMicrotask(()=>rpc.receive({id:message.id,result}));
  },()=>{});t.after(()=>rpc.close());return{rpc,threads,queue,terminals,calls};
}
const child=(id:string,parent='root',status='idle'):CodexThread=>({id,cwd:'/project',parentThreadId:parent,status:{type:status}});

test('原生父链覆盖嵌套子代理及未加载的中间父线程，全部核验只读',async t=>{
  const f=native(t,[child('parent'),child('grandchild','parent'),child('old','root','notLoaded')],['root','grandchild','old']);
  await assertCodexRuntimeScope(f.rpc,'root');
  assert.ok(f.calls.includes('thread/backgroundTerminals/list'));assert.ok(f.calls.every(method=>/^(thread\/(loaded\/list|read|turns\/list|queue\/list|backgroundTerminals\/list))$/.test(method)));
  f.threads.get('grandchild')!.status={type:'active'};
  await assert.rejects(assertCodexRuntimeScope(f.rpc,'root'),{code:'subagent_active'});
});

for(const [name,thread,code] of [
  ['其他根会话',{id:'other',cwd:'/project',status:{type:'idle'}},'shared_runtime'],
  ['不支持轮次历史的临时根会话',{id:'ephemeral-root',cwd:'/project',ephemeral:true,status:{type:'idle'}},'shared_runtime'],
  ['其他 fork',{id:'fork',cwd:'/project',forkedFromId:'root',status:{type:'idle'}},'shared_runtime'],
  ['缺失父链',{id:'orphan',cwd:'/project',threadSource:'subagent',status:{type:'idle'}},'restart_verification_failed'],
  ['自环父链',child('cycle','cycle'),'restart_verification_failed'],
  ['审批中的子代理',{...child('approval'),status:{type:'active',activeFlags:['waitingForApproval']}},'subagent_active'],
  ['元数据空闲但轮次未结束',{...child('turn'),turns:[{id:'in-progress',status:'inProgress'}]},'subagent_active'],
  ['状态未知的子代理',{...child('unknown'),status:undefined},'subagent_active'],
] satisfies [string,CodexThread,string][])test('宿主范围不放行'+name,async t=>{
  const f=native(t,[thread]);await assert.rejects(assertCodexRuntimeScope(f.rpc,'root'),{code});
});

test('自有临时子代理只在原生状态空闲且没有排队和后台任务时允许停止',async t=>{
  const thread={...child('ephemeral-child'),ephemeral:true},f=native(t,[thread]);await assertCodexRuntimeScope(f.rpc,'root');
  assert.equal(f.calls.includes('thread/turns/list'),false);
  thread.status={type:'active'};await assert.rejects(assertCodexRuntimeScope(f.rpc,'root'),{code:'subagent_active'});
  thread.status={type:'idle'};f.queue.set(thread.id,[{id:'queued'}]);await assert.rejects(assertCodexRuntimeScope(f.rpc,'root'),{code:'delivery_unsettled'});
});

test('子代理排队、后台终端和未落盘末轮分别阻止停止，不清除原生工作',async t=>{
  const f=native(t,[child('child')]);
  f.queue.set('child',[{id:'queued'}]);await assert.rejects(assertCodexRuntimeScope(f.rpc,'root'),{code:'delivery_unsettled'});
  f.queue.clear();f.terminals.set('child',[{processId:'still-running'}]);await assert.rejects(assertCodexRuntimeScope(f.rpc,'root'),{code:'session_busy'});
  f.terminals.clear();const thread=f.threads.get('child')!;thread.turns=[{id:'last-child-turn',status:'completed'}];
  await assert.rejects(assertCodexRuntimeScope(f.rpc,'root'),{code:'history_not_persisted'});
  thread.path=path.join(temporary(t),'child.jsonl');writeFileSync(thread.path,JSON.stringify({type:'event_msg',payload:{type:'task_complete',turn_id:'last-child-turn'}})+'\n','utf8');
  await assertCodexRuntimeScope(f.rpc,'root');
});

function bridge(t:TestContext){
  const f=fixture(t),pair=f.store.pair(f.c.id,f.x.id);f.store.updatePeer(f.x.id,{owner:'nxbridge'});
  const endpoint=f.store.endpoint(f.x.id)!,first=f.store.register(registration('codex','child',{kind:'subagent',parentId:'x',endpoint:{...endpoint,epoch:'child'}})),second=f.store.register(registration('codex','grandchild',{kind:'subagent',parentId:'child',endpoint:{...endpoint,epoch:'grandchild'}}));
  f.codex.observe=async()=>{};return{...f,pair,endpoint,first,second};
}

for(const partner of [false,true])test((partner?'搭档':'普通')+'重启接受自有空闲子代理，停止时只停用原宿主代次',async t=>{
  const f=bridge(t),input=partner?{actor:{host:'claude',sessionId:'c',callId:'restart'},partner:true}:{};
  f.store.updatePeer(f.first.id,{state:'paused'});
  (f.codex as any).restart=async(peer:Peer,endpoint:Endpoint,guard:()=>void)=>{
    guard();f.codex.emit('runtimeStopped',endpoint);
    f.store.adopt(peer.id,registration('codex','x',{endpoint:{...endpoint,address:'new-runtime',epoch:'new-runtime'}}));
    return{endpoint:'new-runtime',oldPid:1,pid:2,resumed:{model:'test'}};
  };
  assert.equal((await f.broker.dispatch('codex.restart.target',input) as any).peer_id,f.x.id);
  assert.equal((await f.broker.dispatch('codex.restart',input) as any).restarted,true);
  assert.equal(f.store.endpoint(f.first.id),undefined);assert.equal(f.store.endpoint(f.second.id),undefined);
  assert.equal(f.store.peer(f.first.id).state,'offline');assert.equal(f.store.peer(f.first.id).owner,'user');assert.equal(f.store.endpoint(f.x.id)?.address,'new-runtime');
  assert.equal(f.store.pairs().length,1);assert.deepEqual((f.broker as any).pairAnomalies.issues(f.first.id),[]);
});

test('子代理的活动、桥接投递和晚到任务均阻止重启，其他根线程仍报共享宿主',async t=>{
  const f=bridge(t);let stopped=0;(f.codex as any).restart=async()=>{stopped++;};
  for(const state of ['busy','needsHuman','unknown','starting'] as const){f.store.updatePeer(f.first.id,{state});await assert.rejects(f.broker.dispatch('codex.restart',{}),{code:'subagent_active'});}
  f.store.updatePeer(f.first.id,{state:'ready'});
  const message=f.store.accept(f.pair,f.c,'子代理未确认的既有投递','child-delivery');
  (f.store as any).db.prepare('UPDATE messages SET recipient=? WHERE id=?').run(f.first.id,message.id);
  f.store.deactivate(f.first.id);await assert.rejects(f.broker.dispatch('codex.restart',{}),{code:'delivery_unsettled'});assert.equal(f.store.message(message.id).attempts,0);
  f.store.transition(message.id,'contextObserved');
  f.store.setSetting('codexWake:'+f.first.id,{scope:'child',anchor:'pending',attempts:1,at:1});await assert.rejects(f.broker.dispatch('codex.restart',{}),{code:'delivery_unsettled'});f.store.setSetting('codexWake:'+f.first.id,null);
  const foreign=f.store.register(registration('codex','other-root',{endpoint:{...f.endpoint,epoch:'foreign'}}));
  await assert.rejects(f.broker.dispatch('codex.restart',{}),{code:'shared_runtime'});f.store.deactivate(foreign.id);
  (f.codex as any).restart=async(_peer:Peer,_endpoint:Endpoint,guard:()=>void)=>{f.codex.emit('turnStarted',f.second.sessionId,f.endpoint.address);guard();stopped++;};
  await assert.rejects(f.broker.dispatch('codex.restart',{}),{code:'subagent_active'});assert.equal(stopped,0);assert.equal(f.store.peer(f.x.id).state,'ready');
});

for(const partner of [false,true])test((partner?'搭档':'普通')+'重启兼容既有三个已卸载子代理，保留发往 Claude 的历史未知消息',async t=>{
  const f=bridge(t),third=f.store.register(registration('codex','third-child',{kind:'subagent',parentId:'x',endpoint:{...f.endpoint,epoch:'third-child'}}));
  f.store.updatePeer(f.first.id,{state:'paused'});
  const unknown=f.store.accept(f.pair,f.x,'既有发往 Claude 的未知投递','root-outbound');f.store.transition(unknown.id,'unknown');
  const childUnknown=f.store.accept(f.pair,f.x,'既有子代理发往 Claude 的未知投递','child-outbound');
  (f.store as any).db.prepare('UPDATE messages SET sender=? WHERE id=?').run(f.first.id,childUnknown.id);f.store.transition(childUnknown.id,'unknown');
  const before=[f.store.message(unknown.id),f.store.message(childUnknown.id)];
  const adapter=new CodexAdapter(DEFAULT_CONFIG,temporary(t));t.after(()=>adapter.close());
  const rpc=native(t,[child('child','x','notLoaded'),child('grandchild','child','notLoaded'),child('third-child','x','notLoaded')]).rpc;
  adapter.connect=async()=>rpc;adapter.on('register',(input,memberId)=>f.codex.emit('register',input,memberId));adapter.on('state',(...args)=>f.codex.emit('state',...args));
  f.codex.observe=(peer,endpoint)=>adapter.observe(peer,endpoint);
  (f.codex as any).restart=async(peer:Peer,endpoint:Endpoint,guard:()=>void)=>{guard();f.codex.emit('runtimeStopped',endpoint);f.store.adopt(peer.id,registration('codex','x',{endpoint:{...endpoint,address:'replacement',epoch:'replacement'}}));return{endpoint:'replacement',oldPid:1,pid:2,resumed:{model:'test'}};};
  const input=partner?{actor:{host:'claude',sessionId:'c',callId:'restart'},partner:true}:{};
  assert.equal((await f.broker.dispatch('codex.restart',input) as any).restarted,true);
  for(const peer of [f.first,f.second,third]){assert.equal(f.store.endpoint(peer.id),undefined);assert.equal(f.store.peer(peer.id).state,'offline');}
  assert.deepEqual([f.store.message(unknown.id),f.store.message(childUnknown.id)],before);
});

for(const state of ['dead','alive','unknown'] as const)test('地址复用的旧子端点进程代次为 '+state+' 时只回收已确认退出的记录',async t=>{
  const f=bridge(t),identity=state==='alive'?await processIdentity(process.pid):undefined;
  const stale=f.store.register(registration('codex','stale-child',{kind:'subagent',parentId:'x',endpoint:{...f.endpoint,epoch:'stale-child',runtimeId:'old-runtime',pid:identity?.pid??2147483647,procStart:identity?.startedAt??(state==='dead'?'old-generation':null)}}));
  let stopped=false;(f.codex as any).restart=async(_peer:Peer,_endpoint:Endpoint,guard:()=>void)=>{guard();stopped=true;return{oldPid:1,pid:2,resumed:{model:'test'}};};
  if(state==='dead'){assert.equal((await f.broker.dispatch('codex.restart',{}) as any).restarted,true);assert.equal(f.store.endpoint(stale.id),undefined);assert.equal(f.store.peer(stale.id).state,'offline');}
  else{await assert.rejects(f.broker.dispatch('codex.restart',{}),{code:'shared_runtime'});assert.ok(f.store.endpoint(stale.id));}
  assert.equal(stopped,state==='dead');
});

test('升级刷新停用未加载子代理，原生结束通知和再次启动保持端点生命周期',async t=>{
  const f=bridge(t),observed:string[]=[];
  const identity=await processIdentity(process.pid);
  for(const peer of [f.first,f.second])for(const endpoint of f.store.endpoints(peer.id))f.store.saveEndpoint({...endpoint,procStart:identity.startedAt});
  f.store.updatePeer(f.first.id,{state:'paused'});
  f.codex.observe=async(peer,endpoint)=>{observed.push(peer.id);f.codex.emit('register',registration('codex',peer.sessionId!,{kind:'subagent',parentId:peer.parentId??undefined,state:'offline',endpoint}),peer.id);};
  await f.broker.start();assert.ok(observed.includes(f.first.id));assert.equal(f.store.endpoint(f.first.id),undefined);assert.ok(f.store.endpoint(f.x.id));
  const adapter=new CodexAdapter(DEFAULT_CONFIG,temporary(t));t.after(()=>adapter.close());
  adapter.on('state',(sessionId,state,address)=>f.codex.emit('state',sessionId,state,address));
  f.store.register(registration('codex','child',{kind:'subagent',parentId:'x',endpoint:{...f.endpoint,epoch:'child'}}));
  (adapter as any).notify(f.endpoint.address,{method:'thread/status/changed',params:{threadId:'child',status:{type:'notLoaded'}}});assert.equal(f.store.endpoint(f.first.id),undefined);
  f.store.register(registration('codex','child',{kind:'subagent',parentId:'x',endpoint:{...f.endpoint,epoch:'child'}}));
  f.store.updatePeer(f.first.id,{state:'paused'});f.codex.emit('turnStarted','child',f.endpoint.address);assert.equal(f.store.peer(f.first.id).state,'busy');
  (adapter as any).notify(f.endpoint.address,{method:'thread/closed',params:{threadId:'child'}});assert.equal(f.store.endpoint(f.first.id),undefined);
});

test('原宿主退出不撤销其他代次或其他地址端点，离线子代理按既有保留策略回收',async t=>{
  const f=bridge(t),changed=f.store.register(registration('codex','changed-generation',{kind:'subagent',parentId:'x',endpoint:{...f.endpoint,epoch:'changed',procStart:'new-generation'}}));
  const other=f.store.register(registration('codex','other-address',{kind:'subagent',parentId:'x',endpoint:{...f.endpoint,address:'other-address',epoch:'other'}}));
  f.codex.emit('runtimeStopped',f.endpoint);assert.ok(f.store.endpoint(changed.id));assert.ok(f.store.endpoint(other.id));
  f.store.updatePeer(f.first.id,{updatedAt:0});f.store.updatePeer(f.second.id,{updatedAt:0});
  f.store.maintain({peerMaxIdleMs:1},Date.now()+DEFAULT_RETENTION.historyMaxAgeMs+1000);
  assert.equal(f.store.getPeer(f.first.id),undefined);assert.equal(f.store.getPeer(f.second.id),undefined);assert.ok(f.store.getPeer(f.x.id));
});

test('子代理活动与其他根宿主错误有明确模型处理步骤',()=>{
  assert.match(modelError(new BridgeError('subagent_active','中文')).message,/own subagent.*retry once.*no loop/);
  assert.match(modelError(new BridgeError('shared_runtime','中文')).message,/another Codex root session.*nothing stopped.*tell user/);
});
