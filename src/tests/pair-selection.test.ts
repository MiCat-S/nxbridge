import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fixture } from './support/broker-fixture.js';
import { registration } from './support/registration.js';
import type { Actor, Host } from '../types.js';
import type { Store } from '../storage/store.js';
import { daemonWakeAuthorized } from '../hosts/codex/daemon-wake.js';
import { changeNotices } from '../broker/pairing/pair-changes.js';

function foreground(store:Store,host:Host,id:string,pid:number){return store.register(registration(host,id,{endpoint:{mode:host==='codex'?'embedded':'claude-inbox',address:host==='codex'?'':'inbox-'+pid,epoch:id,pid,procStart:'generation-'+pid,configHome:path.resolve('/isolated',host)}}));}
function actor(store:Store,id:string,callId='selection'):Actor{const p=store.peer(id),b=store.bindings.current(id);return{host:p.host,sessionId:p.sessionId!,callId,...(b?{binding:{key:b.key,epoch:b.epoch}}:{})};}

test('已配对窗口可原地改绑：取消保留，切换终止未投递消息且未知项不重发，不抢占其他配对',async t=>{
  const f=fixture(t,{compatibilityWake:'strict'}),old=f.store.pair(f.c.id,f.x.id),next=f.store.register(registration('codex','next'));
  const otherC=f.store.register(registration('claude','other')),otherX=f.store.register(registration('codex','taken'));f.store.pair(otherC.id,otherX.id);
  const saved=f.store.accept(old,f.c,'未发','saved'),uncertain=f.store.accept(old,f.c,'在途','uncertain'),seen=f.store.accept(old,f.c,'已看','seen');f.store.claim(uncertain.id);f.store.transition(seen.id,'contextObserved');
  const a=actor(f.store,f.c.id,'change'),view=await f.broker.dispatch('pair.code',{actor:a}) as any;
  assert.equal(view.mode,'change');assert.equal(view.current_partner.member_id,f.x.id);assert.deepEqual(view.candidates.map((value:any)=>value.member_id),[next.id]);assert.ok(view.allowed_actions.includes('unpair'));
  const kept=await f.broker.dispatch('pair.selection.commit',{actor:a,selection_id:view.selection_id,action:'cancel'}) as any;assert.equal(kept.pair_unchanged,true);assert.equal(f.store.pairFor(f.c.id)?.id,old.id);assert.equal(f.store.message(saved.id).state,'accepted');
  const b=actor(f.store,f.c.id,'switch'),change=await f.broker.dispatch('pair.code',{actor:b}) as any,result=await f.broker.dispatch('pair.selection.commit',{actor:b,selection_id:change.selection_id,key:change.candidates[0].key}) as any;
  assert.equal(result.partner_name,'next');assert.deepEqual(result.cancelled_message_ids,[saved.id]);assert.deepEqual(result.uncertain_message_ids,[uncertain.id]);assert.equal(f.store.message(saved.id).state,'expired');assert.equal(f.store.message(uncertain.id).state,'unknown');assert.equal(f.store.message(seen.id).state,'contextObserved');
  assert.equal(f.store.pairFor(f.c.id)?.codex,next.id);assert.equal(f.store.pairFor(f.x.id),undefined);assert.equal(f.store.pairFor(otherX.id)?.claude,otherC.id);assert.equal(f.store.messages().length,3);
  assert.equal(daemonWakeAuthorized(f.store,f.store.pairFor(f.c.id)!),true);const notice=changeNotices(f.store,f.x);assert.equal(notice[0]?.source,'pair_changed');assert.equal(notice[0]?.wake,false);assert.match(notice[0]!.message,/do not restore this old pairing/);assert.deepEqual(changeNotices(f.store,f.x),[]);
});

test('改绑表单拒绝已变化的原配对，解除幂等且不会创建替代后台',async t=>{
  const f=fixture(t),old=f.store.pair(f.c.id,f.x.id),a=actor(f.store,f.c.id),view=await f.broker.dispatch('pair.code',{actor:a}) as any;
  f.store.unpair(old.id);f.store.pair(f.c.id,f.x.id);
  await assert.rejects(f.broker.dispatch('pair.selection.commit',{actor:a,selection_id:view.selection_id,action:'unpair'}),{code:'selection_expired'});
  const b=actor(f.store,f.c.id,'unpair'),fresh=await f.broker.dispatch('pair.code',{actor:b}) as any,request={actor:b,selection_id:fresh.selection_id,action:'unpair'},result=await f.broker.dispatch('pair.selection.commit',request) as any;
  assert.equal(result.status,'unpaired');assert.deepEqual(await f.broker.dispatch('pair.selection.commit',request),result);assert.equal(f.store.pairs().length,0);assert.equal(f.codex.created.length+f.claude.created.length,0);
});

test('配对码可替换发起窗口的原搭档，但不能抢走目标已配对的窗口',t=>{
  const f=fixture(t),c=foreground(f.store,'claude','c-window',111),x=foreground(f.store,'codex','x-window',222),next=foreground(f.store,'codex','next-window',333);f.store.pair(c.id,x.id);
  const a=actor(f.store,c.id),view=f.store.selections.create(c,a,f.broker.config) as any;
  assert.equal(f.store.selections.codeRequester(view.pairing_code).peer.id,c.id);
  const result=f.store.selections.commitCode(actor(f.store,next.id),view.pairing_code,intent=>f.broker.send(intent)) as any;assert.equal(result.status,'paired');assert.equal(f.store.pairFor(c.id)?.codex,next.id);assert.equal(f.store.pairFor(x.id),undefined);
  const other=foreground(f.store,'claude','other-window',444),request=f.store.selections.create(other,actor(f.store,other.id),f.broker.config) as any;
  assert.throws(()=>f.store.selections.commitCode(actor(f.store,next.id),request.pairing_code,intent=>f.broker.send(intent)),{code:'target_paired'});
});

test('多个候选只保留待发正文，明确选择后原消息仅接受一次',async t=>{
  const {store,broker,c,x,codex}=fixture(t,{compatibilityWake:'strict'}),x2=store.register(registration('codex','x2'));
  const input={actor:actor(store,c.id),message:'原始正文'};
  const result=await broker.dispatch('send',input) as any;
  assert.equal(result.status,'selection_required');assert.equal(store.messages().length,0);assert.equal(codex.created.length,0);assert.equal(store.pairs().length,0);
  const chosen=result.candidates.find((p:any)=>p.member_id===x2.id),choice={actor:input.actor,selection_id:result.selection_id,key:chosen.key};
  const sent=await broker.dispatch('pair.selection.commit',choice) as any;
  assert.equal(sent.persisted,true);assert.equal(store.message(sent.message_id).body,input.message);assert.equal(store.pairFor(c.id)?.codex,x2.id);
  assert.deepEqual(await broker.dispatch('pair.selection.commit',choice),sent);assert.equal(store.messages().length,1);
  assert.equal(store.pairFor(x.id),undefined);
});

test('唯一已有用户窗口也必须明确选择，双向覆盖忙碌、暂停、人工等待及旧 fork',async t=>{
  for(const host of ['claude','codex'] as const)for(const state of ['ready','busy','paused','needsHuman'] as const){
    const {store,broker,c,x,codex,claude}=fixture(t,{compatibilityWake:'strict'}),sender=host==='claude'?c:x,target=host==='claude'?x:c;
    store.updatePeer(target.id,{state,kind:'fork',activityAt:Date.now()-86400000});
    const input={actor:actor(store,sender.id),message:'只在用户选择后发送'},selection=await broker.dispatch('send',input) as any;
    assert.equal(selection.status,'selection_required');assert.equal(selection.candidates.length,1);assert.equal(selection.candidates[0].member_id,target.id);
    assert.equal(store.pairs().length,0);assert.equal(store.messages().length,0);assert.equal(codex.created.length+claude.created.length,0);
    const result=await broker.dispatch('pair.selection.commit',{actor:input.actor,selection_id:selection.selection_id,key:selection.candidates[0].key}) as any;
    assert.equal(store.message(result.message_id).to,target.id);assert.equal(store.messages().length,1);
  }
});

test('显式解除后不会在下一条发送中悄悄重绑；仍可明确选择同一个窗口',async t=>{
  const {store,broker,c,x}=fixture(t,{compatibilityWake:'strict'});
  for(let attempt=0;attempt<3;attempt++){
    const pair=store.pair(c.id,x.id);await broker.dispatch('unpair',{pair_id:pair.id});
    const a=actor(store,c.id,'after-unpair-'+attempt),selection=await broker.dispatch('send',{actor:a,message:'解除后的新消息 '+attempt}) as any;
    assert.equal(selection.status,'selection_required');assert.equal(store.pairs().length,0);assert.equal(store.messages().length,attempt);
    const selected=selection.candidates.find((p:any)=>p.member_id===x.id);assert.ok(selected);
    const result=await broker.dispatch('pair.selection.commit',{actor:a,selection_id:selection.selection_id,key:selected.key}) as any;
    assert.equal(store.message(result.message_id).to,x.id);assert.equal(store.pairFor(c.id)?.codex,x.id);
  }
});

test('没有已有候选时才按配置创建后台搭档',async t=>{
  const {store,broker,c,x}=fixture(t,{implicit:'on-demand',compatibilityWake:'strict'});store.updatePeer(x.id,{state:'offline'});
  const result=await broker.dispatch('send',{actor:actor(store,c.id),message:'新建后台协作'}) as any;
  assert.ok(result.message_id);const target=store.peer(store.message(result.message_id).to);assert.equal(target.owner,'nxbridge');assert.notEqual(target.id,x.id);
});

test('待选发送调用幂等，改正文拒绝；取消不发信也不启动',async t=>{
  const {store,broker,c,codex}=fixture(t);store.register(registration('codex','x2'));
  const input={actor:actor(store,c.id),message:'正文'},a=await broker.dispatch('send',input) as any,b=await broker.dispatch('send',input) as any;
  assert.equal(a.selection_id,b.selection_id);await assert.rejects(broker.dispatch('send',{...input,message:'更改'}),{code:'idempotency_conflict'});
  const result=await broker.dispatch('pair.selection.commit',{actor:input.actor,selection_id:a.selection_id,action:'cancel'}) as any;
  assert.equal(result.status,'selection_declined');assert.equal(store.messages().length,0);assert.equal(codex.created.length,0);
  assert.equal((await broker.dispatch('pair.selection.get',{actor:input.actor,selection_id:a.selection_id}) as any).status,'selection_declined');
});

test('bootstrap 引导允许 AI 核验独立启动，沿用原选择提交保留草稿且仅创建发送一次',async t=>{
  const {store,broker,c,x,codex}=fixture(t,{implicit:'on-demand',compatibilityWake:'strict'});store.updatePeer(x.id,{state:'offline'});
  const a=actor(store,c.id,'bootstrap-draft'),draft={actor:a,message:'保留的原始发送草稿'},selection=store.selections.create(c,a,broker.config,draft,'bootstrap_required') as any;
  assert.equal(selection.status,'bootstrap_required');assert.ok(selection.allowed_actions.includes('create'));
  assert.match(selection.message,/AI may attempt `nxbridge bootstrap` once.*verifies independent launch before handover/);
  assert.match(selection.message,/originating window.*ordinary PowerShell outside Claude\/Codex/);
  assert.match(selection.message,/same saved selection_id \+ action=create only if create was already authorized.*do not resend.*never choose for user/);
  assert.equal((store.selections.create(c,a,broker.config,draft,'bootstrap_required') as any).selection_id,selection.selection_id);
  assert.equal(store.messages().length,0);assert.equal(codex.created.length,0);assert.equal(store.pairs().length,0);
  const choice={actor:a,selection_id:selection.selection_id,action:'create'},sent=await broker.dispatch('pair.selection.commit',choice) as any;
  assert.equal(sent.selection_id,selection.selection_id);assert.equal(store.message(sent.message_id).body,draft.message);
  const repeated=await broker.dispatch('pair.selection.commit',choice) as any;
  assert.equal(repeated.message_id,sent.message_id);assert.equal(store.messages().length,1);assert.equal(codex.created.length,1);
});

test('选择提交前核验原生可达性，已关闭候选不接受原正文或启动替代窗口',async t=>{
  const {store,broker,c,x,codex}=fixture(t);store.register(registration('codex','x2'));
  const a=actor(store,c.id),selection=await broker.dispatch('send',{actor:a,message:'不可丢弃的原正文'}) as any;
  codex.probe=async()=>({state:'blocked',reasons:['native generation dead'],checked_at:Date.now()});
  const candidate=selection.candidates.find((value:any)=>value.member_id===x.id);
  await assert.rejects(broker.dispatch('pair.selection.commit',{actor:a,selection_id:selection.selection_id,key:candidate.key}),{code:'selection_expired'});
  assert.equal(store.messages().length,0);assert.equal(store.pairs().length,0);assert.equal(codex.created.length,0);
  assert.equal((await broker.dispatch('pair.selection.get',{actor:a,selection_id:selection.selection_id}) as any).selection_id,selection.selection_id);
});

test('候选被配对后拒绝旧键，刷新继续原正文；不接受任意成员 ID',async t=>{
  const {store,broker,c,x}=fixture(t,{compatibilityWake:'strict'}),x2=store.register(registration('codex','x2')),other=store.register(registration('claude','other'));
  const a=actor(store,c.id),selection=await broker.dispatch('send',{actor:a,message:'保留正文'}) as any;
  const old=selection.candidates.find((p:any)=>p.member_id===x.id);store.pair(other.id,x.id);
  await assert.rejects(broker.dispatch('pair.selection.commit',{actor:a,selection_id:selection.selection_id,key:old.key}),{code:'selection_expired'});
  await assert.rejects(broker.dispatch('pair.selection.commit',{actor:a,selection_id:selection.selection_id,key:x2.id}),{code:'selection_expired'});
  const fresh=await broker.dispatch('pair.selection.refresh',{actor:a,selection_id:selection.selection_id}) as any;
  assert.deepEqual(fresh.candidates.map((p:any)=>p.member_id),[x2.id]);
  const sent=await broker.dispatch('pair.selection.commit',{actor:a,selection_id:selection.selection_id,key:fresh.candidates[0].key}) as any;
  assert.equal(store.message(sent.message_id).body,'保留正文');assert.equal(store.pairs().length,2);
});

test('切换发起窗口对话使原选择和配对码失效，旧回调不改变新上下文',async t=>{
  const {store,broker}=fixture(t,{compatibilityWake:'strict'}),c=foreground(store,'claude','foreground',111);store.register(registration('codex','x2'));
  const a=actor(store,c.id),selection=await broker.dispatch('send',{actor:a,message:'旧上下文'}) as any;
  assert.match(selection.pairing_code,/^\d{4}$/);
  store.register({...registration('claude','new'),endpoint:{...store.endpoint(c.id)!,epoch:'new'},contextStart:true});
  await assert.rejects(broker.dispatch('pair.selection.commit',{actor:a,selection_id:selection.selection_id,key:selection.candidates[0].key}),{code:'stale_context'});
  assert.throws(()=>store.selections.commit(actor(store,c.id),{selection_id:selection.selection_id,key:selection.candidates[0].key},broker.config,i=>broker.send(i)),{code:'selection_expired'});
  assert.equal(store.pairFor(c.id),undefined);assert.equal(store.messages().length,0);
});

test('配对码只由已核验对方窗口提交且单次有效，消息仍来自原发起方',t=>{
  const {store,broker}=fixture(t,{compatibilityWake:'strict'}),c=foreground(store,'claude','fc',111),x=foreground(store,'codex','fx',222),same=foreground(store,'claude','same',333);
  const a=actor(store,c.id),intent={actor:a,message:'发起方正文'},s=store.selections.create(c,a,broker.config,intent) as any;
  assert.throws(()=>store.selections.commitCode(actor(store,same.id),s.pairing_code,i=>broker.send(i)),{code:'pairing_code_host'});
  assert.throws(()=>store.selections.commitCode({host:'codex',sessionId:'fx',callId:'model'},s.pairing_code,i=>broker.send(i)),{code:'unverified_identity'});
  const sent=store.selections.commitCode(actor(store,x.id),s.pairing_code,i=>broker.send(i)) as any;
  const message=store.message(sent.message_id);assert.equal(message.from,c.id);assert.equal(message.to,x.id);assert.equal(message.body,intent.message);
  assert.deepEqual(store.selections.view(a,s.selection_id,broker.config),sent);assert.equal(store.messages().length,1);
  assert.throws(()=>store.selections.commitCode(actor(store,same.id),s.pairing_code,i=>broker.send(i)),{code:'pairing_code_invalid'});
  assert.equal(store.messages().length,1);
});

test('两项目并行首次发信均先选择；明确配对后双向发送共用一组',async t=>{
  const {store,broker,c,x,codex,claude}=fixture(t,{compatibilityWake:'strict'}),cwd=path.resolve('/another-project'),c2=store.register(registration('claude','c2',{cwd})),x2=store.register(registration('codex','x2',{cwd}));
  const results=await Promise.all([broker.dispatch('send',{actor:actor(store,c.id,'c'),message:'项目一'}),broker.dispatch('send',{actor:actor(store,x.id,'x'),message:'项目一回复'}),broker.dispatch('send',{actor:actor(store,c2.id),message:'项目二'})]) as any[];
  assert.ok(results.every(result=>result.status==='selection_required'));assert.equal(store.pairs().length,0);assert.equal(store.messages().length,0);
  const first=await broker.dispatch('pair.selection.commit',{actor:actor(store,c.id,'c'),selection_id:results[0].selection_id,key:results[0].candidates[0].key}) as any;
  const second=await broker.dispatch('pair.selection.commit',{actor:actor(store,c2.id),selection_id:results[2].selection_id,key:results[2].candidates[0].key}) as any;
  const reverse=await broker.dispatch('send',{actor:actor(store,x.id,'after-choice'),message:'项目一回复'}) as any;
  assert.equal(store.pairs().length,2);assert.equal(store.pairFor(c.id)?.codex,x.id);assert.equal(store.pairFor(c2.id)?.codex,x2.id);
  assert.equal(store.messages().length,3);assert.equal(new Set([first,second,reverse].map(r=>r.message_id)).size,3);assert.equal(codex.created.length+claude.created.length,0);
});

test('慢速解除一组时另一组仍可发信和提问，同一成员不能同时加入两组',async t=>{
  const {store,broker,c,x,claude}=fixture(t,{compatibilityWake:'strict'}),cwd=path.resolve('/other'),c2=store.register(registration('claude','c2',{cwd})),x2=store.register(registration('codex','x2',{cwd}));
  const p1=store.pair(c.id,x.id),p2=store.pair(c2.id,x2.id);store.updatePeer(c.id,{owner:'nxbridge'});
  let release!:()=>void,started!:()=>void;const blocked=new Promise<void>(resolve=>started=resolve);claude.release=async()=>{started();await new Promise<void>(resolve=>release=resolve);};
  const work=broker.dispatch('unpair',{pair_id:p1.id});await blocked;
  const sent=await broker.dispatch('send',{actor:actor(store,c2.id),message:'另一组继续'}) as any;assert.equal(store.message(sent.message_id).pairId,p2.id);
  const q=await broker.dispatch('question.create',{actor:actor(store,x2.id,'ask'),questions:[{id:'q',header:'问题',question:'能继续吗？'}]}) as any;assert.equal(q.status,'pending');
  assert.throws(()=>store.pair(c2.id,x.id),{code:'pair_exists'});release();await work;
  assert.equal(store.pairFor(c2.id)?.id,p2.id);assert.equal(store.question(q.request_id).status,'pending');
});
