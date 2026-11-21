import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { setupArguments } from '../install/setup-arguments.js';
import {CLI_PATH} from '../shared/package-location.js';
import { temporary } from './support/temporary.js';

test('安装参数完整验证，重复的命令参数保留顺序和以横线开头的值',()=>{
  const parsed=setupArguments(['--dry-run','--codex-command','node','--codex-command-arg','codex.js','--codex-command-arg','--no-daemon','--claude-home','with spaces']);
  assert.deepEqual(parsed.options?.commands?.codex,['node','codex.js','--no-daemon']);assert.equal(parsed.options?.hostHomes?.claude,'with spaces');
  assert.deepEqual(setupArguments(['--codex-command','codex','--codex-command-arg','','--codex-command-arg=--dry-run']).options?.commands?.codex,['codex','','--dry-run']);
  assert.throws(()=>setupArguments(['--codex-command','codex','--codex-command-arg','--dry-run']),/需要一个值/);
  for(const args of [['--what'],['extra'],['--from'],['--from','--dry-run'],['--codex-command-arg'],['--codex-command-arg','a'],['--codex-command','a','--clear-codex-command'],['--from','a','--from','b']])assert.throws(()=>setupArguments(args));
});

test('setup/update 帮助和非法参数不执行安装预检，不创建安装目录',async t=>{
  const directory=temporary(t),home=path.join(directory,'uncreated');
  for(const command of ['setup','update']){
    const result=await promisify(execFile)(process.execPath,[CLI_PATH,command,'--help'],{env:{...process.env,NXBRIDGE_HOME:home},windowsHide:true,timeout:10000});assert.match(result.stdout,/用法/);
    await assert.rejects(promisify(execFile)(process.execPath,[CLI_PATH,command,'--unknown'],{env:{...process.env,NXBRIDGE_HOME:home},windowsHide:true,timeout:10000}),/无法识别安装参数/);
  }
  assert.equal(existsSync(home),false);
});
