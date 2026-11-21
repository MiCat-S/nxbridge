import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import net from 'node:net';
import {mkdirSync,writeFileSync,lstatSync} from 'node:fs';
import {randomUUID,randomBytes} from 'node:crypto';
import { temporaryDirectory } from '../tests/support/temporary.js';
import {ensureHome,socketDirectory,removeOwnedSocket} from '../ipc/home.js';
import {delay} from '../shared/time.js';
import {DEFAULT_CONFIG} from '../config/defaults.js';
import {selectHostLaunch,spawnSelectedHost} from '../hosts/host-launch.js';
import {rememberOwnedHost,releaseRecordedProcesses,rememberOwnedDescendants,ownedProcesses} from '../process/owned-processes.js';
import {nativeDescendant,processIdentity} from '../process/process.js';
import {connectAppServer} from '../hosts/codex/adapter.js';
import {verifyDedicatedCodex} from '../hosts/codex/codex-isolation.js';
import {ownedProcessState} from '../process/process-stop.js';

test('原生隔离选项探针：仅进程参数，不改用户配置，不运行模型',{timeout:90000},async t=>{
  const temp=temporaryDirectory(),root=temp.directory,home=path.join(root,'bridge'),configHome=path.join(root,'codex');await ensureHome(home);mkdirSync(configHome);
  writeFileSync(path.join(configHome,'config.toml'),'check_for_update_on_startup=false\n[features]\napps=false\nremote_plugin=false\ncode_mode=false\n','utf8');
  const config={...DEFAULT_CONFIG,codexHome:configHome,...(process.env.NXBRIDGE_TEST_CODEX_BINARY?{codexBinary:process.env.NXBRIDGE_TEST_CODEX_BINARY}:{})},launch=selectHostLaunch('codex',config,{home,cwd:root}),results:any[]=[];
  const nativeTree=new Map<string,Awaited<ReturnType<typeof processIdentity>>>(),sockets:string[]=[];
  const treeState=()=>Promise.all([...nativeTree.values()].map(async identity=>({pid:identity.pid,procStart:identity.startedAt,name:identity.name,state:await ownedProcessState(identity)})));
  t.after(async()=>{const proof=await treeState();t.diagnostic(JSON.stringify({preStopNativeTree:proof}));assert.deepEqual(proof.filter(identity=>identity.state!=='dead'),[],'停止前登记的原生后代必须全部退出');for(const socket of sockets)await removeOwnedSocket(home,socket);await rememberOwnedDescendants(home,await processIdentity(process.pid),randomUUID());await temp.cleanup();});
  for(const mode of ['config','feature','tcp'] as const){
    const port=mode==='tcp'?await new Promise<number>(resolve=>{const server=net.createServer();server.listen(0,'127.0.0.1',()=>{const port=(server.address() as net.AddressInfo).port;server.close(()=>resolve(port));});}):undefined;
    const address=port?'ws://127.0.0.1:'+port:'unix://'+path.join(await socketDirectory(home),mode+'.sock'),launchId=randomUUID();
    const args=['--no-daemon',...(mode==='config'?['-c','features.daemon_auto_start=false']:mode==='feature'?['--disable','daemon_auto_start']:[]),'app-server','--listen',address];
    if(!port)sockets.push(address);
    const at=Date.now(),child=spawnSelectedHost(launch,args,{stdio:'ignore'});await rememberOwnedHost(home,child,'codex','codex-runtime',launchId,configHome);
    let client:Awaited<ReturnType<typeof connectAppServer>>|undefined;
    try{
      const end=Date.now()+12000;
      while(!client){try{client=await connectAppServer(address,config,undefined,home,{readOnly:true});}catch(error){if(child.exitCode!==null||Date.now()>end)throw error;await delay(50);}}
      const native=await nativeDescendant(child.pid!,'codex',at,address),alias=!port&&process.platform!=='win32'&&lstatSync(address.slice(7)).isSymbolicLink();let dedicated=false,reason;
      await verifyDedicatedCodex(address,native);dedicated=true;
      assert.deepEqual((await client.request('thread/loaded/list',{})).data,[]);
      await rememberOwnedDescendants(home,await processIdentity(child.pid!),launchId);
      results.push({mode,address,alias,dedicated,reason});
    }finally{for(const record of ownedProcesses(home).records.filter(value=>value.proof.launchId===launchId))nativeTree.set(record.identity.pid+':'+record.identity.startedAt,record.identity);client?.close();assert.deepEqual(await releaseRecordedProcesses(home,record=>record.proof.launchId===launchId),[]);}
  }
  t.diagnostic(JSON.stringify({results,realModelCalls:0}));
});

test('认证本地 WebSocket 与同 home 共享后台的线程和停止生命周期相互隔离；无模型调用',{timeout:60000},async t=>{
  const temp=temporaryDirectory(),root=temp.directory,home=path.join(root,'bridge'),configHome=path.join(root,'codex');await ensureHome(home);mkdirSync(configHome);
  writeFileSync(path.join(configHome,'config.toml'),'check_for_update_on_startup=false\n[features]\napps=false\nremote_plugin=false\ncode_mode=false\n','utf8');
  const config={...DEFAULT_CONFIG,codexHome:configHome,...(process.env.NXBRIDGE_TEST_CODEX_BINARY?{codexBinary:process.env.NXBRIDGE_TEST_CODEX_BINARY}:{})},launch=selectHostLaunch('codex',config,{home,cwd:root}),clients:Awaited<ReturnType<typeof connectAppServer>>[]=[];
  const ended:Promise<void>[]=[];
  t.after(async()=>{
    for(const client of clients)client.close();
    await rememberOwnedDescendants(home,await processIdentity(process.pid),randomUUID());
    assert.deepEqual(await releaseRecordedProcesses(home,()=>true),[]);await Promise.all(ended);await removeOwnedSocket(home,sharedAddress);
    try{await temp.cleanup();}catch(error){t.diagnostic(JSON.stringify({cwd:process.cwd(),records:ownedProcesses(home)}));throw error;}
  });
  const sharedAddress='unix://'+path.join(await socketDirectory(home),'shared.sock'),privateId=randomUUID(),token=randomBytes(32).toString('hex'),tokenFile=path.join(root,'token');
  writeFileSync(tokenFile,token,{encoding:'utf8',mode:0o600});
  const port=await new Promise<number>(resolve=>{const server=net.createServer();server.listen(0,'127.0.0.1',()=>{const port=(server.address() as net.AddressInfo).port;server.close(()=>resolve(port));});}),privateAddress='ws://127.0.0.1:'+port;
  for(const [address,id]of [[sharedAddress,randomUUID()],[privateAddress,privateId]]){
    const child=spawnSelectedHost(launch,['--no-daemon','app-server','--listen',address!,...(id===privateId?['--ws-auth','capability-token','--ws-token-file',tokenFile]:[])],{stdio:'ignore'});
    ended.push(new Promise(resolve=>child.once('close',()=>resolve())));
    await rememberOwnedHost(home,child,'codex','codex-runtime',id!,configHome);
    const end=Date.now()+12000;let client;
    while(!client){try{client=await connectAppServer(address!,config,id===privateId?token:undefined,home,{readOnly:true});}catch(error){if(child.exitCode!==null||Date.now()>end)throw error;await delay(50);}}
    clients.push(client);
    await rememberOwnedDescendants(home,await processIdentity(child.pid!),id!);
  }
  await assert.rejects(connectAppServer(privateAddress,config,undefined,home,{readOnly:true}));
  const shared=clients[0]!,privateClient=clients[1]!,sharedThread=(await shared.request('thread/start',{cwd:root,approvalPolicy:'never',sandbox:'read-only'})).thread.id,privateThread=(await privateClient.request('thread/start',{cwd:root,approvalPolicy:'never',sandbox:'read-only'})).thread.id;
  const loaded=async(client:typeof shared)=>(await client.request('thread/loaded/list',{})).data;
  assert.ok((await loaded(shared)).includes(sharedThread));assert.equal((await loaded(privateClient)).includes(sharedThread),false);
  assert.ok((await loaded(privateClient)).includes(privateThread));assert.equal((await loaded(shared)).includes(privateThread),false);
  privateClient.close();assert.deepEqual(await releaseRecordedProcesses(home,record=>record.proof.launchId===privateId),[]);
  assert.ok((await loaded(shared)).includes(sharedThread));
  await shared.request('thread/unsubscribe',{threadId:sharedThread});
  t.diagnostic(JSON.stringify({authenticated:true,unauthenticatedRefused:true,independentLoadedThreads:true,privateStopPreservesShared:true,realModelCalls:0}));
});
