import { overrideEnvironment } from '../tests/support/environment.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { readModelBody } from './model-http-fixture.js';
import { CodexAdapter } from '../hosts/codex/adapter.js';
import { brokerCall } from '../ipc/ipc.js';
import {PACKAGE_ROOT} from '../shared/package-location.js';
import {atomicJson,readJson} from '../shared/files.js';
import {delay} from '../shared/time.js';
import {ensureHome,removeOwnedSocket,socketDirectory} from '../ipc/home.js';
import { selectHostLaunch, spawnSelectedHost } from '../hosts/host-launch.js';
import { liveProcess, processIdentity } from '../process/process.js';
import { rememberOwnedChild } from '../process/owned-processes.js';
import { stopOwnedProcess } from '../process/process-stop.js';
import { Store } from '../storage/store.js';
import {DEFAULT_CONFIG} from '../config/defaults.js';
import { managedMarker } from '../install/installation.js';
import { registration } from '../tests/support/registration.js';
import { temporaryDirectory } from '../tests/support/temporary.js';
import { releaseNativeTestLaunches } from '../tests/support/native-launch.js';
import { randomUUID } from 'node:crypto';
import { managedRuntimes, runtimeFor, saveManagedRuntime } from '../hosts/managed-runtimes.js';

const execute=promisify(execFile);

                                                                
test('显式独立引导后重启托管会话，旧 MCP 竞争不改变协调器且完成结果明确',{skip:process.platform!=='win32',timeout:180000},async t=>{
  const temp=temporaryDirectory(),home=path.join(temp.directory,'bridge'),codexhome=path.join(temp.directory,'codex');
  const entry=path.join(PACKAGE_ROOT,'publish','nxbridge.mjs');
  mkdirSync(codexhome,{recursive:true});
  const env={NXBRIDGE_HOME:home,CODEX_HOME:codexhome,CLAUDE_CONFIG_DIR:path.join(temp.directory,'claude'),OPENAI_API_KEY:'nxbridge-local-service-test'};
  const restoreEnvironment=overrideEnvironment(env);
  const config={...DEFAULT_CONFIG,codexHome:codexhome,...(process.env.NXBRIDGE_TEST_CODEX_BINARY?{codexBinary:process.env.NXBRIDGE_TEST_CODEX_BINARY}:{})};
  const adapter=new CodexAdapter(config,home),pids=new Set<number>(),addresses=new Set<string>();let count=0,modelError='';
  const wait=async(predicate:()=>boolean|Promise<boolean>)=>{const end=Date.now()+20000;while(!await predicate()){if(Date.now()>end)throw Error('隔离服务重启等待超时：'+modelError);await delay(50);}};
  const model=http.createServer(async(req,res)=>{
    try{
      const raw=await readModelBody(req);
      if(!req.url?.includes('/responses')){res.writeHead(200,{'content-type':'application/json'});res.end('{"data":[]}');return;}
      const body=JSON.parse(raw.toString()),last=body.input?.at?.(-1);
                                             
      if(!(last?.type==='function_call_output'&&last.name==='receive_messages'&&/"notices":\[\{/.test(last.output??'')&&!/"messages":\[\{/.test(last.output??'')))count++;
      const item={type:'message',id:'service-final',role:'assistant',status:'completed',content:[{type:'output_text',text:'隔离服务重启的持久答案'}]};
      res.writeHead(200,{'content-type':'text/event-stream'});
      for(const event of [{type:'response.created',response:{id:'service-response-'+count,status:'in_progress',output:[]}},{type:'response.output_item.added',output_index:0,item},{type:'response.output_item.done',output_index:0,item},{type:'response.completed',response:{id:'service-response-'+count,status:'completed',output:[item],usage:{input_tokens:10,output_tokens:10,total_tokens:20}}}])res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
      res.end();
    }catch(error){modelError=String(error);res.writeHead(500);res.end(modelError);}
  });
  const runtimeId=randomUUID(),legacyFile=path.join(temp.directory,'legacy-mcp.json'),attempts=path.join(temp.directory,'legacy-attempts');
  t.after(async()=>{
    if(existsSync(legacyFile)){const legacy=readJson<{pid:number;generation:string}>(legacyFile);await stopOwnedProcess({pid:legacy.pid,startedAt:legacy.generation});}
    try{await brokerCall('shutdown',{releaseOwned:false},{home,start:false});}catch{}
    adapter.close();for(const {value:saved} of managedRuntimes(home)){if(saved.pid)pids.add(saved.pid);addresses.add(saved.endpoint);}
    assert.deepEqual(await releaseNativeTestLaunches(home),[]);await wait(()=>[...pids].every(pid=>!liveProcess(pid)));
    for(const address of addresses)await removeOwnedSocket(home,address);
    const socketRoot=[...addresses][0];if(socketRoot){const directory=path.dirname(socketRoot.slice(7));if(path.resolve(directory)!==path.resolve(path.join(home,'run')))rmdirSync(directory);}
    model.closeAllConnections();await new Promise<void>(resolve=>model.close(()=>resolve()));
    restoreEnvironment();
    await temp.cleanup();
  });
  await new Promise<void>(resolve=>model.listen(0,'127.0.0.1',resolve));
  writeFileSync(path.join(codexhome,'config.toml'),`model_provider="service_test"\nmodel="gpt-5.1-codex"\nmodel_reasoning_effort="high"\nweb_search="disabled"\nsandbox_mode="danger-full-access"\napproval_policy="never"\n[model_providers.service_test]\nname="隔离服务重启"\nbase_url="http://127.0.0.1:${(model.address() as AddressInfo).port}/v1"\nwire_api="responses"\nrequires_openai_auth=false\n[features]\napps=false\nremote_plugin=false\n[features.code_mode]\nenabled=false\n[analytics]\nenabled=false\n`,'utf8');
  await ensureHome(home);atomicJson(path.join(home,'config.json'),config);
  mkdirSync(path.join(home,'bin'),{recursive:true});
  atomicJson(path.join(home,'bin','runtime.json'),{owner:managedMarker(home),entry,node:process.execPath,home});
  const address='unix://'+path.join(await socketDirectory(home),'service-initial.sock');
  addresses.add(address);
  const launch=selectHostLaunch('codex',config,{home,cwd:temp.directory}),child=spawnSelectedHost(launch,['--no-daemon','app-server','--listen',address],{stdio:'ignore'});assert.ok(child.pid);pids.add(child.pid);
  await rememberOwnedChild(home,child,'codex-runtime',{configHome:codexhome},runtimeId);
  await wait(async()=>{try{await adapter.connect(address);return true;}catch{return false;}});
  const store=new Store(path.join(home,'nxbridge.db'));
  let peer;
  try{const placeholder=store.placeholder('codex',temp.directory);saveManagedRuntime(home,{id:runtimeId,peerId:placeholder.id,owner:managedMarker(home),kind:'owned',state:'ready',createdAt:Date.now(),endpoint:address,pid:child.pid,procStart:(await processIdentity(child.pid)).startedAt,configHome:codexhome,executable:launch.executable.command});peer=store.adopt(placeholder.id,await adapter.create(placeholder));const partner=store.register(registration('claude','service-fixture'));store.pair(partner.id,peer.id);}finally{store.close();}
  const rpc=await adapter.connect(address);let complete=false;
  rpc.on('notification',message=>{if(message.method==='turn/completed')complete=true;});
  await rpc.request('turn/start',{threadId:peer.sessionId,input:[{type:'text',text:'启动隔离 broker 后结束。'}]},{mutation:true});
  await wait(()=>complete);
                                           
  const starter=path.join(temp.directory,'start-broker.mjs');
  writeFileSync(starter,"import {spawn} from 'node:child_process';const child=spawn(process.execPath,['--no-warnings',"+JSON.stringify(entry)+",'service'],{detached:true,windowsHide:true,stdio:'ignore',env:{...process.env,NXBRIDGE_SERVICE_ORIGIN:'[]'}});child.unref();",'utf8');
  const terminal=await rpc.request('command/exec',{command:[process.execPath,'--no-warnings',starter],cwd:temp.directory,timeoutMs:20000,sandboxPolicy:{type:'dangerFullAccess'}},{timeout:25000,mutation:true});
  assert.equal(terminal.exitCode,0,JSON.stringify(terminal));
  await wait(async()=>{try{await brokerCall('ping',{}, {home,start:false});return true;}catch{return false;}});
  const before=await brokerCall('ping',{}, {home,start:false});
  assert.deepEqual(before.origin,[],'祖先记录缺失不能作为脱离目标宿主的证据');
                                                     
  const legacyScript=path.join(temp.directory,'legacy-mcp.mjs');
  writeFileSync(legacyScript,`import{writeFileSync,appendFileSync}from'node:fs';import{ensureBroker,connectBroker}from${JSON.stringify(pathToFileURL(path.join(PACKAGE_ROOT,'dist','ipc','ipc.js')).href)};import{processIdentity}from${JSON.stringify(pathToFileURL(path.join(PACKAGE_ROOT,'dist','process','process.js')).href)};writeFileSync(${JSON.stringify(legacyFile)},JSON.stringify({pid:process.pid,generation:(await processIdentity(process.pid)).startedAt}));let busy=false;setInterval(async()=>{if(busy)return;busy=true;try{const c=await connectBroker(${JSON.stringify(home)},100);try{await c.request('ping',{}, {timeout:100});}finally{c.close();}}catch{appendFileSync(${JSON.stringify(attempts)},'attempt\\n');try{const c=await ensureBroker(${JSON.stringify(home)});c.close();}catch{}}finally{busy=false;}},20);`,'utf8');
  const legacyStarter=path.join(temp.directory,'start-legacy.mjs');
  writeFileSync(legacyStarter,`import{spawn}from'node:child_process';const c=spawn(process.execPath,['--no-warnings',${JSON.stringify(legacyScript)}],{detached:true,windowsHide:true,stdio:'ignore'});c.unref();`,'utf8');
  const legacyLaunch=await rpc.request('command/exec',{command:[process.execPath,'--no-warnings',legacyStarter],cwd:temp.directory,timeoutMs:20000,sandboxPolicy:{type:'dangerFullAccess'}},{timeout:25000,mutation:true});
  assert.equal(legacyLaunch.exitCode,0,JSON.stringify(legacyLaunch));await wait(()=>existsSync(legacyFile));
  const bootstrap=await execute(process.execPath,['--no-warnings',entry,'bootstrap'],{env:process.env,windowsHide:true,timeout:90000});assert.match(bootstrap.stdout,/独立运行/);
  const independent=await brokerCall('ping',{}, {home,start:false});assert.notEqual(independent.pid,before.pid);if(process.platform==='win32')assert.equal(independent.runtime.windowsIndependent,true);
  await wait(async()=>{const status=await brokerCall('status',{}, {home,start:false});return status.peers.find((value:any)=>value.id===peer.id)?.state==='ready';});
  const result=await execute(process.execPath,['--no-warnings',entry,'restart','codex','--member',peer.id],{env:process.env,windowsHide:true,timeout:90000});
  assert.match(result.stdout,/Codex 已用新运行时恢复原会话/);assert.equal(result.stderr,'');
  const after=runtimeFor(home,{peerId:peer.id})!.value;assert.ok(after.pid);pids.add(after.pid);assert.notEqual(after.pid,child.pid);
  const service=await brokerCall('ping',{}, {home,start:false});assert.equal(service.pid,independent.pid);assert.equal(service.origin.some((value:any)=>value.pid===child.pid),false);
  assert.ok(existsSync(attempts)&&readFileSync(attempts,'utf8').includes('attempt'),'旧客户端必须实际经历断连并尝试抢启服务');
  assert.equal(readdirSync(path.dirname(address.slice(7))).includes(path.basename(address.slice(7))),false,'确认旧进程退出后应清理自有 socket');
  const verified=new Store(path.join(home,'nxbridge.db'));
  try{assert.ok(verified.events(0,10000).some(event=>event.type==='codex.restarted'));}finally{verified.close();}
  assert.equal(count,1,'冷恢复不能触发额外模型请求');assert.ok(before.pid);
});
