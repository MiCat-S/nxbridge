import test from 'node:test';
import { VERSION } from '../version.js';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync, existsSync, rmSync, renameSync, symlinkSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import path from 'node:path';
import { commitActivation, commitCache, recoverSetup } from '../install/setup-journal.js';
import { managedMarker, planShim } from '../install/installation.js';
import { fileHashes, type InstallReceipt } from '../install/runtime-install.js';
import {atomicJson,readJson} from '../shared/files.js';
import { processIdentity, liveProcess } from '../process/process.js';
import { temporary } from './support/temporary.js';

function activation(t:Parameters<typeof temporary>[0]){
  const directory=temporary(t),home=path.join(directory,'中文 安装'),bin=path.join(directory,'bin');mkdirSync(home,{recursive:true});mkdirSync(bin);
  const plan=planShim(home,{directories:[bin],pathValue:bin,entry:path.join(home,'runtime','新版','nxbridge.mjs')});
  const files=[...plan.launcher,...plan.files],old=files.map(file=>({...file,content:file.content+'\n'}));
  for(const file of old){mkdirSync(path.dirname(file.file),{recursive:true});writeFileSync(file.file,file.content,'utf8');}
  const state={version:1,marketplace:path.join(home,'marketplace'),managedFiles:old};
  atomicJson(path.join(home,'setup-state.json'),state);
  const receipt:InstallReceipt={owner:managedMarker(home),buildId:'新版',roots:[]};atomicJson(path.join(home,'install-manifest.json'),{...receipt,buildId:'旧版'});
  return{directory,home,bin,files,state,receipt,pending:path.join(home,'setup-pending.json')};
}
const failAt=(expected:string)=>(step:string)=>{if(step===expected)throw Error('隔离提交故障 '+step);};
function verified(f:ReturnType<typeof activation>){
  for(const file of f.files)assert.equal(readFileSync(file.file,'utf8'),file.content);
  assert.deepEqual(readJson<any>(path.join(f.home,'setup-state.json')).managedFiles,f.files);
  assert.deepEqual(readJson(path.join(f.home,'install-manifest.json')),f.receipt);assert.equal(existsSync(f.pending),false);
}

test('激活每个提交步骤故障注入：shim、指针、状态、receipt 及意图清理均可重放',async t=>{
  const sample=activation(t),steps:string[]=[];await commitActivation(sample.home,sample.state,sample.files,sample.receipt,step=>{steps.push(step);});
  assert.equal(steps.length,sample.files.length+4);
  for(const step of steps){
    const f=activation(t);await assert.rejects(commitActivation(f.home,f.state,f.files,f.receipt,failAt(step)),/隔离提交故障/);
    assert.equal(existsSync(f.pending),step!=='activation:complete');
    await recoverSetup(f.home);verified(f);
  }
});

test('激活恢复先核对全部文件，任何用户改动都列路径拒绝且不触碰其他提交文件',async t=>{
  const sample=activation(t);
  for(let index=0;index<sample.files.length+2;index++){
    const f=activation(t);await assert.rejects(commitActivation(f.home,f.state,f.files,f.receipt,failAt('activation:write:1')),/隔离提交故障/);
    const writes=readJson<any>(f.pending).writes,file=writes[index].file;writeFileSync(file,'用户中断后修改的内容','utf8');
    const before=writes.map((w:any)=>readFileSync(w.file,'utf8')),pending=readFileSync(f.pending,'utf8');
    await assert.rejects(recoverSetup(f.home),error=>(error as any).code==='setup_recovery_conflict'&&(error as Error).message.includes(file)&&(error as Error).message.includes('保存这些文件的副本')&&(error as Error).message.includes('再运行一次同样的命令'));
    assert.deepEqual(writes.map((w:any)=>readFileSync(w.file,'utf8')),before);assert.equal(readFileSync(f.pending,'utf8'),pending);
    writeFileSync(file,writes[index].after,'utf8');await recoverSetup(f.home);verified(f);
  }
});

test('待提交文件被改为目录或链接时列出具体路径并保留用户内容',async t=>{
  for(const kind of ['directory','link'] as const){
    const f=activation(t);await assert.rejects(commitActivation(f.home,f.state,f.files,f.receipt,failAt('activation:intent')),/隔离提交故障/);
    const file=f.files[0]!.file;rmSync(file);
    if(kind==='directory')mkdirSync(file);else symlinkSync(f.directory,file,process.platform==='win32'?'junction':'dir');
    await assert.rejects(recoverSetup(f.home),error=>(error as any).code==='setup_recovery_conflict'&&(error as Error).message.includes(file));assert.equal(existsSync(f.pending),true);
  }
});

test('pending dry-run 完全只读，活动安装不被重放，失效代次不误判为活动安装',async t=>{
  const f=activation(t);await assert.rejects(commitActivation(f.home,f.state,f.files,f.receipt,failAt('activation:intent')),/隔离提交故障/);
  const before=fileHashes(f.directory);await assert.rejects(recoverSetup(f.home,true),{code:'setup_recovery_pending'});assert.deepEqual(fileHashes(f.directory),before);
  const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{windowsHide:true,stdio:'ignore'}),closed=once(child,'close');
  t.after(async()=>{if(liveProcess(child.pid!))child.kill();await closed;});
  const identity=await processIdentity(child.pid!),intent=readJson<any>(f.pending);intent.process={pid:child.pid,startedAt:identity.startedAt};atomicJson(f.pending,intent);
  await assert.rejects(recoverSetup(f.home),{code:'setup_in_progress'});assert.equal(liveProcess(child.pid!),true);
  intent.process.startedAt='已经失效的旧代次';atomicJson(f.pending,intent);await recoverSetup(f.home);verified(f);assert.equal(liveProcess(child.pid!),true);
});

test('真正进程中断后，新进程无需人工编辑即可完成指针与 receipt 提交',async t=>{
  const f=activation(t),fixture=path.join(f.directory,'fixture.json');atomicJson(fixture,{home:f.home,state:f.state,files:f.files,receipt:f.receipt});
  const code=`import {readFileSync} from 'node:fs';import {commitActivation} from ${JSON.stringify(new URL('../install/setup-journal.js',import.meta.url).href)};const f=JSON.parse(readFileSync(process.argv[1],'utf8'));await commitActivation(f.home,f.state,f.files,f.receipt,step=>{if(step==='activation:write:2')process.exit(79);});`;
  const result=spawnSync(process.execPath,['--input-type=module','-e',code,fixture],{windowsHide:true,encoding:'utf8',timeout:10000});
  assert.equal(result.status,79,result.stderr);assert.equal(existsSync(f.pending),true);await recoverSetup(f.home);verified(f);
});

test('跨进程恢复互斥，持锁进程中断后由系统释放锁，普通重跑不需要删锁文件',async t=>{
  const f=activation(t);await assert.rejects(commitActivation(f.home,f.state,f.files,f.receipt,failAt('activation:intent')),/隔离提交故障/);
  const code="const {DatabaseSync}=require('node:sqlite');const db=new DatabaseSync(process.argv[1]);db.exec('BEGIN EXCLUSIVE');console.log('ready');setInterval(()=>{},1000);";
  const child=spawn(process.execPath,['--no-warnings','-e',code,path.join(f.home,'setup-recovery.db')],{windowsHide:true,stdio:['ignore','pipe','pipe']}),closed=once(child,'close');
  t.after(async()=>{if(liveProcess(child.pid!))child.kill();await closed;});
  await new Promise<void>((resolve,reject)=>{child.stdout.once('data',()=>resolve());child.once('error',reject);child.once('exit',()=>reject(Error('隔离恢复锁进程提前退出')));});
  const before=readFileSync(f.pending,'utf8');await assert.rejects(recoverSetup(f.home),{code:'setup_in_progress'});assert.equal(readFileSync(f.pending,'utf8'),before);
  child.kill();await closed;await recoverSetup(f.home);verified(f);assert.equal(existsSync(path.join(f.home,'setup-recovery.db')),true);
});

test('恢复记录解析失败或协议版本与归属不匹配时保留意图，兼容自有扩展字段',async t=>{
  const f=activation(t);await assert.rejects(commitActivation(f.home,f.state,f.files,f.receipt,failAt('activation:intent')),/隔离提交故障/);
  const intent=readJson<any>(f.pending),invalid=[{...intent,version:2},{...intent,owner:managedMarker(path.join(f.directory,'另一安装'))}];
  for(const value of invalid){atomicJson(f.pending,value);await assert.rejects(recoverSetup(f.home),error=>(error as any).code==='setup_recovery_conflict'&&(error as Error).message.includes(f.pending)&&(error as Error).message.includes('再运行一次同样的命令'));}
  writeFileSync(f.pending,'{损坏','utf8');await assert.rejects(recoverSetup(f.home),{code:'setup_recovery_conflict'});
  atomicJson(f.pending,{...intent,observedByNewerBuild:{result:'新的观测状态'}});await recoverSetup(f.home);verified(f);
});

function cache(t:Parameters<typeof temporary>[0]){
  const directory=temporary(t),home=path.join(directory,'bridge'),hostHome=path.join(directory,'官方清单目录'),source=path.join(home,'marketplace','plugins','codex'),target=path.join(hostHome,'plugins','cache','nxbridge-local','nxbridge',VERSION);
  for(const root of [source,target]){mkdirSync(path.join(root,'.codex-plugin'),{recursive:true});atomicJson(path.join(root,'.codex-plugin','plugin.json'),{name:'nxbridge'});atomicJson(path.join(root,'runtime.json'),{home});}
  atomicJson(path.join(home,'setup-state.json'),{hostHomes:{codex:path.join(directory,'不同的启动目录')}});
  writeFileSync(path.join(source,'changed.bin'),Buffer.from([0,255,23,87]));writeFileSync(path.join(target,'changed.bin'),Buffer.from([0,1]));
  writeFileSync(path.join(source,'new.txt'),'新增完整内容','utf8');writeFileSync(path.join(target,'obsolete.txt'),'删除的旧内容','utf8');
  return{directory,home,hostHome,source,target,pending:path.join(home,'setup-pending.json')};
}

test('提交前缓存归属冲突直接报告配置目录问题，不引用不存在的恢复记录',async t=>{
  for(const kind of ['foreign','unverifiable'] as const){
    const f=cache(t),runtime=path.join(f.target,'runtime.json');
    if(kind==='foreign')atomicJson(runtime,{home:path.join(f.directory,'另一套安装')});else rmSync(runtime);
    const before=fileHashes(f.target);
    await assert.rejects(commitCache(f.home,'codex',f.hostHome,f.source,f.target),error=>{
      assert.equal((error as any).code,'cache_conflict');const message=(error as Error).message;
      assert.ok(message.includes(f.target)&&message.includes(f.home));assert.match(message,/NXBRIDGE_HOME.*配置目录/);assert.doesNotMatch(message,/setup-pending\.json|中断的安装/);return true;
    });
    assert.deepEqual(fileHashes(f.target),before);assert.equal(existsSync(f.pending),false);
  }
});

test('缓存每个提交步骤故障注入：删除与逐文件复制均可恢复，官方清单的其他目录保留兼容',async t=>{
  const sample=cache(t),steps:string[]=[];await commitCache(sample.home,'codex',sample.hostHome,sample.source,sample.target,step=>{steps.push(step);});
  assert.ok(steps.includes('cache:codex:remove:obsolete.txt'));assert.ok(steps.includes('cache:codex:write:changed.bin'));
  for(const step of steps){
    const f=cache(t),before=fileHashes(f.target),after=fileHashes(f.source);
    await assert.rejects(commitCache(f.home,'codex',f.hostHome,f.source,f.target,failAt(step)),/隔离提交故障/);
    const current=fileHashes(f.target);for(const file of new Set([...Object.keys(current),...Object.keys(before),...Object.keys(after)]))assert.ok(current[file]===before[file]||current[file]===after[file],file+' 出现不完整内容');
    await recoverSetup(f.home);assert.deepEqual(fileHashes(f.target),after);assert.equal(existsSync(f.pending),false);
  }
});

test('缓存恢复保护新增、修改、删除和来源漂移，修复前不覆盖其他文件',async t=>{
  for(const change of ['new','modified','deleted','source'] as const){
    const f=cache(t);await assert.rejects(commitCache(f.home,'codex',f.hostHome,f.source,f.target,failAt('cache:codex:write:changed.bin')),/隔离提交故障/);
    const file=path.join(change==='source'?f.source:f.target,change==='new'?'用户新增.txt':'changed.bin');
    if(change==='deleted')rmSync(file);else writeFileSync(file,'用户的改动','utf8');
    const before=fileHashes(f.target);await assert.rejects(recoverSetup(f.home),error=>(error as any).code==='setup_recovery_conflict'&&(error as Error).message.includes(change==='source'?f.source:file));
    assert.deepEqual(fileHashes(f.target),before);assert.equal(existsSync(f.pending),true);
  }
});

test('缓存恢复拒绝根目录被换为链接，不删除链接指向的用户目录',async t=>{
  const f=cache(t);await assert.rejects(commitCache(f.home,'codex',f.hostHome,f.source,f.target,failAt('cache:codex:intent')),/隔离提交故障/);
  const moved=f.target+'.用户目录';renameSync(f.target,moved);symlinkSync(moved,f.target,process.platform==='win32'?'junction':'dir');
  const before=fileHashes(moved);await assert.rejects(recoverSetup(f.home),error=>(error as any).code==='setup_recovery_conflict'&&(error as Error).message.includes(f.target));assert.deepEqual(fileHashes(moved),before);
});
