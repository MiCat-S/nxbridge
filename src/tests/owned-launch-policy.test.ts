import test from 'node:test';
import assert from 'node:assert/strict';
import { ownedClaudeArgs, ownedCodexPolicy, startOwnedCodex } from '../hosts/owned-launch-policy.js';
import type { RpcClient } from '../ipc/rpc.js';

const result=(reviewer='user',approval='never',sandbox='dangerFullAccess')=>({thread:{id:'new-owned'},approvalsReviewer:reviewer,approvalPolicy:approval,sandbox:{type:sandbox}});
test('新后台按来源类别选择无人审批策略；Claude 仅为跨类或未知发送方开启本会话接收',()=>{
  for(const source of ['prompting','unknown'] as const)assert.equal(ownedCodexPolicy(source).approvalsReviewer,'auto_review');
  assert.equal(ownedCodexPolicy('bypass').approvalPolicy,'never');assert.equal(ownedCodexPolicy('bypass').sandbox,'danger-full-access');
  assert.deepEqual(ownedClaudeArgs('bypass'),['--permission-mode','bypassPermissions']);
  for(const source of ['prompting','unknown'] as const)assert.equal(JSON.parse(ownedClaudeArgs(source).at(-1)!).crossSessionInbound,'accept');
  assert.deepEqual(JSON.parse(ownedClaudeArgs('prompting',{model:'opus',effort:'high'}).at(-1)!),{crossSessionInbound:'accept',model:'opus',effortLevel:'high'});
  assert.deepEqual(JSON.parse(ownedClaudeArgs('bypass',{model:'sonnet'}).at(-1)!),{model:'sonnet'});
});
test('原生审核能力未采用时只回收本次空线程，再核验新后台实际完整访问',async()=>{
  const calls:{method:string;params:any}[]=[];let starts=0;
  const rpc={request:async(method:string,params:any)=>{calls.push({method,params});return method==='thread/start'?++starts===1?result('user','on-request','workspaceWrite'):result():{};}} as RpcClient;
  await startOwnedCodex(rpc,'/project','prompting');
  assert.deepEqual(calls.map(c=>c.method),['thread/start','thread/delete','thread/loaded/list','thread/start','thread/settings/update']);assert.equal(calls[3]!.params.approvalPolicy,'never');assert.equal(calls[4]!.params.threadId,'new-owned');
});
test('自动审核成功无需降级；不确定启动结果不能重复创建，管理策略不允许的权限不能冒充成功',async()=>{
  const calls:string[]=[];const rpc={request:async(method:string)=>{calls.push(method);return result('auto_review','on-request','workspaceWrite');}} as RpcClient;
  await startOwnedCodex(rpc,'/project','prompting');assert.deepEqual(calls,['thread/start','thread/settings/update']);
  calls.length=0;rpc.request=async(method:string)=>{calls.push(method);throw Object.assign(Error('timeout'),{code:'timeout'});};await assert.rejects(startOwnedCodex(rpc,'/project','prompting'),/timeout/);assert.deepEqual(calls,['thread/start']);
  calls.length=0;(rpc as any).request=async(method:string)=>{calls.push(method);return result('user','on-request','readOnly');};await assert.rejects(startOwnedCodex(rpc,'/project','bypass'),{code:'autonomous_policy_unavailable'});assert.deepEqual(calls,['thread/start','thread/delete','thread/loaded/list']);
});

test('持久创建标记紧邻原生新建，参数拒绝与已回收空线程的安全重建都重新经过标记',async()=>{
  for(const fallback of ['无降级','参数拒绝','空线程回收'] as const){
    const calls:string[]=[];let starts=0;
    const rpc={request:async(method:string)=>{
      calls.push(method);
      if(method!=='thread/start')return{};
      if(++starts===1&&fallback==='参数拒绝')throw Object.assign(Error('参数不支持'),{code:-32602});
      return starts===1&&fallback==='空线程回收'?result('user','on-request','workspaceWrite'):fallback==='无降级'?result('auto_review','on-request','workspaceWrite'):result();
    }} as RpcClient;
    await startOwnedCodex(rpc,'/project','prompting',()=>{calls.push('guard');},()=>{calls.push('create');});
    assert.equal(calls.filter(value=>value==='create').length,fallback==='无降级'?1:2);
    for(let index=0;index<calls.length;index++)if(calls[index]==='thread/start')assert.deepEqual(calls.slice(index-2,index),['guard','create']);
    assert.deepEqual(calls.slice(-2),['guard','thread/settings/update'],'设置更新仅检查可重复守卫');
  }
});

test('守卫或持久标记失败不提交且不误判为原生参数拒绝；提交超时不重新创建',async()=>{
  for(const stage of ['guard','create','native'] as const){
    const calls:string[]=[],failure=Object.assign(Error('创建边界拒绝'),{code:stage==='native'?'timeout':-32602});
    const rpc={request:async(method:string)=>{calls.push(method);throw failure;}} as unknown as RpcClient;
    await assert.rejects(startOwnedCodex(rpc,'/project','prompting',()=>{calls.push('guard');if(stage==='guard')throw failure;},()=>{calls.push('create');if(stage==='create')throw failure;}),error=>error===failure);
    assert.deepEqual(calls,stage==='guard'?['guard']:stage==='create'?['guard','create']:['guard','create','thread/start']);
  }
});
