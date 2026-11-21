import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { writeFileSync } from 'node:fs';
import { fixture } from './support/broker-fixture.js';
import { registration } from './support/registration.js';
import { temporary } from './support/temporary.js';
import { restartArguments } from '../hosts/codex/codex-restart.js';
import type { Endpoint, Peer, DeliveryState } from '../types.js';

test('搭档重启只接受独立 Claude 的当前托管配对，预检目标不能换成其他成员',async t=>{
  assert.deepEqual(restartArguments(['codex','--partner']),{partner:true});
  for(const args of [['codex','--partner','--member','other'],['codex','--partner','other']])assert.throws(()=>restartArguments(args),{code:'invalid_arguments'});
  const f=fixture(t),pair=f.store.pair(f.c.id,f.x.id),actor={host:'claude' as const,sessionId:'c',callId:'restart'};
  for(const selector of [{},{actor:{host:'codex',sessionId:'x',callId:'self'}},{peer_id:f.x.id}])await assert.rejects(f.broker.dispatch('codex.restart.target',{...selector,partner:true}),{code:'partner_context_required'});
  await assert.rejects(f.broker.dispatch('codex.restart.target',{actor,partner:true}),{code:'unowned_runtime'});
  f.store.updatePeer(f.x.id,{owner:'nxbridge'});
  const binding=f.store.bindings.activate({host:'claude',configHome:path.resolve('/partner'),pid:101,procStart:'caller'},f.c.id,'c','verified'),native={host:binding.host,pid:binding.pid,procStart:binding.procStart};
  const selected:any=await f.broker.dispatch('codex.restart.target',{native,partner:true});assert.equal(selected.peer_id,f.x.id);assert.equal(selected.pair_id,pair.id);
  await assert.rejects(f.broker.dispatch('codex.restart',{native,partner:true,peer_id:'another'}),{code:'session_changed'});
  await assert.rejects(f.broker.dispatch('codex.restart.target',{native:{...native,procStart:'stale'},partner:true}),{code:'ambiguous_context'});
  f.store.unpair(pair.id);
  const other=f.store.register(registration('codex','other',{endpoint:{...f.store.endpoint(f.x.id)!,address:'other',epoch:'other'}}));f.store.updatePeer(other.id,{owner:'nxbridge'});f.store.pair(f.c.id,other.id);
  await assert.rejects(f.broker.dispatch('codex.restart',{native,partner:true,peer_id:selected.peer_id,pair_id:selected.pair_id,session_id:selected.session_id}),{code:'session_changed'});
});

test('自动搭档重启只拒绝目标入站未确认消息，仍保留暂停及上下文保护',async t=>{
  const f=fixture(t),pair=f.store.pair(f.c.id,f.x.id),actor={host:'claude' as const,sessionId:'c',callId:'safe'},input={actor,partner:true};
  f.store.updatePeer(f.x.id,{owner:'nxbridge'});let calls=0;(f.codex as any).restart=async()=>{calls++;};
  const unsent=f.store.accept(pair,f.c,'从未提交的来信','unsent');assert.equal((await f.broker.dispatch('codex.restart.target',input) as any).peer_id,f.x.id);assert.equal(f.store.message(unsent.id).attempts,0);
  for(const state of ['sending','runtimeQueued','held'] as DeliveryState[]){
    const message=f.store.accept(pair,f.c,'原工作',f.c.id+state);if(state!=='accepted'){f.store.claim(message.id);if(state!=='sending')f.store.transition(message.id,state);}
    await assert.rejects(f.broker.dispatch('codex.restart.target',input),{code:'delivery_unsettled'});assert.equal(f.store.message(message.id).state,state);f.store.transition(message.id,'contextObserved');
  }
  const attempted=f.store.accept(pair,f.c,'尝试过但尚未重新核验','attempted');f.store.claim(attempted.id);f.store.transition(attempted.id,'accepted');await assert.rejects(f.broker.dispatch('codex.restart.target',input),{code:'delivery_unsettled'});f.store.transition(attempted.id,'contextObserved');
  for(const [key,value] of [['codexDirect:',{scope:'scope',attempts:[{id:'notice',callId:'notice'}]}],['codexDirect:',{scope:'scope',attempts:[],continuation:{anchor:'notice',attempts:1,at:1,uncertain:true}}],['codexWake:',{scope:'scope',anchor:unsent.id,attempts:1,at:1}] ] as const){f.store.setSetting(key+f.x.id,value);await assert.rejects(f.broker.dispatch('codex.restart.target',input),{code:'delivery_unsettled'});f.store.setSetting(key+f.x.id,null);}
  for(const state of ['accepted','sending','runtimeQueued','held','unknown'] as DeliveryState[]){
    const message=f.store.accept(pair,f.x,'发往 Claude 的原工作',f.x.id+state);if(state!=='accepted'){f.store.claim(message.id);if(state!=='sending')f.store.transition(message.id,state);}
    assert.equal((await f.broker.dispatch('codex.restart.target',input) as any).peer_id,f.x.id);assert.equal(f.store.message(message.id).state,state);
  }
  f.store.setPaused(true,pair.id);await assert.rejects(f.broker.dispatch('codex.restart.target',input),{code:'pair_paused'});f.store.setPaused(false,pair.id);
  f.store.updatePeer(f.x.id,{state:'paused'});await assert.rejects(f.broker.dispatch('codex.restart.target',input),{code:'session_busy'});f.store.updatePeer(f.x.id,{state:'ready'});
  f.store.bindings.activate({host:'claude',configHome:path.resolve('/transition'),pid:102,procStart:'caller'},f.c.id,'c','verified');
  f.store.endContext(actor);await assert.rejects(f.broker.dispatch('codex.restart.target',{partner:true,native:{host:'claude',pid:102,procStart:'caller'}}),{code:'context_transition'});assert.equal(calls,0);
});

for(const partner of [false,true])test('旧未知来信只在完整核验后放行，原消息不改变也不重发：'+(partner?'搭档':'普通'),async t=>{
  const f=fixture(t),pair=f.store.pair(f.c.id,f.x.id),input={actor:{host:'claude',sessionId:'c',callId:'legacy'},...(partner?{partner:true}:{})},history=path.join(temporary(t),'history.jsonl');
  f.store.updatePeer(f.x.id,{owner:'nxbridge'});
  writeFileSync(history,JSON.stringify({type:'session_meta',payload:{id:'x'}})+'\n','utf8');
  const stranded=f.store.accept(pair,f.c,'旧任务已由其他轮次处理，不能重发','stranded');f.store.claim(stranded.id);f.store.transition(stranded.id,'unknown');
  const before=f.store.message(stranded.id),fresh=f.store.accept(pair,f.c,'未尝试的新来信','fresh');
  assert.equal((await f.broker.dispatch('codex.restart.target',input) as any).peer_id,f.x.id);assert.deepEqual(f.store.message(stranded.id),before);
  let stopped=0;
  (f.codex as any).restart=async(peer:Peer,endpoint:Endpoint,guard:()=>void,options:any)=>{
    assert.throws(guard,{code:'delivery_unsettled'});
    await options.verifyDelivery({id:'x',path:history,turns:[]});guard();stopped++;
    f.store.adopt(peer.id,registration('codex','x',{state:'ready',endpoint:{...endpoint,address:'unix://new',epoch:'new'}}));
    return{oldPid:1,pid:2,resumed:{model:'gpt-6.1-sol',reasoningEffort:'xhigh'}};
  };
  assert.equal((await f.broker.dispatch('codex.restart',input) as any).restarted,true);assert.equal(stopped,1);
  await f.broker.pump();await f.broker.pump();
  assert.deepEqual(f.store.message(stranded.id),before);assert.equal(f.codex.delivered.some(message=>message.id===stranded.id),false);
  assert.equal(f.codex.delivered.filter(message=>message.id===fresh.id).length,1);assert.equal(f.store.message(fresh.id).attempts,1);
  assert.equal(f.store.peer(f.x.id).sessionId,'x');assert.equal(f.store.pairFor(f.x.id)?.id,pair.id);assert.equal(f.codex.created.length,0);
});

for(const partner of [false,true])for(const mode of ['missing','partial','wrong-session','unverified'] as const)test('旧未知来信不能凭预检或不完整历史绕过停止保护：'+(partner?'搭档':'普通')+'/'+mode,async t=>{
  const f=fixture(t),pair=f.store.pair(f.c.id,f.x.id),input={actor:{host:'claude',sessionId:'c',callId:mode},...(partner?{partner:true}:{})},history=path.join(temporary(t),'history.jsonl');
  f.store.updatePeer(f.x.id,{owner:'nxbridge'});
  if(mode!=='missing')writeFileSync(history,JSON.stringify({type:'session_meta',payload:{id:mode==='wrong-session'?'other':'x'}})+'\n'+(mode==='partial'?'{':''),'utf8');
  const stranded=f.store.accept(pair,f.c,'保留未知正文',mode);f.store.claim(stranded.id);f.store.transition(stranded.id,'unknown');const before=f.store.message(stranded.id);
  assert.equal((await f.broker.dispatch('codex.restart.target',input) as any).peer_id,f.x.id);
  let stopped=0;
  (f.codex as any).restart=async(_peer:Peer,_endpoint:Endpoint,guard:()=>void,options:any)=>{
    if(mode!=='unverified')await options.verifyDelivery({id:'x',path:history,turns:[]});guard();stopped++;
  };
  await assert.rejects(f.broker.dispatch('codex.restart',input),{code:'delivery_unsettled'});assert.equal(stopped,0);
  assert.deepEqual(f.store.message(stranded.id),before);assert.equal(f.codex.delivered.length,0);
});

for(const partner of [false,true])for(const change of ['retry','late-unknown','runtimeQueued','reservation'] as const)test('完整历史核验后的新提交和预约仍阻止停止：'+(partner?'搭档':'普通')+'/'+change,async t=>{
  const f=fixture(t),pair=f.store.pair(f.c.id,f.x.id),input={actor:{host:'claude',sessionId:'c',callId:change},...(partner?{partner:true}:{})},history=path.join(temporary(t),'history.jsonl');
  f.store.updatePeer(f.x.id,{owner:'nxbridge'});writeFileSync(history,JSON.stringify({type:'session_meta',payload:{id:'x'}})+'\n','utf8');
  const stranded=f.store.accept(pair,f.c,'原未知来信',change);f.store.claim(stranded.id);f.store.transition(stranded.id,'unknown');let stopped=0;
  (f.codex as any).restart=async(_peer:Peer,_endpoint:Endpoint,guard:()=>void,options:any)=>{
    await options.verifyDelivery({id:'x',path:history,turns:[]});guard();
    if(change==='retry'){f.store.transition(stranded.id,'accepted');f.store.claim(stranded.id);f.store.transition(stranded.id,'unknown');}
    if(change==='late-unknown'){const late=f.store.accept(pair,f.c,'核验后才出现的未知来信','late');f.store.claim(late.id);f.store.transition(late.id,'unknown');}
    if(change==='runtimeQueued')f.store.transition(stranded.id,'runtimeQueued');
    if(change==='reservation')f.store.setSetting('codexWake:'+f.x.id,{scope:'new',anchor:stranded.id,attempts:1,at:Date.now()});
    guard();stopped++;
  };
  await assert.rejects(f.broker.dispatch('codex.restart',input),{code:'delivery_unsettled'});assert.equal(stopped,0);assert.equal(f.codex.delivered.length,0);
});

for(const partner of [false,true])test('完整历史的正向回执可结算未知来信，重启不重复投递正文：'+(partner?'搭档':'普通'),async t=>{
  const f=fixture(t),pair=f.store.pair(f.c.id,f.x.id),input={actor:{host:'claude',sessionId:'c',callId:'receipt'},...(partner?{partner:true}:{})},history=path.join(temporary(t),'history.jsonl');
  f.store.updatePeer(f.x.id,{owner:'nxbridge'});
  const stranded=f.store.accept(pair,f.c,'实际已进入原会话的消息','received');f.store.claim(stranded.id);f.store.transition(stranded.id,'unknown');
  const rows=[{type:'session_meta',payload:{id:'x'}},{type:'response_item',payload:{type:'function_call',namespace:'claude',name:'receive_messages',call_id:'receipt'}},{type:'response_item',payload:{type:'function_call_output',call_id:'receipt',output:JSON.stringify({messages:[{message_id:stranded.id}]})}}];
  writeFileSync(history,rows.map(row=>JSON.stringify(row)).join('\n')+'\n','utf8');
  (f.codex as any).restart=async(_peer:Peer,_endpoint:Endpoint,guard:()=>void,options:any)=>{
    await options.verifyDelivery({id:'x',path:history,turns:[]});guard();return{oldPid:1,pid:2,resumed:{model:'gpt-6.1-sol'}};
  };
  assert.equal((await f.broker.dispatch('codex.restart',input) as any).restarted,true);assert.equal(f.store.message(stranded.id).state,'contextObserved');assert.equal(f.store.message(stranded.id).attempts,1);assert.equal(f.codex.delivered.length,0);
});

test('大历史在一次重启请求中分段扫描完成，早期及跨段调用回执不丢失',async t=>{
  const f=fixture(t),pair=f.store.pair(f.c.id,f.x.id),history=path.join(temporary(t),'large.jsonl');f.store.updatePeer(f.x.id,{owner:'nxbridge'});
  const messages=['early','split','absent'].map(id=>{const message=f.store.accept(pair,f.c,id,id);f.store.claim(message.id);f.store.transition(message.id,'unknown');return f.store.message(message.id);});
  const call=(id:string)=>({type:'response_item',payload:{type:'function_call',namespace:'claude',name:'receive_messages',call_id:id}}),output=(message:typeof messages[number])=>({type:'response_item',payload:{type:'function_call_output',call_id:message.callId,output:JSON.stringify({messages:[{message_id:message.id}]})}});
  const rows=[{type:'session_meta',payload:{id:'x'}},call('early'),output(messages[0]!),call('split'),{type:'event_msg',payload:{type:'agent_message',message:'x'.repeat(10*1024*1024)}},output(messages[1]!)];
  writeFileSync(history,rows.map(row=>JSON.stringify(row)).join('\n')+'\n','utf8');let verified=0;
  (f.codex as any).restart=async(_peer:Peer,_endpoint:Endpoint,guard:()=>void,options:any)=>{await options.verifyDelivery({id:'x',path:history,turns:[]});guard();verified++;return{oldPid:1,pid:2,resumed:{model:'gpt-6.1-sol'}};};
  assert.equal((await f.broker.dispatch('codex.restart',{}) as any).restarted,true);assert.equal(verified,1);
  for(const message of messages.slice(0,2)){assert.equal(f.store.message(message.id).state,'contextObserved');assert.equal(f.store.message(message.id).attempts,1);}
  assert.deepEqual(f.store.message(messages[2]!.id),messages[2]);assert.equal(f.codex.delivered.length,0);assert.equal(f.store.setting('codexHistoryRepair:'+f.x.id),null);
});

test('停止前发现未确认提交则拒绝；成功后清除旧运行时告警且保持原会话',async t=>{
  const f=fixture(t),pair=f.store.pair(f.c.id,f.x.id),input={actor:{host:'claude',sessionId:'c',callId:'restart'},partner:true};f.store.updatePeer(f.x.id,{owner:'nxbridge'});
  const outbound=f.store.accept(pair,f.x,'仍然未知的出站消息','outbound');f.store.claim(outbound.id);f.store.transition(outbound.id,'unknown');
  let stopped=0,messageId='';
  (f.codex as any).restart=async(_peer:Peer,_endpoint:Endpoint,guard:()=>void)=>{messageId=f.store.accept(pair,f.c,'停止前新任务','late').id;f.store.claim(messageId);guard();stopped++;};
  await assert.rejects(f.broker.dispatch('codex.restart',input),{code:'delivery_unsettled'});assert.equal(stopped,0);assert.equal(f.store.message(messageId).state,'sending');f.store.transition(messageId,'contextObserved');
  f.broker.pairAnomalies.integration(f.x,{hookError:'plugin contents changed; hook approval required',hookTrustIssue:'hooks_restart_required'});f.broker.pairAnomalies.observe(pair,f.store.peer(f.x.id));assert.equal(f.broker.deliveryHealth.hasPending(pair.id,f.c.id),true);
  (f.codex as any).restart=async(peer:Peer,endpoint:Endpoint,guard:()=>void)=>{guard();stopped++;f.store.adopt(peer.id,registration('codex','x',{state:'ready',endpoint:{...endpoint,address:'new',epoch:'new'}}));return{endpoint:'new',oldPid:1,pid:2,resumed:{model:'gpt-6.1-sol',reasoningEffort:'xhigh'}};};
  const result:any=await f.broker.dispatch('codex.restart',input);assert.equal(result.restarted,true);assert.equal(result.session_id,'x');assert.equal(stopped,1);
  assert.equal(f.broker.pairAnomalies.evidence(f.store.peer(f.x.id)).hookError,undefined);assert.equal(f.broker.pairAnomalies.evidence(f.store.peer(f.x.id)).lastHookAt,undefined);assert.equal(f.broker.deliveryHealth.hasPending(pair.id,f.c.id),false);assert.equal(f.store.pairFor(f.c.id)?.id,pair.id);
  assert.equal(f.store.message(outbound.id).state,'unknown');assert.equal(f.claude.delivered.length,0);
});

test('搭档重启保留已有及停止前新到的未尝试来信，恢复原会话后各投递一次',async t=>{
  const f=fixture(t),pair=f.store.pair(f.c.id,f.x.id),input={actor:{host:'claude',sessionId:'c',callId:'restart-queued'},partner:true};f.store.updatePeer(f.x.id,{owner:'nxbridge'});
  const first=f.store.accept(pair,f.c,'重启前积压','before-restart');let secondId='';
  (f.codex as any).restart=async(peer:Peer,endpoint:Endpoint,guard:()=>void)=>{
    assert.equal(f.store.message(first.id).state,'accepted');assert.equal(f.store.message(first.id).attempts,0);
    secondId=f.store.accept(pair,f.c,'停止前新到来信','during-restart').id;guard();
    f.store.adopt(peer.id,registration('codex','x',{state:'ready',endpoint:{...endpoint,address:'unix://restarted',epoch:'restarted'}}));return{endpoint:'unix://restarted',oldPid:1,pid:2,resumed:{model:'gpt-6.1-sol',reasoningEffort:'xhigh'}};
  };
  assert.equal((await f.broker.dispatch('codex.restart',input) as any).restarted,true);await f.broker.pump();await f.broker.pump();
  for(const id of [first.id,secondId]){assert.equal(f.store.message(id).state,'contextObserved');assert.equal(f.store.message(id).attempts,1);assert.equal(f.codex.delivered.filter(message=>message.id===id).length,1);}
  assert.equal(f.store.peer(f.x.id).sessionId,'x');assert.equal(f.store.pairFor(f.x.id)?.id,pair.id);assert.equal(f.codex.created.length,0);
});
