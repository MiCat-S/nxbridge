import { copyNodeBinary } from '../tests/support/node-binary.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdirSync, writeFileSync, existsSync, readFileSync, readdirSync, linkSync } from 'node:fs';
import { temporaryDirectory } from '../tests/support/temporary.js';
import { CodexAdapter } from '../hosts/codex/adapter.js';
import {DEFAULT_CONFIG} from '../config/defaults.js';
import {delay} from '../shared/time.js';
import {readJson,sameDirectory} from '../shared/files.js';
import {resolveCli} from '../process/host-command.js';
import { liveProcess, processIdentity } from '../process/process.js';
import { ownedProcesses, processRegistryDirectory, releaseRecordedProcesses } from '../process/owned-processes.js';
import { runtimeFor, saveManagedRuntime } from '../hosts/managed-runtimes.js';
import {atomicJson} from '../shared/files.js';

for(const alias of [false,true])test('自定义包装器启动官方 App Server：'+(alias?'程序别名与同名旁支助手':'原生子进程与实际配置目录')+'，保持调用方代理隔离',{skip:process.platform!=='win32'},async t=>{
  const temporary=temporaryDirectory(),directory=temporary.directory,home=path.join(directory,'bridge'),codexhome=path.join(directory,'codex'),script=path.join(directory,'wrapper.mjs');mkdirSync(codexhome);
  let prepared=false;t.after(async()=>{if(!prepared)await temporary.cleanup();});
  const official=resolveCli('codex',process.env.NXBRIDGE_TEST_CODEX_BINARY);
  if(alias){const binary=path.join(directory,'custom-runtime.exe');linkSync(official.command,binary);official.command=binary;copyNodeBinary(path.join(directory,'codex.exe'));}
  writeFileSync(path.join(codexhome,'config.toml'),'web_search="disabled"\n[features]\napps=false\nremote_plugin=false\n','utf8');
  writeFileSync(script,"import {spawn} from 'node:child_process';"+(alias?"const helper=spawn("+JSON.stringify(path.join(directory,'codex.exe'))+",['-e','setInterval(()=>{},1000)'],{stdio:'ignore',windowsHide:true});":"")+"const child=spawn("+JSON.stringify(official.command)+","+JSON.stringify(official.prefix)+".concat(process.argv.slice(2)),{stdio:'inherit',env:{...process.env,CODEX_HOME:"+JSON.stringify(codexhome)+"}});child.on('exit',code=>{"+(alias?'helper.kill();':'')+"process.exitCode=code??1;});",'utf8');
  const config={...DEFAULT_CONFIG,codexCommand:[process.execPath,script],codexHome:codexhome},adapter=new CodexAdapter(config,home),adapters=[adapter],proxy=process.env.HTTPS_PROXY;
  process.env.HTTPS_PROXY='http://127.0.0.1:1';
  t.after(async()=>{
    if(existsSync(path.join(home,'run')))for(const file of readdirSync(path.join(home,'run')).filter(f=>f.endsWith('.log')))t.diagnostic(file+': '+readFileSync(path.join(home,'run',file),'utf8').slice(-4000));
    for(const current of adapters)current.close();if(proxy===undefined)delete process.env.HTTPS_PROXY;else process.env.HTTPS_PROXY=proxy;
    assert.deepEqual(await releaseRecordedProcesses(home,value=>value.role==='codex-runtime'),[]);
    await temporary.cleanup();
  });
  prepared=true;
  const endpoint=await adapter.ensureEndpoint(),runtime=runtimeFor(home,{endpoint})!.value;
  assert.ok(runtime.pid&&runtime.wrapperPid&&runtime.configHome);
  assert.equal(runtime.endpoint,endpoint);assert.notEqual(runtime.pid,runtime.wrapperPid);assert.equal((await processIdentity(runtime.pid)).name.toLowerCase(),alias?'custom-runtime.exe':'codex.exe');assert.equal(sameDirectory(runtime.configHome,codexhome),true);
  const container=ownedProcesses(home).records.find(record=>record.proof.launchId===runtime.id&&record.windowsJob)!;
  assert.deepEqual(container.native,{pid:runtime.pid,startedAt:runtime.procStart});
  adapter.close();
  if(alias){delete container.native;atomicJson(path.join(processRegistryDirectory(home),container.id+'.json'),container);delete runtime.pid;delete runtime.procStart;}
  saveManagedRuntime(home,{...runtime,state:'failed',error:'模拟协调器在原生交接确认前退出'});
  const adopted=new CodexAdapter(config,home);adapters.push(adopted);
  assert.equal(await adopted.ensureEndpoint(),endpoint);const restored=runtimeFor(home,{endpoint})!.value;
  assert.equal(restored.state,'ready');assert.ok(restored.pid&&restored.procStart);
  assert.deepEqual(ownedProcesses(home).records.find(record=>record.id===container.id)!.native,{pid:restored.pid,startedAt:restored.procStart});
  const receipt=readJson<any>(path.join(home,'run','launch-codex-app-server.json'));assert.ok(receipt.environment.inheritedLoopbackProxy.includes('HTTPS_PROXY'));assert.doesNotMatch(JSON.stringify(receipt),/127\.0\.0\.1:1/);
  assert.equal(await adopted.releaseRuntime(),undefined);
  const deadline=Date.now()+5000;while(liveProcess(runtime.wrapperPid)){assert.ok(Date.now()<deadline,'包装器未随原生子进程退出');await delay(50);}
  t.diagnostic('自定义 argv 包装器、原生进程归属与代理隔离通过；不调用模型，不启动真实 wrapper。');
});
