import test from 'node:test';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { fixture } from './support/broker-fixture.js';
import { registration } from './support/registration.js';
import { formatQuestion } from '../integration/mcp/presentation.js';
import { ASK_TOOL, codexView, claudeView } from '../integration/mcp/questions.js';
import {QUESTION_ROUTING_INSTRUCTIONS} from '../integration/instructions.js';
import {PACKAGE_ROOT} from '../shared/package-location.js';

const cx={host:'codex' as const,sessionId:'x',callId:'ask'},cc={host:'claude' as const,sessionId:'c',callId:'answer'};
const questions=[{id:'format',header:'格式',question:'输出哪种格式？',options:[{label:'摘要 (Recommended)',description:'结论'},{label:'完整, 详细',description:'过程'}]}];
const claudeQuestions=Array.from({length:4},(_,i)=>({header:'第'+i+'题',question:'问题'+i,options:[{label:'甲, 乙',description:'组合',preview:'中文预览'},{label:'丙',description:'单项'}],multiSelect:true}));

test('转回用户的旧问题在原截止时间结束路由，不推断答案或重复通知',async t=>{
  t.mock.timers.enable({apis:['Date'],now:1000000});const f=fixture(t);f.store.pair(f.c.id,f.x.id);
  const created=await f.broker.dispatch('question.create',{actor:cx,questions:[{id:'text',header:'文本',question:'用户输入什么？'}]}) as any;
  await f.broker.dispatch('question.answer',{actor:cc,input:{request_id:created.request_id,action:'ask_user'}});
  assert.equal(f.store.question(created.request_id).status,'needs_user');const count=f.store.messages().length;
  t.mock.timers.tick(600001);f.broker.questions.sweep();f.broker.questions.sweep();
  const ended=f.store.question(created.request_id);assert.equal(ended.status,'timed_out');assert.equal(ended.terminalReason,'user_routing_timed_out');assert.equal(ended.answers,undefined);assert.equal(f.store.messages().length,count);assert.equal(f.store.pairFor(f.x.id)?.paused,false);
});

test('Codex 提交立即返回 pending，控制答案保持 label、来源与一次性通知',async t=>{
  const {broker,store,c,x}=fixture(t);store.pair(c.id,x.id);
  const created:any=await broker.dispatch('question.create',{actor:cx,questions});
  assert.equal(created.status,'pending');assert.equal(Date.parse(created.expires_at)-store.question(created.request_id).createdAt,600000);
  const q=store.question(created.request_id);assert.equal(q.items[0]?.isOther,true);
  const answer={request_id:q.id,answers:{'输出哪种格式？':'摘要 (Recommended)'},rationale:'只需要结论。'};
  const result=await broker.dispatch('question.answer',{actor:cc,input:answer});
  assert.equal(store.question(q.id).status,'answered');assert.deepEqual(store.question(q.id).source,{kind:'partner',host:'claude'});
  assert.deepEqual(await broker.dispatch('question.answer',{actor:cc,input:answer}),result);
  const notices=store.messages().filter(m=>m.inReplyTo===q.messageId);assert.equal(notices.length,1);
  const data=JSON.parse(notices[0]!.body);assert.deepEqual(data.answers,{format:{answers:['摘要 (Recommended)']}});assert.equal(data.rationale,answer.rationale);
  await assert.rejects(broker.dispatch('question.answer',{actor:{...cc,callId:'late'},input:answer}),/已经结束/);
  assert.ok(ASK_TOOL.description.includes(QUESTION_ROUTING_INSTRUCTIONS));
});

test('Claude 四题、多选、preview 完整转发，Codex 回答不拆逗号',async t=>{
  const {broker,store,c,x}=fixture(t);store.pair(c.id,x.id);
  const message:any=broker.send({actor:cx,message:'这是搭档任务'});
  const created:any=await broker.dispatch('question.create',{actor:{...cc,callId:'ask'},questions:claudeQuestions,task_message_id:message.message_id,turn_id:'turn',tool_use_id:'call'});
  const q=store.question(created.request_id);assert.equal(q.items.length,4);assert.equal(q.items[3]!.options![0]!.preview,'中文预览');assert.equal(q.items[3]!.multiSelect,true);
  assert.equal(codexView(q)[0]!.options![0]!.preview,'中文预览');assert.equal(codexView(q)[0]!.multiSelect,true);
  const status:any=await broker.dispatch('status',{actor:cx,model_view:true});
  assert.equal(status.questions[0].role,'respondent');assert.equal(status.questions[0].questions[0].multiSelect,true);assert.equal(status.questions[0].questions[0].options[0].preview,'中文预览');
  const answers=Object.fromEntries(q.items.map(item=>[item.id,{answers:['甲, 乙','丙']}]));
  const waiting=broker.dispatch('question.wait',{actor:cc,request_id:q.id});
  await broker.dispatch('question.answer',{actor:{...cx,callId:'answer'},input:{request_id:q.id,questions:codexView(q),answers,rationale:'选择两项。'}});
  const result:any=await waiting;assert.equal(result.status,'answered');assert.equal(result.answers['问题3'],'甲, 乙, 丙');assert.deepEqual(store.question(q.id).answers?.q4?.answers,['甲, 乙','丙']);
  assert.match(formatQuestion(store.question(q.id)),/中文预览/);
});

test('挂起时拒绝反问、错误回答方、缺题和伪造用户来源',async t=>{
  const {broker,store,c,x}=fixture(t);store.pair(c.id,x.id);
  const created:any=await broker.dispatch('question.create',{actor:cx,questions});
  const q=store.question(created.request_id);
  await assert.rejects(broker.dispatch('question.create',{actor:{...cx,callId:'second'},questions}),/先用 answer_question/);
  await assert.rejects(broker.dispatch('question.answer',{actor:cx,input:{request_id:q.id,answers:{},rationale:'x'}}),/只有本次回答方/);
  await assert.rejects(broker.dispatch('question.answer',{actor:cc,input:{request_id:q.id,answers:{},rationale:'x'}}),/完整覆盖/);
  await assert.rejects(broker.dispatch('question.answer_user',{actor:cc,input:{request_id:q.id,answers:{'输出哪种格式？':'摘要'},rationale:'x'}}),{code:'obsolete_form'});
  await assert.rejects(broker.dispatch('question.answer',{actor:cc,input:{request_id:q.id,answers:{'输出哪种格式？':'摘要'},source:'user',rationale:'x'}}));
  assert.equal(store.question(q.id).status,'pending');
});

test('可选问题回显不阻断答案，题目与选项仍使用保存的快照',async t=>{
  const {broker,store,c,x}=fixture(t);store.pair(c.id,x.id);
  const made:any=await broker.dispatch('question.create',{actor:cx,questions:[{...questions[0]!,isOther:false}]});
  const q=store.question(made.request_id),echo=[{question:'回显中的其他问题',options:[]}];
  await assert.rejects(broker.dispatch('question.answer',{actor:cc,input:{request_id:q.id,questions:echo,answers:{'回显中的其他问题':'摘要 (Recommended)'},rationale:'x'}}),{code:'incomplete_answer'});
  await assert.rejects(broker.dispatch('question.answer',{actor:cc,input:{request_id:q.id,questions:echo,answers:{'输出哪种格式？':'回显中的选项'},rationale:'x'}}),{code:'invalid_choice'});
  const answer={request_id:q.id,questions:echo,answers:{'输出哪种格式？':'摘要 (Recommended)'},rationale:'根据原始问题回答。'};
  const result:any=await broker.dispatch('question.answer',{actor:cc,input:answer});
  assert.equal(result.status,'answered');assert.deepEqual(store.question(q.id).answers,{format:{answers:['摘要 (Recommended)']}});
  const count=store.messages().length;
  assert.deepEqual(await broker.dispatch('question.answer',{actor:cc,input:{...answer,questions:[]}}),result);assert.equal(store.messages().length,count);
  const saved=store.question(q.id),submission=Object.values(saved.submissions!)[0]!;
  submission.input={...submission.input as object,questions:q.items};store.saveQuestion(saved);
  assert.deepEqual(await broker.dispatch('question.answer',{actor:cc,input:{...answer,questions:[]}}),result);assert.equal(store.messages().length,count);
});

test('受控 Claude 原生升级之后才能标用户来源，无选项题明确交回用户路径',async t=>{
  const {broker,store,c,x}=fixture(t);store.pair(c.id,x.id);
  const created:any=await broker.dispatch('question.create',{actor:cx,questions});
  const receipt:any=await broker.dispatch('question.answer',{actor:cc,input:{request_id:created.request_id,action:'ask_user'}});
  assert.equal(receipt.status,'awaiting_user');assert.deepEqual(receipt.questions,claudeView(store.question(created.request_id)));
  assert.equal((await broker.dispatch('question.answer',{actor:cc,input:{request_id:created.request_id,action:'ask_user'}}) as any).replayed,true);
  await assert.rejects(broker.dispatch('question.answer',{actor:{...cc,callId:'repeat-upgrade'},input:{request_id:created.request_id,action:'ask_user'}}),/不能重复弹表单/);
  await assert.rejects(broker.dispatch('question.answer',{actor:{...cc,callId:'model'},input:{request_id:created.request_id,answers:{'输出哪种格式？':'摘要'},rationale:'x'}}),/正在等待/);
  const user:any=await broker.dispatch('question.answer_user',{actor:{...cc,callId:'user'},form_lease:receipt.form_lease,input:{request_id:created.request_id,answers:{'输出哪种格式？':'完整, 详细'},rationale:'用户原生回答。'}});
  assert.deepEqual(user.answers,{format:{answers:['完整, 详细']}});assert.equal(user.source.kind,'user_via_claude');
  const replay:any=await broker.dispatch('question.answer',{actor:cc,input:{request_id:created.request_id,action:'ask_user'}});
  assert.equal(replay.status,'answered');assert.deepEqual(replay.answers,user.answers);assert.equal(replay.replayed,true);
  assert.equal(store.question(created.request_id).source?.kind,'user_via_claude');
  const free:any=await broker.dispatch('question.create',{actor:{...cx,callId:'free'},questions:[{id:'text',header:'说明',question:'补充什么？'}]});
  const fallback:any=await broker.dispatch('question.answer',{actor:cc,input:{request_id:free.request_id,action:'ask_user'}});assert.equal(fallback.status,'needs_user');
  assert.match(fallback.message,/2-4 options/);
});

test('无 Mod 立即结束提问，同代次已观测答题支持不被 MCP 覆盖，新代次重新探测',async t=>{
  const {broker,store,c,x}=fixture(t);store.pair(c.id,x.id);
  const endpoint=store.endpoint(c.id)!;
  const register=(support:boolean,epoch=endpoint.epoch)=>store.register(registration('claude','c',{endpoint:{...endpoint,epoch,questionSupport:support}}));
  register(false);
  const absent:any=await broker.dispatch('question.create',{actor:cx,questions});assert.equal(absent.status,'needs_user');assert.equal(store.questions(true).length,0);assert.equal(store.question(absent.request_id).fallback,'mod_unavailable');
  assert.match(absent.message,/answer tool unavailable.*reload\/enable/);assert.doesNotMatch(absent.message,/2-4 options/);
  const status:any=await broker.dispatch('status',{actor:cx,model_view:true});assert.equal(status.questions[0].status,'needs_user');assert.equal(status.questions[0].questions,undefined);
  store.register(registration('claude','c',{endpoint}));assert.equal(store.endpoint(c.id)!.questionSupport,false);
  register(true);register(false);assert.equal(store.endpoint(c.id)!.questionSupport,true);
  const pending:any=await broker.dispatch('question.create',{actor:{...cx,callId:'supported'},questions});assert.equal(pending.status,'pending');
  await broker.dispatch('question.cancel',{actor:cx,request_id:pending.request_id});
  register(false,'next-process');assert.equal(store.endpoint(c.id)!.questionSupport,false);
  const restarted:any=await broker.dispatch('question.create',{actor:{...cx,callId:'unsupported-new'},questions});assert.equal(restarted.status,'needs_user');
});

test('到期、重启、换配对和取消释放等待，旧问题不再投递',async t=>{
  const {broker,store,c,x}=fixture(t);store.pair(c.id,x.id);
  const create=async(callId:string)=>(await broker.dispatch('question.create',{actor:{...cx,callId},questions}) as any).request_id;
  const expired=await create('expire');const q=store.question(expired);q.expiresAt=Date.now()-1;store.saveQuestion(q);broker.questions.sweep();
  assert.equal(store.question(expired).status,'timed_out');assert.notEqual(store.message(q.messageId).state,'accepted');
  const restarted=await create('restart');broker.questions.recover();assert.equal(store.question(restarted).status,'expired');
  const cancelled=await create('cancel');const waiting=broker.dispatch('question.wait',{actor:cx,request_id:cancelled});await broker.dispatch('question.cancel',{actor:cx,request_id:cancelled});assert.equal((await waiting as any).status,'cancelled');
  const replaced=await create('replace');const other=store.register(registration('claude','other'));await broker.dispatch('pair',{claude:other.id,codex:x.id,replace:true});broker.questions.sweep();assert.equal(store.question(replaced).status,'cancelled');
});

test('嵌套事务中问题和通知一起回滚；重复问题与未知来源不入库',async t=>{
  const {broker,store,c,x}=fixture(t);store.pair(c.id,x.id);
  assert.throws(()=>store.transaction(()=>{broker.questions.create(store.currentPair()!,x,cx,{questions});throw new Error('回滚');}),/回滚/);
  assert.equal(store.questions().length,0);assert.equal(store.messages().length,0);
  await assert.rejects(broker.dispatch('question.create',{actor:cc,questions:claudeQuestions}),/缺少可核验/);
  await assert.rejects(broker.dispatch('question.create',{actor:cx,questions:[questions[0],questions[0]]}),/不能重复/);
  assert.equal(store.questions().length,0);
});

test('问题仅传一份 canonical，预览和多选保留，双方接受原样回显',async t=>{
  const {store,broker,c,x}=fixture(t);store.pair(c.id,x.id);
  const origin=broker.send({actor:cx,message:'任务'}) as any;
  const made:any=await broker.dispatch('question.create',{actor:cc,questions:claudeQuestions,task_message_id:origin.message_id});
  const q=store.question(made.request_id),notice=JSON.parse(store.message(q.messageId).body);
  assert.deepEqual(notice.questions,q.items);assert.equal(notice.question_details,undefined);assert.equal(notice.questions[0].options[0].preview,'中文预览');assert.equal(notice.questions[0].multiSelect,true);
  await broker.dispatch('question.answer',{actor:cx,input:{request_id:q.id,questions:notice.questions,answers:Object.fromEntries(q.items.map(item=>[item.id,{answers:['丙']} ])),rationale:'原始理由'}});
  const next:any=await broker.dispatch('question.create',{actor:{...cx,callId:'new'},questions});
  const saved=store.question(next.request_id);
  const result:any=await broker.dispatch('question.answer',{actor:{...cc,callId:'echo'},input:{request_id:saved.id,questions:saved.items,answers:{[questions[0]!.question]:'摘要 (Recommended)'},rationale:'原始理由'}});assert.equal(result.status,'answered');
});

test('Claude 来源关联需要宿主 origin 和实际 append，忙时来信不改用户 turn',async()=>{
  const {TurnSources}=await import(pathToFileURL(path.join(PACKAGE_ROOT,'plugins/claude/hooks/questions.js')).href);
  const sources=new TurnSources(),id='01234567-abcd';
  sources.submit({origin:{kind:'composer'},text:'用户任务'});sources.start({turnId:'human'});
  sources.submit({origin:{kind:'peer'},turnId:'human',text:'[nxbridge message_id='+id+']'});sources.append(id,'row');assert.equal(sources.source(),undefined);
  sources.clear();sources.submit({origin:{kind:'peer'},text:'[nxbridge message_id='+id+']'});sources.append(id,'row');sources.start({turnId:'partner'});assert.equal(sources.source(),id);assert.equal(sources.source('child'),undefined);
  sources.clear();sources.submit({origin:{kind:'composer'},text:'[nxbridge message_id='+id+']'});sources.append(id,'fake');sources.start({turnId:'fake'});assert.equal(sources.source(),undefined);
  sources.clear();sources.submit({origin:{kind:'peer'},text:'[nxbridge message_id='+id+']'});sources.start({turnId:'before-append'});assert.equal(sources.source(),undefined);sources.append(id,'row');assert.equal(sources.source(),id);
  sources.append(id,undefined);assert.equal(sources.source(),undefined,'后续追加缺少宿主 UUID 时不能沿用旧来源');
});
