import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { parse } from 'smol-toml';
import { configurationStatus, ensureConfiguration, readConfiguration, writeConfiguration } from '../config/configuration.js';
import { configurationCommand, requireConfigurationTerminal } from '../app/commands/config-command.js';
import {loadConfig} from '../config/load.js';
import {DEFAULT_CONFIG,DEFAULT_RETENTION} from '../config/defaults.js';
import { temporary } from './support/temporary.js';

test('旧 JSON 只读兼容，明确保存才迁移已知项，原备份保留且不创建用户 TOML',t=>{
  const home=temporary(t),legacy=path.join(home,'config.json'),raw='\ufeff{ "questionTimeoutMs": 42, "codexCommand": ["包装器", ""], "retention": {"maxEvents": 20}, "custom": "秘密" }\r\n';
  writeFileSync(legacy,raw,'utf8');
  assert.equal(loadConfig(home).questionTimeoutMs,42);assert.equal(existsSync(path.join(home,'config.managed.toml')),false);
  const before=configurationStatus(home);assert.equal(before.entries.find(item=>item.key==='questions.timeout_ms')!.source,'legacy-json');assert.doesNotMatch(JSON.stringify(before),/秘密/);
  ensureConfiguration(home);
  assert.equal(readFileSync(legacy,'utf8'),raw);assert.equal(existsSync(path.join(home,'config.toml')),false);
  assert.equal(loadConfig(home).retention!.maxEvents,20);assert.equal(loadConfig(home).retention!.logBackups,DEFAULT_RETENTION.logBackups);
  assert.deepEqual(loadConfig(home).codexCommand,['包装器','']);
  const status=configurationStatus(home);assert.equal(status.source,'toml');assert.equal(status.entries.find(item=>item.key==='questions.timeout_ms')!.source,'managed-toml');assert.equal((status.lastChange as any).migrated,true);
  assert.equal(readConfiguration(home).document.custom,undefined);
  const fresh=temporary(t);ensureConfiguration(fresh);assert.equal(configurationStatus(fresh).entries.find(item=>item.key==='questions.timeout_ms')!.source,'default');assert.equal(loadConfig(fresh).questionTimeoutMs,DEFAULT_CONFIG.questionTimeoutMs);
});

test('用户 TOML 优先，BOM、CRLF、多行字符串和注释原字节保留，覆盖项拒绝自动改写',t=>{
  const home=temporary(t),user=path.join(home,'config.toml');
  writeConfiguration(home,[{key:'questions.timeout_ms',value:100},{key:'retention.max_events',value:15}],'setup');
  const source=Buffer.from('\ufeff# 用户备注\r\nnote = """\r\n# 字符串里的注释\r\n[questions]\r\ntimeout_ms = 999\r\n"""\r\n[questions]\r\n# 超时\r\ntimeout_ms = 25 # 保留尾注\r\n','utf8');writeFileSync(user,source);
  const status=configurationStatus(home),entry=status.entries.find(item=>item.key==='questions.timeout_ms')!;
  assert.equal(loadConfig(home).questionTimeoutMs,25);assert.equal(entry.source,'user-toml');assert.equal(entry.editable,false);assert.equal(entry.shadowed,100);
  for(const value of [50,undefined])assert.throws(()=>writeConfiguration(home,[{key:'questions.timeout_ms',value}],'terminal'),error=>(error as any).code==='config_user_override'&&(error as Error).message.includes('config.toml:9:1'));
  writeConfiguration(home,[{key:'retention.max_events',value:35}],'terminal');assert.equal(loadConfig(home).retention!.maxEvents,35);
  assert.deepEqual(readFileSync(user),source);assert.equal(existsSync(path.join(home,'config.json')),false);
  const mixed=Buffer.from('note="""\n合法多行\n"""\r\n[questions]\ntimeout_ms=12\r\n');writeFileSync(user,mixed);writeConfiguration(home,[{key:'retention.log_backups',value:3}],'terminal');assert.deepEqual(readFileSync(user),mixed);
});

test('任一 TOML 无效时不回退、不写入，语法和类型错误定位但不暴露值',t=>{
  for(const filename of ['config.toml','config.managed.toml']){
    const home=temporary(t),file=path.join(home,filename),legacy=path.join(home,'config.json');
    writeFileSync(legacy,'{"questionTimeoutMs":99}','utf8');
    for(const raw of ['[questions]\ntimeout_ms = "秘密未闭合\n','[questions]\ntimeout_ms = "秘密类型错误"\n']){
      writeFileSync(file,raw,'utf8');
      assert.throws(()=>loadConfig(home),error=>{assert.match((error as Error).message,/config(?:\.managed)?\.toml:2:\d+/);assert.doesNotMatch((error as Error).message,/秘密/);return(error as any).code==='invalid_config';});
      assert.throws(()=>writeConfiguration(home,[{key:'retention.max_events',value:5}],'terminal'));
      assert.equal(readFileSync(file,'utf8'),raw);assert.equal(existsSync(path.join(home,'config-last-change.json')),false);
    }
  }
  const home=temporary(t);writeFileSync(path.join(home,'config.json'),'{无效但已被 TOML 取代','utf8');writeFileSync(path.join(home,'config.toml'),'[questions]\ntimeout_ms=8\n','utf8');assert.equal(loadConfig(home).questionTimeoutMs,8);
});

test('新增、扩展和删除嵌套启动命令，展示隐藏常见秘密参数，修改记录不保存值',t=>{
  const home=temporary(t),file=path.join(home,'config.managed.toml'),key='hosts.codex.command';
  writeConfiguration(home,[{key,value:['包装器','参数 空格','']}],'terminal');assert.deepEqual(loadConfig(home).codexCommand,['包装器','参数 空格','']);
  const command=['包装器','参数 空格','','--token','测试秘密','--api-key=另一个秘密','--auth-token','第三个秘密'];writeConfiguration(home,[{key,value:command}],'terminal');assert.deepEqual(loadConfig(home).codexCommand,command);
  const status=configurationStatus(home),shown=JSON.stringify(status);assert.doesNotMatch(shown,/测试秘密|另一个秘密|第三个秘密/);assert.match(shown,/已隐藏/);
  const audit=JSON.parse(readFileSync(path.join(home,'config-last-change.json'),'utf8'));assert.deepEqual(Object.keys(audit).sort(),['at','keys','migrated','origin']);assert.deepEqual(audit.keys,[key]);assert.equal(audit.origin,'terminal');
  const snapshot=readFileSync(file,'utf8');assert.equal(writeConfiguration(home,[{key,value:command}],'terminal').changed,false);assert.equal(readFileSync(file,'utf8'),snapshot);
  writeConfiguration(home,[{key}],'terminal');assert.equal(loadConfig(home).codexCommand,undefined);assert.equal((parse(readFileSync(file,'utf8')) as any).schema_version,1);
});

test('未知项逻辑保留，带点的字面键不会冒充已知路径，诊断只输出键名',t=>{
  const home=temporary(t),managed=path.join(home,'config.managed.toml'),user=path.join(home,'config.toml');
  writeFileSync(managed,'"questions.timeout_ms" = "未知秘密"\ncustom = { value = "附加秘密" }\nlarge = 9223372036854775807\n[questions]\ntimeout_ms=9\n','utf8');
  writeFileSync(user,'"questions.timeout_ms" = "用户秘密"\n','utf8');
  assert.equal(loadConfig(home).questionTimeoutMs,9);const status=configurationStatus(home);assert.equal(status.warnings.length,4);assert.doesNotMatch(JSON.stringify(status),/未知秘密|附加秘密|用户秘密|9223372036854775807/);assert.match(status.warnings.join('\n'),/"questions.timeout_ms"/);
  writeConfiguration(home,[{key:'questions.timeout_ms',value:20}],'terminal');const document=parse(readFileSync(managed,'utf8'),{integersAsBigInt:'asNeeded'});assert.equal(document['questions.timeout_ms'],'未知秘密');assert.equal(document.large,9223372036854775807n);assert.equal((document.custom as any).value,'附加秘密');assert.equal(loadConfig(home).questionTimeoutMs,20);
});

test('非法值、未知键、批内无效项与版本修改在迁移前拒绝，旧 retention 形状保持严格验证',t=>{
  const home=temporary(t),legacy=path.join(home,'config.json'),raw='{"questionTimeoutMs":100}';writeFileSync(legacy,raw,'utf8');
  for(const edit of [{key:'questions.timeout_ms',value:0},{key:'questions.timeout_ms',value:2147483648},{key:'retention.log_backups',value:11},{key:'hosts.codex.command',value:[]},{key:'hosts.codex.home',value:4},{key:'questions.typo',value:1},{key:'schema_version',value:1}])assert.throws(()=>writeConfiguration(home,[{key:'retention.max_events',value:5},edit],'terminal'));
  assert.equal(readFileSync(legacy,'utf8'),raw);assert.equal(existsSync(path.join(home,'config.managed.toml')),false);assert.equal(existsSync(path.join(home,'config-last-change.json')),false);
  for(const value of [5,null,[]]){writeFileSync(legacy,JSON.stringify({retention:value}),'utf8');assert.throws(()=>loadConfig(home),/retention/);}
  writeFileSync(path.join(home,'config.toml'),'questions=2026-11-01\n','utf8');assert.throws(()=>loadConfig(home),/questions 必须是 TOML 表/);
});

test('配置写入口复用终端来源校验，允许自定义 shell，拒绝非交互、宿主父链和查询失败',async()=>{
  const caller={pid:7,parentPid:6,name:'node.exe',startedAt:'10'},shell={pid:6,parentPid:0,name:'xonsh',startedAt:'1'};
  const terminal={origin:{pid:caller.pid,procStart:caller.startedAt,tty:true as const},ancestry:async()=>({ancestors:[caller,shell],complete:true,reason:'root'})};
  await requireConfigurationTerminal(terminal);
  await assert.rejects(requireConfigurationTerminal({...terminal,origin:undefined}),{code:'config_terminal_required'});
  await assert.rejects(requireConfigurationTerminal({...terminal,ancestry:async()=>({ancestors:[caller,{...shell,name:'codex.exe'}],complete:true,reason:'root'})}),{code:'config_terminal_required'});
  await assert.rejects(requireConfigurationTerminal({...terminal,ancestry:async()=>{throw Error('进程查询失败');}}),{code:'config_terminal_required'});
});

test('CLI 读入口返回来源与隐藏值，非法语法或宿主写入不生成配置文件',async t=>{
  const home=temporary(t);
  assert.equal((await configurationCommand(home,['get','questions.timeout_ms']) as any).source,'default');
  assert.ok((await configurationCommand(home,['list']) as any).entries.length>10);
  for(const args of [[],['list','多余'],['set','questions.timeout_ms'],['get','typo'],['unset','schema_version','多余']])await assert.rejects(configurationCommand(home,args));
  const terminal={origin:{pid:7,procStart:'10',tty:true as const},ancestry:async()=>({ancestors:[{pid:7,parentPid:0,name:'xonsh',startedAt:'10'}],complete:true,reason:'root'})};
  await assert.rejects(configurationCommand(home,['set','questions.timeout_ms','30'],{...terminal,origin:undefined}),{code:'config_terminal_required'});assert.equal(existsSync(path.join(home,'config.managed.toml')),false);
  const saved=await configurationCommand(home,['set','questions.timeout_ms','30'],terminal) as any;
  assert.equal(saved.entry.value,30);assert.equal(saved.applied,false);assert.equal(existsSync(path.join(home,'run')),false,'离线保存不依赖或另起协调器');
  await configurationCommand(home,['set','collaboration.implicit','never'],terminal);assert.equal(loadConfig(home).implicit,'never');
  const command=['包装器','参数 空格','','--token','CLI秘密'];await configurationCommand(home,['set','hosts.codex.command',JSON.stringify(command)],terminal);assert.deepEqual(loadConfig(home).codexCommand,command);assert.doesNotMatch(JSON.stringify(await configurationCommand(home,['get','hosts.codex.command'])),/CLI秘密/);
  await configurationCommand(home,['unset','hosts.codex.command'],terminal);assert.equal(loadConfig(home).codexCommand,undefined);
  await configurationCommand(home,['unset','questions.timeout_ms'],terminal);assert.equal(loadConfig(home).questionTimeoutMs,DEFAULT_CONFIG.questionTimeoutMs);
});
