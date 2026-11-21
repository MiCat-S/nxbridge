import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { writeFileSync, mkdirSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { temporary } from './support/temporary.js';
import { resolveNodeRuntime, supportedNode, encodedNodeDiscovery } from '../install/node-runtime.js';
import { installShim, planShim } from '../install/installation.js';
import {sameDirectory} from '../shared/files.js';
import {windowsPowerShell,windowsTool} from '../shared/windows-tools.js';
import { wrapperBlock } from '../hosts/shell.js';
import { persistentEnvironment } from '../process/environment.js';

const execute=promisify(execFile);
test('Node 记录失效后从持久基线选择兼容版本，拒绝无兼容版本的环境',t=>{
  const directory=temporary(t),missing=path.join(directory,'missing-node.exe');
  assert.equal(resolveNodeRuntime(process.execPath,{PATH:''}),process.execPath);
  assert.ok(sameDirectory(resolveNodeRuntime(missing,{PATH:path.dirname(process.execPath)}),process.execPath));
  assert.throws(()=>resolveNodeRuntime(missing,{PATH:''}),{code:'node_missing'});
  for(const version of ['v24.14.0','25.0.0','v26.1.0'])assert.equal(supportedNode(version),true);
  for(const version of ['v23.9.0','v27.0.0','nonsense'])assert.equal(supportedNode(version),false);
});

test('稳定入口在旧 Node 被移除后复用当前兼容 Node，完整保留 argv 与退出码',async t=>{
  const directory=temporary(t),entry=path.join(directory,'entry.cjs');writeFileSync(entry,'console.log(JSON.stringify(process.argv.slice(2)));process.exitCode=23;','utf8');
  installShim(planShim(directory,{directories:[],pathValue:'',entry,node:path.join(directory,'old-node.exe')}));
  await assert.rejects(execute(process.execPath,[path.join(directory,'bin','nxbridge.cjs'),'中文 参数','',"a\"b"],{windowsHide:true}),error=>{const value=error as {code?:number;stdout?:string};assert.equal(value.code,23);assert.deepEqual(JSON.parse(value.stdout!),['中文 参数','',"a\"b"]);return true;});
});

test('Windows 持久 PATH 回退不使用受污染的调用方 PATH，包装器与命令仍可启动', {skip:process.platform!=='win32'},async t=>{
  const directory=temporary(t),missing=path.join(directory,'old-node.exe'),entry=path.join(directory,'entry.cjs'),bin=path.join(directory,'bin');mkdirSync(bin);
  try{resolveNodeRuntime(missing,persistentEnvironment());}
  catch(error){if((error as {code?:string}).code==='node_missing'){t.skip('运行环境的持久 PATH 没有 Node.js 24～26，无法执行持久安装回退验收');return;}throw error;}
  writeFileSync(entry,"console.log(JSON.stringify(process.argv.slice(2)));",'utf8');
  const env={...process.env,PATH:directory};
  const discovered=(await execute(windowsPowerShell(),['-NoLogo','-NoProfile','-NonInteractive','-EncodedCommand',encodedNodeDiscovery()],{env,windowsHide:true})).stdout.trim();
  assert.equal(path.basename(discovered).toLowerCase(),'node.exe');assert.notEqual(path.dirname(discovered),directory);
  const block=wrapperBlock('powershell',missing,entry),script=`[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false);${block}\ncodex '中文 参数' '';exit $LASTEXITCODE`;
  const result=await execute(windowsPowerShell(),['-NoLogo','-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')],{env,windowsHide:true});
  const [mode,encoded]=JSON.parse(result.stdout.trim());assert.equal(mode,'shell-codex');assert.deepEqual(JSON.parse(Buffer.from(encoded,'base64').toString()),['中文 参数','']);
  installShim(planShim(directory,{directories:[bin],pathValue:bin,entry,node:missing}));
  const command=path.join(bin,'nxbridge.cmd');
  const shim=await execute(windowsTool('cmd.exe'),['/d','/s','/c',`""${command}" "two words" tail"`],{env,windowsHide:true,windowsVerbatimArguments:true});assert.deepEqual(JSON.parse(shim.stdout.trim()),['two words','tail']);
});
