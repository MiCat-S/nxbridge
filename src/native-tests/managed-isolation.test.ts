import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdirSync, writeFileSync, readFileSync, lstatSync,existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { temporaryDirectory } from '../tests/support/temporary.js';
import { releaseNativeTestLaunches } from '../tests/support/native-launch.js';
import {ensureHome,socketDirectory} from '../ipc/home.js';
import {delay} from '../shared/time.js';
import {DEFAULT_CONFIG} from '../config/defaults.js';
import { selectHostLaunch } from '../hosts/host-launch.js';
import { requireDedicatedCodex, verifyDedicatedCodex } from '../hosts/codex/codex-isolation.js';
import { nativeDescendant } from '../process/process.js';
import { rememberOwnedChild, declareOwnedNative, type OwnedProcessRecord } from '../process/owned-processes.js';
import { launchIndependentWindows } from '../process/windows/windows-background.js';
import { spawnPosixSupervisor } from '../process/posix/posix-supervisor.js';
import { connectAppServer } from '../hosts/codex/adapter.js';
import {CodexAdapter} from '../hosts/codex/adapter.js';
import {managedRuntimes,managedRuntimeToken,runtimeFile,saveManagedRuntime} from '../hosts/managed-runtimes.js';
import {managedMarker} from '../install/installation.js';

test('原生隔离：核验专用 socket 及原生链接，客户端断开不停止后台；无模型调用',{timeout:60000},async t=>{
  const temp=temporaryDirectory(),root=temp.directory,home=path.join(root,'bridge'),configHome=path.join(root,'codex'),launchId=randomUUID();
  let client:Awaited<ReturnType<typeof connectAppServer>>|undefined;
                                                   
  t.after(async()=>{
    client?.close();
    try{
      assert.deepEqual(await releaseNativeTestLaunches(home,record=>record.proof.launchId===launchId),[]);
    }finally{await temp.cleanup();}
  });
  await ensureHome(home);mkdirSync(configHome);
  writeFileSync(path.join(configHome,'config.toml'),'check_for_update_on_startup=false\n[features]\napps=false\nremote_plugin=false\ncode_mode=false\n','utf8');
  const config={...DEFAULT_CONFIG,codexHome:configHome,...(process.env.NXBRIDGE_TEST_CODEX_BINARY?{codexBinary:process.env.NXBRIDGE_TEST_CODEX_BINARY}:{})},launch=selectHostLaunch('codex',config,{home,cwd:root});
  await requireDedicatedCodex(launch);const endpoint='unix://'+path.join(await socketDirectory(home),'isolation.sock'),at=Date.now();
  const args=[...launch.executable.prefix,'--no-daemon','app-server','--listen',endpoint],logfile=path.join(home,'run','isolation.log');let stderr='',wrapper:OwnedProcessRecord;
                                            
  if(process.platform==='win32')wrapper=await launchIndependentWindows({home,executable:launch.executable.command,args,cwd:launch.cwd,env:launch.env,logfile,role:'codex-runtime',launchId,configHome});
  else{
    const child=spawnPosixSupervisor(launch.executable.command,args,{cwd:launch.cwd,env:launch.env,stdio:['ignore','ignore','pipe'],waitForNative:true});
    child.stderr!.on('data',chunk=>stderr=(stderr+chunk).slice(-2000));await once(child,'spawn');
    const record=await rememberOwnedChild(home,child,'codex-runtime',{configHome,posixGroup:true},launchId);assert.ok(record);wrapper=record;
  }
  const deadline=Date.now()+15000;
  while(!client){try{client=await connectAppServer(endpoint,config,undefined,home,{readOnly:true});}catch(error){if(Date.now()>deadline)throw Error(String(error)+' '+(existsSync(logfile)?readFileSync(logfile,'utf8').slice(-2000):stderr));await delay(100);}}
  const native=await nativeDescendant(wrapper.identity.pid,'codex',at,endpoint,wrapper),alias=process.platform!=='win32'&&lstatSync(endpoint.slice(7)).isSymbolicLink();
  await declareOwnedNative(wrapper,native);
  await verifyDedicatedCodex(endpoint,native);
  if(alias)t.diagnostic('原生确定性链接已通过监听进程和代次核验。');
  assert.deepEqual((await client.request('thread/loaded/list',{})).data,[]);client.close();await delay(200);
  client=await connectAppServer(endpoint,config,undefined,home,{readOnly:true});assert.deepEqual((await client.request('thread/loaded/list',{})).data,[]);
  assert.equal((await nativeDescendant(wrapper.identity.pid,'codex',at,endpoint,wrapper)).startedAt,native.startedAt);
  client.close();client=undefined;
  saveManagedRuntime(home,{id:launchId,owner:managedMarker(home),kind:'owned',state:'ready',endpoint,pid:native.pid,procStart:native.startedAt,createdAt:at,dedicated:false,peerId:randomUUID(),configHome});
  const adapter=new CodexAdapter(config,home);
  try{assert.equal(await adapter.releaseRuntime(),undefined);assert.equal(managedRuntimes(home).length,0);if(process.platform!=='win32')assert.throws(()=>lstatSync(endpoint.slice(7)),{code:'ENOENT'});}finally{adapter.close();}
  t.diagnostic('历史 dedicated:false 运行时已重新证明并回收，原 socket 入口已清理。');
});

test('认证托管后台跨适配器重连，拒绝无凭证客户端，卸载只回收此原生代次',{skip:!['linux','win32','darwin'].includes(process.platform),timeout:60000},async t=>{
  const temp=temporaryDirectory(),root=temp.directory,home=path.join(root,'bridge'),configHome=path.join(root,'codex');await ensureHome(home);mkdirSync(configHome);
  writeFileSync(path.join(configHome,'config.toml'),'check_for_update_on_startup=false\n[features]\napps=false\nremote_plugin=false\ncode_mode=false\n','utf8');
  const config={...DEFAULT_CONFIG,codexHome:configHome,...(process.env.NXBRIDGE_TEST_CODEX_BINARY?{codexBinary:process.env.NXBRIDGE_TEST_CODEX_BINARY}:{})};let adapter=new CodexAdapter(config,home);t.after(async()=>{adapter.close();await temp.cleanup();});
  const endpoint=await adapter.ensureEndpoint(root,'isolated'),runtime=managedRuntimes(home)[0]!.value;
  if(!runtime.authenticatedLoopback){t.diagnostic('此原生版本未提供认证 WebSocket，保留 socket 及独占性保护。');await adapter.releaseRuntime();return;}
  assert.match(endpoint,/^ws:\/\/127\.0\.0\.1:\d+$/);assert.equal(runtime.dedicated,true);assert.ok(managedRuntimeToken(home,endpoint));
  const stranger=path.join(root,'stranger');await ensureHome(stranger);await assert.rejects(connectAppServer(endpoint,config,undefined,stranger,{readOnly:true}));
  const before=(await adapter.connect(endpoint));assert.deepEqual((await before.request('thread/loaded/list',{})).data,[]);adapter.close();
  adapter=new CodexAdapter(config,home);assert.equal(await adapter.ensureEndpoint(root,'isolated'),endpoint);assert.deepEqual((await (await adapter.connect(endpoint)).request('thread/loaded/list',{})).data,[]);
  adapter.close();saveManagedRuntime(home,{...runtime,state:'failed',failureCode:'app_server_start_failed',error:'夹具模拟握手超时后原生后台才就绪'});
  adapter=new CodexAdapter(config,home);assert.equal(await adapter.ensureEndpoint(root,'isolated'),endpoint);assert.equal(managedRuntimes(home)[0]!.value.state,'ready');assert.equal(managedRuntimes(home)[0]!.value.pid,runtime.pid);
  assert.equal(await adapter.releaseRuntime(),undefined);assert.equal(managedRuntimes(home).length,0);assert.equal(existsSync(runtimeFile(home,runtime.id).replace(/\.json$/,'.token')),false);
});
