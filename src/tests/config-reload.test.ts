import test from 'node:test';
import assert from 'node:assert/strict';
import {writeFileSync,unlinkSync} from 'node:fs';
import path from 'node:path';
import {ConfigurationReload} from '../config/config-reload.js';
import {loadBridgeConfig} from '../config/configuration.js';
import { temporary } from './support/temporary.js';

test('手写配置新增、半写、修正和删除可热读取；解析失败保留最后有效配置且不重复报错',t=>{
  const home=temporary(t),file=path.join(home,'config.toml');let now=0,config=loadBridgeConfig(home),applies=0;
  const reload=new ConfigurationReload(home,()=>now),poll=()=>{now+=1001;return reload.poll(()=>{const latest=loadBridgeConfig(home);config=latest;applies++;});};
  assert.equal(poll(),'unchanged');writeFileSync(file,'[hosts.codex]\nbinary="/first"\n','utf8');assert.equal(poll(),'applied');assert.equal(config.codexBinary,'/first');
  writeFileSync(file,'[hosts.codex]\nbinary="','utf8');assert.equal(poll(),'failed');assert.equal(config.codexBinary,'/first');assert.ok(reload.status.error);assert.equal(poll(),'unchanged');assert.equal(applies,1);
  writeFileSync(file,'[hosts.codex]\nbinary="/second-newer"\n','utf8');assert.equal(poll(),'applied');assert.equal(config.codexBinary,'/second-newer');assert.equal(reload.status.error,undefined);
  unlinkSync(file);assert.equal(poll(),'applied');assert.equal(config.codexBinary,undefined);assert.equal(applies,3);
});
