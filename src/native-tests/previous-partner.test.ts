import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { DatabaseSync } from 'node:sqlite';
import { multiRuntimeFixture } from './multi-runtime-fixture.js';
import { ownedProcessState } from '../process/process-stop.js';
import { processIdentity } from '../process/process.js';
import { connectAppServer } from '../hosts/codex/adapter.js';
import {loadConfig} from '../config/load.js';
import { readCodexHistory } from '../hosts/codex/codex-history.js';

test('正式 CLI 兼容旧版无运行时副本凭据的 Codex 后台恢复，原会话与另一组配对保留',{timeout:180000},async t=>{
  const f=await multiRuntimeFixture(t,true),source=f.sources[0],target=f.targets[0],original=f.endpoints[0],cli=path.join(f.home,'bin','nxbridge.cjs');
  const command=(...args:string[])=>promisify(execFile)(process.execPath,[cli,...args],{cwd:f.root,env:process.env,windowsHide:true,timeout:90000,maxBuffer:4*1024*1024});
  await f.call('unpair',{pair_id:f.pairs[0].id});
  await f.wait(async()=>await ownedProcessState({pid:original.pid,startedAt:original.procStart})==='dead','主动解除后原后台未退出',30000);
  const db=new DatabaseSync(path.join(f.home,'nxbridge.db'),{readOnly:true});
  try{
    const row=db.prepare('SELECT value FROM settings WHERE key=?').get('managedLaunchProof:'+target.id);assert.ok(row,'原生回收必须保留实际启动来源');
    const proof=JSON.parse(row.value as string);assert.equal(proof.sessionId,target.sessionId);assert.equal(proof.runtimeId,original.runtimeId);assert.equal(proof.configHome,original.configHome);
  }finally{db.close();}
                                        
  const legacy=new DatabaseSync(path.join(f.home,'nxbridge.db'));
  try{legacy.prepare('DELETE FROM settings WHERE key=?').run('managedLaunchProof:'+target.id);}finally{legacy.close();}
  const listed=await command('pair');assert.ok(listed.stdout.includes('之前的后台搭档'),listed.stdout);assert.ok(listed.stdout.includes(target.id));
  await command('pair','--restore',f.pairs[0].id);
  assert.equal((await f.status()).pairs.find((pair:any)=>pair.claude===source.id)?.id,f.pairs[0].id,'显式恢复主动归档的配对无需丢失记录');
  const native=await processIdentity(process.pid),replacement=await f.call('register',{host:'codex',sessionId:'previous-partner-current',cwd:source.cwd,kind:'root',endpoint:{mode:'embedded',address:'',epoch:'replacement',pid:native.pid,procStart:native.startedAt}});
  await f.call('pair',{claude:source.id,codex:replacement.id,replace:true});
  await f.wait(async()=>{const value=await f.status();return value.peers.find((peer:any)=>peer.id===target.id)?.state==='offline'&&!value.capabilities.retirements.some((entry:any)=>entry.peerId===target.id);},'切换后的原后台仍在回收',30000);
  const restored=await command('pair','--claude',source.id,'--codex',target.sessionId,'--replace');assert.match(restored.stdout,/原来的会话/);
  const status=await f.status(),pair=status.pairs.find((value:any)=>value.claude===source.id),member=status.peers.find((value:any)=>value.id===target.id);
  assert.equal(pair.codex,target.id);assert.equal(member.sessionId,target.sessionId);assert.ok(status.pairs.some((value:any)=>value.id===f.pairs[1].id));
  const endpoint=status.endpoints.find((value:any)=>value.peerId===target.id&&value.active&&value.mode==='app-server');assert.ok(endpoint);
  assert.ok(endpoint.pid!==original.pid||endpoint.procStart!==original.procStart);
  const rpc=await connectAppServer(endpoint.address,loadConfig(f.home),undefined,f.home);
  try{
    const thread=await rpc.request('thread/read',{threadId:target.sessionId,includeTurns:true}),history=await readCodexHistory(thread.thread.path,target.sessionId),initial=status.messages.find((message:any)=>message.body==='MULTI_INITIAL_0');
    assert.equal(thread.thread.id,target.sessionId);assert.equal(history.receipts.filter(receipt=>receipt.messageId===initial.id).length,1);
  }finally{rpc.close();}
  await f.call('send',{actor:f.actor(source,'continued-previous'),message:'PREVIOUS_PARTNER_CONTINUED'});
  await f.wait(()=>f.requests.some(request=>JSON.stringify(request.input).includes('PREVIOUS_PARTNER_CONTINUED')),'接回后的原会话没有继续执行');
  assert.equal((await f.status()).messages.filter((message:any)=>message.body==='MULTI_INITIAL_0').length,1);
  t.diagnostic('隔离发布 CLI 通过列表、无丢失记录的 --restore、会话 ID + --replace 接回原后台；原历史只保留一次，另一组不受影响；模型请求均为本地夹具。');
});
