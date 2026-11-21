import test from 'node:test';
import { VERSION } from '../version.js';
import assert from 'node:assert/strict';
import path from 'node:path';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { temporary, temporaryAlias } from './support/temporary.js';
import { activeRuntime, fileHashes, inspectRuntime, pointerDetails, pruneRuntimes, stageRuntime } from '../install/runtime-install.js';
import { installShim, planShim } from '../install/installation.js';
import {atomicJson,readJson} from '../shared/files.js';
import {CLI_PATH,PACKAGE_ROOT} from '../shared/package-location.js';
import {delay} from '../shared/time.js';
import { brokerCall } from '../ipc/ipc.js';
import { liveProcess } from '../process/process.js';
import { windowsHelperStatus } from '../process/windows/windows-hook-identity.js';

const execute=promisify(execFile);
function manifestFor(source:string){
  const manifest=readJson<any>(path.join(source,'publish.json'));manifest.files=fileHashes(source,['publish.json']);
  manifest.buildId=manifest.version+'-'+createHash('sha256').update(JSON.stringify({files:manifest.files,dependencies:manifest.dependencies})).digest('hex').slice(0,12);atomicJson(path.join(source,'publish.json'),manifest);return manifest;
}
function revision(directory:string,name:string){
  const source=path.join(directory,name);cpSync(path.join(PACKAGE_ROOT,'publish'),source,{recursive:true});
  writeFileSync(path.join(source,'nxbridge-collaboration.md'),readFileSync(path.join(source,'nxbridge-collaboration.md'),'utf8')+'\n'+name+'\n','utf8');
  manifestFor(source);return source;
}

test('私有运行时不依赖源目录、npm 或 node_modules；校验漂移后拒绝覆盖',async t=>{
  const directory=temporary(t),home=path.join(directory,'中文 私有目录'),source=revision(directory,'source'),candidate=await stageRuntime(home,source);
  if(process.platform==='win32'){
    const helper=windowsHelperStatus(home);assert.equal(helper.prepared,true,'候选运行时切换前必须准备自身修订的原生助手');
    unlinkSync(helper.binary);assert.equal((await stageRuntime(home,source)).reused,true);assert.equal(windowsHelperStatus(home).prepared,true,'重用运行时也要恢复丢失的助手');
  }
  const bin=path.join(directory,'bin');mkdirSync(bin);installShim(planShim(home,{directories:[bin],pathValue:bin,entry:candidate.entry,runtime:pointerDetails(home,candidate)}));
  renameSync(source,path.join(directory,'moved-source'));
  const result=await execute(process.execPath,['--no-warnings',path.join(home,'bin','nxbridge.cjs'),'--version'],{cwd:directory,env:{...process.env,PATH:''},windowsHide:true});assert.equal(result.stdout.trim(),'nxbridge '+VERSION);
  assert.equal(existsSync(path.join(candidate.directory,'node_modules')),false);assert.deepEqual(inspectRuntime(home).drift,[]);
  writeFileSync(candidate.entry,'已被用户改变','utf8');assert.ok((inspectRuntime(home).drift as string[]).length>0);
  await assert.rejects(stageRuntime(home,path.join(directory,'moved-source')),{code:'runtime_drift'});
});

test('暂存目录的漂移和加载失败均不切换当前指针，也不留下半成品版本',async t=>{
  const directory=temporary(t),home=path.join(directory,'bridge'),good=await stageRuntime(home,revision(directory,'good'));
  installShim(planShim(home,{entry:good.entry,pathValue:'',runtime:pointerDetails(home,good)}));
  const before=readFileSync(path.join(home,'bin','runtime.json'),'utf8');
  for(const mode of ['drift','load'] as const){
    const source=revision(directory,mode);writeFileSync(path.join(source,'nxbridge.mjs'),"throw new Error('隔离的加载失败');",'utf8');
    if(mode==='load')manifestFor(source);
    await assert.rejects(stageRuntime(home,source),mode==='drift'?{code:'runtime_drift'}:/隔离的加载失败/);
    assert.equal(readFileSync(path.join(home,'bin','runtime.json'),'utf8'),before);assert.deepEqual(readdirSync(path.join(home,'runtime')),[good.buildId]);
  }
});

test('只按来源清单复制时仍拒绝目录外的构建编号和文件路径',async t=>{
  const directory=temporary(t),home=path.join(directory,'bridge');
  for(const field of ['buildId','files'] as const){
    const source=revision(directory,field),manifest=readJson<any>(path.join(source,'publish.json'));
    if(field==='buildId')manifest.buildId='../outside';else manifest.files['../outside.txt']='0'.repeat(64);
    atomicJson(path.join(source,'publish.json'),manifest);
    await assert.rejects(stageRuntime(home,source),{code:'publish_invalid'});
    assert.equal(existsSync(path.join(home,'outside')),false);assert.equal(existsSync(path.join(home,'runtime','outside.txt')),false);
  }
});

test('保留当前与上一版；更老版本按活 broker 的 PID 和进程代次保护，退出后清理',async t=>{
  const directory=temporaryAlias(t),home=path.join(directory,'bridge'),bin=path.join(directory,'bin');mkdirSync(bin);
  let pid:number|undefined;
  const stop=async()=>{if(pid&&liveProcess(pid)){await brokerCall('shutdown',{releaseOwned:false},{home,start:false});const end=Date.now()+7000;while(liveProcess(pid)){assert.ok(Date.now()<end,'隔离 broker 未退出');await delay(30);}}};
  t.after(stop);
  const candidates=[];
  for(const name of ['a','b','c']){
    const candidate=await stageRuntime(home,revision(directory,name));candidates.push(candidate);
    installShim(planShim(home,{directories:[bin],pathValue:bin,entry:candidate.entry,runtime:pointerDetails(home,candidate)}));
    if(name==='a'){
                                               
      const child=spawn(process.execPath,['--no-warnings',CLI_PATH,'service'],{env:{...process.env,NXBRIDGE_HOME:home},windowsHide:true,stdio:['ignore','pipe','pipe']});pid=child.pid;
      let logs='';child.stdout.on('data',value=>logs=(logs+value).slice(-3000));child.stderr.on('data',value=>logs=(logs+value).slice(-3000));
      let identity:any;const end=Date.now()+10000;
      while(!identity){try{identity=await brokerCall('ping',{}, {home,start:false,timeout:300});}catch{assert.ok(child.exitCode===null&&Date.now()<end,'隔离 broker 未启动：'+logs);await delay(50);}}
      assert.equal(identity.pid,pid);assert.equal(identity.runtime.buildId,candidate.buildId);
    }
  }
  assert.equal(activeRuntime(home)?.previous?.buildId,candidates[1]!.buildId);
  const oldest=candidates[0]!,movedEntry=oldest.entry+'.moved';
  const held=await pruneRuntimes(home);assert.ok(held.protected.includes(oldest.directory));assert.equal(readdirSync(path.join(home,'runtime')).length,3);
  renameSync(oldest.entry,movedEntry);
  try{
    const heldWithoutEntry=await pruneRuntimes(home);
    assert.ok(heldWithoutEntry.protected.includes(oldest.directory),'活 broker 的入口被移走时仍应保护该版本');
  }finally{if(existsSync(movedEntry))renameSync(movedEntry,oldest.entry);}
  await stop();const cleaned=await pruneRuntimes(home);assert.deepEqual(cleaned.removed,[oldest.directory]);assert.equal(readdirSync(path.join(home,'runtime')).length,2);
});
