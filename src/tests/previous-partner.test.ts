import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {fixture, lifecycle} from './support/broker-fixture.js';
import { registration } from './support/registration.js';
import { recordFixtureLaunch } from './support/native-launch.js';
import { formatPairInventory, resolvePairMember } from '../app/commands/pair-command.js';
import { pairLoss, pairLossKey } from '../broker/pairing/pair-loss.js';
import { restorableOwnedPartner, partnerConfigHome } from '../broker/pairing/pair-restore.js';
import { forgetNativeOwnership, nativeOwnership } from '../process/owned-native.js';
import {BridgeError} from '../shared/errors.js';
import {type Host,type Peer} from '../types.js';
import { listenBroker } from '../ipc/ipc.js';
import {ensureHome} from '../ipc/home.js';

type Fixture=ReturnType<typeof fixture>;
function history(f:Fixture,peer:Peer):string{
  const home=f.broker.home,file=path.join(home,peer.host==='codex'?'sessions':'projects/test',peer.sessionId+'.jsonl');
  mkdirSync(path.dirname(file),{recursive:true});
  writeFileSync(file,JSON.stringify(peer.host==='codex'?{type:'session_meta',payload:{id:peer.sessionId,cwd:peer.cwd}}:{sessionId:peer.sessionId})+'\n','utf8');
  f.store.saveEndpoint({...f.store.endpoint(peer.id)!,configHome:home});
  f.store.updatePeer(peer.id,{owner:'nxbridge',state:'offline'});recordFixtureLaunch(f.store,home,f.store.peer(peer.id));
  return file;
}
const actor=(peer:Peer,callId:string)=>({host:peer.host,memberId:peer.id,sessionId:peer.sessionId!,callId});
async function select(f:Fixture,source:Peer,target:Peer,callId:string){
  const a=actor(source,callId),view=await f.broker.dispatch('pair.code',{actor:a}) as any,candidate=view.candidates.find((value:any)=>value.member_id===target.id);
  assert.ok(candidate,'候选应包含指定的原成员：'+JSON.stringify({peer:f.store.peer(target.id),restorable:restorableOwnedPartner(f.store,f.store.peer(target.id)),endpoints:f.store.endpoints(target.id)}));
  const choice={actor:a,selection_id:view.selection_id,key:candidate.key,action:'choose'},result=await f.broker.dispatch('pair.selection.commit',choice) as any;
  return{result,choice,view};
}

for(const host of ['codex','claude'] as Host[])test('反复切换后可接回原后台会话，历史去重并保持幂等：'+host,async t=>{
  const f=fixture(t),source=host==='codex'?f.c:f.x,original=host==='codex'?f.x:f.c;history(f,original);
  if(host==='claude'){
    const discover=f.claude.discover.bind(f.claude);
    f.claude.discover=async sessionId=>{const input=(await discover(sessionId))!;return{...input,endpoint:{...input.endpoint,configHome:f.broker.home}};};
  }
  const next=f.store.register(registration(host,'next-'+host));f.store.pair(f.c.id,f.x.id);
  for(let index=0;index<2;index++){
    await select(f,source,next,'switch-'+index);await lifecycle(f.broker).waitForRelease(original.id);
    const restored=await select(f,source,original,'return-'+index);
    assert.equal(restored.result.restored_previous_partner,true);assert.equal(f.store.peer(original.id).sessionId,original.sessionId);
    assert.equal(restored.view.candidates.filter((value:any)=>value.member_id===original.id).length,1);
    assert.deepEqual(await f.broker.dispatch('pair.selection.commit',restored.choice),restored.result);
  }
  assert.equal(f.codex.created.length+f.claude.created.length,0);assert.equal(f.store.messages().length,0);
  const latest=f.store.pairFor(source.id)!;f.store.unpair(latest.id,{reason:'broker_shutdown'});
  await f.broker.dispatch('pair.restore',{pair_id:latest.id});assert.equal(f.store.pairFor(source.id)?.id,latest.id);
  assert.equal(pairLoss(f.store,source),undefined);
  if(host==='codex'){
    f.store.unpair(latest.id);
    const adopted=await(f.broker as any).hostingTarget({peer_id:original.id},true) as Peer;
    assert.equal(adopted.id,original.id);assert.equal(f.store.pairFor(source.id)?.id,latest.id,'同一搭档的多条历史应取最近记录');
  }
});

test('只有历史后台候选的首次发信必须询问；恢复后清除回收预约且只保存一次草稿',async t=>{
  const f=fixture(t,{implicit:'on-demand'});history(f,f.x);const old=f.store.pair(f.c.id,f.x.id);f.store.unpair(old.id);f.store.deactivate(f.x.id);
  f.store.setSetting('processRetirements',{[f.x.id]:{attempts:2,nextAt:0}});
  const a=actor(f.c,'history-first-send'),view=await f.broker.dispatch('send',{actor:a,message:'接回后继续'}) as any;
  assert.equal(view.status,'selection_required');assert.equal(view.candidates.length,1);assert.equal(view.candidates[0].former_partner,true);
  const resolved=await f.broker.dispatch('pair.selection.resolve',{actor:a,selection_id:view.selection_id}) as any;
  assert.equal(resolved.status,'selection_required');assert.equal(f.codex.created.length,0);assert.equal(f.store.messages().length,0);
  const choice={actor:a,selection_id:view.selection_id,key:resolved.candidates[0].key},result=await f.broker.dispatch('pair.selection.commit',choice) as any;
  assert.equal(f.store.message(result.message_id).body,'接回后继续');assert.equal(f.store.peer(f.x.id).sessionId,f.x.sessionId);
  assert.equal((f.store.setting<any>('processRetirements')??{})[f.x.id],undefined);
  assert.deepEqual(await f.broker.dispatch('pair.selection.commit',choice),result);assert.equal(f.store.messages().length,1);
});

for(const cause of ['missing','claimed','session','disabled','owner'] as const)test('提交历史选择时重新核验，失败保留当前搭档：'+cause,async t=>{
  const f=fixture(t),file=history(f,f.x),old=f.store.pair(f.c.id,f.x.id),next=f.store.register(registration('codex','current'));
  f.store.pair(f.c.id,next.id,true);const current=f.store.pairFor(f.c.id)!,a=actor(f.c,'stale-'+cause),view=await f.broker.dispatch('pair.code',{actor:a}) as any,candidate=view.candidates.find((value:any)=>value.member_id===f.x.id);
  assert.ok(candidate);assert.notEqual(current.id,old.id);
  if(cause==='missing')rmSync(file);
  if(cause==='claimed')f.store.pair(f.store.register(registration('claude','claim')).id,f.x.id);
  if(cause==='session')f.store.updatePeer(f.x.id,{sessionId:'another-session'});
  if(cause==='disabled')f.store.updatePeer(f.x.id,{enabled:false});
  if(cause==='owner')f.store.updatePeer(f.x.id,{owner:'user'});
  await assert.rejects(f.broker.dispatch('pair.selection.commit',{actor:a,selection_id:view.selection_id,key:candidate.key}));
  assert.equal(f.store.pairFor(f.c.id)?.id,current.id);assert.equal(f.codex.created.length,0);assert.equal(f.store.messages().length,0);
});

test('CLI 列表和选择器区分历史成员与运行窗口，重复会话仍需成员 ID',async t=>{
  const f=fixture(t);history(f,f.x);const old=f.store.pair(f.c.id,f.x.id);f.store.unpair(old.id);f.store.deactivate(f.x.id);
  const inventory=await f.broker.dispatch('pair.inventory',{}) as any;
  assert.equal(inventory.previous_partners.filter((value:any)=>value.member_id===f.x.id).length,1);
  assert.ok(!inventory.members.some((value:any)=>value.member_id===f.x.id));
  assert.equal(resolvePairMember(inventory,'codex',f.x.id),f.x.id);assert.equal(resolvePairMember(inventory,'codex',f.x.sessionId!),f.x.id);
  const formatted=formatPairInventory(inventory);assert.ok(formatted.includes('之前的后台搭档'));assert.ok(formatted.includes(f.x.id));
  const duplicate={...inventory.previous_partners[0],member_id:'alias'};
  assert.throws(()=>resolvePairMember({...inventory,previous_partners:[...inventory.previous_partners,duplicate]},'codex',f.x.sessionId!),{code:'ambiguous_context'});
  const result=await f.broker.dispatch('pair',{claude:f.c.id,codex:resolvePairMember(inventory,'codex',f.x.sessionId!)}) as any;
  assert.equal(result.restored_members[0].member_id,f.x.id);assert.equal(f.store.peer(f.x.id).sessionId,f.x.sessionId);
  f.store.unpair(result.id);await f.broker.dispatch('pair.restore',{pair_id:result.id});assert.equal(f.store.pairFor(f.c.id)?.id,result.id,'主动切换历史也能显式恢复，不依赖丢失记录');
});

test('另一成员持有原会话时拒绝后台恢复；核验期间的新窗口也阻止提交',async t=>{
  const f=fixture(t);history(f,f.x);const old=f.store.pair(f.c.id,f.x.id);f.store.unpair(old.id);f.store.deactivate(f.x.id);
                               
  (f.store as any).db.prepare('DELETE FROM endpoints WHERE peer_id=?').run(f.x.id);
  const a=actor(f.c,'holder'),view=await f.broker.dispatch('pair.code',{actor:a}) as any,candidate=view.candidates.find((value:any)=>value.member_id===f.x.id);
  const alias=f.store.register(registration('codex',f.x.sessionId!,{endpoint:{mode:'embedded',address:'alias',epoch:'alias',configHome:f.broker.home,pid:process.pid,procStart:'alias'}}));
  lifecycle(f.broker).nativeSessionState=async()=> 'alive';
  await assert.rejects(f.broker.dispatch('pair.selection.commit',{actor:a,selection_id:view.selection_id,key:candidate.key}),{code:'foreground_active'});
  assert.equal(f.store.pairFor(f.c.id),undefined);
  lifecycle(f.broker).nativeSessionState=async()=>{f.store.saveEndpoint({...f.store.endpoint(alias.id)!,epoch:'new-window'});return'dead';};
  await assert.rejects(f.broker.dispatch('pair.selection.commit',{actor:a,selection_id:view.selection_id,key:candidate.key}),{code:'session_changed'});
  assert.equal(f.store.pairFor(f.c.id),undefined);
});

test('离线用户窗口不进入后台恢复列表；缺失的后台历史不绕过 RPC 检查',async t=>{
  const f=fixture(t),old=f.store.pair(f.c.id,f.x.id);f.store.unpair(old.id);f.store.updatePeer(f.x.id,{state:'offline'});f.store.deactivate(f.x.id);
  assert.equal(restorableOwnedPartner(f.store,f.store.peer(f.x.id)),false);
  assert.equal((await f.broker.dispatch('pair.inventory',{}) as any).previous_partners.length,0);
  f.store.updatePeer(f.x.id,{owner:'nxbridge'});
  await assert.rejects(f.broker.dispatch('pair',{claude:f.c.id,codex:f.x.id}),{code:'pair_restore_unavailable'});
  assert.equal(f.store.pairFor(f.c.id),undefined);
  await assert.rejects(f.broker.dispatch('open',{host:'codex',peer_id:f.x.id}),error=>/nxbridge pair/.test(String(error)));
});

test('普通切换回收 Claude 前保存原启动来源，无删除凭据也能恢复原会话',async t=>{
  const f=fixture(t);history(f,f.c);const ownership=nativeOwnership(f.broker.home,f.c.id)!;
  f.claude.release=async peer=>{f.claude.released.push(peer);forgetNativeOwnership(ownership);};
  const discover=f.claude.discover.bind(f.claude);f.claude.discover=async sessionId=>{const input=(await discover(sessionId))!;return{...input,endpoint:{...input.endpoint,configHome:f.broker.home}};};
  f.store.pair(f.c.id,f.x.id);const next=f.store.register(registration('claude','replacement-claude'));
  await f.broker.dispatch('pair',{claude:next.id,codex:f.x.id,replace:true});await lifecycle(f.broker).waitForRelease(f.c.id);
  const saved=f.store.setting<any>('managedLaunchProof:'+f.c.id);assert.equal(saved.nativeLaunchId,ownership.id);assert.equal(saved.configHome,ownership.configHome);
  assert.equal(nativeOwnership(f.broker.home,f.c.id),undefined);
  await f.broker.dispatch('pair',{claude:f.c.id,codex:f.x.id,replace:true});assert.equal(f.store.peer(f.c.id).sessionId,f.c.sessionId);assert.equal(f.store.setting('managedLaunchProof:'+f.c.id),null);
});

for(const host of ['codex','claude'] as Host[])for(const entry of ['picker','rpc','restore'] as const)test('恢复已提交后启动失败仍返回原配对与消息回执：'+host+'/'+entry,async t=>{
  const f=fixture(t),target=host==='codex'?f.x:f.c,source=host==='codex'?f.c:f.x;
  history(f,target);const original=f.store.pair(f.c.id,f.x.id);f.store.unpair(original.id);f.store.deactivate(target.id);
  const adapter=host==='codex'?f.codex:f.claude,error=new BridgeError('plugin_unavailable','原后台暂未完成登记');
  if(host==='codex')adapter.attachFailure=error;else adapter.fail=error;
  let result:any;
  if(entry==='picker'){
    const a=actor(source,'failed-start'),view=await f.broker.dispatch('send',{actor:a,message:'只保存一次的恢复任务'}) as any;
    const candidate=view.candidates.find((value:any)=>value.member_id===target.id),choice={actor:a,selection_id:view.selection_id,key:candidate.key};
    result=await f.broker.dispatch('pair.selection.commit',choice) as any;
    assert.equal(f.store.message(result.message_id).body,'只保存一次的恢复任务');assert.match(result.message,/不要重发/);
    const retried=await f.broker.dispatch('pair.selection.commit',choice) as any;
    assert.equal(retried.message_id,result.message_id);assert.equal(f.store.messages().length,1);
  }else if(entry==='rpc'){
    const next=f.store.register(registration(host,'next-failed-start')),current=f.store.pair(source.host==='claude'?source.id:next.id,source.host==='codex'?source.id:next.id);
    const cancelled=f.store.accept(current,source,'还未投递','old-unsent'),uncertain=f.store.accept(current,source,'结果未知','old-uncertain');
    f.store.transition(uncertain.id,'sending');f.store.transition(uncertain.id,'unknown');
    result=await f.broker.dispatch('pair',{claude:f.c.id,codex:f.x.id,replace:true}) as any;
    assert.deepEqual(result.cancelled_message_ids,[cancelled.id]);assert.deepEqual(result.uncertain_message_ids,[uncertain.id]);
    assert.equal(f.store.message(uncertain.id).state,'unknown');
  }else result=await f.broker.dispatch('pair.restore',{pair_id:original.id}) as any;
  assert.equal(result.status,'launch_precondition');assert.equal(result.launch_precondition.code,'plugin_unavailable');
  if(entry!=='picker'){
    const retried=await f.broker.dispatch(entry==='rpc'?'pair':'pair.restore',entry==='rpc'?{claude:f.c.id,codex:f.x.id,replace:true}:{pair_id:original.id}) as any;
    assert.equal(retried.status,'launch_precondition','重复操作仍如实返回同一个未解决的启动前置条件');
  }
  assert.equal(f.store.pairFor(source.id)?.[host],target.id);assert.equal(f.store.peer(target.id).sessionId,target.sessionId);
  assert.equal(f.codex.created.length+f.claude.created.length,0);
});

test('历史扫描观察可复用；提交与显式重新打开列表会刷新历史变化',async t=>{
  const f=fixture(t),file=history(f,f.x),pair=f.store.pair(f.c.id,f.x.id);f.store.unpair(pair.id);f.store.deactivate(f.x.id);
  assert.equal(restorableOwnedPartner(f.store,f.store.peer(f.x.id)),true);rmSync(file);
  assert.equal(restorableOwnedPartner(f.store,f.store.peer(f.x.id)),true,'普通候选读取复用观察，不重复递归扫描');
  assert.equal(restorableOwnedPartner(f.store,f.store.peer(f.x.id),undefined,true),false,'提交必须重新核验');
  writeFileSync(file,JSON.stringify({type:'session_meta',payload:{id:f.x.sessionId}})+'\n','utf8');
  assert.equal(restorableOwnedPartner(f.store,f.store.peer(f.x.id)),false);
  assert.ok((await f.broker.dispatch('pair.inventory',{}) as any).previous_partners.some((candidate:any)=>candidate.member_id===f.x.id));
});

test('无关丢失提示被清除不阻止选择另一个历史后台',async t=>{
  const f=fixture(t);history(f,f.x);f.store.pair(f.c.id,f.x.id);
  const next=f.store.register(registration('codex','lost-other')),last=f.store.pair(f.c.id,next.id,true);f.store.unpair(last.id,{reason:'broker_shutdown'});f.store.deactivate(f.x.id);
  const a=actor(f.c,'unrelated-loss'),view=await f.broker.dispatch('pair.code',{actor:a}) as any,candidate=view.candidates.find((value:any)=>value.member_id===f.x.id);
  assert.ok(candidate);f.store.setSetting(pairLossKey(f.c.id),null);
  await f.broker.dispatch('pair.selection.commit',{actor:a,selection_id:view.selection_id,key:candidate.key});
  assert.equal(f.store.pairFor(f.c.id)?.codex,f.x.id);
});

for(const unavailable of ['gone','unverified'] as const)test('未配对发信重新核验暂时不可用的历史，不因失败缓存新建后台：'+unavailable,async t=>{
  const f=fixture(t,{implicit:'on-demand'}),file=history(f,f.x),pair=f.store.pair(f.c.id,f.x.id);f.store.unpair(pair.id);f.store.deactivate(f.x.id);rmSync(file);
  const home=unavailable==='gone'?f.broker.home:path.join(f.broker.home,'reconnected-home');
  f.store.setSetting('managedLaunchProof:'+f.x.id,{sessionId:f.x.sessionId,runtimeId:'original-runtime',configHome:home});
  assert.equal(restorableOwnedPartner(f.store,f.store.peer(f.x.id)),false);
  const restored=path.join(home,'sessions',f.x.sessionId+'.jsonl');mkdirSync(path.dirname(restored),{recursive:true});writeFileSync(restored,JSON.stringify({type:'session_meta',payload:{id:f.x.sessionId}})+'\n','utf8');
  const view=await f.broker.dispatch('send',{actor:actor(f.c,'history-back-'+unavailable),message:'继续原会话'}) as any;
  assert.equal(view.status,'selection_required');assert.ok(view.candidates.some((candidate:any)=>candidate.member_id===f.x.id));assert.equal(f.codex.created.length,0);
});

for(const cause of ['released','auto','conflict','takeover'] as const)test('归档后台的已知启动限制在选择前排除，提交时也重新核验：'+cause,async t=>{
  const f=fixture(t),target=cause==='auto'?f.c:f.x,source=cause==='auto'?f.x:f.c;history(f,target);
  const pair=f.store.pair(f.c.id,f.x.id);f.store.unpair(pair.id);f.store.deactivate(target.id);
  const a=actor(source,'blocked-'+cause),view=await f.broker.dispatch('pair.code',{actor:a}) as any,candidate=view.candidates.find((value:any)=>value.member_id===target.id);assert.ok(candidate);
  if(cause==='released')f.store.setSetting('hosting:'+target.id,{memberId:target.id,sessionId:target.sessionId,pairId:pair.id,released:true});
  if(cause==='auto')f.store.setSetting('claudeAutoFallback:'+target.id,{old_session_id:target.sessionId,pair_id:pair.id,phase:'launching'});
  if(cause==='conflict')f.store.setSetting('managedSessionConflict:'+target.id,{pairId:pair.id});
  if(cause==='takeover')f.store.setSetting('takeover:'+target.id,{sessionId:target.sessionId});
  assert.equal(restorableOwnedPartner(f.store,f.store.peer(target.id)),false);
  assert.ok(!(await f.broker.dispatch('pair.inventory',{}) as any).previous_partners.some((value:any)=>value.member_id===target.id));
  await assert.rejects(f.broker.dispatch('pair.selection.commit',{actor:a,selection_id:view.selection_id,key:candidate.key}),{code:'pair_restore_unavailable'});
  assert.equal(f.store.pairFor(source.id),undefined);
});

test('旧版回收的 Codex 没有运行时副本凭据时仍可从原会话历史进入恢复',async t=>{
  const f=fixture(t);history(f,f.x);const pair=f.store.pair(f.c.id,f.x.id);f.store.unpair(pair.id);f.store.deactivate(f.x.id);f.store.setSetting('managedLaunchProof:'+f.x.id,null);
  assert.equal(restorableOwnedPartner(f.store,f.store.peer(f.x.id)),true);
  const restored=await select(f,f.c,f.x,'legacy-codex');assert.equal(restored.result.status,'paired');assert.equal(f.store.peer(f.x.id).sessionId,f.x.sessionId);assert.equal(f.codex.created.length,0);
});

for(const host of ['codex','claude'] as Host[])test('启动来源目录优先于较新的不同目录端点，核验与启动沿用同一目录：'+host,async t=>{
  const f=fixture(t),target=host==='codex'?f.x:f.c,source=host==='codex'?f.c:f.x;history(f,target);
  const home=f.broker.home,wrong=path.join(home,'another-home');mkdirSync(wrong);
  if(host==='claude')f.store.setSetting('managedLaunchProof:'+target.id,{sessionId:target.sessionId,configHome:home});
  f.store.saveEndpoint({...f.store.endpoint(target.id)!,epoch:'new-wrong-home',configHome:wrong,seenAt:Date.now()+100});
  const pair=f.store.pair(f.c.id,f.x.id);f.store.unpair(pair.id,{reason:'broker_shutdown'});f.store.deactivate(target.id);
  assert.equal(pairLoss(f.store,source)?.partner_config_home,home);assert.equal(partnerConfigHome(f.store,f.store.peer(target.id)),home);
  let launched:string|undefined;
  if(host==='codex'){
    f.codex.attach=async()=>{throw new BridgeError('endpoint_unavailable','旧端点已退出');};
    f.codex.ensureEndpoint=async(_cwd,_peer,_requester,_session,configHome,beforeLaunch)=>{launched=configHome;await beforeLaunch?.();return'new-endpoint';};
  }else{
    f.claude.wake=async(_peer,_endpoint,_signal,beforeLaunch,affinity?:{configHome?:string})=>{launched=affinity?.configHome;await beforeLaunch?.();};
  }
  const result=await f.broker.dispatch('pair.restore',{pair_id:pair.id}) as any;
  assert.equal(result.restored,true);assert.equal(launched,home);
});

test('两种 CLI 恢复入口均展示已保留的配对和启动前置条件',async t=>{
  const f=fixture(t);await ensureHome(f.broker.home);const methods:string[]=[],pending={status:'launch_precondition',pair_id:'old-pair',launch_precondition:{code:'plugin_unavailable',message:'请等待原会话登记。'}};
  const server=await listenBroker(f.broker.home,async method=>{
    methods.push(method);
    if(method==='ping')return{pid:process.pid};
    if(method==='pair.inventory')return{pairs:[],members:f.store.selections.inventory()};
    assert.ok(method==='pair'||method==='pair.restore');return pending;
  });
  t.after(()=>server.close());
  for(const args of [['--restore','old-pair'],['--claude',f.c.id,'--codex',f.x.id]]){
    const script=`import{pairCommand}from${JSON.stringify(new URL('../app/commands/pair-command.js',import.meta.url).href)};await pairCommand(${JSON.stringify(args)});`;
    const result=await promisify(execFile)(process.execPath,['--input-type=module','-e',script],{env:{...process.env,NXBRIDGE_HOME:f.broker.home},windowsHide:true,timeout:15000});
    assert.match(result.stdout,/请等待原会话登记。配对已保留，不用重新配对/);assert.doesNotMatch(result.stdout,/会在后台接着原来的会话运行/);
  }
  assert.ok(methods.includes('pair.restore'));assert.ok(methods.includes('pair'));
});
