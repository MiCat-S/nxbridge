import test from 'node:test';
import assert from 'node:assert/strict';
import { RpcClient, clearRpcFaults, type RpcMessage } from '../ipc/rpc.js';
import { readCodexThread, readCodexItems } from '../hosts/codex/codex-evidence.js';
import {TurnHealthTracker} from '../broker/health/turn-health.js';

function mockRpc(handle:(message:RpcMessage)=>unknown,endpoint?:string){
  const requests:RpcMessage[]=[];const rpc=new RpcClient(message=>{requests.push(message);queueMicrotask(()=>{try{rpc.receive({id:message.id,result:handle(message)});}catch(error){rpc.receive({id:message.id,error:error as any});}});},()=>{},endpoint);
  return{rpc,requests};
}

for(const state of ['idle','active'])test('尚未物化的 '+state+' 线程保留元数据，首次输入后重新读取轮次且不触发协议熔断',async t=>{
  let materialized=false;const endpoint='test://not-materialized/'+state;
  const {rpc,requests}=mockRpc(({method,params})=>{
    if(method==='thread/read')return{thread:{id:'fresh',status:{type:state}}};
    assert.equal(method,'thread/turns/list');assert.equal(params.threadId,'fresh');
    if(!materialized)throw{code:-32600,message:'thread fresh is not materialized yet; thread/turns/list is unavailable before first user message'};
    return{data:[{id:'first-real-turn',status:'completed'}]};
  },endpoint);t.after(()=>{rpc.close();clearRpcFaults(endpoint);});
  const initial=await readCodexThread(rpc,'fresh',{progress:true});assert.equal(initial.status?.type,state);assert.deepEqual(initial.turns,[]);assert.equal(initial.progressEvidence,state==='active'?false:undefined);
  materialized=true;assert.equal((await readCodexThread(rpc,'fresh')).turns?.at(-1)?.id,'first-real-turn');assert.equal(requests.filter(value=>value.method==='thread/turns/list').length,2);assert.equal(rpc.metrics.rejected,0);
});

test('其他线程的未物化错误及普通无效请求不被当成本线程的空历史',async t=>{
  for(const message of ['thread other is not materialized yet','invalid request']){
    const {rpc}=mockRpc(({method})=>{if(method==='thread/read')return{thread:{id:'target',status:{type:'idle'}}};throw{code:-32600,message};});t.after(()=>rpc.close());
    await assert.rejects(readCodexThread(rpc,'target'),{code:'-32600',message});
  }
});

test('原生运行状态和参数错误不熔断后续读取，只有缺少方法会短暂停止同类请求',async t=>{
  for(const code of [-32600,-32602,-32601]){
    const endpoint='test://rpc-error/'+code;let failed=true;
    const {rpc,requests}=mockRpc(()=>{if(failed)throw{code,message:code===-32600?'thread not loaded':'native error'};return{ready:true};},endpoint);
    t.after(()=>{rpc.close();clearRpcFaults(endpoint);});
    await assert.rejects(rpc.request('thread/read',{threadId:'target'}),{code:String(code)});failed=false;
    if(code===-32601){await assert.rejects(rpc.request('thread/read',{threadId:'target'}),{code:String(code)});assert.equal(requests.length,1);}
    else{assert.deepEqual(await rpc.request('thread/read',{threadId:'target'}),{ready:true});assert.equal(requests.length,2);}
  }
});

test('长轮次概要不变时只读取最新一项，持续的新工具进展不误报停滞，入站条目不冒充进展',async t=>{
  t.mock.timers.enable({apis:['Date'],now:1000000});let item:any={id:'0',type:'agentMessage',text:'实际进展'};
  const {rpc,requests}=mockRpc(({method,params})=>{
    if(method==='thread/read'){assert.equal(params.includeTurns,false);return{thread:{id:'t',status:{type:'active'}}};}
    if(method==='thread/turns/list'){assert.equal(params.limit,1);assert.equal(params.itemsView,'summary');return{data:[{id:'turn',status:'inProgress',items:[]}]};}
    assert.equal(method,'thread/items/list');assert.equal(params.limit,1);assert.equal(params.turnId,'turn');assert.equal(params.sortDirection,'desc');return{data:[{turnId:'turn',item}]};
  });t.after(()=>rpc.close());
  const health=new TurnHealthTracker(),read=async()=>health.read('endpoint',await readCodexThread(rpc,'t',{progress:true}));await read();
  for(let i=1;i<=20;i++){t.mock.timers.tick(60000);item={id:String(i),type:'mcpToolCall',status:'completed'};assert.equal((await read())?.state,'running');}
  const progress=health.get('endpoint','t')!.lastProgressAt;t.mock.timers.tick(60000);item={id:'incoming',type:'functionCallOutput',namespace:'claude',name:'receive_messages'};await read();assert.equal(health.get('endpoint','t')!.lastProgressAt,progress);
  assert.equal(requests.filter(request=>request.method==='thread/items/list').length,22);
});

test('最新条目读取不支持时明确保留进展未知，不重试该方法或回退全历史',async t=>{
  const {rpc,requests}=mockRpc(({method})=>{
    if(method==='thread/read')return{thread:{id:'t',status:{type:'active'}}};
    if(method==='thread/turns/list')return{data:[{id:'turn',status:'inProgress',items:[]}]};
    throw{code:-32601,message:'method not found'};
  });t.after(()=>rpc.close());
  assert.equal((await readCodexThread(rpc,'t',{progress:true})).progressEvidence,false);
  assert.equal((await readCodexThread(rpc,'t',{progress:true})).progressEvidence,false);
  assert.equal(requests.filter(request=>request.method==='thread/items/list').length,1);
  assert.ok(requests.filter(request=>request.method==='thread/read').every(request=>request.params.includeTurns===false));
});

test('轮次概要单次共享，不拉取全量；线程不支持不污染其他线程或条目方法',async t=>{
  const {rpc,requests}=mockRpc(({method,params})=>{if(method==='thread/read'){assert.equal(params.includeTurns,false);return{thread:{id:params.threadId}};}if(method==='thread/turns/list'){assert.equal(params.itemsView,'summary');if(params.threadId==='old')throw{code:-32000,message:'list_turns is not supported yet'};return{data:[{id:'new'},{id:'old'}]};}return{data:[]};});t.after(()=>rpc.close());
  await Promise.all([readCodexThread(rpc,'old'),readCodexThread(rpc,'old')]);assert.equal(requests.filter(v=>v.method==='thread/read').length,1);
  await readCodexThread(rpc,'old');assert.equal(requests.filter(v=>v.method==='thread/turns/list').length,1);
  assert.deepEqual((await readCodexThread(rpc,'new',{turnId:'old'})).turns?.map(v=>v.id),['old','new']);
  assert.equal((await readCodexItems(rpc,'old')).complete,true);
});

test('条目从最新页读取；超预算不推进边界或声称缺席，后续新增仍可读',async t=>{
  let ids=['0'];const {rpc}=mockRpc(({params})=>{const start=Number(params.cursor??0),data=ids.slice(start,start+16).map(id=>({item:{id}}));return{data,nextCursor:start+16<ids.length?String(start+16):null};});t.after(()=>rpc.close());
  assert.equal((await readCodexItems(rpc,'thread')).complete,true);
  ids=Array.from({length:40},(_,i)=>String(40-i)).concat('0');let result=await readCodexItems(rpc,'thread');assert.equal(result.complete,false);assert.equal(result.items.length,32);
  ids.unshift('41');result=await readCodexItems(rpc,'thread');assert.equal(result.items[0].item.id,'41');assert.equal(result.complete,false);
  ids=['42','0'];result=await readCodexItems(rpc,'thread');assert.equal(result.complete,true);assert.deepEqual(result.items.map(v=>v.item.id),['42']);
});

test('RPC 大响应只隔离所属读取；套接字断开不连带熔断，写超时仍保持不确定',async t=>{
  t.mock.timers.enable({apis:['Date'],now:1000000});const endpoint='test://rpc-budget';clearRpcFaults(endpoint);const sent:RpcMessage[]=[];
  const rpc=new RpcClient(m=>sent.push(m),()=>{},endpoint);t.after(()=>rpc.close());
  const large=rpc.request('thread/items/list',{threadId:'big'},{maxBytes:8});rpc.receive({id:sent.at(-1)!.id,result:{}},{bytes:9,parseMs:1});await assert.rejects(large,{code:'response_too_large'});
  await assert.rejects(rpc.request('thread/items/list',{threadId:'big'}),{code:'response_too_large'});
  const other=rpc.request('thread/items/list',{threadId:'small'});rpc.receive({id:sent.at(-1)!.id,result:{ok:true}},{bytes:7,parseMs:1});assert.deepEqual(await other,{ok:true});
  const read=rpc.request('thread/read',{threadId:'small'}),write=rpc.request('thread/inject_items',{threadId:'small'},{mutation:true});rpc.disconnected('关闭1009','payload_too_large');
  await assert.rejects(read,{code:'payload_too_large',uncertain:false});await assert.rejects(write,{code:'payload_too_large',uncertain:true});
  const next=new RpcClient(m=>queueMicrotask(()=>next.receive({id:m.id,result:true})),()=>{},endpoint);t.after(()=>next.close());assert.equal(await next.request('thread/read',{threadId:'small'}),true);
  t.mock.timers.tick(900000);assert.equal(await next.request('thread/items/list',{threadId:'big'}),true);
});
