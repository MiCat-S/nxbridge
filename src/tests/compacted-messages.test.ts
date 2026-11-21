import test from 'node:test';
import assert from 'node:assert/strict';
import { closeSync, openSync, writeFileSync, writeSync } from 'node:fs';
import path from 'node:path';
import { compactedMessageIds } from '../broker/delivery/compacted-messages.js';
import { recoveryDigest, RECOVERY_DIGEST_LIMIT } from '../broker/recovery/recovery-digest.js';
import { fixture } from './support/broker-fixture.js';
import { registration } from './support/registration.js';
import { temporary } from './support/temporary.js';

const incoming=(id:string)=>({type:'function_call_output',namespace:'claude',name:'receive_messages',output:JSON.stringify({messages:[{message_id:id,message:'通信正文'}]})});
const boundary=(history:any[]=[])=>({type:'compacted',payload:{replacement_history:history}});
const item=(payload:any)=>({type:'response_item',payload});
const digestRows=(text:string)=>text.trimEnd().split('\n').slice(1).reduce<{meta:any;body:string}[]>((rows,line,index,lines)=>{if(index%2===0)rows.push({meta:JSON.parse(line),body:JSON.parse(lines[index+1]!)});return rows;},[]);

for(const count of [0,1,4,5,8])test(`压缩窗口有 ${count} 条：只附回最后至多五条双向通信，时间顺序稳定`,t=>{
  const f=fixture(t),pair=f.store.pair(f.c.id,f.x.id);
  const outside=f.store.accept(pair,f.c,'窗口外旧消息','outside');
  const messages=Array.from({length:count},(_,index)=>f.store.accept(pair,index%2?f.x:f.c,'窗口内正文 '+index,'in-'+index));
  const unobserved=f.store.accept(pair,f.c,'尚未进入上下文的新消息','unobserved');
                                       
  const ids=messages.map(m=>m.id).reverse();
  const text=recoveryDigest(f.store,f.x,pair,1,[...ids,...ids]),rows=digestRows(text);
  assert.deepEqual(rows.map(row=>row.meta.message_id),messages.slice(-5).map(m=>m.id));
  assert.ok(text.length<=RECOVERY_DIGEST_LIMIT);assert.ok(!text.includes(outside.id)&&!text.includes(unobserved.id));
  for(const [index,row]of rows.entries()){
    const message=messages.slice(-5)[index]!;assert.equal(row.meta.direction,message.from===f.x.id?'outgoing':'incoming');
    assert.equal(row.meta.created_at,new Date(message.createdAt).toISOString());assert.equal(row.meta.in_reply_to,null);
  }
  assert.equal(f.store.messages().length,count+2);assert.ok(f.store.messages().every(m=>m.attempts===0));
});

test('五万字符包含引号转义及元数据；先截断最旧正文，最新单条过长时仍保留开头',t=>{
  const f=fixture(t),pair=f.store.pair(f.c.id,f.x.id);
  const oldest=f.store.accept(pair,f.c,'旧正文'.repeat(22000),'old'),newest=f.store.accept(pair,f.x,'最新完整正文 😀'.repeat(1000),'new',oldest.id);
  const text=recoveryDigest(f.store,f.x,pair,1,[oldest.id,newest.id]),rows=digestRows(text);
  assert.ok(text.length<=RECOVERY_DIGEST_LIMIT);assert.match(rows[0]!.body,new RegExp('truncated; read_messages '+oldest.id));assert.equal(rows[1]!.body,newest.body);assert.equal(rows[1]!.meta.in_reply_to,oldest.id);
  const huge=f.store.accept(pair,f.c,'开头标记😀\n"\t'.repeat(12000),'huge');
  const hugeText=recoveryDigest(f.store,f.x,pair,2,[oldest.id,newest.id,huge.id]),hugeRows=digestRows(hugeText);
  assert.ok(hugeText.length<=RECOVERY_DIGEST_LIMIT);assert.match(hugeRows.at(-1)!.body,/^开头标记/);assert.match(hugeRows.at(-1)!.body,new RegExp('truncated; read_messages '+huge.id));
  assert.equal(Buffer.from(hugeRows.at(-1)!.body).toString(),hugeRows.at(-1)!.body);assert.doesNotMatch(hugeText,/\uFFFD/);
  const other=f.store.register(registration('claude','foreign')),x=f.store.register(registration('codex','foreign-x')),foreignPair=f.store.pair(other.id,x.id),foreign=f.store.accept(foreignPair,other,'不属于当前配对','foreign');
  assert.match(recoveryDigest(f.store,f.x,pair,3,[foreign.id]),/0 actual exchange msgs/);
});

test('窗口编号来自真实通信工具；排除重读、引用、摘要和失败发送；压缩后新消息不混入',async t=>{
  const file=path.join(temporary(t),'rollout.jsonl'),rows=[
    item(incoming('older-window')),boundary(),
    item(incoming('injected-incoming')),
    item({type:'function_call',namespace:'claude',name:'send_message',call_id:'sent',arguments:JSON.stringify({message:'nxref:msg:referenced-only'})}),
    item({type:'function_call_output',call_id:'sent',output:[{type:'input_text',text:'Wall time: 0.01s\nOutput:'},{type:'input_text',text:JSON.stringify({message_id:'actual-outgoing',persisted:true})}]}),
    item({type:'function_call',name:'mcp__claude__receive_messages',call_id:'recv'}),
    item({type:'function_call_output',call_id:'recv',output:{content:[{type:'text',text:JSON.stringify({messages:[{message_id:'actual-incoming',message:'正文 nxref:msg:referenced-only'}]})}]}}),
    item({type:'function_call',namespace:'claude',name:'read_messages',call_id:'reread'}),
    item({type:'function_call_output',call_id:'reread',output:JSON.stringify({messages:[{message_id:'reread-only',message:'旧正文'}]})}),
    item({type:'function_call',namespace:'claude',name:'send_message',call_id:'failed'}),
    item({type:'function_call_output',call_id:'failed',output:JSON.stringify({message_id:'not-saved',persisted:false})}),
    item({type:'function_call_output',namespace:'other',name:'receive_messages',output:incoming('wrong-tool').output}),
    item({type:'message',role:'developer',content:[{type:'input_text',text:JSON.stringify(incoming('digest-only'))}]}),
    boundary(),item(incoming('next-window')),
  ];
  writeFileSync(file,rows.map(row=>JSON.stringify(row)).join('\n')+'\n{"type":','utf8');
  assert.deepEqual(await compactedMessageIds(file),['injected-incoming','actual-outgoing','actual-incoming']);
                                        
  writeFileSync(file,[boundary([incoming('retained')]),item(incoming('current')),boundary()].map(row=>JSON.stringify(row)).join('\n'),'utf8');
  assert.deepEqual(await compactedMessageIds(file),['retained','current']);
  writeFileSync(file,[item(incoming('before-remote')),boundary([{type:'compaction',encrypted_content:'opaque-remote-summary'}]),item(incoming('after-remote')),boundary()].map(row=>JSON.stringify(row)).join('\n'),'utf8');
  assert.deepEqual(await compactedMessageIds(file),['after-remote']);
  writeFileSync(file,JSON.stringify(item(incoming('no-boundary'))),'utf8');assert.deepEqual(await compactedMessageIds(file),[]);
  await assert.rejects(compactedMessageIds(file+'.missing'),{code:'ENOENT'});
});

test('大日志只读取最近两次压缩之间的尾部；读取预算到期时明确失败供 hook 降级为提醒',async t=>{
  const file=path.join(temporary(t),'large-rollout.jsonl'),fd=openSync(file,'w');
  try{writeSync(fd,'\n'+[boundary([incoming('retained-tail')]),item(incoming('new-tail')),boundary(),item(incoming('after-tail'))].map(row=>JSON.stringify(row)).join('\n'),256*1024*1024,'utf8');}finally{closeSync(fd);}
  assert.deepEqual(await compactedMessageIds(file),['retained-tail','new-tail']);
  await assert.rejects(compactedMessageIds(file,0),/预算|abort|timeout/i);
});
