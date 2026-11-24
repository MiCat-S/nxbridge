import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { atomicJson, readJson } from '../shared/files.js';
import { CLI_PATH, PACKAGE_ROOT } from '../shared/package-location.js';
import { fileHashes, pointerDetails, stageRuntime } from '../install/runtime-install.js';
import { installShim, planShim } from '../install/installation.js';
import { temporary } from './support/temporary.js';

const execute=promisify(execFile);
function sourceAt(directory:string,name:string,script?:string){
  const source=path.join(directory,name);cpSync(path.join(PACKAGE_ROOT,'publish'),source,{recursive:true});
  if(script)writeFileSync(path.join(source,'runtime-dispatch.mjs'),script);
  const manifest=readJson<any>(path.join(source,'publish.json'));manifest.files=fileHashes(source,['publish.json']);
  manifest.buildId=manifest.version+'-'+createHash('sha256').update(JSON.stringify({files:manifest.files,dependencies:manifest.dependencies})).digest('hex').slice(0,12);
  atomicJson(path.join(source,'publish.json'),manifest);return source;
}
const reporter=`export async function dispatchCommand(command,args){process.stdout.write(JSON.stringify({selected:'new installer',command,args})+'\\n');process.stderr.write('new installer stderr\\n');process.exitCode=23;}`;
const run=(entry:string,home:string,args:string[])=>execute(process.execPath,[entry,...args],{env:{...process.env,NXBRIDGE_HOME:home},windowsHide:true,timeout:15000});

test('setup --from 在第一次调用中执行目标安装器，原样传递参数、输出和退出码',async t=>{
  const directory=temporary(t),home=path.join(directory,'home'),source=sourceAt(directory,'new source',reporter);
  const args=['--from',source,'--dry-run','--codex-command','with spaces','--codex-command-arg=--flag'];
  await assert.rejects(run(CLI_PATH,home,['setup',...args]),(error:any)=>{
    assert.equal(error.code,23);assert.deepEqual(JSON.parse(error.stdout),{selected:'new installer',command:'setup',args});assert.equal(error.stderr,'new installer stderr\n');return true;
  });
  assert.equal(existsSync(home),false);
});

test('已安装入口的 update 第一次调用即使用来源的新逻辑',async t=>{
  const directory=temporary(t),home=path.join(directory,'home'),source=sourceAt(directory,'source');
  const candidate=await stageRuntime(home,source);installShim(planShim(home,{entry:candidate.entry,pathValue:'',runtime:pointerDetails(home,candidate)}));
  sourceAt(directory,'source',reporter);
  await assert.rejects(run(path.join(home,'bin','nxbridge.cjs'),home,['update']), (error:any)=>{
    assert.equal(error.code,23);assert.equal(JSON.parse(error.stdout).selected,'new installer');return true;
  });
  assert.equal(readJson<any>(path.join(home,'bin','runtime.json')).buildId,candidate.buildId);
});

test('恢复安装优先运行 pendingSetup 的版本，不跳到新的 --from 来源',async t=>{
  const directory=temporary(t),home=path.join(directory,'home'),pending=sourceAt(directory,'pending',reporter);
  mkdirSync(home);atomicJson(path.join(home,'setup-state.json'),{pendingSetup:{runtimeDirectory:pending}});
  await assert.rejects(run(CLI_PATH,home,['update','--from',path.join(directory,'missing')]),(error:any)=>{
    assert.equal(error.code,23);assert.equal(JSON.parse(error.stdout).selected,'new installer');return true;
  });
});

test('真实目标版本不重复转交，dry-run 不建立私有目录；来源消失时仍进入修复预检',async t=>{
  const directory=temporary(t),home=path.join(directory,'home'),source=sourceAt(directory,'source');
  const args=['update','--dry-run','--codex-command',path.join(directory,'missing-codex'),'--claude-command',process.execPath];
  await assert.rejects(run(CLI_PATH,home,[...args,'--from',source]),/setup 需要运行 codex/);
  assert.equal(existsSync(home),false);
  const candidate=await stageRuntime(home,source);candidate.source=path.join(directory,'gone');
  installShim(planShim(home,{entry:candidate.entry,pathValue:'',runtime:pointerDetails(home,candidate)}));
  await assert.rejects(run(candidate.entry,home,args),/setup 需要运行 codex/);
});

test('目标发布文件漂移时不执行目标代码',async t=>{
  const directory=temporary(t),home=path.join(directory,'home'),source=sourceAt(directory,'source',reporter);
  writeFileSync(path.join(source,'runtime-dispatch.mjs'),readFileSync(path.join(source,'runtime-dispatch.mjs'),'utf8')+'\n// drift');
  await assert.rejects(run(CLI_PATH,home,['update','--from',source]),/发布目录与构建清单不一致/);
  assert.equal(existsSync(home),false);
});
