import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { multiRuntimeFixture } from './multi-runtime-fixture.js';
import { connectAppServer } from '../hosts/codex/adapter.js';
import {loadConfig} from '../config/load.js';
import { ownedProcessState } from '../process/process-stop.js';
import { readCodexHistory } from '../hosts/codex/codex-history.js';

const execute=promisify(execFile);

test('发布入口恢复被关闭归档的托管搭档：原配对和原会话历史保留，另一组不受影响',{timeout:180000},async t=>{
  t.diagnostic('阶段：建立两组隔离的真实托管会话');
  const f=await multiRuntimeFixture(t,true),pair=f.pairs[0],target=f.targets[0],original=f.endpoints.map(endpoint=>({pid:endpoint.pid,startedAt:endpoint.procStart}));
  t.diagnostic('阶段：关闭隔离 broker 并归档配对');
  await f.call('shutdown',{releaseOwned:true,reason:'external_release',requester:{pid:process.pid,command:'隔离事故回归'}});
  t.diagnostic('阶段：shutdown 返回完成');
  await f.wait(async()=>{const states=await Promise.all(original.map(identity=>ownedProcessState(identity)));return states.every(state=>state==='dead');},'原托管运行时没有退出',30000);
  t.diagnostic('阶段：原托管运行时均已退出，读取恢复事实');
  const lost=await f.status();assert.equal(lost.pairs.length,0);
  t.diagnostic('阶段：发布 CLI 显式恢复原配对');
  const fact=lost.lostPairs.find((value:any)=>value.member_id===f.sources[0].id);
  assert.equal(fact.pair_id,pair.id);assert.equal(fact.restore_state,'resumable');assert.equal(fact.reason,'external_release');
  const {stdout}=await execute(process.execPath,[path.join(f.home,'bin','nxbridge.cjs'),'pair','--restore',pair.id],{cwd:f.root,env:process.env,windowsHide:true,timeout:90000,maxBuffer:4*1024*1024});
  assert.ok(stdout.includes(pair.id));assert.match(stdout,/已恢复原配对/);
  const restored=await f.status(),current=restored.pairs.find((value:any)=>value.id===pair.id),member=restored.peers.find((value:any)=>value.id===target.id);
  assert.equal(current.codex,target.id);assert.equal(current.claude,f.sources[0].id);assert.equal(member.sessionId,target.sessionId);
  assert.equal(restored.pairs.length,1);assert.equal(restored.lostPairs.some((value:any)=>value.pair_id===pair.id),false);
  assert.ok(restored.lostPairs.some((value:any)=>value.pair_id===f.pairs[1].id),'未选择的另一组仍保留原事故事实');
  const endpoint=restored.endpoints.find((value:any)=>value.peerId===target.id&&value.active&&value.mode==='app-server');
  assert.ok(endpoint);assert.ok(endpoint.pid!==original[0]!.pid||endpoint.procStart!==original[0]!.startedAt);
  const rpc=await connectAppServer(endpoint.address,loadConfig(f.home),undefined,f.home);
  try{
    const history=await rpc.request('thread/read',{threadId:target.sessionId,includeTurns:true});
    assert.equal(history.thread.id,target.sessionId);const initial=restored.messages.find((message:any)=>message.body==='MULTI_INITIAL_0');assert.ok(initial);
    const evidence=await readCodexHistory(history.thread.path,target.sessionId);assert.equal(evidence.status,'supported');assert.equal(evidence.receipts.filter(receipt=>receipt.messageId===initial.id).length,1,'原会话的持久工具记录必须保留');
    await f.call('send',{actor:f.actor(f.sources[0],'after-explicit-restore'),message:'RESTORE_CONTINUATION'});
    await f.wait(()=>f.requests.some(request=>JSON.stringify(request.input).includes('RESTORE_CONTINUATION')),'恢复后没有在原会话继续');
    const finished=await f.status();assert.equal(finished.messages.filter((message:any)=>message.body==='RESTORE_CONTINUATION').length,1);
    assert.equal(finished.messages.filter((message:any)=>message.body==='MULTI_INITIAL_0').length,1);
  }finally{rpc.close();}
  t.diagnostic('真实发布 CLI 完成归档、原成员/原配对恢复和原线程继续；原生会话未替换；全部模型请求仅到本地夹具。');
});
