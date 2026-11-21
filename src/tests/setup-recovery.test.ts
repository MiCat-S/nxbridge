import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, openSync, closeSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { cp } from 'node:fs/promises';
import path from 'node:path';
import { preparePlugins, setup, uninstall } from '../install/setup.js';
import {atomicJson,readJson} from '../shared/files.js';
import {PACKAGE_ROOT} from '../shared/package-location.js';
import {loadConfig} from '../config/load.js';
import { activeRuntime, fileHashes } from '../install/runtime-install.js';
import { registration } from './support/registration.js';
import { Store } from '../storage/store.js';

import { fixture } from './setup-fixture.js';

async function recoveryRelease(directory:string,filename='nxbridge-collaboration.md'){
  const source=path.join(directory,'新的发布来源');await cp(path.join(PACKAGE_ROOT,'publish'),source,{recursive:true});
  const guide=path.join(source,filename);writeFileSync(guide,readFileSync(guide,'utf8')+'\n'+(filename.endsWith('.mjs')?'// ':'')+'隔离的中断恢复版本\n','utf8');
  const manifest=readJson<any>(path.join(source,'publish.json'));manifest.files=fileHashes(source,['publish.json']);
  manifest.buildId=manifest.version+'-'+createHash('sha256').update(JSON.stringify({files:manifest.files,dependencies:manifest.dependencies})).digest('hex').slice(0,12);atomicJson(path.join(source,'publish.json'),manifest);
  return{source,buildId:manifest.buildId};
}

test('仅长驻入口代码变化也提示对应窗口重载，同一版本重复更新无需再次操作',async t=>{
  for(const [entry,required] of [['mcp-entry.mjs',{claude:true,codex:true}],['mod-entry.mjs',{claude:true,codex:false}],['vendor-core.mjs',{claude:true,codex:true}],['runtime-native-source.mjs',{claude:true,codex:true}]] as const){
    const f=fixture(t);await setup({home:f.home},f.services);
    const release=await recoveryRelease(f.directory,entry),updated=await setup({home:f.home,from:release.source},f.services) as any;
    assert.deepEqual(updated.reloadRequired,required);assert.equal(updated.hookTrustRequired,false);
    assert.equal(updated.next.some((value:string)=>value.includes('nxbridge restart codex')),required.codex);
    assert.ok(updated.next.some((value:string)=>value.includes('/reload-plugins')));
    assert.deepEqual((await setup({home:f.home,from:release.source},f.services) as any).reloadRequired,{claude:false,codex:false});
  }
});

test('显式正式来源可替换手工未知构建，保留配对、未知投递、禁用状态且忽略旧 adopt 文件',async t=>{
  const f=fixture(t);await setup({home:f.home},f.services);
  const old=activeRuntime(f.home)!,buildId='0.1.1-0badcafe0001',directory=path.join(f.home,'runtime',buildId);
  renameSync(old.directory,directory);
  for(const name of ['publish.json','.nxbridge-runtime.json']){
    const file=path.join(directory,name);atomicJson(file,{...readJson<any>(file),buildId});
  }
  atomicJson(path.join(f.home,'bin','runtime.json'),{...old,buildId,directory,entry:path.join(directory,'nxbridge.mjs')});
                                           
  const stateFile=path.join(f.home,'setup-state.json'),state=readJson<any>(stateFile);
  for(const file of state.managedFiles)file.content=readFileSync(file.file,'utf8');atomicJson(stateFile,state);
  const receipt=path.join(f.home,'install-manifest.json');atomicJson(receipt,{...readJson<any>(receipt),buildId});
  const obsolete=path.join(f.home,'adopt-codex.json'),obsoleteText='{"sessionId":"未经授权的旧文件"}';writeFileSync(obsolete,obsoleteText,'utf8');
  const store=new Store(path.join(f.home,'nxbridge.db'));
  try{
  const claude=store.register(registration('claude','unknown-build-source')),codex=store.register(registration('codex','preserved-session'));
  const pair=store.pair(claude.id,codex.id),message=store.accept(pair,claude,'未知投递必须保留','unknown-build-call');
  store.claim(message.id);store.transition(message.id,'unknown','旧版本投递结果不确定，不自动重发');
  const pairs=store.pairs(),messages=store.messages(),configuration=readFileSync(path.join(f.home,'config.managed.toml'),'utf8');f.registry.codex.enabled=false;
  const updated:any=await setup({home:f.home,from:path.join(PACKAGE_ROOT,'publish')},f.services);
  assert.notEqual(updated.runtime.buildId,buildId);assert.equal(updated.runtime.previous.buildId,buildId);
  assert.deepEqual(store.pairs(),pairs);assert.deepEqual(store.messages(),messages);assert.equal(store.peer(codex.id).sessionId,'preserved-session');assert.equal(store.peer(codex.id).owner,'user');
  assert.equal(f.registry.codex.enabled,false);assert.equal(readFileSync(obsolete,'utf8'),obsoleteText);assert.equal(readFileSync(path.join(f.home,'config.managed.toml'),'utf8'),configuration);
  }finally{store.close();}
});

for(const step of ['plan','prepared','market:claude','cache-state:claude','market:codex','cache-state:codex','namespace-state','obsolete-state']){
  test(`安装阶段 ${step} 中断后普通重跑保留原版本和 bin，来源移走仍能恢复`,async t=>{
    const f=fixture(t),release=await recoveryRelease(f.directory),checkpoint=(current:string)=>{if(current===step)throw Error('隔离安装阶段故障 '+step);};
    await assert.rejects(setup({home:f.home,from:release.source,binDirectory:f.bin},{...f.services,checkpoint}),/隔离安装阶段故障/);
    const state=readJson<any>(path.join(f.home,'setup-state.json'));
    if(step!=='obsolete-state'){
      assert.equal(state.pendingSetup.buildId,release.buildId);assert.equal(state.pendingSetup.binDirectory,f.bin);
      renameSync(release.source,release.source+'.已移走');
      const before=fileHashes(f.home);await assert.rejects(setup({home:f.home,dryRun:true},f.services),{code:'setup_recovery_pending'});assert.deepEqual(fileHashes(f.home),before);
    }
                                                   
    const result:any=await setup({home:f.home,...(step==='obsolete-state'?{from:release.source}:{})},f.services);
    assert.equal(result.installed,true);assert.equal(result.runtime.buildId,release.buildId);assert.equal(result.bin.directory,f.bin);
    assert.equal(readJson<any>(path.join(f.home,'setup-state.json')).pendingSetup,undefined);assert.equal(existsSync(path.join(f.home,'setup-pending.json')),false);
    assert.equal(readJson<any>(path.join(f.home,'install-manifest.json')).buildId,release.buildId);
  });
}

test('Windows 实际状态文件 EPERM：指针已更新而 receipt 未更新，关闭占用后普通 update 自动完成',{skip:process.platform!=='win32'},async t=>{
  const f=fixture(t);await setup({home:f.home},f.services);const before=activeRuntime(f.home)!,release=await recoveryRelease(f.directory),stateFile=path.join(f.home,'setup-state.json'),receiptFile=path.join(f.home,'install-manifest.json');
  const configBefore=readFileSync(path.join(f.codex,'config.toml'),'utf8');let descriptor:number|undefined;
  try{
    await assert.rejects(setup({home:f.home,from:release.source},{...f.services,checkpoint:step=>{if(step==='activation:write:2')descriptor=openSync(stateFile,'r');}}),error=>(error as NodeJS.ErrnoException).code==='EPERM'&&(error as Error).message.includes(stateFile));
    assert.equal(activeRuntime(f.home)!.buildId,release.buildId);assert.equal(readJson<any>(receiptFile).buildId,before.buildId);assert.equal(existsSync(path.join(f.home,'setup-pending.json')),true);
  }finally{if(descriptor!==undefined)closeSync(descriptor);}
  const recovered:any=await setup({home:f.home},f.services);assert.equal(recovered.runtime.buildId,release.buildId);assert.equal(readJson<any>(receiptFile).buildId,release.buildId);
  assert.equal(loadConfig(f.home).codexHome,undefined);assert.equal(loadConfig(f.home).claudeHome,undefined);
  assert.equal(recovered.notes.some((note:string)=>note.includes('自动完成中断')),true);assert.equal(readFileSync(path.join(f.codex,'config.toml'),'utf8'),configBefore);
  const state=readJson<any>(stateFile);for(const file of state.managedFiles)assert.equal(readFileSync(file.file,'utf8'),file.content);assert.equal(state.pendingSetup,undefined);assert.equal(existsSync(path.join(f.home,'setup-pending.json')),false);
});

test('中断安装仍可卸载，取消待完成计划后再次安装不引用已清理的版本',async t=>{
  const f=fixture(t);await assert.rejects(setup({home:f.home},{...f.services,checkpoint:step=>{if(step==='activation:write:2')throw Error('隔离中断');}}),/隔离中断/);
  assert.equal(existsSync(path.join(f.home,'setup-pending.json')),true);const removed:any=await uninstall(f.home,{},f.services);assert.equal(removed.removed,true,JSON.stringify(removed));
  assert.equal(existsSync(path.join(f.home,'setup-pending.json')),false);assert.equal(readJson<any>(path.join(f.home,'setup-state.json')).pendingSetup,undefined);
  assert.equal((await setup({home:f.home},f.services) as any).installed,true);
});

test('插件首次准备中断时归属标记已经写入，普通 setup 可重建未完成的自有目录',async t=>{
  const f=fixture(t);await assert.rejects(preparePlugins(f.home,{packageRoot:path.join(f.directory,'不存在的发布来源')}),{code:'ENOENT'});
  const root=path.join(f.home,'marketplace');assert.equal(existsSync(path.join(root,'.nxbridge-owned.json')),true);
  mkdirSync(path.join(root,'plugins','claude'),{recursive:true});writeFileSync(path.join(root,'plugins','claude','bridge.cjs'),'未完成的复制内容','utf8');
  const result:any=await setup({home:f.home},f.services);assert.equal(result.installed,true);assert.notEqual(readFileSync(path.join(root,'plugins','claude','bridge.cjs'),'utf8'),'未完成的复制内容');
});

test('中断计划优先保持原目标，新选项不能静默替换它；错误和 dry-run 都不写文件',async t=>{
  const f=fixture(t);await assert.rejects(setup({home:f.home},{...f.services,checkpoint:step=>{if(step==='plan')throw Error('隔离计划中断');}}),/隔离计划中断/);
  const before=fileHashes(f.home);
  for(const options of [{binDirectory:path.join(f.directory,'其他bin')},{commands:{codex:[process.execPath]}},{from:path.join(f.directory,'其他发布来源')},{hostHomes:{codex:path.join(f.directory,'其他配置')}}]){
    await assert.rejects(setup({home:f.home,...options},f.services),error=>(error as any).code==='setup_recovery_pending'&&(error as Error).message.includes(path.join(f.home,'setup-state.json'))&&(error as Error).message.includes('再运行一次同样的命令'));
    assert.deepEqual(fileHashes(f.home),before);
  }
  const stateFile=path.join(f.home,'setup-state.json'),state=readJson<any>(stateFile);state.pendingSetup.newerBuildObservation={state:'新增诊断状态'};atomicJson(stateFile,state);
  assert.equal((await setup({home:f.home},f.services) as any).installed,true);
});
