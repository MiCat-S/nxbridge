import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { writeFileSync } from 'node:fs';
import { CodexAdapter } from '../hosts/codex/adapter.js';
import { ClaudeAdapter } from '../hosts/claude/adapter.js';
import { claudeChild, ensureClaudeChild } from '../hosts/claude/claude-child.js';
import { forgetNativeOwnership, nativeOwnership } from '../process/owned-native.js';
import { ownedProcesses } from '../process/owned-processes.js';
import { Store } from '../storage/store.js';
import {DEFAULT_CONFIG} from '../config/defaults.js';
import { temporary } from './support/temporary.js';
import type { RpcClient } from '../ipc/rpc.js';

test('Codex 运行时准备和连接失败仍可安全重试，只有原生新建前才写持久标记',async t=>{
  const home=temporary(t),store=new Store(':memory:'),peer=store.placeholder('codex',home),adapter=new CodexAdapter(DEFAULT_CONFIG,home);
  t.after(()=>{adapter.close();store.close();});
  let stage:'runtime'|'connect'|'ready'='runtime';const calls:string[]=[];
  adapter.ensureEndpoint=async(_cwd,_id,_requester,_session,_configHome,guard)=>{calls.push('runtime');await guard?.();if(stage==='runtime')throw Error('准备失败');return'ws://创建边界测试';};
  const rpc={request:async(method:string)=>{calls.push(method);if(method==='thread/start')throw Error('原生提交超时');return{};}} as RpcClient;
  adapter.connect=async()=>{calls.push('connect');if(stage==='connect')throw Error('连接失败');return rpc;};
  let marked=0;
  const create=()=>adapter.create(peer,undefined,()=>{calls.push('guard');},'bypass',()=>{marked++;calls.push('create');});
  await assert.rejects(create(),/准备失败/);assert.equal(marked,0);
  stage='connect';await assert.rejects(create(),/连接失败/);assert.equal(marked,0);
  stage='ready';await assert.rejects(create(),/原生提交超时/);assert.equal(marked,1);
  assert.deepEqual(calls.slice(-3),['guard','create','thread/start']);
});

test('Claude 原生创建在准备和启动守卫之后登记标记，标记失败结算未提交意图且不留下进程',async t=>{
  if(process.platform==='linux')t.mock.method(process as typeof process&{getuid:()=>number},'getuid',()=>1000);
  const home=temporary(t),store=new Store(':memory:'),peer=store.placeholder('claude',home),adapter=new ClaudeAdapter({...DEFAULT_CONFIG,claudeBinary:process.execPath,claudeHome:home},home);
  t.after(()=>{const binding=nativeOwnership(home,peer.id);if(binding)forgetNativeOwnership(binding);adapter.close();store.close();});
  writeFileSync(path.join(home,'settings.json'),JSON.stringify({skipDangerousModePermissionPrompt:true}),'utf8');
  let ready=false,marked=0;const failure=Error('标记处停止，禁止实际启动'),guardFailure=Error('启动守卫拒绝'),calls:string[]=[];
  const create=()=>adapter.create(peer,()=>{calls.push('guard');if(!ready)throw guardFailure;},'bypass',()=>{marked++;calls.push('create');throw failure;});
  writeFileSync(path.join(home,'.claude.json'),'{','utf8');
  await assert.rejects(create(),{code:'invalid_config'});assert.equal(marked,0);assert.equal(nativeOwnership(home,peer.id),undefined);assert.deepEqual(calls,[]);
  writeFileSync(path.join(home,'.claude.json'),'{}','utf8');
  await assert.rejects(create(),error=>error===guardFailure);assert.equal(marked,0);assert.equal(nativeOwnership(home,peer.id),undefined);
  ready=true;await assert.rejects(create(),error=>error===failure);assert.equal(marked,1);assert.equal(nativeOwnership(home,peer.id)?.phase,'failed');
  assert.deepEqual(calls.slice(-2),['guard','create']);
  await assert.rejects(create(),error=>error===failure);assert.equal(marked,2);assert.equal(nativeOwnership(home,peer.id)?.phase,'failed');
  const settled=nativeOwnership(home,peer.id)!;assert.equal(settled.handle,undefined);assert.equal(settled.native,undefined);assert.deepEqual(ownedProcesses(home).records,[]);
});

test('Claude 子进程在提交前持久保存 UUID，标记失败后的重试复用同一会话身份',{skip:process.platform!=='linux'},async t=>{
  t.mock.method(process as typeof process&{getuid:()=>number},'getuid',()=>1000);
  const home=temporary(t),store=new Store(':memory:'),peer=store.placeholder('claude',home),config={...DEFAULT_CONFIG,claudeBinary:process.execPath,claudeHome:home};
  t.after(()=>store.close());writeFileSync(path.join(home,'settings.json'),JSON.stringify({skipDangerousModePermissionPrompt:true}),'utf8');
  const failure=Error('标记处停止，禁止 worker 启动'),ids:string[]=[];
  const create=()=>ensureClaudeChild(home,config,peer,undefined,'bypass',()=>{const record=claudeChild(home,peer.id)!;assert.equal(record.phase,'starting');assert.equal(record.worker,undefined);ids.push(record.sessionId);throw failure;});
  await assert.rejects(create(),error=>error===failure);await assert.rejects(create(),error=>error===failure);
  assert.equal(ids.length,2);assert.match(ids[0]!,/^[a-f0-9-]{36}$/);assert.equal(ids[0],ids[1]);
});
