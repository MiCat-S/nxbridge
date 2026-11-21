import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { bootstrapBackground } from '../hosts/background-bootstrap.js';
import { recordBackgroundState } from '../hosts/background-state.js';
import { listenBroker } from '../ipc/ipc.js';
import {ensureHome} from '../ipc/home.js';
import {BridgeError} from '../shared/errors.js';
import { temporary } from './support/temporary.js';

test('Windows bootstrap 预检拒绝时不停止现有协调器、不预约、不改变持久诊断',{skip:process.platform!=='win32'},async t=>{
  const home=temporary(t);await ensureHome(home);recordBackgroundState(home,'先前环境的失败诊断');
  const state=path.join(home,'run','background-state.json'),before=readFileSync(state),methods:string[]=[];
  const server=await listenBroker(home,async method=>{methods.push(method);assert.equal(method,'ping');return{pid:process.pid,runtime:{windowsIndependent:false}};});t.after(()=>server.close());
  let probes=0;
  await assert.rejects(bootstrapBackground(home,{preflight:async()=>{probes++;throw new BridgeError('bootstrap_context_unavailable','请在普通 PowerShell 运行 nxbridge bootstrap');}}),{code:'bootstrap_context_unavailable'});
  assert.equal(probes,1);assert.deepEqual(methods,['ping']);assert.deepEqual(readFileSync(state),before);
  assert.equal(existsSync(path.join(home,'run','broker-startup.db')),false);
});

test('已独立运行的协调器直接复用，不执行启动能力探针',async t=>{
  const home=temporary(t);await ensureHome(home);let probes=0;
  const server=await listenBroker(home,async method=>{assert.equal(method,'ping');return{pid:process.pid,runtime:{windowsIndependent:true}};});t.after(()=>server.close());
  assert.match((await bootstrapBackground(home,{preflight:async()=>{probes++;}})).text,/无需重复操作/);assert.equal(probes,0);
  assert.equal(existsSync(path.join(home,'run','broker-startup.db')),false);
});
