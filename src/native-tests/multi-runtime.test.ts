import test from 'node:test';
import assert from 'node:assert/strict';
import { processIdentity } from '../process/process.js';
import { multiRuntimeFixture } from './multi-runtime-fixture.js';

test('两个实际独立 App Server：重启和解绑 A 不影响忙碌且有待答问题的 B',{timeout:170000},async t=>{
  const f=await multiRuntimeFixture(t),before=await processIdentity(f.endpoints[1].pid);await f.busy(1);const q=await f.question(1);
  const result=await f.call('codex.restart',{pair_id:f.pairs[0].id});assert.ok(result);
  let s=await f.status();assert.equal(s.peers.find((p:any)=>p.id===f.targets[0].id).sessionId,f.targets[0].sessionId);assert.equal((await processIdentity(before.pid)).startedAt,before.startedAt);assert.equal(s.peers.find((p:any)=>p.id===f.targets[1].id).state,'busy');assert.equal(s.questions.find((v:any)=>v.id===q.request_id).status,'pending');
  await f.call('unpair',{pair_id:f.pairs[0].id});s=await f.status();assert.equal(s.pairs.length,1);assert.equal(s.pairs[0].id,f.pairs[1].id);assert.equal((await processIdentity(before.pid)).startedAt,before.startedAt);assert.equal(s.questions.find((v:any)=>v.id===q.request_id).expiresAt,Date.parse(q.expires_at));
  f.release(1);await f.wait(async()=>(await f.status()).peers.find((p:any)=>p.id===f.targets[1].id).state==='ready','B 原生轮次未继续完成');
  await f.call('question.answer',{actor:f.actor(f.sources[1],'answer-b'),input:{request_id:q.request_id,answers:{'选择第 1 组？':'甲'},rationale:'B 在 A 重启解绑后仍可回答'}});assert.equal((await f.status()).questions.find((v:any)=>v.id===q.request_id).status,'answered');assert.equal(f.errors.length,0);
  t.diagnostic(JSON.stringify({pairs:f.pairs.map(p=>p.id),runtimes:f.endpoints.map(e=>({pid:e.pid,address:e.address})),realModelCalls:0}));
});
