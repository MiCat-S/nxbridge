import test from 'node:test';
import { VERSION } from '../version.js';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync, renameSync, statSync, utimesSync } from 'node:fs';
import path from 'node:path';
import {parse} from 'smol-toml';
import { preparePlugins, setup, uninstall, type SetupServices } from '../install/setup.js';
import { installedCacheDirectories } from '../install/installation.js';
import {atomicJson,readJson} from '../shared/files.js';
import {CLI_PATH} from '../shared/package-location.js';
import { fileHashes } from '../install/runtime-install.js';
import { withBrokerStartup } from '../broker/broker-startup.js';
import { processIdentity } from '../process/process.js';

import { fixture, autonomousNext } from './setup-fixture.js';

test('重复准备保留稳定入口及未变文件，清理废弃文件而不删除插件目录',async t=>{
  const f=fixture(t),root=await preparePlugins(f.home),target=path.join(root,'plugins','codex'),bridge=path.join(target,'bridge.cjs'),old=new Date('2000-01-01T00:00:00Z');
  utimesSync(bridge,old,old);const before=statSync(bridge).mtimeMs;writeFileSync(path.join(target,'obsolete.js'),'已废弃','utf8');
  await preparePlugins(f.home);assert.equal(statSync(bridge).mtimeMs,before);assert.equal(existsSync(path.join(target,'obsolete.js')),false);assert.ok(existsSync(path.join(target,'.mcp.json')));
});

test('MCP 入口用 PATH 中的 node，不写死会随 Node 升级失效的安装路径',async t=>{
  const f=fixture(t),root=await preparePlugins(f.home);
  for(const [host,server] of [['codex','claude'],['claude','codex']] as const){
    const target=path.join(root,'plugins',host),entry=readJson<{mcpServers:Record<string,{command:string;args:string[]}>}>(path.join(target,'.mcp.json')).mcpServers[server]!;
    assert.equal(entry.command,'node');assert.equal(entry.args[0],path.join(target,'bridge.cjs'));
  }
});

test('嵌套来源清单在安装与卸载中使用同一归属判定',async t=>{
  const f=fixture(t),run=f.services.run!;
  f.services.run=async(host,args)=>{
    const result=await run(host,args);
    return args[1]==='marketplace'&&args[2]==='list'?JSON.stringify(JSON.parse(result).map((value:any)=>({name:value.name,source:{source:{path:value.path}}}))):result;
  };
  assert.equal((await setup({home:f.home},f.services) as any).installed,true);
  assert.equal((await setup({home:f.home},f.services) as any).installed,true);
  assert.equal((await uninstall(f.home,{},f.services) as any).removed,true);assert.equal(f.registry.codex.installed,false);assert.equal(f.registry.claude.installed,false);
});

test('安装、更新和卸载只读取自有 Codex 市场，远程目录故障不阻塞本地维护',async t=>{
  const f=fixture(t),run=f.services.run!;
  f.services.run=async(host,args)=>{
    if(host==='codex'&&args[0]==='plugin'&&args[1]==='list'&&args[args.indexOf('--marketplace')+1]!=='nxbridge-local')throw Error('隔离远程插件目录不可达');
    return run(host,args);
  };
  assert.equal((await setup({home:f.home},f.services) as any).installed,true);
  f.registry.codex.enabled=false;
  assert.equal((await setup({home:f.home},f.services) as any).installed,true);
  assert.equal(f.registry.codex.enabled,false);
  assert.equal((await uninstall(f.home,{},f.services) as any).removed,true);
  assert.ok(f.calls.filter(call=>call.host==='codex'&&call.args[1]==='list').length>=3);
});


test('跨版本已登记宿主仍存活或代次未知时只同步现有路径，退出后才刷新原生版本登记',async t=>{
  const f=fixture(t);await setup({home:f.home},f.services);
  const previous=path.join(path.dirname(f.cache('codex')),'0.1.0');renameSync(f.cache('codex'),previous);f.registry.codex.version='0.1.0';
  atomicJson(path.join(previous,'.codex-plugin','plugin.json'),{name:'nxbridge',version:'0.1.0'});writeFileSync(path.join(previous,'bridge.cjs'),'旧轮次已信任的字节','utf8');const before=fileHashes(previous),run=f.services.run!;
  f.services.run=async(host,args)=>{if(host==='codex'&&args[1]==='add')rmSync(previous,{recursive:true});return run(host,args);};
  f.services.nativeProcesses=async()=>[{pid:123,startedAt:'仍在运行的原生代次'}];
  const updated=await setup({home:f.home},f.services) as any;
  const update=updated.updates.find((value:any)=>value.host==='codex');
  assert.ok(existsSync(previous));assert.notDeepEqual(fileHashes(previous),before);assert.equal(update.mode,'file-sync-fallback');assert.deepEqual(update.paths,[previous]);assert.equal(readJson<any>(path.join(previous,'.codex-plugin','plugin.json')).version,VERSION);
  assert.equal(f.registry.codex.version,'0.1.0');assert.equal(update.cacheVersions[0].nativeVersion,'0.1.0');assert.equal(update.cacheVersions[0].cacheVersion,VERSION);assert.equal(update.cacheVersions[0].nativeInventoryLag,true);
  assert.ok(updated.notes.some((value:string)=>value.includes('原生清单版本可能仍显示旧版')));
  assert.deepEqual(updated.reloadRequired,{claude:false,codex:true});
  const synced=fileHashes(previous);f.services.nativeProcesses=async()=>{throw Error('隔离探测不可用');};
  const unchanged=await setup({home:f.home},f.services) as any;assert.deepEqual(fileHashes(previous),synced);assert.deepEqual(unchanged.reloadRequired,{claude:false,codex:false});assert.deepEqual(unchanged.next,autonomousNext);
  f.services.nativeProcesses=async()=>[];await setup({home:f.home},f.services);assert.equal(f.registry.codex.version,VERSION);assert.ok(existsSync(f.cache('codex')));
  await setup({home:f.home},f.services);assert.equal(existsSync(previous),false);
});

test('插件文件未变仍提示原生待信任状态，已信任和元数据不可读时分别给出准确操作',async t=>{
  const f=fixture(t);await setup({home:f.home},f.services);f.trust('modified');
  const pending=await setup({home:f.home},f.services) as any;
  assert.deepEqual(pending.reloadRequired,{claude:false,codex:false});assert.equal(pending.next.length,1+autonomousNext.length);assert.match(pending.next[0],/\/hooks.*确认/);assert.deepEqual(pending.next.slice(1),autonomousNext);assert.match(pending.notice,/还没有重新信任/);
  const config=readFileSync(path.join(f.codex,'config.toml'),'utf8');f.trust('trusted');
  const trusted=await setup({home:f.home},f.services) as any;assert.deepEqual(trusted.next,autonomousNext);assert.match(trusted.notice,/不需要任何操作/);assert.equal(readFileSync(path.join(f.codex,'config.toml'),'utf8'),config);
  f.trust(undefined);writeFileSync(path.join(f.cache('codex'),'bridge.cjs'),'隔离旧内容','utf8');
  const unknown=await setup({home:f.home},f.services) as any;assert.equal(unknown.reloadRequired.codex,true);assert.ok(unknown.next.some((value:string)=>value.includes('如果 /hooks')));assert.ok(!unknown.next.some((value:string)=>value.includes('/reload-plugins')));
});

test('插件更新按当前存活的 Codex 根会话给出确切重启或恢复命令，已结束会话不提示',async t=>{
  const f=fixture(t);await setup({home:f.home},f.services);
  const peers=[{id:'owned',host:'codex',name:'后台搭档',owner:'nxbridge',kind:'root',sessionId:'owned-session'},{id:'user',host:'codex',name:'用户窗口',owner:'user',kind:'root',sessionId:'user-session'},{id:'gone',host:'codex',name:'已结束窗口',owner:'user',kind:'root',sessionId:'gone-session'},{id:'child',host:'codex',name:'子代理',owner:'nxbridge',kind:'subagent',sessionId:'child-session'},{id:'off',host:'codex',name:'已关闭成员',owner:'nxbridge',kind:'root',enabled:false,sessionId:'off-session'}];
  let status={peers,endpoints:peers.map(peer=>({peerId:peer.id,active:peer.id!=='gone'}))};
  f.services.broker=async(method)=>{if(method==='status')return status as any;throw Object.assign(Error('隔离 broker 不存在'),{code:'ENOENT'});};
  writeFileSync(path.join(f.cache('codex'),'bridge.cjs'),'待更新的原插件','utf8');
  const updated=await setup({home:f.home},f.services) as any,text=updated.next.join('\n');
  assert.match(text,/nxbridge restart codex --member owned/);assert.match(text,/codex resume user-session/);assert.doesNotMatch(text,/gone-session|child-session|off-session|<成员ID>|下一轮会自动恢复/);
  status={peers:[],endpoints:[]};writeFileSync(path.join(f.cache('codex'),'bridge.cjs'),'再次更新的原插件','utf8');
  const empty=await setup({home:f.home},f.services) as any;assert.equal(empty.next.some((value:string)=>/restart codex|codex resume/.test(value)),false);
});

test('安装预检拒绝 Node、命名空间、市场和命令冲突，检查失败不写安装目录',async t=>{
  const f=fixture(t);
  await assert.rejects(setup({home:f.home},{...f.services,nodeVersion:'23.0.0'}),{code:'node_version'});assert.equal(existsSync(f.home),false);
  writeFileSync(path.join(f.codex,'config.toml'),'[mcp_servers.claude]\ncommand="用户命令"\n','utf8');
  await assert.rejects(setup({home:f.home},f.services),{code:'namespace_conflict'});assert.equal(existsSync(f.home),false);
  rmSync(path.join(f.codex,'config.toml'));
  f.registry.codex.market=true;f.marketSource(path.join(f.directory,'foreign'));
  await assert.rejects(setup({home:f.home},f.services),{code:'marketplace_conflict'});assert.equal(existsSync(f.home),false);
  f.registry.codex.market=false;
  const filename=path.join(f.bin,process.platform==='win32'?'nxbridge.cmd':'nxbridge');writeFileSync(filename,'用户自己的命令','utf8');
  await assert.rejects(setup({home:f.home},f.services),{code:'shim_conflict'});assert.equal(readFileSync(filename,'utf8'),'用户自己的命令');assert.equal(existsSync(f.home),false);
  rmSync(filename);const root=path.join(f.home,'marketplace');mkdirSync(root,{recursive:true});writeFileSync(path.join(root,'user.txt'),'用户目录','utf8');
  await assert.rejects(setup({home:f.home},f.services),{code:'marketplace_conflict'});assert.deepEqual(readdirSync(root),['user.txt']);
});

test('首次安装创建可撤销入口，重复 setup 同步缓存且保留两端禁用状态',async t=>{
  const f=fixture(t);writeFileSync(path.join(f.codex,'config.toml'),'[features]\ncode_mode=true\nother_feature=true\n','utf8');
  const first:any=await setup({home:f.home},f.services);assert.equal(first.command,'nxbridge');assert.equal(first.installed,true);
  const runtime=readJson<any>(path.join(f.home,'bin','runtime.json'));
  assert.ok(runtime.entry.startsWith(path.join(f.home,'runtime')+path.sep));assert.notEqual(runtime.entry,CLI_PATH);
  for(const host of ['claude','codex'] as const){f.registry[host].enabled=false;writeFileSync(path.join(f.cache(host),'skills','partner','SKILL.md'),'旧缓存','utf8');}
  f.calls.length=0;
  const next:any=await setup({home:f.home},f.services);
  assert.equal(f.calls.some(call=>['add','install','remove','uninstall'].includes(call.args[1]!)),false);
  assert.equal(f.registry.codex.enabled,false);assert.equal(f.registry.claude.enabled,false);
  assert.ok(next.updates.some((update:any)=>update.host==='codex'&&update.mode==='file-sync-fallback'));
  assert.notEqual(readFileSync(path.join(f.cache('codex'),'skills','partner','SKILL.md'),'utf8'),'旧缓存');
  const config:any=parse(readFileSync(path.join(f.codex,'config.toml'),'utf8'));assert.equal(config.features.other_feature,true);assert.equal(config.features.code_mode.enabled,true);
  const before=readFileSync(path.join(f.home,'setup-state.json'),'utf8');
  assert.equal((await setup({home:f.home,dryRun:true},f.services) as any).dryRun,true);assert.equal(readFileSync(path.join(f.home,'setup-state.json'),'utf8'),before);
});

for(const enabled of [true,false,undefined])test(`跨版本更新：Codex 启用状态 ${enabled} 决定官方登记更新或保留文件同步`,async t=>{
  const f=fixture(t);await setup({home:f.home},f.services);
  const original=f.cache('codex');f.registry.codex.version='0.1.0';renameSync(original,f.cache('codex'));
  f.registry.codex.enabled=enabled;const previous=f.cache('codex'),configuration=readFileSync(path.join(f.codex,'config.toml'),'utf8');f.calls.length=0;
  const result:any=await setup({home:f.home},f.services);
  const adds=f.calls.filter(call=>call.host==='codex'&&call.args[1]==='add');
  assert.equal(adds.length,enabled===true?1:0);assert.equal(f.registry.codex.enabled,enabled);
  assert.equal(f.registry.codex.version,enabled===true?VERSION:'0.1.0');
  assert.equal(result.updates.find((update:any)=>update.host==='codex').mode,enabled===true?'official-update':'file-sync-fallback');
  if(enabled!==true)assert.ok(result.notes.some((note:string)=>note.includes('原生清单版本可能仍显示旧版')));
  for(const cache of installedCacheDirectories(f.codex,'codex'))assert.equal(readJson<any>(path.join(cache,'.codex-plugin','plugin.json')).version,VERSION);
  assert.equal(readJson<any>(path.join(previous,'.codex-plugin','plugin.json')).version,VERSION);
  assert.equal(readFileSync(path.join(f.codex,'config.toml'),'utf8'),configuration);
});

test('Windows 更新在旧协调器停止前预约，直到新协调器就绪才释放',{skip:process.platform!=='win32'},async t=>{
  const f=fixture(t),owner=await processIdentity(process.pid),steps:string[]=[];
  f.services.broker=(async(method,_params,options)=>{
    steps.push(method+(options?.start===false?':existing':':start'));
    if(steps.length<=3){
      assert.equal(await withBrokerStartup(f.home,[],async()=>true),undefined,'交接期间其他宿主不能绑定端点');
      assert.equal(await withBrokerStartup(f.home,[owner],async()=>true),true,'更新调用方仍可启动');
    }else assert.equal(await withBrokerStartup(f.home,[],async()=>true),true,'就绪检查前已释放交接预约');
    if(options?.start!==false)assert.equal(options?.reserved,true);
    return{pid:2147483647,runtime:{windowsIndependent:true}};
  }) as SetupServices['broker'];
  const result:any=await setup({home:f.home},f.services);
  assert.equal(result.brokerRestarted,true);
  assert.deepEqual(steps.slice(0,3),['ping:existing','shutdown:existing','ping:start']);
  assert.equal(await withBrokerStartup(f.home,[],async()=>true),true);
});

test('Windows 更新预检拒绝时继续保留旧协调器，不进入停止或启动步骤',{skip:process.platform!=='win32'},async t=>{
  const f=fixture(t),steps:string[]=[];
  f.services.backgroundPreflight=async()=>{steps.push('probe');throw Object.assign(Error('普通 PowerShell 中运行 nxbridge bootstrap'),{code:'bootstrap_context_unavailable'});};
  f.services.broker=(async(method)=>{steps.push(method);if(method==='status')return{peers:[],endpoints:[]};assert.equal(method,'ping');return{pid:process.pid,runtime:{windowsIndependent:false}};}) as SetupServices['broker'];
  const result:any=await setup({home:f.home},f.services);
  assert.equal(result.brokerRestarted,false);assert.deepEqual(steps,['probe','ping','status']);
  assert.equal(existsSync(path.join(f.home,'run','broker-startup.db')),false);
  assert.ok(result.notes.some((note:string)=>note.includes('普通 PowerShell')));
});

test('安装中途失败保留进度，重试修复缺失的宿主与缓存',async t=>{
  const f=fixture(t);f.fail('codex plugin add');
  await assert.rejects(setup({home:f.home},f.services),/隔离故障/);
  assert.equal(readJson<any>(path.join(f.home,'setup-state.json')).claudeInstalled,true);
  f.fail('');f.calls.length=0;await setup({home:f.home},f.services);
  assert.equal(f.calls.some(call=>call.host==='claude'&&call.args[1]==='install'),false);
  assert.equal(f.registry.codex.installed,true);
  f.registry.codex.installed=false;rmSync(f.cache('codex'),{recursive:true});await setup({home:f.home},f.services);
  assert.equal(installedCacheDirectories(f.codex,'codex').length,1);
});
