import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fixture } from './support/broker-fixture.js';
import { temporary } from './support/temporary.js';
import {codexHome} from '../shared/local-paths.js';
import { MOD_REVISION } from '../mod-revision.js';

test('原生集成故障在普通及 Mod 状态提供用户会话、非默认配置目录和启动重试信息',async t=>{
  const f=fixture(t),home=temporary(t);f.store.pair(f.c.id,f.x.id);
  f.store.saveEndpoint({...f.store.endpoint(f.x.id)!,configHome:home});
  const binding=f.store.bindings.activate({host:'claude',configHome:path.resolve('/guidance-status'),pid:101,procStart:'native'},f.c.id,'c','verified');
  const endpoint={...f.store.endpoint(f.c.id)!,pid:binding.pid,procStart:binding.procStart,modRevision:MOD_REVISION};f.store.saveEndpoint(endpoint);
  const actor={host:'claude' as const,sessionId:'c',callId:'guidance',binding:{key:binding.key,epoch:binding.epoch}},receipt={sessionId:'c',native:{pid:binding.pid,procStart:binding.procStart},revision:MOD_REVISION};
  f.store.setSetting('pairIssues:'+f.x.id,{issues:['hooks_restart_required','contract_inactive','hooks_trust_required','launch_failed'].map(kind=>({kind,message:kind==='launch_failed'?'后台启动失败：原入口不存在':kind}))});
  const scoped:any=f.broker.status(actor),all:any=f.broker.status(),fast:any=await(f.broker as any).modRead(actor,'status',receipt,endpoint.epoch);
  for(const issues of [scoped.integrationIssues,all.capabilities.integrationIssues,fast.integrationIssues]){
    for(const code of ['hooks_restart_required','contract_inactive']){const issue=issues.find((row:any)=>row.peerId===f.x.id&&row.code===code);assert.equal(issue.owner,'user');assert.equal(issue.session_id,'x');assert.equal(issue.name,f.x.name);}
    assert.equal(issues.find((row:any)=>row.peerId===f.x.id&&row.code==='hooks_trust_required').config_home,home);
    const launch=issues.find((row:any)=>row.peerId===f.x.id&&row.code==='launch_failed');assert.match(launch.message,/原入口不存在/);assert.equal(launch.retry_command,`nxbridge open codex --member ${f.x.id}`);
  }
  f.store.saveEndpoint({...f.store.endpoint(f.x.id)!,configHome:codexHome()});
  assert.equal(Object.hasOwn((f.broker.status(actor) as any).integrationIssues.find((row:any)=>row.code==='hooks_trust_required'),'config_home'),false);
  f.store.saveEndpoint({...f.store.endpoint(f.x.id)!,epoch:'another-window',configHome:home});
  const ambiguous=(f.broker as any).runtimeHealth.integrationIssues(f.x.id);assert.equal(ambiguous.find((row:any)=>row.code==='hooks_restart_required').session_id,'x');assert.equal(Object.hasOwn(ambiguous.find((row:any)=>row.code==='hooks_trust_required'),'config_home'),false);
});

test('仅独立托管 Codex 的失效回复契约被动通知 Claude，恢复后撤回且不唤醒',t=>{
  t.mock.timers.enable({apis:['Date'],now:1000000});
  for(const mode of ['owned','user','daemon'] as const){
    const f=fixture(t),pair=f.store.pair(f.c.id,f.x.id);f.store.updatePeer(f.x.id,{owner:mode==='user'?'user':'nxbridge'});
    if(mode==='daemon')f.store.saveEndpoint({...f.store.endpoint(f.x.id)!,daemon:{address:'daemon',rootSessionId:'x'}});
    f.store.setSetting('replyContract:'+f.x.id,null);f.broker.pairAnomalies.integration(f.store.peer(f.x.id),{hookSeen:true});t.mock.timers.tick(120001);
    const detect=()=>f.broker.pairAnomalies.observe(pair,f.store.peer(f.x.id));detect();
    const notices=f.broker.deliveryHealth.peek(pair.id,f.c.id).filter(notice=>notice.kind?.endsWith(':contract_inactive'));
    assert.equal(notices.length,mode==='owned'?1:0,mode);
    if(mode==='owned'){assert.equal(notices[0]!.tier,3);assert.equal(notices[0]!.wake,false);assert.match(notices[0]!.message,/'restart' 'codex' '--partner'/);detect();assert.equal(f.broker.deliveryHealth.peek(pair.id,f.c.id).filter(notice=>notice.kind?.endsWith(':contract_inactive')).length,1);}
    f.store.adoptReplyContract(f.x.id,'mcp');detect();assert.equal(f.broker.deliveryHealth.peek(pair.id,f.c.id).some(notice=>notice.kind?.endsWith(':contract_inactive')),false);
    assert.equal(f.codex.woken.length+f.claude.woken.length,0);
  }
});

test('暂停原因只取已记录证据，离开暂停或切换会话后清除',async t=>{
  const f=fixture(t);f.store.pair(f.c.id,f.x.id);f.store.updatePeer(f.x.id,{owner:'nxbridge'});
  const partner=()=>(f.broker.status({host:'claude',sessionId:'c',callId:'pause'}) as any).partner;
  f.store.updatePeer(f.x.id,{state:'paused'});assert.equal(partner().owner,'nxbridge');assert.equal(partner().pause_reason,undefined);
  await f.broker.dispatch('hook',{session_id:'x',hook_event_name:'Interrupt'});assert.equal(partner().pause_reason,'interrupted');
  f.store.updatePeer(f.x.id,{state:'ready'});assert.equal(partner().pause_reason,undefined);assert.equal(f.store.peer(f.x.id).pauseReason,undefined);
  f.store.updatePeer(f.x.id,{state:'paused',pauseReason:'restart_incomplete'});assert.equal(partner().pause_reason,'restart_incomplete');
  f.store.updatePeer(f.x.id,{sessionId:'different-session'});assert.equal(f.store.peer(f.x.id).pauseReason,undefined);
});
