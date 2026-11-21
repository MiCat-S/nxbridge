import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './support/broker-fixture.js';
import { elicitPartner } from '../broker/pairing/pair-elicitation.js';

for(const host of ['claude','codex'] as const)test(`${host} 隐式发送过滤无法核验的旧窗口，自动创建后台且不接管窗口`,async t=>{
  const {store,broker,c,x,codex,claude}=fixture(t,{implicit:'on-demand'}),sender=host==='claude'?c:x,target=host==='claude'?x:c,adapter=host==='claude'?codex:claude;
  adapter.probe=async peer=>peer.id===target.id?{state:'unknown',nativeState:'unknown',reasons:['无法核验'],checked_at:Date.now()}:{state:'reachable',reasons:[],checked_at:Date.now()};
  const result=await broker.dispatch('send',{actor:{host,sessionId:sender.sessionId!,callId:'first'},message:'自动配对原正文'}) as any;
  assert.ok(result.message_id);assert.notEqual(store.message(result.message_id).to,target.id);assert.equal(store.peer(target.id).owner,'user');assert.equal(store.peer(target.id).state,'ready');assert.equal(adapter.attached.length,0);
});

test('最后候选消失后在显示前自动提交原草稿，并发重试和重读只接受一次',async t=>{
  const {store,broker,c,x,codex}=fixture(t,{implicit:'on-demand'}),actor={host:'claude' as const,sessionId:c.sessionId!,callId:'original'};
  const selected=await broker.dispatch('send',{actor,message:'仅此原草稿'}) as any;assert.equal(selected.status,'selection_required');
  store.updatePeer(x.id,{state:'offline'});
  const before=await broker.dispatch('pair.selection.get',{actor,selection_id:selected.selection_id}) as any;assert.equal(before.status,'selection_required');assert.equal(store.messages().length,0);
  const resolve=()=>broker.dispatch('pair.selection.resolve',{actor,selection_id:selected.selection_id});
  const [first,second]=await Promise.all([resolve(),resolve()]) as any[];assert.equal(first.message_id,second.message_id);assert.ok(first.message_id);
  assert.equal((await resolve() as any).message_id,first.message_id);assert.equal(store.messages().length,1);assert.equal(store.messages()[0]!.body,'仅此原草稿');assert.ok(codex.created.length<=1);
});

test('仍有真实窗口就保留选择；显式打开和禁止隐式创建时即使空列表也不自动选',async t=>{
  const {store,broker,c,x}=fixture(t,{implicit:'on-demand'}),actor={host:'claude' as const,sessionId:c.sessionId!,callId:'draft'};
  const draft=await broker.dispatch('send',{actor,message:'真实选择'}) as any,resolve=(selection:any)=>broker.dispatch('pair.selection.resolve',{actor,selection_id:selection.selection_id}) as Promise<any>;
  const choice=await resolve(draft);assert.equal(choice.status,'selection_required');assert.equal(choice.candidates[0].member_id,x.id);assert.equal(store.messages().length,0);
  const explicit=await broker.dispatch('pair.code',{actor:{...actor,callId:'explicit'}}) as any;store.updatePeer(x.id,{state:'offline'});
  assert.equal((await resolve(explicit)).status,'selection_required');assert.equal(store.pairs().length,0);
  const implicit=store.selections.create(c,{...actor,callId:'disabled'},broker.config,{actor:{...actor,callId:'disabled'},message:'保持关闭'}) as any;
  broker.config.implicit='never';const disabled=await resolve(implicit);assert.equal(disabled.status,'selection_required');assert.ok(!disabled.allowed_actions.includes('create'));assert.equal(store.messages().length,0);
});

test('失效候选的自动处理也适用于没有原生表单能力的 MCP 客户端',async t=>{
  const {store,broker,c,x}=fixture(t,{implicit:'on-demand'}),actor={host:'claude' as const,sessionId:c.sessionId!,callId:'no-form'};
  const selection=await broker.dispatch('send',{actor,message:'不依赖表单'}) as any;store.updatePeer(x.id,{state:'offline'});let forms=0;
  const result=await elicitPartner({getClientCapabilities:()=>({}),elicitInput:async()=>{forms++;throw Error('不应弹窗');}},selection,(method,params)=>broker.dispatch(method,{actor,...params})) as any;
  assert.ok(result.message_id);assert.equal(forms,0);assert.equal(store.messages().length,1);
});

test('失去搭档和原上下文待核验的选择不自动新建',async t=>{
  for(const reason of ['pair_lost','lineage_choice','lineage_unverified'] as const){
    const {store,broker,c,x}=fixture(t,{implicit:'on-demand'}),actor={host:'claude' as const,sessionId:c.sessionId!,callId:reason};store.updatePeer(x.id,{state:'offline'});
    if(reason==='pair_lost'){const pair=store.pair(c.id,x.id);store.unpair(pair.id,{reason:'window_exit',actor:'原生观察'});}
    const view=store.selections.create(c,actor,broker.config,{actor,message:'保留原上下文'},reason,Date.now()+60000) as any;
    const resolved=await broker.dispatch('pair.selection.resolve',{actor,selection_id:view.selection_id}) as any;assert.ok(['selection_required','lineage_held'].includes(resolved.status));assert.equal(store.messages().length,0);assert.equal(store.pairs().length,0);
  }
});
