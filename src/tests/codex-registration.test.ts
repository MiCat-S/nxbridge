import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { stringify } from 'smol-toml';
import { inspectCodexRegistration } from '../hosts/codex/codex-registration.js';
import { formatGlobalStatus } from '../integration/mcp/presentation.js';
import { temporary } from './support/temporary.js';

test('登记丢失、禁用与已卸载分别诊断，查询保留配置原字节',t=>{
  const home=temporary(t),codex=path.join(home,'codex');mkdirSync(codex);
  const state=path.join(home,'setup-state.json'),file=path.join(codex,'config.toml');
  assert.equal(inspectCodexRegistration(home).state,'unrecorded');
  writeFileSync(state,JSON.stringify({codexInstalled:true,hostHomes:{codex}}));
  assert.equal(inspectCodexRegistration(home).state,'repair_required');
  for(const [config,expected] of [
    ['# 用户设置\nmodel_verbosity="low"\n','repair_required'],
    ['[plugins."nxbridge@nxbridge-local"]\nenabled=true\n','repair_required'],
    ['[marketplaces.nxbridge-local]\nsource="本地市场"\n','repair_required'],
    ['[plugins."nxbridge@nxbridge-local"]\nenabled=false\n[marketplaces.nxbridge-local]\nsource="本地市场"\n','disabled'],
    ['[plugins."nxbridge@nxbridge-local"]\nenabled=true\n[marketplaces.nxbridge-local]\nsource="本地市场"\n','current'],
    ['损坏的 toml = [','unknown'],
  ] as const){
    writeFileSync(file,config,'utf8');
    assert.equal(inspectCodexRegistration(home).state,expected);
    assert.equal(readFileSync(file,'utf8'),config);
  }
  writeFileSync(state,JSON.stringify({codexInstalled:true,disabled:true,hostHomes:{codex}}));
  assert.deepEqual(inspectCodexRegistration(home),{state:'unrecorded',issues:[]});
});

test('命名空间设置丢失或排除 claude 时提示修复，兼容全局启用和显式关闭代码模式',t=>{
  const home=temporary(t),codex=path.join(home,'codex');mkdirSync(codex);
  const setup={codexInstalled:true,hostHomes:{codex}},state=path.join(home,'setup-state.json');
  writeFileSync(state,JSON.stringify({...setup,changes:[{keyPath:'features.non_prefixed_mcp_tool_names'},{keyPath:'features.code_mode'}]}));
  for(const [features,expected] of [
    [{},'repair_required'],
    [{non_prefixed_mcp_tool_names:{enabled:true,server_names:['other']},code_mode:false},'repair_required'],
    [{non_prefixed_mcp_tool_names:true},'repair_required'],
    [{non_prefixed_mcp_tool_names:true,code_mode:false},'current'],
    [{non_prefixed_mcp_tool_names:{enabled:true},code_mode:{direct_only_tool_namespaces:['claude']}},'current'],
    [{non_prefixed_mcp_tool_names:{enabled:true,server_names:['claude']},code_mode:{enabled:false}},'current'],
    [{code_mode_only_strict_3p_tools:true,code_mode:{direct_only_tool_namespaces:['claude']}},'current'],
    [{code_mode_only_strict_3p_tools:true},'current'],
  ] as const){
    writeFileSync(path.join(codex,'config.toml'),stringify({plugins:{'nxbridge@nxbridge-local':{enabled:true}},marketplaces:{'nxbridge-local':{source:'本地市场'}},features}));
    assert.equal(inspectCodexRegistration(home).state,expected);
  }
                                           
  writeFileSync(state,JSON.stringify(setup));
  writeFileSync(path.join(codex,'config.toml'),stringify({plugins:{'nxbridge@nxbridge-local':{enabled:true}},marketplaces:{'nxbridge-local':{source:'本地市场'}}}));
  assert.equal(inspectCodexRegistration(home).state,'current');
});

test('状态输出明确提示修复缺失登记，诊断不把配置正文输出',t=>{
  const home=temporary(t),codex=path.join(home,'codex');mkdirSync(codex);
  writeFileSync(path.join(home,'setup-state.json'),JSON.stringify({codexInstalled:true,hostHomes:{codex}}));
  writeFileSync(path.join(codex,'config.toml'),'token="不能输出的凭据"\n');
  const codexRegistration=inspectCodexRegistration(home);
  assert.doesNotMatch(JSON.stringify(codexRegistration),/不能输出的凭据/);
  const text=formatGlobalStatus({pairs:[],peers:[],codexRegistration});
  assert.match(text,/nxbridge setup/);assert.match(text,/\/hooks/);
  writeFileSync(path.join(codex,'config.toml'),'token="不能输出的凭据');
  const unreadable=inspectCodexRegistration(home);
  assert.equal(unreadable.state,'unknown');assert.doesNotMatch(JSON.stringify(unreadable),/不能输出的凭据/);
});
