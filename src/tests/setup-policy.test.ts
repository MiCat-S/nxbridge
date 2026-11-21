import test from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { parse, stringify } from 'smol-toml';
import { preparePlugins, setup, uninstall, type SetupServices } from '../install/setup.js';
import { planShim } from '../install/installation.js';
import { RpcClient } from '../ipc/rpc.js';
import {loadConfig} from '../config/load.js';
import { randomUUID } from 'node:crypto';
import { forgetOwnedProcess,ownedProcesses,prepareProcessRegistry,processRegistryDirectory } from '../process/owned-processes.js';
import { saveManagedRuntime,runtimeFor } from '../hosts/managed-runtimes.js';
import { managedMarker } from '../install/installation.js';
import { unknownContainerFixture } from './unknown-container-fixture.js';

import { fixture } from './setup-fixture.js';

test('卸载预览不写文件；正常卸载恢复配置、删除自有入口并保留账本',async t=>{
  const f=fixture(t);writeFileSync(path.join(f.codex,'config.toml'),'[features]\ncode_mode=true\n','utf8');await setup({home:f.home},f.services);
  f.retainCache();
  writeFileSync(path.join(f.home,'nxbridge.db'),'保留账本','utf8');
  const snapshot=readFileSync(path.join(f.home,'setup-state.json'),'utf8');
  const preview:any=await uninstall(f.home,{dryRun:true,purge:true},f.services);assert.equal(preview.dryRun,true);assert.ok(preview.actions.some((action:string)=>action.includes(f.home)));assert.equal(readFileSync(path.join(f.home,'setup-state.json'),'utf8'),snapshot);
  const removed:any=await uninstall(f.home,{},f.services);assert.equal(removed.removed,true);assert.equal(removed.purged,false);assert.equal(existsSync(path.join(f.home,'marketplace')),false);assert.equal(readFileSync(path.join(f.home,'nxbridge.db'),'utf8'),'保留账本');
  assert.equal((parse(readFileSync(path.join(f.codex,'config.toml'),'utf8')) as any).features.code_mode,true);
  assert.equal(existsSync(path.join(f.bin,process.platform==='win32'?'nxbridge.cmd':'nxbridge')),false);
  assert.equal(existsSync(f.cache('claude')),false);assert.equal(existsSync(f.cache('codex')),false);
  assert.equal((await uninstall(f.home,{},f.services) as any).removed,true);
});

test('卸载独立处理宿主失败，保留可重试状态；缺失状态记录仍按自有标记清理',async t=>{
  const f=fixture(t);await setup({home:f.home},f.services);f.fail('codex plugin remove');
  const partial:any=await uninstall(f.home,{},f.services);assert.equal(partial.removed,false);assert.equal(f.registry.claude.installed,false);assert.equal(f.registry.codex.installed,true);assert.equal(existsSync(path.join(f.home,'bin','nxbridge.cjs')),true);
  f.fail('');assert.equal((await uninstall(f.home,{},f.services) as any).removed,true);
  await setup({home:f.home},f.services);rmSync(path.join(f.home,'setup-state.json'));
  const missing:any=await uninstall(f.home,{},f.services);assert.equal(missing.removed,true);assert.equal(f.registry.claude.market,false);assert.equal(f.registry.codex.installed,false);
  assert.equal(existsSync(path.join(f.bin,process.platform==='win32'?'nxbridge.cmd':'nxbridge')),false);
});

test('用户修改的 shim 与命名空间保留；明确 purge 只清除可核验的私有目录',async t=>{
  const f=fixture(t);await setup({home:f.home},f.services);
  const configFile=path.join(f.codex,'config.toml'),userConfig:any=parse(readFileSync(configFile,'utf8'));userConfig.features.code_mode.user_setting='保留用户修改';writeFileSync(configFile,stringify(userConfig),'utf8');
  const shim=path.join(f.bin,process.platform==='win32'?'nxbridge.cmd':'nxbridge');writeFileSync(shim,'用户替换的命令','utf8');
  const preserved:any=await uninstall(f.home,{purge:true},f.services);assert.equal(preserved.purged,false);assert.equal(readFileSync(shim,'utf8'),'用户替换的命令');assert.equal(existsSync(f.home),true);
  assert.match(readFileSync(configFile,'utf8'),/保留用户修改/);
  const clean=fixture(t);await setup({home:clean.home},clean.services);writeFileSync(path.join(clean.home,'history.txt'),'自有历史','utf8');
  assert.equal((await uninstall(clean.home,{purge:true},clean.services) as any).purged,true);assert.equal(existsSync(clean.home),false);assert.equal(existsSync(clean.codex),true);
});

test('普通卸载保留未知容器，明确 purge 收尾不再被信息提示或无原生 PID 的预约阻塞',{skip:process.platform!=='win32'},async t=>{
  const f=fixture(t);await setup({home:f.home},f.services);const record=await unknownContainerFixture(f.home);
  saveManagedRuntime(f.home,{id:record.proof.launchId!,owner:managedMarker(f.home),kind:'owned',state:'starting',createdAt:Date.now(),endpoint:'unix://purge-unconfirmed'});
  try{
    const normal=await uninstall(f.home,{},f.services) as any;assert.equal(normal.purged,false);assert.equal(ownedProcesses(f.home).records.length,1);assert.ok(runtimeFor(f.home,{id:record.proof.launchId}));
    const purged=await uninstall(f.home,{purge:true},f.services) as any;assert.equal(purged.purged,true);assert.deepEqual(purged.failures,[]);assert.equal(purged.processes.removed,true);assert.match(purged.notes.join(' '),/未确认.*全部退出/);assert.equal(existsSync(f.home),false);assert.equal(existsSync(record.completionFile!),false);
  }finally{forgetOwnedProcess(record);}
});

test('明确 purge 清除记录提交前遗留的孤立完成凭据，普通卸载保留',async t=>{
  const f=fixture(t);await setup({home:f.home},f.services);await prepareProcessRegistry(f.home);const orphan=path.join(processRegistryDirectory(f.home),randomUUID()+'.json.done');writeFileSync(orphan,'','utf8');
  assert.equal((await uninstall(f.home,{},f.services) as any).purged,false);assert.equal(existsSync(orphan),true);
  const result=await uninstall(f.home,{purge:true},f.services) as any;assert.equal(result.purged,true);assert.deepEqual(result.failures,[]);assert.equal(result.processes.orphanReceiptsRemoved,1);assert.equal(existsSync(orphan),false);
});

test('缓存位置采用官方清单；旧安装缺失状态文件和新标记时仍能核验来源',async t=>{
  const f=fixture(t),services={...f.services,claudeDirectory:path.join(f.directory,'managed-config')};
  await setup({home:f.home},services);assert.equal(existsSync(f.cache('claude')),true);
  rmSync(path.join(f.home,'setup-state.json'));rmSync(path.join(f.home,'marketplace','.nxbridge-owned.json'));
  assert.equal((await uninstall(f.home,{},services) as any).removed,true);assert.equal(f.registry.claude.installed,false);
});

test('插件准备和安装共享空目录与旧状态归属规则，不因缺少新标记卡住修复',async t=>{
  const f=fixture(t),root=path.join(f.home,'marketplace');mkdirSync(root,{recursive:true});
  assert.equal((await setup({home:f.home,dryRun:true},f.services) as any).dryRun,true);
  await setup({home:f.home},f.services);rmSync(path.join(root,'.nxbridge-owned.json'));rmSync(path.join(root,'.agents'),{recursive:true});rmSync(path.join(root,'plugins'),{recursive:true});
  writeFileSync(path.join(root,'interrupted.txt'),'中断准备留下的内容','utf8');
  assert.equal((await setup({home:f.home},f.services) as any).installed,true);
  assert.equal(existsSync(path.join(root,'.nxbridge-owned.json')),true);
});

test('原生配置层和已安装插件提供配置目录时无需预先解析宿主路径',async t=>{
  const f=fixture(t),root=await preparePlugins(f.home),services={...f.services};
  delete services.codexDirectory;delete services.claudeDirectory;
  cpSync(path.join(root,'plugins','claude'),f.cache('claude'),{recursive:true});f.registry.claude.installed=true;
  const result=await setup({home:f.home,dryRun:true},services) as any;
  assert.equal(result.launches.codex.configHome,f.codex);assert.equal(result.launches.claude.configHome,f.claude);
  assert.equal(existsSync(path.join(f.home,'setup-state.json')),false);
});

test('没有 PATH 可写目录时提供完整命令，未在 PATH 的注入目录不会被写入',t=>{
  const f=fixture(t),plan=planShim(f.home,{directories:[f.bin],pathValue:path.join(f.directory,'other')});assert.equal(plan.directory,null);assert.equal(plan.files.length,0);assert.match(plan.command,/nxbridge\.cjs/);assert.equal(readdirSync(f.bin).length,0);
});

test('命名空间管理策略在安装前检查，严格第三方工具策略沿用原生 MCP',async t=>{
  const control=(strict:boolean):SetupServices['control']=>async()=>{
    const rpc=new RpcClient(message=>{
      assert.ok(['config/read','configRequirements/read'].includes(message.method!));
      const result=message.method==='config/read'?{config:{features:{code_mode_only_strict_3p_tools:strict}}}:{requirements:{featureRequirements:{non_prefixed_mcp_tool_names:false}}};
      queueMicrotask(()=>rpc.receive({id:message.id,result}));
    },()=>{});return rpc;
  };
  const blocked=fixture(t);await assert.rejects(setup({home:blocked.home},{...blocked.services,control:control(false)}),{code:'namespace_policy_conflict'});assert.equal(existsSync(blocked.home),false);
  const strict=fixture(t),result:any=await setup({home:strict.home},{...strict.services,control:control(true)});assert.equal(result.toolMode,'policy-controlled-mcp');assert.equal(strict.edits.length,0);
});

test('启动命令与配置目录只在预检通过后保存，预览与失败不改配置',async t=>{
  const f=fixture(t),configFile=path.join(f.home,'config.managed.toml'),commands={codex:[process.execPath,'包装 参数'],claude:[process.execPath,'另一个 参数']},hostHomes={codex:f.codex,claude:f.claude};
  const preview:any=await setup({home:f.home,dryRun:true,commands,hostHomes},f.services);assert.equal(preview.dryRun,true);assert.equal(preview.launches.codex.configHome,f.codex);assert.equal(existsSync(configFile),false);
  f.fail('claude --version');await assert.rejects(setup({home:f.home,commands,hostHomes},f.services),/隔离故障/);assert.equal(existsSync(configFile),false);f.fail('');
  await setup({home:f.home,commands,hostHomes},f.services);
  let saved=loadConfig(f.home);assert.deepEqual(saved.codexCommand,commands.codex);assert.deepEqual(saved.claudeCommand,commands.claude);assert.equal(saved.codexHome,f.codex);assert.equal(saved.claudeHome,f.claude);
  const before=readFileSync(configFile,'utf8');await setup({home:f.home,dryRun:true,commands:{codex:null}},f.services);assert.equal(readFileSync(configFile,'utf8'),before);
  await setup({home:f.home,commands:{codex:null}},f.services);saved=loadConfig(f.home);assert.equal(saved.codexCommand,undefined);assert.deepEqual(saved.claudeCommand,commands.claude);
  const other=path.join(f.directory,'other-home');mkdirSync(other);
  await assert.rejects(setup({home:f.home,hostHomes:{codex:other}},{...f.services,codexDirectory:other}),{code:'launch_home_changed'});assert.equal(loadConfig(f.home).codexHome,f.codex);
});

test('普通更新控制原安装目录，不把已记录的安装目录写成新的启动 pin',async t=>{
  const f=fixture(t);await setup({home:f.home},f.services);
  let checked=false;
  await setup({home:f.home},{...f.services,control:async config=>{assert.equal(config.codexHome,f.codex);assert.equal(config.claudeHome,f.claude);checked=true;return f.services.control!(config);}});
  assert.equal(checked,true);const saved=loadConfig(f.home);assert.equal(saved.codexHome,undefined);assert.equal(saved.claudeHome,undefined);
});

test('dry-run 清理新建的空归属目录，既有目录与异常诊断保留',async t=>{
  const f=fixture(t),control=f.services.control!,directory=processRegistryDirectory(f.home);
  f.services.control=async config=>{await prepareProcessRegistry(f.home);return control(config);};
  await setup({home:f.home,dryRun:true},f.services);assert.equal(existsSync(directory),false);
  mkdirSync(directory,{recursive:true});await setup({home:f.home,dryRun:true},f.services);assert.equal(existsSync(directory),true);
  writeFileSync(path.join(directory,'keep.txt'),'其他进程的证据','utf8');f.fail('codex plugin list');
  await assert.rejects(setup({home:f.home,dryRun:true},f.services));assert.equal(readFileSync(path.join(directory,'keep.txt'),'utf8'),'其他进程的证据');rmSync(directory,{recursive:true});
});

test('dry-run 与真实安装共享版本预检，旧 Codex 在写入前拒绝而旧 Claude 仍按能力判断',async t=>{
  const old=fixture(t),oldRun:SetupServices['run']=async(host,args)=>args[0]==='--version'?(host==='codex'?'codex-cli 0.120.0':'2.0.1 (Claude Code)'):old.services.run!(host,args);
  for(const dryRun of [true,false]){await assert.rejects(setup({home:old.home,dryRun},{...old.services,run:oldRun}),{code:'codex_version'});assert.equal(existsSync(old.home),false);assert.equal(old.edits.length,0);}
  const f=fixture(t),run:SetupServices['run']=async(host,args)=>args[0]==='--version'?(host==='codex'?'codex-cli 0.164.0':'2.0.1 (Claude Code)'):f.services.run!(host,args);
  const preview:any=await setup({home:f.home,dryRun:true},{...f.services,run});
  assert.equal(existsSync(f.home),false);assert.equal(preview.bin.directory,f.bin);assert.match(preview.bin.reason,/指定/);
  assert.equal(preview.preflight.requiredCapabilities.passed,true);assert.equal(preview.preflight.compatibility.hosts.codex.status,'tested');assert.equal(preview.preflight.compatibility.hosts.claude.status,'older-than-tested');
  const result:any=await setup({home:f.home},{...f.services,run});
  assert.deepEqual(result.preflight.requiredCapabilities,preview.preflight.requiredCapabilities);assert.deepEqual(result.preflight.compatibility,preview.preflight.compatibility);
  const failed=fixture(t);failed.fail('codex plugin list');
  for(const dryRun of [true,false]){await assert.rejects(setup({home:failed.home,dryRun},failed.services),/隔离故障/);assert.equal(existsSync(failed.home),false);}
});

test('自定义 Codex 包装命令也必须提供可核验的最低版本，Claude 保留能力预检',async t=>{
  const f=fixture(t),commands={codex:[process.execPath,'codex-wrapper'],claude:[process.execPath,'claude-wrapper']};
  const unknown:SetupServices['run']=async(host,args)=>args[0]==='--version'?`${host} wrapper build unknown`:f.services.run!(host,args);
  for(const dryRun of [true,false])await assert.rejects(setup({home:f.home,dryRun,commands},{...f.services,run:unknown}),{code:'codex_version'});
  assert.equal(existsSync(f.home),false);
  const run:SetupServices['run']=async(host,args)=>args[0]==='--version'?(host==='codex'?'codex-cli 0.164.0':'claude wrapper build unknown'):f.services.run!(host,args);
  for(const dryRun of [true,false]){
    const result:any=await setup({home:f.home,dryRun,commands},{...f.services,run});
    assert.equal(result.preflight.requiredCapabilities.passed,true);assert.equal(result.preflight.compatibility.hosts.claude.status,'unrecognized');
    assert.ok(result.notes.some((note:string)=>note.includes('自定义 claude')&&note.includes('必需能力检查')));
  }
  const failed=fixture(t);failed.fail('codex plugin list');
  await assert.rejects(setup({home:failed.home,commands},{...failed.services,run:async(host,args)=>args[0]==='--version'?(host==='codex'?'codex-cli 0.164.0':'wrapper'):failed.services.run!(host,args)}),{code:'preflight_failed'});
  assert.equal(existsSync(failed.home),false);
});

test('dry-run 与实际安装都拒绝空清单输出和无效发布来源，失败有版本及输出诊断',async t=>{
  const f=fixture(t),run:SetupServices['run']=async(host,args)=>host==='codex'&&args[0]==='plugin'&&args[1]==='list'?'':f.services.run!(host,args);
  for(const dryRun of [true,false]){
    await assert.rejects(setup({home:f.home,dryRun},{...f.services,run}),error=>{assert.equal((error as any).code,'preflight_failed');assert.match((error as Error).message,/codex-cli 0\.166\.0/);assert.match((error as Error).message,/退出码=0/);assert.match((error as Error).message,/标准输出末尾：.*空/);return true;});
    await assert.rejects(setup({home:f.home,dryRun,from:path.join(f.directory,'missing-release')},f.services),{code:'publish_missing'});
    assert.equal(existsSync(f.home),false);
  }
});
