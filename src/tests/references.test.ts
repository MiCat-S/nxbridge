import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './support/broker-fixture.js';
import { registration } from './support/registration.js';
import { temporary } from './support/temporary.js';
import {BridgeError} from '../shared/errors.js';
import { codexAgentPath } from '../hosts/codex/adapter.js';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { hook } from '../integration/hooks/hook-control.js';

const cx={host:'codex' as const,sessionId:'x',callId:'ref'},cc={host:'claude' as const,sessionId:'c',callId:'ref'};
const code=(expected:string)=>(error:unknown)=>error instanceof BridgeError&&error.code===expected;
const wrap=(key:string,body:string)=>`[nxref ${key}]\n${body}\n[/nxref]`;

test('nxref 消息和子代理递归展开，账本保留原文，重试沿用接收快照',async t=>{
  const {store,broker,c,x,codex}=fixture(t);store.pair(c.id,x.id);
  await broker.dispatch('ref.capture',{actor:cc,agent_id:'child',text:'长正文'});
  const first=broker.send({actor:cc,message:'任务 nxref:agent:child。'}) as any;
  assert.equal(store.message(first.message_id).body,'任务 nxref:agent:child。');
  const next=broker.send({actor:{...cc,callId:'nested'},message:`沿用 nxref:msg:${first.message_id}.`}) as any;
  await broker.dispatch('ref.capture',{actor:cc,agent_id:'child',text:'后续答案'});
  assert.equal((broker.send({actor:cc,message:'任务 nxref:agent:child。'}) as any).message_id,first.message_id);
  const firstBody='任务 '+wrap('agent:child','长正文')+'。',nextBody='沿用 '+wrap('msg:'+first.message_id,firstBody)+'.';
  await broker.pump();assert.deepEqual(codex.delivered.map(m=>m.body),[firstBody,nextBody]);
  assert.equal(broker.references.message(store.message(next.message_id)),nextBody);
  assert.throws(()=>broker.send({actor:cc,message:'修改'}),code('idempotency_conflict'));
  const expanded:any=await broker.dispatch('ref.expand',{actor:cx,text:`转给子代理 nxref:msg:${first.message_id}`});
  assert.equal(expanded.text,'转给子代理 '+wrap('msg:'+first.message_id,firstBody));
});

test('nxref 未知、跨根、旧配对、循环和大小错误均拒绝，不落账',async t=>{
  const {store,broker,c,x}=fixture(t);store.pair(c.id,x.id);
  broker.references.capture(c,'same-id','自己的答案');
  for(const raw of ['nxref:msg:missing','nxref:agent:same-id'])await assert.rejects(broker.dispatch('ref.expand',{actor:cx,text:raw}),code('ref_missing'));
  broker.references.capture(x,'a','nxref:agent:b');broker.references.capture(x,'b','nxref:agent:a');
  await assert.rejects(broker.dispatch('ref.expand',{actor:cx,text:'nxref:agent:a'}),code('ref_cycle'));
  broker.references.capture(x,'large','中'.repeat(50000));
  await assert.rejects(broker.dispatch('ref.expand',{actor:cx,text:'nxref:agent:large nxref:agent:large'}),code('ref_too_large'));
  const count=store.messages().length;assert.throws(()=>broker.send({actor:cx,message:'nxref:msg:missing'}),code('ref_missing'));assert.equal(store.messages().length,count);
  const source=broker.send({actor:cc,message:'原配对'}) as any;
  const other=store.register(registration('claude','other'));store.pair(other.id,x.id,true);
  await assert.rejects(broker.dispatch('ref.expand',{actor:cx,text:'nxref:msg:'+source.message_id}),code('ref_missing'));
});

test('语法不完整的 nxref 说明保留原文，同一正文内合法引用仍展开',t=>{
  const {broker,c}=fixture(t);broker.references.capture(c,'answer','保存的答案');
  const prose='格式为 nxref:msg:、nxref:agent: 或 nxref:unknown:id；示例 nxref:agent:answer。';
  assert.equal(broker.references.expand(c,prose),'格式为 nxref:msg:、nxref:agent: 或 nxref:unknown:id；示例 '+wrap('agent:answer','保存的答案')+'。');
});

for(const subagentSend of ['allow-verified','deny'] as const)test('Codex hook 原生展开保留所有参数，正常失败 deny；仅已核验根捕获子代理答案：'+subagentSend,async t=>{
  const {store,broker,c,x}=fixture(t,{subagentSend});store.pair(c.id,x.id);
  const context_key=`${process.pid}:test:x`;
  await broker.dispatch('hook',{session_id:'x',hook_event_name:'SessionStart',context_key});
  const stop={session_id:'x',hook_event_name:'SubagentStop',context_key,agent_id:'child',last_assistant_message:'子代理最终答案',model:'small'};
  await broker.dispatch('hook',{...stop,context_key:'foreign'});
  await assert.rejects(broker.dispatch('ref.expand',{actor:cx,text:'nxref:agent:child'}),code('ref_missing'));
  await broker.dispatch('hook',{...stop,agent_path:'/root/reference_child'});assert.equal(store.peer(x.id).model,undefined);
  assert.equal(broker.references.expand(x,'nxref:agent:/root/reference_child'),wrap('agent:/root/reference_child','子代理最终答案'));
  const tool={message:'任务 nxref:agent:child',task_name:'child2',model:'gpt-6-sol',reasoning_effort:'high',fork_turns:'none'};
  const hook={session_id:'x',hook_event_name:'PreToolUse',context_key,tool_name:'spawn_agent',tool_input:tool};
  const result:any=await broker.dispatch('hook',hook);
  assert.equal(result.hookSpecificOutput.permissionDecision,'allow');assert.deepEqual(result.hookSpecificOutput.updatedInput,{...tool,message:'任务 '+wrap('agent:child','子代理最终答案')});
  for(const name of ['collaborationspawn_agent','collaboration.spawn_agent'])assert.deepEqual((await broker.dispatch('hook',{...hook,tool_name:name}) as any).hookSpecificOutput.updatedInput,result.hookSpecificOutput.updatedInput);
  for(const changed of [{session_id:'unknown'},{context_key:'foreign'},{tool_input:{message:'nxref:msg:missing'}}])assert.equal((await broker.dispatch('hook',{...hook,...changed}) as any).hookSpecificOutput.permissionDecision,'deny');
});

test('V2 路径从原生元数据读取，同时核验根和子线程，允许宿主独立 home',t=>{
  const home=temporary(t),sessions=path.join(home,'sessions');mkdirSync(sessions);
  const file=path.join(sessions,'child.jsonl'),meta={id:'child',session_id:'root',agent_path:'/root/child'};
  const parent=path.join(sessions,'root.jsonl');writeFileSync(parent,JSON.stringify({type:'session_meta',payload:{id:'root',session_id:'root'}}),'utf8');
  writeFileSync(file,JSON.stringify({type:'session_meta',payload:meta})+'\n'+JSON.stringify({type:'response_item',payload:'无需读取正文'}),'utf8');
  assert.equal(codexAgentPath('root','child',file,parent),'/root/child');
  assert.throws(()=>codexAgentPath('foreign','child',file,parent),code('unverified_parent'));assert.throws(()=>codexAgentPath('root','foreign',file,parent),code('unverified_parent'));
  const foreign=path.join(home,'foreign.jsonl');writeFileSync(foreign,JSON.stringify({type:'session_meta',payload:{...meta,id:'foreign'}}),'utf8');assert.throws(()=>codexAgentPath('root','child',file,foreign),code('unverified_parent'));
});

test('子代理元数据跨读取块时仍完整解析，并且不解析后续正文',t=>{
  const home=temporary(t),parent=path.join(home,'root.jsonl'),child=path.join(home,'child.jsonl');
  writeFileSync(parent,JSON.stringify({type:'session_meta',payload:{id:'root',session_id:'root',instructions:'中文'.repeat(200000)}})+'\n这不是 JSON','utf8');
  writeFileSync(child,JSON.stringify({type:'session_meta',payload:{id:'child',session_id:'root',agent_path:'/root/长路径',instructions:'规则'.repeat(8000)}})+'\n'+'.'.repeat(2*1024*1024),'utf8');
  assert.equal(codexAgentPath('root','child',child,parent),'/root/长路径');
});

for(const mode of ['missing','invalid','foreign'] as const)test('路径补充失败仍提交已绑定的 SubagentStop，不认领未核验路径：'+mode,async t=>{
  const home=temporary(t),parent=path.join(home,'root.jsonl'),child=path.join(home,'child.jsonl');
  writeFileSync(parent,JSON.stringify({type:'session_meta',payload:{id:'root',session_id:'root'}}),'utf8');
  if(mode!=='missing')writeFileSync(child,mode==='invalid'?'尚未完整写入':JSON.stringify({type:'session_meta',payload:{id:'child',session_id:'foreign',agent_path:'/foreign/child'}}),'utf8');
  const calls:string[]=[],input={session_id:'root',hook_event_name:'SubagentStop',agent_id:'child',agent_path:'/unverified/child',agent_transcript_path:child,transcript_path:parent,last_assistant_message:'已完成'};
  const result=await hook('codex',input,()=>{}, {home,configHome:home,runtime:{pid:process.pid,procStart:'test',appServer:true} as any,call:(async(method:string,params:any)=>{calls.push(method);assert.equal(params.agent_path,undefined);assert.equal(params.agent_id,'child');return{accepted:true};}) as any});
  assert.deepEqual(result,{accepted:true});assert.deepEqual(calls,['hook']);
});

test('embedded 缓存保存展开正文，问题来源核验读取同一快照',async t=>{
  const {store,broker,c,x}=fixture(t);store.pair(c.id,x.id);store.saveEndpoint({...store.endpoint(c.id)!,mode:'embedded'});
  broker.references.capture(x,'child','原始任务');const sent:any=broker.send({actor:cx,message:'nxref:agent:child'});
  const expanded=wrap('agent:child','原始任务');
  const result:any=broker.receive(cc);assert.equal(result.messages[0].message,expanded);assert.equal(result.messages[0].relationship,undefined);assert.equal(result.messages[0].in_reply_to,undefined);
  assert.equal((store.setting<any>(`receive:${c.id}:${cc.sessionId}:ref`)).messages[0].message,expanded);
  assert.equal((await broker.dispatch('question.origin',{actor:cc,message_id:sent.message_id}) as any).body,expanded);
});

test('代理路径 ID 与 UUID 都能捕获和展开，边界计入字节上限',async t=>{
  const {broker,c}=fixture(t);
  for(const id of ['/root/reference_child','root/child-2','01234567-89ab-cdef-0123-456789abcdef']){
    broker.references.capture(c,id,'最终答复');assert.equal(broker.references.expand(c,'nxref:agent:'+id),wrap('agent:'+id,'最终答复'));
  }
  for(const id of ['/root/../child','/root//child','/root/child/'])assert.throws(()=>broker.references.capture(c,id,'答案'),code('agent_incomplete'));
  broker.references.capture(c,'boundary','x'.repeat(256*1024));assert.throws(()=>broker.references.expand(c,'nxref:agent:boundary'),code('ref_too_large'));
});
