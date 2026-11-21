import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { configurationField } from '../config/config-schema.js';
import { configurationStatus, ensureConfiguration, loadBridgeConfig, writeConfiguration } from '../config/configuration.js';
import { configurationCommand } from '../app/commands/config-command.js';
import { captureFrozenProfile, frozenProfiles, profileDefaults, syncFrozenProfiles } from '../broker/profiles/frozen-profile.js';
import {DEFAULT_CONFIG} from '../config/defaults.js';
import {type BridgeConfig,type Host} from '../types.js';
import { temporary } from './support/temporary.js';
import {fixture, lifecycle} from './support/broker-fixture.js';
import { formatGlobalStatus, formatStatus } from '../integration/mcp/presentation.js';

const frozen=(host:Host):BridgeConfig=>({...DEFAULT_CONFIG,partnerProfiles:{[host]:{source:'frozen'}}});
const stateFile=(home:string)=>path.join(home,'frozen-profiles.json');

test('缺省继续使用宿主配置，旧 JSON 与新配置键保持兼容，所有搭档配置项需要人工确认',t=>{
  const home=temporary(t),legacy=path.join(home,'config.json'),raw='{"questionTimeoutMs":42}';
  writeFileSync(legacy,raw,'utf8');
  const config=loadBridgeConfig(home);
  assert.equal(config.questionTimeoutMs,42);
  for(const host of ['claude','codex'] as const){
    assert.equal(config.partnerProfiles?.[host]?.source,'host');
    assert.deepEqual(profileDefaults(home,config,host),{});
    for(const key of ['model','effort','profile_source'])assert.equal(configurationField(`partners.${host}.${key}`).safe,false);
  }
  assert.deepEqual(frozenProfiles(home,config),{});
  assert.equal(existsSync(stateFile(home)),false);
  assert.equal(readFileSync(legacy,'utf8'),raw);
  assert.equal(existsSync(path.join(home,'config.managed.toml')),false);
});

test('显式默认值逐项覆盖冻结值，数值零不会被当作缺省，宿主模式不使用旧捕获',t=>{
  const home=temporary(t),config=frozen('claude');
  captureFrozenProfile(home,config,'claude',{model:'native-model',effort:0});
  assert.deepEqual(profileDefaults(home,config,'claude'),{model:'native-model',effort:0});
  const defaults=(values:BridgeConfig['partnerProfiles'])=>profileDefaults(home,{...config,partnerProfiles:values},'claude');
  assert.deepEqual(defaults({claude:{source:'frozen',model:'explicit-model'}}),{model:'explicit-model',effort:0});
  assert.deepEqual(defaults({claude:{source:'frozen',effort:'max'}}),{model:'native-model',effort:'max'});
  assert.deepEqual(defaults({claude:{source:'frozen',model:'explicit-model',effort:0}}),{model:'explicit-model',effort:0});
  assert.deepEqual(defaults({claude:{model:'host-model'}}),{model:'host-model'});
  assert.deepEqual(defaults({}),{});
  assert.deepEqual(profileDefaults(home,config,'codex'),{});
});

test('首次原生模型持久冻结，延迟 effort 只接受同模型快照且每个字段只捕获一次',t=>{
  const home=temporary(t),config=frozen('codex');
  captureFrozenProfile(home,config,'codex',{model:'first-model'});
  const first=frozenProfiles(home,config).codex!;
  assert.equal(first.model,'first-model');assert.equal(first.effort,undefined);assert.ok(first.at>0);
  captureFrozenProfile(home,config,'codex',{model:'other-model',effort:'high'});
  captureFrozenProfile(home,config,'codex',{effort:'high'});
  assert.deepEqual(frozenProfiles(home,config).codex,first);
  captureFrozenProfile(home,config,'codex',{model:'first-model',effort:0});
  assert.deepEqual(frozenProfiles(home,config).codex,{...first,effort:0});
  const captured=readFileSync(stateFile(home),'utf8');
  captureFrozenProfile(home,config,'codex',{model:'first-model',effort:'changed'});
  captureFrozenProfile(home,config,'codex',{model:'later-model',effort:'later'});
  assert.equal(readFileSync(stateFile(home),'utf8'),captured);
  assert.deepEqual(profileDefaults(home,frozen('codex'),'codex'),{model:'first-model',effort:0});
});

test('未开启冻结与未解析的原生值不写记录，非法 effort 不阻止后续有效捕获',t=>{
  const home=temporary(t),config=frozen('claude');
  captureFrozenProfile(home,DEFAULT_CONFIG,'claude',{model:'ignored',effort:'high'});
  for(const observed of [{},{effort:0},{model:''},{model:'   ',effort:'high'},{model:null,effort:'high'}])captureFrozenProfile(home,config,'claude',observed as any);
  assert.equal(existsSync(stateFile(home)),false);
  captureFrozenProfile(home,config,'claude',{model:'resolved',effort:NaN});
  const first=frozenProfiles(home,config).claude!;
  assert.deepEqual(profileDefaults(home,config,'claude'),{model:'resolved'});
  for(const effort of ['', '  ',Infinity,-Infinity,null,{},[]])captureFrozenProfile(home,config,'claude',{model:'resolved',effort} as any);
  assert.deepEqual(frozenProfiles(home,config).claude,first);
  captureFrozenProfile(home,config,'claude',{model:'resolved',effort:'future-level'});
  assert.deepEqual(profileDefaults(home,config,'claude'),{model:'resolved',effort:'future-level'});
});

test('关闭或 unset 清除该宿主冻结记录，再次开启重新捕获，不影响另一宿主',t=>{
  const home=temporary(t);
  writeConfiguration(home,[{key:'partners.claude.profile_source',value:'frozen'},{key:'partners.codex.profile_source',value:'frozen'},{key:'partners.claude.model',value:'explicit'}],'terminal');
  const capture=(host:Host,model:string)=>captureFrozenProfile(home,loadBridgeConfig(home),host,{model,effort:'high'});
  capture('claude','first-claude');capture('codex','first-codex');
  const codex=frozenProfiles(home,loadBridgeConfig(home)).codex;
  writeConfiguration(home,[{key:'partners.claude.profile_source',value:'host'}],'terminal');
  assert.deepEqual(frozenProfiles(home,loadBridgeConfig(home)),{codex});
  assert.equal(JSON.parse(readFileSync(stateFile(home),'utf8')).profiles.claude,undefined);
  assert.deepEqual(profileDefaults(home,loadBridgeConfig(home),'claude'),{model:'explicit'});
  writeConfiguration(home,[{key:'partners.claude.profile_source',value:'frozen'}],'terminal');
  assert.deepEqual(profileDefaults(home,loadBridgeConfig(home),'claude'),{model:'explicit'});
  capture('claude','second-claude');
  assert.equal(frozenProfiles(home,loadBridgeConfig(home)).claude!.model,'second-claude');
  writeConfiguration(home,[{key:'partners.claude.profile_source'}],'terminal');
  assert.deepEqual(frozenProfiles(home,loadBridgeConfig(home)),{codex});
  assert.equal(JSON.parse(readFileSync(stateFile(home),'utf8')).profiles.claude,undefined);
  writeConfiguration(home,[{key:'partners.codex.profile_source'}],'terminal');
  assert.deepEqual(frozenProfiles(home,loadBridgeConfig(home)),{});
  assert.deepEqual(JSON.parse(readFileSync(stateFile(home),'utf8')).profiles,{});
});

test('手写配置重载清理关闭宿主；显式默认值变更保留捕获，未改用户或原生文件',t=>{
  const home=temporary(t),native=path.join(home,'native'),user=path.join(home,'config.toml');mkdirSync(native);
  const nativeFile=path.join(native,'config.toml'),nativeText='[原生配置不要求是合法 TOML';writeFileSync(nativeFile,nativeText,'utf8');
  const userText='[partners.codex]\nprofile_source="frozen"\n';writeFileSync(user,userText,'utf8');
  writeConfiguration(home,[{key:'hosts.codex.home',value:native}],'terminal');
  captureFrozenProfile(home,loadBridgeConfig(home),'codex',{model:'captured',effort:'medium'});
  const before=frozenProfiles(home,loadBridgeConfig(home));
  writeConfiguration(home,[{key:'partners.codex.model',value:'explicit'},{key:'partners.codex.effort',value:'low'}],'terminal');
  assert.deepEqual(frozenProfiles(home,loadBridgeConfig(home)),before);
  assert.deepEqual(profileDefaults(home,loadBridgeConfig(home),'codex'),{model:'explicit',effort:'low'});
  assert.equal(readFileSync(user,'utf8'),userText);assert.equal(readFileSync(nativeFile,'utf8'),nativeText);
  writeFileSync(user,'[partners.codex]\nprofile_source="host"\n','utf8');
  syncFrozenProfiles(home,loadBridgeConfig(home));
  assert.deepEqual(JSON.parse(readFileSync(stateFile(home),'utf8')).profiles,{});
});

test('配置状态与 get 显示冻结元数据，查询不捕获，用户覆盖项保持不可自动编辑',async t=>{
  const home=temporary(t),key='partners.claude.profile_source';
  const initial=await configurationCommand(home,['get',key]) as any;
  assert.equal(initial.value,'host');assert.equal(initial.source,'default');assert.equal(initial.captured,null);
  writeFileSync(path.join(home,'config.toml'),'[partners.claude]\nprofile_source="frozen"\n','utf8');
  const pending=configurationStatus(home);assert.deepEqual(pending.frozen_profiles,{});assert.equal(existsSync(stateFile(home)),false);
  captureFrozenProfile(home,loadBridgeConfig(home),'claude',{model:'observed-model',effort:0});
  const status=configurationStatus(home),entry=status.entries.find(item=>item.key===key)!;
  assert.deepEqual(entry.captured,status.frozen_profiles.claude);assert.equal(entry.editable,false);assert.equal(entry.source,'user-toml');
  const shown=await configurationCommand(home,['get',key]) as any;
  assert.deepEqual(shown.captured,status.frozen_profiles.claude);
  assert.throws(()=>writeConfiguration(home,[{key}],'terminal'),{code:'config_user_override'});
});

test('模型和 effort 不设允许列表，空白、非有限数值、无效类型和模式在写入前拒绝',t=>{
  const home=temporary(t);
  for(const key of ['partners.codex.model','partners.claude.model'])for(const value of ['', '  ', 0, null, [], {}])
    assert.throws(()=>writeConfiguration(home,[{key,value}],'terminal'),{code:'invalid_config'});
  for(const key of ['partners.codex.effort','partners.claude.effort'])for(const value of ['', '\t',NaN,Infinity,-Infinity,null,true,[],{}])
    assert.throws(()=>writeConfiguration(home,[{key,value}],'terminal'),{code:'invalid_config'});
  for(const value of ['', 'snapshot', 0, null])assert.throws(()=>writeConfiguration(home,[{key:'partners.codex.profile_source',value}],'terminal'),{code:'invalid_config'});
  assert.equal(existsSync(path.join(home,'config.managed.toml')),false);
  writeConfiguration(home,[{key:'partners.codex.model',value:'future/vendor-model-v9'},{key:'partners.codex.effort',value:'future-level'},{key:'partners.claude.effort',value:0}],'terminal');
  assert.deepEqual(profileDefaults(home,loadBridgeConfig(home),'codex'),{model:'future/vendor-model-v9',effort:'future-level'});
  assert.deepEqual(profileDefaults(home,loadBridgeConfig(home),'claude'),{effort:0});
  for(const raw of ['partners=[]\n','[partners]\ncodex=5\n','[partners.codex]\nmodel=""\n']){
    writeFileSync(path.join(home,'config.toml'),raw,'utf8');assert.throws(()=>loadBridgeConfig(home),{code:'invalid_config'});
  }
});

test('旧 JSON 支持新内部配置结构并按已知项迁移，错误嵌套形状拒绝而不丢弃',t=>{
  const home=temporary(t),legacy=path.join(home,'config.json');
  const raw=JSON.stringify({partnerProfiles:{codex:{source:'frozen',model:'legacy-model',effort:0}}});writeFileSync(legacy,raw,'utf8');
  assert.deepEqual(profileDefaults(home,loadBridgeConfig(home),'codex'),{model:'legacy-model',effort:0});
  ensureConfiguration(home);assert.equal(readFileSync(legacy,'utf8'),raw);
  assert.equal(configurationStatus(home).entries.find(item=>item.key==='partners.codex.profile_source')!.value,'frozen');
  assert.deepEqual(profileDefaults(home,loadBridgeConfig(home),'codex'),{model:'legacy-model',effort:0});
  for(const value of [null, [], 0, 'invalid', {codex:[]}, {claude:null}]){
    const invalid=temporary(t),file=path.join(invalid,'config.json'),text=JSON.stringify({partnerProfiles:value});writeFileSync(file,text,'utf8');
    assert.throws(()=>loadBridgeConfig(invalid),{code:'invalid_config'});assert.equal(readFileSync(file,'utf8'),text);
  }
});

test('损坏冻结记录不使 broker 或状态退出，诊断可见且依赖冻结的创建拒绝',async t=>{
  const f=fixture(t,{implicit:'on-demand',partnerProfiles:{codex:{source:'frozen'}}}),home=(f.broker as any).home as string,file=stateFile(home),raw='{损坏';
  writeFileSync(file,raw,'utf8');
  syncFrozenProfiles(home,f.broker.config);
  const status=f.broker.status() as any;assert.equal(status.capabilities.profile_warnings.length,1);
  assert.match(formatGlobalStatus(status),/固定的模型和推理强度记录格式无效/);
  assert.match(formatStatus(f.broker.status({host:'claude',sessionId:f.c.sessionId!,callId:'corrupt-status'})),/固定的模型和推理强度记录格式无效/);
  assert.throws(()=>f.broker.profiles.initialize(f.store.placeholder('codex',f.c.cwd)),{code:'invalid_frozen_profiles'});
  const actor={host:'claude' as const,sessionId:f.c.sessionId!,callId:'corrupt-create'},selection=await f.broker.dispatch('pair.code',{actor}) as any;
  await assert.rejects(f.broker.dispatch('pair.selection.commit',{actor,selection_id:selection.selection_id,action:'create'}),{code:'invalid_frozen_profiles'});
  assert.equal(f.store.pairs().length,0);assert.equal(f.store.messages().length,0);
  const failed=f.store.placeholder('codex',f.c.cwd);await assert.rejects(lifecycle(f.broker).prepare(failed),{code:'invalid_frozen_profiles'});
  assert.equal(f.store.peer(failed.id).launchFailure?.code,'invalid_frozen_profiles');
  assert.deepEqual(profileDefaults(home,f.broker.config,'codex',{model:'explicit',effort:'high'}),{model:'explicit',effort:'high'});
  captureFrozenProfile(home,f.broker.config,'codex',{model:'observed',effort:'low'});
  assert.equal(readFileSync(file,'utf8'),raw);
});
