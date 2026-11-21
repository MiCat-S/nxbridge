import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { brokerOutageNotice, brokerOutageState, claimBrokerOutageEnqueue, releaseBrokerOutageClaim, observeBrokerReachable, brokerOutageDiagnostic, BROKER_OUTAGE_DELAY_MS, type OutageClaimant } from '../broker/broker-outage.js';
import { temporaryDirectory } from './support/temporary.js';

const actor=(session:string):OutageClaimant=>({host:session==='codex'?'codex':'claude',peerId:session,sessionId:session,pid:100,procStart:session});
const alive=async()=>['alive' as const];
function home(t:test.TestContext){const temp=temporaryDirectory();mkdirSync(path.join(temp.directory,'run'));t.after(temp.cleanup);return temp.directory;}
async function prime(root:string,who:OutageClaimant,start=1000){for(const offset of [0,40000,80000])assert.equal(await brokerOutageNotice(root,who,{now:start+offset,admit:false},alive),undefined);}

test('持续两分钟后所有窗口共用一次原子领取，原生 hook 和 Mod 不重复处理',async t=>{
  const root=home(t),first=actor('claude'),other=actor('codex');
  await prime(root,first);
  assert.equal(await brokerOutageNotice(root,first,{now:BROKER_OUTAGE_DELAY_MS,admit:false},alive),undefined);
  const notices=await Promise.all([first,other,actor('third')].map(actor=>brokerOutageNotice(root,actor,{now:121001},alive)));
  assert.equal(notices.filter(notice=>notice?.wake).length,1);assert.equal(new Set(notices.filter(Boolean).map(notice=>notice!.epoch)).size,1);
  assert.match(notices.find(notice=>notice?.wake)!.message,/doctor once.*bootstrap once/);
  assert.equal((await brokerOutageNotice(root,first,{now:122000},alive))?.wake,undefined);
  assert.equal((await brokerOutageNotice(root,other,{now:122000},alive))?.wake,undefined);
  assert.equal(brokerOutageState(root)?.claim?.state,'admitted');
});

test('独立进程同时领取时只有一个处理任务，落败窗口只能接收同一次故障的提示',async t=>{
  const root=home(t);await prime(root,actor('seed'));
  const script=`import{brokerOutageNotice}from${JSON.stringify(new URL('../broker/broker-outage.js',import.meta.url).href)};
    const actor=JSON.parse(process.argv[2]);process.send('ready');await new Promise(resolve=>process.once('message',resolve));
    let notice;for(let i=0;i<100&&!notice;i++){notice=await brokerOutageNotice(process.argv[1],actor,{now:121001},async()=>['alive']);if(!notice)await new Promise(resolve=>setTimeout(resolve,10));}
    process.send(notice??null);process.disconnect();`;
  const children=Array.from({length:6},(_,index)=>{
    const child=spawn(process.execPath,['--no-warnings','--input-type=module','-e',script,root,JSON.stringify(actor('window-'+index))],{windowsHide:true,stdio:['ignore','ignore','pipe','ipc']});
    const closed=once(child,'close');t.after(async()=>{if(child.exitCode===null&&child.signalCode===null)child.kill();await closed;});
    return{child,closed,ready:once(child,'message')};
  });
  await Promise.all(children.map(value=>value.ready));
  const delivered=children.map(({child})=>once(child,'message').then(([notice])=>notice));
  for(const {child} of children)child.send('go');
  const notices=await Promise.all(delivered);
  assert.equal(notices.filter(notice=>notice?.wake===true).length,1);
  assert.equal(notices.filter(notice=>notice?.wake===false).length,5);
  assert.equal(new Set(notices.map(notice=>notice.epoch)).size,1);
  for(const {closed} of children)assert.equal((await closed)[0],0);
  assert.equal(brokerOutageState(root)?.claim?.state,'admitted');
});

test('只读信号保留领取；原生 inbox 提交一次，领取者死于提供正文之前才允许转交',async t=>{
  const root=home(t),first=actor('claude'),other=actor('codex');await prime(root,first);
  const signal=(await brokerOutageNotice(root,first,{now:121001,admit:false},alive))!;assert.equal(signal.wake,true);
  assert.equal(claimBrokerOutageEnqueue(root,first,signal.id,121001),true);assert.equal(claimBrokerOutageEnqueue(root,first,signal.id,121001),false);
  assert.equal((await brokerOutageNotice(root,other,{now:122000,admit:false},async()=>['unknown']))?.wake,false);
  const replacement=await brokerOutageNotice(root,other,{now:123000},async()=>['dead']);assert.equal(replacement?.wake,true);assert.equal(replacement?.epoch,signal.epoch);
  assert.equal((await brokerOutageNotice(root,first,{now:124000},async()=>['dead']))?.wake,false);
  assert.equal(brokerOutageState(root)?.claim?.sessionId,'codex');
});

test('已提供正文后结果未知也不重放；恢复是被动事实，下一次故障从新期限开始',async t=>{
  const root=home(t),first=actor('claude');await prime(root,first);
  const notice=(await brokerOutageNotice(root,first,{now:121001},alive))!;
  assert.equal(await brokerOutageNotice(root,first,{now:122000},alive),undefined);
  assert.equal(await brokerOutageNotice(root,first,{now:123000,reachable:true},alive),undefined);
  for(let now=123000;now<=243000;now+=30000)observeBrokerReachable(root,now);
  const recovery=await brokerOutageNotice(root,first,{now:243001,reachable:true},alive);assert.equal(recovery?.wake,false);assert.equal(recovery?.phase,'recovery');
  assert.equal((await brokerOutageNotice(root,actor('new-window'),{now:243002,reachable:true},alive))?.phase,'recovery');
  assert.equal(await brokerOutageNotice(root,first,{now:243003,reachable:true},alive),undefined);
  await prime(root,first,245000);
  assert.equal((await brokerOutageNotice(root,first,{now:365001},alive))?.wake,false,'一小时内的新故障只能提示');
  await prime(root,first,3722000);
  const next=(await brokerOutageNotice(root,first,{now:3842001},alive))!;assert.equal(next.wake,true);assert.notEqual(next.epoch,notice.epoch);
});

test('交接期间重计静默期限，不给暂停或待人工窗口领取，锁竞争也不产生第二任务',async t=>{
  const root=home(t),first=actor('claude');await prime(root,first);
  assert.equal(await brokerOutageNotice(root,first,{now:121001,suppressed:true},alive),undefined);
  assert.equal(await brokerOutageNotice(root,first,{now:122000},alive),undefined);
  for(const now of [162000,202000])assert.equal(await brokerOutageNotice(root,first,{now},alive),undefined);
  const passive=await brokerOutageNotice(root,first,{now:241002,eligible:false,admit:false},alive);assert.equal(passive?.wake,false);assert.equal(brokerOutageState(root)?.claim,undefined);
  const {DatabaseSync}=createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite'),db=new DatabaseSync(path.join(root,'run','broker-outage.db'));
  try{db.exec('BEGIN IMMEDIATE');assert.equal(await brokerOutageNotice(root,first,{now:242000},alive),undefined);}finally{db.exec('ROLLBACK');db.close();}
  assert.equal((await brokerOutageNotice(root,first,{now:243000},alive))?.wake,true);
});

test('短暂恢复后再崩溃仍是同一次故障，超过一小时也不循环唤醒',async t=>{
  const root=home(t),first=actor('claude');await prime(root,first);
  const initial=(await brokerOutageNotice(root,first,{now:121001},alive))!;
  for(const now of [122000,1800000,3800000]){
    assert.equal(await brokerOutageNotice(root,first,{now,reachable:true},alive),undefined);
    assert.equal((await brokerOutageNotice(root,actor('other-'+now),{now:now+15000},alive))?.wake===true,false);
    assert.equal(brokerOutageState(root)?.epoch,initial.epoch);assert.equal(brokerOutageState(root)?.closedAt,undefined);
  }
});

test('长时间没有观察时重新计算连续断线期限，快速通道也由 broker 心跳关闭旧故障',async t=>{
  const root=home(t),first=actor('claude');await brokerOutageNotice(root,first,{now:1000},alive);
  assert.equal(await brokerOutageNotice(root,first,{now:121001},alive),undefined);
  assert.equal(brokerOutageState(root)?.since,121001);
  for(const now of [161001,201001])await brokerOutageNotice(root,first,{now},alive);
  assert.equal((await brokerOutageNotice(root,first,{now:241002},alive))?.wake,true);
  for(let now=242000;now<=362000;now+=30000)observeBrokerReachable(root,now);
  assert.equal(brokerOutageState(root)?.closedAt,362000);
});

test('明确未提供正文可转交并排除原窗口；预约过期可接替，已提供正文永不释放',async t=>{
  const root=home(t),first=actor('claude'),other=actor('codex');await prime(root,first);
  const signal=(await brokerOutageNotice(root,first,{now:121001,admit:false},alive))!;
  claimBrokerOutageEnqueue(root,first,signal.id,121001);releaseBrokerOutageClaim(root,first,signal.id);
  assert.equal((await brokerOutageNotice(root,first,{now:122000,admit:false},alive))?.wake,false);
  assert.equal((await brokerOutageNotice(root,other,{now:123000,admit:false},alive))?.wake,true);
  await brokerOutageNotice(root,actor('third'),{now:160000,admit:false},alive);
  assert.equal((await brokerOutageNotice(root,actor('third'),{now:183001},alive))?.wake,true);
  releaseBrokerOutageClaim(root,actor('third'),signal.id);assert.equal(brokerOutageState(root)?.claim?.state,'admitted');
});

test('损坏领取账本保留原始证据且不自动重新创建任务',async t=>{
  const root=home(t),filename=path.join(root,'run','broker-outage.db'),bytes='invalid sqlite';writeFileSync(filename,bytes,'utf8');
  assert.equal(await brokerOutageNotice(root,actor('claude'),{now:121001},alive),undefined);
  observeBrokerReachable(root);assert.equal(readFileSync(filename,'utf8'),bytes);assert.match(brokerOutageDiagnostic(root)!,/unknown/);
});

test('通知已入队但窗口切换且进程仍活时，正文领取超时可转交，迟到标记不能取得新任务',async t=>{
  const root=home(t),first=actor('old-session'),other=actor('new-session');await prime(root,first);
  const signal=(await brokerOutageNotice(root,first,{now:121001,admit:false},alive))!;
  assert.equal(claimBrokerOutageEnqueue(root,first,signal.id,121001),true);
  for(const now of [162000,202000])assert.equal((await brokerOutageNotice(root,other,{now,admit:false},alive))?.wake,false);
  assert.equal((await brokerOutageNotice(root,other,{now:241002,admit:false},alive))?.wake,true);
  assert.equal((await brokerOutageNotice(root,first,{now:241003,noticeId:signal.id},alive))?.wake,false);
  releaseBrokerOutageClaim(root,first,signal.id);assert.equal(brokerOutageState(root)?.claim?.sessionId,other.sessionId);
  assert.equal((await brokerOutageNotice(root,other,{now:241004},alive))?.wake,true);
  assert.equal(brokerOutageState(root)?.claim?.state,'admitted');
});

test('单窗口明确未提交后只短暂排除，恢复预算允许同一窗口随后领取一次',async t=>{
  const root=home(t),first=actor('claude');await prime(root,first);
  const signal=(await brokerOutageNotice(root,first,{now:121001,admit:false},alive))!;
  releaseBrokerOutageClaim(root,first,signal.id);
  for(const now of [122000,162000])assert.equal((await brokerOutageNotice(root,first,{now,admit:false},alive))?.wake,false);
  assert.equal((await brokerOutageNotice(root,first,{now:181002},alive))?.wake,true);
  assert.equal(await brokerOutageNotice(root,first,{now:5000000},alive),undefined);
});

test('稀疏 Codex hook 累计断线时间，稳定恢复后的心跳和读取不反复写入账本',async t=>{
  const root=home(t),first=actor('codex');await brokerOutageNotice(root,first,{now:1000},alive);
  assert.equal((await brokerOutageNotice(root,first,{now:121001},alive))?.wake,true);
  for(let now=122000;now<=242000;now+=30000)observeBrokerReachable(root,now);
  assert.equal(brokerOutageState(root)?.closedAt,242000);
  const {DatabaseSync}=createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite'),db=new DatabaseSync(path.join(root,'run','broker-outage.db'));
  try{const before=db.prepare('PRAGMA data_version').get()!.data_version;observeBrokerReachable(root,300000);brokerOutageState(root);assert.equal(db.prepare('PRAGMA data_version').get()!.data_version,before);}finally{db.close();}
});

test('唯一窗口长时间忙碌导致入队和预约过期时，迟到取件仍能领取任务，不被当作发送失败排除',async t=>{
  const root=home(t),first=actor('claude');await prime(root,first);
  const signal=(await brokerOutageNotice(root,first,{now:121001,admit:false},alive))!;claimBrokerOutageEnqueue(root,first,signal.id,121001);
  for(const now of [162000,202000,242002,282002,322003])await brokerOutageNotice(root,first,{now,admit:false},alive);
  assert.equal(brokerOutageState(root)?.excluded?.[JSON.stringify([first.host,first.peerId,first.sessionId,first.pid,first.procStart])],undefined);
  assert.equal((await brokerOutageNotice(root,first,{now:322004,noticeId:signal.id},alive))?.wake,true);assert.equal(brokerOutageState(root)?.claim?.state,'admitted');
});

test('无法解析的领取记录保留原文和诊断，不按空账本重新领取',async t=>{
  const {DatabaseSync}=createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');
  const root=home(t),raw='{"epoch":';await brokerOutageNotice(root,actor('codex'),{now:1000},alive);const db=new DatabaseSync(path.join(root,'run','broker-outage.db'));
  try{db.prepare('UPDATE outage SET data=? WHERE slot=1').run(raw);assert.equal(await brokerOutageNotice(root,actor('codex'),{now:121001},alive),undefined);assert.equal(db.prepare('SELECT data FROM outage WHERE slot=1').get()!.data,raw);assert.match(brokerOutageDiagnostic(root)!,/unknown/);}finally{db.close();}
});

test('自有账本的扩展字段不冻结恢复，已准入领取也不会因旧枚举校验重复唤醒',async t=>{
  const root=home(t),first=actor('claude');await prime(root,first);
  const signal=(await brokerOutageNotice(root,first,{now:121001},alive))!;
  const {DatabaseSync}=createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite'),db=new DatabaseSync(path.join(root,'run','broker-outage.db'));
  try{
    const value=JSON.parse(String(db.prepare('SELECT data FROM outage WHERE slot=1').get()!.data));
    value.excluded={legacy:'future-format'};value.extension={state:'new-state'};
    db.prepare('UPDATE outage SET data=? WHERE slot=1').run(JSON.stringify(value));
    assert.equal(brokerOutageState(root)?.epoch,signal.epoch);assert.equal(brokerOutageDiagnostic(root),undefined);
    assert.equal(await brokerOutageNotice(root,first,{now:122000},alive),undefined);
    for(let now=123000;now<=243000;now+=30000)observeBrokerReachable(root,now);
    assert.equal((await brokerOutageNotice(root,first,{now:243001,reachable:true},alive))?.phase,'recovery');
    assert.equal(brokerOutageState(root)?.claim?.state,'admitted');
  }finally{db.close();}
});

test('系统时钟回退后未提交领取可到期转交，已提供正文的领取仍不重放',async t=>{
  for(const admitted of [false,true]){
    const root=home(t),first=actor('claude'),other=actor('codex');await prime(root,first,9000000);
    const signal=(await brokerOutageNotice(root,first,{now:9120001,admit:admitted},alive))!;
    if(!admitted)claimBrokerOutageEnqueue(root,first,signal.id,9120001);
    assert.equal(await brokerOutageNotice(root,other,{now:1000},alive),undefined);
    const next=await brokerOutageNotice(root,other,{now:121001},alive);
    assert.equal(next?.wake===true,!admitted);assert.equal(brokerOutageState(root)?.claim?.sessionId,admitted?first.sessionId:other.sessionId);
    if(admitted){assert.equal(brokerOutageState(root)?.lastWakeAt,1000);assert.equal((await brokerOutageNotice(root,other,{now:5000000},alive))?.wake===true,false);}
  }
});

test('只有被动断线说明而未产生领取时，稳定恢复后也提供一次恢复事实',async t=>{
  const root=home(t),first=actor('claude');await prime(root,first);
  assert.equal((await brokerOutageNotice(root,first,{now:121001,eligible:false},alive))?.wake,false);assert.equal(brokerOutageState(root)?.claim,undefined);
  for(let now=122000;now<=242000;now+=30000)observeBrokerReachable(root,now);
  assert.equal((await brokerOutageNotice(root,first,{now:243000,reachable:true},alive))?.phase,'recovery');assert.equal(await brokerOutageNotice(root,first,{now:243001,reachable:true},alive),undefined);
});

test('慢速进程核验期间其他窗口推进账本后，使用提交时的新时钟，不把交错观察误判为时钟回退',async t=>{
  t.mock.timers.enable({apis:['Date'],now:1000});const root=home(t),first=actor('claude'),other=actor('other');await prime(root,first);t.mock.timers.tick(120001);
  const signal=(await brokerOutageNotice(root,first,{admit:false},alive))!;claimBrokerOutageEnqueue(root,first,signal.id);
  const passive=await brokerOutageNotice(root,other,{admit:false},async()=>{
    for(let i=0;i<2;i++){t.mock.timers.tick(40000);await brokerOutageNotice(root,first,{admit:false},alive);}return['alive'];
  });
  assert.equal(passive?.wake,false);assert.equal(brokerOutageState(root)?.since,1000);assert.equal(brokerOutageState(root)?.lastAt,201001);
  t.mock.timers.tick(40001);assert.equal((await brokerOutageNotice(root,other,{},alive))?.wake,true);
});
