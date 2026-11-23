import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { pathToFileURL } from 'node:url';
import { temporary } from './support/temporary.js';
import {atomicJson,readJson} from '../shared/files.js';
import { fileHashes } from '../install/runtime-install.js';
import { managedMarker } from '../install/installation.js';
import { compareCacheVersions, pruneRetainedCodexCaches, recoverRetainedCaches, withRetainedCodexCaches } from '../install/plugin-cache-retention.js';

function fixture(t:Parameters<typeof temporary>[0]){
  const directory=temporary(t),home=path.join(directory,'bridge'),hostHome=path.join(directory,'codex'),base=path.join(hostHome,'plugins','cache','nxbridge-local','nxbridge'),old=path.join(base,'0.1.0'),fresh=path.join(base,'0.1.1');
  mkdirSync(home);mkdirSync(path.join(old,'.codex-plugin'),{recursive:true});
  atomicJson(path.join(old,'.codex-plugin','plugin.json'),{name:'nxbridge',version:'0.1.0'});atomicJson(path.join(old,'runtime.json'),{home});writeFileSync(path.join(old,'bridge.cjs'),'旧的已信任代码','utf8');
  return{home,hostHome,base,old,fresh,pending:path.join(home,'cache-retention-pending.json')};
}

test('官方 add 后保留旧缓存原字节；活宿主和未知状态阻止回收，后续无宿主时才清理',async t=>{
  const f=fixture(t),before=fileHashes(f.old);
  const result=await withRetainedCodexCaches(f.home,[f.hostHome],'0.1.1',async()=>{rmSync(f.old,{recursive:true});mkdirSync(f.fresh);writeFileSync(path.join(f.fresh,'new'),'新版');return'installed';});
  assert.equal(result.value,'installed');assert.deepEqual(fileHashes(f.old),before);assert.ok(existsSync(f.fresh));assert.equal(existsSync(f.pending),false);
  await withRetainedCodexCaches(f.home,[f.hostHome],'0.1.1',async()=>{rmSync(path.join(f.old,'bridge.cjs'));});assert.deepEqual(fileHashes(f.old),before,'原生只删掉部分文件时也必须恢复');
  const directories=[f.old,f.fresh];
  assert.deepEqual((await pruneRetainedCodexCaches(f.home,directories,[f.fresh],result.restored,async()=>{throw Error('本轮不应查询或清理刚恢复的目录');})).retained,[f.old]);
  assert.deepEqual((await pruneRetainedCodexCaches(f.home,directories,[f.fresh],[],async()=>[{pid:123,startedAt:'native-generation'}])).retained,[f.old]);
  assert.deepEqual((await pruneRetainedCodexCaches(f.home,directories,[f.fresh],[],async()=>{throw Error('无法核验');})).retained,[f.old]);
  assert.deepEqual((await pruneRetainedCodexCaches(f.home,directories,[f.fresh],[],async()=>[])).removed,[f.old]);assert.equal(existsSync(f.old),false);assert.ok(existsSync(f.fresh));
});

test('官方 add 失败仍恢复原缓存；恢复冲突保留用户内容和副本，dry-run 不写入',async t=>{
  const f=fixture(t),before=fileHashes(f.old);
  await assert.rejects(withRetainedCodexCaches(f.home,[f.hostHome],'0.1.1',async()=>{rmSync(f.old,{recursive:true});throw Error('原生 add 失败');}),/原生 add 失败/);
  assert.deepEqual(fileHashes(f.old),before);assert.equal(existsSync(f.pending),false);
  await assert.rejects(withRetainedCodexCaches(f.home,[f.hostHome],'0.1.1',async()=>{rmSync(f.old,{recursive:true});mkdirSync(f.old);writeFileSync(path.join(f.old,'user'),'用户内容');}),/旧缓存位置已有不同内容/);
  assert.equal(readFileSync(path.join(f.old,'user'),'utf8'),'用户内容');const pending=readFileSync(f.pending,'utf8');
  await assert.rejects(recoverRetainedCaches(f.home,true),/预览未修改/);assert.equal(readFileSync(f.pending,'utf8'),pending);
  rmSync(f.old,{recursive:true});await recoverRetainedCaches(f.home);assert.deepEqual(fileHashes(f.old),before);assert.equal(existsSync(f.pending),false);
});

test('恢复记录已发布但目录刷新失败时保留原字节副本，重试仍可恢复',{skip:process.platform==='win32'},async t=>{
  const f=fixture(t),before=fileHashes(f.old),fs=createRequire(import.meta.url)('node:fs') as typeof import('node:fs'),sync=fs.fsyncSync;
  t.mock.method(fs,'fsyncSync',(descriptor:number)=>{
    if(existsSync(f.pending)&&fs.fstatSync(descriptor).isDirectory())throw Object.assign(Error('模拟发布后的目录刷新失败'),{code:'EIO'});
    sync(descriptor);
  });
  syncBuiltinESMExports();
  try{
    await assert.rejects(withRetainedCodexCaches(f.home,[f.hostHome],'0.1.1',async()=>assert.fail('目录刷新失败后不能执行官方安装')),{code:'EIO'});
  }finally{t.mock.restoreAll();syncBuiltinESMExports();}

  const pending=readJson<{root:string;caches:{backup:string}[]}>(f.pending);
  assert.equal(pending.caches.length,1);
  assert.deepEqual(fileHashes(pending.caches[0]!.backup),before);
  rmSync(path.join(f.old,'bridge.cjs'));
  assert.deepEqual(await recoverRetainedCaches(f.home),[f.old]);
  assert.deepEqual(fileHashes(f.old),before);
  assert.equal(existsSync(f.pending),false);
  assert.equal(existsSync(pending.root),false);
});

test('安装进程在官方删除之后崩溃，下一次 update 能从持久记录恢复原字节',async t=>{
  const f=fixture(t),before=fileHashes(f.old),module=pathToFileURL(path.resolve('dist/install/plugin-cache-retention.js')).href;
  const script=`import{withRetainedCodexCaches}from ${JSON.stringify(module)};import{rmSync}from'node:fs';await withRetainedCodexCaches(${JSON.stringify(f.home)},[${JSON.stringify(f.hostHome)}],'0.1.1',async()=>{rmSync(${JSON.stringify(f.old)},{recursive:true});process.exit(17)});`;
  const result=spawnSync(process.execPath,['--input-type=module','-e',script],{windowsHide:true,timeout:15000});assert.equal(result.status,17,result.stderr?.toString());assert.equal(existsSync(f.old),false);assert.ok(existsSync(f.pending));
  const record=readJson<any>(f.pending);assert.notEqual(record.process.pid,process.pid);
  await recoverRetainedCaches(f.home);assert.deepEqual(fileHashes(f.old),before);assert.equal(existsSync(f.pending),false);
});

test('缓存副本清理拒绝越界、整个副本目录与链接父目录，保留恢复记录及用户文件',async t=>{
  for(const kind of ['outside','collection','linked-parent'] as const){
    const f=fixture(t),backups=path.join(f.home,'cache-retention-backups'),outside=path.join(f.home,'..','user-data');mkdirSync(outside);
    let root:string;
    if(kind==='linked-parent'){symlinkSync(outside,backups,process.platform==='win32'?'junction':'dir');root=path.join(backups,'saved');}
    else root=kind==='outside'?outside:backups;
    mkdirSync(root,{recursive:true});const keep=path.join(root,'keep.txt');writeFileSync(keep,'用户保留内容','utf8');
    atomicJson(f.pending,{owner:managedMarker(f.home),root,process:{pid:process.pid,startedAt:'当前进程'},caches:[]});
    const pending=readFileSync(f.pending,'utf8');
    await assert.rejects(recoverRetainedCaches(f.home),error=>(error as any).code==='cache_retention_pending'&&(error as Error).message.includes('cache-retention-backups'));
    assert.equal(readFileSync(keep,'utf8'),'用户保留内容');assert.equal(readFileSync(f.pending,'utf8'),pending);
  }
});

test('符号链接指向的私有目录仍可清理本轮副本，其他轮次副本保留',async t=>{
  const f=fixture(t),home=f.home+'-link';symlinkSync(f.home,home,process.platform==='win32'?'junction':'dir');
  const root=path.join(home,'cache-retention-backups','completed'),other=path.join(home,'cache-retention-backups','other');mkdirSync(root,{recursive:true});mkdirSync(other);writeFileSync(path.join(other,'keep.txt'),'其他轮次','utf8');
  atomicJson(f.pending,{owner:managedMarker(home),root,process:{pid:process.pid,startedAt:'当前进程'},caches:[]});
  assert.deepEqual(await recoverRetainedCaches(home),[]);assert.equal(existsSync(root),false);assert.equal(readFileSync(path.join(other,'keep.txt'),'utf8'),'其他轮次');assert.equal(existsSync(f.pending),false);
});

test('缓存选择保留原生 local、语义版本和非语义版本优先级，旧副本不会遮住目标版',()=>{
  for(const [left,right] of [['0.1.9','0.1.10'],['1.0.0-alpha.2','1.0.0-alpha.10'],['1.0.0-rc','1.0.0'],['0.1.1','local'],['aaa','zzz']])assert.ok(compareCacheVersions(left!,right!)<0,left+' / '+right);
  assert.equal(compareCacheVersions('1.0.0+old','1.0.0+new'),0);assert.ok(compareCacheVersions('local','9.0.0')>0);
});

test('同版本的其他安装缓存也不能交给官方覆盖，损坏恢复记录返回可处理的诊断',async t=>{
  const f=fixture(t);atomicJson(path.join(f.old,'runtime.json'),{home:path.join(f.home,'other')});let called=false;
  await assert.rejects(withRetainedCodexCaches(f.home,[f.hostHome],'0.1.0',async()=>{called=true;}),{code:'cache_retention_pending'});assert.equal(called,false);assert.ok(existsSync(f.old));
  writeFileSync(f.pending,'null','utf8');await assert.rejects(recoverRetainedCaches(f.home),{code:'cache_retention_pending'});assert.equal(readFileSync(f.pending,'utf8'),'null');
});
