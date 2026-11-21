import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { VERSION } from '../version.js';
import {PACKAGE_ROOT} from '../shared/package-location.js';
import {readJson} from '../shared/files.js';
import { fixture } from './support/broker-fixture.js';
import { temporary } from './support/temporary.js';
import { preparePlugins } from '../install/setup.js';

test('仅修改 package.json 后构建会同步全部版本元数据，检查模式拒绝漂移且不写文件',async t=>{
  const {synchronizeVersions}=await import(pathToFileURL(path.join(PACKAGE_ROOT,'tools/sync-version.mjs')).href),root=temporary(t);
  const save=(relative:string,value:unknown)=>{const file=path.join(root,relative);mkdirSync(path.dirname(file),{recursive:true});writeFileSync(file,JSON.stringify(value,null,2)+'\r\n','utf8');return file;};
  const pkg=save('package.json',{name:'nxbridge',version:'8.7.6'}),lock=save('package-lock.json',{version:'8.7.5',packages:{'':{name:'nxbridge',version:'8.7.5'},'node_modules/example':{version:'3.2.1'}}});
  const manifests=['plugins/claude/.claude-plugin/plugin.json','plugins/codex/.codex-plugin/plugin.json'];
  for(const file of manifests)save(file,{name:'nxbridge',version:'8.7.5',description:'保留其他元数据'});
  const before=readFileSync(lock,'utf8');assert.throws(()=>synchronizeVersions(root,{check:true}),/版本元数据.*不一致/);assert.equal(readFileSync(lock,'utf8'),before);
  assert.equal(synchronizeVersions(root).version,'8.7.6');assert.deepEqual(synchronizeVersions(root,{check:true}).changed,[]);
  save('package.json',{name:'nxbridge',version:'8.7.7'});synchronizeVersions(root);
  assert.equal(readJson<any>(pkg).version,'8.7.7');
  assert.deepEqual(readJson<any>(lock),{version:'8.7.7',packages:{'':{name:'nxbridge',version:'8.7.7'},'node_modules/example':{version:'3.2.1'}}});
  for(const file of manifests)assert.deepEqual(readJson(path.join(root,file)),{name:'nxbridge',version:'8.7.7',description:'保留其他元数据'});
  assert.ok(readFileSync(lock,'utf8').endsWith('\r\n'));
});

test('运行时、协调器及两端发布元数据采用同一个版本',async t=>{
  const f=fixture(t);assert.equal((await f.broker.dispatch('ping',{}) as {version:string}).version,VERSION);
  for(const file of ['package.json','package-lock.json','plugins/claude/.claude-plugin/plugin.json','plugins/codex/.codex-plugin/plugin.json','publish/publish.json','publish/plugins/claude/.claude-plugin/plugin.json','publish/plugins/codex/.codex-plugin/plugin.json'])assert.equal(readJson<any>(path.join(PACKAGE_ROOT,file)).version,VERSION,file);
});

test('安装器从目标交付清单读取版本，不把自身版本写入新版市场',async t=>{
  const root=temporary(t),payload=path.join(root,'payload'),home=path.join(root,'bridge'),version='9.8.7';
  for(const host of ['claude','codex']){
    const plugin=path.join(payload,'plugins',host),metadata=path.join(plugin,host==='claude'?'.claude-plugin':'.codex-plugin');mkdirSync(metadata,{recursive:true});
    writeFileSync(path.join(metadata,'plugin.json'),JSON.stringify({name:'nxbridge',version}),'utf8');
    writeFileSync(path.join(plugin,'.mcp.json'),JSON.stringify({mcpServers:{[host==='claude'?'codex':'claude']:{command:'node',args:['bridge.cjs']}}}),'utf8');
  }
  writeFileSync(path.join(payload,'nxbridge-collaboration.md'),'搭档规则','utf8');
  const marketplace=await preparePlugins(home,{packageRoot:payload});
  assert.equal(readJson<any>(path.join(marketplace,'.claude-plugin','marketplace.json')).plugins[0].version,version);
});
