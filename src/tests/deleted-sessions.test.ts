import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import { DeletedSessions, sessionPresence, type SessionPresence } from '../broker/deleted-sessions.js';
import { Store } from '../storage/store.js';
import {DEFAULT_CONFIG} from '../config/defaults.js';
import {DeliveryError} from '../shared/errors.js';
import {type Peer,type Host} from '../types.js';
import { pairLoss } from '../broker/pairing/pair-loss.js';
import { pairLossView } from '../broker/pairing/pair-restore.js';
import { FakeAdapter } from './support/fake-adapter.js';
import {fixture, lifecycle} from './support/broker-fixture.js';
import { registration } from './support/registration.js';
import { temporary } from './support/temporary.js';
import { Broker, type Adapters } from '../broker/coordinator.js';
import { processIdentity } from '../process/process.js';
import { saveNativeOwnership, forgetNativeOwnership, type NativeOwnership } from '../process/owned-native.js';

async function unattended(t:TestContext,f:ReturnType<typeof fixture>){
  const native=await processIdentity(process.pid),configHome=temporary(t);
  f.store.updatePeer(f.c.id,{owner:'nxbridge'});f.store.saveEndpoint({...f.store.endpoint(f.c.id)!,pid:native.pid,procStart:native.startedAt,configHome});
  mkdirSync(path.join(configHome,'sessions'));writeFileSync(path.join(configHome,'sessions',native.pid+'.json'),JSON.stringify({sessionId:f.c.sessionId,procStart:native.startedAt}),'utf8');
  const proof:NativeOwnership={version:1,id:f.c.id,home:f.broker.home,peerId:f.c.id,configHome,phase:'bound',createdAt:Date.now(),sessionId:f.c.sessionId!,native:{pid:native.pid,startedAt:native.startedAt}};
  saveNativeOwnership(proof);t.after(()=>forgetNativeOwnership(proof));return native;
}

function setup(t:TestContext,options:{presence?:SessionPresence;implicit?:'never';deletedHost?:Host}={}){
  const store=new Store(':memory:');t.after(()=>store.close());
  const c=store.register(registration('claude','deleted-c')),x=store.register(registration('codex','deleted-x')),pair=store.pair(c.id,x.id);
  const dead=options.deletedHost==='claude'?c:x,survivor=dead.id===c.id?x:c;
  let presence:SessionPresence=options.presence??'present',failure=false,createCount=0;
  let beforePrepare:undefined|(()=>void);
  const prepared:string[]=[],cancelled:string[]=[],retired:string[]=[],alerted:string[]=[];
  const deps={holder:async()=> 'dead' as const,busy:()=>false,change:async<T>(_pair:unknown,work:()=>Promise<T>)=>work(),cancel:(id:string)=>{cancelled.push(id);},beforeCreate:()=>{},retire:(id:string)=>{retired.push(id);},notifyFailure:(peer:Peer)=>{alerted.push(peer.id);},presence:async()=>presence,
    prepare:async(target:Peer,_source:Peer,guard:()=>void,beforeCreate:()=>void)=>{
      beforePrepare?.();guard();prepared.push(target.id);
      if(!store.peer(target.id).sessionId){beforeCreate();createCount++;store.adopt(target.id,registration(target.host,'replacement-'+target.id));}
      if(failure)throw Error('模拟登记暂时失败');guard();
    }};
  const manager=new DeletedSessions(store,{...DEFAULT_CONFIG,implicit:options.implicit??'on-demand'},deps);
  return{store,c,x,pair,dead,survivor,manager,deps,prepared,cancelled,retired,alerted,setPresence:(value:SessionPresence)=>{presence=value;},setFailure:(value:boolean)=>{failure=value;},setBeforePrepare:(work:()=>void)=>{beforePrepare=work;},created:()=>createCount,markDeleted:()=>manager.deleted(dead,store.endpoint(dead.id)!)};
}

test('已核验删除在交互窗口解除绑定并通知；未知在场状态也不代选',async t=>{
  for(const presence of ['present','unknown'] as const){
    const f=setup(t,{presence});f.markDeleted();await f.manager.sweep();
    assert.equal(f.store.pairFor(f.survivor.id),undefined);
    assert.equal(f.store.pairById(f.pair.id)?.archived,true);
    const loss=pairLoss(f.store,f.survivor)!;
    assert.equal(loss.reason,'session_deleted');assert.equal(loss.deleted_member_id,f.dead.id);
    assert.equal(pairLossView(f.store,f.survivor)?.restore_state,'gone');
    assert.equal(f.created(),0);assert.deepEqual(new Set(f.cancelled),new Set([f.c.id,f.x.id]));
  }
});

test('两方向无人值守恢复只建一个新成员，附上下文，旧消息不重放',async t=>{
  for(const deletedHost of ['claude','codex'] as const){
    const f=setup(t,{presence:'absent',deletedHost});
    const safe=f.store.accept(f.pair,f.survivor,'确定未送达的任务','safe');
    const uncertain=f.store.accept(f.pair,f.survivor,'可能已执行的任务','uncertain');
    f.store.transition(uncertain.id,'sending','模拟发送中');
    const queued=f.store.accept(f.pair,f.survivor,'宿主已排队','queued');f.store.transition(queued.id,'runtimeQueued','模拟接收');
    f.store.setSetting('checkpoint:'+f.survivor.id,{pairId:f.pair.id,sessionId:f.survivor.sessionId,revision:2,path:'/tmp/current-task.md'});
    f.markDeleted();await Promise.all([f.manager.sweep(),f.manager.sweep()]);await f.manager.sweep(true);
    const next=f.store.pairFor(f.survivor.id)!;
    assert.notEqual(next.id,f.pair.id);assert.notEqual(next[deletedHost],f.dead.id);assert.equal(f.created(),1);
    assert.equal(f.store.message(safe.id).state,'expired');assert.equal(f.store.message(uncertain.id).state,'unknown');assert.equal(f.store.message(queued.id).state,'runtimeQueued');
    const messages=f.store.messagesFor(next.id);assert.equal(messages.length,1);assert.match(messages[0]!.body,/replacement bootstrap/);assert.match(messages[0]!.body,/current-task.md/);assert.match(messages[0]!.body,/"state":"unknown"/);
    assert.match(messages[0]!.callId,/^deleted-replacement:/);
    assert.equal(f.store.setting<any>('checkpoint:'+f.survivor.id).pairId,next.id);
    assert.equal(f.store.messagesFor(f.pair.id).length,3);assert.equal(f.store.endpoint(f.dead.id),undefined);
  }
});

test('普通离线、缺少持久化证据、外部归档不触发删除恢复',async t=>{
  const f=setup(t,{presence:'absent'});f.store.updatePeer(f.dead.id,{state:'offline'});
  await f.manager.sweep();assert.equal(f.store.pairFor(f.survivor.id)?.id,f.pair.id);assert.equal(f.created(),0);
                                      
  f.markDeleted();f.store.updatePeer(f.dead.id,{sessionId:'later-session'});await f.manager.sweep(true);
  assert.equal(f.store.pairFor(f.survivor.id)?.id,f.pair.id);
});

test('没有原生历史落盘凭据时巡检不额外连接用户运行时',async t=>{
  const f=setup(t);let probes=0;
  f.deps.holder=async()=>{probes++;return'dead' as const;};
  await f.manager.sweep(true);await f.manager.sweep(true);
  assert.equal(probes,0);assert.equal(f.store.pairFor(f.survivor.id)?.id,f.pair.id);
});

test('旧删除通知已消费且绑定原配对，不解除后来显式恢复的配对',async t=>{
  const f=setup(t);f.markDeleted();await f.manager.sweep();
  const next=f.store.pair(f.c.id,f.x.id);await f.manager.sweep(true);
  assert.equal(f.store.pairFor(f.survivor.id)?.id,next.id);assert.equal(f.created(),0);
});

test('暂停、关闭、禁用自动创建与用户解除优先于自动替换',async t=>{
  for(const gate of ['paused','disabled','never','unpaired'] as const){
    const f=setup(t,{presence:'absent',...(gate==='never'?{implicit:'never' as const}:{})});f.markDeleted();
    if(gate==='paused')f.store.setPaused(true,f.pair.id);
    if(gate==='disabled')f.store.updatePeer(f.survivor.id,{enabled:false});
    if(gate==='unpaired')f.store.unpair(f.pair.id);
    await f.manager.sweep();assert.equal(f.created(),0);
    assert.equal(!!f.store.pairFor(f.survivor.id),gate==='paused'||gate==='disabled');
  }
});

test('协调器重建和启动失败沿用已预留成员及已创建会话，状态可见',async t=>{
  const f=setup(t,{presence:'absent'});f.setFailure(true);f.markDeleted();await f.manager.sweep();
  const loss=pairLoss(f.store,f.survivor)!;assert.match(loss.replacement!.error,/模拟登记暂时失败/);assert.equal(f.created(),1);
  const key='deletedReplacement:'+f.survivor.id,claim=f.store.setting<any>(key);f.store.setSetting(key,{...claim,nextAt:0});f.setFailure(false);
  const restarted=new DeletedSessions(f.store,{...DEFAULT_CONFIG},f.deps);await restarted.sweep();
  assert.equal(f.created(),1);assert.deepEqual(f.prepared,[claim.memberId,claim.memberId]);assert.ok(f.store.pairFor(f.survivor.id));
});

test('创建确认超时或提交后崩溃不再创建，后来可信登记身份后继续同一会话',async t=>{
  const f=setup(t,{presence:'absent'});let submits=0;
  const prepare=f.deps.prepare;
  f.deps.prepare=async(_target,_source,guard,beforeCreate)=>{guard();beforeCreate();submits++;throw new DeliveryError('timeout','thread/start 结果不确定',true);};
  f.markDeleted();await f.manager.sweep();assert.equal(pairLoss(f.store,f.survivor)!.replacement!.state,'uncertain');
  const key='deletedReplacement:'+f.survivor.id,claim=f.store.setting<any>(key);
                                        
  f.store.setSetting(key,{...claim,state:'staged',nextAt:0});
  const restarted=new DeletedSessions(f.store,{...DEFAULT_CONFIG},f.deps);await restarted.sweep();assert.equal(submits,1);
  f.store.adopt(claim.memberId,registration(f.dead.host,'late-confirmed-session'));f.deps.prepare=prepare;
  await restarted.sweep(true);assert.equal(f.store.peer(claim.memberId).sessionId,'late-confirmed-session');assert.equal(f.created(),0);assert.equal(f.store.pairFor(f.survivor.id)![f.dead.host],claim.memberId);
});

test('创建前用户切换配对或拒绝替换不会启动；后续无人值守也保持拒绝',async t=>{
  const f=setup(t,{presence:'present'});f.markDeleted();await f.manager.sweep();
  const loss=pairLoss(f.store,f.survivor)!;f.store.setSetting('pairLoss:'+f.survivor.id,{...loss,replacement_suppressed:true});
  f.setPresence('absent');await f.manager.sweep(true);assert.equal(f.created(),0);
  f.store.setSetting('pairLoss:'+f.survivor.id,{...loss});
  f.setBeforePrepare(()=>{f.store.unpair(f.pair.id);f.store.setSetting('pairLoss:'+f.survivor.id,null);});
  await f.manager.sweep(true);assert.equal(f.created(),0);assert.equal(f.store.pairFor(f.survivor.id),undefined);
});

test('只有仍存活的自有后台视作无人值守，关闭窗口和 SDK 非交互保持未知',async t=>{
  const f=setup(t),peer=f.survivor,ep=f.store.endpoint(peer.id)!;
  f.store.saveEndpoint({...ep,nativeSession:{interactive:true}});
  assert.equal(await sessionPresence(f.store,peer,async()=>['alive']),'present');
  assert.equal(await sessionPresence(f.store,peer,async()=>['unknown']),'unknown');
  assert.equal(await sessionPresence(f.store,peer,async()=>['dead']),'unknown');
  f.store.saveEndpoint({...ep,nativeSession:{interactive:false}});
  assert.equal(await sessionPresence(f.store,peer,async()=>['alive']),'unknown');
  const owned=f.store.updatePeer(peer.id,{owner:'nxbridge'});
  assert.equal(await sessionPresence(f.store,owned,async()=>['alive']),'unknown');
  const home=temporary(t),proof:NativeOwnership={version:1,id:peer.id,home,peerId:peer.id,configHome:home,phase:'bound',createdAt:Date.now(),sessionId:peer.sessionId!,native:{pid:ep.pid!,startedAt:ep.procStart!}};
  saveNativeOwnership(proof);
  assert.equal(await sessionPresence(f.store,owned,async()=>['alive'],home),'absent');
  saveNativeOwnership({...proof,releasedToUser:true});assert.equal(await sessionPresence(f.store,owned,async()=>['alive'],home),'unknown');
  assert.equal(await sessionPresence(f.store,owned,async()=>['dead']),'unknown');
  f.store.saveEndpoint({...ep,nativeSession:undefined});
  assert.equal(await sessionPresence(f.store,peer,async()=>['alive']),'unknown');
});

test('Broker 保留删除恢复的部分启动预约，维护后沿用原会话，不重复创建',async t=>{
  const f=fixture(t,{implicit:'on-demand'});await unattended(t,f);const {store,broker,c,x,codex}=f;
  const pair=store.pair(c.id,x.id),create=codex.create.bind(codex);
  codex.create=async(...args)=>{const input=await create(...args);store.adopt(args[0].id,input);throw Error('创建已完成，返回登记暂时失败');};
                                   
  codex.emit('native',{address:store.endpoint(x.id)!.address,message:{method:'thread/deleted',params:{threadId:x.sessionId}}});
  await new Promise(resolve=>setImmediate(resolve));await broker.deletedSessions.sweep(true);
  const key='deletedReplacement:'+c.id,claim=store.setting<any>(key);assert.equal(claim.state,'failed');assert.equal(codex.created.length,1);
  (broker as any).maintain();await new Promise(resolve=>setImmediate(resolve));
  assert.equal(store.setting<any>('implicitPartner:'+c.id).peerId,claim.memberId);assert.equal(codex.released.length,0);
  codex.create=create;store.setSetting(key,{...claim,nextAt:0});await broker.deletedSessions.sweep(true);
  assert.notEqual(store.pairFor(c.id)?.id,pair.id);assert.equal(store.pairFor(c.id)?.codex,claim.memberId);assert.equal(codex.created.length,1);
});

for(const deletedHost of ['claude','codex'] as const)test('真实历史删除与找回可逆，辅助文件不妨碍判断：'+deletedHost,async t=>{
  const f=setup(t,{deletedHost}),home=temporary(t),directory=path.join(home,deletedHost==='claude'?'projects':'sessions','project');mkdirSync(directory,{recursive:true});
  const file=path.join(directory,f.dead.sessionId+'.jsonl'),body=JSON.stringify(deletedHost==='codex'?{type:'session_meta',payload:{id:f.dead.sessionId}}:{sessionId:f.dead.sessionId,type:'user'});
  writeFileSync(file,body+'\n','utf8');writeFileSync(path.join(directory,'notes.md'),'辅助笔记','utf8');
  const endpoint={...f.store.endpoint(f.dead.id)!,configHome:home,nativeSession:{transcriptPath:file}};f.store.saveEndpoint(endpoint);f.manager.observe(f.dead,endpoint);
  unlinkSync(file);await f.manager.sweep();
  assert.equal(f.store.pairFor(f.survivor.id),undefined);assert.equal(pairLoss(f.store,f.dead),undefined);
  assert.equal(pairLossView(f.store,f.survivor)!.restore_state,'gone');assert.equal(f.store.selections.candidates(f.survivor).some(candidate=>candidate.member_id===f.dead.id),false);
  writeFileSync(file,body+'\n','utf8');
  assert.equal(pairLossView(f.store,f.survivor)!.restore_state,'resumable');assert.equal(f.store.selections.candidates(f.survivor).some(candidate=>candidate.member_id===f.dead.id),true);
  f.setPresence('absent');await f.manager.sweep(true);
  assert.equal(f.created(),0);
});

test('删除成员的旧 needsHuman 状态不阻止通知，遗留结果保留给原接收方且不进入新简报',async t=>{
  const f=setup(t,{presence:'absent'}),result=f.store.accept(f.pair,f.dead,'原搭档的未读结果','old-result');
  const abandoned=f.store.accept(f.pair,f.survivor,'取消的旧任务正文','old-task');
  f.store.updatePeer(f.dead.id,{state:'needsHuman'});f.markDeleted();await f.manager.sweep();
  assert.equal(f.store.message(result.id).state,'held');assert.equal(f.store.message(abandoned.id).state,'expired');
  const next=f.store.pairFor(f.survivor.id)!;assert.ok(next);
  const bootstrap=f.store.messagesFor(next.id)[0]!.body;assert.doesNotMatch(bootstrap,/原搭档的未读结果|取消的旧任务正文/);assert.ok(f.retired.includes(f.dead.id));
});

test('安全失败只尝试三次，终止与不确定结果各通知幸存者一次',async t=>{
  const f=setup(t,{presence:'absent'});f.setFailure(true);f.markDeleted();
  const key='deletedReplacement:'+f.survivor.id;
  for(let i=0;i<3;i++){if(i)f.store.setSetting(key,{...f.store.setting<any>(key),nextAt:0});await f.manager.sweep(true);}
  assert.equal(f.prepared.length,3);assert.equal(pairLoss(f.store,f.survivor)!.replacement!.terminal,true);assert.deepEqual(f.alerted,[f.survivor.id]);
  assert.ok(f.retired.includes(f.store.setting<any>(key).memberId));
  await f.manager.sweep(true);assert.equal(f.prepared.length,3);assert.equal(f.alerted.length,1);
  const u=setup(t,{presence:'absent'});u.deps.prepare=async(_target,_source,guard,beforeCreate)=>{guard();beforeCreate();throw new DeliveryError('timeout','未知创建结果',true);};
  u.markDeleted();await u.manager.sweep();await u.manager.sweep(true);assert.deepEqual(u.alerted,[u.survivor.id]);
});

test('一组删除核验失败不阻止其他配对继续处理',async t=>{
  const f=setup(t),c=f.store.register(registration('claude','c2')),x=f.store.register(registration('codex','x2')),pair=f.store.pair(c.id,x.id),endpoint=f.store.endpoint(x.id)!;
  f.deps.change=async(selected,work)=>{if((selected as {id:string}).id===f.pair.id)throw Error('第一组核验失败');return work();};
  f.markDeleted();f.manager.deleted(x,endpoint);await f.manager.sweep();
  assert.equal(f.store.pairFor(f.survivor.id)?.id,f.pair.id);assert.equal(f.store.pairFor(c.id),undefined);assert.equal(f.store.pairById(pair.id)!.archived,true);
});

test('接手预约后关闭成员不会让一条失败交接阻断其他配对巡检',async t=>{
  const f=setup(t,{presence:'absent'});
  f.deps.prepare=async(_target,_source,_guard,beforeCreate)=>{beforeCreate();throw new DeliveryError('timeout','创建结果未核验',true);};
  f.markDeleted();await f.manager.sweep(true);
  const claim=f.store.setting<any>('deletedReplacement:'+f.survivor.id);
  f.store.pair(f.survivor.host==='claude'?f.survivor.id:claim.memberId,f.survivor.host==='codex'?f.survivor.id:claim.memberId);
  f.store.adopt(claim.memberId,registration(f.dead.host,'late-identity'));f.store.updatePeer(f.survivor.id,{enabled:false});
  const c=f.store.register(registration('claude','other-c')),x=f.store.register(registration('codex','other-x')),pair=f.store.pair(c.id,x.id);
  f.manager.deleted(x,f.store.endpoint(x.id)!);await f.manager.sweep(true);
  assert.equal(f.store.pairById(pair.id)!.archived,true);
});

test('删除巡检等待创建时不阻塞其他配对的消息泵',async t=>{
  const f=fixture(t),pair=f.store.pair(f.c.id,f.x.id);assert.ok(pair);
  let finish!:()=>void,entered!:()=>void;const blocked=new Promise<void>(resolve=>finish=resolve),started=new Promise<void>(resolve=>entered=resolve);
  t.mock.method(f.broker.deletedSessions,'sweep',()=>{entered();return blocked;});
  f.broker.send({actor:{host:'codex',sessionId:'x',callId:'independent'},message:'其他配对继续投递'},false);
  const pumping=f.broker.pump();await started;
  let timer:NodeJS.Timeout|undefined;
  try{await Promise.race([pumping,new Promise<never>((_resolve,reject)=>{timer=setTimeout(()=>reject(Error('删除巡检阻塞消息泵')),5000);})]);assert.equal(f.claude.delivered.length,1);}
  finally{clearTimeout(timer);finish();await pumping;}
});

test('同一原生会话的 hook 和提问重新登记保留会话事实，换代不继承',t=>{
  const f=setup(t),input=registration('claude','native',{endpoint:{mode:'claude-inbox',address:'facts',epoch:'native',pid:process.pid,procStart:'native',configHome:temporary(t),nativeSession:{interactive:true,transcriptPath:'/native.jsonl'}}});
  const peer=f.store.register(input);
  for(const nativeSession of [{transcriptPath:'/native.jsonl'},undefined])f.store.register({...input,endpoint:{...input.endpoint,nativeSession}});
  assert.deepEqual(f.store.endpoint(peer.id)!.nativeSession,{interactive:true,transcriptPath:'/native.jsonl'});
  const later=f.store.register({...input,endpoint:{...input.endpoint,procStart:'later',nativeSession:undefined}});assert.equal(f.store.endpoint(later.id)!.nativeSession,undefined);
});

test('实际 Broker 允许找回历史后恢复原配对，托管接管不能绕过历史缺失',async t=>{
  const f=fixture(t),home=temporary(t),directory=path.join(home,'sessions');mkdirSync(directory);
  const file=path.join(directory,'x.jsonl'),body=JSON.stringify({type:'session_meta',payload:{id:'x'}})+'\n';writeFileSync(file,body,'utf8');
  const endpoint={...f.store.endpoint(f.x.id)!,configHome:home,nativeSession:{transcriptPath:file}};f.store.saveEndpoint(endpoint);f.broker.deletedSessions.observe(f.x,endpoint);
  const pair=f.store.pair(f.c.id,f.x.id);f.broker.deletedSessions.deleted(f.x,endpoint);unlinkSync(file);await f.broker.deletedSessions.sweep(true);
  await assert.rejects(f.broker.dispatch('pair.restore',{pair_id:pair.id}),{code:'pair_restore_unavailable'});
                           
  await assert.rejects((f.broker as any).hostingTarget({peer_id:f.x.id},true),{code:'pair_restore_unavailable'});
  await assert.rejects((f.broker as any).hostingTarget({pair_id:pair.id},true),{code:'pair_restore_unavailable'});
  const actor={host:'claude',sessionId:'c',callId:'restore-picker'};
  const initial=await f.broker.dispatch('pair.code',{actor}) as {selection_id:string};
  writeFileSync(path.join(directory,'moved.jsonl'),body,'utf8');
  const refreshed=await f.broker.dispatch('pair.selection.refresh',{actor,selection_id:initial.selection_id}) as {candidates:{member_id:string}[]};
  assert.ok(refreshed.candidates.some(candidate=>candidate.member_id===f.x.id));
  const restored=await f.broker.dispatch('pair.restore',{pair_id:pair.id}) as {restored:boolean};
  assert.equal(restored.restored,true);assert.equal(f.store.pairFor(f.c.id)?.id,pair.id);
});

test('原生 Claude 回收归属后保留启动来源，找回历史可按原会话和配置恢复',async t=>{
  const home=temporary(t),nativeHome=temporary(t),store=new Store(':memory:'),claude=new FakeAdapter(),codex=new FakeAdapter();
  const broker=new Broker(store,{...DEFAULT_CONFIG,implicit:'never'},{claude,codex} as unknown as Adapters,home);
  t.after(async()=>{await broker.stop();store.close();});
  const directory=path.join(nativeHome,'projects','project');mkdirSync(directory,{recursive:true});
  const file=path.join(directory,'original.jsonl'),body=JSON.stringify({type:'user',sessionId:'original'})+'\n';writeFileSync(file,body,'utf8');
  const registered=store.register(registration('claude','original',{endpoint:{mode:'claude-inbox',address:'old-native',epoch:'old-native',pid:2147483647,procStart:'dead-native',configHome:nativeHome,nativeSession:{transcriptPath:file}}})),peer=store.updatePeer(registered.id,{owner:'nxbridge'}),other=store.register(registration('codex','survivor')),pair=store.pair(peer.id,other.id);
  const proof:NativeOwnership={version:1,id:peer.id,home,peerId:peer.id,sessionId:peer.sessionId!,configHome:nativeHome,phase:'bound',createdAt:Date.now(),executable:process.execPath,native:{pid:2147483647,startedAt:'dead-native'}};
  saveNativeOwnership(proof);claude.release=async()=>{forgetNativeOwnership(proof);};
  let affinity:unknown;
  claude.wake=async(_peer,_endpoint,_signal,beforeLaunch,saved?:unknown)=>{affinity=saved;await beforeLaunch?.();};
  broker.deletedSessions.observe(peer,store.endpoint(peer.id)!);broker.deletedSessions.deleted(peer,store.endpoint(peer.id)!);
  unlinkSync(file);await broker.deletedSessions.sweep(true);await new Promise(resolve=>setImmediate(resolve));await (broker as any).runtimeHealth.waitForIdle();
  assert.equal(store.pairFor(peer.id),undefined);assert.equal(store.setting<any>('managedLaunchProof:'+peer.id).nativeLaunchId,proof.id);
  writeFileSync(file,body,'utf8');
  const restored=await broker.dispatch('pair.restore',{pair_id:pair.id}) as {restored:boolean};
  assert.equal(restored.restored,true);assert.equal(store.peer(peer.id).sessionId,'original');
  assert.equal((affinity as {configHome:string}).configHome,nativeHome);assert.equal((affinity as {nativeLaunchId:string}).nativeLaunchId,proof.id);
  assert.equal(store.peer(peer.id).launchFailure,undefined);
  assert.equal(store.setting('managedLaunchProof:'+peer.id),null);
  await lifecycle(broker).prepare(store.peer(peer.id));
  assert.equal((affinity as {configHome:string}).configHome,nativeHome,'再次恢复仍沿用已登记的原配置目录');
});

test('自动创建尚未返回时用户选择同一预留搭档只创建一次',async t=>{
  const f=fixture(t,{implicit:'on-demand'});await unattended(t,f);
  f.store.pair(f.c.id,f.x.id);
  let finish!:()=>void,entered!:()=>void;const gate=new Promise<void>(resolve=>finish=resolve),started=new Promise<void>(resolve=>entered=resolve),create=f.codex.create.bind(f.codex);
  f.codex.create=async(...args)=>{entered();await gate;return create(...args);};
  f.broker.deletedSessions.deleted(f.x,f.store.endpoint(f.x.id)!);const replacing=f.broker.deletedSessions.sweep(true);await started;
  const claim=f.store.setting<any>('deletedReplacement:'+f.c.id),actor={host:'claude' as const,sessionId:'c',callId:'choose'};
  const draft={actor,message:'用户接手后附带的任务'};
  const selection=f.store.selections.create(f.store.peer(f.c.id),actor,f.broker.config,draft,'pair_lost') as {selection_id:string};
  const choosing=f.broker.dispatch('pair.selection.commit',{actor,selection_id:selection.selection_id,action:'create'});
  try{
    finish();await choosing;await replacing;
    assert.equal(f.codex.created.length,1);assert.equal(f.store.pairFor(f.c.id)?.codex,claim.memberId);assert.ok(f.store.peer(claim.memberId).sessionId);
    const messages=f.store.messagesFor(f.store.pairFor(f.c.id)!.id);
    assert.equal(messages.filter(message=>message.callId==='deleted-replacement:'+claim.lossId).length,1);
    assert.equal(messages[0]!.callId,'deleted-replacement:'+claim.lossId);assert.equal(messages[1]!.body,draft.message);
  }
  finally{finish();await replacing;}
});

test('选择原预约后启动在提交前失败，后续创建仍保留一份背景简报',async t=>{
  const f=fixture(t,{implicit:'on-demand'});await unattended(t,f);f.store.pair(f.c.id,f.x.id);
  const create=f.codex.create.bind(f.codex);let finish!:()=>void,entered!:()=>void;
  const gate=new Promise<void>(resolve=>finish=resolve),started=new Promise<void>(resolve=>entered=resolve);
  f.codex.create=async()=>{entered();await gate;throw new DeliveryError('timeout','尚未提交原生创建',false);};
  f.broker.deletedSessions.deleted(f.x,f.store.endpoint(f.x.id)!);const replacing=f.broker.deletedSessions.sweep(true);await started;
  const claim=f.store.setting<any>('deletedReplacement:'+f.c.id),actor={host:'claude',sessionId:'c',callId:'pre-submit-handoff'};
  const selection=await f.broker.dispatch('pair.code',{actor}) as {selection_id:string};
  const choosing=f.broker.dispatch('pair.selection.commit',{actor,selection_id:selection.selection_id,action:'create'});
  try{
    finish();await choosing;await replacing;f.codex.create=create;
    await f.broker.deletedSessions.sweep(true);
    await lifecycle(f.broker).prepare(f.store.peer(claim.memberId));await f.broker.deletedSessions.sweep(true);
    assert.equal(f.codex.created.length,1);
    assert.equal(f.store.messagesFor(f.store.pairFor(f.c.id)!.id).filter(message=>message.callId==='deleted-replacement:'+claim.lossId).length,1);
    assert.equal(f.store.setting<any>('deletedReplacement:'+f.c.id).state,'ready');
  }finally{finish();await replacing;}
});

test('不确定创建会向仍存活的自有后台投递终止通知一次',async t=>{
  const f=fixture(t,{implicit:'on-demand'});await unattended(t,f);f.store.pair(f.c.id,f.x.id);
  f.codex.create=async(...args)=>{await args[4]?.();throw new DeliveryError('timeout','创建已提交，响应未知',true);};
  f.broker.deletedSessions.deleted(f.x,f.store.endpoint(f.x.id)!);await f.broker.deletedSessions.sweep(true);
                                     
  await new Promise(resolve=>setImmediate(resolve));await (f.broker as any).runtimeHealth.waitForIdle();
  assert.equal(f.claude.delivered.length,1);assert.match(f.claude.delivered[0]!.body,/no 2nd auto create/);
  await f.broker.deletedSessions.sweep(true);assert.equal(f.claude.delivered.length,1);
});

test('原生提交前的超时保留安全重试，提交后超时才停止重复创建',async t=>{
  const f=fixture(t,{implicit:'on-demand'});await unattended(t,f);f.store.pair(f.c.id,f.x.id);
  f.codex.create=async()=>{throw new DeliveryError('timeout','运行时连接超时，尚未提交创建',true);};
  f.broker.deletedSessions.deleted(f.x,f.store.endpoint(f.x.id)!);await f.broker.deletedSessions.sweep(true);
  const key='deletedReplacement:'+f.c.id,first=f.store.setting<any>(key);
  assert.equal(first.state,'failed');assert.equal(first.creationPending,false);
  let submitted=0;f.codex.create=async(...args)=>{await args[4]?.();submitted++;throw new DeliveryError('timeout','原生创建已提交，响应未知',true);};
  f.store.setSetting(key,{...first,nextAt:0});await f.broker.deletedSessions.sweep(true);
  assert.equal(f.store.setting<any>(key).state,'uncertain');assert.equal(f.store.setting<any>(key).creationPending,true);
  await f.broker.deletedSessions.sweep(true);assert.equal(submitted,1);
});

test('用户接手创建结果不确定的预留成员后不再创建，可信身份回来只补一次简报',async t=>{
  const f=fixture(t,{implicit:'on-demand'});await unattended(t,f);f.store.pair(f.c.id,f.x.id);
  let finish!:()=>void,entered!:()=>void,submits=0;const gate=new Promise<void>(resolve=>finish=resolve),started=new Promise<void>(resolve=>entered=resolve);
  f.codex.create=async(...args)=>{await args[4]?.();submits++;entered();await gate;throw new DeliveryError('timeout','原生创建响应未知',true);};
  f.broker.deletedSessions.deleted(f.x,f.store.endpoint(f.x.id)!);const replacing=f.broker.deletedSessions.sweep(true);await started;
  const claim=f.store.setting<any>('deletedReplacement:'+f.c.id),actor={host:'claude',sessionId:'c',callId:'choose-uncertain'};
  const selection=await f.broker.dispatch('pair.code',{actor}) as {selection_id:string};
  const choosing=f.broker.dispatch('pair.selection.commit',{actor,selection_id:selection.selection_id,action:'create'}) as Promise<{status:string}>;
  try{
    finish();const chosen=await choosing;await replacing;assert.equal(chosen.status,'launch_precondition');assert.equal(submits,1);assert.equal(f.store.peer(claim.memberId).sessionId,null);
    await assert.rejects(lifecycle(f.broker).prepare(f.store.peer(claim.memberId)),{code:'session_unverified'});
    await f.broker.deletedSessions.sweep(true);assert.equal(f.broker.deletedSessions.pendingCreation(claim.memberId),true);
    f.store.adopt(claim.memberId,registration('codex','late-native-identity'));await f.broker.deletedSessions.sweep(true);await f.broker.deletedSessions.sweep(true);
    assert.equal(submits,1);assert.equal(f.store.pairFor(f.c.id)?.codex,claim.memberId);assert.equal(f.store.messagesFor(f.store.pairFor(f.c.id)!.id).filter(message=>message.callId==='deleted-replacement:'+claim.lossId).length,1);
  }finally{finish();await replacing;}
});
