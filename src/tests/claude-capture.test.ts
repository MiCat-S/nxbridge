import { copyNodeBinary } from './support/node-binary.js';
import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs, { mkdirSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { ChildProcess, spawn } from 'node:child_process';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { ClaudeAdapter } from '../hosts/claude/adapter.js';
import { bindNativeLaunch, captureNativeProcess, forgetNativeOwnership, nativeOwnership, saveNativeOwnership, type NativeOwnership } from '../process/owned-native.js';
import { rememberOwnedChild, releaseOwnedProcess, recordOwnedProcess, type OwnedProcessRecord } from '../process/owned-processes.js';
import { saveClaudeBackground } from '../hosts/claude/claude-capability.js';
import {DEFAULT_CONFIG} from '../config/defaults.js';
import { Store } from '../storage/store.js';
import { temporaryDirectory } from './support/temporary.js';

async function fixture(t:TestContext){
  const temp=temporaryDirectory(),home=temp.directory,store=new Store(':memory:'),peer=store.placeholder('claude',home),sessionId=randomUUID(),executable=path.join(home,process.platform==='win32'?'claude.exe':'claude');
  let child:ChildProcess|undefined,processProof:OwnedProcessRecord|undefined,adapter:ClaudeAdapter|undefined;
  t.after(async()=>{
    adapter?.close();
    try{const current=nativeOwnership(home,peer.id);if(current)forgetNativeOwnership(current);}
    finally{
      try{if(processProof)await releaseOwnedProcess(processProof);else if(child?.pid&&child.exitCode===null&&child.signalCode===null){const closed=once(child,'exit');child.kill();await closed;}}
      finally{store.close();await temp.cleanup();}
    }
  });
  copyNodeBinary(executable);
  child=spawn(executable,['-e',"process.title='claude';process.send('ready');process.disconnect();setInterval(()=>{},1000)"],{stdio:['ignore','ignore','ignore','ipc'],windowsHide:true});await once(child,'message');
  processProof=await rememberOwnedChild(home,child,'claude-native',{peerId:peer.id,sessionId,configHome:home});assert.ok(processProof);
  const identity=processProof.identity,record={sessionId,cwd:home,procStart:identity.procStartFt??identity.procStart??identity.startedAt,messagingSocketPath:'native-inbox'};
  mkdirSync(path.join(home,'sessions'));const file=path.join(home,'sessions',identity.pid+'.json');writeFileSync(file,JSON.stringify(record),'utf8');
  const proof:NativeOwnership={version:1,id:randomUUID(),home,peerId:peer.id,configHome:home,phase:'bound',createdAt:Date.now(),sessionId,handle:'abc00001',native:{pid:identity.pid,startedAt:identity.startedAt}};
  saveNativeOwnership(proof);
  adapter=new ClaudeAdapter({...DEFAULT_CONFIG,claudeBinary:executable,claudeHome:home},home);const agent={id:proof.handle,sessionId,pid:identity.pid,kind:'background',status:'idle'};
  adapter.list=async()=>[agent];
  return{home,peer,record,file,proof,identity,agent,adapter};
}

function identityQueries(t:TestContext,pid:number){
  const prototype=ChildProcess.prototype as unknown as {spawn:(options:any)=>unknown},original=prototype.spawn,count={value:0};
  t.mock.method(prototype,'spawn',function(this:ChildProcess,options:any){
    if(options.args?.[1]==='ancestors'&&options.args[2]===String(pid)&&options.args[3]==='1')count.value++;
    return Reflect.apply(original,this,[options]);
  });
  return count;
}

test('Claude 暂未发布 PID 但原控制器仍存活时不重复恢复、不替换启动归属',async t=>{
  const f=await fixture(t),proof={...f.proof,native:{pid:2147483647,startedAt:'已退出的原生子进程'}};
  saveNativeOwnership(proof);saveClaudeBackground(f.home,(f.adapter as any).config,{available:true,checkedAt:Date.now()});
  await recordOwnedProcess(f.home,{role:'claude-native',identity:f.identity,peerId:f.peer.id,sessionId:f.record.sessionId,configHome:f.home,proof:{kind:'native-session',launchId:proof.id}});
  f.adapter.list=async()=>[{...f.agent,pid:undefined}];let submissions=0;
  await assert.rejects(f.adapter.wake({...f.peer,owner:'nxbridge',sessionId:f.record.sessionId},undefined,undefined,()=>{submissions++;}),{code:'claude_start_pending'});
  assert.equal(submissions,0);assert.deepEqual(nativeOwnership(f.home,f.peer.id),proof);
  const waiting=(f.adapter as any).nativeRestartWaits.get(f.peer.id);waiting.at-=60000;
  await assert.rejects(f.adapter.wake({...f.peer,owner:'nxbridge',sessionId:f.record.sessionId},undefined,undefined,()=>{submissions++;}),{code:'claude_native_recovery_waiting'});
  assert.equal(submissions,0);assert.deepEqual(nativeOwnership(f.home,f.peer.id),proof);
});

test('旧启动回执没有 supervisor 字段时也等待同一 handle，不重新恢复出副本',async t=>{
  const f=await fixture(t),proof={...f.proof,native:{pid:2147483647,startedAt:'已退出'}};saveNativeOwnership(proof);
  saveClaudeBackground(f.home,(f.adapter as any).config,{available:true,checkedAt:Date.now()});f.adapter.list=async()=>[{...f.agent,pid:undefined,state:'working'}];
  await assert.rejects(f.adapter.wake({...f.peer,owner:'nxbridge',sessionId:f.record.sessionId}),{code:'claude_start_pending'});
  (f.adapter as any).nativeRestartWaits.get(f.peer.id).at-=60000;
  await assert.rejects(f.adapter.wake({...f.peer,owner:'nxbridge',sessionId:f.record.sessionId}),{code:'claude_native_recovery_waiting'});
  assert.deepEqual(nativeOwnership(f.home,f.peer.id),proof);
});

test('原生 PID 先于后台列表到达时，不缓存瞬时缺失阻塞后续身份核验',async t=>{
  const f=await fixture(t),input={host:'claude' as const,sessionId:f.record.sessionId,cwd:f.home,kind:'root' as const,endpoint:{mode:'claude-inbox' as const,address:'native-inbox',epoch:'test',pid:f.identity.pid,procStart:f.identity.startedAt}};
  let queries=0;f.adapter.list=async()=>++queries===1?[]:[f.agent];
  assert.equal(await f.adapter.corroborateRegistration(input,f.proof),undefined);
  assert.equal((await f.adapter.corroborateRegistration(input,f.proof))?.native?.pid,f.identity.pid);assert.equal(queries,2);
});

test('托管 Claude 发现与人工副本登记复用同次原生核验，端点来自实际会话',async t=>{
  const f=await fixture(t),queries=identityQueries(t,f.identity.pid);
  for(const registration of [await f.adapter.discover(f.record.sessionId),await f.adapter.manualCopyRegistration({...f.peer,sessionId:f.record.sessionId})]){
    assert.equal(registration?.sessionId,f.record.sessionId);assert.equal(registration?.endpoint.pid,f.identity.pid);assert.equal(registration?.endpoint.procStart,f.identity.startedAt);assert.equal(registration?.endpoint.address,f.record.messagingSocketPath);
  }
  if(process.platform==='win32')assert.equal(queries.value,2,'两个入口各自只查询一次实际原生身份');
});

test('被动登记只接受同一原生 PID 和代次，不借用旧 hook 的身份',async t=>{
  const f=await fixture(t),queries=identityQueries(t,f.identity.pid),input={host:'claude' as const,sessionId:f.record.sessionId,cwd:f.home,name:'后台',kind:'root' as const,endpoint:{mode:'claude-inbox' as const,address:'native-inbox',epoch:'test',pid:f.identity.pid,procStart:f.identity.startedAt}};
  assert.equal(await f.adapter.corroborateRegistration({...input,endpoint:{...input.endpoint,pid:f.identity.pid+1}},f.proof),undefined);
  assert.equal(await f.adapter.corroborateRegistration({...input,endpoint:{...input.endpoint,procStart:'old-generation'}},f.proof),undefined);
  assert.equal((await f.adapter.corroborateRegistration(input,f.proof))?.native?.startedAt,f.identity.startedAt);
  if(process.platform==='win32')assert.equal(queries.value,2,'PID 不符不查询；每次同 PID 登记仅查询一次代次');
});

for(const operation of ['bind','capture'] as const)test('原生列表等待期间已交给用户的同次启动，旧参数不能重新认领：'+operation,async t=>{
  const f=await fixture(t),stale={...f.proof,...(operation==='bind'?{phase:'intent' as const}:{})},released={...stale,releasedToUser:true};
  saveNativeOwnership(released);
  await assert.rejects((operation==='bind'?bindNativeLaunch:captureNativeProcess)(stale,f.agent),{code:operation==='bind'?'process_record_changed':'claude_launch_unverified'});
  assert.deepEqual(nativeOwnership(f.home,f.peer.id),released);
});

for(const changed of ['session','generation','launch','handoff'] as const)test('PTY 核验等待期间事实改变时不返回旧证据或覆盖归属：'+changed,async t=>{
  const f=await fixture(t),read=fs.readFileSync,successor=randomUUID();let observed=false,reads=0;
  t.mock.method(fs,'readFileSync',((file:Parameters<typeof fs.readFileSync>[0],...args:any[])=>{
    if(file===f.file&&++reads===2){
      if(changed==='session'||changed==='generation')writeFileSync(f.file,JSON.stringify({...f.record,...(changed==='session'?{sessionId:randomUUID()}:{procStart:'new-generation'})}),'utf8');
      else saveNativeOwnership({...f.proof,...(changed==='launch'?{id:successor}:{releasedToUser:true})});
    }
    return Reflect.apply(read,fs,[file,...args]);
  }) as typeof fs.readFileSync);syncBuiltinESMExports();
  try{
    await assert.rejects(captureNativeProcess(f.proof,f.agent,()=>{observed=true;}),{code:changed==='session'||changed==='generation'?'claude_launch_unverified':'process_record_changed'});
    assert.equal(observed,false);
    if(changed==='launch')assert.equal(nativeOwnership(f.home,f.peer.id)?.id,successor);
    if(changed==='handoff')assert.equal(nativeOwnership(f.home,f.peer.id)?.releasedToUser,true);
  }finally{t.mock.restoreAll();syncBuiltinESMExports();}
});
