import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync, readFileSync, unlinkSync } from 'node:fs';
import { Store } from '../storage/store.js';
import { FaultBoundary } from '../broker/fault-boundary.js';
import { managedRegistration } from '../hosts/managed-registration.js';
import { pairLossView } from '../broker/pairing/pair-restore.js';
import {DeliveryHealth} from '../broker/health/delivery.js';
import { fixture } from './support/broker-fixture.js';
import { registration } from './support/registration.js';
import { temporaryDirectory } from './support/temporary.js';
import { nativeOwnership, nativeOwnershipRecords, saveNativeOwnership, type NativeOwnership } from '../process/owned-native.js';
import { pruneProcessOwnership } from '../process/process-cleanup.js';
import { ClaudeAdapter } from '../hosts/claude/adapter.js';
import { WindowRecovery } from '../broker/recovery/window-recovery.js';
import {DEFAULT_CONFIG} from '../config/defaults.js';
import { brokerOutageNotice, observeBrokerReachable } from '../broker/broker-outage.js';
import { processRegistryDirectory } from '../process/owned-processes.js';

test('同一坏记录只诊断一次，修复后恢复读取且不会使所有配对降级',t=>{
  const {store,c}=fixture(t),db=(store as any).db,raw=db.prepare('SELECT data FROM peers WHERE id=?').get(c.id).data;
  db.prepare('UPDATE peers SET data=? WHERE id=?').run('{broken',c.id);
  for(let index=0;index<20;index++)assert.equal(store.getPeer(c.id),undefined);
  const failures=()=>store.events().filter(event=>event.type==='pump.failed'&&(event.data as any).stage==='record:peer:'+c.id);
  assert.equal(failures().length,1);assert.equal(store.faults.status().find(value=>value.stage==='record:peer:'+c.id)?.degraded,false);
  db.prepare('UPDATE peers SET data=? WHERE id=?').run(raw,c.id);assert.ok(store.getPeer(c.id));
  assert.equal(store.faults.status().some(value=>value.stage==='record:peer:'+c.id),false);
  db.prepare('UPDATE peers SET data=? WHERE id=?').run('{broken-again',c.id);store.getPeer(c.id);assert.equal(failures().length,2);
});

test('单组配对的成员不可解析时，全局状态 RPC 仍可读取并保留原配对',async t=>{
  const {store,broker,c,x}=fixture(t),pair=store.pair(c.id,x.id);
  (store as any).db.prepare('UPDATE peers SET data=? WHERE id=?').run('{broken',c.id);
  const result=await broker.dispatch('status',{}) as any;
  assert.equal(result.pair.id,pair.id);assert.ok(result.peers.some((peer:any)=>peer.id===x.id));
  assert.equal(store.pairFor(c.id)?.id,pair.id);
});

test('单个原生归属文件无法解析时其他记录继续，状态保留未知诊断，卸载不丢证据',async t=>{
  const {store,broker,c}=fixture(t),directory=processRegistryDirectory(broker.home),file=path.join(directory,'native-'+c.id+'.json');
  const healthy=store.register(registration('claude','healthy-native'));
  saveNativeOwnership({version:1,id:randomUUID(),home:broker.home,peerId:healthy.id,configHome:broker.home,phase:'failed',createdAt:0,releasedToUser:true});
  mkdirSync(directory,{recursive:true});writeFileSync(file,'{broken','utf8');
  try{
    await broker.start();
    assert.equal(store.faults.status().some(value=>value.stage==='startup_retirements'),false);
    const notes:string[]=[],records=nativeOwnershipRecords(broker.home,(_peerId,note)=>notes.push(note));
    assert.deepEqual(records.map(record=>record.peerId),[healthy.id]);assert.equal(notes.length,1);assert.ok(notes[0]!.includes(file));
    assert.throws(()=>nativeOwnership(broker.home,c.id),SyntaxError);
    const status=await broker.dispatch('status',{}) as any;assert.ok(status.peers.some((peer:any)=>peer.id===c.id));
    const retirement=status.capabilities.retirements.find((record:any)=>record.peerId===c.id);
    assert.equal(retirement.state,'unknown');assert.deepEqual(retirement.processes,[]);assert.ok(retirement.notes[0].includes(file));
    const cleanup=await pruneProcessOwnership(broker.home,true);assert.equal(cleanup.removed,false);assert.ok(cleanup.notes.some(note=>note.includes(file)));
    assert.equal(readFileSync(file,'utf8'),'{broken');assert.equal(nativeOwnership(broker.home,healthy.id),undefined);
  }finally{unlinkSync(file);}
});

test('相同记录连续故障进入有上限的退避，其他记录及恢复后工作继续',async()=>{
  let now=1000,calls=0;const events:unknown[]=[],faults=new FaultBoundary((_type,data)=>events.push(data),()=>now);
  for(let i=0;i<8;i++)await faults.run('bad',()=>{calls++;throw Error('坏记录 '+i);});
  assert.equal(calls,3);assert.equal(faults.status()[0]!.degraded,true);
  assert.equal(await faults.run('healthy',()=>calls++),true);assert.equal(calls,4);
  now=6001;assert.equal(await faults.run('bad',()=>calls++),true);assert.deepEqual(faults.status(),[]);assert.equal(events.length,3);
});

test('原生事件同步异常和异步登记拒绝均不逃出宿主回调，正常投递继续',async t=>{
  const {store,broker,c,x,codex,claude}=fixture(t),pair=store.pair(c.id,x.id),message=store.accept(pair,x,'继续服务','isolated-event');
  const peer=(broker as any).runtimePeer.bind(broker);(broker as any).runtimePeer=()=>{throw Error('事件记录故障');};
  assert.doesNotThrow(()=>codex.emit('state','bad','ready'));
  (broker as any).runtimePeer=peer;(broker as any).windowRecovery.register=async()=>{throw Error('异步登记故障');};
  assert.doesNotThrow(()=>codex.emit('register',registration('codex','new')));
  await broker.pump();assert.equal(store.message(message.id).state,'runtimeQueued');assert.equal(claude.delivered.length,1);
  assert.ok(store.faults.status().some(row=>row.stage.startsWith('event:state:')));
  assert.ok(store.faults.status().some(row=>row.stage.startsWith('event:register:')));
});

test('坏暂停窗口不会阻断其他配对的消息，也不会让全局等待提前结束',async t=>{
  const {store,broker,c,x,claude}=fixture(t),pair=store.pair(c.id,x.id),message=store.accept(pair,x,'独立队列','healthy-pair');
  const paused=store.register(registration('codex','broken-paused'));store.updatePeer(paused.id,{state:'paused'});
  const probe=(broker as any).runtimeHealth.probeRuntime.bind((broker as any).runtimeHealth);(broker as any).runtimeHealth.probeRuntime=(peer:any,...args:unknown[])=>peer.id===paused.id?Promise.reject(Error('单窗口查询失败')):probe(peer,...args);
  await broker.pump();assert.equal(store.message(message.id).state,'runtimeQueued');assert.equal(claude.delivered.length,1);
  assert.ok(store.faults.status().some(row=>row.stage==='paused_window:'+paused.id));
});

test('启动清除旧悬空引用，不可解析成员保留原文并留下阶段诊断',async t=>{
  const temp=temporaryDirectory(),file=path.join(temp.directory,'bridge.db');let store=new Store(file);
  const c=store.register(registration('claude','healthy')),x=store.register(registration('codex','healthy')),pair=store.pair(c.id,x.id),bad=store.register(registration('claude','bad'));
  store.setSetting('windowRecoveryPending',{gone:{peerId:'gone',input:{}}});store.setSetting('managedSessionConflict:'+c.id,{memberId:'gone'});store.close();
  const {DatabaseSync}=createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite'),db=new DatabaseSync(file);db.prepare('UPDATE peers SET data=? WHERE id=?').run('{broken',bad.id);db.close();
  store=new Store(file);t.after(async()=>{store.close();await temp.cleanup();});
  assert.deepEqual(store.setting('windowRecoveryPending'),{});assert.equal(store.setting('managedSessionConflict:'+c.id),undefined);
  assert.equal(store.peers().length,2);assert.equal(store.pairs()[0]!.id,pair.id);
  assert.ok(store.faults.status().some(event=>event.stage==='record:peer:'+bad.id));
  assert.equal((store as any).db.prepare('SELECT data FROM peers WHERE id=?').get(bad.id).data,'{broken');
});

test('前搭档被保留策略清除后，解配事实仍可读取且恢复状态为 gone',async t=>{
  const {store,c,x}=fixture(t),pair=store.pair(c.id,x.id);store.unpair(pair.id,{reason:'window_exit'});
  store.deactivate(c.id);store.updatePeer(c.id,{state:'offline'});
  store.maintain({historyMaxAgeMs:1,peerMaxIdleMs:1},Date.now()+1000);
  assert.equal(store.getPeer(c.id),undefined);const loss=pairLossView(store,store.peer(x.id));
  assert.equal(loss?.partner_id,c.id);assert.equal(loss?.restore_state,'gone');
});

for(const proofKind of ['native','marker'] as const)test(`托管 Claude 凭 ${proofKind} 证明重连，不创建用户租约且保留未知消息`,async t=>{
  const {store,c,x}=fixture(t),home=path.resolve('/managed/home'),managed=store.updatePeer(c.id,{owner:'nxbridge',state:'offline'}),pair=store.pair(c.id,x.id),message=store.accept(pair,x,'未知不可重发','uncertain');store.claim(message.id);store.recover();
  const input=registration('claude',c.sessionId!,{endpoint:{mode:'claude-inbox',address:'inbox-new',epoch:'new',pid:12345,procStart:'new-generation',configHome:home}});
  const proof:NativeOwnership={version:1,id:'launch-id',home,peerId:managed.id,configHome:home,phase:proofKind==='native'?'bound':'intent',handle:'native-handle',sessionId:c.sessionId!,createdAt:Date.now(),...(proofKind==='native'?{native:{pid:12345,startedAt:'new-generation'}}:{})};
  if(proofKind==='marker')input.ownedLaunch={peerId:managed.id,launchId:proof.id};
  const corroborate=async(value:NativeOwnership)=>({...value,phase:'bound' as const,native:{pid:12345,startedAt:'new-generation'}});
  const result=await managedRegistration(store,home,input,()=>proof,corroborate);
  assert.equal(result?.id,managed.id);assert.equal(result?.owner,'nxbridge');assert.equal(store.setting('takeover:'+managed.id),undefined);assert.equal(store.pairFor(managed.id)?.id,pair.id);assert.equal(store.message(message.id).state,'unknown');
  const binding=store.bindings.current(managed.id)!;input.expectedBinding={key:binding.key,epoch:binding.epoch};assert.equal((await managedRegistration(store,home,input,()=>proof,corroborate))?.id,managed.id);
});

test('名称相同、旧代次或已交用户的启动记录不能被当作自有重连',async t=>{
  const {store,c,x}=fixture(t),home=path.resolve('/managed/home');store.updatePeer(c.id,{owner:'nxbridge'});store.pair(c.id,x.id);
  const input=registration('claude',c.sessionId!,{name:'nxbridge-'+c.id,endpoint:{mode:'claude-inbox',address:'user',epoch:'user',pid:12345,procStart:'user',configHome:home}});
  const proof:NativeOwnership={version:1,id:'old',home,peerId:c.id,configHome:home,phase:'bound',sessionId:c.sessionId!,createdAt:0,native:{pid:12345,startedAt:'old'}};
  assert.equal(await managedRegistration(store,home,input,()=>proof),undefined);input.ownedLaunch={peerId:c.id,launchId:'old'};
  assert.equal(await managedRegistration(store,home,input,()=>proof),undefined,'继承环境标记不能单独证明归属');
  assert.equal(await managedRegistration(store,home,input,()=>({...proof,releasedToUser:true})),undefined);
});

test('单个不可解析成员不阻断其他配对，端点记录不被读取副作用删除',async t=>{
  const {store,broker,c,x}=fixture(t),pair=store.pair(c.id,x.id),bad=store.register(registration('codex','bad'));
  store.saveEndpoint({...store.endpoint(bad.id)!,pendingContext:true});
  const child=store.register(registration('codex','orphan-child'));store.updatePeer(child.id,{rootPeerId:bad.id,state:'paused'});
  (store as any).db.prepare('UPDATE peers SET data=? WHERE id=?').run('{invalid',bad.id);
  const message=store.accept(pair,x,'健康配对仍可投递','healthy-after-corruption');await broker.pump();
  assert.equal(store.message(message.id).state,'runtimeQueued');assert.doesNotThrow(()=>store.maintain());
  assert.equal(store.endpoints(bad.id).length,1);assert.ok(store.faults.status().some(row=>row.stage==='record:peer:'+bad.id));
});

test('持续降级在运行时通知和状态中可见，不额外唤醒或重发消息',async t=>{
  const {store,broker,c,x}=fixture(t),pair=store.pair(c.id,x.id);
  for(let i=0;i<3;i++)store.faults.failed('isolated_record',Error('变化的错误 '+i));
  (broker as any).runtimeHealth.refreshNoticeConditions(pair);
  const notice=new DeliveryHealth(store).peek(pair.id,c.id).find(value=>value.source==='broker_degraded');
  assert.equal(notice?.wake,false);assert.match(notice!.message,/doctor once/);
  assert.ok((broker.status() as any).capabilities.degraded.some((value:any)=>value.stage==='isolated_record'));
});

test('消失记录的降级状态在五分钟无活动后过期，稀疏错误不累计成永久降级',()=>{
  let now=1000;const faults=new FaultBoundary(()=>{},()=>now);
  for(let i=0;i<3;i++)faults.failed('deleted-record',Error('瞬态错误 '+i));assert.equal(faults.status()[0]!.degraded,true);
  now+=300001;assert.deepEqual(faults.status(),[]);assert.equal(faults.ready('deleted-record'),true);
  faults.failed('deleted-record',Error('新的错误'));assert.equal(faults.status()[0]!.count,1);
  now+=300001;faults.failed('deleted-record',Error('很晚的错误'));assert.equal(faults.status()[0]!.count,1);
});

test('成员暂时无法解析时保留接管租约、恢复预算和恢复记录',async t=>{
  const temp=temporaryDirectory(),filename=path.join(temp.directory,'bridge.db');let store=new Store(filename);
  t.after(async()=>{store.close();await temp.cleanup();});
  const c=store.register(registration('claude','corrupt')),x=store.register(registration('codex','partner')),pair=store.pair(c.id,x.id);
  const lease={id:'lease',peerId:c.id},budget={state:'unknown',attempts:[{id:'spent-attempt'}]},pending={peerId:c.id,input:registration('claude','corrupt'),state:'unverified',deadline:Date.now()+60000,nextAt:0};
  store.setSetting('takeover:'+c.id,lease);store.setSetting('managedRecovery:'+c.id,budget);store.setSetting('windowRecoveryPending',{[c.id]:pending});store.setSetting('managedSessionConflict:'+x.id,{memberId:c.id,pairId:pair.id});
  const db=(store as any).db,raw=db.prepare('SELECT data FROM peers WHERE id=?').get(c.id).data;db.prepare('UPDATE peers SET data=? WHERE id=?').run('{newer-version',c.id);store.close();store=new Store(filename);
  await new WindowRecovery(store,async()=>{throw Error('不可解析成员不得触发原生查询');}).retry(()=>{});store.maintain();
  assert.deepEqual(store.setting('takeover:'+c.id),lease);assert.deepEqual(store.setting('managedRecovery:'+c.id),budget);
  assert.deepEqual(store.setting<Record<string,unknown>>('windowRecoveryPending')?.[c.id],pending);assert.ok(store.setting('managedSessionConflict:'+x.id));
  assert.equal(store.endpoints(c.id).length,1);assert.equal((store as any).db.prepare('SELECT count(*) AS n FROM endpoints WHERE peer_id=?').get(c.id).n,1);
  (store as any).db.prepare('UPDATE peers SET data=? WHERE id=?').run(raw,c.id);assert.equal(store.endpoints(c.id).length,1);assert.equal(store.pairFor(c.id)?.id,pair.id);
});

test('自有记录新增枚举值和字段不被旧版读取器隐藏或丢弃',t=>{
  const {store,c}=fixture(t),db=(store as any).db;
  const future={...store.peer(c.id),state:'future-state',kind:'future-kind',future:{revision:2}};
  db.prepare('UPDATE peers SET data=? WHERE id=?').run(JSON.stringify(future),c.id);
  assert.deepEqual(store.getPeer(c.id),future);assert.ok(store.peers().some(peer=>peer.id===c.id));
  assert.deepEqual(store.faults.status(),[]);
});

test('设置解析失败回滚嵌套业务事务，原记录留在原表',t=>{
  const {store,c}=fixture(t),key='takeover:'+c.id,db=(store as any).db;store.setSetting(key,{});db.prepare('UPDATE settings SET value=? WHERE key=?').run('{invalid',key);
  assert.throws(()=>store.transaction(()=>{store.setSetting('must-rollback',true);store.transaction(()=>store.setting(key));}),{code:'record_invalid'});
  assert.equal(store.setting('must-rollback'),undefined);assert.equal(db.prepare('SELECT value FROM settings WHERE key=?').get(key).value,'{invalid');
});

for(const failure of ['intent','corroboration','read'] as const)test(`后台归属 ${failure} 未核验时用户窗口仍可登记并选择，不能自动接管`,async t=>{
  const {store,c,x}=fixture(t),home=path.resolve('/managed/uncertain'),pair=store.pair(c.id,x.id);store.updatePeer(c.id,{owner:'nxbridge'});
  const old=store.endpoint(c.id)!;store.saveEndpoint({...old,configHome:home});
  const input=registration('claude',c.sessionId!,{endpoint:{mode:'claude-inbox',address:'user-inbox',epoch:'user',pid:12345,procStart:'user-generation',configHome:home}});
  const proof:NativeOwnership={version:1,id:'pending-launch',peerId:c.id,home,configHome:home,phase:'intent',sessionId:c.sessionId!,createdAt:0,...(failure==='corroboration'?{handle:'handle'}:{})};
  const read=()=>{if(failure==='read')throw Error('归属记录无法读取');return proof;};
  const recovery=new WindowRecovery(store,async()=>['alive','dead'],undefined,undefined,value=>managedRegistration(store,home,value,read,async()=>{throw Error('原生进程核验失败');}));
  const user=await recovery.register(input);assert.notEqual(user.id,c.id);assert.equal(user.owner,'user');assert.equal(store.peer(c.id).owner,'nxbridge');assert.equal(store.pairFor(c.id)?.id,pair.id);assert.equal(store.setting('takeover:'+c.id),undefined);
  assert.equal((store.setting<any>('managedSessionConflict:'+c.id)).memberId,user.id);assert.equal((recovery.status(user.id) as any).state,'verifying');
});

test('被动归属核验有总时限并共享在途请求，超时后允许重新核验',async t=>{
  t.mock.timers.enable({apis:['Date','setTimeout'],now:1000});
  const adapter=new ClaudeAdapter(DEFAULT_CONFIG,path.resolve('/managed/probe'));t.after(()=>adapter.close());let calls=0;
  adapter.list=async()=>{calls++;return new Promise(()=>{});};
  const input=registration('claude','session',{endpoint:{mode:'claude-inbox',address:'inbox',epoch:'user',pid:12345,procStart:'generation',configHome:path.resolve('/managed/probe')}});
  const proof:NativeOwnership={version:1,id:'launch',home:path.resolve('/managed/probe'),peerId:'peer',configHome:input.endpoint.configHome!,phase:'intent',handle:'handle',sessionId:input.sessionId,createdAt:0};
  const first=adapter.corroborateRegistration(input,proof),second=adapter.corroborateRegistration(input,proof);t.mock.timers.tick(1500);
  await assert.rejects(first,{code:'managed_proof_unverified'});await assert.rejects(second,{code:'managed_proof_unverified'});assert.equal(calls,1);
  const retried=adapter.corroborateRegistration(input,proof);t.mock.timers.tick(1500);await assert.rejects(retried,{code:'managed_proof_unverified'});assert.equal(calls,2);
  adapter.list=async()=>{calls++;return[];};assert.equal(await adapter.corroborateRegistration(input,proof),undefined);assert.equal(calls,3);
  assert.equal(await adapter.corroborateRegistration({...input,endpoint:{...input.endpoint,procStart:'new-generation'}},proof),undefined);assert.equal(calls,4);
});

test('用户正在接管时，原生被动登记不能先采集新后台的停止权限',async t=>{
  const {store,c,x}=fixture(t),home=path.resolve('/managed/handoff');store.updatePeer(c.id,{owner:'nxbridge'});store.pair(c.id,x.id);
  const input=registration('claude',c.sessionId!,{endpoint:{mode:'claude-inbox',address:'new',epoch:'new',pid:12345,procStart:'new-generation',configHome:home}});
  const proof:NativeOwnership={version:1,id:'launch',home,peerId:c.id,configHome:home,phase:'bound',sessionId:c.sessionId!,handle:'handle',createdAt:0};
  const lease={id:'active-takeover'};store.setSetting('takeover:'+c.id,lease);let captures=0;
  assert.equal(await managedRegistration(store,home,input,()=>proof,async()=>{captures++;return{...proof,native:{pid:12345,startedAt:'new-generation'}};}),undefined);
  assert.equal(captures,0);assert.deepEqual(store.setting('takeover:'+c.id),lease);
});

test('损坏的单个冲突记录不会阻断其他未配对窗口的发送和配对检查',async t=>{
  const {store,broker,c,x}=fixture(t);store.pair(c.id,x.id);const key='managedSessionConflict:'+c.id;store.setSetting(key,{});(store as any).db.prepare('UPDATE settings SET value=? WHERE key=?').run('{invalid',key);
  const user=store.register(registration('claude','healthy-unpaired')),recovery=new WindowRecovery(store);
  const target=store.register(registration('codex','healthy-candidate'));
  assert.doesNotThrow(()=>recovery.assertUnbound(user));assert.equal(recovery.hold({actor:{host:'claude',memberId:user.id,sessionId:user.sessionId!,callId:'send'},message:'正常发送'},DEFAULT_CONFIG),undefined);
  const result=await broker.dispatch('send',{actor:{host:'claude',memberId:user.id,sessionId:user.sessionId!,callId:'selection'},message:'正常选择搭档'}) as any;assert.equal(result.status,'selection_required');assert.ok(result.candidates.some((value:any)=>value.member_id===target.id));
  assert.ok(store.faults.status().some(row=>row.stage==='managed_conflict_scan:'+c.id));
});

test('Claude 快速监测通道提供被动恢复信号，普通监测消费正文后同窗口不再提供',async t=>{
  const {store,broker,c,x}=fixture(t),home=broker.home,revision='a'.repeat(16);mkdirSync(path.join(home,'run'),{recursive:true});store.pair(c.id,x.id);
  const input=registration('claude',c.sessionId!,{endpoint:{mode:'claude-inbox',address:'inbox',epoch:'native',pid:process.pid,procStart:'generation',configHome:home,modRevision:revision}});store.adopt(c.id,input);
  const binding=store.bindings.current(c.id)!,actor={host:'claude' as const,memberId:c.id,sessionId:c.sessionId!,callId:'recovery',binding:{key:binding.key,epoch:binding.epoch}},native={pid:process.pid,procStart:'generation'},claimant={host:'claude' as const,peerId:c.id,sessionId:c.sessionId!,...native};
  writeFileSync(path.join(home,'sessions',native.pid+'.json'),JSON.stringify({sessionId:c.sessionId,pid:native.pid,procStart:native.procStart}),'utf8');
  for(const now of [1000,41000,81000,121001])await brokerOutageNotice(home,claimant,{now},async()=>['alive']);
  for(let now=122000;now<=242000;now+=30000)observeBrokerReachable(home,now);t.mock.timers.enable({apis:['Date'],now:243000});
  const signal=(await (broker as any).modRead(actor,'monitor',{sessionId:c.sessionId,native,revision},'native')).notices.find((notice:any)=>notice.id.startsWith('broker-recovered:'));
  assert.ok(signal);assert.equal(signal.wake,false);assert.equal(signal.message,undefined);
  const notice=(await broker.dispatch('health.monitor',{actor,notice_id:signal.id}) as any).notices.find((notice:any)=>notice.id===signal.id);assert.match(notice.message,/stably reachable/);assert.equal(notice.wake,false);
  assert.equal((await (broker as any).modRead(actor,'monitor',{sessionId:c.sessionId,native,revision},'native')).notices.some((notice:any)=>notice.id===signal.id),false);
});
