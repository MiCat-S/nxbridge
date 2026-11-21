import { overrideEnvironment } from '../tests/support/environment.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { cpSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { parse } from 'smol-toml';
import { VERSION } from '../version.js';
import {DEFAULT_CONFIG} from '../config/defaults.js';
import {atomicJson,readJson} from '../shared/files.js';
import {PACKAGE_ROOT} from '../shared/package-location.js';
import {loadConfig} from '../config/load.js';
import {runCli} from '../process/host-command.js';
import { configClient } from '../hosts/codex/stdio-codex.js';
import { fileHashes, verifyPublish } from '../install/runtime-install.js';
import { installedCacheDirectories } from '../install/installation.js';
import { temporaryDirectory } from '../tests/support/temporary.js';
import { publishEnvironment } from './publish-fixture.js';

const execute=promisify(execFile),previousPublish=process.env.NXBRIDGE_TEST_PREVIOUS_PUBLISH;

test('实际旧版更新保留禁用状态与信任记录，两种更新路径均由原生宿主要求重新信任',{skip:!previousPublish,timeout:170000},async t=>{
  const temp=temporaryDirectory(),root=temp.directory,home=path.join(root,'bridge'),codexhome=path.join(root,'codex'),claudehome=path.join(root,'claude'),bin=path.join(root,'bin'),old=path.join(root,'old');
  for(const directory of [home,codexhome,claudehome,bin,old])mkdirSync(directory,{recursive:true});
  writeFileSync(path.join(claudehome,'settings.json'),JSON.stringify({skipDangerousModePermissionPrompt:true}),'utf8');
  const manifest=verifyPublish(previousPublish!);assert.equal(manifest.version,'0.1.0');assert.notEqual(manifest.version,VERSION);
  for(const relative of [...Object.keys(manifest.files),'publish.json']){const target=path.join(old,relative);mkdirSync(path.dirname(target),{recursive:true});cpSync(path.join(previousPublish!,relative),target);}
  const overrides={NXBRIDGE_HOME:home,CODEX_HOME:codexhome,CLAUDE_CONFIG_DIR:claudehome},restoreEnvironment=overrideEnvironment(overrides);
  t.after(async()=>{try{await temp.cleanup();}finally{restoreEnvironment();}});
  writeFileSync(path.join(home,'config.json'),JSON.stringify({...DEFAULT_CONFIG,codexHome:codexhome,claudeHome:claudehome}),'utf8');
  const filename=path.join(codexhome,'config.toml');writeFileSync(filename,'[features]\nhooks=true\n','utf8');
  const env=publishEnvironment(home,bin),run=async(entry:string,args:string[])=>JSON.parse((await execute(process.execPath,[entry,...args],{env,windowsHide:true,timeout:75000,maxBuffer:8*1024*1024})).stdout);
  await run(path.join(old,'nxbridge.mjs'),['setup','--bin-dir',bin]);
  const query=async<T>(action:(client:Awaited<ReturnType<typeof configClient>>)=>Promise<T>)=>{const client=await configClient(loadConfig(home),home);try{return await action(client);}finally{client.close();}};
  const hooks=()=>query(async client=>(await client.request('hooks/list',{cwds:[root]})).data.flatMap((value:any)=>value.hooks??[]).filter((value:any)=>value.pluginId==='nxbridge@nxbridge-local'));
  const edit=(keyPath:string,value:unknown)=>query(client=>client.request('config/batchWrite',{edits:[{keyPath,value,mergeStrategy:'replace'}],filePath:filename},{mutation:true}));
  const original=await hooks();assert.equal(original.length,9);
                                        
  await edit('hooks.state',Object.fromEntries(original.map((hook:any,index:number)=>[hook.key,{enabled:index!==0,trusted_hash:hook.currentHash}])));
  const trusted=await hooks();assert.ok(trusted.every((hook:any)=>hook.trustStatus==='trusted'));assert.equal(trusted.filter((hook:any)=>!hook.enabled).length,1);
  const before=(parse(readFileSync(filename,'utf8')) as any).hooks.state;
  await edit('plugins."nxbridge@nxbridge-local".enabled',false);
  const delivery=path.join(PACKAGE_ROOT,'publish'),update=()=>run(path.join(delivery,'nxbridge.mjs'),['update','--from',delivery,'--bin-dir',bin]);
  const disabled=await update(),inventory=JSON.parse(await runCli('codex',['plugin','list','--json'],{home})).installed.find((value:any)=>value.pluginId==='nxbridge@nxbridge-local');
  assert.equal(inventory.enabled,false);assert.equal(inventory.version,'0.1.0');
  assert.equal(disabled.updates.find((value:any)=>value.host==='codex').mode,'file-sync-fallback');assert.ok(disabled.notes.some((value:string)=>value.includes('原生清单版本可能仍显示旧版')));
  assert.deepEqual((parse(readFileSync(filename,'utf8')) as any).hooks.state,before);
  for(const directory of installedCacheDirectories(codexhome,'codex'))assert.equal(readJson<any>(path.join(directory,'.codex-plugin','plugin.json')).version,VERSION);
  await edit('plugins."nxbridge@nxbridge-local".enabled',true);
  const synced=await hooks();assert.equal(synced.length,9);assert.ok(synced.every((hook:any)=>hook.trustStatus==='modified'));assert.equal(synced.filter((hook:any)=>!hook.enabled).length,1);
  const enabled=await update(),upgraded=await hooks();assert.equal(enabled.updates.find((value:any)=>value.host==='codex').mode,'official-update');
  const fresh=JSON.parse(await runCli('codex',['plugin','list','--json'],{home})).installed.find((value:any)=>value.pluginId==='nxbridge@nxbridge-local');assert.equal(fresh.version,VERSION);assert.equal(fresh.enabled,true);
  assert.equal(upgraded.length,9);assert.ok(upgraded.every((hook:any)=>hook.trustStatus==='modified'));assert.equal(upgraded.filter((hook:any)=>!hook.enabled).length,1);
  const declarations=readJson<any>(path.join(delivery,'plugins','codex','hooks','hooks.json')).hooks;
  for(const hook of upgraded){
    assert.equal(hook.statusMessage,declarations[hook.eventName.replace(/^./,(value:string)=>value.toUpperCase())][0].hooks[0].statusMessage,'原生钩子名称应与发布定义一致');
    assert.match(hook.statusMessage,/^nxbridge: /);assert.doesNotMatch(hook.statusMessage,/\p{Script=Han}/u);
    assert.notEqual(hook.currentHash,original.find((value:any)=>value.key===hook.key)?.currentHash);
  }
  assert.deepEqual((parse(readFileSync(filename,'utf8')) as any).hooks.state,before);
  for(const result of [disabled,enabled])assert.ok(result.next.some((value:string)=>value.includes('/hooks')&&value.includes('重新信任')));
  const pending=await update();assert.deepEqual(pending.reloadRequired,{claude:false,codex:false});assert.equal(pending.hookTrustRequired,true);assert.equal(pending.next.length,1);assert.match(pending.next[0],/\/hooks/);assert.match(pending.notice,/还没有重新信任/);
  assert.deepEqual((parse(readFileSync(filename,'utf8')) as any).hooks.state,before);
  await edit('hooks.state',Object.fromEntries(upgraded.map((hook:any,index:number)=>[hook.key,{enabled:index!==0,trusted_hash:hook.currentHash}])));
  const accepted=(parse(readFileSync(filename,'utf8')) as any).hooks.state,unchanged=await update();
  assert.deepEqual(unchanged.reloadRequired,{claude:false,codex:false});assert.equal(unchanged.hookTrustRequired,false);assert.deepEqual(unchanged.next,[]);assert.match(unchanged.notice,/不需要任何操作/);assert.deepEqual((parse(readFileSync(filename,'utf8')) as any).hooks.state,accepted);
  t.diagnostic(JSON.stringify({disabledPreserved:true,disabledInventoryVersion:inventory.version,enabledInventoryVersion:fresh.version,trustRecordsPreserved:true,fileSyncTrust:'modified',officialUpgradeTrust:'modified',disabledHooks:1,realModelCalls:0}));
});

test('同版本只补钩子名称：原生显示九个名称，保留禁用和信任记录并准确要求重审',{timeout:170000},async t=>{
  const temp=temporaryDirectory(),root=temp.directory,home=path.join(root,'bridge'),codexhome=path.join(root,'codex'),claudehome=path.join(root,'claude'),bin=path.join(root,'bin'),old=path.join(root,'unnamed-source');
  for(const directory of [home,codexhome,claudehome,bin])mkdirSync(directory,{recursive:true});
  writeFileSync(path.join(claudehome,'settings.json'),JSON.stringify({skipDangerousModePermissionPrompt:true}),'utf8');
  const delivery=path.join(PACKAGE_ROOT,'publish'),published=verifyPublish(delivery);
  cpSync(delivery,old,{recursive:true});
  const hookFile=path.join(old,'plugins','codex','hooks','hooks.json'),namedText=readFileSync(hookFile,'utf8');
  assert.equal([...namedText.matchAll(/,\s*"statusMessage":\s*"[^"]*"/g)].length,9);
  writeFileSync(hookFile,namedText.replace(/,\s*"statusMessage":\s*"[^"]*"/g,''),'utf8');
  const manifest=readJson<any>(path.join(old,'publish.json'));manifest.files=fileHashes(old,['publish.json']);
  manifest.buildId=manifest.version+'-'+createHash('sha256').update(JSON.stringify({files:manifest.files,dependencies:manifest.dependencies})).digest('hex').slice(0,12);
  atomicJson(path.join(old,'publish.json'),manifest);assert.equal(manifest.version,published.version);assert.notEqual(manifest.buildId,published.buildId);
  const overrides={NXBRIDGE_HOME:home,CODEX_HOME:codexhome,CLAUDE_CONFIG_DIR:claudehome},restoreEnvironment=overrideEnvironment(overrides);
  t.after(async()=>{try{await temp.cleanup();}finally{restoreEnvironment();}});
  writeFileSync(path.join(home,'config.json'),JSON.stringify({...DEFAULT_CONFIG,codexHome:codexhome,claudeHome:claudehome}),'utf8');
  const filename=path.join(codexhome,'config.toml');writeFileSync(filename,'[features]\nhooks=true\n','utf8');
  const env=publishEnvironment(home,bin),run=async(entry:string,args:string[])=>JSON.parse((await execute(process.execPath,[entry,...args],{env,windowsHide:true,timeout:75000,maxBuffer:8*1024*1024})).stdout);
  await run(path.join(old,'nxbridge.mjs'),['setup','--bin-dir',bin]);
  const query=async<T>(action:(client:Awaited<ReturnType<typeof configClient>>)=>Promise<T>)=>{const client=await configClient(loadConfig(home),home);try{return await action(client);}finally{client.close();}};
  const hooks=()=>query(async client=>(await client.request('hooks/list',{cwds:[root]})).data.flatMap((value:any)=>value.hooks??[]).filter((value:any)=>value.pluginId==='nxbridge@nxbridge-local'));
  const approve=(items:any[])=>query(client=>client.request('config/batchWrite',{edits:[{keyPath:'hooks.state',value:Object.fromEntries(items.map((hook:any,index:number)=>[hook.key,{enabled:index!==0,trusted_hash:hook.currentHash}])),mergeStrategy:'replace'}],filePath:filename},{mutation:true}));
  const original=await hooks();assert.equal(original.length,9);assert.ok(original.every((hook:any)=>hook.statusMessage==null));
                                         
  await approve(original);assert.ok((await hooks()).every((hook:any)=>hook.trustStatus==='trusted'));
  const before=(parse(readFileSync(filename,'utf8')) as any).hooks.state;
  const update=()=>run(path.join(delivery,'nxbridge.mjs'),['update','--from',delivery,'--bin-dir',bin]);
  const updated=await update(),named=await hooks(),declarations=readJson<any>(path.join(delivery,'plugins','codex','hooks','hooks.json')).hooks;
  assert.equal(updated.runtime.buildId,published.buildId);assert.equal(named.length,9);assert.equal(named.filter((hook:any)=>!hook.enabled).length,1);
  for(const hook of named){
    assert.equal(hook.statusMessage,declarations[hook.eventName.replace(/^./,(value:string)=>value.toUpperCase())][0].hooks[0].statusMessage,'原生钩子名称应与发布定义一致');
    assert.match(hook.statusMessage,/^nxbridge: /);assert.doesNotMatch(hook.statusMessage,/\p{Script=Han}/u);
    assert.equal(hook.trustStatus,'modified');assert.notEqual(hook.currentHash,original.find((value:any)=>value.key===hook.key)?.currentHash);
  }
  assert.deepEqual((parse(readFileSync(filename,'utf8')) as any).hooks.state,before);
  assert.equal(updated.hookTrustRequired,true);assert.ok(updated.next.some((value:string)=>value.includes('/hooks')&&value.includes('重新信任')));
  const autonomousNext=process.platform==='linux'&&process.getuid?.()===0?['Claude 原生禁止 root/sudo 使用无人审批模式。请以普通 Linux 用户运行 nxbridge；原草稿已保留。']:[];
  const pending=await update();assert.deepEqual(pending.reloadRequired,{claude:false,codex:false});assert.equal(pending.hookTrustRequired,true);assert.equal(pending.next.length,1+autonomousNext.length);assert.match(pending.next[0],/\/hooks/);assert.deepEqual(pending.next.slice(1),autonomousNext);
  assert.deepEqual((parse(readFileSync(filename,'utf8')) as any).hooks.state,before);
  await approve(named);const accepted=(parse(readFileSync(filename,'utf8')) as any).hooks.state,unchanged=await update();
  assert.equal(unchanged.hookTrustRequired,false);assert.deepEqual(unchanged.next,autonomousNext);assert.deepEqual((parse(readFileSync(filename,'utf8')) as any).hooks.state,accepted);
  t.diagnostic(JSON.stringify({sameVersion:true,names:9,nameOnlyTrust:'modified',disabledPreserved:true,trustRecordsPreserved:true,pendingNoopRequiresTrust:true,approvedNoopRequiresTrust:false,realModelCalls:0}));
});
