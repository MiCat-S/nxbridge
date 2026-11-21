import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { writeFileSync } from 'node:fs';
import { McpHook } from '../integration/hooks/mcp-hook.js';
import { codexHookContext } from '../hosts/codex/codex-hook-context.js';
import { temporary } from './support/temporary.js';

test('MCP hook 每次核验当前 rollout，fork 独立且子代理不继承根身份',async t=>{
  const transcript=path.join(temporary(t),'rollout.jsonl'),input={session_id:'thread',hook_event_name:'PostToolUse',transcript_path:transcript};
  for(const extra of [{},{forked_from_id:'parent'},{parent_thread_id:'parent'},{source:{subagent:{thread_spawn:{parent_thread_id:'parent'}}}}]){
    writeFileSync(transcript,JSON.stringify({type:'session_meta',payload:{id:'thread',...extra}})+'\n','utf8');
    const result=await codexHookContext(input,'thread',false);
    assert.equal(result.agent_id,'parent_thread_id'in extra||'source'in extra?'thread':undefined);
  }
  writeFileSync(transcript,JSON.stringify({type:'session_meta',payload:{id:'foreign'}})+'\n','utf8');
  await assert.rejects(codexHookContext(input,'thread',true),{code:'unverified_identity'});
  await assert.rejects(codexHookContext({...input,transcript_path:null},'thread',false),{code:'unverified_identity'});
  assert.equal((await codexHookContext({...input,transcript_path:null},'thread',true)).agent_id,undefined);
  writeFileSync(transcript,JSON.stringify({type:'session_meta',payload:{id:'child',parent_thread_id:'thread',source:{subagent:{thread_spawn:{parent_thread_id:'thread'}}}}})+'\n','utf8');
  assert.equal((await codexHookContext(input,'child',false)).agent_id,'child','原生子代理事件的 session_id 保留根线程');
  writeFileSync(transcript,JSON.stringify({type:'session_meta',payload:{id:'child'}})+'\n','utf8');
  await assert.rejects(codexHookContext(input,'child',false),{code:'unverified_identity'});
});

test('MCP hook 截止覆盖连接，迟到连接不提交；故障后不重复等待或重放',async t=>{
  let release!:()=>void,calls=0;
  const connection={connect:()=>new Promise<void>(resolve=>{release=resolve;}),request:async()=>{calls++;return{output:{}};}};
  const hook=new McpHook(connection as any,25),receipts=new Map<string|number,string>(),input={session_id:'root',hook_event_name:'PostToolUse'};t.after(()=>hook.close());
  await assert.rejects(hook.run({...input,hook_event_name:'UserPromptSubmit'},{threadId:'root'},1,receipts),{code:'unverified_identity'});
  await assert.rejects(hook.run(input,{threadId:'root'},1,receipts),{code:'timeout'});
  release();await new Promise(resolve=>setImmediate(resolve));assert.equal(calls,0);
  await assert.rejects(hook.run(input,{threadId:'root'},2,receipts),{code:'hook_unavailable'});assert.equal(calls,0);
});

test('MCP hook 提交后断连不重放，正常响应的回执独立确认',async t=>{
  const calls:{method:string;params:any}[]=[];let broken=false;
  const connection={connect:async()=>{},request:async(method:string,params:any)=>{calls.push({method,params});if(broken)throw Object.assign(Error('断连'),{code:'disconnected'});return{output:{ok:true},receipt:'receipt'};}};
  const hook=new McpHook(connection as any),receipts=new Map<string|number,string>();t.after(()=>hook.close());
  assert.deepEqual(await hook.run({session_id:'root',hook_event_name:'PostToolUse'},{threadId:'root'},1,receipts),{ok:true});
  assert.equal(receipts.get(1),'receipt');assert.equal(calls.length,1);assert.equal(calls[0]!.method,'hook.client.mcp');
  hook.acknowledge('receipt');await new Promise(resolve=>setImmediate(resolve));assert.equal(calls[1]!.method,'hook.client.ack');
  broken=true;await assert.rejects(hook.run({session_id:'root',hook_event_name:'PostToolUse'},{threadId:'root'},2,receipts),{code:'disconnected'});
  await assert.rejects(hook.run({session_id:'root',hook_event_name:'PostToolUse'},{threadId:'root'},3,receipts),{code:'hook_unavailable'});assert.equal(calls.length,3);
});

test('MCP hook 后台探测协调器恢复，只提交新的调用',async t=>{
  let online=false,submissions=0,pings=0;
  const connection={connect:async()=>{if(!online)throw Object.assign(Error('协调器离线'),{code:'ECONNREFUSED'});},request:async(method:string)=>{if(method==='ping'){pings++;return{};}submissions++;return{output:{ok:true}};}};
  const hook=new McpHook(connection as any),receipts=new Map<string|number,string>(),input={session_id:'root',hook_event_name:'PostToolUse'};t.after(()=>hook.close());
  await assert.rejects(hook.run(input,{threadId:'root'},1,receipts),{code:'ECONNREFUSED'});
  online=true;
  await assert.rejects(hook.run(input,{threadId:'root'},2,receipts),{code:'hook_unavailable'});
  await new Promise(resolve=>setTimeout(resolve,5200));
  assert.equal(pings,1);assert.equal(submissions,0);
  assert.deepEqual(await hook.run(input,{threadId:'root'},3,receipts),{ok:true});assert.equal(submissions,1);
});
