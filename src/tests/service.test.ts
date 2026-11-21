import test from 'node:test';
import { VERSION } from '../version.js';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { WebSocketServer } from 'ws';
import { brokerCall, ensureBroker, listenBroker } from '../ipc/ipc.js';
import {atomicJson} from '../shared/files.js';
import {CLI_PATH} from '../shared/package-location.js';
import {delay} from '../shared/time.js';
import {ensureHome} from '../ipc/home.js';
import {ipcAddress} from '../shared/local-paths.js';
import net from 'node:net';
import { Store } from '../storage/store.js';
import {DEFAULT_CONFIG} from '../config/defaults.js';
import { temporaryDirectory } from './support/temporary.js';
import { liveProcess, processIdentity } from '../process/process.js';
import { reserveBrokerStartup, type StartupReservation } from '../broker/broker-startup.js';
import { requireIndependentWindows } from './support/windows-job.js';

test('交接关闭校验预约令牌与协调器代次，旧调用不能关闭新协调器',async t=>{
  const temporary=temporaryDirectory(),home=temporary.directory;let lease:StartupReservation|undefined,logs='';
  const child=spawn(process.execPath,['--no-warnings',CLI_PATH,'service'],{env:{...process.env,NXBRIDGE_HOME:home},stdio:['ignore','pipe','pipe'],windowsHide:true}),closed=once(child,'close');
  child.stdout!.resume();child.stderr!.on('data',chunk=>logs+=chunk.toString());
  t.after(async()=>{if(child.exitCode===null&&child.signalCode===null)child.kill();await closed;await lease?.();await temporary.cleanup();});
  let current:{pid:number;runtime?:{generation:string}}|undefined;const deadline=performance.now()+10000;
  while(!current){try{current=await brokerCall('ping',{}, {home,start:false,timeout:500});}catch(error){if(performance.now()>=deadline||child.exitCode!==null)throw Error('隔离协调器未就绪：'+logs,{cause:error});await delay(50);}}
  lease=await reserveBrokerStartup(home,await processIdentity(process.pid));
  await assert.rejects(brokerCall('shutdown',{releaseOwned:false},{home,start:false,mutation:true}),{code:'broker_reservation_lost'});
  await assert.rejects(brokerCall('shutdown',{releaseOwned:false,startupToken:lease.token,expectedBroker:{pid:current.pid,generation:'wrong-generation'}},{home,start:false,mutation:true}),{code:'broker_changed'});
  assert.equal((await brokerCall('ping',{}, {home,start:false})).pid,current.pid);
  await brokerCall('shutdown',{releaseOwned:false,startupToken:lease.token,expectedBroker:{pid:current.pid,generation:current.runtime?.generation}},{home,start:false,mutation:true});
  await within(closed,4000,()=> '交接后隔离协调器未退出');assert.equal(child.exitCode,0,logs);
  const store=new Store(path.join(home,'nxbridge.db'));try{assert.ok(store.events().some(event=>event.type==='shutdown.requested'));assert.equal(JSON.stringify(store.events()).includes(lease.token),false);}finally{store.close();}
});

test('卸载先禁用安装后可越过旧启动预约，启用期间仍必须校验预约',async t=>{
  const temp=temporaryDirectory(),home=temp.directory;let lease:StartupReservation|undefined;
  const child=spawn(process.execPath,['--no-warnings',CLI_PATH,'service'],{env:{...process.env,NXBRIDGE_HOME:home},stdio:'ignore',windowsHide:true}),closed=once(child,'close');
  t.after(async()=>{if(child.exitCode===null&&child.signalCode===null)child.kill();await closed;await lease?.();await temp.cleanup();});
  let identity:{pid:number;runtime?:{generation:string}}|undefined;const end=performance.now()+10000;
  while(!identity){try{identity=await brokerCall('ping',{}, {home,start:false,timeout:500});}catch(error){if(performance.now()>=end)throw error;await delay(50);}}
  lease=await reserveBrokerStartup(home,await processIdentity(process.pid));
  const params={releaseOwned:true,reason:'uninstall',expectedBroker:{pid:identity.pid,generation:identity.runtime?.generation}};
  await assert.rejects(brokerCall('shutdown',params,{home,start:false,mutation:true}),{code:'broker_reservation_lost'});
  atomicJson(path.join(home,'setup-state.json'),{version:1,disabled:true});
  await brokerCall('shutdown',params,{home,start:false,mutation:true});await within(closed,4000,()=> '卸载被旧预约阻塞');assert.equal(child.exitCode,0);
});

test('卸载会拦住已开始但尚未启动服务的旧心跳，显式 service 也不能复活已卸载安装',async t=>{
  const temporary=temporaryDirectory(),home=temporary.directory;t.after(temporary.cleanup);
  const starting=ensureBroker(home);await delay(30);atomicJson(path.join(home,'setup-state.json'),{version:1,disabled:true});
  await assert.rejects(starting,{code:'uninstalled'});
  const child=spawn(process.execPath,['--no-warnings',CLI_PATH,'service'],{env:{...process.env,NXBRIDGE_HOME:home},stdio:['ignore','pipe','pipe'],windowsHide:true});let logs='';child.stderr!.on('data',chunk=>logs+=chunk);
  await within(once(child,'exit'),15000,()=> '被禁用的服务未退出');assert.equal(child.exitCode,0,logs);assert.equal(logs,'');
});

test('多个客户端竞争启动同一协调器时只保留一个实例，正常竞争和 SQLite 提示不写日志',async t=>{
  if(!await requireIndependentWindows(t))return;
  const temporary=temporaryDirectory(),home=temporary.directory;let pid:number|undefined;
  t.after(async()=>{
    if(pid&&liveProcess(pid)){
      await brokerCall('shutdown',{releaseOwned:false},{home,start:false});
      await within((async()=>{while(liveProcess(pid!))await delay(30);})(),4000,()=> '隔离协调器未退出');
    }
    await temporary.cleanup();
  });
  const responses=await Promise.all(Array.from({length:4},()=>brokerCall('ping',{}, {home})));
  pid=responses[0].pid;assert.equal(new Set(responses.map(r=>r.pid)).size,1);
                                  
  await delay(300);
  const log=readFileSync(path.join(home,'run','broker.log'),'utf8');assert.doesNotMatch(log,/EADDRINUSE|already_running|ExperimentalWarning/);
});

test('已有启动预约时等待完整 Windows 启动窗口，不提前报错或重复启动',{skip:process.platform!=='win32'},async t=>{
  const temporary=temporaryDirectory(),home=temporary.directory;
  await ensureHome(home);
  const release=await reserveBrokerStartup(home,await processIdentity(process.pid));
  let timer:NodeJS.Timeout|undefined,starting:ReturnType<typeof listenBroker>|undefined,probes=0;
  t.after(async()=>{clearTimeout(timer);if(starting)await(await starting).close();await release();await temporary.cleanup();});
  const connect=net.createConnection,address=ipcAddress(home);
  t.mock.method(net,'createConnection',(...args:any[])=>{
                                          
    if(args[0]===address&&++probes===2)timer=setTimeout(()=>{
      starting=listenBroker(home,async method=>{assert.equal(method,'ping');return{pid:process.pid};});
    },10000);
    return Reflect.apply(connect,net,args);
  });
  const result=await brokerCall('ping',{}, {home});
  assert.equal(result.pid,process.pid);
  assert.equal(existsSync(path.join(home,'run','launch-broker.json')),false,'竞争者不能启动替代协调器');
});

test('等待其他 Windows 启动者期间卸载仍立即取消，不启动替代协调器',{skip:process.platform!=='win32'},async t=>{
  const temporary=temporaryDirectory(),home=temporary.directory;
  await ensureHome(home);
  const release=await reserveBrokerStartup(home,await processIdentity(process.pid));
  t.after(async()=>{await release();await temporary.cleanup();});
  const connect=net.createConnection,address=ipcAddress(home);let probes=0;
  t.mock.method(net,'createConnection',(...args:any[])=>{
    if(args[0]===address&&++probes===2)atomicJson(path.join(home,'setup-state.json'),{version:1,disabled:true});
    return Reflect.apply(connect,net,args);
  });
  await assert.rejects(brokerCall('ping',{}, {home}),{code:'uninstalled'});
  assert.equal(existsSync(path.join(home,'run','launch-broker.json')),false);
});

test('已存在的协调器首次探测断线后仍被识别，竞争者安静退出',async t=>{
  const temporary=temporaryDirectory(),home=temporary.directory;await ensureHome(home);let connections=0;
  const owner=net.createServer(socket=>{
    socket.on('error',()=>{});if(++connections===1){socket.destroy();return;}
    socket.once('data',raw=>{const request=JSON.parse(raw.toString());socket.end(JSON.stringify({id:request.id,result:{pid:process.pid,version:VERSION}})+'\n');});
  });
  await new Promise<void>(resolve=>owner.listen(ipcAddress(home),resolve));
  t.after(async()=>{await new Promise<void>(resolve=>owner.close(()=>resolve()));await temporary.cleanup();});
  const child=spawn(process.execPath,['--no-warnings',CLI_PATH,'service'],{env:{...process.env,NXBRIDGE_HOME:home},stdio:['ignore','pipe','pipe'],windowsHide:true});let logs='';child.stdout!.on('data',chunk=>logs+=chunk);child.stderr!.on('data',chunk=>logs+=chunk);
  await within(once(child,'exit'),15000,()=> '竞争者未退出');assert.equal(child.exitCode,0,logs);assert.equal(logs,'');assert.ok(connections>=2);
});

async function within<T>(promise: Promise<T>, timeout: number, message: () => string): Promise<T> {
  let timer: NodeJS.Timeout;
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(Error(message())), timeout);
    })]);
  } finally { clearTimeout(timer!); }
}

for (const scenario of ['正常', '无关闭回执', '启动尚未完成'] as const) {
  test(`协调器关闭${scenario}的 App Server 连接后退出，保留配对和宿主`, async t => {
    const temporary = temporaryDirectory(), home = temporary.directory;
    const host = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', windowsHide: true });
    const hostExit = once(host, 'exit');
    const appServer = new WebSocketServer({ host: '127.0.0.1', port: 0 });
    let service: ReturnType<typeof spawn> | undefined, serviceExit: Promise<unknown> | undefined, logs = '';
    let finishStartup: (() => void) | undefined;
    const methods: string[] = [];
    t.after(async () => {
      if (service && service.exitCode === null && service.signalCode === null) service.kill();
      if (serviceExit) await within(serviceExit, 3000, () => '隔离协调器清理超时');
      for (const socket of appServer.clients) socket.terminate();
      await new Promise<void>(resolve => appServer.close(() => resolve()));
      if (host.exitCode === null && host.signalCode === null) host.kill();
      await hostExit;
      await temporary.cleanup();
    });
    await once(appServer, 'listening');
    const endpoint = `ws://127.0.0.1:${(appServer.address() as { port: number }).port}`;
    appServer.on('connection', socket => {
      socket.on('error', () => {});
      socket.on('message', raw => {
        const request = JSON.parse(raw.toString());
        methods.push(request.method);
        if (request.id === undefined) return;
        const result = request.method === 'initialize' ? {userAgent:'codex-tui/0.166.0 (test; test) test (codex-tui; 0.166.0)'} : request.method === 'thread/loaded/list' ? { data: ['codex-fixture'] }
          : request.method === 'thread/read' ? { thread: { id: 'codex-fixture', cwd: home, status: { type: 'idle' } } } : {};
        const respond = () => { socket.send(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }), () => {}); };
        if (scenario === '启动尚未完成' && request.method === 'thread/read') { finishStartup = respond; return; }
        respond();
                                           
        if (scenario === '无关闭回执' && request.method === 'thread/read') socket.pause();
      });
    });
    writeFileSync(path.join(home, 'config.json'), JSON.stringify({ ...DEFAULT_CONFIG, implicit: 'never', codexBinary: process.execPath, claudeBinary: process.execPath }), 'utf8');
    const store = new Store(path.join(home, 'nxbridge.db'));
    const codex = store.register({ host: 'codex', sessionId: 'codex-fixture', cwd: home, kind: 'root', endpoint: { mode: 'app-server', address: endpoint, epoch: endpoint, pid: null, procStart: null } });
    const claude = store.register({ host: 'claude', sessionId: 'claude-fixture', cwd: home, kind: 'root', endpoint: { mode: 'claude-inbox', address: 'fixture-inbox', epoch: 'fixture', pid: host.pid!, procStart: 'fixture' } });
    store.updatePeer(codex.id, { owner: 'nxbridge' });
    store.updatePeer(claude.id, { owner: 'nxbridge' });
    const pair = store.pair(claude.id, codex.id);
    store.close();
    service = spawn(process.execPath, [CLI_PATH, 'service'], {
      env: { ...process.env, NXBRIDGE_HOME: home, CODEX_HOME: path.join(home, 'codex'), CLAUDE_CONFIG_DIR: path.join(home, 'claude') },
      stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
    });
    service.stderr!.on('data', chunk => { logs += chunk.toString(); });
    service.stdout!.resume();
    serviceExit = once(service, 'exit');
    const deadline = Date.now() + 10000;
    for (;;) {
      if (Date.now() > deadline) throw Error(`隔离协调器未完成宿主连接\n${logs}`);
      try {
        await brokerCall('ping', {}, { home, start: false, timeout: 200 });
        if (methods.includes('thread/read')) break;
        await delay(30);
      }
      catch (error) { if (Date.now() > deadline || service.exitCode !== null) throw Error(`隔离协调器启动失败：${error}\n${logs}`); await delay(30); }
    }
    assert.ok(methods.includes('thread/read'), '协调器必须先实际连接宿主');
    const stopping = brokerCall('shutdown', { releaseOwned: false }, { home, start: false, mutation: true });
    if (scenario === '启动尚未完成') { await delay(100); finishStartup!(); }
    const shutdown = await stopping;
    assert.deepEqual(shutdown, { stopping: true, notes: [] });
    await within(serviceExit, 4000, () => `shutdown 返回后协调器仍未退出\n${logs}`);
    assert.equal(service.exitCode, 0);
    assert.equal(host.exitCode, null, '不能停止宿主进程');
    assert.equal(host.signalCode, null);
    assert.equal(appServer.address() !== null, true, 'App Server 必须继续监听');
    assert.equal(methods.includes('thread/unsubscribe'), false, '不能卸载宿主线程');
    const persisted = new Store(path.join(home, 'nxbridge.db'));
    try {
      assert.deepEqual(persisted.currentPair(), pair);
      assert.equal(persisted.peer(codex.id).sessionId, codex.sessionId);
      assert.equal(persisted.peer(claude.id).sessionId, claude.sessionId);
      assert.equal(persisted.endpoints(codex.id)[0]!.address, endpoint);
    } finally { persisted.close(); }
  });
}
