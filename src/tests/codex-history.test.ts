import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { writeFileSync,appendFileSync } from 'node:fs';
import { readCodexHistory } from '../hosts/codex/codex-history.js';
import { temporary } from './support/temporary.js';

test('冷启动按未确认消息时间有界回看尾部，仍要求同会话唯一有序调用对',async t=>{
  const file=path.join(temporary(t),'recent.jsonl'),base=Date.parse('2026-11-10T00:00:00Z'),row=(n:number,payload:unknown,type='response_item')=>({timestamp:new Date(base+n).toISOString(),type,payload});
  const call=(id:string)=>({type:'function_call',name:'receive_messages',namespace:'claude',call_id:id}),output=(id:string)=>({type:'function_call_output',call_id:id,output:JSON.stringify({messages:[{message_id:id}]})});
  writeFileSync(file,[row(0,{id:'recent'},'session_meta'),row(1,call('old')),row(2,output('old')),row(3,{type:'task_started'},'event_msg'),row(5,call('new')),row(6,output('new')),row(7,output('orphan'))].map(value=>JSON.stringify(value)).join('\n')+'\n','utf8');
  assert.deepEqual((await readCodexHistory(file,'recent',{tail:true})).receipts,[]);
  const recent=await readCodexHistory(file,'recent',{since:base+4});assert.equal(recent.status,'supported');assert.deepEqual(recent.receipts.map(receipt=>receipt.messageId),['new']);
  appendFileSync(file,JSON.stringify(row(8,call('new')))+'\n','utf8');assert.deepEqual((await readCodexHistory(file,'recent',{since:base+4})).receipts,[],'重复调用不能证明唯一进入上下文');
  assert.equal((await readCodexHistory(file,'other',{since:base+4})).status,'unsupported');
});

test('冷启动回看不扫描整份大历史，窗口外及不完整调用对继续保留未知',async t=>{
  const file=path.join(temporary(t),'recent-large.jsonl'),meta={type:'session_meta',payload:{id:'recent-large'}},call=(id:string)=>({type:'response_item',payload:{type:'function_call',name:'receive_messages',namespace:'claude',call_id:id}}),output=(id:string)=>({type:'response_item',payload:{type:'function_call_output',call_id:id,output:JSON.stringify({messages:[{message_id:id}]})}});
  writeFileSync(file,[meta,call('outside'),output('outside'),call('partial'),{type:'event_msg',payload:{type:'agent_message',message:'x'.repeat(10*1024*1024)}},output('partial'),call('inside'),output('inside')].map(value=>JSON.stringify(value)).join('\n')+'\n','utf8');
  const result=await readCodexHistory(file,'recent-large',{since:0});assert.equal(result.status,'supported');assert.deepEqual(result.receipts.map(receipt=>receipt.messageId),['inside']);assert.ok(result.bytesRead!<1024*1024);
  assert.equal((await readCodexHistory(file,'recent-large',{since:0})).bytesRead,0,'相同时间边界继续增量读取，不反复回看历史');
});

test('超过读取预算的普通大行跨块跳过，仍能核验其后的成对回执',async t=>{
  const file=path.join(temporary(t),'huge-line.jsonl'),meta={type:'session_meta',payload:{id:'huge'}};
  writeFileSync(file,JSON.stringify(meta)+'\n'+JSON.stringify({type:'event_msg',payload:{type:'agent_message',message:'x'.repeat(10*1024*1024)}})+'\n','utf8');
  const first=await readCodexHistory(file,'huge');assert.equal(first.status,'supported');assert.equal(first.complete,false);assert.ok(first.bytesRead!<=8*1024*1024);
  appendFileSync(file,JSON.stringify({type:'response_item',payload:{type:'function_call',name:'receive_messages',namespace:'claude',call_id:'nxbridge-expected'}})+'\n'+JSON.stringify({type:'response_item',payload:{type:'function_call_output',call_id:'nxbridge-expected',output:JSON.stringify({messages:[{message_id:'expected'}]})}})+'\n','utf8');
  let result=first;for(let i=0;i<40&&!result.complete;i++)result=await readCodexHistory(file,'huge');
  assert.equal(result.status,'supported');assert.equal(result.complete,true);assert.equal(result.receipts[0]?.messageId,'expected');
});

test('超大普通工具输出可跳过，超大 nxbridge 回执不能证明缺席',async t=>{
  for(const own of [false,true]){
    const file=path.join(temporary(t),'tool.jsonl'),id=own?'nxbridge-own':'shell';
    writeFileSync(file,[{type:'session_meta',payload:{id:'tool'}},{type:'response_item',payload:{type:'function_call',call_id:id,name:own?'receive_messages':'exec_command',namespace:own?'claude':'functions'}},{type:'response_item',payload:{type:'function_call_output',call_id:id,output:'x'.repeat(3*1024*1024)}}].map(v=>JSON.stringify(v)).join('\n')+'\n','utf8');
    let result=await readCodexHistory(file,'tool');for(let i=0;i<20&&!result.complete&&result.status==='supported';i++)result=await readCodexHistory(file,'tool');
    assert.equal(result.status,own?'unsupported':'supported');assert.equal(result.complete,!own);
  }
});

test('旧版修复扫描检查点保留跨批调用配对，缓存被释放后仍可继续验证',async t=>{
  const dir=temporary(t),file=path.join(dir,'repair.jsonl'),meta={type:'session_meta',payload:{id:'repair'}},call={type:'response_item',payload:{type:'function_call',name:'receive_messages',namespace:'claude',call_id:'nxbridge-repair'}};
  writeFileSync(file,[meta,call,{type:'event_msg',payload:{type:'agent_message',message:'x'.repeat(10*1024*1024)}}].map(v=>JSON.stringify(v)).join('\n')+'\n','utf8');
  const first=await readCodexHistory(file,'repair',{checkpoint:true});assert.equal(first.complete,false);assert.ok(first.checkpoint);
  for(let i=0;i<17;i++){const other=path.join(dir,'evict-'+i);writeFileSync(other,JSON.stringify({type:'session_meta',payload:{id:String(i)}})+'\n');await readCodexHistory(other,String(i));}
  appendFileSync(file,JSON.stringify({type:'response_item',payload:{type:'function_call_output',call_id:'nxbridge-repair',output:JSON.stringify({messages:[{message_id:'repaired'}]})}})+'\n','utf8');
  let result=await readCodexHistory(file,'repair',{checkpoint:true,resume:first.checkpoint});for(let i=0;i<30&&!result.complete;i++)result=await readCodexHistory(file,'repair',{checkpoint:true,resume:result.checkpoint});
  assert.equal(result.complete,true);assert.equal(result.receipts[0]?.messageId,'repaired');assert.equal(result.checkpoint,undefined);
});

test('持久历史仅认可同一线程内完整、唯一、有序的 receive_messages 调用与结果',async t=>{
  const file=path.join(temporary(t),'history.jsonl'),meta={type:'session_meta',payload:{id:'thread'}},call={type:'response_item',payload:{type:'function_call',call_id:'call',name:'receive_messages',namespace:'claude',arguments:'{}'}},output={type:'response_item',payload:{type:'function_call_output',call_id:'call',output:JSON.stringify({messages:[{message_id:'message',message:'原文'}]})}};
  let sequence=0;const read=async(rows:unknown[],id='thread')=>{const filename=file+sequence++;writeFileSync(filename,rows.map(row=>JSON.stringify(row)).join('\n')+'\n','utf8');return readCodexHistory(filename,id);};
  const good=await read([meta,call,output]);assert.equal(good.status,'supported');assert.deepEqual(good.receipts.map(item=>[item.callId,item.messageId]),[['call','message']]);
  for(const rows of [[meta,call],[meta,output],[meta,output,call],[meta,call,call,output],[meta,call,output,output],[meta,{...call,payload:{...call.payload,name:'send_message'}},output],[meta,call,{...output,payload:{...output.payload,call_id:'other'}}]])assert.equal((await read(rows)).receipts.length,0);
  assert.equal((await read([meta,call,output],'other')).status,'unsupported');
  writeFileSync(file,[meta,call,output].map(row=>JSON.stringify(row)).join('\n')+'\n{"type":','utf8');const partial=await readCodexHistory(file,'thread');assert.equal(partial.status,'supported');assert.equal(partial.complete,false);assert.equal(partial.receipts.length,1);
  writeFileSync(file,JSON.stringify(meta)+'\n{"type":\n'+JSON.stringify(call)+'\n','utf8');assert.equal((await readCodexHistory(file,'thread')).status,'unsupported');
});

test('大历史只读取新增完整行；部分尾行不抹掉已验证回执，也不能证明调用缺席',async t=>{
  const file=path.join(temporary(t),'large.jsonl'),meta=JSON.stringify({type:'session_meta',payload:{id:'large'}})+'\n',text=JSON.stringify({type:'response_item',payload:{type:'message',content:'中'.repeat(6000)}})+'\n';
  writeFileSync(file,meta+text.repeat(1024),'utf8');const cold=performance.now();await readCodexHistory(file,'large');const coldMs=performance.now()-cold,warm=performance.now();for(let i=0;i<50;i++)await readCodexHistory(file,'large');const warmMs=performance.now()-warm;
  const call={type:'response_item',payload:{type:'function_call',name:'receive_messages',namespace:'claude',call_id:'appended'}},output={type:'response_item',payload:{type:'function_call_output',call_id:'appended',output:[{type:'input_text',text:'Wall time: 4.0690 seconds\nOutput:'},{type:'input_text',text:JSON.stringify({messages:[{message_id:'once'}]})}]}};
  appendFileSync(file,JSON.stringify(call)+'\n'+JSON.stringify(output)+'\n{"type":','utf8');const partial=await readCodexHistory(file,'large');assert.equal(partial.complete,false);assert.equal(partial.receipts[0]?.messageId,'once');
  appendFileSync(file,'"event_msg","payload":{"type":"task_started","turn_id":"next"}}\n','utf8');const finished=await readCodexHistory(file,'large');assert.equal(finished.complete,true);assert.equal(finished.receipts.length,1);
  t.diagnostic(JSON.stringify({bytes:Buffer.byteLength(meta+text.repeat(1024)),coldMs,warm50Ms:warmMs}));
});

test('普通输出按旧版解码结果保留检查点，跨块与缓存释放不改变调用或回执',async t=>{
                                           
  const legacyMessages=(output:any):any[]=>{
    if(typeof output==='string'){try{return legacyMessages(JSON.parse(output));}catch{return[];}}
    if(Array.isArray(output))return output.filter(item=>item?.type==='text'||item?.type==='input_text').flatMap(item=>legacyMessages(item.text));
    if(!output||typeof output!=='object')return[];
    if(Array.isArray(output.messages)||Array.isArray(output.notices))return[...(output.messages??[]),...(output.notices??[]).map((notice:any)=>({message_id:notice?.notice_id}))];
    return Array.isArray(output.content)?output.content.filter((item:any)=>item?.type==='text').flatMap((item:any)=>legacyMessages(item.text)):[];
  };
  const dir=temporary(t),file=path.join(dir,'ordinary-checkpoint.jsonl'),sessionId='ordinary-checkpoint',turnId='ordinary-turn';
  const rows:any[]=[{type:'session_meta',payload:{id:sessionId}},{type:'event_msg',payload:{type:'task_started',turn_id:turnId}}];
  const calls=new Map<string,{count:number;receive:boolean;turnId:string}>(),outputs=new Map<string,{count:number;ids:string[];itemId:string;afterCall:boolean}>(),receipts:any[]=[];
  const call=(id:string,receive:boolean,name?:string)=>{
    rows.push({type:'response_item',payload:{type:'function_call',call_id:id,name:name??(receive?'receive_messages':'exec_command'),namespace:receive?'claude':'functions'}});
    calls.set(id,{count:(calls.get(id)?.count??0)+1,receive,turnId});
  };
  const output=(id:string,value:unknown,extra:Record<string,unknown>={},valid=true)=>{
    rows.push({type:'response_item',payload:{type:'function_call_output',call_id:id,output:value,...extra}});
    const ids=valid?legacyMessages(value).flatMap(message=>typeof message?.message_id==='string'&&message.message_id?[message.message_id]:[]):[];
    outputs.set(id,{count:(outputs.get(id)?.count??0)+1,ids,itemId:typeof extra.id==='string'?extra.id:id,afterCall:calls.has(id)});
    return ids;
  };
  const nested={messages:[{message_id:'message-a'},{message_id:''},{message_id:23},{message_id:'message-a'}],notices:[{notice_id:'notice-b'}]};
  const values:unknown[]=[
    'Wall time: 1.2 seconds\nOutput:\n{"messages":[{"message_id":"plain-text-only"}]}',
    '', ' \r\n\t', '42', 'false', 'null', '{broken', '[broken', '"unterminated',
    JSON.stringify(nested),JSON.stringify(JSON.stringify(nested)),JSON.stringify('ordinary text'),
    '\uFEFF'+JSON.stringify(nested),
    [{type:'input_text',text:'Chunk ID: ordinary'},{type:'text',text:JSON.stringify(nested)},{type:'image',text:JSON.stringify(nested)}],
    {content:[{type:'text',text:JSON.stringify([{type:'text',text:JSON.stringify(nested)}])},{type:'input_text',text:JSON.stringify(nested)}]},
    JSON.stringify({messages:{invalid:true},notices:[]}),null,23,
  ];
  for(const [index,value] of values.entries())for(const kind of ['ordinary','receive','unknown','duplicate'] as const){
    const id=kind+'-'+index;
    if(kind!=='unknown')call(id,kind==='receive');
    if(kind==='duplicate')call(id,false);
    const itemId='item-'+id,ids=output(id,value,{id:itemId});
    if(kind==='receive')for(const messageId of ids)receipts.push({messageId,turnId,itemId,callId:id});
  }
  call('wrong-name',false);output('wrong-name',JSON.stringify(nested),{name:'exec_command'},false);
  call('wrong-namespace',false);output('wrong-namespace',JSON.stringify(nested),{namespace:'functions'},false);
  call('receive-name-other-namespace',false,'receive_messages');output('receive-name-other-namespace',JSON.stringify(nested));
  output('out-of-order',JSON.stringify(nested));call('out-of-order',true);
  call('repeated-output',true);output('repeated-output','ordinary text');output('repeated-output',JSON.stringify(nested));
  call('receive-across',true);call('ordinary-across',false);call('plain-across',false);
  const before={turnId,calls:[...calls],outputs:[...outputs]},expectedBefore=structuredClone(before),prefix=rows.map(row=>JSON.stringify(row)).join('\n')+'\n';
                                          
  writeFileSync(file,prefix+JSON.stringify({type:'event_msg',payload:{type:'agent_message',message:'x'.repeat(10*1024*1024)+JSON.stringify(nested)}})+'\n','utf8');
  const first=await readCodexHistory(file,sessionId,{checkpoint:true});assert.equal(first.status,'supported');assert.equal(first.complete,false);assert.ok(first.checkpoint);
  const state=(checkpoint:NonNullable<typeof first.checkpoint>)=>({turnId:checkpoint.turnId,calls:checkpoint.calls,outputs:checkpoint.outputs});
  assert.deepEqual(state(first.checkpoint),expectedBefore);assert.deepEqual(first.receipts,receipts);
  for(let index=0;index<17;index++){
    const other=path.join(dir,'eviction-'+index);writeFileSync(other,JSON.stringify({type:'session_meta',payload:{id:'eviction-'+index}})+'\n','utf8');await readCodexHistory(other,'eviction-'+index);
  }
  const suffixStart=rows.length,acrossValue=[{type:'input_text',text:'Wall time: 0.2 seconds'},{type:'text',text:JSON.stringify(nested)}];
  for(const messageId of output('receive-across',acrossValue))receipts.push({messageId,turnId,itemId:'receive-across',callId:'receive-across'});
  output('ordinary-across',JSON.stringify(nested));output('plain-across','Process exited with code 0\nOutput:\nordinary text');
                                         
  rows.push({type:'response_item',payload:{type:'function_call_output',output:JSON.stringify(nested)}});
  call('out-of-order',false);output('out-of-order','ordinary late output');
  appendFileSync(file,rows.slice(suffixStart).map(row=>JSON.stringify(row)).join('\n')+'\n{"type":','utf8');
  let result=await readCodexHistory(file,sessionId,{checkpoint:true,resume:first.checkpoint});
  for(let index=0;index<30&&result.status==='supported'&&result.cursor!.offset<Buffer.byteLength(prefix)+10*1024*1024;index++){
    assert.ok(result.checkpoint);assert.deepEqual(state(result.checkpoint),expectedBefore);
    result=await readCodexHistory(file,sessionId,{checkpoint:true,resume:result.checkpoint});
  }
  assert.equal(result.status,'supported');assert.equal(result.complete,false);assert.ok(result.checkpoint);
  assert.deepEqual(state(result.checkpoint),{turnId,calls:[...calls],outputs:[...outputs]});assert.deepEqual(result.receipts,receipts);
  const expectedCalls=[...new Set([...calls.keys(),...outputs.keys()])];assert.deepEqual(result.calls,expectedCalls);
  appendFileSync(file,'"event_msg","payload":{"type":"task_started","turn_id":"next-turn"}}\n','utf8');
  const finished=await readCodexHistory(file,sessionId,{checkpoint:true,resume:result.checkpoint});
  assert.equal(finished.complete,true);assert.equal(finished.checkpoint,undefined);assert.deepEqual(finished.receipts,receipts);assert.deepEqual(finished.calls,expectedCalls);
});
