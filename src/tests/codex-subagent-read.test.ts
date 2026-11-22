import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { captureCodexSubagentReadFloor, readCodexSubagentCompletions, type CodexSubagentReadCandidate } from '../hosts/codex/codex-subagent-read.js';
import { temporary } from './support/temporary.js';

const sessionId='parent-session',parentTurn='parent-turn',agentId='child-session',agentPath='/root/child';
const meta={type:'session_meta',payload:{id:sessionId}};
const event=(type:string,turn_id=parentTurn)=>({type:'event_msg',payload:{type,turn_id}});
const v1=(reference=agentId)=>({type:'response_item',payload:{type:'message',role:'user',content:[{type:'input_text',text:`<subagent_notification>\n${JSON.stringify({agent_path:reference,status:{completed:'子代理结果'}})}\n</subagent_notification>`}],internal_chat_message_metadata_passthrough:{content_item_kinds:['multi_agent.subagent_notification']}}});
const v2Meta={type:'inter_agent_communication_metadata',payload:{trigger_turn:false}};
const v2=(history_sequence:number)=>({type:'response_item',metadata:{history_sequence},payload:{type:'agent_message',author:agentPath,recipient:'/root',content:[{type:'input_text',text:`Message Type: FINAL_ANSWER\nTask name: /root\nSender: ${agentPath}\nPayload:\n子代理结果`}]}});
const output=(sampled_through_sequence?:number)=>({type:'response_item',metadata:{sampled_through_sequence},payload:{type:'message',role:'assistant',content:[{type:'output_text',text:'父会话输出'}]}});

function fixture(t:TestContext){
  const directory=temporary(t),file=path.join(directory,'parent.jsonl');
  writeFileSync(file,'','utf8');
  const append=(...rows:unknown[])=>appendFileSync(file,rows.map(row=>JSON.stringify(row)+'\n').join(''),'utf8');
  append(meta,event('task_started'));
  const completion=(childTurnId='child-turn',withPath=false):CodexSubagentReadCandidate=>{
    const floor=captureCodexSubagentReadFloor(file,sessionId);
    assert.ok(floor);
    return{key:childTurnId,agentId,childTurnId,floor,...(withPath?{agentPath}:{})};
  };
  const read=(...pending:CodexSubagentReadCandidate[])=>[...readCodexSubagentCompletions(file,sessionId,parentTurn,pending)];
  return{file,append,completion,read};
}

test('V1 只确认本轮原生匹配结果之后的父会话输出',t=>{
  const f=fixture(t),pending=f.completion();
  f.append(output(),v1('other-child'),output(),v1());
  assert.deepEqual(f.read(pending),[]);
  f.append(output());
  assert.deepEqual(f.read(pending),[pending.key]);
  assert.deepEqual([...readCodexSubagentCompletions(f.file,sessionId,'other-turn',[pending])],[]);
  f.append(event('task_complete'));
  assert.deepEqual(f.read(pending),[]);
});

test('父线程空闲期间的结果在下一轮模型输出后得到确认，回滚则撤销证明',t=>{
  const f=fixture(t),pending=f.completion();
  f.append(event('task_complete'),v1());
  assert.deepEqual(f.read(pending),[]);
  f.append(event('task_started'),output());
  assert.deepEqual(f.read(pending),[pending.key]);
  f.append(event('thread_rolled_back'),event('task_started'),output());
  assert.deepEqual(f.read(pending),[]);
});

test('V2 使用采样边界区分旧请求输出和结果进入上下文后的输出',t=>{
  const f=fixture(t),pending=f.completion('child-turn',true);
  f.append(v2(91),output(91));
  assert.deepEqual(f.read(pending),[]);
  f.append(v2Meta,v2(94),output(93),event('token_count'));
  assert.deepEqual(f.read(pending),[]);
  f.append(output(94));
  assert.deepEqual(f.read(pending),[pending.key]);
});

test('父会话最后一步之后的子代理结果，以及同一子代理先前轮次的结果均不确认',t=>{
  const f=fixture(t),first=f.completion();
  f.append(v1(),output());
  assert.deepEqual(f.read(first),[first.key]);
  const later=f.completion('child-followup');
  assert.deepEqual(f.read(later),[]);
  f.append(v1(),event('token_count'));
  assert.deepEqual(f.read(later),[]);
  f.append(output());
  assert.deepEqual(f.read(later),[later.key]);
  assert.deepEqual(f.read(first,later),[]);
});

test('同名非原生通知、重复原生通知和压缩输出不能证明模型读取',t=>{
  const f=fixture(t),pending=f.completion();
  const plain=v1();
  f.append({...plain,payload:{...plain.payload,internal_chat_message_metadata_passthrough:undefined}},output());
  assert.deepEqual(f.read(pending),[]);
  f.append(v1(),{...output(),metadata:{compaction_output:true}});
  assert.deepEqual(f.read(pending),[]);
  f.append(v1(),output());
  assert.deepEqual(f.read(pending),[]);
});

test('损坏、轮换或超过读取上限的父会话历史保留待确认项',t=>{
  const f=fixture(t),pending=f.completion();
  assert.equal(captureCodexSubagentReadFloor(f.file,'unverified-session'),undefined);
  f.append(v1(),output(),{type:'response_item',payload:{text:'a'.repeat(1024*1024)}});
  assert.deepEqual(f.read(pending),[]);
  renameSync(f.file,f.file+'.old');
  f.append(meta,event('task_started'));
  const rotated=f.completion();
  f.append(v1(),output());
  assert.deepEqual(f.read(pending),[]);
  assert.deepEqual(f.read(rotated),[rotated.key]);
  appendFileSync(f.file,'{无效记录}\n','utf8');
  assert.deepEqual(f.read(rotated),[]);
});
