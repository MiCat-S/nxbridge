import { copyNodeBinary } from './support/node-binary.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { once } from 'node:events';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { FakeAdapter } from './support/fake-adapter.js';
import { registration } from './support/registration.js';
import { temporaryDirectory } from './support/temporary.js';
import {ensureHome} from '../ipc/home.js';
import {PACKAGE_ROOT} from '../shared/package-location.js';
import { listenBroker } from '../ipc/ipc.js';
import { Store } from '../storage/store.js';
import { Broker } from '../broker/coordinator.js';
import {BridgeError} from '../shared/errors.js';
import {DEFAULT_CONFIG} from '../config/defaults.js';

test('Windows hook 冷启动分段计时，空取件不额外探测宿主进程',{skip:process.platform!=='win32',timeout:60000},async t=>{
  const temp=temporaryDirectory(),root=temp.directory,home=path.join(root,'bridge'),binary=path.join(root,'codex.exe');await ensureHome(home);copyNodeBinary(binary);
  const store=new Store(':memory:'),codex=new FakeAdapter(),claude=new FakeAdapter(),broker=new Broker(store,{...DEFAULT_CONFIG,implicit:'never'},{codex,claude} as any,home),f={store,broker,codex,claude};
  const partner=store.register(registration('claude','deadline-partner',{cwd:root}));
  let probes=0;for(const adapter of [f.codex,f.claude])adapter.probe=async()=>{probes++;return{state:'reachable',reasons:[],checked_at:Date.now()};};
  let failStatus=false;const server=await listenBroker(home,async(method,params)=>{if(failStatus&&method==='status')throw new BridgeError('fixture_status','隔离状态查询失败');return f.broker.dispatch(method,params);});
  const script=`const {spawn}=require('node:child_process');process.on('message',p=>{const start=performance.now(),c=spawn(${JSON.stringify(process.execPath)},p.args,{cwd:${JSON.stringify(root)},env:process.env,windowsHide:true,stdio:['pipe','pipe','pipe']});let out='',err='';c.stdout.on('data',d=>out+=d);c.stderr.on('data',d=>err+=d);c.on('exit',code=>process.send({code,out,err,wallMs:performance.now()-start}));c.stdin.end(p.input||'');});process.send('ready');`;
  const child=spawn(binary,['-e',script],{env:{...process.env,NXBRIDGE_HOME:home,CODEX_HOME:path.join(root,'codex'),NXBRIDGE_HOOK_STARTED_AT:'1'},windowsHide:true,stdio:['ignore','ignore','ignore','ipc']}),exit=once(child,'exit');
  t.after(async()=>{if(child.exitCode===null&&child.signalCode===null)child.kill();await exit;await server.close();await broker.stop();store.close();await temp.cleanup();});await once(child,'message');
  const invoke=async(args:string[],input='')=>{const done=once(child,'message');child.send({args,input});const value=(await done)[0];assert.equal(value.code,0,value.err);return value;};
  const module=pathToFileURL(path.join(PACKAGE_ROOT,'dist/process/process.js')).href;
  const identity=await invoke(['--input-type=module','-e',`const began=performance.now();const {codexProcessIdentity}=await import(${JSON.stringify(module)});const imported=performance.now();const id=await codexProcessIdentity();console.log(JSON.stringify({importMs:imported-began,identityMs:performance.now()-imported,pid:id.pid}));`]);
  const results=[];for(const event of ['SessionStart','PostToolUse']){
    const value=await invoke(['--no-warnings',path.join(PACKAGE_ROOT,'publish/nxbridge.mjs'),'hook','--host','codex'],JSON.stringify({hook_event_name:event,session_id:'deadline-root',cwd:root,source:'startup',transcript_path:path.join(root,'deadline-root.jsonl'),tool_name:'exec_command'}));
    results.push({event,wallMs:value.wallMs,timing:f.store.setting<any>('lastHook')?.timing});
    if(event==='SessionStart'){const x=f.store.find('codex','deadline-root')!;f.store.pair(partner.id,x.id);}
  }
  assert.equal(probes,0,'健康的空取件不应再启动昂贵的进程代次探测');
  failStatus=true;const failedControl=await invoke(['--no-warnings',path.join(PACKAGE_ROOT,'publish/nxbridge.mjs'),'hook','--host','codex'],JSON.stringify({hook_event_name:'UserPromptSubmit',session_id:'deadline-root',cwd:root,transcript_path:path.join(root,'deadline-root.jsonl'),prompt:'nxbridge status'}));
  assert.equal(JSON.parse(failedControl.out).decision,'block');assert.match(JSON.parse(failedControl.out).reason,/隔离状态查询失败/);
  t.diagnostic(JSON.stringify({identity:{wallMs:identity.wallMs,...JSON.parse(identity.out)},hooks:results,extraRuntimeProbes:probes}));
});

test('协调器不在线时，原生中断和退出在三秒内返回且不启动服务',{timeout:15000},async t=>{
  const temp=temporaryDirectory(),root=temp.directory,home=path.join(root,'bridge'),binary=path.join(root,process.platform==='win32'?'codex.exe':'codex');await ensureHome(home);copyNodeBinary(binary);
  const entry=path.join(PACKAGE_ROOT,'publish/hook-entry.mjs'),script=`const{spawn}=require('node:child_process');process.on('message',event=>{const began=performance.now(),child=spawn(${JSON.stringify(process.execPath)},[${JSON.stringify(entry)},'hook','--host','codex'],{env:process.env,windowsHide:true,stdio:['pipe','pipe','pipe']});let out='',err='';child.stdout.on('data',data=>out+=data);child.stderr.on('data',data=>err+=data);child.on('close',code=>process.send({code,out,err,wallMs:performance.now()-began}));child.stdin.end(JSON.stringify({hook_event_name:event,session_id:'offline-short'}));});process.send('ready');`;
  const parent=spawn(binary,['-e',script],{env:{...process.env,NXBRIDGE_HOME:home,CODEX_HOME:path.join(root,'codex')},windowsHide:true,stdio:['ignore','ignore','ignore','ipc']}),ended=once(parent,'exit');
  t.after(async()=>{if(parent.exitCode===null&&parent.signalCode===null)parent.kill();await ended;await temp.cleanup();});await once(parent,'message');
  for(const event of ['Interrupt','SessionEnd']){
    const ready=once(parent,'message');parent.send(event);const value=(await ready)[0];assert.equal(value.code,0,value.err);assert.deepEqual(JSON.parse(value.out),{});assert.ok(value.wallMs<3000,JSON.stringify(value));
  }
  assert.equal(existsSync(path.join(home,'run','broker.log')),false);assert.equal(existsSync(path.join(home,'run','launch-broker.json')),false);
});
