import test from 'node:test';
import assert from 'node:assert/strict';
import { ClaudeInbound, claudePermissionClass, inboundAdmission } from '../hosts/claude/claude-inbound.js';
import { fixture } from './support/broker-fixture.js';
import type { Endpoint, NativeInbound, PermissionClass } from '../types.js';
import { peerAddress } from '../hosts/claude/claude-inbox.js';

const endpoint=(policy:NativeInbound['policy'],permission:PermissionClass='prompting'):Endpoint=>({peerId:'receiver',epoch:'epoch',mode:'claude-inbox',address:'inbox',pid:null,procStart:null,seenAt:100,active:true,nativeInbound:{policy,permission,observedAt:100}});

test('原生准入：显式策略优先，默认策略比较实际权限，未知观察不猜测',()=>{
  for(const mode of ['plan','bypassPermissions','bypass'])assert.equal(claudePermissionClass(mode),'bypass');
  for(const mode of ['default','acceptEdits','auto','dontAsk'])assert.equal(claudePermissionClass(mode),'prompting');
  assert.equal(claudePermissionClass('future'),'unknown');
  for(const sender of ['prompting','bypass','unknown'] as const){
    assert.equal(inboundAdmission(sender,endpoint('accept')),'accept');
    assert.equal(inboundAdmission(sender,endpoint('hold')),'held');
    assert.equal(inboundAdmission(sender,endpoint('refuse')),'refused');
    assert.equal(inboundAdmission(sender,endpoint('unknown')),'unknown');
  }
  for(const sender of ['prompting','bypass'] as const)for(const receiver of ['prompting','bypass'] as const)assert.equal(inboundAdmission(sender,endpoint('default',receiver)),sender===receiver?'accept':'approval_required');
  assert.equal(inboundAdmission('unknown',endpoint('default','bypass')),'unknown');
  assert.equal(inboundAdmission('bypass',endpoint('default','unknown')),'unknown');
  assert.equal(inboundAdmission('bypass'),'unknown');
});

test('发送结果和集成状态提示预计审核，但预测不阻止实际投递',async t=>{
  const {store,broker,c,x,claude}=fixture(t);store.pair(c.id,x.id);store.updatePeer(x.id,{permission:'bypass'});
  const old=store.endpoint(c.id)!;store.saveEndpoint({...old,nativeInbound:{policy:'default',permission:'prompting',observedAt:Date.now()}});
  const sent=await broker.dispatch('send',{actor:{host:'codex',sessionId:'x',callId:'warning'},message:'需要原生审核'}) as any;
  assert.equal(sent.persisted,true);assert.equal(sent.read_confirmed,false);assert.equal(sent.inbound_admission.state,'approval_required');assert.match(sent.message,/original Claude window/);
  await broker.pump();assert.equal(claude.delivered.length,1);assert.notEqual(store.message(sent.message_id).state,'held');
  assert.ok(broker.pairAnomalies.issues(c.id).some(issue=>issue.kind==='inbound_hold'));
  store.saveEndpoint({...old,nativeInbound:{policy:'accept',permission:'prompting',observedAt:Date.now()}});await broker.pump();
  assert.ok(!broker.pairAnomalies.issues(c.id).some(issue=>issue.kind==='inbound_hold'));
});

test('接收钩子的审核等待可持久恢复；重复回执不延长截止时间，超时仍不声称丢信',async t=>{
  const {store,broker,c,x,claude}=fixture(t),pair=store.pair(c.id,x.id),old=store.endpoint(c.id)!;
  store.saveEndpoint({...old,nativeInbound:{policy:'default',permission:'prompting',dialogExpiry:'2s',observedAt:Date.now()}});
  const message=store.accept(pair,x,'等待原生审批','held');store.claim(message.id);store.transition(message.id,'unknown');
  const receipt={actor:{host:'claude' as const,sessionId:'c',callId:'receive'},message_id:message.id,state:'observed',admission:'approval_required'};
  await broker.dispatch('observe',receipt);const approval=store.inboundApprovals()[0]!.approval;
  assert.equal(store.message(message.id).state,'held');assert.equal(approval.expiresAt,approval.receivedAt+2000);
  await broker.dispatch('observe',receipt);assert.equal(store.inboundApprovals()[0]!.approval.expiresAt,approval.expiresAt);
  const recovered=new ClaudeInbound(store,broker.deliveryHealth);recovered.sweep(approval.expiresAt!-1);
  assert.equal(store.inboundApprovals()[0]!.approval.expiredUnconfirmed,undefined);
  recovered.sweep(approval.expiresAt!+1);recovered.sweep(approval.expiresAt!+1000);
  assert.equal(store.message(message.id).state,'held');assert.equal(claude.delivered.length,0);
  assert.equal(store.events(0,1000).filter(e=>e.type==='message.inbound.expiry_unconfirmed').length,1);
  assert.ok(broker.deliveryHealth.peek(pair.id,x.id).some(n=>n.message.includes('approval_expiry_unconfirmed')&&n.message.includes('busy queue')));
  await broker.dispatch('observe',{...receipt,state:'contextObserved',admission:undefined});
  assert.equal(store.message(message.id).state,'contextObserved');assert.equal(store.inboundApprovals().length,0);
  assert.ok(!broker.deliveryHealth.peek(pair.id,x.id).some(n=>n.kind?.startsWith('inbound_')));
  await broker.dispatch('observe',receipt);assert.equal(store.message(message.id).state,'contextObserved');assert.equal(store.inboundApprovals().length,0);
});

test('普通忙碌消息无审批计时；显式 hold 不过期；原生释放证据结算等待',async t=>{
  const {store,broker,c,x}=fixture(t),pair=store.pair(c.id,x.id),actor={host:'claude' as const,sessionId:'c',callId:'receive'};
  const ordinary=store.accept(pair,x,'普通排队','ordinary');store.claim(ordinary.id);store.transition(ordinary.id,'unknown');
  await broker.dispatch('observe',{actor,message_id:ordinary.id,state:'observed'});broker.claudeInbound.sweep(Date.now()+3600000);
  assert.equal(store.message(ordinary.id).state,'unknown');assert.equal(store.inboundApprovals().length,0);
  store.saveEndpoint({...store.endpoint(c.id)!,nativeInbound:{policy:'hold',dialogExpiry:'1s',observedAt:Date.now()}});
  const held=store.accept(pair,x,'显式保留','indefinite');store.claim(held.id);
  await broker.dispatch('observe',{actor,message_id:held.id,state:'observed',admission:'approval_required'});
  broker.claudeInbound.sweep(Date.now()+86400000);assert.equal(store.inboundApprovals()[0]!.approval.expiresAt,undefined);
  assert.equal(store.inboundApprovals()[0]!.approval.expiredUnconfirmed,undefined);
  await broker.dispatch('observe',{actor,message_id:held.id,state:'runtimeQueued'});assert.equal(store.inboundApprovals().length,0);assert.equal(store.message(held.id).state,'runtimeQueued');
  await assert.rejects(broker.dispatch('observe',{actor,message_id:store.accept(pair,c,'错误方向','wrong').id,state:'observed',admission:'approval_required'}),{code:'receipt_target'});
});

test('未知时长只报告观察超时；配对切换会取消旧窗口的待发提醒',async t=>{
  const {store,broker,c,x}=fixture(t),pair=store.pair(c.id,x.id);
  store.saveEndpoint({...store.endpoint(c.id)!,nativeInbound:{policy:'default',permission:'prompting',dialogExpiry:'undocumented',observedAt:Date.now()}});
  const message=store.accept(pair,x,'未知时长','duration');store.claim(message.id);
  await broker.dispatch('observe',{actor:{host:'claude',sessionId:'c',callId:'receive'},message_id:message.id,state:'observed',admission:'approval_required'});
  const approval=store.inboundApprovals()[0]!.approval;assert.equal(approval.durationVerified,false);
  broker.claudeInbound.sweep(approval.expiresAt!+1);assert.equal(store.message(message.id).state,'held');
  assert.ok(broker.deliveryHealth.peek(pair.id,x.id).some(n=>n.message.includes('configured duration unrecognized')));
  store.unpair(pair.id);broker.claudeInbound.sweep();assert.equal(store.inboundApprovals().length,0);
  assert.ok(!broker.deliveryHealth.peek(pair.id,x.id).some(n=>n.kind?.startsWith('inbound_')));
});

test('只有核验来源的原生终态回执才确认未送达，晚到的过期不能覆盖上下文证据',async t=>{
  const {store,broker,c,x,claude}=fixture(t),pair=store.pair(c.id,x.id),message=store.accept(pair,x,'原生已过期','native-expiry');store.claim(message.id);store.transition(message.id,'unknown');
  const receipt={orig_msg_id:message.id,from:peerAddress(store.endpoint(c.id)!.address),status:'expired',reason:'dialog expired'};
  claude.emit('receipt',{...receipt,from:'foreign'});assert.equal(store.message(message.id).state,'unknown');
  claude.emit('receipt',receipt);assert.equal(store.message(message.id).state,'expired');
  const notice=broker.deliveryHealth.peek(pair.id,x.id).find(n=>n.kind==='inbound_delivery_failed');assert.ok(notice);assert.match(notice.message,/native receipt confirmed/);
  claude.emit('receipt',receipt);assert.equal(broker.deliveryHealth.peek(pair.id,x.id).filter(n=>n.kind==='inbound_delivery_failed').length,1);
  await broker.dispatch('observe',{actor:{host:'claude',sessionId:'c',callId:'late-context'},message_id:message.id,state:'contextObserved'});
  claude.emit('receipt',receipt);assert.equal(store.message(message.id).state,'contextObserved');
  assert.ok(!broker.deliveryHealth.peek(pair.id,x.id).some(n=>n.kind==='inbound_delivery_failed'));
});

test('never 不推断截止时间；原生环境覆盖值优先于 never',async t=>{
  const {store,broker,c,x}=fixture(t),pair=store.pair(c.id,x.id),old=store.endpoint(c.id)!,actor={host:'claude' as const,sessionId:'c',callId:'receive'};
  for(const dialogTimeoutMs of [undefined,1500]){
    store.saveEndpoint({...old,nativeInbound:{policy:'default',permission:'prompting',dialogExpiry:'never',dialogTimeoutMs,observedAt:Date.now()}});
    const message=store.accept(pair,x,'原生期限规则','never-'+dialogTimeoutMs);store.claim(message.id);
    await broker.dispatch('observe',{actor,message_id:message.id,state:'observed',admission:'approval_required'});
    const approval=store.inboundApprovals().find(row=>row.message.id===message.id)!.approval;
    assert.equal(approval.expiresAt,dialogTimeoutMs===undefined?undefined:approval.receivedAt+dialogTimeoutMs);
    await broker.dispatch('observe',{actor,message_id:message.id,state:'contextObserved'});
  }
});
