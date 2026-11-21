import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { appendFileSync, writeFileSync } from 'node:fs';
import { readCodexHistory } from '../hosts/codex/codex-history.js';
import { readSessionProfile } from '../hosts/codex/codex-session-profile.js';
import { temporary } from './support/temporary.js';

const row=(type:string,payload:unknown)=>JSON.stringify({timestamp:'2026-11-14T00:00:00Z',type,payload})+'\n';
const meta=(id:string,extra:Record<string,unknown>={})=>row('session_meta',{id,...extra});
const call=(id:string)=>row('response_item',{type:'function_call',name:'receive_messages',namespace:'claude',call_id:id});
const output=(id:string)=>row('response_item',{type:'function_call_output',call_id:id,output:JSON.stringify({messages:[{message_id:id}]})});

test('分叉历史的祖先元数据不破坏唯一有序回执，首条身份仍须匹配目标',async t=>{
  const file=path.join(temporary(t),'fork.jsonl');
  writeFileSync(file,meta('child')+meta('parent')+call('received')+meta('grandparent')+output('received'),'utf8');
  const child=await readCodexHistory(file,'child');
  assert.equal(child.status,'supported');assert.equal(child.complete,true);assert.deepEqual(child.receipts.map(value=>value.messageId),['received']);
  for(const sessionId of ['parent','grandparent'])assert.equal((await readCodexHistory(file,sessionId)).status,'unsupported');
  const wrong=path.join(path.dirname(file),'wrong-first.jsonl');
  writeFileSync(wrong,meta('parent')+meta('child')+call('wrong')+output('wrong'),'utf8');
  assert.equal((await readCodexHistory(wrong,'child')).status,'unsupported');
  assert.equal((await readSessionProfile(wrong,'child')).verified,false);
});

test('祖先元数据在增量、尾部与游标续读中均不使目标历史失效',async t=>{
  const file=path.join(temporary(t),'append.jsonl');writeFileSync(file,meta('child'),'utf8');
  const initial=await readCodexHistory(file,'child');assert.equal(initial.status,'supported');
  assert.equal((await readCodexHistory(file,'child',{tail:true})).status,'supported');
  appendFileSync(file,meta('parent')+call('later')+output('later'),'utf8');
  for(const options of [{},{tail:true},{cursor:initial.cursor},{since:0}]){
    const result=await readCodexHistory(file,'child',options);
    assert.equal(result.status,'supported');assert.equal(result.complete,true);assert.deepEqual(result.receipts.map(value=>value.messageId),['later']);
  }
  assert.equal((await readCodexHistory(file,'parent',{cursor:initial.cursor})).status,'unsupported');
});

test('分叉设置冷读及增量读取保留首条来源，并继续按顺序读取目标权限',async t=>{
  const directory=temporary(t),file=path.join(directory,'profile.jsonl');
  const first=meta('child',{cwd:directory,model_provider:'child-provider',cli_version:'0.166.0'})+row('turn_context',{model:'inherited',approval_policy:'never',sandbox_policy:{type:'read-only'}});
  const later=meta('parent',{cwd:'parent-directory',model_provider:'parent-provider',cli_version:'0.165.0'})+row('event_msg',{type:'thread_settings_applied',thread_id:'child',thread_settings:{model:'child-model',approval_policy:'on-request',approvals_reviewer:'user',sandbox_policy:{type:'workspace-write'}}});
  writeFileSync(file,first,'utf8');assert.equal((await readSessionProfile(file,'child')).verified,true);
  appendFileSync(file,later,'utf8');
  const cold=path.join(directory,'cold.jsonl');writeFileSync(cold,first+later,'utf8');
  for(const filename of [file,cold]){
    const profile=await readSessionProfile(filename,'child');
    assert.equal(profile.verified,true);assert.equal(profile.complete,true);
    assert.deepEqual(profile.meta,{id:'child',cwd:directory,model_provider:'child-provider',cli_version:'0.166.0',history_mode:undefined});
    assert.deepEqual(profile.settings,{model:'child-model',approvalPolicy:'on-request',approvalsReviewer:'user',sandbox:{type:'workspace-write'}});
    assert.equal((await readSessionProfile(filename,'parent')).verified,false);
  }
});

test('首条身份错误或格式损坏的权限缓存不会在重复读取时变成已核验',async t=>{
  const directory=temporary(t);
  for(const [name,prefix] of [['wrong-first',meta('parent')],['malformed','{\n']] as const){
    const file=path.join(directory,name+'.jsonl');
    writeFileSync(file,prefix+meta('child')+row('turn_context',{approval_policy:'never',sandbox_policy:{type:'danger-full-access'}}),'utf8');
    for(let attempt=0;attempt<3;attempt++){
      const profile=await readSessionProfile(file,'child');
      assert.equal(profile.verified,false);assert.deepEqual(profile.settings,{});assert.deepEqual(profile.meta,{});
      assert.equal((await readCodexHistory(file,'child')).status,'unsupported');
    }
  }
});
