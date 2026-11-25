import test,{type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {appendFileSync,writeFileSync} from 'node:fs';
import path from 'node:path';
import {temporary} from './support/temporary.js';
import {readCodexPendingTools} from '../hosts/codex/codex-pending-tools.js';

const session='native-session',turn='current-turn',base=Date.parse('2026-11-25T03:00:00Z');
const row=(payload:object,type='response_item',metadata?:object)=>({timestamp:new Date(base).toISOString(),type,payload,metadata});
const start=(turn_id=turn)=>row({type:'task_started',turn_id},'event_msg');
const call=(id:string,type='function_call',scope=turn)=>row({type,call_id:id,name:'arbitrary_tool',status:'completed',internal_chat_message_metadata_passthrough:{turn_id:scope}});
const output=(id:string,type='function_call_output')=>row({type,call_id:id,output:'正文不进入证据'});
function fixture(t:TestContext){
  const file=path.join(temporary(t),'native.jsonl'),meta={type:'session_meta',payload:{id:session}};
  writeFileSync(file,JSON.stringify(meta)+'\n','utf8');
  const append=(...rows:unknown[])=>appendFileSync(file,rows.map(value=>JSON.stringify(value)+'\n').join(''),'utf8');
  return{file,append,read:()=>readCodexPendingTools(file,session,turn)};
}

test('模型已生成函数或自定义调用不代表工具结束；只保留当前轮次的在途编号',async t=>{
  const f=fixture(t);f.append(start(),call('function'),call('custom','custom_tool_call'),call('other','function_call','older'));
  let value=await f.read();assert.equal(value?.complete,true);
  assert.deepEqual(value?.calls,[{id:'function',at:base},{id:'custom',at:base}]);
  assert.doesNotMatch(JSON.stringify(value),/arbitrary_tool|正文/);
                                      
  f.append(row({type:'item_completed',thread_id:session,turn_id:'older',item:{id:'old-item'}},'event_msg'),output('function'),output('custom','custom_tool_call_output'));
  value=await f.read();assert.deepEqual(value?.calls,[]);
});

test('原生完成记录、轮次结束和回滚均清除在途调用，旧轮次或压缩副本不复活工具',async t=>{
  const f=fixture(t);f.append(start(),call('done'),row({type:'item_completed',thread_id:session,turn_id:turn,item:{id:'done'}},'event_msg'));
  assert.deepEqual((await f.read())?.calls,[]);
  f.append(call('aborted'),row({type:'turn_aborted',turn_id:turn},'event_msg'),call('late'));
  assert.deepEqual((await f.read())?.calls,[]);assert.equal((await f.read())?.complete,false);
  f.append(start(),call('rollback'),row({type:'thread_rolled_back'},'event_msg'),call('copy'));
  assert.deepEqual((await f.read())?.calls,[]);
  f.append(start('newer'),call('old'),{...call('compacted'),metadata:{compaction_output:true}});
  assert.deepEqual((await f.read())?.calls,[]);
});

test('大历史只读有界尾部，开始记录在窗口外时按显式轮次配对调用与回执',async t=>{
  const f=fixture(t);f.append(start());
  const padding=JSON.stringify(row({type:'message',role:'assistant',content:[{text:'x'.repeat(128*1024)}]}))+'\n';
  appendFileSync(f.file,padding.repeat(20),'utf8');f.append(call('outside-start'));
  assert.equal((await f.read())?.complete,true);assert.deepEqual((await f.read())?.calls.map(call=>call.id),['outside-start']);
  f.append(output('outside-start'));assert.deepEqual((await f.read())?.calls,[]);assert.equal((await f.read())?.complete,true);
});

test('会话身份、完整行和轮次来源无法核验时保留未知；轮换后不复用旧调用',async t=>{
  const f=fixture(t);f.append(start(),call('pending'));
  assert.equal(await readCodexPendingTools(f.file,'wrong-session',turn),undefined);
  assert.equal(await readCodexPendingTools(f.file+'.missing',session,turn),undefined);
  appendFileSync(f.file,'{"type":"response_item"','utf8');assert.equal((await f.read())?.complete,false);
  writeFileSync(f.file,JSON.stringify({type:'session_meta',payload:{id:session}})+'\n','utf8');
  f.append(row({type:'function_call',call_id:'unscoped'}));assert.deepEqual((await f.read())?.calls,[]);assert.equal((await f.read())?.complete,false);
  writeFileSync(f.file,'无效历史\n','utf8');assert.equal(await f.read(),undefined);
});

test('长自定义指令的会话头按块核验，超过 hook 共用的两 MiB 上限才保留未知',async t=>{
  const f=fixture(t);
  writeFileSync(f.file,JSON.stringify({type:'session_meta',payload:{id:session,base_instructions:'x'.repeat(100*1024)}})+'\n','utf8');
  f.append(start(),call('long-header'));assert.deepEqual((await f.read())?.calls,[{id:'long-header',at:base}]);
  writeFileSync(f.file,JSON.stringify({type:'session_meta',payload:{id:session,base_instructions:'x'.repeat(2*1024*1024)}})+'\n','utf8');
  f.append(start(),call('over-limit'));assert.equal(await f.read(),undefined);
});
