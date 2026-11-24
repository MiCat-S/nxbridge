import test from 'node:test';
import assert from 'node:assert/strict';
import { closeSync, existsSync, openSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import {createRequire,syncBuiltinESMExports} from 'node:module';
import path from 'node:path';
import { atomicWriteText, retryWindowsFileOperation } from '../storage/atomic-file.js';
import { windowsFileLockOwners } from '../process/windows/windows-file-lock.js';
import {windowsPowerShell} from '../shared/windows-tools.js';
import { temporary } from './support/temporary.js';
import {atomicJson} from '../shared/files.js';
import {stateDirectory} from '../storage/state-directory.js';

const fs=createRequire(import.meta.url)('node:fs') as typeof import('node:fs');

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
  assert.throws(()=>atomicWriteText(file,'新内容',{exclusive:true}),{code:'EEXIST'});
  assert.equal(readFileSync(file,'utf8'),'旧内容');assert.deepEqual(readdirSync(directory),[path.basename(file)]);
  atomicWriteText(file,'完整新内容');assert.equal(readFileSync(file,'utf8'),'完整新内容');
  const exclusive=path.join(directory,'意图.json');atomicWriteText(exclusive,'完整意图',{exclusive:true});
  assert.equal(readFileSync(exclusive,'utf8'),'完整意图');assert.equal(readdirSync(directory).some(name=>name.endsWith('.tmp')),false);
});

test('JSON 状态默认刷新数据后发布并提交目录，可重建观测才显式使用缓冲',t=>{
  const directory=temporary(t),file=path.join(directory,'归属.json'),events:string[]=[];
  const write=fs.writeFileSync,rename=fs.renameSync,sync=fs.fsyncSync;
  t.mock.method(fs,'writeFileSync',((...args:any[])=>{Reflect.apply(write,fs,args);events.push(args[2]?.flush===true?'data-synced':'buffered');}) as typeof fs.writeFileSync);
  t.mock.method(fs,'renameSync',((...args:any[])=>{Reflect.apply(rename,fs,args);events.push('published');}) as typeof fs.renameSync);
  t.mock.method(fs,'fsyncSync',(descriptor:number)=>{const directory=fs.fstatSync(descriptor).isDirectory();sync(descriptor);if(directory)events.push('directory-synced');});
  syncBuiltinESMExports();
  try{
    atomicJson(file,{version:1,owner:'完整归属'});
    assert.deepEqual(events,process.platform==='win32'?['data-synced','published']:['data-synced','published','directory-synced']);
    events.length=0;
    atomicJson(file,{observation:'可重建'},{durability:'buffered'});
    assert.deepEqual(events,['buffered','published']);
  }finally{t.mock.restoreAll();syncBuiltinESMExports();}
  assert.deepEqual(JSON.parse(readFileSync(file,'utf8')),{observation:'可重建'});
});

test('发布前的数据刷新失败保留完整旧状态并清理本次临时文件',t=>{
  const directory=temporary(t),file=path.join(directory,'归属.json');writeFileSync(file,'{"owner":"原代次"}','utf8');
  const write=fs.writeFileSync;
  t.mock.method(fs,'writeFileSync',((...args:any[])=>{
    assert.equal(args[2]?.flush,true);
    Reflect.apply(write,fs,[args[0],args[1],{...args[2],flush:false}]);
    throw Object.assign(Error('模拟磁盘刷新失败'),{code:'EIO'});
  }) as typeof fs.writeFileSync);syncBuiltinESMExports();
  try{assert.throws(()=>atomicJson(file,{owner:'新代次'}),{code:'EIO'});}
  finally{t.mock.restoreAll();syncBuiltinESMExports();}
  assert.deepEqual(JSON.parse(readFileSync(file,'utf8')),{owner:'原代次'});
  assert.deepEqual(readdirSync(directory),[path.basename(file)]);
});

test('发布后的目录刷新失败保持完整新内容并报告未完成持久化',{skip:process.platform==='win32'},t=>{
  const directory=temporary(t),file=path.join(directory,'归属.json');writeFileSync(file,'{"owner":"原代次"}','utf8');
  const sync=fs.fsyncSync;
  t.mock.method(fs,'fsyncSync',(descriptor:number)=>{if(fs.fstatSync(descriptor).isDirectory())throw Object.assign(Error('模拟目录刷新失败'),{code:'EIO'});sync(descriptor);});syncBuiltinESMExports();
  try{assert.throws(()=>atomicJson(file,{owner:'新代次'}),{code:'EIO'});}
  finally{t.mock.restoreAll();syncBuiltinESMExports();}
  assert.deepEqual(JSON.parse(readFileSync(file,'utf8')),{owner:'新代次'});
  assert.deepEqual(readdirSync(directory),[path.basename(file)]);
});

test('首次创建多层状态目录会提交新目录及其原有父目录',t=>{
  const base=temporary(t),first=path.join(base,'归属'),leaf=path.join(first,'当前代次'),opened:string[]=[];
  const open=fs.openSync;
  t.mock.method(fs,'openSync',((...args:any[])=>{if(args[1]==='r')opened.push(path.resolve(String(args[0])));return Reflect.apply(open,fs,args);}) as typeof fs.openSync);syncBuiltinESMExports();
  try{
    assert.equal(path.toNamespacedPath(stateDirectory(leaf,0o700)!),path.toNamespacedPath(first));
    assert.deepEqual(opened,process.platform==='win32'?[]:[leaf,first,base]);
    opened.length=0;assert.equal(stateDirectory(leaf,0o700),undefined);assert.deepEqual(opened,[]);
  }finally{t.mock.restoreAll();syncBuiltinESMExports();}
});

test('首次目录提交失败后，即使目录已存在也会重新提交',{skip:process.platform==='win32'},t=>{
  const base=temporary(t),directory=path.join(base,'未提交','当前'),sync=fs.fsyncSync;let fail=true,calls=0;
  t.mock.method(fs,'fsyncSync',(descriptor:number)=>{calls++;if(fail){fail=false;throw Object.assign(Error('模拟首次目录提交失败'),{code:'EIO'});}sync(descriptor);});syncBuiltinESMExports();
  try{
    assert.throws(()=>stateDirectory(directory),{code:'EIO'});assert.equal(calls,1);
    assert.equal(stateDirectory(directory),undefined);assert.equal(calls,4);
  }finally{t.mock.restoreAll();syncBuiltinESMExports();}
});

test('状态目录先规范化路径，不创建被取消的层级',t=>{
  const base=temporary(t),existing=path.join(base,'已有');fs.mkdirSync(existing);
  const directory=existing+path.sep+'被取消'+path.sep+'..'+path.sep+'..'+path.sep+'正式';
  assert.equal(path.toNamespacedPath(stateDirectory(directory)!),path.toNamespacedPath(path.join(base,'正式')));
  assert.equal(existsSync(path.join(existing,'被取消')),false);
});

test('本进程删除并重建同名状态目录时仍提交新目录链',{skip:process.platform==='win32'},t=>{
  const base=temporary(t),directory=path.join(base,'重建');stateDirectory(directory);
  const opened:string[]=[],open=fs.openSync;
  try{
    fs.rmdirSync(directory);
    t.mock.method(fs,'openSync',((...args:any[])=>{if(args[1]==='r')opened.push(path.resolve(String(args[0])));return Reflect.apply(open,fs,args);}) as typeof fs.openSync);syncBuiltinESMExports();
    assert.equal(stateDirectory(directory),directory);
    assert.deepEqual(opened,[directory,base]);
  }finally{t.mock.restoreAll();syncBuiltinESMExports();}
});

test('已有状态目录不读取祖先，可写但不可读的目录仍可原子发布',{skip:process.platform==='win32'},t=>{
  const base=temporary(t),directory=path.join(base,'已有'),file=path.join(directory,'归属.json'),opened:string[]=[];
  fs.mkdirSync(directory);const open=fs.openSync;
  t.mock.method(fs,'openSync',((...args:any[])=>{
    if(args[1]==='r'){
      const current=path.resolve(String(args[0]));opened.push(current);assert.equal(current,directory);
      throw Object.assign(Error('目录可写但不可读'),{code:'EACCES'});
    }
    return Reflect.apply(open,fs,args);
  }) as typeof fs.openSync);syncBuiltinESMExports();
  try{
    assert.equal(stateDirectory(directory),undefined);assert.deepEqual(opened,[]);
    atomicJson(file,{owner:'完整归属'});assert.deepEqual(opened,[directory]);
  }finally{t.mock.restoreAll();syncBuiltinESMExports();}
  assert.deepEqual(JSON.parse(readFileSync(file,'utf8')),{owner:'完整归属'});
});

test('挂载不支持目录刷新时仍刷新文件并发布，真正的 I/O 错误仍由原路径报告',{skip:process.platform==='win32'},t=>{
  const base=temporary(t),sync=fs.fsyncSync;let code='';const attempted:string[]=[];
  t.mock.method(fs,'fsyncSync',(descriptor:number)=>{
    if(fs.fstatSync(descriptor).isDirectory()){attempted.push(code);throw Object.assign(Error('挂载拒绝目录刷新'),{code});}
    sync(descriptor);
  });syncBuiltinESMExports();
  try{
    for(code of ['EACCES','EPERM','EINVAL','ENOTSUP','EOPNOTSUPP','ENOSYS']){
      const directory=path.join(base,code),file=path.join(directory,'归属.json');stateDirectory(directory);
      atomicJson(file,{owner:code});assert.deepEqual(JSON.parse(readFileSync(file,'utf8')),{owner:code});
      assert.equal(attempted.filter(value=>value===code).length,3);
    }
  }finally{t.mock.restoreAll();syncBuiltinESMExports();}
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
