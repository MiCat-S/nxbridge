import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fixture } from './support/broker-fixture.js';
import { registration } from './support/registration.js';
import { temporary } from './support/temporary.js';
import { hookContextMatches } from '../integration/hooks/session-bindings.js';
import { Store } from '../storage/store.js';

test('自有 App Server 的离线重复会话不遮住原生 hook；真实活动歧义可见且告警限频',async t=>{
  const {broker,store,x,c}=fixture(t),key=`${process.pid}:test:${x.sessionId}`;
  const duplicate=store.register(registration('codex',x.sessionId!,{endpoint:{mode:'app-server',address:'unix://old-window',epoch:'old',pid:99999,procStart:'old-generation'}}));
  assert.notEqual(duplicate.id,x.id);store.deactivate(duplicate.id);store.updatePeer(duplicate.id,{state:'offline'});
  assert.throws(()=>store.find('codex',x.sessionId!),{code:'ambiguous_context'});
  const pair=store.pair(c.id,x.id);store.accept(pair,c,'正在等待的来信','pending-hook');
  const output=await broker.dispatch('hook',{session_id:x.sessionId,hook_event_name:'PostToolUse',context_key:key}) as any;
  assert.equal(store.setting<any>('lastHook')?.peerId,x.id);assert.match(output.hookSpecificOutput.additionalContext,/receive_messages/);
  const actor={host:'codex',sessionId:x.sessionId,memberId:x.id,callId:'hint',turnId:'turn-one'};
  assert.ok((await broker.dispatch('messages.pending-hint',actor) as any).pending_inbound);
  assert.deepEqual(await broker.dispatch('messages.pending-hint',actor),{});
  assert.ok((await broker.dispatch('messages.pending-hint',{...actor,turnId:'turn-two'}) as any).pending_inbound);
  const next={...actor,turnId:'turn-three'};
  assert.deepEqual(await broker.dispatch('messages.pending-hint',{...next,hint_deadline:Date.now()-1}),{});
  assert.equal(store.setting('pendingHintTurn:'+x.id),'turn-two');
  store.updatePeer(x.id,{enabled:false});assert.deepEqual(await broker.dispatch('messages.pending-hint',next),{});store.updatePeer(x.id,{enabled:true});
  const child=store.register(registration('codex','hint-child',{kind:'subagent',parentId:x.sessionId!}));
  assert.deepEqual(await broker.dispatch('messages.pending-hint',{...next,sessionId:child.sessionId,memberId:child.id}),{});
  assert.equal(store.setting('pendingHintTurn:'+x.id),'turn-two');
  assert.ok((await broker.dispatch('messages.pending-hint',next) as any).pending_inbound);
  store.saveEndpoint({...store.endpoint(x.id)!,peerId:duplicate.id,epoch:'conflicting-window',address:'unix://conflicting'});
  for(let i=0;i<2;i++)await assert.rejects(broker.dispatch('hook',{session_id:x.sessionId,hook_event_name:'PostToolUse',context_key:key}),{code:'ambiguous_context'});
  assert.equal(store.events().filter(row=>row.type==='hook.broker.failed'&&(row.data as any).peerId===x.id).length,1);
  assert.match(store.setting<any>('hookCallFailure:'+x.id).error,/多个活动会话/);
});

test('登记与 hook 上下文同事务提交，写入失败时不遗留半登记窗口',t=>{
  const store=new Store(':memory:');t.after(()=>store.close());const configHome=temporary(t),input=registration('codex','atomic',{endpoint:{mode:'embedded',address:'',epoch:'atomic',pid:123,procStart:'generation',configHome},hookContextKey:'123:generation:atomic'});
  (store as any).db.exec("CREATE TEMP TRIGGER reject_context BEFORE INSERT ON settings WHEN NEW.key LIKE 'hookContext:%' BEGIN SELECT RAISE(ABORT,'context fixture'); END");
  assert.throws(()=>store.register(input),/context fixture/);assert.equal(store.peers().length,0);assert.equal(store.bindings.all().length,0);
  (store as any).db.exec('DROP TRIGGER reject_context');const peer=store.register(input);
  assert.equal(store.setting('hookContext:'+input.hookContextKey),peer.sessionId);
});

test('共享 daemon 两线程同进程登记时，返回前分别持久化各自 hook 上下文',async t=>{
  const {broker,store}=fixture(t),configHome=temporary(t),before=store.peers().length;
  const input=(sessionId:string)=>registration('codex',sessionId,{endpoint:{mode:'app-server',address:'unix://fixture',epoch:sessionId,pid:123,procStart:'daemon',configHome,daemon:{address:'unix://fixture'}}});
  broker.daemons.registration=async(_home,_native,id)=>input(id);
  for(const id of ['thread-a','thread-b']){
    const key='123:daemon:'+path.join(configHome,'rollout-fixture-'+id+'.jsonl');
    const peer=await broker.dispatch('mcp.register',{...input(id),context_key:key}) as any;
    assert.equal(store.setting('hookContext:'+key),id);assert.equal(store.bindings.validate({host:'codex',sessionId:id,callId:id,binding:peer.binding})?.sessionId,id);
  }
  assert.equal(store.peers().length,before+2);
  const foreign=await broker.dispatch('mcp.register',{...input('thread-c'),context_key:'123:daemon:thread-a'}) as any;
  assert.equal(foreign.sessionId,'thread-c');assert.equal(store.peers().length,before+3);assert.equal(store.setting('hookContext:123:daemon:thread-a'),undefined);
});

test('扫描先激活同一线程不误判为切换；旧线程迟到仍拒绝，独立 App Server 能补齐原生键',async t=>{
  const {broker,store,x}=fixture(t),configHome=temporary(t),input=registration('codex','scan-thread',{endpoint:{mode:'embedded',address:'',epoch:'scan',pid:123,procStart:'scan',configHome}}),peer=store.register(input),binding=store.bindings.current(peer.id)!,boundaryStartedAt=binding.activatedAt!-1;
  assert.equal(store.register({...input,boundaryStartedAt,hookContextKey:'123:scan:scan-thread'}).id,peer.id);
  assert.ok((await broker.dispatch('context.lookup',{host:'codex',configHome,pid:123,procStart:'scan',session_id:'scan-thread',boundary_started_at:boundaryStartedAt}) as any).binding);
  assert.throws(()=>store.register({...input,sessionId:'other',boundaryStartedAt,contextStart:true}),{code:'stale_context'});
  store.register({...input,sessionId:'other'});store.register({...input,contextStart:true});
  assert.throws(()=>store.register({...input,boundaryStartedAt}),{code:'stale_context'});
  assert.deepEqual(await broker.dispatch('context.lookup',{host:'codex',configHome,pid:123,procStart:'scan',session_id:'scan-thread',boundary_started_at:boundaryStartedAt}),{});
  const current=store.bindings.current(peer.id)!;
  assert.ok((await broker.dispatch('context.lookup',{host:'codex',configHome,pid:123,procStart:'scan',session_id:'scan-thread',boundary_started_at:current.activatedAt}) as any).binding);
  const key=process.pid+':test:'+x.sessionId;
  await broker.dispatch('hook',{session_id:x.sessionId,hook_event_name:'PostToolUse',context_key:key});assert.equal(store.setting('hookContext:'+key),x.sessionId);
  const invalid={...input,hookContextKey:'123:scan:unrecognized-transcript'};store.register(invalid);store.register(invalid);
  assert.equal(store.setting('hookContext:'+invalid.hookContextKey),undefined);
  assert.equal(store.events().filter(row=>row.type==='hook.context.unverified'&&(row.data as any).context_key===invalid.hookContextKey).length,1);
  const child=store.register(registration('codex','child',{kind:'subagent',parentId:'scan-thread',endpoint:{...input.endpoint,daemon:{address:'unix://fixture',rootSessionId:'scan-thread'}},hookContextKey:'123:scan:child'}));
  assert.equal(child.kind,'subagent');assert.equal(store.setting('hookContext:123:scan:child'),undefined);
});

test('原有已核验键不受端点歧义影响，缺失键和 SessionStart 伪造键保持拒绝',async t=>{
  const {broker,store,x}=fixture(t),context_key=`${process.pid}:test:x`;
  await broker.dispatch('hook',{session_id:'x',hook_event_name:'SessionStart',context_key:'foreign'});assert.equal(store.setting('hookContext:foreign'),undefined);
  store.setSetting('hookContext:'+context_key,'x');broker.references.capture(x,'memo','原生子代理结果');
  store.saveEndpoint({...store.endpoint(x.id)!,epoch:'parallel',address:'unix://parallel'});
  const input={session_id:'x',hook_event_name:'PreToolUse',context_key,tool_name:'spawn_agent',tool_input:{message:'任务 nxref:agent:memo'}};
  assert.equal((await broker.dispatch('hook',input) as any).hookSpecificOutput.permissionDecision,'allow');
  assert.equal((await broker.dispatch('hook',{...input,context_key:`${process.pid}:test:/transcripts/x.jsonl`}) as any).hookSpecificOutput.permissionDecision,'deny');
});

test('SessionStart 未登记时，后续已核验根 hook 补齐缺失键；跨会话、代次和子代理不补齐',async t=>{
  const {broker,store}=fixture(t),configHome=temporary(t),input=registration('codex','current',{endpoint:{mode:'embedded',address:'',epoch:'current',pid:123,procStart:'native',configHome}}),peer=store.register(input),binding=store.bindings.current(peer.id)!,actor={host:'codex' as const,sessionId:'current',callId:'hook',binding:{key:binding.key,epoch:binding.epoch}};
  const call=(key:string,extra:object={})=>broker.dispatch('hook',{session_id:'current',hook_event_name:'UserPromptSubmit',context_key:key,prompt:'正常任务',actor,...extra});
  await broker.dispatch('hook',{session_id:'current',hook_event_name:'SessionStart',context_key:'123:native:current'});
  assert.equal(store.setting('hookContext:123:native:current'),undefined);
  for(const key of ['123:native:other','123:old:current']){await call(key);assert.equal(store.setting('hookContext:'+key),undefined);}
  await call('123:native:current',{agent_id:'child'});assert.equal(store.setting('hookContext:123:native:current'),undefined);
  await call('123:native:current');assert.equal(store.setting('hookContext:123:native:current'),'current');
  assert.equal(store.events().filter(row=>row.type==='hook.context.recovered').length,1);
  store.setSetting('hookContext:123:native:current','another-session');const previous=store.setting('lastHook');
  await call('123:native:current');assert.deepEqual(store.setting('lastHook'),previous);assert.equal(store.setting('hookContext:123:native:current'),'another-session');
  assert.ok(store.events().some(row=>row.type==='hook.context.unverified'&&(row.data as any).reason==='mismatch'));
  assert.equal(hookContextMatches('123:native:C:\\sessions\\rollout-time-current.jsonl','current',binding),true);
});
