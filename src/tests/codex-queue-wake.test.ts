import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { DEFAULT_CONFIG } from '../config/defaults.js';
import { queueCodexWake } from '../hosts/codex/queue-wake.js';
import { saveUserProfile } from '../hosts/launch-profiles.js';
import { createRuntimeToken, saveManagedRuntime, type ManagedRuntime } from '../hosts/managed-runtimes.js';
import { managedMarker } from '../install/installation.js';
import { BridgeError } from '../shared/errors.js';
import { HEALTH_WAKE_NOTICE, type Endpoint, type Peer } from '../types.js';
import { temporary } from './support/temporary.js';

function fixture(t:TestContext,address='ws://127.0.0.1:48195'){
  const home=temporary(t),configHome=path.join(home,'original'),image=path.join(home,process.platform==='win32'?'codex.exe':'codex');
  mkdirSync(configHome);writeFileSync(image,'隔离验收入口');
  const peer:Peer={id:'parent',host:'codex',kind:'root',owner:'nxbridge',state:'ready',sessionId:randomUUID(),cwd:home,name:'父会话',parentId:null,permission:'prompting',updatedAt:0};
  const endpoint:Endpoint={peerId:peer.id,epoch:'epoch',bindingEpoch:'binding',mode:'app-server',address,pid:901,procStart:'original',configHome,active:true,seenAt:0};
  const runtime:ManagedRuntime={id:randomUUID(),owner:managedMarker(home),kind:'owned',state:'ready',endpoint:address,configHome,pid:endpoint.pid!,procStart:endpoint.procStart!,peerId:peer.id,dedicated:true,createdAt:0,authenticatedLoopback:address.startsWith('ws:')};
  saveManagedRuntime(home,runtime);endpoint.runtimeId=runtime.id;
  const token=runtime.authenticatedLoopback?readFileSync(createRuntimeToken(home,runtime),'utf8'):undefined;
  const native={pid:endpoint.pid!,parentPid:1,name:'codex',image,startedAt:endpoint.procStart!};
  const io:NonNullable<Parameters<typeof queueCodexWake>[6]>={
    identity:async()=>native,
    dedicated:async(value:string)=>{assert.equal(value,address);},
    daemon:async()=>true,
    unixSocket:async()=>({requested:address.slice(7),resolved:address.slice(7),kind:'direct' as const,pid:native.pid,generation:native.startedAt}),
    run:async()=>{throw new Error('未指定原生命令结果');}
  };
  return{home,peer,endpoint,runtime,token,image,native,io};
}

test('Codex 队列固定原配置与精确认证端点，命令参数不含凭证或继续原会话选项',async t=>{
  const f=fixture(t),order:string[]=[],profileId=randomUUID();
  saveUserProfile(f.home,{id:profileId,host:'codex',exe:f.image,version:'0.171.0',configHome:f.endpoint.configHome!,cwd:f.peer.cwd,env:{QUEUE_PROFILE_FIXTURE:'原会话'},sourceSession:f.peer.sessionId!,sourcePid:f.native.pid,sourceGeneration:f.native.startedAt,capturedAt:0,dropped:[]});
  let childEnv:NodeJS.ProcessEnv|undefined;
  f.io.run=async(host,args,options)=>{
    assert.equal(host,'codex');
    assert.deepEqual(args,['queue','--thread',f.peer.sessionId,'--message',HEALTH_WAKE_NOTICE,'--remote',f.endpoint.address,'--remote-auth-token-env','NXBRIDGE_CODEX_REMOTE_TOKEN']);
    assert.deepEqual(options?.launch?.executable,{command:f.image,prefix:[]});
    assert.equal(options?.launch?.profile?.id,profileId);
    assert.equal(options?.cwd,f.peer.cwd);
    assert.equal(options?.env?.CODEX_HOME,f.endpoint.configHome);
    assert.equal(options?.env?.QUEUE_PROFILE_FIXTURE,'原会话');
    assert.equal(options?.env?.NXBRIDGE_CODEX_REMOTE_TOKEN,undefined);
    await options?.beforeSpawn?.();
    assert.equal(options?.env?.NXBRIDGE_CODEX_REMOTE_TOKEN,f.token);
    childEnv=options?.env;
    options?.onSpawn?.();
    return 'Queued message native-1 for thread '+f.peer.sessionId+'.\n';
  };
  await queueCodexWake(f.home,{...DEFAULT_CONFIG,codexHome:path.join(f.home,'other'),codexCommand:['错误入口']},f.peer,f.endpoint,()=>{order.push('核验');},()=>{order.push('已启动');},f.io);
  assert.deepEqual(order,['核验','已启动']);
  assert.equal(childEnv?.NXBRIDGE_CODEX_REMOTE_TOKEN,undefined);
});

test('Codex 入队等待控制命令期间的代次、端点、授权变化均阻止启动',async t=>{
  const f=fixture(t),denied=new BridgeError('session_changed','配对已改变');
  let scope:'generation'|'endpoint'|'consent'='generation';
  f.io.run=async(_host,_args,options)=>{
    if(scope==='generation')f.native.startedAt='replacement';
    if(scope==='endpoint')saveManagedRuntime(f.home,{...f.runtime,procStart:'replacement'});
    await options?.beforeSpawn?.();
    return assert.fail('端点或授权变化后不得发送');
  };
  const send=()=>queueCodexWake(f.home,DEFAULT_CONFIG,f.peer,f.endpoint,()=>{throw denied;},()=>{assert.fail('不得启动队列命令');},f.io);
  await assert.rejects(send(),{code:'queue_route_unverified'});
  f.native.startedAt='original';scope='endpoint';
  await assert.rejects(send(),{code:'queue_route_unverified'});
  saveManagedRuntime(f.home,f.runtime);scope='consent';
  await assert.rejects(send(),error=>error===denied);
  await assert.rejects(queueCodexWake(f.home,DEFAULT_CONFIG,f.peer,f.endpoint,()=>{saveManagedRuntime(f.home,{...f.runtime,pid:f.native.pid+1});},()=>{assert.fail('不得使用替换后的端点凭证');},f.io),{code:'queue_route_unverified'});
  const unix=fixture(t,'unix://'+path.join(f.home,'private.sock'));
  unix.io.run=async(_host,_args,options)=>{
    await options?.beforeSpawn?.();
    return assert.fail('专用 socket 登记改变后不得发送');
  };
  await assert.rejects(queueCodexWake(unix.home,DEFAULT_CONFIG,unix.peer,unix.endpoint,()=>{saveManagedRuntime(unix.home,{...unix.runtime,pid:unix.native.pid+1});},()=>{assert.fail('不得启动队列命令');},unix.io),{code:'queue_route_unverified'});
});

test('共享 daemon 入队使用已登记的 Unix socket，拒绝其他地址或命名会话',async t=>{
  const home=temporary(t),address='unix://'+path.join(home,'daemon.sock'),f=fixture(t,address);
  const endpoint={...f.endpoint,mode:'embedded' as const,daemon:{address}};
  const pidFile=path.join(endpoint.configHome!,'app-server-daemon','daemon.pid');
  mkdirSync(path.join(endpoint.configHome!,'app-server-daemon'));
  writeFileSync(pidFile,JSON.stringify({pid:endpoint.pid}));
  f.io.run=async(_host,args,options)=>{
    if(args[0]==='app-server')return JSON.stringify({status:'running',socketPath:address.slice(7)});
    assert.deepEqual(args,['queue','--thread',f.peer.sessionId,'--message',HEALTH_WAKE_NOTICE,'--remote',address]);
    await options?.beforeSpawn?.();options?.onSpawn?.();
    return 'Queued message native-1 for thread '+f.peer.sessionId+'.';
  };
  await queueCodexWake(f.home,DEFAULT_CONFIG,f.peer,endpoint,()=>{},()=>{},f.io);
  await assert.rejects(queueCodexWake(f.home,DEFAULT_CONFIG,{...f.peer,sessionId:'历史名称'},endpoint,()=>{},()=>{},f.io),{code:'queue_route_unverified'});
  await assert.rejects(queueCodexWake(f.home,DEFAULT_CONFIG,f.peer,{...endpoint,address:'wss://other.invalid'},()=>{},()=>{},f.io),{code:'queue_route_unverified'});
  await assert.rejects(queueCodexWake(f.home,DEFAULT_CONFIG,f.peer,endpoint,()=>{writeFileSync(pidFile,JSON.stringify({pid:f.native.pid+1}));},()=>{assert.fail('不得启动队列命令');},f.io),{code:'queue_route_unverified'});
});

test('Codex 入队丢失启动回执、命令超时或返回其他会话时均保留不确定性',async t=>{
  const f=fixture(t),timeout=new Error('模拟进程回执超时');
  for(const scenario of ['missing-spawn','timeout','wrong-thread']){
    let calls=0,spawns=0;
    f.io.run=async(_host,_args,options)=>{
      calls++;await options?.beforeSpawn?.();
      if(scenario!=='missing-spawn')options?.onSpawn?.();
      if(scenario!=='wrong-thread')throw timeout;
      return 'Queued message native-1 for thread '+randomUUID()+'.';
    };
    await assert.rejects(queueCodexWake(f.home,DEFAULT_CONFIG,f.peer,f.endpoint,()=>{},()=>{spawns++;},f.io),error=>{
      assert.match(String(error),/提交结果未知/);
      assert.equal((error as {uncertain?:boolean}).uncertain,true);
      if(scenario!=='wrong-thread')assert.equal((error as Error).cause,timeout);
      return true;
    });
    assert.equal(calls,1);assert.equal(spawns,scenario==='missing-spawn'?0:1);
  }
});
