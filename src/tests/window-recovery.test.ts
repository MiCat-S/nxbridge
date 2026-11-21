import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { Store } from '../storage/store.js';
import { WindowRecovery } from '../broker/recovery/window-recovery.js';
import {DEFAULT_CONFIG} from '../config/defaults.js';
import {type Actor,type Host} from '../types.js';
import { fixture } from './support/broker-fixture.js';
import { registration } from './support/registration.js';
import { temporaryDirectory } from './support/temporary.js';
import { pairLoss } from '../broker/pairing/pair-loss.js';
import { normalizedHome } from '../integration/hooks/session-bindings.js';

for(const archived of [false,true])test(`新窗口跨配置目录在应用内恢复历史：接续原成员及${archived?'断开事实':'原配对'}，不悄悄新建搭档`,async t=>{
  const {store,broker,codex}=fixture(t,{implicit:'on-demand'}),c=store.register(window('claude','original-conversation',10,'slot-003')),x=store.register(window('codex','original-partner',11)),pair=store.pair(c.id,x.id);
  if(archived)store.unpair(pair.id,{reason:'broker_shutdown'});
  const recovery=new WindowRecovery(store,async()=>['alive','dead']);(broker as any).windowRecovery=recovery;
  const provisional=await recovery.register(window('claude','new-conversation',20,'slot-017'));
  const resumed=await recovery.register({...window('claude','original-conversation',20,'slot-017'),contextStart:true,contextReason:'switch'});
  assert.equal(resumed.id,c.id);assert.equal(store.peers().some(peer=>peer.id===provisional.id),false);
  assert.equal(store.bindings.current(c.id)!.configHome,normalizedHome(path.resolve('/isolated','slot-017','claude')));assert.equal(store.resolve(actor(store,c.id))?.id,c.id);
  if(archived){
    assert.equal(pairLoss(store,resumed)?.pair_id,pair.id);const result=await broker.dispatch('send',{actor:actor(store,resumed.id),message:'先恢复原搭档'}) as any;
    assert.equal(result.reason,'pair_lost');assert.equal(codex.created.length,0);assert.equal(store.messages().length,0);
  }else assert.equal(store.pairFor(c.id)?.id,pair.id);
});

function window(host:Host,id:string,pid:number,home='original',generation='generation-'+pid){
  return registration(host,id,{endpoint:{mode:host==='codex'?'embedded' as const:'claude-inbox' as const,address:host==='codex'?'':'inbox-'+pid,epoch:host+':'+pid+':'+home,pid,procStart:generation,configHome:path.resolve('/isolated',home,host)}});
}
function actor(store:Store,id:string,callId='send'):Actor{
  const peer=store.peer(id),binding=store.bindings.current(id)!;
  return{host:peer.host,memberId:id,sessionId:peer.sessionId!,callId,binding:{key:binding.key,epoch:binding.epoch}};
}

test('归属核验只在同次内部调用中复用，外部登记标记和 Claude 登记均不能跳过',async t=>{
  const {broker,store}=fixture(t);let checked=0;
  const recovery=new WindowRecovery(store,async()=>['alive'],undefined,undefined,async()=>{checked++;return undefined;});
  (broker as any).windowRecovery=recovery;
  const input=window('codex','request-local-check',30);
  await recovery.register({...input,managedCodexChecked:true} as typeof input);
  assert.equal(checked,1,'登记载荷里的同名标记不能跳过归属核验');
  await broker.dispatch('mcp.register',{...input,managedCodexChecked:false});
  assert.equal(checked,1,'协调器完成归属预检后复用内部凭据，忽略外部同名字段');
  await recovery.register(input,{managedCodexChecked:true});assert.equal(checked,1);
  await recovery.register(window('claude','claude-check',40),{managedCodexChecked:true});assert.equal(checked,2);
});

for(const host of ['claude'] as Host[])test(host+' 崩溃后跨配置目录恢复原成员，保留原搭档、队列及回复链接',async t=>{
  const store=new Store(':memory:');t.after(()=>store.close());
  const original=store.register(window(host,'resumed',process.pid)),partner=store.register(window(host==='claude'?'codex':'claude','partner',11));
  const pair=store.pair(host==='claude'?original.id:partner.id,host==='codex'?original.id:partner.id);
  const pending=store.accept(pair,partner,'崩溃前已排队','pending'),seen=store.accept(pair,partner,'恢复后需关联回复','seen');store.transition(seen.id,'contextObserved');
  const sending=store.accept(pair,original,'旧代次提交结果未知','sending');store.claim(sending.id);store.recover();store.updatePeer(original.id,{state:'paused'});
  const recovery=new WindowRecovery(store,async()=>['alive','dead']);
  const restored=await recovery.register(window(host,'resumed',process.pid,'replacement','new-generation'));
  assert.equal(restored.id,original.id);assert.equal(restored.state,'ready');assert.equal(store.pairFor(restored.id)?.id,pair.id);
  assert.equal(store.message(pending.id).state,'accepted');assert.equal(store.message(sending.id).state,'unknown');
  const reply=store.accept(pair,restored,'继续原任务','reply',seen.id);assert.equal(reply.inReplyTo,seen.id);assert.equal(store.message(seen.id).state,'responded');
  assert.equal(store.endpoints(original.id).filter(e=>e.active).length,1,'PID 复用不能留下旧前台端点');
  assert.equal(store.bindings.current(original.id)?.configHome,path.resolve('/isolated/replacement',host).toLowerCase());
  assert.equal(store.peers().length,2);assert.equal(store.pairs().length,1);
});

test('原生代次暂时未知时草稿持久保留，重建恢复器后只向原配对恢复一次',async t=>{
  t.mock.timers.enable({apis:['Date'],now:1000000});
  const temp=temporaryDirectory(),filename=path.join(temp.directory,'recovery.db');let store=new Store(filename);t.after(async()=>{store.close();await temp.cleanup();});
  const c=store.register(window('claude','resumed',10)),x=store.register(window('codex','partner',11)),pair=store.pair(c.id,x.id),prior=store.accept(pair,x,'原搭档任务','prior');
  let recovery=new WindowRecovery(store,async()=>['alive','unknown']);const input=window('claude','resumed',20,'new-home'),fresh=await recovery.register(input);
  const draft={actor:actor(store,fresh.id),message:'恢复后的关联回复',in_reply_to:prior.id};
  const held=recovery.hold(draft,{...DEFAULT_CONFIG,implicit:'on-demand'}) as any;
  assert.equal(held.status,'lineage_held');assert.equal(held.persisted,true);assert.deepEqual(held.allowed_actions,['cancel']);
  assert.equal(store.messages().length,1);assert.equal(store.pairFor(fresh.id),undefined);
  store.close();store=new Store(filename);recovery=new WindowRecovery(store,async()=>['alive','dead']);t.mock.timers.tick(5000);
  const send=(intent:typeof draft)=>{const peer=store.resolve(intent.actor)!;return{message_id:store.accept(store.pairFor(peer.id)!,peer,intent.message,intent.actor.sessionId+':'+intent.actor.callId,intent.in_reply_to).id};};
  await recovery.retry(send as any);await recovery.retry(send as any);
  assert.equal(store.peers().length,2);assert.equal(store.messages().length,2);assert.equal(store.messages()[1]!.from,c.id);assert.equal(store.messages()[1]!.pairId,pair.id);
  assert.equal(store.message(prior.id).state,'responded');assert.equal(store.resolve({...draft.actor,memberId:c.id})?.id,c.id);
});

for(const state of ['alive','unknown'] as const)test('旧窗口 '+state+' 时不隐式创建陌生搭档，持续不明才要求选择',async t=>{
  t.mock.timers.enable({apis:['Date'],now:1000000});
  const {store,broker,codex}=fixture(t,{implicit:'on-demand'}),c=store.register(window('claude','resumed',10)),x=store.register(window('codex','old-partner',11));store.pair(c.id,x.id);
  const recovery=new WindowRecovery(store,async()=>['alive',state]);(broker as any).windowRecovery=recovery;
  const fresh=await recovery.register(window('claude','resumed',20)),input={actor:actor(store,fresh.id),message:'不要发给陌生搭档'};
  const held=await broker.dispatch('send',input) as any;
  assert.equal(held.status,state==='unknown'?'lineage_held':'selection_required');assert.equal(codex.created.length,0);assert.equal(store.messages().length,0);
  assert.throws(()=>broker.send(input),{code:'lineage_choice'});
  if(state==='unknown'){
    await assert.rejects(broker.dispatch('pair.selection.commit',{actor:input.actor,selection_id:held.selection_id,action:'create'}),{code:'lineage_unverified'});
    t.mock.timers.tick(60001);await recovery.retry(intent=>broker.send(intent,false));
    assert.equal((await broker.dispatch('pair.selection.get',{actor:input.actor,selection_id:held.selection_id}) as any).status,'selection_required');
    assert.equal(codex.created.length,0);assert.equal(store.messages().length,0);
  }
});

test('草稿表单过期后仍保留；后续已核验登记可恢复原配对并接受原消息',async t=>{
  t.mock.timers.enable({apis:['Date'],now:1000000});
  const {store,broker}=fixture(t),c=store.register(window('claude','resumed',10)),x=store.register(window('codex','old-partner',11)),pair=store.pair(c.id,x.id);
  let oldState:'unknown'|'dead'='unknown';const recovery=new WindowRecovery(store,async()=>['alive',oldState]);(broker as any).windowRecovery=recovery;
  const input=window('claude','resumed',20),fresh=await recovery.register(input),draft={actor:actor(store,fresh.id),message:'表单过期也不丢草稿'};
  recovery.hold(draft,DEFAULT_CONFIG);t.mock.timers.tick(600001);store.selections.maintain();oldState='dead';
  assert.equal((await broker.dispatch('register',input) as any).id,c.id);assert.equal(store.messages().length,1);assert.equal(store.messages()[0]!.pairId,pair.id);
  await broker.dispatch('register',input);assert.equal(store.messages().length,1);
});

test('用户另选搭档后，旧沿袭草稿不能被后续登记误发给新搭档',async t=>{
  const {store,broker}=fixture(t),c=store.register(window('claude','resumed',10)),x=store.register(window('codex','old-partner',11));store.pair(c.id,x.id);
  const recovery=new WindowRecovery(store,async()=>['alive','unknown']);(broker as any).windowRecovery=recovery;
  const input=window('claude','resumed',20),fresh=await recovery.register(input);recovery.hold({actor:actor(store,fresh.id),message:'只能恢复给原搭档'},DEFAULT_CONFIG);
  const other=store.register(window('codex','new-partner',30)),chosen=store.pair(fresh.id,other.id);
  await broker.dispatch('register',input);assert.equal(store.pairFor(fresh.id)?.id,chosen.id);assert.equal(store.messages().length,0);
});

test('异步代次核验期间原配对改变，旧结果不能接管成员',async t=>{
  const store=new Store(':memory:');t.after(()=>store.close());const c=store.register(window('claude','resumed',10)),x=store.register(window('codex','partner',11));store.pair(c.id,x.id);
  let release!:(states:('alive'|'dead')[])=>void;
  const recovery=new WindowRecovery(store,()=>new Promise(resolve=>release=resolve)),pending=recovery.register(window('claude','resumed',20));
  const other=store.register(window('codex','other',30)),changed=store.pair(c.id,other.id,true);release(['alive','dead']);
  await assert.rejects(pending,{code:'context_changed'});assert.equal(store.pairFor(c.id)?.id,changed.id);assert.equal(store.bindings.current(c.id)?.pid,10);
});

test('已有窗口切换他人历史，或临时成员已有归档关系时，保留自己的成员与历史',async t=>{
  const {store,broker}=fixture(t),original=store.register(window('claude','old-history',10)),x=store.register(window('codex','original-partner',11)),pair=store.pair(original.id,x.id);
  let previousState:'unknown'|'dead'='unknown';
  const current=store.register(window('claude','current-history',20)),recovery=new WindowRecovery(store,async()=>['alive',previousState]);(broker as any).windowRecovery=recovery;
  const switched=await recovery.register(window('claude','old-history',20));assert.equal(switched.id,current.id);assert.equal(store.pairFor(original.id)?.id,pair.id);
  const temporary=await recovery.register(window('claude','old-history',30)),other=store.register(window('codex','explicit-partner',31)),archived=store.pair(temporary.id,other.id);store.unpair(archived.id);
  previousState='dead';
  const repeated=await recovery.register(window('claude','old-history',30));assert.equal(repeated.id,temporary.id);assert.ok(store.pairById(archived.id)?.archived);
  const held=await broker.dispatch('send',{actor:actor(store,repeated.id),message:'保留全部旧配对历史'}) as any;assert.equal(held.status,'selection_required');assert.equal(store.messages().length,0);
});

for(const mode of ['embedded','app-server'] as const)test(`托管死亡后 ${mode} 同 home 恢复接续原配对、未发送及未知消息`,async t=>{
  const {store}=fixture(t),home=path.resolve('/isolated/managed-codex'),original=store.register(registration('codex','managed-history',{endpoint:{mode:'app-server',address:'unix://old',epoch:'old',pid:90101,procStart:'old',configHome:home,runtimeId:'old-runtime'}}));
  store.updatePeer(original.id,{owner:'nxbridge',state:'offline'});const partner=store.register(window('claude','continuity-partner',90102)),pair=store.pair(partner.id,original.id),pending=store.accept(pair,partner,'未提交','pending'),unknown=store.accept(pair,partner,'不明结果','unknown');store.claim(unknown.id);store.recover();
  const recovery=new WindowRecovery(store,async()=>['alive','dead']),fresh=await recovery.register(registration('codex','managed-history',{endpoint:{mode,address:mode==='app-server'?'unix://user':'',epoch:'user',pid:90103,procStart:'user',configHome:home}}));
  assert.equal(fresh.id,original.id);assert.equal(fresh.owner,'user');assert.equal(store.pairFor(fresh.id)!.id,pair.id);assert.equal(store.message(pending.id).state,'accepted');assert.equal(store.message(unknown.id).state,'unknown');
});

for(const fromPartner of [false,true])test(`托管仍活时暂停路由，${fromPartner?'原搭档':'恢复窗口'}显式选择后保留同一配对与消息`,async t=>{
  const {store,broker}=fixture(t),home=path.resolve('/isolated/conflict-codex'),original=store.register(registration('codex','managed-live',{endpoint:{mode:'app-server',address:'unix://old',epoch:'old',pid:90101,procStart:'old',configHome:home,runtimeId:'old-runtime'}}));store.updatePeer(original.id,{owner:'nxbridge'});
  const partner=store.register(window('claude','live-partner',90102)),pair=store.pair(partner.id,original.id),pending=store.accept(pair,partner,'原队列','pending');let detached=0;
                                       
  const takeovers=(broker as any).takeovers;
  t.mock.method(takeovers,'probe',async(identities:unknown[])=>identities.map(()=> 'alive'));
  t.mock.method(takeovers,'observe',async()=>undefined);
  t.mock.method(takeovers,'sessionState',async()=> 'alive');
  const recovery=new WindowRecovery(store,async()=>['alive','alive'],async peer=>{assert.equal(peer.id,original.id);detached++;store.deactivate(peer.id);});(broker as any).windowRecovery=recovery;
  const fresh=await recovery.register(registration('codex','managed-live',{endpoint:{mode:'app-server',address:'unix://user',epoch:'user',pid:90103,procStart:'user',configHome:home}}));assert.notEqual(fresh.id,original.id);assert.equal(detached,1);
  const source=fromPartner?partner:fresh,sourceActor=fromPartner?actor(store,source.id):{host:'codex' as const,memberId:source.id,sessionId:source.sessionId!,callId:'pick'},selection=store.selections.create(source,sourceActor,{...DEFAULT_CONFIG,implicit:'never'}) as any;
  const candidate=selection.candidates.find((value:any)=>value.member_id===(fromPartner?fresh.id:partner.id));assert.ok(candidate?.continuation_of);
  const result=await broker.dispatch('pair.selection.commit',{actor:sourceActor,selection_id:selection.selection_id,key:candidate.key,action:'choose'}) as any;
  assert.equal(result.continued_same_session,true);assert.equal(store.pairFor(original.id)!.id,pair.id);assert.equal(store.peer(original.id).owner,'user');assert.equal(store.message(pending.id).state,'accepted');assert.equal(store.setting('managedSessionConflict:'+original.id),null);assert.equal(store.peers().some(peer=>peer.id===fresh.id),false);
  assert.equal(store.setting<Record<string,unknown>>('windowRecoveryPending')?.[fresh.id],undefined);
  await recovery.retry(()=>{});assert.equal(store.message(pending.id).state,'accepted');
});

test('旧版本遗留的悬空恢复和冲突记录被遗忘，仍存在的禁用成员记录保留',async t=>{
  const {store,c,x}=fixture(t),pair=store.pair(c.id,x.id),disabled=store.register(window('claude','disabled',40));store.updatePeer(disabled.id,{enabled:false});
  const pending={peerId:'deleted-peer',input:window('claude','gone',30),state:'unverified',deadline:Date.now()+60000,nextAt:0};
  store.setSetting('windowRecoveryPending',{'deleted-peer':pending,[disabled.id]:{...pending,peerId:disabled.id,input:window('claude','disabled',40)}});
  store.setSetting('managedSessionConflict:'+x.id,{memberId:'deleted-peer',pairId:pair.id});
  const recovery=new WindowRecovery(store,async()=>{throw Error('悬空记录不得触发原生查询');},undefined,async()=>{throw Error('悬空成员不得解引用');});
  await recovery.retry(()=>{});await recovery.retry(()=>{});
  assert.equal(store.setting<Record<string,unknown>>('windowRecoveryPending')?.['deleted-peer'],undefined);
  assert.ok(store.setting<Record<string,unknown>>('windowRecoveryPending')?.[disabled.id]);assert.equal(store.setting('managedSessionConflict:'+x.id),null);
  assert.equal(store.peer(x.id).state,x.state);assert.equal(store.pairFor(c.id)?.id,pair.id);
});

test('单个冲突核验失败不阻止其他成员恢复，失败留下可定位事件',async t=>{
  const {store,c,x}=fixture(t),pair=store.pair(c.id,x.id),c2=store.register(window('claude','second',50)),x2=store.register(window('codex','second-partner',51)),pair2=store.pair(c2.id,x2.id);
  store.setSetting('managedSessionConflict:'+x.id,{memberId:c.id,pairId:pair.id});store.setSetting('managedSessionConflict:'+x2.id,{memberId:c2.id,pairId:pair2.id});
  const recovery=new WindowRecovery(store,async()=>[],undefined,async peer=>{if(peer.id===c.id)throw Error('隔离的代次查询失败');return'dead';});
  await recovery.retry(()=>{});
  assert.ok(store.setting('managedSessionConflict:'+x.id));assert.equal(store.setting('managedSessionConflict:'+x2.id),null);
  assert.ok(store.events().some(event=>event.type==='pump.failed'&&(event.data as any).stage==='managed_conflict:'+x.id));
});

test('冲突窗口死亡后解除阻塞；正在启动的后台不能被旧端点死亡证明抢先接续',async t=>{
  const {store}=fixture(t),home=path.resolve('/isolated/launching-codex'),old=store.register(registration('codex','launching',{endpoint:{mode:'app-server',address:'unix://old',epoch:'old',pid:90101,procStart:'old',configHome:home,runtimeId:'old-runtime'}})),partner=store.register(window('claude','launching-partner',90102));store.updatePeer(old.id,{owner:'nxbridge'});store.pair(partner.id,old.id);store.setSetting('managedRecovery:'+old.id,{state:'recovering'});
  let states:('alive'|'dead')[]=['alive','dead'];const recovery=new WindowRecovery(store,async()=>states,async()=>{}),fresh=await recovery.register(registration('codex','launching',{endpoint:{mode:'app-server',address:'unix://user',epoch:'user',pid:90103,procStart:'user',configHome:home}}));
  assert.notEqual(fresh.id,old.id);assert.ok(store.setting('managedSessionConflict:'+old.id));states=['dead'];await recovery.retry(()=>{});assert.equal(store.setting('managedSessionConflict:'+old.id),null);assert.equal(store.peer(old.id).state,'offline');
});

test('共享 app-server 仍活但原生线程卸载后解除冲突，不等共享后台退出',async t=>{
  const {store}=fixture(t),home=path.resolve('/isolated/shared-codex'),old=store.register(registration('codex','shared-session',{endpoint:{mode:'app-server',address:'unix://old',epoch:'old',pid:90101,procStart:'old',configHome:home}})),partner=store.register(window('claude','shared-partner',90102));store.updatePeer(old.id,{owner:'nxbridge'});store.pair(partner.id,old.id);
  let state:'alive'|'dead'|'unknown'='alive';const recovery=new WindowRecovery(store,async()=>['alive','alive'],async()=>{},async()=>state);
  await recovery.register(registration('codex','shared-session',{endpoint:{mode:'app-server',address:'unix://shared',epoch:'shared',pid:90103,procStart:'shared',configHome:home}}));
  state='unknown';await recovery.retry(()=>{});assert.ok(store.setting('managedSessionConflict:'+old.id));
  state='dead';await recovery.retry(()=>{});assert.equal(store.setting('managedSessionConflict:'+old.id),null);assert.equal(store.peer(old.id).state,'offline');
});
