import test from 'node:test';
import assert from 'node:assert/strict';
import { ResourceHealth, resourceEvidence, resourceSummary, type ResourceSample } from '../broker/health/resource-health.js';
import { fixture } from './support/broker-fixture.js';

test('只在超时或无法核验时按需采样；并发合并，不产生独立资源告警',async t=>{
  t.mock.timers.enable({apis:['Date'],now:1000000});
  let calls=0,release!:()=>void;const blocked=new Promise<void>(resolve=>release=resolve),GiB=1024**3;
  const sample:ResourceSample={checkedAt:Date.now(),cpuPercent:99,cpuWindowMs:120,memoryFreeBytes:100*1024**2,memoryTotalBytes:64*GiB,diskFreeBytes:100*1024**2,diskTotalBytes:100*GiB,brokerLagMs:150,io:{systemAvailable:false,metadataMs:2},unavailable:['fixture']};
  const resources=new ResourceHealth(async()=>{calls++;await blocked;return sample;}),f=fixture(t,{},resources),pair=f.store.pair(f.c.id,f.x.id);
  assert.equal(calls,0);assert.equal(resources.snapshot().state,'unavailable');
  f.broker.pairAnomalies.integration(f.x,{hookError:'hook timed out after 10s'});
  const result=resources.request('runtime_unverified');assert.equal(calls,1);assert.equal(resources.snapshot().pending,true);release();await result;
  assert.equal(resources.snapshot().state,'fresh');assert.match(resourceEvidence(resources.snapshot().sample),/cpu ~99% \(120 ms sample\)/);assert.match(resourceSummary(sample),/120 ms 采样.*文件访问延迟/);
  assert.deepEqual(f.broker.deliveryHealth.take(pair.id,f.c.id),[],'资源再低也不是独立事件');
  await resources.request('runtime_unverified');assert.equal(calls,1,'短期并发故障复用同一带时间戳证据');
  t.mock.timers.tick(90001);assert.equal(resources.snapshot().state,'stale');assert.equal(resourceEvidence(resources.snapshot().sample),'');
});

test('采样不可用不虚构高负载，持久超时告警不能被资源结果降级',async t=>{
  t.mock.timers.enable({apis:['Date'],now:1000000});
  const resources=new ResourceHealth(async()=>({checkedAt:Date.now(),io:{systemAvailable:false},unavailable:['fixture']})),f=fixture(t,{},resources),pair=f.store.pair(f.c.id,f.x.id);
  for(let i=0;i<3;i++)f.broker.pairAnomalies.integration(f.x,{hookError:'hook timed out after 10s'});
  t.mock.timers.tick(60000);
  await resources.request('hook_timeout');f.broker.pairAnomalies.observe(pair,f.x);assert.equal(f.broker.pairAnomalies.issues(f.x.id)[0]!.kind,'hooks_timeout');
  assert.doesNotMatch(f.broker.pairAnomalies.issues(f.x.id)[0]!.message,/evidence:|cpu ~|ram free/);assert.deepEqual(f.broker.deliveryHealth.take(pair.id,f.c.id),[],'hook 超时只进入状态栏');
});
