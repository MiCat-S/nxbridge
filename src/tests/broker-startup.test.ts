import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync } from 'node:fs';
import { reserveBrokerStartup, startupHeldElsewhere, withBrokerStartup, assertStartupReservation, currentStartupToken, BROKER_STARTUP_LEASE_MS } from '../broker/broker-startup.js';
import { createRequire } from 'node:module';
import path from 'node:path';
import { processIdentity, liveProcess } from '../process/process.js';
import {delay} from '../shared/time.js';
import { temporary, temporaryDirectory } from './support/temporary.js';

test('外部预约只允许对应调用方启动，重复释放不会清除后来的预约',async t=>{
  const home=temporary(t),owner=await processIdentity(process.pid),release=await reserveBrokerStartup(home,owner);
  t.after(release);
  let starts=0;
  assert.equal(await withBrokerStartup(home,[],async()=>++starts),undefined);
  assert.equal(await withBrokerStartup(home,[owner],async()=>++starts),1);
  await assert.rejects(reserveBrokerStartup(home,owner),{code:'restart_in_progress'});
  await release();
  const later=await reserveBrokerStartup(home,owner);t.after(later);
  await release();
  assert.equal(await withBrokerStartup(home,[],async()=>++starts),undefined);
  await later();
  assert.equal(await withBrokerStartup(home,[],async()=>++starts),2);
});

test('预约与端点绑定互斥，已核验的竞争启动必须先完成绑定才能开始交接',async t=>{
  const home=temporary(t),owner=await processIdentity(process.pid);
  let entered!:()=>void,finish!:()=>void;
  const ready=new Promise<void>(resolve=>entered=resolve),gate=new Promise<void>(resolve=>finish=resolve);
  const startup=withBrokerStartup(home,[],async()=>{entered();await gate;return 'bound';});
  await ready;
  let reserved=false;
  const pending=reserveBrokerStartup(home,owner).then(release=>{reserved=true;return release;});
  try{await delay(100);assert.equal(reserved,false);}
  finally{finish();}
  assert.equal(await startup,'bound');
  const release=await pending;t.after(release);
  assert.equal(await withBrokerStartup(home,[],async()=>true),undefined);
});

test('已有读取事务阻塞提交时等待其释放，不泄漏原始 SQLite busy 错误',async t=>{
  const temp=temporaryDirectory(),home=temp.directory,owner=await processIdentity(process.pid),{DatabaseSync}=createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');
  await withBrokerStartup(home,[],async()=>true);
  const reader=new DatabaseSync(path.join(home,'run','broker-startup.db'));t.after(async()=>{reader.close();await temp.cleanup();});
  reader.exec('BEGIN');reader.prepare('SELECT * FROM reservation').all();let finished=false;
  const pending=reserveBrokerStartup(home,owner).then(value=>{finished=true;return value;});
  try{await delay(120);assert.equal(finished,false);}finally{reader.exec('ROLLBACK');}
  const release=await pending;t.after(release);await release.assertCurrent();
});

test('过期记录先提交清理再绑定端点，绑定后的读取者不会阻塞只读提交',async t=>{
  const temp=temporaryDirectory(),home=temp.directory,owner=await processIdentity(process.pid),{DatabaseSync}=createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');
  const release=await reserveBrokerStartup(home,owner);await release();
  const reader=new DatabaseSync(path.join(home,'run','broker-startup.db')),after=new DatabaseSync(path.join(home,'run','broker-startup.db'));t.after(async()=>{reader.close();after.close();await temp.cleanup();});
  reader.prepare('INSERT INTO reservation VALUES(1,?,?,?,?)').run(owner.pid,owner.startedAt,'expired',Date.now()-1);
  reader.exec('BEGIN');reader.prepare('SELECT * FROM reservation').all();let starts=0;
  const pending=withBrokerStartup(home,[],async()=>{starts++;after.exec('BEGIN');after.prepare('SELECT * FROM reservation').all();return 'bound';});
  try{await delay(120);assert.equal(starts,0);}finally{reader.exec('ROLLBACK');}
  try{assert.equal(await pending,'bound');assert.equal(starts,1);}finally{if(after.isTransaction)after.exec('ROLLBACK');}
});

test('写入者崩溃遗留热日志时，读取预约先自动回滚日志再正常接手',async t=>{
  const home=temporary(t),owner=await processIdentity(process.pid),{DatabaseSync}=createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');
  const release=await reserveBrokerStartup(home,owner);await release();const file=path.join(home,'run','broker-startup.db');
  const seed=new DatabaseSync(file);seed.exec('CREATE TABLE spill(value BLOB)');seed.close();
  const script=`import{DatabaseSync}from'node:sqlite';const db=new DatabaseSync(process.argv[1]);db.exec('PRAGMA cache_size=10;BEGIN IMMEDIATE');db.prepare('INSERT INTO reservation VALUES(1,?,?,?,?)').run(process.pid,'torn','uncommitted',Date.now()+120000);const insert=db.prepare('INSERT INTO spill VALUES(?)');for(let i=0;i<100;i++)insert.run(Buffer.alloc(16384));console.log('ready');setInterval(()=>{},1000);`;
  const child=spawn(process.execPath,['--no-warnings','--input-type=module','-e',script,file],{windowsHide:true,stdio:['ignore','pipe','pipe']}),closed=once(child,'close');
  t.after(async()=>{if(child.exitCode===null&&child.signalCode===null)child.kill();await closed;});
  await new Promise<void>((resolve,reject)=>{child.stdout.once('data',()=>resolve());child.once('error',reject);child.once('exit',()=>reject(Error('热日志写入进程提前退出')));});
  child.kill();await closed;assert.equal(existsSync(file+'-journal'),true);
  assert.equal(await startupHeldElsewhere(home),false);
  const fresh=await reserveBrokerStartup(home,owner);t.after(fresh);await fresh.assertCurrent();
  const db=new DatabaseSync(file);try{assert.equal(Number(db.prepare('SELECT count(*) AS n FROM spill').get()!.n),0);}finally{db.close();}
});

test('预约调用方崩溃后自动允许启动，无需删除状态文件',async t=>{
  const home=temporary(t),moduleUrl=new URL('../broker/broker-startup.js',import.meta.url).href;
  const script=`import{reserveBrokerStartup}from${JSON.stringify(moduleUrl)};import{processIdentity}from${JSON.stringify(new URL('../process/process.js',import.meta.url).href)};await reserveBrokerStartup(process.argv[1],await processIdentity(process.pid));console.log('ready');setInterval(()=>{},1000);`;
  const child=spawn(process.execPath,['--no-warnings','--input-type=module','-e',script,home],{windowsHide:true,stdio:['ignore','pipe','pipe']}),closed=once(child,'close');
  t.after(async()=>{if(child.pid&&liveProcess(child.pid))child.kill();await closed;});
  await new Promise<void>((resolve,reject)=>{child.stdout.once('data',()=>resolve());child.once('error',reject);child.once('exit',()=>reject(Error('隔离预约进程提前退出')));});
  assert.equal(await withBrokerStartup(home,[],async()=>true),undefined);
  assert.equal(await startupHeldElsewhere(home),true);
  child.kill();await closed;
  assert.equal(await startupHeldElsewhere(home),false);
  assert.equal(await withBrokerStartup(home,[],async()=>true),true);
  const release=await reserveBrokerStartup(home,await processIdentity(process.pid));await release();
});

test('释放预约不重新创建已经清理的状态目录',async()=>{
  const temp=temporaryDirectory();
  try{
    const release=await reserveBrokerStartup(temp.directory,await processIdentity(process.pid));
    await temp.cleanup();await release();
    assert.equal(existsSync(temp.directory),false);
  }finally{await temp.cleanup();}
});

test('本进程释放失败遗留的预约可由自身收回，进行中的预约仍互斥',async t=>{
  const home=temporary(t),owner=await processIdentity(process.pid);
  assert.equal(await startupHeldElsewhere(home),false);
  const release=await reserveBrokerStartup(home,owner);
  assert.equal(await startupHeldElsewhere(home),true);
  await assert.rejects(reserveBrokerStartup(home,owner),{code:'restart_in_progress'});
  await release();
  const {DatabaseSync}=createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');
  const db=new DatabaseSync(path.join(home,'run','broker-startup.db'));
  try{db.prepare('INSERT OR REPLACE INTO reservation(slot,pid,generation,token) VALUES(1,?,?,?)').run(owner.pid,owner.startedAt,'leaked');}finally{db.close();}
  assert.equal(await startupHeldElsewhere(home),false);
  assert.equal(await withBrokerStartup(home,[],async()=>true),undefined);
  const again=await reserveBrokerStartup(home,owner);
  assert.equal(await startupHeldElsewhere(home),true);
  await again();
  assert.equal(await withBrokerStartup(home,[],async()=>true),true);
});

test('存活所有者的预约到期后可接手，旧令牌不能绑定、交接或清除新预约',async t=>{
  const home=temporary(t),owner=await processIdentity(process.pid);t.mock.timers.enable({apis:['Date'],now:1000000});
  const old=await reserveBrokerStartup(home,owner);t.after(old);assert.equal(await currentStartupToken(home),old.token);
  t.mock.timers.tick(BROKER_STARTUP_LEASE_MS+1);assert.equal(await startupHeldElsewhere(home),false);
  const fresh=await reserveBrokerStartup(home,owner);t.after(fresh);
  let started=0;assert.equal(await withBrokerStartup(home,[owner],async()=>++started,old.token),undefined);
  await assert.rejects(old.assertCurrent(),{code:'broker_reservation_lost'});await assert.rejects(assertStartupReservation(home),{code:'broker_reservation_lost'});
  await old();await fresh.assertCurrent();assert.equal(await withBrokerStartup(home,[owner],async()=>++started,fresh.token),1);assert.equal(started,1);
});

test('旧格式活进程预约只获得一次固定宽限，多次检查不续期并能由新版接手',async t=>{
  const temp=temporaryDirectory(),home=temp.directory,owner=await processIdentity(process.pid),{DatabaseSync}=createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');
  const release=await reserveBrokerStartup(home,owner);await release();
  const db=new DatabaseSync(path.join(home,'run','broker-startup.db'));t.after(async()=>{db.close();t.mock.timers.reset();await temp.cleanup();});
  db.exec('DROP TABLE reservation;CREATE TABLE reservation(slot INTEGER PRIMARY KEY,pid INTEGER,generation TEXT,token TEXT)');
  db.prepare('INSERT INTO reservation VALUES(1,?,?,?)').run(owner.pid,owner.startedAt,'old-runtime-token');
  t.mock.timers.enable({apis:['Date'],now:1000000});
  assert.equal(await withBrokerStartup(home,[],async()=>true),undefined);
  const expiry=Number(db.prepare('SELECT expires_at FROM reservation').get()!.expires_at);assert.equal(expiry,1000000+BROKER_STARTUP_LEASE_MS);
  t.mock.timers.tick(10000);assert.equal(await withBrokerStartup(home,[],async()=>true),undefined);
  assert.equal(Number(db.prepare('SELECT expires_at FROM reservation').get()!.expires_at),expiry);
  t.mock.timers.tick(BROKER_STARTUP_LEASE_MS);const fresh=await reserveBrokerStartup(home,owner);t.after(fresh);
  assert.notEqual(fresh.token,'old-runtime-token');await fresh.assertCurrent();
});

test('所有者身份未知时视为持有，旧格式仍只得到一次固定宽限',async t=>{
  const temp=temporaryDirectory(),home=temp.directory,owner=await processIdentity(process.pid),{DatabaseSync}=createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');
  const release=await reserveBrokerStartup(home,owner);await release();const db=new DatabaseSync(path.join(home,'run','broker-startup.db'));
  t.after(async()=>{db.close();t.mock.timers.reset();await temp.cleanup();});
  db.prepare('INSERT INTO reservation VALUES(1,?,?,?,0)').run(owner.pid,'unverified-generation','legacy-unknown');
  t.mock.timers.enable({apis:['Date'],now:1000000});
  await assert.rejects(reserveBrokerStartup(home,owner),{code:'restart_in_progress'});
  const expiry=db.prepare('SELECT expires_at FROM reservation').get()!.expires_at;assert.equal(expiry,1000000+BROKER_STARTUP_LEASE_MS);
  t.mock.timers.tick(1000);assert.equal(await withBrokerStartup(home,[],async()=>true),undefined);assert.equal(db.prepare('SELECT expires_at FROM reservation').get()!.expires_at,expiry);
});

test('原生代次查询等待期间不占 SQLite 写锁，旧结果不能覆盖已变更的预约',async t=>{
  const home=temporary(t),owner=await processIdentity(process.pid),release=await reserveBrokerStartup(home,owner);t.after(release);
  const pending=withBrokerStartup(home,[owner],async()=>true,release.token);
  const {DatabaseSync}=createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite'),db=new DatabaseSync(path.join(home,'run','broker-startup.db'),{timeout:0});
  try{db.exec('BEGIN IMMEDIATE');db.prepare('UPDATE reservation SET token=?').run('replacement-token');db.exec('COMMIT');}finally{db.close();}
  assert.equal(await pending,undefined);
});

test('新版接手旧运行时的过期预约，不结束旧所有者，也不允许其迟到子进程绑定',async t=>{
  const temp=temporaryDirectory(),home=temp.directory,moduleUrl=new URL('../broker/broker-startup.js',import.meta.url).href;
  const script=`import{reserveBrokerStartup}from${JSON.stringify(moduleUrl)};import{processIdentity}from${JSON.stringify(new URL('../process/process.js',import.meta.url).href)};await reserveBrokerStartup(process.argv[1],await processIdentity(process.pid));console.log('ready');setInterval(()=>{},1000);`;
  const child=spawn(process.execPath,['--no-warnings','--input-type=module','-e',script,home],{windowsHide:true,stdio:['ignore','pipe','pipe']}),closed=once(child,'close');let fresh:Awaited<ReturnType<typeof reserveBrokerStartup>>|undefined;
  t.after(async()=>{if(child.pid&&liveProcess(child.pid))child.kill();await closed;await fresh?.();await temp.cleanup();});
  await new Promise<void>((resolve,reject)=>{child.stdout.once('data',()=>resolve());child.once('error',reject);child.once('exit',()=>reject(Error('旧预约所有者提前退出')));});
  const oldOwner=await processIdentity(child.pid!),{DatabaseSync}=createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite'),db=new DatabaseSync(path.join(home,'run','broker-startup.db'));
  try{
    db.exec('UPDATE reservation SET expires_at=0');await assert.rejects(reserveBrokerStartup(home,await processIdentity(process.pid)),{code:'restart_in_progress'});
    assert.ok(Number(db.prepare('SELECT expires_at FROM reservation').get()!.expires_at)>Date.now());
    db.prepare('UPDATE reservation SET expires_at=?').run(Date.now()-1);fresh=await reserveBrokerStartup(home,await processIdentity(process.pid));
  }finally{db.close();}
  assert.equal(liveProcess(child.pid!),true);assert.equal(await withBrokerStartup(home,[oldOwner],async()=>true),undefined);await fresh!.assertCurrent();
});
