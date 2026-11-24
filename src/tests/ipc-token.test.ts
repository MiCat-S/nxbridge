import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {readFileSync,statSync,writeFileSync} from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import test,{type TestContext} from 'node:test';
import {reserveBrokerStartup} from '../broker/broker-startup.js';
import {ensureHome} from '../ipc/home.js';
import {connectBroker,ensureBroker,listenBroker} from '../ipc/ipc.js';
import {repairIpcToken} from '../ipc/token-repair.js';
import {rememberOwnedChild} from '../process/owned-processes.js';
import {processIdentity} from '../process/process.js';
import {ipcAddress} from '../shared/local-paths.js';
import {temporary} from './support/temporary.js';

test('并行初始化与重复使用共享同一个完整的私有 IPC 令牌',async t=>{
  const home=temporary(t),file=path.join(home,'run','token');
  await Promise.all([ensureHome(home),ensureHome(home)]);
  const token=readFileSync(file,'utf8');
  assert.match(token,/^[a-f0-9]{64}$/);
  if(process.platform!=='win32')assert.equal(statSync(file).mode&0o777,0o600);
  const server=await listenBroker(home,async()=>({ready:true}));
  try{
    await ensureHome(home);
    assert.equal(readFileSync(file,'utf8'),token);
    const client=await connectBroker(home);
    try{assert.deepEqual(await client.request('ping'),{ready:true});}finally{client.close();}
  }finally{await server.close();}
});

test('损坏的旧 IPC 令牌阻止启动和连接，原文件保留',async t=>{
  const home=temporary(t),file=path.join(home,'run','token');
  await ensureHome(home);
  for(const content of [Buffer.alloc(0),Buffer.alloc(64),Buffer.from('deadbeef')]){
    writeFileSync(file,content);
    await ensureHome(home);
    await assert.rejects(connectBroker(home),{code:'ipc_token_invalid'});
    await assert.rejects(ensureBroker(home),{code:'ipc_token_invalid'});
    await assert.rejects(async()=>{
      const server=await listenBroker(home,async()=>({}));
      await server.close();
    },{code:'ipc_token_invalid'});
    assert.deepEqual(readFileSync(file),content);
  }
});

async function oldBroker(t:TestContext){
  const home=temporary(t),file=path.join(home,'run','token');
  await ensureHome(home);
  const code="require('node:net').createServer(socket=>socket.destroy()).listen(process.argv[1],()=>process.stdout.write('ready'))";
  const child=spawn(process.execPath,['-e',code,ipcAddress(home)],{stdio:['ignore','pipe','inherit']});
  const closed=once(child,'close');
  t.after(async()=>{
    if(child.exitCode===null&&child.signalCode===null)child.kill();
    await closed;
  });
  await Promise.race([once(child.stdout,'data'),closed.then(()=>assert.fail('隔离旧协调器未开始监听'))]);
  assert.ok(await rememberOwnedChild(home,child,'broker'));
  writeFileSync(file,'','utf8');
  return{home,file,closed};
}

test('持有启动预约时，仅关闭已登记的旧协调器再更换令牌',async t=>{
  const {home,file,closed}=await oldBroker(t),startup=await reserveBrokerStartup(home,await processIdentity(process.pid));
  try{assert.equal(await repairIpcToken(home,startup),true);}finally{await startup();}
  await closed;
  assert.match(readFileSync(file,'utf8'),/^[a-f0-9]{64}$/);
});

test('旧进程停止后监听短暂残留时等待释放，释放前不更换令牌',async t=>{
  const {home,file,closed}=await oldBroker(t),startup=await reserveBrokerStartup(home,await processIdentity(process.pid));
  const create=net.createConnection;let probes=0;
  t.mock.method(net,'createConnection',((...args:any[])=>{
    if(args[0]!==ipcAddress(home))return Reflect.apply(create,net,args);
    assert.equal(readFileSync(file,'utf8'),'');
    if(++probes>1)return Reflect.apply(create,net,args);
                                           
    const socket=new net.Socket();queueMicrotask(()=>socket.emit('connect'));return socket;
  }) as typeof net.createConnection);
  try{
    assert.equal(await repairIpcToken(home,startup),true);
    assert.ok(probes>=2);await closed;assert.match(readFileSync(file,'utf8'),/^[a-f0-9]{64}$/);
  }finally{t.mock.restoreAll();await startup();}
});

test('原停止期限内监听一直未释放时拒绝换密，不重新获得一份等待预算',async t=>{
  const {home,file,closed}=await oldBroker(t),startup=await reserveBrokerStartup(home,await processIdentity(process.pid));
  const create=net.createConnection,now=performance.now.bind(performance);let probes=0;
  t.mock.method(net,'createConnection',((...args:any[])=>{
    if(args[0]!==ipcAddress(home))return Reflect.apply(create,net,args);
    probes++;assert.equal(readFileSync(file,'utf8'),'');
    t.mock.method(performance,'now',()=>now()+15000);
    const socket=new net.Socket();queueMicrotask(()=>socket.emit('connect'));return socket;
  }) as typeof net.createConnection);
  try{
    await assert.rejects(repairIpcToken(home,startup),{code:'ipc_token_repair_blocked'});
    assert.ok(probes>=1);await closed;assert.equal(readFileSync(file,'utf8'),'');
  }finally{t.mock.restoreAll();await startup();}
});
