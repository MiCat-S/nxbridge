import test,{type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {appendFileSync,writeFileSync} from 'node:fs';
import path from 'node:path';
import {CodexFinalForwards,type FinalForwardOptions} from '../broker/codex-final-forwards.js';
import {SubagentCompletions} from '../broker/subagent-completions.js';
import {CODEX_WAKE_RETRY_MS} from '../hosts/codex/codex-wake.js';
import {DeliveryHealth} from '../broker/health/delivery.js';
import {noticeScope} from '../broker/health/contracts.js';
import type {CodexCompletedTurn,CodexTurnEvidence} from '../hosts/codex/codex-turn-evidence.js';
import type {CodexTurnOrigin} from '../hosts/codex/codex-turn-origin.js';
import {fixture} from './support/broker-fixture.js';
import {temporary} from './support/temporary.js';
import {MOD_REVISION} from '../mod-revision.js';

function setup(t:TestContext,owned=false){
  t.mock.timers.enable({apis:['Date'],now:1000000});
  const f=fixture(t),pair=f.store.pair(f.c.id,f.x.id),health=new DeliveryHealth(f.store);
  f.store.saveEndpoint({...f.store.endpoint(f.c.id)!,modRevision:MOD_REVISION});
  const evidence:CodexTurnEvidence={status:'supported',caughtUp:true,turns:[],bytesRead:0};
  const children={pending:[] as string[],known:[] as string[],wakePending:false};
  let readChildren:FinalForwardOptions['children']=()=>children;
  const ledger=()=>new CodexFinalForwards(f.store,health,{source:()=>({owned}),children:peer=>readChildren(peer),read:async()=>evidence,
    gate:(codex,claude)=>f.store.pairFor(codex.id)?.paused?'paused':codex.enabled===false||claude.enabled===false?'disabled':
      codex.state!=='ready'?'codex_busy':claude.state!=='ready'?'claude_busy':undefined});
  const forwards=ledger();
  const send=(body='已完成第一步',from=f.x,evidence='原生上下文已核验')=>{
    const message=f.store.accept(pair,from,body,'send-'+f.store.messages().length);
    f.store.transition(message.id,'contextObserved',evidence);return message;
  };
  const read=async()=>{await forwards.scan(f.x);forwards.refresh(pair);};
  const pending=()=>health.peek(pair.id,f.c.id).filter(n=>n.source==='codex_final');
  const admit=()=>{
    const notice=pending()[0];assert.ok(notice);
    const prepared=health.prepare(pair.id,f.c.id,notice.id,notice.scope,false,false,true);assert.ok(prepared);
    forwards.admitted(pair,prepared);health.outcome(pair.id,f.c.id,prepared.id,'submitted');return prepared;
  };
  let sequence=0;
  const turn=(origin?:CodexTurnOrigin,extra:Partial<CodexCompletedTurn>={}):CodexCompletedTurn=>{
    t.mock.timers.tick(10);const now=Date.now(),turnId='turn-'+ ++sequence;
    const value:CodexCompletedTurn={turnId,startedAt:now-3,completedAt:now,trigger:origin?.turnTrigger,userInputs:origin?[origin.clientUserMessageId]:[],
      lastWorkAt:now-2,final:{itemId:'answer-'+turnId,text:'未发送的最终结果 '+sequence,at:now-1},...extra};
    evidence.turns.push(value);evidence.latestTurnId=turnId;return value;
  };
  const useCompletions=()=>{const completions=new SubagentCompletions(f.store);readChildren=peer=>completions.forwardChildren(peer);return completions;};
  return{...f,pair,health,evidence,children,forwards,ledger,send,read,pending,admit,turn,useCompletions,status:()=>forwards.status(f.x) as any};
}

test('真正结束且发信之后仍有原生活动才转达；只发信再收尾不触发',async t=>{
  const f=setup(t),last=f.send(),origin=await f.forwards.origin(f.x,'partner');
  assert.ok(origin);f.turn(origin,{lastWorkAt:last.createdAt-1});await f.read();assert.deepEqual(f.pending(),[]);
  const current=f.turn(await f.forwards.origin(f.x,'partner'));f.evidence.openTurnId='仍在运行';await f.read();assert.deepEqual(f.pending(),[]);
  delete f.evidence.openTurnId;f.evidence.caughtUp=false;await f.read();assert.equal(f.status().hold,'history_pending');
  f.evidence.caughtUp=true;await f.read();const notice=f.pending()[0]!;
  assert.equal(notice.readyOnly,true);assert.equal(notice.wake,true);assert.equal(notice.tier,4);
  assert.ok(notice.message.includes(current.final!.text));assert.ok(notice.message.includes(last.id));
  assert.equal(f.store.messages().length,1,'自动转达不能伪造成搭档发信');
  assert.equal(f.health.prepare(f.pair.id,f.c.id,notice.id,notice.scope),undefined,'普通取件不消耗空闲限定提醒');
  f.admit();await f.read();assert.deepEqual(f.pending(),[]);assert.equal(f.status().consecutive,1);
  const rebuilt=f.ledger();await rebuilt.scan(f.x);rebuilt.refresh(f.pair);assert.deepEqual(f.pending(),[],'重建观察器不重放');
});

test('新配对首次工作只给出最终回复时，仍向已空闲的 Claude 汇报；Claude 后续催办不重置连续次数',async t=>{
  const f=setup(t),task=f.send('请完成第一项工作',f.c);
  f.turn(await f.forwards.origin(f.x,'partner'));await f.read();const notice=f.pending()[0]!;
  assert.ok(notice.message.includes('after reading your message ('+task.id+')'));assert.equal(f.status().anchor_from,'claude');
  f.admit();assert.equal(f.status().consecutive,1);
  t.mock.timers.tick(60001);f.send('请继续下一项',f.c);await f.read();assert.deepEqual(f.pending(),[]);
  f.turn(await f.forwards.origin(f.x,'partner'));await f.read();f.admit();assert.equal(f.status().consecutive,2);
});

test('用户窗口要求精确原生来源；用户输入、混合输入和未知来源都不自动转达',async t=>{
  const f=setup(t),last=f.send(),origin=(await f.forwards.origin(f.x,'queue'))!;
  f.turn(undefined);await f.read();assert.equal(f.status().hold,'origin_unverified');assert.deepEqual(f.pending(),[]);
  f.turn(origin,{userInputs:[origin.clientUserMessageId,'用户追加输入']});await f.read();assert.deepEqual(f.pending(),[]);
  f.turn(origin,{trigger:'user'});await f.read();assert.deepEqual(f.pending(),[]);
  const queued=(await f.forwards.origin(f.x,'queue'))!;f.turn(queued,{trigger:'queue'});await f.read();assert.equal(f.pending().length,1);
  f.turn(undefined,{userInputs:[null]});await f.read();assert.deepEqual(f.pending(),[],'后续来源不明轮次不能借之前的候选结果转达');
  assert.equal(f.status().hold,'origin_unverified');
  assert.equal(f.store.lastMessageFacts(f.pair.id,f.x.id)?.id,last.id);
});

test('旧后台轮次须有独占范围、精确原生采样回执和完整无用户输入；回复覆盖回执后仍可核验',async t=>{
  const f=setup(t,true),inbound=f.send('实际协作任务',f.c,'Codex native history 确认工具输出进入上下文，thread=x，turn=已注入轮次，item=真实原生输出');f.send();
  f.store.transition(inbound.id,'responded','回复覆盖了消息的最新回执');
  const sampledInjection={messageId:inbound.id,itemId:'真实原生输出',historySequence:1,sampledThroughSequence:2};
  f.turn();await f.read();assert.deepEqual(f.pending(),[]);
  f.turn(undefined,{sampledInjection,userInputs:[null]});await f.read();assert.deepEqual(f.pending(),[]);
  f.turn(undefined,{sampledInjection:{...sampledInjection,itemId:'不匹配的输出'}});await f.read();assert.deepEqual(f.pending(),[]);
  f.turn(undefined,{sampledInjection});await f.read();assert.equal(f.pending().length,1);
});

test('子任务钩子不能授权转发人工入队轮次的正文；已证明的桥接子任务唤醒仍保留后续原文',async t=>{
  const f=setup(t);f.send();f.children.pending=['first-child'];f.children.known=['first-child'];
  const primary=f.turn(await f.forwards.origin(f.x,'partner'));await f.read();assert.deepEqual(f.pending(),[]);
  f.turn(undefined,{trigger:'queue',userInputs:['人工队列编号'],childTurnIds:['first-child'],final:{itemId:'private',text:'用户私人对话正文',at:Date.now()+1}});
  f.children.pending=[];await f.read();const first=f.pending()[0]!;
  assert.ok(first.message.includes(primary.final!.text));assert.ok(first.message.includes('body was unverified and omitted'));assert.ok(!first.message.includes('用户私人对话正文'));
  assert.ok(!JSON.stringify(f.store.setting('codexFinalForward:'+f.x.id)).includes('用户私人对话正文'),'不把未授权的后续正文复制进转达账本');f.admit();
  t.mock.timers.tick(60001);f.children.pending=['second-child'];f.children.known.push('second-child');
  f.turn(await f.forwards.origin(f.x,'partner'));await f.read();assert.deepEqual(f.pending(),[]);
  const child=f.turn(await f.forwards.origin(f.x,'children'),{childTurnIds:['second-child']});
  f.children.pending=[];await f.read();assert.ok(f.pending()[0]!.message.includes(child.final!.text));
});

test('已唤醒并提供过的未确认子结果不再阻塞既有最终回复，保留原读取证明账本',async t=>{
  const f=setup(t),completions=f.useCompletions();f.send();
  completions.record(f.x,'first-agent','first-child',undefined,undefined);completions.record(f.x,'second-agent','second-child',undefined,undefined);
  const primary=f.turn(await f.forwards.origin(f.x,'partner'));await f.read();assert.equal(f.status().hold,'children_pending');
  const wake=completions.reserve(f.x,'native');assert.ok(wake);
  completions.outcome(f.x,wake,'submitted','child-wake-turn');assert.ok(completions.consume(f.x,completions.context(f.x)));
  completions.settle(f.x,undefined,'child-wake-turn');
  assert.equal(completions.status(f.x)?.unconfirmed,2);assert.equal(completions.pending(f.x),false);assert.equal(completions.available(f.x),false);
                                           
  f.forwards.refresh(f.pair);assert.equal(f.pending().length,1);assert.ok(f.pending()[0]!.message.includes(primary.final!.text));
  assert.equal(f.status().waiting_children,0);f.admit();await f.read();assert.deepEqual(f.pending(),[]);
  assert.equal(completions.status(f.x)?.unconfirmed,2,'转达不能冒充已读取子结果');
});

test('子任务唤醒 RPC 在途及返回后的合并期限仍阻塞转达，过期不重放已通知的事实',async t=>{
  const f=setup(t),completions=f.useCompletions();f.send();completions.record(f.x,'agent','child',undefined,undefined);
  f.turn(await f.forwards.origin(f.x,'partner'));await f.read();
  const wake=completions.reserve(f.x,'native');assert.ok(wake);assert.ok(completions.consume(f.x,completions.context(f.x)));
  t.mock.timers.tick(CODEX_WAKE_RETRY_MS+1);f.forwards.refresh(f.pair);assert.equal(f.forwards.ready(f.pair),false,'在途 RPC 不因年龄放行');
  completions.outcome(f.x,wake,'unknown');t.mock.timers.tick(CODEX_WAKE_RETRY_MS-1);
  f.forwards.refresh(f.pair);assert.equal(f.forwards.ready(f.pair),false,'回执返回后重新计算合并期限');
  t.mock.timers.tick(1);f.forwards.refresh(f.pair);assert.equal(f.forwards.ready(f.pair),true);
  assert.equal(completions.status(f.x)?.unconfirmed,1);assert.equal(completions.pending(f.x),false);
  completions.record(f.x,'new-agent','new-child',undefined,undefined);f.forwards.refresh(f.pair);
  assert.equal(f.forwards.ready(f.pair),false);assert.equal(f.status().waiting_children,1,'新的未通知结果仍阻塞旧候选');
});

test('已暂缓的主结果遇到原生回退或历史替换会取消，不在恢复空闲后转发撤回的内容',async t=>{
  const f=setup(t);f.send();f.turn(await f.forwards.origin(f.x,'partner'));await f.read();assert.equal(f.pending().length,1);
  f.store.updatePeer(f.c.id,{state:'busy'});const old=[...f.evidence.turns];f.evidence.turns=[];await f.read();
  assert.equal(f.status().hold,'history_changed');assert.deepEqual(f.pending(),[]);
  f.store.updatePeer(f.c.id,{state:'ready'});f.evidence.turns=old;await f.read();assert.deepEqual(f.pending(),[],'恢复旧文件不重新授权已撤回的完成事实');
});

test('分块追赶不撤回候选，完整扫描撤回旧结果时仍保留同批内较新的有效结果',async t=>{
  const f=setup(t);f.send();const first=f.turn(await f.forwards.origin(f.x,'partner'));await f.read();const id=f.pending()[0]!.id;
  f.evidence.turns=[];f.evidence.caughtUp=false;await f.read();assert.equal(f.status().hold,'history_pending');
  assert.equal(f.health.get(f.pair.id,f.c.id,id)?.state,'pending');
  f.evidence.turns=[first];f.evidence.caughtUp=true;await f.read();assert.equal(f.pending()[0]?.id,id);
  const newer=f.turn(await f.forwards.origin(f.x,'partner'));f.evidence.turns=[newer];await f.read();
  assert.equal(f.pending().length,1);assert.ok(f.pending()[0]!.message.includes(newer.final!.text));assert.ok(!f.pending()[0]!.message.includes(first.final!.text));
});

test('完整历史撤掉或修订子任务后续结果时，待转达正文同步撤掉或修订；同一原生编号也不复用旧正文',async t=>{
  const f=setup(t);f.send();f.children.pending=['child'];f.children.known=['child'];
  f.turn(await f.forwards.origin(f.x,'partner'));await f.read();
  const followup=f.turn(await f.forwards.origin(f.x,'children'),{childTurnIds:['child']});f.children.pending=[];await f.read();
  assert.ok(f.pending()[0]!.message.includes(followup.final!.text));
  f.evidence.turns=f.evidence.turns.filter(turn=>turn!==followup);await f.read();assert.ok(!f.pending()[0]!.message.includes(followup.final!.text));
  f.evidence.turns.push({...followup,final:{...followup.final!,text:'修订后的自动协作结果'}});await f.read();
  assert.ok(f.pending()[0]!.message.includes('修订后的自动协作结果'));assert.ok(!f.pending()[0]!.message.includes(followup.final!.text));
  f.evidence.turns[f.evidence.turns.length-1]={...followup,userInputs:['人工入队编号']};await f.read();
  assert.ok(f.pending()[0]!.message.includes('body was unverified and omitted'));assert.ok(!f.pending()[0]!.message.includes(followup.final!.text));
});

test('新结果仅等待统一一分钟间隔；同类十分钟重复限频不阻挡新的完成事实',async t=>{
  const f=setup(t);f.send();f.turn(await f.forwards.origin(f.x,'partner'));await f.read();f.admit();
  f.send('已真正向 Claude 汇报');f.turn(await f.forwards.origin(f.x,'partner'));await f.read();
  assert.equal(f.status().hold,'notice_cooldown');assert.deepEqual(f.pending(),[]);assert.equal(f.status().consecutive,0);
  t.mock.timers.tick(60001);await f.read();assert.equal(f.pending().length,1);f.admit();assert.equal(f.status().consecutive,1);
});

test('连续自动转达上限为二；Claude 催办不重置，Codex 真正发信和人工输入才重置',async t=>{
  const f=setup(t);f.send();
  for(let index=0;index<3;index++){
    t.mock.timers.tick(60001);f.send('Claude 的自动催办',f.c);
    const origin=(await f.forwards.origin(f.x,'partner'))!;f.turn(origin);await f.read();
    if(index<2){assert.equal(f.pending().length,1);f.admit();}
    else{assert.deepEqual(f.pending(),[]);assert.equal(f.status().hold,'cap_reached');}
  }
  assert.equal(f.status().consecutive,2);f.send('Codex 主动汇报');assert.equal(f.status().consecutive,0);
  t.mock.timers.tick(600001);const origin=(await f.forwards.origin(f.x,'partner'))!;f.turn(origin);await f.read();f.admit();
  assert.equal(f.status().consecutive,1);f.forwards.human(f.c);assert.equal(f.status().consecutive,0);
});

test('旧上下文的人类轮次及历史裁剪都不重新开放已用完的连续额度',async t=>{
  const f=setup(t);f.send();
  for(let index=0;index<2;index++){t.mock.timers.tick(60001);f.turn(await f.forwards.origin(f.x,'partner'));await f.read();f.admit();}
  assert.equal(f.status().consecutive,2);
  f.evidence.turns.unshift({turnId:'旧上下文人工输入',startedAt:1,completedAt:2,trigger:'user',userInputs:[null]});
  t.mock.timers.tick(10);const endpoint=f.store.endpoint(f.x.id)!;f.store.deactivate(f.x.id);f.store.saveEndpoint({...endpoint,epoch:'更换绑定'});
  await f.read();assert.equal(f.status().consecutive,2);
  f.send('只保留最近的 Claude 消息',f.c);f.store.maintain({maxMessages:1});assert.equal(f.store.lastMessageFacts(f.pair.id,f.x.id),undefined);
  assert.equal(f.status().consecutive,2,'最后发信被历史裁剪不能当作新汇报');
  await f.read();assert.deepEqual(f.pending(),[]);assert.equal(f.status().hold,'history_unavailable','裁剪不能把已有汇报误当作从未发信');
  t.mock.timers.tick(10);f.send('Codex 的新主动汇报');assert.equal(f.status().consecutive,0);
});

test('暂时门槛不消耗额度；解除门槛沿用同一个待转达结果；换代则不复活旧候选',async t=>{
  const f=setup(t);f.send();const origin=(await f.forwards.origin(f.x,'partner'))!;f.turn(origin);await f.read();const id=f.pending()[0]!.id;
  f.store.updatePeer(f.c.id,{state:'busy'});assert.equal(f.forwards.ready(f.pair),false);assert.equal(f.forwards.ready(f.pair,true),true);
  f.store.updatePeer(f.x.id,{state:'paused'});assert.equal(f.forwards.ready(f.pair,true),false);assert.equal(f.status().consecutive,0);
  f.store.updatePeer(f.x.id,{state:'ready'});f.store.updatePeer(f.c.id,{state:'ready'});await f.read();assert.equal(f.pending()[0]?.id,id);
  const old=f.store.endpoint(f.x.id)!;f.store.deactivate(f.x.id);f.store.saveEndpoint({...old,epoch:'新的原生代次'});
  const before=f.store.events().length;assert.equal(f.status().hold,'context_changed');assert.equal(f.store.events().length,before,'诊断不能修改账本或发出取消事件');
  await f.read();assert.deepEqual(f.pending(),[]);assert.equal(f.status().hold,'context_changed');
});

test('普通通知不夹带空闲限定正文；空闲边界可以合并准入且只计一次额度',async t=>{
  const f=setup(t);f.send();const origin=(await f.forwards.origin(f.x,'partner'))!;f.turn(origin);await f.read();
  const final=f.pending()[0]!;
  f.health.enqueue(f.pair.id,f.c.id,{id:'ordinary',message:'独立的普通通知',state:'pending',tier:3,scope:final.scope});
  assert.equal(f.health.peek(f.pair.id,f.c.id).length,2);
  const ordinary=f.health.prepare(f.pair.id,f.c.id,'ordinary',final.scope)!;assert.deepEqual(ordinary.componentIds,['ordinary']);
  assert.ok(!ordinary.message.includes('codex_final'));assert.equal(f.health.get(f.pair.id,f.c.id,final.id)?.admitted,undefined);
  assert.equal(f.status().consecutive,0);
  t.mock.timers.tick(60001);
  f.health.enqueue(f.pair.id,f.c.id,{id:'ordinary-next',kind:'independent',message:'另一个独立通知',state:'pending',tier:3,scope:final.scope});
  const combined=f.admit();assert.deepEqual(combined.componentIds,[final.id,'ordinary-next']);assert.equal(f.status().consecutive,1);
});

test('需要用户回答的问题（含 needs_user）阻止转达；正文不会绕过正常 prepare',async t=>{
  const f=setup(t);f.send();
  const request:any=await f.broker.dispatch('question.create',{actor:{host:'codex',sessionId:'x',callId:'question'},questions:[{id:'requirement',header:'需求',question:'需要用户决定的需求'}]});
  const question=f.store.question(request.request_id);f.store.transition(question.messageId,'contextObserved','Claude 已读问题');f.store.saveQuestion({...question,status:'needs_user'});
  const origin=(await f.forwards.origin(f.x,'partner'))!;f.turn(origin);
  await f.read();assert.equal(f.status().hold,'question_pending');assert.deepEqual(f.pending(),[]);
  f.store.saveQuestion({...question,status:'answered'});await f.read();assert.equal(f.pending().length,1);
  const notice=f.pending()[0]!;assert.equal(notice.scope,noticeScope(f.pair,f.c,f.x,f.store.bindings.current(f.c.id)?.epoch,f.store.bindings.current(f.x.id)?.epoch));
});

test('真实协调器在当前 Mod 和最新原生事实下准入，普通通知也不能夹带旧结果',async t=>{
  const cases:Array<{ordinary:boolean;completed:boolean;oldMod?:boolean}>=[{ordinary:false,completed:false},{ordinary:true,completed:false},{ordinary:true,completed:true},{ordinary:false,completed:false,oldMod:true}];
  for(const {ordinary,completed,oldMod} of cases)await t.test(oldMod?'旧 Mod 先升级再接收原提醒':completed?'普通通知携带探测期间刚结束的新结果':ordinary?'普通通知入口':'最终结果入口',async t=>{
  const f=setup(t),file=path.join(temporary(t),'native.jsonl'),forwards=f.broker.finalForwards;
  writeFileSync(file,JSON.stringify({type:'session_meta',payload:{id:f.x.sessionId}})+'\n','utf8');
  f.store.setSetting('codexTranscript:'+f.x.id,{sessionId:f.x.sessionId,file});f.send();
  const origin=(await forwards.origin(f.x,'queue'))!;
  t.mock.timers.tick(10);const at=Date.now(),turnId='native-final';
  const row=(n:number,payload:object,type='event_msg')=>({timestamp:new Date(at+n).toISOString(),type,payload});
  const event=(n:number,type:string,extra:object={})=>row(n,{type,turn_id:turnId,...extra});
  const item=(n:number,value:object)=>event(n,'item_completed',{thread_id:f.x.sessionId,item:value});
  const append=(...rows:unknown[])=>appendFileSync(file,rows.map(row=>JSON.stringify(row)+'\n').join(''),'utf8');
  append(event(0,'task_started',{turn_attribution:{turn_id:turnId,turn_trigger:'queue'}}),
    item(1,{type:'UserMessage',client_id:origin.clientUserMessageId}),row(2,{type:'custom_tool_call',name:'exec'} ,'response_item'),
    item(3,{type:'AgentMessage',phase:'final_answer',id:'native-answer',content:[{type:'Text',text:'真实读取后的最终回复'}]}),event(4,'task_complete'));
  const actor={host:'claude',sessionId:f.c.sessionId,callId:'native-prepare'};
  if(oldMod){
    const revision=(modRevision:string)=>f.store.saveEndpoint({...f.store.endpoint(f.c.id)!,modRevision});
    revision('0000000000000000');await forwards.scan(f.x);forwards.refresh(f.pair);
    assert.equal((forwards.status(f.x) as any).hold,'mod_pending');assert.deepEqual(f.pending(),[],'旧 Mod 不先收到会反复丢弃的标记');
    revision(MOD_REVISION);forwards.refresh(f.pair);const id=f.pending()[0]!.id;
    revision('0000000000000000');const signal:any=await f.broker.dispatch('health.monitor',{actor,admit:false});
    assert.ok(!signal.notices.some((notice:any)=>notice.source==='codex_final'),'已存在的空闲限定通知也不向旧 Mod 提供');
    revision(MOD_REVISION);const ready:any=await f.broker.dispatch('health.monitor',{actor,notice_id:id,ready_boundary:true});
    assert.equal(ready.notices[0]?.id,id);assert.ok(ready.notices[0]?.message.includes('真实读取后的最终回复'));assert.equal((forwards.status(f.x) as any).consecutive,1);return;
  }
  await forwards.scan(f.x);forwards.refresh(f.pair);const notice=f.pending()[0]!;assert.ok(notice);
  const prepare=(ready_boundary=false)=>f.broker.dispatch('health.monitor',{actor,notice_id:ready_boundary&&ordinary?'ordinary':notice.id,ready_boundary}) as Promise<any>;
  f.store.updatePeer(f.c.id,{state:'busy'});assert.deepEqual(await prepare(),{notices:[],deferred:true});
  assert.equal((forwards.status(f.x) as any).consecutive,0);assert.equal(f.health.get(f.pair.id,f.c.id,notice.id)?.state,'pending');
  if(ordinary)f.health.enqueue(f.pair.id,f.c.id,{id:'ordinary',message:'独立通知',state:'pending',tier:3,scope:notice.scope});
  const next=completed?(await forwards.origin(f.x,'queue'))!:undefined;
  let probed=false;
  f.codex.probe=async()=>{
                                         
    if(!probed){
      append(row(5,{type:'task_started',turn_id:'next',turn_attribution:{turn_id:'next',turn_trigger:next?.turnTrigger??'user'}}));
      if(next)append(row(6,{type:'item_completed',thread_id:f.x.sessionId,turn_id:'next',item:{type:'UserMessage',client_id:next.clientUserMessageId}}),
        row(7,{type:'custom_tool_call',name:'exec'},'response_item'),
        row(8,{type:'item_completed',thread_id:f.x.sessionId,turn_id:'next',item:{type:'AgentMessage',id:'newer-answer',phase:'final_answer',content:[{type:'Text',text:'刚结束的新最终回复'}]}}),
        row(9,{type:'task_complete',turn_id:'next'}));
    }
    probed=true;return{state:'reachable',reasons:[],checked_at:Date.now()};
  };
  const result=await prepare(true);assert.equal(probed,true);
  if(completed){assert.ok(JSON.stringify(result.notices).includes('刚结束的新最终回复'));assert.ok(!JSON.stringify(result.notices).includes('真实读取后的最终回复'));}
  else if(ordinary){assert.equal(result.notices.length,1);assert.ok(!JSON.stringify(result.notices).includes('codex_final'));}
  else assert.deepEqual(result,{notices:[],deferred:true});
  assert.equal((forwards.status(f.x) as any).consecutive,completed?1:0);
  });
});
