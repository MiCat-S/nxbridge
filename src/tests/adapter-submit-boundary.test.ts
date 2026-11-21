import test from 'node:test';
import assert from 'node:assert/strict';
import { CodexAdapter } from '../hosts/codex/adapter.js';
import { ClaudeAdapter } from '../hosts/claude/adapter.js';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { Store } from '../storage/store.js';
import {DEFAULT_CONFIG} from '../config/defaults.js';
import { temporary } from './support/temporary.js';
import { beginNativeLaunch, nativeOwnership, forgetNativeOwnership } from '../process/owned-native.js';

for(const disable of [false,true])test('新 Codex 后台只在真实原生变更前执行守卫，关闭状态不会穿过异步边界：'+disable,async t=>{
  const home=temporary(t),adapter=new CodexAdapter(DEFAULT_CONFIG,home),store=new Store(':memory:'),peer=store.placeholder('codex',home),calls:string[]=[];
  t.after(()=>{adapter.close();store.close();});
  adapter.ensureEndpoint=async()=>{calls.push('endpoint');return'ws://127.0.0.1:1234';};
  adapter.connect=async()=>{await Promise.resolve();if(disable)adapter.setEnabled(peer,undefined,false);return{request:async(method:string)=>{calls.push(method);if(method==='thread/start')return{thread:{id:'created',cwd:home},approvalPolicy:'never',approvalsReviewer:'user',sandbox:{type:'dangerFullAccess'}};return{};}} as any;};
  const create=adapter.create(peer,undefined,async()=>{calls.push('guard');},'bypass');
  if(disable){await assert.rejects(create,{code:'member_disabled'});assert.deepEqual(calls,['endpoint']);}
  else{assert.equal((await create).sessionId,'created');assert.deepEqual(calls,['endpoint','guard','thread/start','guard','thread/settings/update','thread/name/set']);}
});

test('新 Claude 后台直接进入带守卫的创建流程，不预查全部原生会话',{skip:process.platform==='linux'&&process.getuid?.()===0},async t=>{
  const home=temporary(t),store=new Store(':memory:'),peer=store.placeholder('claude',home),adapter=new ClaudeAdapter({...DEFAULT_CONFIG,claudeBinary:process.execPath,claudeHome:home},home);
  t.after(()=>{adapter.close();store.close();});
  writeFileSync(path.join(home,'.claude.json'),JSON.stringify({bypassPermissionsModeAccepted:true}),'utf8');
  let lists=0;adapter.list=async()=>{lists++;throw new Error('不应预查会话');};
  await assert.rejects(adapter.create(peer,()=>{throw new Error('创建守卫已执行');}),/创建守卫已执行/);
  assert.equal(lists,0);
});

test('已有 Claude 启动记录的异步核验期间关闭成员，不能继续认领后台',async t=>{
  const home=temporary(t),store=new Store(':memory:'),peer=store.placeholder('claude',home),adapter=new ClaudeAdapter({...DEFAULT_CONFIG,claudeBinary:process.execPath,claudeHome:home},home);
  t.after(()=>{const binding=nativeOwnership(home,peer.id);if(binding)forgetNativeOwnership(binding);adapter.close();store.close();});
  await beginNativeLaunch(home,peer,home);
  adapter.list=async()=>{await Promise.resolve();adapter.setEnabled(peer,undefined,false);return[];};
  await assert.rejects(adapter.create(peer),{code:'member_disabled'});
});
