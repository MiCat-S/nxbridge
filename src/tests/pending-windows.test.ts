import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { fixture } from './support/broker-fixture.js';
import { registration } from './support/registration.js';
import { registerPendingCodex } from '../broker/pending-windows.js';
import { codexStartupArguments, processIdentity } from '../process/process.js';

test('启动参数只接受明确 resume UUID，选项值、fork、last 和提示正文不能当作对话证明',()=>{
  const id='00000002-0000-7000-8000-000000000002';
  assert.equal(codexStartupArguments(['codex','-c','x=1','resume',id]).resumeSessionId,id);
  for(const args of [['--profile','resume',id],['resume','--last'],['fork',id],['resume',id,'--fork'],['exec','resume',id],[id],['--','resume',id]])assert.equal(codexStartupArguments(['codex',...args]).resumeSessionId,undefined);
  assert.equal(codexStartupArguments(['codex','-m','model','app-server','--listen','stdio://']).appServer,true);
});

test('第一轮前的新窗口是候选，发信只保存；实际对话接续同一成员和配对',async t=>{
  const f=fixture(t),native=await processIdentity(process.pid);
                                 
  f.store.updatePeer(f.x.id,{state:'offline'});
  const input={window:{host:'codex' as const,pid:process.pid,procStart:native.startedAt,configHome:path.join(tmpdir(),'pending-codex')},cwd:f.c.cwd,bridge:{pid:process.pid,procStart:native.startedAt}};
  const pending=registerPendingCodex(f.store,input);assert.equal(pending.sessionId,null);assert.equal(registerPendingCodex(f.store,input).id,pending.id);
  assert.deepEqual(f.store.candidates('codex',f.c.cwd).map(p=>p.id),[pending.id]);
  const actor={host:'claude' as const,sessionId:'c',callId:'before-turn'},choice:any=await f.broker.dispatch('send',{actor,message:'启动前保存的任务'});
  assert.equal(choice.status,'selection_required');assert.equal(f.store.pairFor(pending.id),undefined);assert.equal(f.store.messages().length,0);
  const sent:any=await f.broker.dispatch('pair.selection.commit',{actor,selection_id:choice.selection_id,key:choice.candidates[0].key});
  const pair=f.store.pairFor(pending.id)!;assert.ok(pair);await f.broker.pump();assert.equal(f.codex.created.length,0);assert.equal(f.store.message(sent.message_id).attempts,0);
  const actual=f.store.register(registration('codex','actual',{endpoint:{mode:'embedded',address:'',epoch:'actual',pid:process.pid,procStart:native.startedAt,configHome:input.window.configHome},contextStart:true}));
  assert.equal(actual.id,pending.id);assert.equal(f.store.pairFor(actual.id)!.id,pair.id);assert.equal(f.store.endpoint(actual.id)!.pendingContext,undefined);
});

test('resume 提案被原生对话否定时解除临时配对，旧消息保留且不借给新对话',t=>{
  const f=fixture(t),window={host:'codex' as const,pid:123,procStart:'generation',configHome:path.join(tmpdir(),'pending-resume')};
  const pending=registerPendingCodex(f.store,{window,cwd:f.c.cwd,sessionId:'proposed',bridge:{pid:234,procStart:'bridge'}}),pair=f.store.pair(f.c.id,pending.id),message=f.store.accept(pair,f.c,'原任务','draft');
  const actual=f.store.register(registration('codex','different',{endpoint:{mode:'embedded',address:'',epoch:'actual',pid:123,procStart:'generation',configHome:window.configHome},contextStart:true}));
  assert.equal(actual.id,pending.id);assert.equal(f.store.pairFor(actual.id),undefined);assert.equal(f.store.message(message.id).state,'held');assert.equal(f.store.message(message.id).attempts,0);
});

test('第一轮前退出的窗口不再是候选，临时配对解除但任务不丢失',async t=>{
  const f=fixture(t),pending=registerPendingCodex(f.store,{window:{host:'codex',pid:process.pid,procStart:'wrong-generation',configHome:path.join(tmpdir(),'pending-dead')},cwd:f.c.cwd,bridge:{pid:process.pid,procStart:'wrong'}}),pair=f.store.pair(f.c.id,pending.id),message=f.store.accept(pair,f.c,'保留的任务','dead');
  await f.broker.pump();assert.equal(f.store.pairFor(pending.id),undefined);assert.equal(f.store.peer(pending.id).state,'offline');assert.ok(!f.store.candidates('codex',f.c.cwd).some(p=>p.id===pending.id));assert.equal(f.store.message(message.id).state,'held');assert.equal(f.store.message(message.id).attempts,0);
});

test('Esc 暂停窗口明确选择后配对，消息等原窗口下一次用户输入；退出优先转离线',async t=>{
  const f=fixture(t,{implicit:'on-demand'});f.store.updatePeer(f.x.id,{state:'paused'});
  const actor={host:'claude' as const,sessionId:'c',callId:'paused'},choice:any=await f.broker.dispatch('send',{actor,message:'等你继续'});
  assert.equal(choice.status,'selection_required');assert.equal(f.store.pairFor(f.c.id),undefined);
  const sent:any=await f.broker.dispatch('pair.selection.commit',{actor,selection_id:choice.selection_id,key:choice.candidates[0].key});
  assert.equal(f.store.pairFor(f.c.id)!.codex,f.x.id);
  await f.broker.pump();assert.equal(f.codex.delivered.length,0);assert.equal(f.codex.created.length,0);assert.equal(f.store.message(sent.message_id).attempts,0);
  await f.broker.dispatch('hook',{host:'codex',session_id:'x',hook_event_name:'UserPromptSubmit',prompt:'继续'});
  await f.broker.pump();assert.equal(f.store.message(sent.message_id).state,'accepted');
  const pickup=f.broker.receive({host:'codex',sessionId:'x',callId:'after-user-input'}) as any;assert.equal(pickup.messages[0].message_id,sent.message_id);assert.equal(f.store.message(sent.message_id).state,'unknown');
  f.store.unpair();f.store.updatePeer(f.x.id,{state:'paused'});
  f.codex.probe=async()=>({state:'blocked',nativeState:'dead',reasons:['native host exited or PID generation changed'],checked_at:Date.now()});
  const inventory:any=await f.broker.dispatch('pair.inventory',{});assert.ok(!inventory.members.some((p:any)=>p.member_id===f.x.id));assert.equal(f.store.peer(f.x.id).state,'offline');
});

test('选择多个候选时能提交第一轮前的窗口，待对话确认期间不投递',async t=>{
  const f=fixture(t),native=await processIdentity(process.pid),pending=registerPendingCodex(f.store,{window:{host:'codex',pid:process.pid,procStart:native.startedAt,configHome:path.join(tmpdir(),'pending-choice')},cwd:f.c.cwd,bridge:{pid:process.pid,procStart:native.startedAt}});
  const actor={host:'claude' as const,sessionId:'c',callId:'choice'},choice:any=await f.broker.dispatch('send',{actor,message:'选择待开始窗口'}),candidate=choice.candidates.find((p:any)=>p.member_id===pending.id);
  f.codex.probe=async peer=>({state:peer.id===pending.id?'starting':'reachable',nativeState:'alive',reasons:[],checked_at:Date.now()});
  const sent:any=await f.broker.dispatch('pair.selection.commit',{actor,selection_id:choice.selection_id,key:candidate.key});
  assert.equal(f.store.pairFor(f.c.id)!.codex,pending.id);await f.broker.pump();assert.equal(f.store.message(sent.message_id).attempts,0);
});
