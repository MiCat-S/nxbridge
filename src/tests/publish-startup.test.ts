import test from 'node:test';
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {cpSync,existsSync,readdirSync,writeFileSync} from 'node:fs';
import path from 'node:path';
import {PACKAGE_ROOT} from '../shared/package-location.js';
import {temporary} from './support/temporary.js';

test('复制后的发布 CLI 延迟加载命令，帮助与版本独立于通信及原生助手模块',async t=>{
  const root=temporary(t),runtime=path.join(root,'runtime'),home=path.join(root,'uncreated');cpSync(path.join(PACKAGE_ROOT,'publish'),runtime,{recursive:true});
  const invoke=(args:string[])=>promisify(execFile)(process.execPath,[path.join(runtime,'nxbridge.mjs'),...args],{cwd:root,env:{...process.env,NXBRIDGE_HOME:home},windowsHide:true,timeout:10000});
  assert.match((await invoke(['setup','--help'])).stdout,/用法/);
  await assert.rejects(invoke(['setup','--unknown']),error=>{
    const result=error as Error&{code:number;stderr:string},detail=JSON.parse(result.stderr);assert.equal(result.code,1);assert.equal(detail.code,'invalid_arguments');assert.match(detail.message,/无法识别安装参数/);return true;
  });
                             
  for(const file of readdirSync(runtime).filter(name=>/^(?:vendor-|runtime-).+\.mjs$/.test(name)))writeFileSync(path.join(runtime,file),"throw Error('基础查询意外加载延迟模块');",'utf8');
  assert.match((await invoke(['--help'])).stdout,/nxbridge/);
  assert.match((await invoke(['--version'])).stdout,/^nxbridge \d+\.\d+\.\d+\n$/);
  assert.equal(existsSync(home),false);
});
