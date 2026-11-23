import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { DEFAULT_CONFIG } from '../config/defaults.js';
import { queueCodexWake, windowsQueueSocketVacant, type CodexQueueOptions, type CodexQueueParams } from '../hosts/codex/queue-wake.js';
import { selectHostLaunch } from '../hosts/host-launch.js';
import { saveUserProfile } from '../hosts/launch-profiles.js';
import { saveManagedRuntime, type ManagedRuntime } from '../hosts/managed-runtimes.js';
import { managedMarker } from '../install/installation.js';
import { RpcClient, type RpcMessage } from '../ipc/rpc.js';
import { BridgeError, DeliveryError } from '../shared/errors.js';
import { HEALTH_WAKE_NOTICE, WAKE_NOTICE, type Endpoint, type Peer } from '../types.js';
import { temporary } from './support/temporary.js';

const clientUserMessageId='bridge-reserved-client-id';
const confirmation=(params:CodexQueueParams)=>({queuedSubmission:{id:'native-queue-id',clientUserMessageId:params.clientUserMessageId}});
const options:CodexQueueOptions={clientUserMessageId,message:HEALTH_WAKE_NOTICE,beforeSubmit:()=>{}};

function fixture(t:TestContext,address='ws://127.0.0.1:48195'){
  const home=temporary(t),configHome=path.join(home,'original'),image=path.join(home,process.platform==='win32'?'codex.exe':'codex');
  mkdirSync(configHome);writeFileSync(image,'隔离验收入口');
  const peer:Peer={id:'parent',host:'codex',kind:'root',owner:'nxbridge',state:'ready',sessionId:randomUUID(),cwd:home,name:'父会话',parentId:null,permission:'prompting',updatedAt:0};
  const endpoint:Endpoint={peerId:peer.id,epoch:'epoch',bindingEpoch:'binding',mode:'app-server',address,pid:901,procStart:'original',configHome,active:true,seenAt:0};
  const runtime:ManagedRuntime={id:randomUUID(),owner:managedMarker(home),kind:'owned',state:'ready',endpoint:address,configHome,pid:endpoint.pid!,procStart:endpoint.procStart!,peerId:peer.id,dedicated:true,createdAt:0,authenticatedLoopback:address.startsWith('ws:')};
  saveManagedRuntime(home,runtime);endpoint.runtimeId=runtime.id;
  const native={pid:endpoint.pid!,parentPid:1,name:'codex',image,startedAt:endpoint.procStart!};
  const io:NonNullable<Parameters<typeof queueCodexWake>[5]>={
    identity:async()=>native,
    dedicated:async(value:string)=>{assert.equal(value,address);},
    daemon:async()=>true,
    unixSocket:async()=>({requested:address.slice(7),resolved:address.slice(7),kind:'direct' as const,pid:native.pid,generation:native.startedAt}),
    live:()=>false,socketVacant:async()=>true,
    control:async()=>assert.fail('共享路由不能启动控制进程'),
    run:async()=>assert.fail('不得退回命令行入队'),
  };
  const request=(requestRemote:NonNullable<CodexQueueOptions['requestRemote']>,beforeSubmit=options.beforeSubmit,target=endpoint)=>
    queueCodexWake(home,DEFAULT_CONFIG,peer,target,{...options,requestRemote,beforeSubmit},io);
  return{home,peer,endpoint,runtime,configHome,image,native,io,request};
}

test('专用 Codex 入队使用已核验的原端点，回执绑定桥接提交编号',async t=>{
  const f=fixture(t),order:string[]=[];
  f.io.dedicated=async address=>{assert.equal(address,f.endpoint.address);order.push('原生路由');};
  const result=await f.request(async(params,authorize)=>{
    order.push('原有连接');
    await authorize();order.push('提交');
    assert.deepEqual(params,{threadId:f.peer.sessionId,input:[{type:'text',text:HEALTH_WAKE_NOTICE}],clientUserMessageId});
    return confirmation(params);
  },()=>{order.push('当前授权');});
  assert.deepEqual(result,{id:'native-queue-id',clientUserMessageId});
  assert.deepEqual(order,['原生路由','原有连接','当前授权','提交']);
  const changed={...f.runtime,authenticatedLoopback:false};
  saveManagedRuntime(f.home,changed);
  await assert.rejects(f.request(async()=>assert.fail('未经认证的回环连接不得提交')),{code:'queue_route_unverified'});
});

test('等待原连接期间的代次、端点及授权变化均阻止入队',async t=>{
  const f=fixture(t),denied=new BridgeError('session_changed','配对已改变');
  await assert.rejects(f.request(async(_params,authorize)=>{
    f.native.startedAt='replacement';await authorize();assert.fail('代次更新后不得写入');
  }),{code:'queue_route_unverified'});
  f.native.startedAt='original';
  await assert.rejects(f.request(async(_params,authorize)=>{
    saveManagedRuntime(f.home,{...f.runtime,procStart:'replacement'});await authorize();assert.fail('路由更新后不得写入');
  }),{code:'queue_route_unverified'});
  saveManagedRuntime(f.home,f.runtime);
  const submit=async(_params:CodexQueueParams,authorize:()=>Promise<void>)=>{await authorize();assert.fail('授权更新后不得写入');};
  await assert.rejects(f.request(submit,()=>{throw denied;}),error=>error===denied);
  await assert.rejects(f.request(submit,()=>{saveManagedRuntime(f.home,{...f.runtime,pid:f.native.pid+1});}),{code:'queue_route_unverified'});
});

test('共享 daemon 必须使用已登记的控制 socket 及精确线程编号',async t=>{
  const home=temporary(t),address='unix://'+path.join(home,'daemon.sock'),f=fixture(t,address);
  const endpoint={...f.endpoint,mode:'embedded' as const,daemon:{address}};
  const pidFile=path.join(f.configHome,'app-server-daemon','daemon.pid');
  mkdirSync(path.dirname(pidFile));writeFileSync(pidFile,JSON.stringify({pid:endpoint.pid}),'utf8');
  f.io.run=async(_host,args,settings)=>{
    assert.deepEqual(args,['app-server','daemon','version']);
    assert.equal(settings?.launch?.executable.command,f.image);
    return JSON.stringify({status:'running',socketPath:address.slice(7)});
  };
  const send=async(params:CodexQueueParams,authorize:()=>Promise<void>)=>{await authorize();return confirmation(params);};
  await f.request(send,undefined,endpoint);
  await assert.rejects(queueCodexWake(f.home,DEFAULT_CONFIG,{...f.peer,sessionId:'历史名称'},endpoint,{...options,requestRemote:send},f.io),{code:'queue_route_unverified'});
  await assert.rejects(f.request(send,undefined,{...endpoint,address:'wss://other.invalid'}),{code:'queue_route_unverified'});
  await assert.rejects(f.request(send,()=>{writeFileSync(pidFile,JSON.stringify({pid:f.native.pid+1}),'utf8');},endpoint),{code:'queue_route_unverified'});
});

test('嵌入式入队仅调用原生队列接口，复用原启动记录并回收控制进程',async t=>{
  const f=fixture(t),profileId=randomUUID(),wire:RpcMessage[]=[],order:string[]=[];
  const endpoint:Endpoint={...f.endpoint,mode:'embedded',address:'',runtimeId:undefined},peer:Peer={...f.peer,owner:'user'};
  saveUserProfile(f.home,{id:profileId,host:'codex',exe:f.image,version:'0.170.0',configHome:f.configHome,cwd:peer.cwd,env:{QUEUE_PROFILE_FIXTURE:'原会话',NXBRIDGE_CODEX_REMOTE_TOKEN:'不应传递'},sourceSession:peer.sessionId!,sourcePid:f.native.pid,sourceGeneration:f.native.startedAt,capturedAt:0,dropped:[]});
  f.io.socketVacant=async socket=>{
    assert.equal(socket,path.join(f.configHome,'app-server-control','app-server-control.sock'));order.push('无冲突');return true;
  };
  f.io.control=async(_config,home,launch)=>{
    assert.equal(home,f.home);
    assert.deepEqual(launch?.executable,{command:f.image,prefix:[]});
    assert.equal(launch?.profile?.id,profileId);
    assert.equal(launch?.cwd,peer.cwd);
    assert.equal(launch?.env.CODEX_HOME,f.configHome);
    assert.equal(launch?.env.QUEUE_PROFILE_FIXTURE,'原会话');
    assert.equal(launch?.env.NXBRIDGE_CODEX_REMOTE_TOKEN,undefined);
    order.push('隔离控制');
    const rpc=new RpcClient(message=>{wire.push(message);order.push('入队');rpc.receive({id:message.id,result:confirmation(message.params)});},()=>{order.push('关闭');});
    return rpc;
  };
  const receipt=await queueCodexWake(f.home,{...DEFAULT_CONFIG,codexHome:path.join(f.home,'other'),codexCommand:['错误入口']},peer,endpoint,
    {...options,message:WAKE_NOTICE,beforeSubmit:()=>{order.push('当前授权');}},f.io);
  assert.equal(receipt.clientUserMessageId,clientUserMessageId);
  assert.deepEqual(wire.map(({method,params})=>({method,params})),[{method:'thread/queue/add',params:{threadId:peer.sessionId,input:[{type:'text',text:WAKE_NOTICE}],clientUserMessageId}}]);
  assert.deepEqual(order,['无冲突','隔离控制','无冲突','当前授权','入队','关闭']);
});

test('嵌入式入队在启动及提交前排除共享 daemon，碰撞后回收控制进程',async t=>{
  const f=fixture(t),endpoint:Endpoint={...f.endpoint,mode:'embedded',address:'',runtimeId:undefined};
  let vacant=false,closed=0;
  f.io.socketVacant=async()=>vacant;
  await assert.rejects(queueCodexWake(f.home,DEFAULT_CONFIG,f.peer,endpoint,options,f.io),{code:'queue_daemon_collision'});
  vacant=true;
  f.io.control=async()=>new RpcClient(()=>assert.fail('共享 daemon 就绪后不得写入'),()=>{closed++;});
  const state=path.join(f.configHome,'app-server-daemon');
  await assert.rejects(queueCodexWake(f.home,DEFAULT_CONFIG,f.peer,endpoint,{...options,beforeSubmit:()=>{
    mkdirSync(state);writeFileSync(path.join(state,'app-server.pid'),JSON.stringify({pid:701}),'utf8');f.io.live=pid=>pid===701;
  }},f.io),{code:'queue_daemon_collision'});
  assert.equal(closed,1);
});

test('Windows 控制 socket 只在精确原生连接拒绝时视为已失效',async t=>{
  const f=fixture(t),socket=path.join(f.home,'control.sock');
  const launch=selectHostLaunch('codex',DEFAULT_CONFIG,{home:f.home,configHome:f.configHome,executable:f.image,cwd:f.peer.cwd,unobserved:true});
  assert.equal(await windowsQueueSocketVacant(socket,launch,f.home,async()=>assert.fail('无 socket 时无需启动探测')),true);
  writeFileSync(socket,'隔离探测占位');
  assert.equal(await windowsQueueSocketVacant(socket,launch,f.home,async()=>({stdout:'',stderr:''})),false);
  const rejected=(target:string,number:number)=>'Error: failed to connect to socket at '+target+'\r\n\r\nCaused by:\r\n    本地化的原生错误 (os error '+number+')\r\n';
  const response=async(stderr:string,extra:object={})=>windowsQueueSocketVacant(socket,launch,f.home,async(command,args,settings)=>{
    assert.equal(command,f.image);
    assert.deepEqual(args,['app-server','proxy','--sock',socket]);
    assert.equal(settings.cwd,f.peer.cwd);
    assert.equal(settings.env?.CODEX_HOME,f.configHome);
    throw Object.assign(new Error('探测结果'),{code:1,stderr,...extra});
  });
  assert.equal(await response(rejected(socket,10061)),true);
  assert.equal(await response('WARNING: proceeding, even though we could not create PATH aliases\n'+rejected(socket,10061)),true);
  assert.equal(await response(rejected(socket,5)),false);
  assert.equal(await response(rejected(socket+'.other',10061)),false);
  assert.equal(await response(rejected(socket,10061),{killed:true}),false);
  assert.equal(await response('Error: unexpected argument app-server'),false);
});

test('入队明确拒绝与未知回执分开，任一情况均不重投',async t=>{
  const f=fixture(t),missing=new DeliveryError('-32601','原生接口不可用'),timeout=new DeliveryError('timeout','原生回执超时',true);
  for(const scenario of ['unsupported','timeout','wrong-id','no-id']){
    let calls=0;
    await assert.rejects(f.request(async(params,authorize)=>{
      await authorize();calls++;
      if(scenario==='unsupported')throw missing;
      if(scenario==='timeout')throw timeout;
      const ack=confirmation(params);
      if(scenario==='wrong-id')ack.queuedSubmission.clientUserMessageId='other';
      else ack.queuedSubmission.id='';
      return ack;
    }),error=>{
      if(scenario==='unsupported')return error===missing;
      assert.equal((error as DeliveryError).code,'queue_result_unknown');
      assert.equal((error as DeliveryError).uncertain,true);
      if(scenario==='timeout')assert.equal((error as Error).cause,timeout);
      return true;
    });
    assert.equal(calls,1);
  }
});
