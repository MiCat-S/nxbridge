import { copyNodeBinary } from './support/node-binary.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import { chmodSync, mkdirSync, readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { nativeDescendant, processAncestors, processIdentity, selectNativeHost, codexDedicatedEndpointArguments, probeProcesses, processProbeStatus, codexArguments, readPsArguments } from '../process/process.js';
import { temporary } from './support/temporary.js';

test('同名辅助后代不阻止真正宿主登记，独立的宿主分支仍拒绝猜选',()=>{
  const root={pid:1,parentPid:0,name:'node',startedAt:'1'},host={...root,pid:2,parentPid:1,name:'codex'},helper={...host,pid:3,parentPid:2},other={...host,pid:4};
  assert.equal(selectNativeHost([host,helper],[root,host,helper]).pid,2);
  assert.equal(selectNativeHost([host],[root,host]).pid,2);
  assert.throws(()=>selectNativeHost([host,helper,other],[root,host,helper,other]),{code:'launch_owner_unverified'});
});

test('专用端点选择按原生角色与精确参数，支持程序别名且排除其他监听及包装器',()=>{
  const address='unix:///tmp/launch.sock';
  assert.ok(codexDedicatedEndpointArguments(['/opt/custom-runtime','app-server','--listen',address],address));
  assert.ok(codexDedicatedEndpointArguments(['codex','-c','key=value','app-server','--listen='+address],address));
  for(const args of [['codex','app-server','--listen',address+'-other'],['node','wrapper.js','app-server','--listen',address],['codex','exec','app-server','--listen',address]])assert.equal(codexDedicatedEndpointArguments(args,address),false);
});

test('BSD 参数读取把已退出的候选进程归为缺失，保留查询故障和代次核验',async()=>{
  const found={pid:123,parentPid:1,name:'codex',startedAt:'Mon Nov 23 03:24:30 2026',image:'/opt/codex'},stdout=found.startedAt+' '+found.image+' app-server --listen unix:///tmp/launch.sock\n';
  assert.deepEqual(await readPsArguments(found,1500,async(command,args,options)=>{
    assert.equal(command,process.platform==='darwin'?'/bin/ps':'ps');assert.deepEqual(args,['-ww','-p','123','-o','lstart=,args=']);assert.equal(options.timeout,1500);return{stdout};
  }),['/opt/codex','app-server','--listen','unix:///tmp/launch.sock']);
  const missing={code:1,stdout:'',stderr:'',killed:false,signal:null};
  await assert.rejects(readPsArguments(found,1500,async()=>{throw missing;}),{code:'process_missing'});
  for(const failure of [{...missing,stderr:'ps: denied'},{...missing,stdout:'unexpected'},{...missing,code:2},{...missing,killed:true},{...missing,signal:'SIGTERM'}])await assert.rejects(readPsArguments(found,1500,async()=>{throw failure;}),error=>error===failure);
  for(const value of ['',stdout.replace('03:24:30','03:24:31')])await assert.rejects(readPsArguments(found,1500,async()=>({stdout:value})),{code:'process_identity_unknown'});
});

test('Darwin 原生参数查询在子进程退出后报告缺失',{skip:process.platform!=='darwin'},async()=>{
  const child=spawn(process.execPath,['-e','process.send("ready");setInterval(()=>{},1000)'],{stdio:['ignore','ignore','ignore','ipc']}),closed=new Promise<void>(resolve=>child.once('close',()=>resolve()));
  try{
    await new Promise<void>((resolve,reject)=>{child.once('message',()=>resolve());child.once('error',reject);});
    const identity=await processIdentity(child.pid!);child.kill();await closed;
    await assert.rejects(codexArguments(identity),{code:'process_missing'});
  }finally{if(child.exitCode===null&&child.signalCode===null)child.kill();await closed;}
});

test('同一轮多组健康探测合并查询，分别保留正确和错误代次结果',async()=>{
  const identity=await processIdentity(process.pid),before=processProbeStatus();
  const results=await Promise.all(Array.from({length:12},(_,index)=>probeProcesses([{pid:process.pid,procStart:index%2?'wrong':identity.startedAt}])));
  assert.deepEqual(results.map(r=>r[0]),Array.from({length:12},(_,i)=>i%2?'dead':'alive'));assert.equal(processProbeStatus().batches-before.batches,1);assert.equal(processProbeStatus().requests-before.requests,12);
});

test('Windows 原生后代保持宿主身份、父链和 FILETIME 代次一致',{skip:process.platform!=='win32'},async t=>{
  const home=temporary(t),binary=path.join(home,'codex.exe');copyNodeBinary(binary);
  const started=Date.now(),child=spawn(binary,['-e','process.send("ready");setInterval(()=>{},1000)'],{windowsHide:true,stdio:['ignore','ignore','ignore','ipc']});
  try{
    await new Promise<void>((resolve,reject)=>{child.once('message',()=>resolve());child.once('error',reject);child.once('exit',()=>reject(Error('后代夹具提前退出')));});
    const identity=await processIdentity(child.pid!),native=await nativeDescendant(child.pid!,'codex',started);
    assert.equal(native.pid,child.pid);assert.equal(native.parentPid,process.pid);assert.equal(native.name,'codex.exe');
    assert.equal(native.startedAt,identity.startedAt);assert.equal(native.startedAt,identity.procStartFt);
    assert.equal((await processAncestors(child.pid!,2))[1]?.pid,process.pid);
  }finally{child.kill();await new Promise<void>(resolve=>child.exitCode!==null||child.signalCode!==null?resolve():child.once('exit',()=>resolve()));}
});

test('Windows 原生后代按精确端点选择程序别名，拒绝不同端点与独立宿主分支',{skip:process.platform!=='win32'},async t=>{
  const home=temporary(t),alias=path.join(home,'custom-runtime.exe'),binary=path.join(home,'codex.exe'),endpoint='ws://127.0.0.1:34567';copyNodeBinary(alias);copyNodeBinary(binary);
  const children:ReturnType<typeof spawn>[]=[],started=Date.now();
  const start=async(executable:string,address:string)=>{
    const child=spawn(executable,['--eval=process.send("ready");setInterval(()=>{},1000)','app-server','--listen',address],{windowsHide:true,stdio:['ignore','ignore','ignore','ipc']});children.push(child);
    await new Promise<void>((resolve,reject)=>{child.once('message',()=>resolve());child.once('error',reject);});return child;
  };
  try{
    const matching=await start(alias,endpoint);await start(binary,endpoint+'-other');
    assert.equal((await nativeDescendant(matching.pid!,'codex',started,endpoint)).pid,matching.pid);
    await assert.rejects(nativeDescendant(process.pid,'codex',started,endpoint),{code:'launch_owner_unverified'});
    await start(binary,endpoint);await assert.rejects(nativeDescendant(process.pid,'codex',started,endpoint),{code:'launch_owner_unverified'});
  }finally{await Promise.all(children.map(child=>new Promise<void>(resolve=>{if(child.exitCode!==null||child.signalCode!==null)return resolve();child.once('exit',()=>resolve());child.kill();})));}
});


test('Linux 进程身份采用原生 starttime，正确解析含空格和括号的 comm',{skip:process.platform!=='linux'},async()=>{
  const child=spawn(process.execPath,['-e','process.title="a ) ( b";process.send("ready");setInterval(()=>{},1000)'],{stdio:['ignore','ignore','ignore','ipc']});
  try{
    await new Promise<void>((resolve,reject)=>{child.once('message',()=>resolve());child.once('error',reject);child.once('exit',()=>reject(Error('身份夹具提前退出')));});
    const identity=await processIdentity(child.pid!),stat=readFileSync(`/proc/${child.pid}/stat`,'utf8');
    const generation=stat.slice(stat.lastIndexOf(')')+2).trim().split(/\s+/)[19];
    assert.equal(identity.name,'a ) ( b');assert.equal(identity.startedAt,generation);assert.equal(identity.procStart,generation);
    const ancestors=await processAncestors(child.pid!,2);assert.equal(ancestors[1]?.pid,process.pid);assert.equal(identity.parentPid,process.pid);
  }finally{child.kill();await new Promise<void>(resolve=>child.exitCode!==null||child.signalCode!==null?resolve():child.once('exit',()=>resolve()));}
});

test('Darwin 改名后的后代按内核程序名及真实映像发现，保留原生代次',{skip:process.platform!=='darwin'},async t=>{
  const root=temporary(t),binary=path.join(root,'claude');copyNodeBinary(binary);chmodSync(binary,0o700);
  const child=spawn(binary,['-e','process.title="renamed background worker";process.send("ready");setInterval(()=>{},1000)'],{stdio:['ignore','ignore','ignore','ipc']});
  try{
    await new Promise<void>((resolve,reject)=>{child.once('message',()=>resolve());child.once('error',reject);child.once('exit',()=>reject(Error('后代夹具提前退出')));});
    const native=await nativeDescendant(process.pid,'claude',Date.now()-10000),identity=await processIdentity(child.pid!);
    assert.equal(native.pid,child.pid);assert.equal(native.name,'claude');assert.equal(native.image,realpathSync(binary));assert.equal(native.startedAt,identity.startedAt);
  }finally{child.kill();await new Promise<void>(resolve=>child.exitCode!==null||child.signalCode!==null?resolve():child.once('exit',()=>resolve()));}
});

test('Linux 原生后代返回同一套 /proc 代次与真实程序路径',{skip:process.platform!=='linux'},async()=>{
  const started=Date.now(),child=spawn(process.execPath,['-e','process.title="codex";process.send("ready");setInterval(()=>{},1000)'],{stdio:['ignore','ignore','ignore','ipc']});
  try{
    await new Promise<void>((resolve,reject)=>{child.once('message',()=>resolve());child.once('error',reject);child.once('exit',()=>reject(Error('后代夹具提前退出')));});
    assert.deepEqual(await nativeDescendant(child.pid!,'codex',started),await processIdentity(child.pid!));
  }finally{child.kill();await new Promise<void>(resolve=>child.exitCode!==null||child.signalCode!==null?resolve():child.once('exit',()=>resolve()));}
});

test('Linux C locale 下的 ps 只作枚举，真实中文及 NFD 程序路径仍从 procfs 完整读取',{skip:process.platform!=='linux'},async t=>{
  const root=temporary(t),directory=path.join(root,'中文 Ω e\u0301 含 空格'),binary=path.join(directory,'codex');mkdirSync(directory);copyNodeBinary(binary);chmodSync(binary,0o700);
                                               
  const child=spawn(binary,['-e','process.title="codex";process.send("ready");setInterval(()=>{},1000)'],{stdio:['ignore','ignore','ignore','ipc']}),closed=new Promise<void>(resolve=>child.once('close',()=>resolve())),saved={LC_ALL:process.env.LC_ALL,LANG:process.env.LANG};
  try{
    await new Promise<void>((resolve,reject)=>{child.once('message',()=>resolve());child.once('error',reject);});
    Object.assign(process.env,{LC_ALL:'C',LANG:'C'});
    const native=await nativeDescendant(child.pid!,'codex',Date.now()-10000);assert.equal(native.image,binary);assert.equal(native.startedAt,(await processIdentity(child.pid!)).startedAt);
  }finally{for(const [key,value]of Object.entries(saved))if(value===undefined)delete process.env[key];else process.env[key]=value;child.kill();await closed;}
});
