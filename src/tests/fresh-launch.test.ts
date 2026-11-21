import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdirSync,writeFileSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { temporary } from './support/temporary.js';
import { listenBroker } from '../ipc/ipc.js';
import {CLI_PATH} from '../shared/package-location.js';
import {ensureHome} from '../ipc/home.js';
import { VERSION } from '../version.js';
import {BridgeError} from '../shared/errors.js';
import { runtimeDirectory, saveManagedRuntime } from '../hosts/managed-runtimes.js';
import { managedMarker } from '../install/installation.js';
import { processIdentity } from '../process/process.js';
import { randomUUID } from 'node:crypto';

test('新会话、恢复与分叉完整透传官方入口，选择器不探测或创建远程后台',async t=>{
  const directory=temporary(t),home=path.join(directory,'bridge'),other=path.join(directory,'other'),native=path.join(directory,'native.mjs');await ensureHome(home);mkdirSync(other);
  writeFileSync(native,"console.log(JSON.stringify({fresh:true,args:process.argv.slice(2)}));",'utf8');
  writeFileSync(path.join(home,'config.json'),JSON.stringify({codexCommand:[process.execPath,native]}),'utf8');
  const requested:string[]=[],server=await listenBroker(home,async method=>{requested.push(method);if(method==='ping')return{version:VERSION,pid:process.pid};throw new BridgeError('runtime_launch_unconfirmed','原运行时仍存活但身份不兼容，不能复用');});t.after(server.close);
  const entry=process.env.NXBRIDGE_TEST_LAUNCH_ENTRY??CLI_PATH;
  const scenarios=[[],['--yolo'],['-m','test-model'],['--no-daemon'],['修复问题'],['-C',other],['--model','resume'],['--','resume'],['resume'],['resume','--last'],['resume','00000001-0000-7000-8000-000000000001','--yolo'],['resume','-s','read-only','-a','on-request'],['fork','--last'],['resume','--full-auto'],['--profile','work','resume'],['resume','--cd',other]];
                                             
  for(let offset=0;offset<scenarios.length;offset+=4)await Promise.all(scenarios.slice(offset,offset+4).map(async args=>{
    const {stdout}=await promisify(execFile)(process.execPath,[entry,'shell-codex',Buffer.from(JSON.stringify(args)).toString('base64')],{cwd:directory,env:{...process.env,NXBRIDGE_HOME:home},windowsHide:true,timeout:10000});
    assert.deepEqual(JSON.parse(stdout),{fresh:true,args});
  }));
  assert.deepEqual(requested,[],'新会话不探测旧服务器，不恢复旧线程，也不触发身份迁移');
  mkdirSync(runtimeDirectory(home),{recursive:true});writeFileSync(path.join(runtimeDirectory(home),randomUUID()+'.json'),'{');
  const args=['resume','00000001-0000-7000-8000-000000000001'],{stdout}=await promisify(execFile)(process.execPath,[entry,'shell-codex',Buffer.from(JSON.stringify(args)).toString('base64')],{cwd:directory,env:{...process.env,NXBRIDGE_HOME:home},windowsHide:true,timeout:10000});
  assert.deepEqual(JSON.parse(stdout),{fresh:true,args});assert.deepEqual(requested,[],'记录损坏时仍直接交回官方恢复');
});

test('后台收尾拒绝不能被吞成原生恢复，归属读取失败才回到官方入口',async t=>{
  const directory=temporary(t),home=path.join(directory,'bridge'),native=path.join(directory,'native.mjs');await ensureHome(home);
  writeFileSync(native,"console.log(JSON.stringify({args:process.argv.slice(2)}));",'utf8');writeFileSync(path.join(home,'config.json'),JSON.stringify({codexCommand:[process.execPath,native]}),'utf8');
  const identity=await processIdentity(process.pid);saveManagedRuntime(home,{id:randomUUID(),owner:managedMarker(home),kind:'owned',state:'ready',endpoint:'unix://retiring',createdAt:Date.now(),configHome:home,pid:identity.pid,procStart:identity.startedAt});
  let unavailable=true;const server=await listenBroker(home,async method=>{if(method==='ping')return{version:VERSION,pid:process.pid};if(method==='hosting.resolve'){if(unavailable)return{unavailable:'会话正在后台收尾，请稍后重试或用 nxbridge status 查看。'};throw new BridgeError('runtime_record_invalid','隔离的读取失败');}throw Error('未预期调用 '+method);});t.after(server.close);
  const entry=process.env.NXBRIDGE_TEST_LAUNCH_ENTRY??CLI_PATH,args=['resume','00000001-0000-7000-8000-000000000001'],run=()=>promisify(execFile)(process.execPath,[entry,'shell-codex',Buffer.from(JSON.stringify(args)).toString('base64')],{cwd:directory,env:{...process.env,NXBRIDGE_HOME:home,CODEX_HOME:home},windowsHide:true,timeout:10000});
  await assert.rejects(run(),error=>/后台收尾.*nxbridge status/.test((error as {stderr:string}).stderr));unavailable=false;
  assert.deepEqual(JSON.parse((await run()).stdout),{args});
});
