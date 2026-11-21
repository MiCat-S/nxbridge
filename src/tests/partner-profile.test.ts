import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture, lifecycle} from './support/broker-fixture.js';
import { temporary } from './support/temporary.js';
import { registration } from './support/registration.js';
import { PartnerProfiles, modelProfileSchema, profileChangeFailure } from '../broker/profiles/partner-profile.js';
import {DEFAULT_CONFIG} from '../config/defaults.js';
import {DeliveryError} from '../shared/errors.js';
import {type Endpoint,type ModelProfile,type Peer} from '../types.js';
import { Store } from '../storage/store.js';
import { frozenProfiles } from '../broker/profiles/frozen-profile.js';
import { ownedCodexPolicy, startOwnedCodex } from '../hosts/owned-launch-policy.js';
import type { RpcClient } from '../ipc/rpc.js';
import { CodexAdapter } from '../hosts/codex/adapter.js';
import { ClaudeAdapter } from '../hosts/claude/adapter.js';
import { saveManagedRuntime } from '../hosts/managed-runtimes.js';
import { managedMarker } from '../install/installation.js';
import { randomUUID } from 'node:crypto';
import {atomicJson} from '../shared/files.js';
import { claudeChild, claudeChildFile, type ClaudeChildRecord } from '../hosts/claude/claude-child.js';
import { formatPartnerProfile } from '../app/commands/partner-profile-command.js';
import { mkdirSync } from 'node:fs';

const actor={host:'claude' as const,sessionId:'c',callId:'profile'};
function owned(t:Parameters<typeof fixture>[0]){
  const f=fixture(t);f.store.pair(f.c.id,f.x.id);f.store.updatePeer(f.x.id,{owner:'nxbridge',state:'ready',model:'old',effort:'low'});
  const calls:ModelProfile[]=[];
  (f.codex as unknown as {setProfile:(peer:Peer,endpoint:Endpoint,profile:ModelProfile,guard:()=>void)=>Promise<ModelProfile>}).setProfile=async(peer,_endpoint,profile,guard)=>{guard();calls.push(profile);return{model:peer.model,effort:peer.effort,...profile};};
  return{...f,calls};
}

test('搭档设置在空闲时核验生效，观察事件不覆盖持久选择；reset 保持当前会话设置',async t=>{
  const f=owned(t),before=f.store.peer(f.x.id).sessionId;
  const result=await f.broker.dispatch('partner.profile',{actor,action:'set',model:'chosen',effort:'high'}) as any;
  assert.equal(result.status,'applied');assert.deepEqual(result.effective,{model:'chosen',effort:'high'});assert.equal(f.store.peer(f.x.id).sessionId,before);
  f.codex.emit('profile',before,{model:'observed',effort:'low'},f.store.endpoint(f.x.id)!.address);
  assert.deepEqual(f.broker.profiles.requested(f.store.peer(f.x.id)),{model:'chosen',effort:'high'});
  f.broker.config.partnerProfiles={codex:{model:'default-now',effort:'medium'}};
  const reset=await f.broker.dispatch('partner.profile',{actor,action:'reset'}) as any;
  assert.equal(reset.status,'applied');assert.deepEqual(reset.requested,{});assert.equal(f.calls.length,1);assert.equal(reset.effective.model,'observed');
});

test('忙碌及等待人工时保存选择，不中断；安全空闲点一次应用',async t=>{
  const f=owned(t);f.store.updatePeer(f.x.id,{state:'busy'});
  const result=await f.broker.dispatch('partner.profile',{actor,action:'set',model:'next'}) as any;
  assert.equal(result.status,'pending');assert.equal(f.calls.length,0);assert.equal(f.broker.profiles.blocks(f.store.peer(f.x.id)),true);
  f.store.updatePeer(f.x.id,{state:'needsHuman'});
  await (f.broker as any).profileCoordination.apply(f.store.peer(f.x.id));assert.equal(f.calls.length,0);
  f.store.updatePeer(f.x.id,{state:'ready'});
  await (f.broker as any).profileCoordination.apply(f.store.peer(f.x.id));
  assert.equal(f.calls.length,1);assert.equal(f.broker.profiles.view(f.store.peer(f.x.id)).status,'applied');assert.equal(f.broker.profiles.blocks(f.store.peer(f.x.id)),false);
});

test('待生效的模型选择不允许取走新消息；用户接管后不再影响用户窗口',t=>{
  const f=owned(t),pair=f.store.pairFor(f.x.id)!,message=f.store.accept(pair,f.c,'等待模型切换','held-profile'),receiver={host:'codex' as const,sessionId:'x',callId:'held-pickup'};
  f.broker.profiles.set(f.store.peer(f.x.id),{model:'next'});
  const held=f.broker.receive(receiver) as any;
  assert.equal(held.status,'held');assert.deepEqual(held.messages,[]);assert.equal(held.partner_profile.delivery_held,true);assert.equal(f.store.message(message.id).state,'accepted');
  f.store.updatePeer(f.x.id,{owner:'user'});
  assert.equal(f.broker.profiles.blocks(f.store.peer(f.x.id)),false);
  const received=f.broker.receive(receiver) as any;assert.equal(received.status,'received');assert.equal(received.messages[0].message_id,message.id);
});

test('投递异步核验期间新增模型选择，最后提交边界仍保留原消息',async t=>{
  const f=owned(t);f.store.updatePeer(f.c.id,{owner:'nxbridge',state:'ready'});let checked=false;
  f.claude.deliver=async(_peer,_endpoint,message)=>{
    await Promise.resolve();f.broker.profiles.set(f.store.peer(f.c.id),{model:'next'});checked=true;
    assert.equal(await message.beforeSubmit!(),false);return{state:'expired',evidence:'模型选择等待核验'};
  };
  const message=f.store.accept(f.store.pairFor(f.c.id)!,f.x,'切换前已进入投递路径','profile-race');
  await f.broker.pump();assert.equal(checked,true);assert.equal(f.store.message(message.id).state,'accepted');
});

test('核验不符或回执超时保留失败与选择，不自动重试或继续按旧模型投递',async t=>{
  const f=owned(t);
  (f.codex as any).setProfile=async()=>({model:'wrong',effort:'low'});
  let result=await f.broker.dispatch('partner.profile',{actor,action:'set',model:'chosen'}) as any;
  assert.equal(result.status,'failed');assert.equal(result.error.code,'profile_verification_failed');assert.equal(f.broker.profiles.blocks(f.store.peer(f.x.id)),true);
  let attempts=0;(f.codex as any).setProfile=async()=>{attempts++;throw Object.assign(Error('回执超时'),{code:'timeout'});};
  result=await f.broker.dispatch('partner.profile',{actor,action:'set',effort:'high'}) as any;
  assert.equal(result.status,'failed');assert.equal(result.error.code,'timeout');assert.equal(attempts,1);
  await (f.broker as any).profileCoordination.apply(f.store.peer(f.x.id));assert.equal(attempts,1);
  assert.deepEqual(result.requested,{model:'chosen',effort:'high'});
});

test('设置回读期间关闭成员不确认过期结果，失败后释放跨域互斥',async t=>{
  const f=owned(t),adapter=f.codex as unknown as Pick<CodexAdapter,'setProfile'>,original=adapter.setProfile;let release!:()=>void,entered!:()=>void;
  const started=new Promise<void>(resolve=>entered=resolve),waiting=new Promise<void>(resolve=>release=resolve);
  adapter.setProfile=async()=>{entered();await waiting;return{model:'stale'};};
  const pending=f.broker.dispatch('partner.profile',{actor,action:'set',model:'stale'});
  try{await started;assert.equal(lifecycle(f.broker).isRestarting(f.x.id),true);f.store.updatePeer(f.x.id,{enabled:false});}
  finally{release();}
  const failed=await pending as any;
  assert.equal(failed.status,'failed');assert.equal(failed.error.code,'session_changed');assert.equal(failed.effective.model,'old');
  assert.equal(lifecycle(f.broker).isRestarting(f.x.id),false);
  adapter.setProfile=original;f.store.updatePeer(f.x.id,{enabled:true});
  const applied=await f.broker.dispatch('partner.profile',{actor,action:'set',model:'fresh'}) as any;
  assert.equal(applied.status,'applied');assert.equal(applied.effective.model,'fresh');
});

test('拒绝用户窗口、子代理、自身宿主与不支持的 Claude 会话变更',async t=>{
  const f=owned(t);
  f.store.updatePeer(f.x.id,{owner:'user'});
  await assert.rejects(f.broker.dispatch('partner.profile',{actor,action:'set',model:'x'}),{code:'process_owned_by_user'});
  await assert.rejects(f.broker.dispatch('partner.profile',{actor:{...actor,via:'child'},action:'set',model:'x'}),{code:'subagent_denied'});
  await assert.rejects(f.broker.dispatch('partner.profile',{actor,host:'claude',action:'set',model:'x'}),{code:'invalid_target'});
  f.store.updatePeer(f.c.id,{owner:'nxbridge'});
  await assert.rejects(f.broker.dispatch('partner.profile',{host:'claude',peer_id:f.c.id,action:'set',model:'next'}),{code:'profile_change_unsupported'});
  assert.equal(f.broker.profiles.intent(f.store.peer(f.c.id)),undefined);
});

test('新建默认配置只解析一次；冻结仅采集新后台的同事件配置',t=>{
  const home=temporary(t),store=new Store(':memory:');t.after(()=>store.close());
  const config={...DEFAULT_CONFIG,partnerProfiles:{codex:{model:'first',source:'frozen' as const}}},profiles=new PartnerProfiles(store,home,config);
  const x=store.placeholder('codex',home);profiles.initialize(x);config.partnerProfiles.codex.model='later';profiles.initialize(x);
  assert.deepEqual(profiles.requested(x),{model:'first'});
  store.adopt(x.id,registration('codex','created',{model:'first',effort:'low'}));
  profiles.observed(store.peer(x.id),{effort:'low'});assert.deepEqual(frozenProfiles(home,config),{});
  profiles.observed(store.peer(x.id),{model:'first',effort:'low'});assert.equal(frozenProfiles(home,config).codex?.model,'first');
  const existing=store.register(registration('codex','existing',{model:'existing'}));profiles.initialize(existing);assert.deepEqual(profiles.requested(existing),{});
});

test('模型和 effort 输入不限定模型列表，拒绝空值；零值及逐字段修改保留',()=>{
  assert.deepEqual(modelProfileSchema.parse({model:' custom-provider/new ',effort:0}),{model:'custom-provider/new',effort:0});
  for(const input of [{model:''},{model:' '},{effort:''},{effort:NaN},{effort:-1}])assert.equal(modelProfileSchema.safeParse(input).success,false);
});

test('创建时只指定一个字段仍逐字段继承默认值；明确拒绝不拦住原会话',async t=>{
  const f=owned(t);f.broker.config.partnerProfiles={codex:{model:'default',effort:'high'}};
  const fresh=f.store.placeholder('codex',f.c.cwd);f.broker.profiles.set(fresh,{model:'picked'});
  assert.deepEqual(f.broker.profiles.requested(fresh),{model:'picked',effort:'high'});
  (f.codex as any).setProfile=async()=>{throw Object.assign(Error('宿主拒绝参数'),{code:-32602});};
  const result=await f.broker.dispatch('partner.profile',{actor,action:'set',model:'rejected'}) as any;
  assert.equal(result.status,'failed');assert.equal(result.delivery_held,false);assert.equal(result.effective.model,'old');
});

test('Claude 别名保留原请求并以已核验解析结果判断观察，偏离选择时拦住后续投递',t=>{
  const f=owned(t);f.store.updatePeer(f.c.id,{owner:'nxbridge',model:'previous',effort:'low'});const peer=f.store.peer(f.c.id);
  f.broker.profiles.set(peer,{model:'opus',effort:'high'});
  f.broker.profiles.applied(peer,{model:'claude-opus-current',effort:'high',requestedModel:'opus'});
  assert.deepEqual(f.broker.profiles.requested(peer),{model:'opus',effort:'high'});assert.equal(f.broker.profiles.view(f.store.peer(peer.id)).status,'applied');
  f.broker.profiles.observed(f.store.peer(peer.id),{model:'claude-opus-current',effort:'high'});assert.equal(f.broker.profiles.blocks(peer),false);
  f.broker.profiles.observed(f.store.peer(peer.id),{model:'other'});assert.equal(f.broker.profiles.blocks(peer),true);
});

test('新 Claude 的请求先等待原生回读，不能把任意首个模型当成别名解析结果',async t=>{
  const f=owned(t),peer=f.store.placeholder('claude',f.c.cwd);
  f.broker.profiles.set(peer,{model:'opus',effort:'high'});
  f.store.adopt(peer.id,registration('claude','new-profile',{model:'different',effort:'low'}));
  const current=f.store.peer(peer.id);f.broker.profiles.observed(current,{model:'different',effort:'low'});
  assert.equal(f.broker.profiles.intent(current)?.resolved,undefined);assert.equal(f.broker.profiles.view(current).status,'pending');assert.equal(f.broker.profiles.blocks(current),true);
  await (f.broker as any).profileCoordination.verifyInitial(current);
  assert.equal(f.broker.profiles.view(current).status,'pending');assert.equal(f.broker.profiles.blocks(current),true);
  f.store.saveEndpoint({...f.store.endpoint(peer.id)!,nativeProfile:{model:'claude-opus-current',flag:{model:'opus',effort:'high'},effective:{model:'opus',effort:'high'},observedAt:Date.now()}});
  await (f.broker as any).profileCoordination.verifyInitial(current);
  assert.equal(f.broker.profiles.view(f.store.peer(peer.id)).status,'applied');assert.equal(f.broker.profiles.blocks(current),false);assert.equal(f.store.peer(peer.id).model,'claude-opus-current');
});

test('新 Claude 原生设置或环境覆盖与选择冲突时，首份任务保持暂缓',async t=>{
  for(const profile of [{flag:{model:'different',effort:'high'},effective:{model:'different',effort:'high'}},{flag:{model:'opus',effort:'high'},effective:{model:'policy',effort:'high'}},{flag:{model:'opus',effort:'high'},effective:{model:'opus',effort:'high'},effortOverride:'low'}]){
    const f=owned(t),peer=f.store.placeholder('claude',f.c.cwd);f.broker.profiles.set(peer,{model:'opus',effort:'high'});
    f.store.adopt(peer.id,registration('claude','conflict'));
    f.store.saveEndpoint({...f.store.endpoint(peer.id)!,nativeProfile:{model:'claude-opus-current',...profile,observedAt:Date.now()}});
    await (f.broker as any).profileCoordination.verifyInitial(f.store.peer(peer.id));
    const view=f.broker.profiles.view(f.store.peer(peer.id));assert.equal(view.status,'failed');assert.equal(view.delivery_held,true);assert.equal(view.requested?.model,'opus');
  }
});

test('新 Codex 启动和安全权限降级都保留模型与 effort；不采用请求时清理空线程',async()=>{
  const calls:{method:string;params:any}[]=[];let starts=0;
  const rpc={request:async(method:string,params:any)=>{calls.push({method,params});if(method==='thread/start'){starts++;return{thread:{id:'new'},model:'chosen',reasoningEffort:'high',...(starts===1?{approvalPolicy:'on-request',approvalsReviewer:'user',sandbox:{type:'workspaceWrite'}}:{approvalPolicy:'never',approvalsReviewer:'user',sandbox:{type:'dangerFullAccess'}})};}return{};}} as RpcClient;
  await startOwnedCodex(rpc,'/project','prompting',undefined,undefined,{model:'chosen',effort:'high'});
  const requests=calls.filter(call=>call.method==='thread/start');assert.equal(requests.length,2);
  for(const call of requests){assert.equal(call.params.model,'chosen');assert.equal(call.params.config.model_reasoning_effort,'high');}
  assert.equal(requests[1]!.params.approvalPolicy,ownedCodexPolicy('bypass').approvalPolicy);
  (rpc as any).request=async(method:string)=>method==='thread/start'?{thread:{id:'wrong'},model:'wrong',approvalPolicy:'never',approvalsReviewer:'user',sandbox:{type:'dangerFullAccess'}}:{};
  await assert.rejects(startOwnedCodex(rpc,'/project','bypass',undefined,undefined,{model:'chosen'}),{code:'profile_verification_failed'});
});

test('提交边界区分读取失败与提交后回读失败，不让 RPC 缺省 uncertain=false 丢掉不确定性',()=>{
  for(const submitted of [false,true]){
    const error=profileChangeFailure(new DeliveryError('timeout','读取超时'),submitted);
    assert.equal(error.uncertain,submitted);
  }
  assert.equal(profileChangeFailure(Object.assign(new DeliveryError('disconnected','连接失败'),{phase:'prepare'}),true).uncertain,false);
  assert.equal(profileChangeFailure(Object.assign(Error('明确拒绝'),{code:-32602}),true).uncertain,false);
  assert.equal(profileChangeFailure(Object.assign(Error('回读拒绝'),{code:-32602}),true,true).uncertain,true);
  assert.equal(profileChangeFailure(profileChangeFailure(Object.assign(Error('回读拒绝'),{code:'claude_control_rejected'}),true,true),true).uncertain,true);
});

test('Codex 长会话设置只读取摘要；提交前失败不暂停，提交后超时保留不确定性',async t=>{
  const home=temporary(t),store=new Store(':memory:');t.after(()=>store.close());
  const peer=store.register(registration('codex','long-session'));store.updatePeer(peer.id,{owner:'nxbridge'});
  const current=store.peer(peer.id),endpoint=store.endpoint(peer.id)!;
  saveManagedRuntime(home,{id:randomUUID(),peerId:peer.id,owner:managedMarker(home),kind:'owned',state:'ready',endpoint:endpoint.address,createdAt:Date.now()});
  const adapter=new CodexAdapter(DEFAULT_CONFIG,home);t.after(()=>adapter.close());
  const calls:{method:string;params:any}[]=[];let fail:'pre'|'post'|undefined,rejected=false;
  (adapter as any).connect=async()=>({request:async(method:string,params:any)=>{
    calls.push({method,params});if(method==='thread/read'&&(fail==='pre'||fail==='post'&&calls.some(call=>call.method==='thread/settings/update')))throw new DeliveryError(rejected?'-32602':'timeout','宿主回读失败');
    return{thread:{id:peer.sessionId,status:{type:'idle'},model:'chosen',reasoningEffort:'high'}};
  }});
  fail='pre';await assert.rejects(adapter.setProfile(current,endpoint,{model:'chosen'},()=>{}),{uncertain:false});
  assert.equal(calls.some(call=>call.method==='thread/settings/update'),false);
  calls.length=0;fail='post';await assert.rejects(adapter.setProfile(current,endpoint,{model:'chosen'},()=>{}),{uncertain:true});
  assert.deepEqual(calls[0],{method:'thread/read',params:{threadId:peer.sessionId,includeTurns:false}});
  assert.equal(calls.filter(call=>call.method==='thread/settings/update').length,1);
  calls.length=0;rejected=true;await assert.rejects(adapter.setProfile(current,endpoint,{model:'chosen'},()=>{}),{uncertain:true});
  calls.length=0;fail=undefined;assert.deepEqual(await adapter.readProfile(current,endpoint,()=>{}),{model:'chosen',effort:'high'});
  assert.deepEqual(calls,[{method:'thread/read',params:{threadId:peer.sessionId,includeTurns:false}}]);
});

test('提交后超时由只读核对解除暂停，不重发设置；原生代次变化后再次核验',async t=>{
  const f=owned(t);let mutations=0,reads=0,now=Date.now();t.mock.method(Date,'now',()=>now);
  (f.codex as any).setProfile=async()=>{mutations++;throw profileChangeFailure(new DeliveryError('timeout','回读超时'),true);};
  (f.codex as any).readProfile=async()=>{reads++;return{model:'chosen',effort:'high'};};
  const failed=await f.broker.dispatch('partner.profile',{actor,action:'set',model:'chosen',effort:'high'}) as any;
  assert.equal(failed.delivery_held,true);
  await (f.broker as any).profileCoordination.reconcile(f.store.peer(f.x.id));
  assert.equal(f.broker.profiles.blocks(f.store.peer(f.x.id)),false);assert.equal(reads,1);assert.equal(mutations,1);
  const previous=f.store.endpoint(f.x.id)!;f.store.deactivate(f.x.id);f.store.saveEndpoint({...previous,epoch:'new-native'});
  assert.equal(f.broker.profiles.blocks(f.store.peer(f.x.id)),true);assert.match(formatPartnerProfile({host:'codex',...f.broker.profiles.view(f.store.peer(f.x.id))}),/正在重新核对/);
  (f.codex as any).readProfile=async()=>{reads++;return{model:'wrong',effort:'high'};};
  await (f.broker as any).profileCoordination.reconcile(f.store.peer(f.x.id));assert.equal(reads,1,'核对间隔内不重复读取宿主设置');
  now+=5001;await (f.broker as any).profileCoordination.reconcile(f.store.peer(f.x.id));
  assert.equal(f.broker.profiles.view(f.store.peer(f.x.id)).status,'failed');assert.equal(f.broker.profiles.blocks(f.store.peer(f.x.id)),true);
  (f.codex as any).readProfile=async()=>{reads++;return{model:'chosen',effort:'high'};};
  now+=5001;await (f.broker as any).profileCoordination.reconcile(f.store.peer(f.x.id));
  assert.equal(f.broker.profiles.blocks(f.store.peer(f.x.id)),false);assert.equal(reads,3);assert.equal(mutations,1);
});

test('失败后的部分事件不能借用旧成员字段解除暂停',t=>{
  const f=owned(t),peer=f.store.peer(f.x.id);f.broker.profiles.set(peer,{model:'old',effort:'low'});
  f.broker.profiles.failed(peer,profileChangeFailure(new DeliveryError('timeout','回执不明'),true));
  f.broker.profiles.observed(peer,{model:'old'});assert.equal(f.broker.profiles.blocks(peer),true);
  f.broker.profiles.observed(peer,{model:'old',effort:'low'});assert.equal(f.broker.profiles.blocks(peer),false);
  f.broker.profiles.failed(peer,new DeliveryError('profile_verification_failed','跨进程核验已确认不符',false));assert.equal(f.broker.profiles.blocks(peer),true);
});

test('首次 Claude 回读超时保持 pending，较晚的真实原生快照可解锁',async t=>{
  const f=owned(t),peer=f.store.placeholder('claude',f.c.cwd);f.broker.profiles.set(peer,{model:'opus',effort:'high'});
  f.store.adopt(peer.id,registration('claude','late-profile'));
  const current=f.store.peer(peer.id);f.broker.profiles.waiting(current,new DeliveryError('timeout','原生尚未就绪'));
  assert.equal(f.broker.profiles.intent(current)?.status,'pending');assert.equal(f.broker.profiles.blocks(current),true);
  f.store.saveEndpoint({...f.store.endpoint(peer.id)!,nativeProfile:{model:'claude-opus-current',flag:{model:'opus',effort:'high'},effective:{model:'opus',effort:'high'},observedAt:Date.now()}});
  await (f.broker as any).profileCoordination.verifyInitial(current);
  assert.equal(f.broker.profiles.blocks(f.store.peer(peer.id)),false);
});

test('Claude child 尚在启动时保留首次核验，晚到的原生回读解除暂停',async t=>{
  const f=owned(t),peer=f.store.placeholder('claude',f.c.cwd),home=(f.broker as any).home;
  f.broker.profiles.set(peer,{model:'opus',effort:'high'});f.store.adopt(peer.id,registration('claude','starting-child'));
  mkdirSync(home+'/run',{recursive:true});atomicJson(claudeChildFile(home,peer.id),{version:1,peerId:peer.id,sessionId:'starting-child',phase:'starting'});
  const native=new ClaudeAdapter(f.broker.config,home);t.after(()=>native.close());
  (f.claude as any).readProfile=(current:Peer)=>native.readProfile(current);
  await (f.broker as any).profileCoordination.verifyInitial(f.store.peer(peer.id));
  assert.equal(f.broker.profiles.intent(peer)?.status,'pending');assert.equal(f.broker.profiles.blocks(f.store.peer(peer.id)),true);
  (f.claude as any).readProfile=async()=>({model:'claude-opus-current',effort:'high',requestedModel:'opus'});
  await (f.broker as any).profileCoordination.verifyInitial(f.store.peer(peer.id));assert.equal(f.broker.profiles.blocks(f.store.peer(peer.id)),false);
});

test('显式创建字段不进入冻结记录；effort 单字段选择只冻结宿主模型',t=>{
  const home=temporary(t),store=new Store(':memory:');t.after(()=>store.close());
  const config={...DEFAULT_CONFIG,partnerProfiles:{codex:{source:'frozen' as const}}},profiles=new PartnerProfiles(store,home,config);
  const create=(profile:ModelProfile,model:string,effort:string)=>{const peer=store.placeholder('codex',home);profiles.set(peer,profile);store.adopt(peer.id,registration('codex',randomUUID(),{model,effort}));profiles.observed(store.peer(peer.id),{model,effort});};
  create({model:'explicit',effort:'high'},'explicit','high');assert.deepEqual(frozenProfiles(home,config),{});
  create({effort:'max'},'host-model','max');assert.equal(frozenProfiles(home,config).codex?.model,'host-model');assert.equal(frozenProfiles(home,config).codex?.effort,undefined);
  const peer=store.placeholder('codex',home);profiles.initialize(peer);store.adopt(peer.id,registration('codex','capture-default',{model:'host-model',effort:'low'}));profiles.observed(store.peer(peer.id),{model:'host-model',effort:'low'});
  assert.equal(frozenProfiles(home,config).codex?.effort,'low');
});

test('明确指定创建设置时替换已启动预备成员，回收旧后台且原草稿只发送一次',async t=>{
  const f=fixture(t,{implicit:'on-demand'}),sender={host:'claude' as const,sessionId:f.c.sessionId!,callId:'provisional-profile'};
  const provisional=f.store.placeholder('codex',f.c.cwd);f.store.adopt(provisional.id,registration('codex','already-created'));
  f.store.setSetting('implicitPartner:'+f.c.id,{peerId:provisional.id,sessionId:f.c.sessionId,callId:sender.callId});
  const view=f.store.selections.create(f.c,sender,f.broker.config,{actor:sender,message:'唯一的原草稿'}) as any;
  const choice={actor:sender,selection_id:view.selection_id,action:'create',model:'chosen',effort:'high'};
  const result=await f.broker.dispatch('pair.selection.commit',choice) as any;
  const target=f.store.peer(f.store.pairFor(f.c.id)!.codex);assert.notEqual(target.id,provisional.id);
  assert.deepEqual(f.broker.profiles.requested(target),{model:'chosen',effort:'high'});
  assert.equal(f.codex.released.some(peer=>peer.id===provisional.id),true);
  assert.deepEqual(await f.broker.dispatch('pair.selection.commit',choice),result);assert.equal(f.store.messages().length,1);assert.equal(f.store.messages()[0]!.body,'唯一的原草稿');
});

test('慢成员的设置核验不阻塞另一配对，同成员的后台阶段不并发提交',async t=>{
  const f=owned(t),c2=f.store.register(registration('claude','second-c')),x2=f.store.register(registration('codex','second-x'));
  f.store.pair(c2.id,x2.id);f.store.updatePeer(x2.id,{owner:'nxbridge'});
  f.broker.profiles.set(f.store.peer(f.x.id),{model:'first'});f.broker.profiles.set(f.store.peer(x2.id),{model:'second'});
  let release!:()=>void,entered!:()=>void;const started=new Promise<void>(resolve=>entered=resolve),waiting=new Promise<void>(resolve=>release=resolve),calls:string[]=[];
  (f.codex as any).setProfile=async(peer:Peer,_endpoint:Endpoint,profile:ModelProfile)=>{calls.push(peer.id);if(peer.id===f.x.id){entered();await waiting;}return profile;};
  const first=(f.broker as any).syncPartnerProfile(f.x.id);
  try{await started;await (f.broker as any).syncPartnerProfile(f.x.id);await (f.broker as any).syncPartnerProfile(x2.id);
    assert.equal(calls.filter(id=>id===f.x.id).length,1);assert.equal(f.broker.profiles.view(f.store.peer(x2.id)).status,'applied');
  }finally{release();await first;}
});

test('已生效或缺省成员的重复状态事件不产生数据库写入',t=>{
  const f=owned(t),peer=f.store.peer(f.x.id),profile={model:'old',effort:'low'};
  f.broker.profiles.set(peer,profile);f.broker.profiles.applied(peer,profile);
  const original=f.store.setSetting.bind(f.store);let writes=0;
  f.store.setSetting=(key,value)=>{writes++;return original(key,value);};
  f.broker.profiles.observed(peer,profile);assert.equal(writes,0);
  f.broker.profiles.set(peer,{},true);writes=0;f.broker.profiles.observed(peer,profile);assert.equal(writes,0);
});

test('新 Codex 的身份登记晚于创建，后台阶段仍可只读核验并解除首轮暂停',async t=>{
  const f=owned(t),peer=f.store.placeholder('codex',f.c.cwd);f.broker.profiles.set(peer,{model:'chosen',effort:'high'});
  f.store.adopt(peer.id,registration('codex','late-codex'));
  let reads=0;(f.codex as any).readProfile=async()=>{reads++;return{model:'chosen',effort:'high'};};
  await (f.broker as any).profileCoordination.verifyInitial(f.store.peer(peer.id));
  assert.equal(reads,1);assert.equal(f.broker.profiles.blocks(f.store.peer(peer.id)),false);
});

test('首次设置回读的拥塞或能力错误保持等待，不能误报为宿主拒绝切换',async t=>{
  const f=owned(t),peer=f.store.placeholder('codex',f.c.cwd);f.broker.profiles.set(peer,{model:'chosen',effort:'high'});
  f.store.adopt(peer.id,registration('codex','read-pending'));
  for(const code of ['rpc_backpressure','-32601']){
    (f.codex as any).readProfile=async()=>{throw new DeliveryError(code,'只读核验暂不可用',false);};
    await (f.broker as any).profileCoordination.verifyInitial(f.store.peer(peer.id));
    assert.equal(f.broker.profiles.intent(peer)?.status,'pending');assert.equal(f.broker.profiles.intent(peer)?.error?.code,code);assert.equal(f.broker.profiles.blocks(f.store.peer(peer.id)),true);
  }
  (f.codex as any).readProfile=async()=>({model:'chosen',effort:'high'});
  await (f.broker as any).profileCoordination.verifyInitial(f.store.peer(peer.id));assert.equal(f.broker.profiles.blocks(f.store.peer(peer.id)),false);
});

test('重启、退休或接管期间不读取模型设置；提交接管后的真实观测保留为会话基线',async t=>{
  const f=owned(t),peer=f.store.peer(f.x.id);f.broker.profiles.set(peer,{model:'chosen'});f.broker.profiles.failed(peer,profileChangeFailure(new DeliveryError('timeout','超时'),true));
  let reads=0;(f.codex as any).readProfile=async()=>{reads++;return{model:'chosen'};};
  const releaseRestart=lifecycle(f.broker).beginRestart(peer.id);
  try{await (f.broker as any).profileCoordination.reconcile(peer);}finally{releaseRestart();}
  const retirement=lifecycle(f.broker).releaseOwned([peer.id]);
  try{await (f.broker as any).profileCoordination.reconcile(peer);}finally{await retirement;}
  assert.equal(reads,0);
  const childPeer=f.store.peer(f.c.id),home=(f.broker as any).home,endpoint=f.store.endpoint(childPeer.id)!;
  const child={version:1,peerId:childPeer.id,sessionId:childPeer.sessionId,cwd:childPeer.cwd,address:'test',phase:'user',handoffId:'profile-handoff',updatedAt:Date.now(),modelProfile:{model:'old-canonical',effort:'low'},foreground:{pid:endpoint.pid,startedAt:endpoint.procStart}} as ClaudeChildRecord;
  mkdirSync(home+'/run',{recursive:true});atomicJson(claudeChildFile(home,childPeer.id),child);
  lifecycle(f.broker).returnClaudeChild(childPeer,child,child.handoffId!);assert.deepEqual(claudeChild(home,childPeer.id)?.modelProfile,child.modelProfile);
  atomicJson(claudeChildFile(home,childPeer.id),child);
  f.store.saveEndpoint({...endpoint,nativeProfile:{model:'foreground-canonical',effective:{effort:'high'},observedAt:Date.now()}});
  lifecycle(f.broker).returnClaudeChild(childPeer,child,child.handoffId!);assert.deepEqual(claudeChild(home,childPeer.id)?.modelProfile,{model:'foreground-canonical',effort:'high'});
  atomicJson(claudeChildFile(home,childPeer.id),child);
  f.store.saveEndpoint({...endpoint,nativeProfile:{model:'foreground-canonical',effective:{effort:'high'},runtimeEffort:'medium',observedAt:Date.now()}});
  lifecycle(f.broker).returnClaudeChild(childPeer,child,child.handoffId!);assert.deepEqual(claudeChild(home,childPeer.id)?.modelProfile,{model:'foreground-canonical',effort:'medium'});
  atomicJson(claudeChildFile(home,childPeer.id),child);
  f.store.saveEndpoint({...endpoint,nativeProfile:{model:'foreground-canonical',effective:{effort:'high'},runtimeEffort:null,observedAt:Date.now()}});
  lifecycle(f.broker).returnClaudeChild(childPeer,child,child.handoffId!);assert.deepEqual(claudeChild(home,childPeer.id)?.modelProfile,{model:'foreground-canonical'});
  atomicJson(claudeChildFile(home,childPeer.id),child);
  f.store.saveEndpoint({...endpoint,nativeProfile:{model:'foreground-canonical',effective:{effort:'high'},runtimeEffort:'medium',effortUnverified:true,observedAt:Date.now()}});
  lifecycle(f.broker).returnClaudeChild(childPeer,child,child.handoffId!);assert.deepEqual(claudeChild(home,childPeer.id)?.modelProfile,{model:'foreground-canonical'});
  assert.equal(f.broker.profiles.blocks(childPeer),false);
});

test('既有托管暂停仍准备通知，新模型暂停才提前返回',async t=>{
  const f=owned(t);(f.broker as any).receive=()=>({status:'held',messages:[],hosting:{phase:'released'}});
  let notices=0;(f.broker as any).runtimeHealth.prepareNotices=async()=>{notices++;return[];};
  await f.broker.dispatch('receive',actor);assert.equal(notices,1);
  (f.broker as any).receive=()=>({status:'held',messages:[],partner_profile:{delivery_held:true}});
  await f.broker.dispatch('receive',actor);assert.equal(notices,1);
});
