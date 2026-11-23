import test, {type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {appendFileSync,renameSync,writeFileSync} from 'node:fs';
import path from 'node:path';
import {readCodexTurnEvidence} from '../hosts/codex/codex-turn-evidence.js';
import {temporary} from './support/temporary.js';

const session='native-session',base=Date.parse('2026-11-23T12:00:00.000Z');
const row=(n:number,payload:unknown,type='response_item',metadata?:unknown)=>({timestamp:new Date(base+n).toISOString(),type,payload,metadata});
const event=(n:number,type:string,turn_id:string,extra:object={})=>row(n,{type,turn_id,...extra},'event_msg');
const start=(n:number,turnId:string,trigger?:string)=>event(n,'task_started',turnId,{turn_attribution:{turn_id:turnId,turn_trigger:trigger}});
const end=(n:number,turn_id:string,extra:object={})=>event(n,'task_complete',turn_id,extra);
const item=(n:number,turnId:string,value:object)=>event(n,'item_completed',turnId,{thread_id:session,item:value});
const nativeInput=(n:number,turnId:string,client_id?:string)=>item(n,turnId,{type:'UserMessage',id:`user-${n}`,client_id});
const rawInput=(n:number,turnId:string,content_item_kinds=['user.text'])=>row(n,{type:'message',role:'user',content:[{type:'input_text',text:'同样的原生输入'}],internal_chat_message_metadata_passthrough:{turn_id:turnId,content_item_kinds}});
const answer=(n:number,turnId:string,text='最终回复')=>item(n,turnId,{type:'AgentMessage',phase:'final_answer',id:`answer-${n}`,content:[{type:'Text',text}]});

function fixture(t:TestContext,sessionId=session){
  const file=path.join(temporary(t),'history.jsonl');
  const meta={type:'session_meta',payload:{id:sessionId}};
  writeFileSync(file,JSON.stringify(meta)+'\n','utf8');
  const append=(...rows:unknown[])=>appendFileSync(file,rows.map(value=>JSON.stringify(value)+'\n').join(''),'utf8');
  const read=()=>readCodexTurnEvidence(file,sessionId);
  return{file,meta,append,read};
}

test('原生提交编号保留同轮的后续用户输入，原生子通知不成为用户输入',async t=>{
  const f=fixture(t);
  f.append(start(1,'rpc','opaque-lease'),rawInput(2,'rpc'),nativeInput(3,'rpc','bridge-input'),rawInput(4,'rpc',['multi_agent.subagent_notification']),
    rawInput(5,'rpc'),nativeInput(6,'rpc','composer-input'),answer(7,'rpc'),end(8,'rpc'),
    start(9,'queue','queue'),rawInput(10,'queue'),event(11,'user_message','queue',{client_id:'queue-input'}),answer(12,'queue'),end(13,'queue'),
    start(14,'uncertain','opaque-lease'),rawInput(15,'uncertain'),answer(16,'uncertain'),end(17,'uncertain'));
  const evidence=await f.read();
  assert.deepEqual(evidence.turns.map(turn=>[turn.trigger,turn.userInputs]),[
    ['opaque-lease',['bridge-input','composer-input']],['queue',['queue-input']],['opaque-lease',[null]],
  ]);
});

test('发信回执和普通说明不当作发信后的原生工作',async t=>{
  const f=fixture(t);
  f.append(start(1,'send'),row(2,{type:'custom_tool_call',name:'exec',call_id:'exec'}),row(3,{type:'custom_tool_call_output',call_id:'exec'}),
    row(4,{type:'function_call',name:'mcp__claude__send_message',call_id:'send'}),
    item(6,'send',{type:'McpToolCall',server:'claude',tool:'send_message'}),row(7,{type:'function_call_output',call_id:'send'}),
    row(8,{type:'function_call_output',call_id:'unknown'}),row(9,{type:'message',role:'assistant',phase:'commentary'}),answer(10,'send'),end(11,'send'));
  assert.equal((await f.read()).turns[0]?.lastWorkAt,base+3);
  f.append(start(12,'child'),item(13,'older',{type:'SubAgentActivity',kind:'completed',agent_thread_id:'child'}),end(14,'child'));
  assert.equal((await f.read()).turns[1]?.lastWorkAt,base+13);
});

test('旧版与新版子代理最终结果须有原生来源，不能只凭通知文案',async t=>{
  const f=fixture(t),agentPath='/root/worker';
  const legacy={type:'message',role:'user',content:[{type:'input_text',text:`<subagent_notification>\n${JSON.stringify({agent_path:agentPath,status:{completed:'结果'}})}\n</subagent_notification>`}]};
  const modern={type:'agent_message',author:agentPath,recipient:'/root',content:[{type:'input_text',text:`Message Type: FINAL_ANSWER\nTask name: /root\nSender: ${agentPath}\nPayload:\n结果`}]};
  const metadata=(n:number,trigger_turn=false)=>row(n,{trigger_turn},'inter_agent_communication_metadata');
  f.append(start(1,'legacy-child'),row(2,{...legacy,internal_chat_message_metadata_passthrough:{content_item_kinds:['multi_agent.subagent_notification']}}),end(3,'legacy-child'),
    start(4,'unknown-child'),row(5,legacy),row(6,modern),metadata(7,true),row(8,modern),
    metadata(9),row(10,{...modern,recipient:'/unrelated'}),end(11,'unknown-child'),start(12,'modern-child'),metadata(13));
  const partial=await f.read();
  assert.equal(partial.turns[0]?.lastWorkAt,base+2);
  assert.equal(partial.turns[1]?.lastWorkAt,undefined);
  f.append(row(14,modern),end(15,'modern-child'));
  assert.equal((await f.read()).turns[2]?.lastWorkAt,base+14);
});

test('只保留完成轮次的显式最终回复，回滚和原生失败清除候选',async t=>{
  const f=fixture(t);
  f.append(start(1,'commentary'),row(2,{type:'message',role:'assistant',phase:'commentary',id:'comment',content:[{type:'output_text',text:'说明'}]}),
    end(3,'commentary',{last_agent_message:'说明'}),start(4,'legacy'),
    row(5,{type:'message',role:'assistant',phase:'final_answer',id:'legacy-answer',content:[{type:'output_text',text:'旧历史最终回复'}]}),end(6,'legacy'),
    start(7,'compacted'),row(8,{type:'message',role:'assistant',phase:'final_answer',id:'compaction-answer',content:[{type:'output_text',text:'压缩摘要'}]},'response_item',{compaction_output:true}),end(9,'compacted'),
    start(10,'commentary-after-final'),answer(11,'commentary-after-final'),
    row(12,{type:'message',role:'assistant',phase:'commentary',id:'later-commentary',content:[{type:'output_text',text:'后续说明'}]}),
    end(13,'commentary-after-final',{last_agent_message:'后续说明'}),start(14,'failed'),answer(15,'failed'),end(16,'failed',{error:{message:'失败'}}));
  const initial=await f.read();
  assert.deepEqual(initial.turns.map(turn=>[turn.turnId,turn.final?.text]),[
    ['commentary',undefined],['legacy','旧历史最终回复'],['compacted',undefined],['commentary-after-final','最终回复'],
  ]);
  f.append(event(17,'thread_rolled_back','failed'));
  assert.deepEqual((await f.read()).turns,[]);
  f.append(start(18,'fresh'),answer(19,'fresh'),end(20,'fresh'));
  assert.equal((await f.read()).turns[0]?.turnId,'fresh');
});

test('大文件冷读有界，增量只处理新增完整行且轮换不沿用旧证明',async t=>{
  const f=fixture(t);
  const padding=JSON.stringify(row(1,{type:'function_call_output',output:'x'.repeat(128*1024)}))+'\n';
  appendFileSync(f.file,padding.repeat(72),'utf8');
                                
  f.append(end(3,'outside'),start(4,'inside'),answer(5,'inside'));
  let first=await f.read(),bytes=first.bytesRead;
  for(let i=0;i<20&&!first.caughtUp;i++){first=await f.read();bytes+=first.bytesRead;}
  assert.ok(bytes<=8*1024*1024);
  assert.equal(first.openTurnId,'inside');
  assert.deepEqual(first.turns,[]);
  assert.equal((await f.read()).bytesRead,0);
  const closing=JSON.stringify(end(6,'inside'))+'\n';
  appendFileSync(f.file,closing.slice(0,40),'utf8');
  assert.equal((await f.read()).caughtUp,false);
  appendFileSync(f.file,closing.slice(40),'utf8');
  assert.equal((await f.read()).turns[0]?.final?.text,'最终回复');
  renameSync(f.file,f.file+'.old');f.append({type:'session_meta',payload:{id:'other'}});
  const rotated=await f.read();
  assert.equal(rotated.status,'unsupported');
  assert.deepEqual(rotated.turns,[]);
});
