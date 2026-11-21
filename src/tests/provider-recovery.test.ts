import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './support/broker-fixture.js';
import { ProviderRecovery } from '../broker/recovery/provider-recovery.js';
import { noticeCanWake } from '../broker/health/notice-policy.js';

test('供应商重试后的失败跨实例保留，仅同作用域新模型输出生成一次提示，不重放消息',t=>{
  const f=fixture(t);let recovery=new ProviderRecovery(f.store);const event=(method:string,turnId:string,extra:any={})=>({method,params:{threadId:f.x.sessionId,turnId,...extra}});
  recovery.observe(f.x,'original',event('error','failed-turn',{willRetry:true,error:{message:'HTTP 503'}}));
  recovery.observe(f.x,'original',event('turn/completed','failed-turn',{turn:{id:'failed-turn',status:'failed'}}));
  recovery=new ProviderRecovery(f.store);const output=event('item/completed','new-turn',{item:{type:'agentMessage',text:'已恢复输出'}});
  assert.equal(recovery.observe(f.x,'other-provider',output),undefined);
  assert.equal(recovery.observe(f.x,'original',event('item/completed','new-turn',{item:{type:'commandExecution',status:'completed'}})),undefined);
  const notice=recovery.observe(f.x,'original',output)!;assert.match(notice.message,/failed-turn/);assert.equal(noticeCanWake(notice,f.c.id),false);assert.doesNotMatch(notice.message,/NEW authorized|continue|recovery command/i);
  assert.equal(recovery.observe(f.x,'original',output),undefined);assert.equal(new ProviderRecovery(f.store).observe(f.x,'original',output),undefined);assert.equal(f.store.messages().length,0);
});

test('原生自动重试自行成功不误报失败；其他会话和失败轮次的迟到输出都不宣告恢复',t=>{
  const f=fixture(t),recovery=new ProviderRecovery(f.store),event=(method:string,turn:string,extra:any={})=>({method,params:{turnId:turn,...extra}});
  recovery.observe(f.x,'scope',event('error','retry',{willRetry:true}));assert.equal(recovery.observe(f.x,'scope',event('item/completed','retry',{item:{type:'agentMessage',text:'成功'}})),undefined);
  recovery.observe(f.x,'scope',event('turn/completed','retry',{turn:{id:'retry',status:'failed'}}));
  assert.equal(recovery.observe(f.x,'scope',event('item/completed','retry',{item:{type:'agentMessage',text:'迟到输出'}})),undefined);
  assert.equal(recovery.observe({...f.x,sessionId:'different'},'scope',event('item/completed','next',{item:{type:'agentMessage',text:'新会话'}})),undefined);
});
