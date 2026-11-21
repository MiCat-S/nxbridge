import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { copyFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { temporary } from './support/temporary.js';
import {PACKAGE_ROOT} from '../shared/package-location.js';
import { WAKE_NOTICE, HEALTH_WAKE_NOTICE } from '../types.js';

async function invoke(script:string,input:unknown,options:{age?:number;openStdin?:boolean;code?:number}={}){
  const start=performance.now(),child=spawn(process.execPath,['--no-warnings','--input-type=module','-e',script],{env:{...process.env,NXBRIDGE_HOOK_STARTED_AT:String(Date.now()-(options.age??0))},windowsHide:true,stdio:['pipe','pipe','pipe']});
  child.stdout.setEncoding('utf8');child.stderr.setEncoding('utf8');
  let out='',err='';child.stdout.on('data',data=>out+=data);child.stderr.on('data',data=>err+=data);
  const ended=once(child,'close');if(!options.openStdin)child.stdin.end(JSON.stringify(input));
  try{const [code]=await ended;assert.equal(code,options.code??0,err);return{result:out?JSON.parse(out):undefined,out,err,wall:performance.now()-start};}
  finally{if(child.exitCode===null&&child.signalCode===null)child.kill();}
}
const runner=pathToFileURL(path.join(PACKAGE_ROOT,'dist/integration/hooks/hook-command.js')).href;
const script=(execute:string)=>`import {hookCommand} from ${JSON.stringify(runner)};await hookCommand(['--host','codex'],${execute});`;

test('短事件总预算覆盖未关闭 stdin、异步模块加载和悬挂写后回执',{timeout:20000},async t=>{
  const stdin=await invoke(script('async()=>({})'),{}, {openStdin:true});assert.match(stdin.result.systemMessage,/timed out after 3s/);assert.ok(stdin.wall<3000,JSON.stringify(stdin));
                                         
  const directory=temporary(t),entry=path.join(directory,'hook-entry.mjs');copyFileSync(path.join(PACKAGE_ROOT,'publish/hook-entry.mjs'),entry);
  writeFileSync(path.join(directory,'hook-control.mjs'),'await new Promise(()=>{});export async function hook(){}','utf8');
  const loading=await invoke(`process.argv=[process.execPath,${JSON.stringify(entry)},'hook','--host','codex'];await import(${JSON.stringify(pathToFileURL(entry).href)});`,{hook_event_name:'Interrupt'},{age:1800});
  assert.match(loading.result.systemMessage,/timed out after 3s/);assert.ok(loading.wall<3000,JSON.stringify(loading));
  const ack=await invoke(script("async(_host,_input,provided)=>{provided(async()=>new Promise(()=>{}));return{hookSpecificOutput:{hookEventName:'Interrupt',additionalContext:'已写出的通知'}};}"),{hook_event_name:'Interrupt'},{age:1800});
  assert.equal(ack.result.hookSpecificOutput.additionalContext,'已写出的通知');assert.ok(ack.wall<3000,JSON.stringify(ack));
});

test('总预算保留短事件的在途变更时间，PreToolUse 超时仍拒绝未展开引用',{timeout:15000},async()=>{
  const mutation=await invoke(script("async()=>{await new Promise(resolve=>setTimeout(resolve,150));process.stderr.write('mutation-complete');return{};}"),{hook_event_name:'SessionEnd'},{age:1800});
  assert.match(mutation.err,/mutation-complete/);assert.ok(mutation.wall>=150);assert.deepEqual(mutation.result,{});
  const denied=await invoke(script('async()=>new Promise(()=>{})'),{hook_event_name:'PreToolUse',tool_input:{message:'任务 nxref:msg:pending'}});
  assert.equal(denied.result.hookSpecificOutput.permissionDecision,'deny');assert.match(denied.result.hookSpecificOutput.permissionDecisionReason,/nxref not expanded/);assert.ok(denied.wall<10000,JSON.stringify(denied));
});

test('加载或执行失败及总预算超时都不能放行未经核验的唤醒',{timeout:20000},async()=>{
  for(const prompt of [WAKE_NOTICE,HEALTH_WAKE_NOTICE]){
    const failed=await invoke(script("async()=>{throw Error('隔离加载失败');}"),{hook_event_name:'UserPromptSubmit',prompt});
    assert.equal(failed.result.continue,false);assert.match(failed.err,/隔离加载失败/);
  }
  const timeout=await invoke(script('async()=>new Promise(()=>{})'),{hook_event_name:'UserPromptSubmit',prompt:WAKE_NOTICE});
  assert.equal(timeout.result.continue,false);assert.ok(timeout.wall<10000,JSON.stringify(timeout));
  assert.match(timeout.result.systemMessage,/timed out after 10s/);
});

test('总预算到达时等待已经开始的异步输出，长上下文不会被截断',{timeout:5000},async()=>{
  const delayed=`const write=process.stdout.write.bind(process.stdout);process.stdout.write=(chunk,callback)=>{const elapsed=performance.timeOrigin-Number(process.env.NXBRIDGE_HOOK_STARTED_AT)+performance.now();setTimeout(()=>write(chunk,callback),Math.max(0,2750-elapsed));return true;};`;
  const value=await invoke(delayed+script("async()=>({hookSpecificOutput:{hookEventName:'Interrupt',additionalContext:'完整上下文'.repeat(40000)}})"),{hook_event_name:'Interrupt'},{age:2300});
  assert.equal(value.result.hookSpecificOutput.additionalContext,'完整上下文'.repeat(40000));assert.ok(value.wall<1000);
});

test('退出保护器用 stderr 和退出码1，SessionStart 保留锚点，控制命令仍拦截',{timeout:20000},async()=>{
  const end=await invoke(script('async()=>new Promise(()=>{})'),{hook_event_name:'SessionEnd'},{age:2300,code:1});assert.equal(end.out,'');assert.match(end.err,/nxbridge hook timed out after 3s/);
                                        
  const [start,control]=await Promise.all([
    invoke(script('async()=>new Promise(()=>{})'),{hook_event_name:'SessionStart'},{age:1800}),
    invoke(script('async()=>new Promise(()=>{})'),{hook_event_name:'UserPromptSubmit',prompt:'nxbridge off'},{age:1800}),
  ]);
  assert.match(start.result.systemMessage,/timed out after 10s/);assert.match(start.result.hookSpecificOutput.additionalContext,/standing developer instructions/);
  assert.equal(control.result.decision,'block');assert.match(control.result.systemMessage,/timed out after 10s/);
});
