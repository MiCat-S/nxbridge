import test from 'node:test';
import assert from 'node:assert/strict';
import { closeSync, existsSync, openSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import path from 'node:path';
import { atomicWriteText, retryWindowsFileOperation } from '../storage/atomic-file.js';
import { windowsFileLockOwners } from '../process/windows/windows-file-lock.js';
import {windowsPowerShell} from '../shared/windows-tools.js';
import { temporary } from './support/temporary.js';

test('Windows 短暂替换失败只对三种占用错误重试，总退避严格有界',()=>{
  for(const code of ['EPERM','EBUSY','EACCES']){
    let calls=0;const waits:number[]=[];
    const result=retryWindowsFileOperation(()=>{if(++calls<4)throw Object.assign(Error('占用'),{code});return '完成';},'文件',{platform:'win32',wait:ms=>{waits.push(ms);}});
    assert.equal(result,'完成');assert.equal(calls,4);assert.deepEqual(waits,[20,40,80]);
    calls=0;waits.length=0;const error=Object.assign(Error('持续占用'),{code});let diagnosis=0;
    assert.throws(()=>retryWindowsFileOperation(()=>{calls++;throw error;},'精确文件名',{platform:'win32',wait:ms=>{waits.push(ms);},diagnose:file=>{assert.equal(file,'精确文件名');diagnosis++;return 'PID 123 模拟占用程序。';}}),failure=>failure===error&&error.message.includes('精确文件名')&&error.message.includes('PID 123')&&error.message.includes('重新运行原命令'));
    assert.equal(calls,7);assert.equal(diagnosis,1);assert.deepEqual(waits,[20,40,80,160,320,640]);assert.equal(waits.reduce((sum,ms)=>sum+ms),1260);
  }
  for(const [platform,code] of [['linux','EPERM'],['darwin','EBUSY'],['win32','ENOENT'],['win32','EEXIST']] as const){
    let calls=0;const error=Object.assign(Error('原错误'),{code});
    assert.throws(()=>retryWindowsFileOperation(()=>{calls++;throw error;},'文件',{platform,wait:()=>assert.fail('不应等待'),diagnose:()=>assert.fail('不应诊断')}),failure=>failure===error);
    assert.equal(calls,1);assert.equal(error.message,'原错误');
  }
});

test('原子发布不覆盖已有意图，失败后旧内容保留且本次临时文件清理',t=>{
  const directory=temporary(t),file=path.join(directory,'状态 中文.json');
  atomicWriteText(file,'旧内容');
  assert.throws(()=>atomicWriteText(file,'新内容',true),{code:'EEXIST'});
  assert.equal(readFileSync(file,'utf8'),'旧内容');assert.deepEqual(readdirSync(directory),[path.basename(file)]);
  atomicWriteText(file,'完整新内容');assert.equal(readFileSync(file,'utf8'),'完整新内容');
  const exclusive=path.join(directory,'意图.json');atomicWriteText(exclusive,'完整意图',true);
  assert.equal(readFileSync(exclusive,'utf8'),'完整意图');assert.equal(readdirSync(directory).some(name=>name.endsWith('.tmp')),false);
});

test('普通 Node 读句柄的系统行为：Windows 占用可诊断，关闭后重跑替换；Unix 保留旧读句柄',t=>{
  const directory=temporary(t),file=path.join(directory,'状态.json');writeFileSync(file,'完整旧内容','utf8');
  const descriptor=openSync(file,'r');
  try{
    if(process.platform==='win32'){
      assert.throws(()=>atomicWriteText(file,'完整新内容'),error=>['EPERM','EACCES','EBUSY'].includes((error as NodeJS.ErrnoException).code??'')&&(error as Error).message.includes('PID '+process.pid));
      assert.equal(readFileSync(file,'utf8'),'完整旧内容');
    }else{atomicWriteText(file,'完整新内容');assert.equal(readFileSync(file,'utf8'),'完整新内容');}
    assert.equal(readFileSync(descriptor,'utf8'),'完整旧内容');
  }
  finally{closeSync(descriptor);}
  atomicWriteText(file,'完整新内容');assert.equal(readFileSync(file,'utf8'),'完整新内容');
});

async function lockFile(file:string,releaseAfter:number){
  const script="$stream=[IO.File]::Open($env:NX_TEST_LOCK_FILE,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::ReadWrite);try{[Console]::WriteLine('ready');[Console]::Out.Flush();if([int]$env:NX_TEST_RELEASE_MS -gt 0){[Threading.Thread]::Sleep([int]$env:NX_TEST_RELEASE_MS)}else{[void][Console]::ReadLine()}}finally{$stream.Dispose()}";
  const child=spawn(windowsPowerShell(),['-NoLogo','-NoProfile','-NonInteractive','-Command',script],{env:{...process.env,NX_TEST_LOCK_FILE:file,NX_TEST_RELEASE_MS:String(releaseAfter)},windowsHide:true,stdio:['pipe','pipe','pipe']});
  const closed=once(child,'close');let stderr='';child.stderr.on('data',data=>{stderr+=data;});
  await new Promise<void>((resolve,reject)=>{let output='';child.stdout.on('data',data=>{output+=data;if(output.includes('ready'))resolve();});child.once('error',reject);child.once('exit',code=>reject(Error(`隔离锁进程提前退出 ${code}：${stderr}`)));});
  return{child,closed,release:async()=>{child.stdin.end('\n');await closed;}};
}

test('Windows 无 share-delete 读锁：短暂占用自动恢复，持续占用不删目标并报告当前占用者',{skip:process.platform!=='win32'},async t=>{
  const directory=temporary(t),file=path.join(directory,'锁定 中文状态.json');writeFileSync(file,'完整旧内容','utf8');
  const transient=await lockFile(file,250);t.after(transient.release);
  atomicWriteText(file,'短暂占用后的完整内容');await transient.closed;
  assert.equal(readFileSync(file,'utf8'),'短暂占用后的完整内容');
  const persistent=await lockFile(file,0);t.after(persistent.release);
  assert.match(windowsFileLockOwners(file),new RegExp('PID '+persistent.child.pid+'(?: |\\b)'));
  const started=Date.now();assert.throws(()=>atomicWriteText(file,'禁止写入的内容'),error=>['EPERM','EACCES','EBUSY'].includes((error as NodeJS.ErrnoException).code??'')&&(error as Error).message.includes(file)&&(error as Error).message.includes('未删除'));
  assert.ok(Date.now()-started>=1200);assert.equal(readFileSync(file,'utf8'),'短暂占用后的完整内容');
  assert.equal(readdirSync(directory).some(name=>name.endsWith('.tmp')),false);await persistent.release();
  atomicWriteText(file,'关闭占用后的完整内容');assert.equal(existsSync(file),true);assert.equal(readFileSync(file,'utf8'),'关闭占用后的完整内容');
});
