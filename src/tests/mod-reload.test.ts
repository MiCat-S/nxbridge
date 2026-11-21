import test from 'node:test';
import assert from 'node:assert/strict';
import { reloadAction, recordReloadAttempt, modStaleNotice, MOD_RELOAD_STABLE_MS, MOD_RELOAD_ATTEMPT_MS, MOD_STALE_NOTICE_MS, MOD_RELOAD_SETTLE_MS } from '../integration/mod/mod-reload.js';
import { MOD_REVISION } from '../mod-revision.js';
import { fixture } from './support/broker-fixture.js';

const memory=()=>{const values=new Map<string,unknown>();return{setting:<T>(key:string)=>values.get(key) as T|undefined,setSetting:(key:string,value:unknown)=>{values.set(key,value);}};};
const REV='a'.repeat(16),NEXT='b'.repeat(16);

test('插件自动重新加载：新版稳定后才下发，同一目标版本只下发到报告尝试为止，新版本重新开始',()=>{
  const store=memory(),since=1_000_000;
  assert.equal(reloadAction(store,'c',since,REV,since+MOD_RELOAD_STABLE_MS-1),undefined,'刚发布的版本先等稳定');
  assert.equal(reloadAction(store,'c',undefined,REV,since+MOD_RELOAD_STABLE_MS),undefined,'没有过期不下发');
  const action=reloadAction(store,'c',since,REV,since+MOD_RELOAD_STABLE_MS)!;assert.equal(action.kind,'reload_plugins');assert.equal(action.targetRevision,REV);
  assert.equal(reloadAction(store,'c',since,REV,since+MOD_RELOAD_STABLE_MS+15000)?.attemptId,action.attemptId,'报告前沿用同一编号');
  assert.throws(()=>recordReloadAttempt(store,'c','00000000-0000-4000-8000-000000000000',REV),{code:'reload_attempt_stale'});
  assert.throws(()=>recordReloadAttempt(store,'c',action.attemptId,NEXT),{code:'reload_attempt_stale'});
  assert.deepEqual(recordReloadAttempt(store,'c',action.attemptId,REV),{recorded:true});
  assert.equal(reloadAction(store,'c',since,REV,since+MOD_RELOAD_STABLE_MS+30000),undefined,'试过就不再下发，避免反复重载');
  const next=reloadAction(store,'c',since+100000,NEXT,since+100000+MOD_RELOAD_STABLE_MS)!;assert.notEqual(next.attemptId,action.attemptId);assert.equal(next.targetRevision,NEXT);
});

test('插件过期提醒模型：旧插件下发后不报告尝试就叫醒一次（第 4 档）；新插件试过后在途不提醒，空闲后仍过期才第 3 档',()=>{
  const store=memory(),since=1_000_000;
                                    
  assert.equal(modStaleNotice(store,{id:'c',state:'ready'},since,REV,since+MOD_STALE_NOTICE_MS-1),undefined);
  assert.deepEqual(modStaleNotice(store,{id:'c',state:'ready'},since,REV,since+MOD_STALE_NOTICE_MS),{tier:4});
                                                             
  const offered=since+MOD_RELOAD_STABLE_MS,action=reloadAction(store,'c',since,REV,offered)!;
  assert.equal(modStaleNotice(store,{id:'c',state:'ready'},since,REV,offered+MOD_RELOAD_ATTEMPT_MS-1),undefined,'新插件一个状态周期内就会报告，先等');
  assert.deepEqual(modStaleNotice(store,{id:'c',state:'busy'},since,REV,offered+MOD_RELOAD_ATTEMPT_MS),{tier:4},'旧插件：忙时也叫醒（原生收件箱在轮中排队，模型登记本轮结束后重载）');
                                                        
  const store2=memory(),action2=reloadAction(store2,'c',since,REV,offered)!;recordReloadAttempt(store2,'c',action2.attemptId,REV,offered+10000);
  assert.equal(modStaleNotice(store2,{id:'c',state:'busy'},since,REV,offered+3600000),undefined,'本轮还没结束，重载排在空闲时执行');
  assert.equal(modStaleNotice(store2,{id:'c',state:'ready'},since,REV,offered+10000+MOD_RELOAD_SETTLE_MS-1),undefined);
  assert.deepEqual(modStaleNotice(store2,{id:'c',state:'ready'},since,REV,offered+10000+MOD_RELOAD_SETTLE_MS),{tier:3},'空闲后仍过期：自动重载没成功，不叫醒地告诉模型');
  assert.deepEqual(modStaleNotice(store2,{id:'c',state:'ready'},since,NEXT,since+MOD_STALE_NOTICE_MS),{tier:4},'试的是旧目标版本，不挡住新版本');
  assert.ok(action.attemptId);
});

test('后台：旧插件窗口过期时只叫醒一次（同一事实只提交一次）；新插件报告尝试后不排队给模型',async t=>{
  t.mock.timers.enable({apis:['Date'],now:1000000});
  for(const mod of ['old','new'] as const){
    const f=fixture(t),pair=f.store.pair(f.c.id,f.x.id),health=f.broker.deliveryHealth;
    f.store.saveEndpoint({...f.store.endpoint(f.c.id)!,questionSupport:true});
    const beat=()=>f.broker.pairAnomalies.integration(f.store.peer(f.c.id),{mod:true,modVersion:'0.1.1',modRevision:'f'.repeat(16)});
    beat();t.mock.timers.tick(130000);beat();f.broker.pairAnomalies.observe(pair,f.store.peer(f.c.id));
    const stale=f.broker.pairAnomalies.issues(f.c.id).find(issue=>issue.kind==='mod_stale')!;assert.ok(stale);
    t.mock.timers.tick(MOD_RELOAD_STABLE_MS);beat();
    const action=reloadAction(f.store,f.c.id,stale.firstSeenAt,MOD_REVISION)!;assert.ok(action,'状态读取下发自动重新加载');
    if(mod==='new')recordReloadAttempt(f.store,f.c.id,action.attemptId,MOD_REVISION);
    for(let i=0;i<4;i++){t.mock.timers.tick(15000);beat();f.broker.pairAnomalies.observe(pair,f.store.peer(f.c.id));}
    const pending=health.peek(pair.id,f.c.id);
    if(mod==='new'){assert.equal(pending.length,0,'新插件自己在空闲时重新加载，不惊动模型');continue;}
    assert.equal(pending.length,1);const notice=health.get(pair.id,f.c.id,pending[0]!.id)!;
    assert.equal(notice.tier,4);assert.equal(notice.wake,true,'旧插件：叫醒该窗口去调用 reload_plugins');assert.ok(notice.factKey);
    assert.match(notice.message,/Call reload_plugins once now[\s\S]*will not repeat/,'叫醒时写明要做的一步，不让模型以“还在频繁更新”为由跳过');
    assert.ok(health.prepare(pair.id,f.c.id,notice.id,notice.scope));health.outcome(pair.id,f.c.id,notice.id,'submitted');
                                        
    for(let i=0;i<8;i++){t.mock.timers.tick(15000);beat();f.broker.pairAnomalies.observe(pair,f.store.peer(f.c.id));}
    t.mock.timers.tick(600001);beat();f.broker.pairAnomalies.observe(pair,f.store.peer(f.c.id));
    assert.equal(health.peek(pair.id,f.c.id).length,0,'同一事实只叫醒一次');
  }
});

test('后台：本窗口状态带出自动重新加载动作，插件报告尝试走 mod.reload.attempt，只接受根会话',async t=>{
  const f=fixture(t),peer=f.store.peer(f.c.id);
  const action=reloadAction(f.store,peer.id,Date.now()-MOD_RELOAD_STABLE_MS,REV)!;
  await assert.rejects(f.broker.dispatch('mod.reload.attempt',{actor:{host:'claude',sessionId:'c',callId:'r0',via:'child'},attempt_id:action.attemptId,target_revision:REV}),{code:'subagent_denied'});
  assert.deepEqual(await f.broker.dispatch('mod.reload.attempt',{actor:{host:'claude',sessionId:'c',callId:'r1'},attempt_id:action.attemptId,target_revision:REV}),{recorded:true});
  assert.equal(reloadAction(f.store,peer.id,Date.now()-MOD_RELOAD_STABLE_MS,REV),undefined);
});

test('同一窗口新旧插件环境短暂并存：当前修订号报到后 2 分钟内，旧修订号心跳不把已加载版本降级，也不触发过期；之后旧修订号重新可见',t=>{
  t.mock.timers.enable({apis:['Date'],now:1000000});
  const f=fixture(t),pair=f.store.pair(f.c.id,f.x.id);
  f.store.saveEndpoint({...f.store.endpoint(f.c.id)!,questionSupport:true});
  const report=(revision:string)=>f.broker.pairAnomalies.integration(f.store.peer(f.c.id),{mod:true,modVersion:'0.1.1',modRevision:revision});
  const stale=()=>{f.broker.pairAnomalies.observe(pair,f.store.peer(f.c.id));return f.broker.pairAnomalies.issues(f.c.id).some(issue=>issue.kind==='mod_stale');};
  report(MOD_REVISION);t.mock.timers.tick(130000);report(MOD_REVISION);assert.equal(stale(),false);
  for(let i=0;i<6;i++){t.mock.timers.tick(7500);report('f'.repeat(16));assert.equal(stale(),false,'旧环境心跳不降级');t.mock.timers.tick(7500);report(MOD_REVISION);assert.equal(stale(),false);}
  assert.equal(f.broker.pairAnomalies.evidence(f.store.peer(f.c.id)).modRevision,MOD_REVISION);
  t.mock.timers.tick(121000);report('f'.repeat(16));assert.equal(stale(),true,'当前插件停止报到超过 2 分钟，旧修订号重新可见（例如回滚或重载失败）');
});
