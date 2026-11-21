import test from 'node:test';
import { spawnPosixSupervisor } from '../process/posix/posix-supervisor.js';
import assert from 'node:assert/strict';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync,statSync,chmodSync,writeFileSync,unlinkSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import net from 'node:net';
import { managedRuntimes, managedRuntimeState, managedRuntimeNativeState, removeManagedRuntime, runtimeFor, saveManagedRuntime, createRuntimeToken,managedRuntimeToken,managedRemoteAuthentication,localCodexEndpoint,type ManagedRuntime } from '../hosts/managed-runtimes.js';
import {atomicJson} from '../shared/files.js';
import {ensureHome} from '../ipc/home.js';
import {delay} from '../shared/time.js';
import { managedMarker } from '../install/installation.js';
import { processIdentity } from '../process/process.js';
import { CodexAdapter,connectAppServer } from '../hosts/codex/adapter.js';
import {BridgeError} from '../shared/errors.js';
import {DEFAULT_CONFIG} from '../config/defaults.js';
import { Store } from '../storage/store.js';
import { codexInitializeResult, registration } from './support/registration.js';
import { temporary } from './support/temporary.js';
import { forgetOwnedProcess, completeOwnedContainer, recordSpawnedProcess, declareOwnedNative, rememberOwnedChild, ownedProcesses, ownedRecordState, releaseOwnedProcess, releaseRecordedProcesses, processRegistryDirectory, prepareProcessRegistry, type OwnedProcessRecord } from '../process/owned-processes.js';
import { ownedProcessState } from '../process/process-stop.js';
import { pruneDeadProcessRecords } from '../process/process-records.js';
import { launchIndependentWindows } from '../process/windows/windows-background.js';
import { requireIndependentWindows } from './support/windows-job.js';

function record(home:string,peerId:string,patch:Partial<ManagedRuntime>={}):ManagedRuntime{return{id:randomUUID(),peerId,owner:managedMarker(home),kind:'owned',state:'starting',endpoint:'unix://'+path.join(home,peerId+'.sock'),createdAt:Date.now(),...patch};}

test('原生恢复只借用同配置目录中实际加载的明确会话，死代次与未加载线程不接管',async t=>{
  const home=temporary(t);await ensureHome(home);const identity=await processIdentity(process.pid),adapter=new CodexAdapter(DEFAULT_CONFIG,home);t.after(()=>adapter.close());
  const a=record(home,'loaded',{state:'ready',configHome:home,pid:identity.pid,procStart:identity.startedAt});saveManagedRuntime(home,a);
  saveManagedRuntime(home,record(home,'dead',{state:'ready',configHome:home,pid:identity.pid,procStart:'旧代次'}));
  saveManagedRuntime(home,record(home,'other-home',{state:'ready',configHome:path.join(home,'other'),pid:identity.pid,procStart:identity.startedAt}));
  const seen:string[]=[];t.mock.method(adapter,'sessionState',async(peer:{sessionId:string},endpoint:{address:string})=>{seen.push(endpoint.address);return peer.sessionId==='exact-id'?'alive':'dead';});
  assert.equal((await adapter.loadedRuntime('exact-id',home))?.id,a.id);assert.deepEqual(seen,[a.endpoint]);
  assert.equal(await adapter.loadedRuntime('unloaded-id',home),undefined);assert.equal(managedRuntimes(home).length,3,'核验不能创建或恢复后台');
});

test('认证后台凭证不进入状态与参数，原窗口认证选择保持不变，回收记录一并删除凭证',async t=>{
  const home=temporary(t);await ensureHome(home);const value=record(home,'authenticated',{endpoint:'ws://127.0.0.1:12345',authenticatedLoopback:true,state:'ready',pid:process.pid,procStart:(await processIdentity(process.pid)).startedAt});saveManagedRuntime(home,value);
  const file=createRuntimeToken(home,value),token=managedRuntimeToken(home,value.endpoint)!;assert.match(token,/^[a-f0-9]{64}$/);assert.equal(JSON.stringify(managedRuntimes(home)).includes(token),false);
  assert.equal(localCodexEndpoint(home,value.endpoint),true);assert.equal(localCodexEndpoint(undefined,value.endpoint),false);
  assert.equal(localCodexEndpoint(home,'ws://127.0.0.1:12346'),false);assert.equal(localCodexEndpoint(home,'ws://localhost:12345'),false);assert.equal(localCodexEndpoint(home,'wss://remote.invalid'),false);
  const original=['--remote',value.endpoint,'resume','--last'],authentication=await managedRemoteAuthentication(home,original);
  assert.equal(authentication.env.NXBRIDGE_CODEX_REMOTE_TOKEN,token);assert.equal(JSON.stringify(authentication.args).includes(token),false);assert.deepEqual(original,['--remote',value.endpoint,'resume','--last']);
  assert.deepEqual((await managedRemoteAuthentication(home,['--remote',value.endpoint,'--remote-auth-token-env','USER_TOKEN'])).env,{});
  assert.deepEqual((await managedRemoteAuthentication(home,['--','--remote',value.endpoint])).env,{});
  if(process.platform!=='win32'){assert.equal(statSync(file).mode&0o777,0o600);chmodSync(file,0o644);assert.equal(managedRuntimeToken(home,value.endpoint),token);chmodSync(file,0o600);}
  removeManagedRuntime(runtimeFor(home,{id:value.id})!);assert.equal(existsSync(file),false);assert.equal(managedRuntimeToken(home,value.endpoint),undefined);assert.equal(localCodexEndpoint(home,value.endpoint),false);
});

test('端口复用、失败和歧义记录不能向陌生监听者发送托管凭证或启动原生窗口',async t=>{
  const home=temporary(t);await ensureHome(home);let connections=0;
  const server=net.createServer(socket=>{connections++;socket.destroy();});await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise<void>(resolve=>server.close(()=>resolve())));
  const value=record(home,'stale-port',{endpoint:'ws://127.0.0.1:'+(server.address() as net.AddressInfo).port,authenticatedLoopback:true,state:'ready',pid:process.pid,procStart:'stale-generation'});saveManagedRuntime(home,value);createRuntimeToken(home,value);
  await assert.rejects(connectAppServer(value.endpoint,DEFAULT_CONFIG,undefined,home),{code:'runtime_endpoint_unverified'});
  await assert.rejects(managedRemoteAuthentication(home,['--remote',value.endpoint,'resume','--last']),{code:'runtime_endpoint_unverified'});assert.equal(connections,0);
  const store=new Store(':memory:');t.after(()=>store.close());
  const peer=store.register(registration('codex','probe-port')),identity=await processIdentity(process.pid);
  const endpoint={...store.endpoint(peer.id)!,mode:'app-server' as const,address:value.endpoint,pid:identity.pid,procStart:identity.startedAt};
  const adapter=new CodexAdapter(DEFAULT_CONFIG,home);
  const health=await adapter.probe(peer,endpoint);
  assert.equal(health.state,'blocked');assert.match(health.reasons.join(),/owned App Server exited or PID generation changed/);assert.equal(connections,0,'用户暂时持有托管端点时也不能向复用端口发送凭证');
  saveManagedRuntime(home,{...value,state:'failed'});assert.equal(localCodexEndpoint(home,value.endpoint),false);assert.throws(()=>managedRuntimeToken(home,value.endpoint),{code:'runtime_endpoint_unverified'});
  await assert.rejects(connectAppServer(value.endpoint,DEFAULT_CONFIG,undefined,home),{code:'runtime_endpoint_unverified'});assert.equal(connections,0);
  saveManagedRuntime(home,value);saveManagedRuntime(home,{...value,id:randomUUID()});assert.equal(localCodexEndpoint(home,value.endpoint),false);
  await assert.rejects(connectAppServer(value.endpoint,DEFAULT_CONFIG,undefined,home),{code:'runtime_ambiguous'});assert.equal(connections,0);
});

test('每个成员保留独立运行时，旧单文件只读并列，不覆盖其他成员',async t=>{
  const home=temporary(t);await ensureHome(home);
  const a=record(home,'a'),b=record(home,'b');saveManagedRuntime(home,a);saveManagedRuntime(home,b);
  atomicJson(path.join(home,'run','codex-runtime.json'),{endpoint:'unix://legacy',pid:2147483647,procStart:'old'});
  assert.equal(managedRuntimes(home).length,3);assert.equal(runtimeFor(home,{peerId:'a'})?.value.id,a.id);assert.equal(runtimeFor(home,{endpoint:b.endpoint})?.value.peerId,'b');
  removeManagedRuntime(runtimeFor(home,{peerId:'a'})!);
  assert.equal(runtimeFor(home,{peerId:'b'})?.value.id,b.id);assert.equal(runtimeFor(home,{id:'legacy'})?.value.endpoint,'unix://legacy');
});

test('托管运行时保留新版自写字段，读取仍绑定记录 ID 与安装归属',async t=>{
  const home=temporary(t);await ensureHome(home);const value=record(home,'future');
  saveManagedRuntime(home,{...value,state:'future-state',newField:{revision:2}} as any);
  assert.equal(managedRuntimes(home)[0]!.value.state,'future-state');
  saveManagedRuntime(home,{...value,owner:'another-installation'});
  assert.throws(()=>managedRuntimes(home),{code:'runtime_record_invalid'});
});

test('Linux 旧 boot ID 在 PID 和 ticks 碰巧相同时仍阻止接管与发送凭证；同次启动的时钟变化不误伤',{skip:process.platform!=='linux'},async t=>{
  const home=temporary(t);await ensureHome(home);const identity=await processIdentity(process.pid),runtime=record(home,'boot-fence',{state:'ready',endpoint:'ws://127.0.0.1:12345',authenticatedLoopback:true,pid:identity.pid,procStart:identity.startedAt});saveManagedRuntime(home,runtime);createRuntimeToken(home,runtime);
  const proof=await recordSpawnedProcess(home,{role:'codex-runtime',identity,native:identity,proof:{kind:'spawn',launchId:runtime.id}}),filename=path.join(processRegistryDirectory(home),proof.id+'.json');
  try{
    assert.ok(proof.bootId);proof.bootTime=0;atomicJson(filename,proof);
    assert.equal(await managedRuntimeNativeState(home,runtime),'alive');assert.equal(await managedRuntimeState(home,runtime),'alive');
    proof.bootId='previous-boot';atomicJson(filename,proof);runtime.bootId='previous-boot';saveManagedRuntime(home,runtime);
    assert.equal(await managedRuntimeNativeState(home,runtime),'dead');assert.equal(await managedRuntimeState(home,runtime),'dead');assert.equal(await managedRuntimeNativeState(home,{...runtime,pid:undefined,procStart:undefined}),'dead');
    delete runtime.bootId;saveManagedRuntime(home,runtime);await assert.rejects(managedRemoteAuthentication(home,['--remote',runtime.endpoint]),{code:'runtime_endpoint_unverified'});
    const store=new Store(':memory:'),adapter=new CodexAdapter(DEFAULT_CONFIG,home);t.after(()=>{adapter.close();store.close();});const peer=store.register(registration('codex','boot-probe'));
    await assert.rejects(adapter.probe(peer,{...store.endpoint(peer.id)!,address:runtime.endpoint,pid:identity.pid,procStart:identity.startedAt}),{code:'runtime_endpoint_unverified'});
    runtime.bootId='previous-boot';saveManagedRuntime(home,runtime);assert.equal(localCodexEndpoint(home,runtime.endpoint),false);assert.throws(()=>managedRuntimeToken(home,runtime.endpoint),{code:'runtime_endpoint_unverified'});
    delete proof.bootId;atomicJson(filename,proof);delete runtime.bootId;saveManagedRuntime(home,runtime);assert.equal(await managedRuntimeNativeState(home,runtime),'alive','没有 boot ID 的旧记录保留精确活代次判断');
  }finally{forgetOwnedProcess(proof);}
});

test('原生代次退出后允许恢复，仍存活或未知的包装器仅保留清理证据',async t=>{
  const home=temporary(t);await ensureHome(home);const identity=await processIdentity(process.pid);
  const adapter=new CodexAdapter({...DEFAULT_CONFIG,codexCommand:['nxbridge-missing-relaunch-fixture']},home);t.after(()=>adapter.close());
  let connects=0;t.mock.method(adapter,'connect',async()=>{connects++;throw Error('旧原生代次已退出');});
  for(const unknown of [false,true]){
    const a=record(home,unknown?'unknown':'alive',{state:'ready',pid:2147483647,procStart:'dead',wrapperPid:unknown?-1:identity.pid,wrapperProcStart:unknown?'unknown':identity.startedAt});saveManagedRuntime(home,a);
    assert.equal(await managedRuntimeState(home,a),unknown?'unknown':'alive');assert.equal(await managedRuntimeNativeState(home,a),'dead');
    await assert.rejects(adapter.ensureEndpoint(home,a.peerId),{code:'launch_command_missing'});
    assert.equal(runtimeFor(home,{id:a.id})!.value.state,'failed');assert.equal(runtimeFor(home,{id:a.id})!.value.wrapperPid,a.wrapperPid);
  }
  assert.equal(connects,0);assert.equal(managedRuntimes(home).length,2);
});

test('退休的原生代次不制造活动预约歧义；无关损坏归属保留诊断但不污染运行时状态',async t=>{
  const home=temporary(t);await ensureHome(home);await prepareProcessRegistry(home);const identity=await processIdentity(process.pid);
  const stale=record(home,'a',{state:'ready',pid:2147483647,procStart:'dead',wrapperPid:-1,wrapperProcStart:'unknown'}),active=record(home,'a',{state:'ready',pid:identity.pid,procStart:identity.startedAt});saveManagedRuntime(home,stale);saveManagedRuntime(home,active);
  const malformed=path.join(processRegistryDirectory(home),randomUUID()+'.json');writeFileSync(malformed,'{损坏的无关记录','utf8');
  try{
  const ended=record(home,'ended',{pid:2147483647,procStart:'dead'});
  assert.equal(ownedProcesses(home).notes.length,1);assert.equal(await managedRuntimeState(home,ended),'dead');
  assert.equal(await managedRuntimeState(home,record(home,'reserved')),'unknown');
  const adapter=new CodexAdapter(DEFAULT_CONFIG,home);t.after(()=>adapter.close());const seen:string[]=[];
  t.mock.method(adapter,'connect',async(endpoint:string)=>{seen.push(endpoint);return{} as any;});
  assert.equal(await adapter.ensureEndpoint(home,'a'),active.endpoint);assert.deepEqual(seen,[active.endpoint]);assert.equal(runtimeFor(home,{peerId:'a'})!.value.id,active.id);
  }finally{unlinkSync(malformed);}
});

test('握手前失败仍回收本次创建的完整容器，并允许下次重新启动',{timeout:60000},async t=>{
  if(!await requireIndependentWindows(t))return;
  const home=temporary(t);await ensureHome(home);const script=path.join(home,'failed-start.cjs'),output=path.join(home,'created.json');
  writeFileSync(script,`const{spawn}=require('node:child_process'),fs=require('node:fs');if(process.argv.includes('--help')){process.stdout.write('fixture app-server');}else{const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore',windowsHide:true});fs.writeFileSync(${JSON.stringify(output)},JSON.stringify({wrapper:process.pid,child:child.pid}));setInterval(()=>{},1000);}`,'utf8');
  const adapter=new CodexAdapter({...DEFAULT_CONFIG,codexCommand:[process.execPath,script],codexHome:home},home);t.after(async()=>{adapter.close();assert.deepEqual(await releaseRecordedProcesses(home,()=>true),[]);});
  let attempts=0,lastId:string|undefined,identities:Awaited<ReturnType<typeof processIdentity>>[]=[],container:OwnedProcessRecord|undefined;
  t.mock.method(adapter,'connect',async()=>{const deadline=Date.now()+5000;while(!existsSync(output)){assert.ok(Date.now()<deadline,'启动夹具未创建后代');await delay(20);}const created=JSON.parse(readFileSync(output,'utf8'));identities=await Promise.all([processIdentity(created.wrapper),processIdentity(created.child)]);container=ownedProcesses(home).records.find(record=>record.windowsJob||record.posixGroup);attempts++;throw new BridgeError('process_launch_unverified','夹具拒绝原生交接');});
  for(let attempt=0;attempt<2;attempt++){
    await assert.rejects(adapter.ensureEndpoint(home,'failed-start'),{code:'process_launch_unverified'});
    const saved=runtimeFor(home,{peerId:'failed-start'})!.value;
    assert.equal(saved.state,'failed');assert.equal(saved.launchSettled,true);assert.notEqual(saved.id,lastId);lastId=saved.id;
    assert.equal(await managedRuntimeState(home,saved),'dead');assert.equal(await managedRuntimeNativeState(home,saved),'dead');
    assert.equal(ownedProcesses(home).records.some(record=>record.proof.launchId===saved.id),false);
    for(const identity of identities)assert.equal(await ownedProcessState(identity),'dead');unlinkSync(output);
    assert.ok(container);
                                                 
    atomicJson(path.join(processRegistryDirectory(home),container.id+'.json'),container);
    const pending={...saved,pid:undefined,procStart:undefined,launchSettled:undefined};saveManagedRuntime(home,pending);
    assert.equal(await managedRuntimeState(home,pending),'dead');assert.equal(await managedRuntimeNativeState(home,pending),'dead');
    await pruneDeadProcessRecords(home);assert.equal(runtimeFor(home,{id:saved.id}),undefined);
  }
  assert.equal(attempts,2);
});

test('没有启动证明的失败预约保持未知；只有已确认没有进程的失败可清理',async t=>{
  const home=temporary(t);await ensureHome(home);const a=record(home,'a',{state:'failed'});
  assert.equal(await managedRuntimeState(home,a),'unknown');assert.equal(await managedRuntimeState(home,{...a,launchSettled:true}),'dead');
  saveManagedRuntime(home,a);const adapter=new CodexAdapter(DEFAULT_CONFIG,home);t.after(()=>adapter.close());t.mock.method(adapter,'connect',async()=>{throw Error('无端点');});
  await assert.rejects(adapter.ensureEndpoint(home,'a'),{code:'runtime_launch_unconfirmed'});
});

test('协调器在声明前退出，下一实例回收仅剩辅助进程的原容器再解除启动预约',{skip:process.platform==='win32',timeout:30000},async t=>{
  const home=temporary(t);await ensureHome(home);const ready=path.join(home,'undeclared.json'),stop=path.join(home,'owner-exit'),saved=record(home,'undeclared');
  const source="const{spawn}=require('node:child_process');const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});child.once('spawn',()=>{require('node:fs').writeFileSync(process.argv[1],JSON.stringify({pid:child.pid}));process.exit(0);});";
  const module=(name:string)=>JSON.stringify(new URL('../'+name+'.js',import.meta.url).href),ownerSource=`import{spawnPosixSupervisor}from ${module('process/posix/posix-supervisor')};import{rememberOwnedChild}from ${module('process/owned-processes')};import{saveManagedRuntime}from ${module('hosts/managed-runtimes')};import{existsSync}from'node:fs';const saved=${JSON.stringify(saved)},child=spawnPosixSupervisor(process.execPath,['-e',${JSON.stringify(source)},${JSON.stringify(ready)}],{stdio:'ignore',waitForNative:true});const proof=await rememberOwnedChild(${JSON.stringify(home)},child,'codex-runtime',{peerId:saved.peerId,posixGroup:true},saved.id);saved.wrapperPid=proof.identity.pid;saved.wrapperProcStart=proof.identity.startedAt;saveManagedRuntime(${JSON.stringify(home)},saved);setInterval(()=>{if(existsSync(${JSON.stringify(stop)}))process.exit(0);},20);`;
  const owner=spawn(process.execPath,['--input-type=module','-e',ownerSource],{stdio:'ignore'}),closed=once(owner,'close');
  t.after(async()=>{if(owner.exitCode===null&&owner.signalCode===null)owner.kill();await closed;assert.deepEqual(await releaseRecordedProcesses(home,()=>true),[]);});
  const deadline=Date.now()+5000;while(!existsSync(ready)){assert.ok(Date.now()<deadline);await delay(20);}
  const helper=await processIdentity(JSON.parse(readFileSync(ready,'utf8')).pid);
  while(!runtimeFor(home,{id:saved.id})){assert.ok(Date.now()<deadline);await delay(20);}
  const container=ownedProcesses(home).records.find(value=>value.proof.launchId===saved.id)!;
  assert.equal(await ownedRecordState(container),'alive');assert.equal(ownedProcesses(home).records.find(value=>value.id===container.id)!.native,undefined);
  const adapter=new CodexAdapter({...DEFAULT_CONFIG,codexCommand:['nxbridge-missing-relaunch-fixture']},home);t.after(()=>adapter.close());
  await assert.rejects(adapter.ensureEndpoint(home,saved.peerId),{code:'runtime_launch_unconfirmed'});assert.equal(await ownedProcessState(helper),'alive','创建者仍存活时不能回收正在交接的启动');
  writeFileSync(stop,'退出','utf8');await closed;
  await assert.rejects(adapter.ensureEndpoint(home,saved.peerId),{code:'launch_command_missing'});
  assert.equal(await ownedProcessState(helper),'dead');assert.equal(await ownedProcessState(container.identity),'dead');assert.equal(runtimeFor(home,{id:saved.id}),undefined);
});

test('释放已完成容器时仍回收原代持有器，再移除运行时与归属记录',{skip:process.platform!=='win32'},async t=>{
  const home=temporary(t);await ensureHome(home);
  const holder=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore',windowsHide:true}),closed=once(holder,'close');await once(holder,'spawn');
  t.after(async()=>{if(holder.exitCode===null&&holder.signalCode===null)holder.kill();await closed;});
  const native=await processIdentity(holder.pid!),saved=record(home,'completed',{pid:2147483647,procStart:'dead',state:'ready',launchSettled:true});
  const container=await recordSpawnedProcess(home,{role:'codex-runtime',identity:{pid:2147483647,startedAt:'dead',parentPid:0,name:'已退出的入口'},proof:{kind:'spawn',launchId:saved.id},windowsJob:'Global\\nxbridge-fixture-'+saved.id,windowsHolder:native});
  completeOwnedContainer(container);saveManagedRuntime(home,saved);
  const adapter=new CodexAdapter(DEFAULT_CONFIG,home);t.after(()=>adapter.close());
  assert.equal(await adapter.releaseRuntime([],saved.endpoint),undefined);await closed;
  assert.equal(await ownedProcessState(native),'dead');assert.equal(runtimeFor(home,{id:saved.id}),undefined);assert.equal(ownedProcesses(home).records.length,0);
});

test('启动独立性失败在当前调用进程短暂退避，保留原诊断且不重复尝试',async t=>{
  const home=temporary(t);await ensureHome(home);const a=record(home,'a',{state:'failed',launchSettled:true,failureCode:'bootstrap_required',error:'原生拒绝 breakaway'});saveManagedRuntime(home,a);
  const {deferBackgroundRetry}=await import('../hosts/background-state.js');deferBackgroundRetry(home,a.error!);
  const adapter=new CodexAdapter(DEFAULT_CONFIG,home);t.after(()=>adapter.close());let connects=0;t.mock.method(adapter,'connect',async()=>{connects++;throw Error('不应连接');});
  await assert.rejects(adapter.ensureEndpoint(home,'a'),error=>{assert.equal((error as BridgeError).code,'bootstrap_required');assert.match((error as Error).message,/未重复尝试.*原生拒绝 breakaway/);return true;});assert.equal(connects,0);assert.equal(managedRuntimes(home).length,1);
});

test('运行时记录更新后旧快照不能删除；同一成员多个活动预约明确拒绝',async t=>{
  const home=temporary(t);await ensureHome(home);const a=record(home,'a');saveManagedRuntime(home,a);const snapshot=runtimeFor(home,{peerId:'a'})!;
  saveManagedRuntime(home,{...a,wrapperPid:process.pid,wrapperProcStart:'new'});assert.throws(()=>removeManagedRuntime(snapshot),{code:'runtime_changed'});assert.equal(existsSync(snapshot.file),true);
  saveManagedRuntime(home,record(home,'a'));assert.throws(()=>runtimeFor(home,{peerId:'a'}),{code:'runtime_ambiguous'});
});

test('已退出的归档线程不再连接死端点；存活或身份不明的端点仍需确认退订',async t=>{
  const home=temporary(t),store=new Store(':memory:');t.after(()=>store.close());
  const adapter=new CodexAdapter(DEFAULT_CONFIG,home);t.after(()=>adapter.close());
  const peer=store.register(registration('codex','retired-thread')),endpoint=store.endpoint(peer.id)!;
  let connects=0;t.mock.method(adapter,'connect',async()=>{connects++;throw Error('无法连接');});
  await adapter.release(peer,{...endpoint,pid:2147483647,procStart:'retired-generation'});
  await adapter.release(peer,{...endpoint,pid:null,procStart:null,native:{pid:2147483647,procStart:'retired-generation'}});
  assert.equal(connects,0);assert.equal(managedRuntimes(home).length,0);
  const identity=await processIdentity(process.pid);
  await assert.rejects(adapter.release(peer,{...endpoint,pid:process.pid,procStart:identity.startedAt}),/无法连接/);
  await assert.rejects(adapter.release(peer,{...endpoint,pid:null,procStart:null}),/无法连接/);
  assert.equal(connects,2);
});

test('包装器先退出时仍保留活跃容器，显式释放会回收其后代且不影响其他成员',{timeout:45000},async t=>{
  if(!await requireIndependentWindows(t))return;
  const home=temporary(t);await ensureHome(home);const output=path.join(home,'descendant.json'),exit=path.join(home,'exit-wrapper');
  const args=['-e',`const{spawn}=require('node:child_process'),fs=require('node:fs');const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore',windowsHide:true,detached:process.platform==='win32'});fs.writeFileSync(process.argv[1],JSON.stringify({pid:child.pid,wrapper:process.pid}));setInterval(()=>{if(fs.existsSync(process.argv[2]))process.exit(0);},25);`,output,exit],launchId=randomUUID();
  let wrapper:OwnedProcessRecord|undefined,supervisor:ReturnType<typeof spawnPosixSupervisor>|undefined;
  if(process.platform==='win32')wrapper=await launchIndependentWindows({home,executable:process.execPath,args,cwd:home,env:process.env,logfile:path.join(home,'wrapper.log'),role:'codex-runtime',peerId:'a',launchId});
  else{supervisor=spawnPosixSupervisor(process.execPath,args,{stdio:'ignore',waitForNative:true});await once(supervisor,'spawn');wrapper=await rememberOwnedChild(home,supervisor,'codex-runtime',{peerId:'a',posixGroup:true},launchId);}
  assert.ok(wrapper);
  t.after(async()=>{for(const proof of ownedProcesses(home).records.reverse())if(proof.proof.launchId===launchId)await releaseOwnedProcess(proof);});
  const end=Date.now()+5000;while(!existsSync(output)){if(Date.now()>end)throw Error('包装器未启动后代');await delay(20);}
  const ready=JSON.parse(readFileSync(output,'utf8')),descendant=await processIdentity(ready.pid),command=await processIdentity(ready.wrapper);
  await declareOwnedNative(wrapper,descendant);
  writeFileSync(exit,'退出','utf8');
  while(await ownedProcessState(command)!=='dead'){if(Date.now()>end)throw Error('包装器未退出');await delay(20);}
  assert.equal(await ownedRecordState(wrapper),'alive');
  await pruneDeadProcessRecords(home);assert.ok(ownedProcesses(home).records.some(value=>value.id===wrapper!.id),'周期维护必须保留仍有成员的容器');
  const saved=record(home,'a',{id:launchId,wrapperPid:wrapper.identity.pid,wrapperProcStart:wrapper.identity.startedAt});saveManagedRuntime(home,saved);
  const b=record(home,'b',{state:'failed',launchSettled:true,failureCode:'bootstrap_required',error:'缓存的引导要求'});saveManagedRuntime(home,b);
  const adapter=new CodexAdapter(DEFAULT_CONFIG,home);t.after(()=>adapter.close());
  assert.equal(await managedRuntimeState(home,saved),'alive');
  assert.match((await adapter.releaseRuntime([],saved.endpoint))!,/独占性证明/);assert.equal(await ownedProcessState(descendant),'alive');
  saveManagedRuntime(home,{...saved,dedicated:true});
  assert.equal(await adapter.releaseRuntime([],saved.endpoint),undefined);
  assert.equal(await ownedProcessState(wrapper.identity),'dead');assert.equal(await ownedProcessState(descendant),'dead');assert.equal(runtimeFor(home,{peerId:'a'}),undefined);
  await pruneDeadProcessRecords(home);assert.equal(runtimeFor(home,{peerId:'b'})?.value.error,b.error);
});

test('无关原生大帧触及传输保护，保留明确原因且不无限扩大历史响应上限',async t=>{
  const home=temporary(t);await ensureHome(home);
  const { WebSocketServer }=await import('ws');
  const server=new WebSocketServer({host:'127.0.0.1',port:0});await once(server,'listening');
                                           
  t.after(()=>new Promise<void>(resolve=>{for(const client of server.clients)client.terminate();server.close(()=>resolve());}));
  const payload=JSON.stringify({jsonrpc:'2.0',method:'large/fixture',params:{text:'x'.repeat(17*1024*1024)}});
  server.on('connection',socket=>socket.on('message',data=>{const request=JSON.parse(String(data));if(request.method==='initialize')socket.send(JSON.stringify({jsonrpc:'2.0',id:request.id,result:codexInitializeResult}));else socket.send(payload);}));
  const value=record(home,'large-frame',{endpoint:'ws://127.0.0.1:'+(server.address() as net.AddressInfo).port,authenticatedLoopback:true,state:'ready',pid:process.pid,procStart:(await processIdentity(process.pid)).startedAt});
  saveManagedRuntime(home,value);createRuntimeToken(home,value);
  const rpc=await connectAppServer(value.endpoint,DEFAULT_CONFIG,undefined,home);
  const request=rpc.request('thread/read',{threadId:'large',includeTurns:false});await assert.rejects(request,{code:'payload_too_large',uncertain:false});assert.equal(rpc.closed,true);
});
