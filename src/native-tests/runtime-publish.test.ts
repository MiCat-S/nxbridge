import test from 'node:test';
import { VERSION } from '../version.js';
import assert from 'node:assert/strict';
import path from 'node:path';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { cp } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { temporaryDirectory } from '../tests/support/temporary.js';
import {atomicJson,readJson} from '../shared/files.js';
import {PACKAGE_ROOT} from '../shared/package-location.js';
import { fileHashes } from '../install/runtime-install.js';
import {DEFAULT_CONFIG} from '../config/defaults.js';
import { publishEnvironment } from './publish-fixture.js';

const execute=promisify(execFile);

test('发布安装器：来源移走后修复、显式来源更新及从已安装入口彻底卸载',async t=>{
  const temporary=temporaryDirectory(),directory=temporary.directory,home=path.join(directory,'中文 私有目录'),bin=path.join(directory,'bin');
  t.after(temporary.cleanup);
  mkdirSync(home,{recursive:true});mkdirSync(bin);
  atomicJson(path.join(home,'config.json'),{...DEFAULT_CONFIG,...(process.env.NXBRIDGE_TEST_CODEX_BINARY?{codexBinary:process.env.NXBRIDGE_TEST_CODEX_BINARY}:{})});
  const env=publishEnvironment(home,bin,{...process.env,NXBRIDGE_HOME:home,CODEX_HOME:path.join(directory,'codex'),CLAUDE_CONFIG_DIR:path.join(directory,'claude')}) as NodeJS.ProcessEnv&{CODEX_HOME:string;CLAUDE_CONFIG_DIR:string};
  mkdirSync(env.CODEX_HOME,{recursive:true});mkdirSync(env.CLAUDE_CONFIG_DIR,{recursive:true});
  writeFileSync(path.join(env.CODEX_HOME,'config.toml'),'# 用户配置需保留\nmodel_verbosity = "low"\n','utf8');
  const launcher=path.join(home,'bin','nxbridge.cjs');
  const run=async(entry:string,args:string[])=>JSON.parse((await execute(process.execPath,['--no-warnings',entry,...args],{cwd:directory,env,windowsHide:true,timeout:90000,maxBuffer:4*1024*1024})).stdout);
  const revision=async(destination:string,label:string)=>{
    await cp(path.join(PACKAGE_ROOT,'publish'),destination,{recursive:true});
                                            
    const runtime=path.join(destination,'nxbridge.mjs');
    writeFileSync(runtime,readFileSync(runtime,'utf8')+'\n// '+label+'\n','utf8');
    const manifest=readJson<any>(path.join(destination,'publish.json'));manifest.files=fileHashes(destination,['publish.json']);
    manifest.buildId=manifest.version+'-'+createHash('sha256').update(JSON.stringify({files:manifest.files,dependencies:manifest.dependencies})).digest('hex').slice(0,12);
    atomicJson(path.join(destination,'publish.json'),manifest);return manifest;
  };
  const source=path.join(directory,'source'),first=await revision(source,'第一版验收');
  const installed=await run(path.join(source,'nxbridge.mjs'),['setup','--bin-dir',bin]);
  assert.equal(installed.runtime.buildId,first.buildId);
  const codexBundle=path.join(env.CODEX_HOME,'plugins','cache','nxbridge-local','nxbridge',VERSION),bundleBefore=fileHashes(codexBundle);
  const baseline=await run(launcher,['config','get','questions.timeout_ms']);assert.equal(baseline.source,'managed-toml');
  const userFile=path.join(home,'config.toml'),userText='\ufeff# 用户配置原字节保留\r\nnote="""\r\n多行说明\r\n"""\r\n[questions]\r\ntimeout_ms=321\r\n';writeFileSync(userFile,userText,'utf8');
  const override=await run(launcher,['config','get','questions.timeout_ms']);assert.equal(override.value,321);assert.equal(override.shadowed,DEFAULT_CONFIG.questionTimeoutMs);assert.equal(override.source,'user-toml');assert.equal(override.editable,false);
  const managedFile=path.join(home,'config.managed.toml'),managedBefore=readFileSync(managedFile,'utf8');
  await assert.rejects(run(launcher,['config','set','retention.max_events','44']),error=>(error as {stderr?:string}).stderr?.includes('config_terminal_required')===true);assert.equal(readFileSync(managedFile,'utf8'),managedBefore);
  renameSync(source,path.join(directory,'moved-source'));
  const repaired=await run(launcher,['update','--bin-dir',bin]);
  assert.equal(repaired.runtime.buildId,first.buildId);assert.ok(repaired.notes.some((note:string)=>note.includes('原来的安装来源已经不在了')));
  assert.deepEqual(fileHashes(codexBundle),bundleBefore,'修复运行时不能改变已安装插件的信任指纹');
  const independent=await execute(process.execPath,['--no-warnings',launcher,'--version'],{cwd:directory,env:{...env,PATH:''},windowsHide:true,timeout:15000});
  assert.equal(independent.stdout.trim(),'nxbridge '+VERSION);
  const nextSource=path.join(directory,'新来源'),second=await revision(path.join(nextSource,'publish'),'第二版验收');
  const recoveryFixture=path.join(directory,'recovery-fixture.json');atomicJson(recoveryFixture,{home,from:nextSource,binDirectory:bin,pathValue:env.PATH});
  const recoveryWorker=`import {readFileSync} from 'node:fs';import {setup} from ${JSON.stringify(new URL('../install/setup.js',import.meta.url).href)};const f=JSON.parse(readFileSync(process.argv[1],'utf8'));await setup({home:f.home,from:f.from,binDirectory:f.binDirectory},{pathValue:f.pathValue,binDirectories:[f.binDirectory],checkpoint:step=>{if(step==='activation:write:2')process.exit(79);}});`;
  await assert.rejects(execute(process.execPath,['--no-warnings','--input-type=module','-e',recoveryWorker,recoveryFixture],{cwd:directory,env,windowsHide:true,timeout:90000,maxBuffer:4*1024*1024}),error=>(error as {code?:number}).code===79);
  assert.equal(existsSync(path.join(home,'setup-pending.json')),true);assert.equal(readJson<any>(path.join(home,'bin','runtime.json')).buildId,second.buildId);assert.equal(readJson<any>(path.join(home,'install-manifest.json')).buildId,first.buildId);
                                        
  const updated=await run(launcher,['update']);
  assert.equal(updated.runtime.buildId,second.buildId);assert.equal(updated.runtime.previous.buildId,first.buildId);
  assert.deepEqual(fileHashes(codexBundle),bundleBefore,'运行时切换及中断恢复必须保持 Codex 插件全部字节不变');
  assert.equal(existsSync(path.join(home,'setup-pending.json')),false);assert.equal(readJson<any>(path.join(home,'setup-state.json')).pendingSetup,undefined);assert.equal(readJson<any>(path.join(home,'install-manifest.json')).buildId,second.buildId);
  assert.equal(readFileSync(userFile,'utf8'),userText);assert.equal((await run(launcher,['config','get','questions.timeout_ms'])).value,321);
  const removed=await run(launcher,['uninstall','--purge']);
  assert.equal(removed.removed,true,JSON.stringify(removed));assert.equal(removed.purged,true,JSON.stringify(removed));assert.equal(existsSync(home),false);
  assert.equal(existsSync(path.join(bin,process.platform==='win32'?'nxbridge.cmd':'nxbridge')),false);
  assert.match(readFileSync(path.join(env.CODEX_HOME,'config.toml'),'utf8'),/model_verbosity = "low"/);
  assert.equal(existsSync(path.join(nextSource,'publish','nxbridge.mjs')),true,'卸载不能删除发布来源');
});
