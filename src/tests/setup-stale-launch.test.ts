import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { cp } from 'node:fs/promises';
import path from 'node:path';
import { stringify } from 'smol-toml';
import { preparePlugins, setup } from '../install/setup.js';
import {atomicJson,readJson} from '../shared/files.js';
import {loadConfig} from '../config/load.js';
import {PACKAGE_ROOT} from '../shared/package-location.js';
import { activeRuntime, fileHashes, stageRuntime } from '../install/runtime-install.js';
import type { LaunchProfile } from '../hosts/launch-profiles.js';
import { fixture } from './setup-fixture.js';

function staleDesktop(t:Parameters<typeof fixture>[0]){
  const f=fixture(t),desktop=path.join(f.directory,'Library','Application Support','Claude','claude-code');
  mkdirSync(f.home,{recursive:true});
  const configFile=path.join(f.home,'config.toml'),profilesFile=path.join(f.home,'launch-profiles.json'),stateFile=path.join(f.home,'setup-state.json');
  writeFileSync(configFile,'# 保留用户固定的 Codex 入口，不把安装目录写成 Claude 启动 pin。\n'+stringify({hosts:{codex:{binary:process.execPath,home:f.codex}}}),'utf8');
  const profiles:LaunchProfile[]=[['2.1.317','91184d3d9ba3'],['2.1.321','e6736b2d954d'],['2.1.321','ddbdf2b334e1']].map(([version,hash],index)=>({
    id:'旧桌面记录-'+index,host:'claude',exe:path.join(desktop,version!,hash!,'claude.app','Contents','MacOS','claude'),version:version!+' (Claude Code)',
    configHome:f.claude,cwd:f.directory,env:{PATH:'',CLAUDE_CONFIG_DIR:f.claude,USER_TOKEN:'保留原窗口凭据'},sourceSession:'原窗口-'+index,sourcePid:4100+index,sourceGeneration:'原代次-'+index,capturedAt:index+1,dropped:[],
  }));
  atomicJson(profilesFile,{version:1,profiles,observations:profiles.map(profile=>({...profile,owned:false})),preferred:{}});
  const state={version:1,changes:[],claudeInstalled:false,codexInstalled:false,claudeMarketplace:false,codexMarketplace:false,marketplace:path.join(f.home,'marketplace'),disabled:true,managedFiles:[],cacheDirectories:[],hostHomes:{codex:f.codex,claude:f.claude}};
  atomicJson(stateFile,state);
  const preserved=[configFile,profilesFile].map(file=>({file,contents:readFileSync(file)}));
  const assertPreserved=()=>{
    for(const {file,contents} of preserved)assert.deepEqual(readFileSync(file),contents,'用户配置、启动记录及原进程代次凭据必须保留');
    const config=loadConfig(f.home);assert.equal(config.codexBinary,process.execPath);assert.equal(config.claudeCommand,undefined);assert.equal(config.claudeBinary,undefined);assert.equal(config.claudeHome,undefined);
  };
  return{...f,desktop,profiles,state,stateFile,configFile,assertPreserved};
}

function successor(f:ReturnType<typeof staleDesktop>){
  const executable=path.join(f.desktop,'2.1.325','f13cbdd19d9e','claude.app','Contents','MacOS','claude');
  mkdirSync(path.dirname(executable),{recursive:true});
                              
  const image=Buffer.alloc(32);image.writeUInt32LE(0xfeedfacf,0);image.writeUInt32LE(0x0100000c,4);image.writeUInt32LE(2,12);
  writeFileSync(executable,image,{mode:0o755});return executable;
}

function assertCompleted(f:ReturnType<typeof staleDesktop>,result:any){
  assert.equal(result.installed,true);assert.equal(f.registry.claude.installed,true);assert.equal(f.registry.codex.installed,true);
  assert.equal(existsSync(path.join(f.home,'bin','nxbridge.cjs')),true);assert.equal(existsSync(path.join(f.bin,process.platform==='win32'?'nxbridge.cmd':'nxbridge')),true);
  const state=readJson<any>(f.stateFile);assert.equal(state.disabled,false);assert.equal(state.pendingSetup,undefined);assert.deepEqual(state.hostHomes,{codex:f.codex,claude:f.claude});
  assert.equal(readJson<any>(path.join(f.home,'install-manifest.json')).buildId,result.runtime.buildId);f.assertPreserved();
}

test('卸载保留的 Mac 桌面旧版本记录不阻塞重新安装，预览和正式安装都报告真实运行入口',async t=>{
  const f=staleDesktop(t),executable=successor(f),stateBefore=readFileSync(f.stateFile);
  assert.ok(f.profiles.every(profile=>!existsSync(profile.exe)));assert.equal(f.registry.claude.installed,false);assert.equal(f.registry.codex.installed,false);
  const preview:any=await setup({home:f.home,dryRun:true},f.services);
  assert.equal(preview.runtimeLaunches.claude.purpose,'runtime-default');assert.equal(preview.runtimeLaunches.claude.executable,executable);assert.equal(preview.runtimeLaunches.claude.configHome,f.claude);
  assert.deepEqual(readFileSync(f.stateFile),stateBefore);assert.equal(existsSync(path.join(f.home,'runtime')),false);assert.equal(existsSync(path.join(f.home,'marketplace')),false);assert.equal(existsSync(path.join(f.home,'bin')),false);f.assertPreserved();
                                                   
  let moved=false,result:any;
  try{result=await setup({home:f.home},{...f.services,checkpoint:step=>{if(step==='prepared'){renameSync(executable,executable+'.更新中');moved=true;}}});}
  finally{if(moved)renameSync(executable+'.更新中',executable);}
  assertCompleted(f,result);assert.equal(result.runtimeLaunches.claude.executable,executable);assert.equal(result.runtimeLaunches.claude.configHome,f.claude);assert.ok(result.runtimeLaunches.claude.notes.length>0);
  assert.equal(result.launches.claude.configHome,f.claude);assert.equal(result.launches.codex.configHome,f.codex);
});

test('旧发布包 prepared 阶段留下的 pendingSetup 可直接无新选项恢复，插件缺失也不依赖窗口重新登记',async t=>{
  const f=staleDesktop(t),executable=successor(f),source=path.join(f.directory,'已移走的旧发布包');
  await cp(path.join(PACKAGE_ROOT,'publish'),source,{recursive:true});
  const guide=path.join(source,'nxbridge-collaboration.md');writeFileSync(guide,readFileSync(guide,'utf8')+'\n隔离的旧安装发布版本\n','utf8');
  const manifest=readJson<any>(path.join(source,'publish.json'));manifest.files=fileHashes(source,['publish.json']);
  manifest.buildId=manifest.version+'-'+createHash('sha256').update(JSON.stringify({files:manifest.files,dependencies:manifest.dependencies})).digest('hex').slice(0,12);atomicJson(path.join(source,'publish.json'),manifest);
  const candidate=await stageRuntime(f.home,source);
                                         
  atomicJson(f.stateFile,{...f.state,disabled:false,pendingSetup:{runtimeDirectory:candidate.directory,buildId:candidate.buildId,source,binDirectory:f.bin,hostHomes:f.state.hostHomes}});
  await preparePlugins(f.home,{packageRoot:candidate.directory,launcher:path.join(f.home,'bin','nxbridge.cjs')});
  renameSync(source,source+'.已移动');
  assert.equal(activeRuntime(f.home),undefined);assert.equal(existsSync(path.join(f.home,'bin')),false);assert.equal(f.registry.claude.installed,false);assert.equal(f.registry.codex.installed,false);
  const result:any=await setup({home:f.home},f.services);
  assertCompleted(f,result);assert.equal(result.runtime.buildId,candidate.buildId);assert.equal(result.bin.directory,f.bin);assert.equal(result.runtimeLaunches.claude.executable,executable);assert.equal(result.runtimeLaunches.claude.configHome,f.claude);
  assert.equal(existsSync(path.join(f.home,'setup-pending.json')),false);
});

test('运行入口解析失败只作为预览和正式安装的说明，不在 prepared 后中止安装',async t=>{
  const f=staleDesktop(t);
                              
  writeFileSync(f.configFile,stringify({hosts:{codex:{binary:process.execPath,home:f.codex},claude:{command:['nxbridge-isolated-missing-'+path.basename(f.directory)],home:f.claude}}}),'utf8');
  const configBefore=readFileSync(f.configFile),profilesBefore=readFileSync(path.join(f.home,'launch-profiles.json')),stateBefore=readFileSync(f.stateFile);
  const preview:any=await setup({home:f.home,dryRun:true},f.services);
  assert.equal(preview.runtimeLaunches.claude.code,'launch_command_missing');assert.equal(typeof preview.runtimeLaunches.claude.error,'string');assert.deepEqual(readFileSync(f.stateFile),stateBefore);assert.equal(existsSync(path.join(f.home,'marketplace')),false);
  const result:any=await setup({home:f.home},f.services);
  assert.equal(result.installed,true);assert.equal(result.runtimeLaunches.claude.code,preview.runtimeLaunches.claude.code);assert.equal(result.runtimeLaunches.claude.error,preview.runtimeLaunches.claude.error);assert.equal(readJson<any>(f.stateFile).pendingSetup,undefined);
  assert.equal(f.registry.claude.installed,true);assert.equal(f.registry.codex.installed,true);assert.deepEqual(readFileSync(f.configFile),configBefore);assert.deepEqual(readFileSync(path.join(f.home,'launch-profiles.json')),profilesBefore);
});

test('必需的安装控制入口失败在预览和真实安装中都止于写入前，保留卸载状态与旧记录',async t=>{
  const f=staleDesktop(t),stateBefore=readFileSync(f.stateFile),checkpoints:string[]=[];
  f.fail('claude --version');
  for(const dryRun of [true,false]){
    await assert.rejects(setup({home:f.home,dryRun},{...f.services,checkpoint:step=>checkpoints.push(step)}),/隔离故障/);
    assert.deepEqual(readFileSync(f.stateFile),stateBefore);assert.equal(existsSync(path.join(f.home,'runtime')),false);assert.equal(existsSync(path.join(f.home,'marketplace')),false);assert.equal(existsSync(path.join(f.home,'bin')),false);
    assert.equal(f.registry.claude.installed,false);assert.equal(f.registry.codex.installed,false);f.assertPreserved();
  }
  assert.deepEqual(checkpoints,[]);
});

test('真实控制入口的解析失败在预览与正式安装中使用可执行的安装提示，写入前终止',async t=>{
  const f=staleDesktop(t),missing='nxbridge-isolated-no-such-claude-'+path.basename(f.directory);
  writeFileSync(f.configFile,stringify({hosts:{codex:{binary:process.execPath,home:f.codex},claude:{command:[missing]}}}),'utf8');
  const stateBefore=readFileSync(f.stateFile),configBefore=readFileSync(f.configFile),services={...f.services};delete services.run;
  for(const dryRun of [true,false]){
    await assert.rejects(setup({home:f.home,dryRun},services),error=>{
      assert.equal((error as any).code,'launch_command_missing');assert.match(String(error),/setup 需要运行 claude.*没有写入任何文件.*--claude-command/);assert.doesNotMatch(String(error),/打开.*窗口.*重新记录/);return true;
    });
    assert.deepEqual(readFileSync(f.stateFile),stateBefore);assert.deepEqual(readFileSync(f.configFile),configBefore);
    for(const directory of ['runtime','marketplace','bin'])assert.equal(existsSync(path.join(f.home,directory)),false);
  }
});
