import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './support/broker-fixture.js';
import { registration } from './support/registration.js';
import {BridgeError,DeliveryError} from '../shared/errors.js';
import { runtimeProfile } from '../broker/profiles/runtime-profile.js';
import { modelError, modelPeerName } from '../integration/mcp/model-output.js';
import { threadRegistration } from '../hosts/codex/adapter.js';
import { formatStatus, formatQuestion } from '../integration/mcp/presentation.js';

test('模型观测缺省保留、显式清空、换模型清除旧 effort，数字零不丢',async t=>{
  const {store,broker,x}=fixture(t),actor={host:'codex',sessionId:'x',callId:'profile'};
  assert.deepEqual(runtimeProfile({model:'a',effort:0},{}),{model:'a',effort:0});
  assert.deepEqual(runtimeProfile({model:'a',effort:'high'},{model:'b'}),{model:'b'});
  assert.deepEqual(runtimeProfile({model:'a',effort:'high'},{model:null}),{});
  store.register(registration('codex','x',{model:'a',effort:0}));store.register(registration('codex','x'));assert.equal(store.peer(x.id).effort,0);
  await broker.dispatch('peer.state',{actor,state:'busy',model:'b'});assert.equal(store.peer(x.id).model,'b');assert.equal(store.peer(x.id).effort,undefined);
  await broker.dispatch('peer.state',{actor,state:'busy',effort:0});assert.equal(store.peer(x.id).effort,0);
  await broker.dispatch('peer.state',{actor,state:'ready',model:null,effort:null});assert.equal(store.peer(x.id).model,undefined);
  const child=store.register(registration('codex','child',{kind:'subagent',parentId:'x'}));
  await assert.rejects(broker.dispatch('peer.state',{actor:{...actor,sessionId:child.sessionId},state:'busy',model:'child-model'}),/子代理/);
  const r=threadRegistration({id:'profile',cwd:x.cwd,model:'observed',reasoningEffort:'high'},'unix://fixture');assert.equal(r?.model,'observed');assert.equal(r?.effort,'high');
  const resumed=threadRegistration({id:'profile',cwd:x.cwd,model:'old',reasoningEffort:'high'},'unix://fixture',{model:'current',reasoningEffort:null});assert.equal(resumed?.model,'current');assert.equal(resumed?.effort,null);
});

test('人类状态精简为中文并转义控制字符，不展开题目或内部结构',async t=>{
  const {store,broker,c,x}=fixture(t);store.pair(c.id,x.id);store.updatePeer(c.id,{name:'搭档\u001b[31m'});
  const created:any=await broker.dispatch('question.create',{actor:{host:'codex',sessionId:'x',callId:'q'},questions:[{id:'q',header:'题',question:'不应在状态里展开的正文'}]});
  const status:any=broker.status({host:'codex',sessionId:'x',callId:'status'}),text=formatStatus(status);
  assert.equal(text.split('\n').length,4);assert.match(text,/待处理问题：1/);assert.match(text,/搭档\\u001b/);assert.doesNotMatch(text,/不应在状态里展开|pair_id|questions|\u001b/);
  assert.match(formatQuestion(store.question(created.request_id)),/等待搭档/);assert.doesNotMatch(formatQuestion(store.question(created.request_id)),/waitingPartner/);
});

test('模型状态只保留活跃问题，题目仅给回答方并采用宿主视图',async t=>{
  const {store,broker,c,x}=fixture(t),actor={host:'codex',sessionId:'x',callId:'question'};store.pair(c.id,x.id);
  store.updatePeer(c.id,{model:'opus',effort:0});
  const q:any=await broker.dispatch('question.create',{actor,questions:[{id:'q',header:'决定',question:'用户原文？',isOther:false,options:[{label:'甲',description:'一'},{label:'乙',description:'二'}]}]});
  const full:any=await broker.dispatch('status',{actor}),small:any=await broker.dispatch('status',{actor,model_view:true});
  assert.ok(full.self.sessionId&&full.self.cwd&&full.pair_id);assert.equal(small.self.sessionId,undefined);assert.equal(small.partner.model,'opus');assert.equal(small.partner.effort,0);
  assert.equal(small.questions[0].questions,undefined);assert.equal(small.questions[0].role,'asker');
  for(const key of ['state','sessionId','host','cwd'])assert.equal(small.self[key],undefined);
  for(const key of ['host','name'])assert.equal(small.partner[key],undefined);
  for(const key of ['paused','pending','receive_mode'])assert.equal(small[key],undefined);
  assert.equal(small.pickup,true);
  const respondent:any=await broker.dispatch('status',{actor:{host:'claude',sessionId:'c',callId:'status'},model_view:true});
  assert.equal(respondent.questions[0].role,'respondent');assert.equal(respondent.questions[0].questions[0].question,'用户原文？');assert.equal(respondent.questions[0].questions[0].multiSelect,false);assert.equal(respondent.questions[0].questions[0].id,undefined);
  await broker.dispatch('question.answer',{actor:{host:'claude',sessionId:'c',callId:'answer'},input:{request_id:q.request_id,answers:{'用户原文？':'甲'},rationale:'原始理由'}});
  const done:any=await broker.dispatch('status',{actor,model_view:true});assert.equal(done.questions,undefined);
  const history:any=await broker.dispatch('status',{});assert.equal(history.questions[0].source.kind,'partner');assert.equal(history.questions[0].rationale,'原始理由');assert.equal(history.questions[0].answers.q.answers[0],'甲');
  store.saveEndpoint({...store.endpoint(x.id)!,mode:'embedded'});store.setPaused(true);
  const paused:any=await broker.dispatch('status',{actor,model_view:true});assert.equal(paused.pickup,true);assert.equal(paused.paused,true);
});

test('模型错误只翻译内部文案，保留 uncertain 和自定义名称',t=>{
  const {c}=fixture(t);
  assert.deepEqual(modelError(new BridgeError('ref_missing','中文错误')),{code:'ref_missing',message:'nxref not found: msg must be in current pair; agent must be own finished subagent (id, not name)'});
  assert.equal(modelError(new DeliveryError('timeout','超时',true)).uncertain,true);
  assert.equal(modelPeerName(c),c.name);assert.equal(modelPeerName({...c,name:'nxbridge · claude 搭档'}),'nxbridge:claude');
  assert.equal(modelPeerName({...c,name:'nxbridge-01234567-89ab-cdef-0123-456789abcdef'}),'nxbridge:claude');
  assert.equal(modelPeerName({...c,name:'用户定制名称'}),'用户定制名称');
});
