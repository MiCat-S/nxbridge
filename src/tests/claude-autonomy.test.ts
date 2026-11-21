import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import { temporary } from './support/temporary.js';
import {fixture, lifecycle} from './support/broker-fixture.js';
import { registration } from './support/registration.js';
import { claudeBypassConsent, claudeLaunchPrerequisite, requireClaudeBypassConsent } from '../hosts/claude/claude-autonomy.js';
import { ClaudeAdapter } from '../hosts/claude/adapter.js';
import {DEFAULT_CONFIG} from '../config/defaults.js';
import { nativeOwnership } from '../process/owned-native.js';
import { claudeObservedPermission } from '../hosts/claude/claude-inbound.js';
import {BridgeError} from '../shared/errors.js';

beforeEach(t=>{if(process.platform==='linux'&&'mock'in t)t.mock.method(process as typeof process&{getuid:()=>number},'getuid',()=>1000);});

test('只读取所选 home 的用户声明；项目、本地和非布尔值不能伪装确认',t=>{
  const home=temporary(t),settings=path.join(home,'settings.json'),local=path.join(home,'settings.local.json');
  writeFileSync(local,JSON.stringify({skipDangerousModePermissionPrompt:true}),'utf8');
  assert.equal(claudeBypassConsent(home).accepted,false);
  writeFileSync(settings,JSON.stringify({skipDangerousModePermissionPrompt:'true'}),'utf8');
  assert.throws(()=>requireClaudeBypassConsent(home),{code:'claude_bypass_consent_required'});
  const before=readFileSync(settings,'utf8');assert.equal(claudeBypassConsent(home).accepted,false);assert.equal(readFileSync(settings,'utf8'),before);
  writeFileSync(settings,JSON.stringify({skipDangerousModePermissionPrompt:true}),'utf8');assert.equal(claudeBypassConsent(home).source,'user');
  writeFileSync(settings,'{}','utf8');writeFileSync(path.join(home,'.claude.json'),JSON.stringify({bypassPermissionsModeAccepted:true}),'utf8');assert.equal(claudeBypassConsent(home).source,'legacy');
  writeFileSync(path.join(home,'.claude.json'),'{','utf8');assert.equal(claudeBypassConsent(home).accepted,null);assert.throws(()=>requireClaudeBypassConsent(home),{code:'invalid_config'});
});

test('已完成声明也不能越过项目禁用；首条任务前仍检查实际权限和入站策略',async t=>{
  const home=temporary(t);mkdirSync(path.join(home,'.claude'));
  writeFileSync(path.join(home,'settings.json'),JSON.stringify({skipDangerousModePermissionPrompt:true}),'utf8');
  writeFileSync(path.join(home,'.claude','settings.local.json'),JSON.stringify({permissions:{disableBypassPermissionsMode:'disable'}}),'utf8');
  assert.equal(claudeBypassConsent(home).accepted,true);assert.equal(claudeLaunchPrerequisite(home,home).code,'claude_bypass_disabled');
  assert.throws(()=>requireClaudeBypassConsent(home,home),{code:'claude_bypass_disabled'});
  const {broker,store,c}=fixture(t);store.updatePeer(c.id,{owner:'nxbridge'});
  store.setSetting('ownedClaudePolicy:'+c.id,{sessionId:c.sessionId,inboundAccept:true});
  const endpoint=store.endpoint(c.id)!,verify=()=>lifecycle(broker).verifyOwnedClaudeLaunch(c.id);
  store.saveEndpoint({...endpoint,nativePermission:{mode:'default',permission:'prompting',observedAt:Date.now()}});
  await assert.rejects(verify(),{code:'claude_bypass_disabled'});
  store.saveEndpoint({...endpoint,nativePermission:{mode:'bypassPermissions',permission:'bypass',observedAt:Date.now()},nativeInbound:{policy:'hold',source:'policy',observedAt:Date.now()}});
  await assert.rejects(verify(),{code:'claude_inbound_restricted'});assert.equal(store.messages().length,0);
  store.saveEndpoint({...store.endpoint(c.id)!,nativeInbound:{policy:'accept',source:'flag',observedAt:Date.now()}});await verify();
  assert.equal(store.setting<any>('ownedClaudePolicy:'+c.id).verified,true);
  store.saveEndpoint({...endpoint,nativePermission:{mode:'default',permission:'prompting',observedAt:Date.now()}});await verify();
  assert.equal(store.endpoint(c.id)!.nativePermission!.mode,'default','核验完成后由用户主动更改的运行中权限不被重设');
});

test('未确认时不创建原生启动意图，不提交任务，也不回退到人工审批',async t=>{
  const home=temporary(t),adapter=new ClaudeAdapter({...DEFAULT_CONFIG,claudeBinary:process.execPath,claudeHome:home},home);t.after(()=>adapter.close());
  adapter.list=async()=>[];
  const peer={id:randomUUID(),host:'claude',owner:'nxbridge',cwd:home,sessionId:null} as const;
  let submits=0;await assert.rejects(adapter.create(peer as any,()=>{submits++;},'prompting'),{code:'claude_bypass_consent_required'});
  assert.equal(submits,0);assert.equal(nativeOwnership(home,peer.id),undefined);
});

test('缺失模式时以原生引擎判定核验，不把用户放行规则或矛盾模式当作全部放行',async t=>{
  const {broker,store,c}=fixture(t);store.updatePeer(c.id,{owner:'nxbridge'});
  const endpoint=store.endpoint(c.id)!,expected={sessionId:c.sessionId,inboundAccept:true},verify=()=>lifecycle(broker).verifyOwnedClaudeLaunch(c.id);
  const nativeInbound={policy:'accept' as const,source:'flag' as const,observedAt:Date.now()},decision=(bash:'allow'|'ask'|'deny',rule?:string)=>({bash,observedAt:Date.now(),...(rule===undefined?{}:{rule})});
  for(const bash of ['ask','deny'] as const){
    store.setSetting('ownedClaudePolicy:'+c.id,expected);store.saveEndpoint({...endpoint,nativeDecision:decision(bash),nativeInbound});
    await assert.rejects(verify(),{code:'claude_bypass_disabled'});assert.equal(claudeObservedPermission('unknown',decision(bash)),'prompting');
  }
  assert.equal(claudeObservedPermission('unknown',decision('allow','Bash(*)')),'unknown');
  assert.equal(claudeObservedPermission('default',decision('allow')),'prompting');
  store.saveEndpoint({...endpoint,nativePermission:{mode:'default',permission:'prompting',observedAt:Date.now()},nativeDecision:decision('allow'),nativeInbound});
  await assert.rejects(verify(),{code:'claude_bypass_disabled'});
  store.saveEndpoint({...endpoint,nativePermission:{mode:'unknown',permission:'bypass',observedAt:Date.now()},nativeDecision:decision('allow'),nativeInbound});
  await verify();assert.equal(store.setting<any>('ownedClaudePolicy:'+c.id).verified,true);
  assert.equal(claudeObservedPermission('unknown',decision('allow')),'bypass');
  assert.equal((store.events().find(event=>event.type==='claude.launch.verified')?.data as any).mode,'unknown');
  assert.equal(store.messages().length,0);
});

test('启动核验失败后重新登记为就绪，投递循环仍不能交付未核验后台',async t=>{
  t.mock.timers.enable({apis:['Date'],now:1000000});
  const {broker,store,c,x,claude}=fixture(t),pair=store.pair(c.id,x.id);
  store.updatePeer(c.id,{owner:'nxbridge',state:'ready'});store.setSetting('ownedClaudePolicy:'+c.id,{sessionId:c.sessionId,inboundAccept:true});
  const endpoint=store.endpoint(c.id)!;store.saveEndpoint({...endpoint,nativePermission:{mode:'default',permission:'prompting',observedAt:Date.now()}});
  const msg=store.accept(pair,x,'自动执行任务','autonomous');await broker.pump();assert.equal(claude.delivered.length,0);assert.equal(store.message(msg.id).attempts,0);
  store.updatePeer(c.id,{state:'ready'});t.mock.timers.tick(10001);await broker.pump();assert.equal(claude.delivered.length,0);
  const blocked:any=broker.status();assert.equal(blocked.peers.find((p:any)=>p.id===c.id).launch_precondition.code,'claude_bypass_disabled');
  store.saveEndpoint({...endpoint,nativePermission:{mode:'bypassPermissions',permission:'bypass',observedAt:Date.now()},nativeInbound:{policy:'accept',source:'flag',observedAt:Date.now()}});
  t.mock.timers.tick(10001);await broker.pump();assert.equal(store.setting<any>('ownedClaudePolicy:'+c.id).verified,true);assert.equal(claude.delivered.length,1);
  store.updatePeer(c.id,{sessionId:'user-rotated'});await lifecycle(broker).verifyOwnedClaudeLaunch(c.id,false);assert.equal(store.setting('ownedClaudePolicy:'+c.id),null,'用户切换后的会话不再套用原后台的启动默认值');
});

test('未知入站设置继续等待原生观测，不误报为组织限制',async t=>{
  const {broker,store,c}=fixture(t);store.updatePeer(c.id,{owner:'nxbridge'});store.setSetting('ownedClaudePolicy:'+c.id,{sessionId:c.sessionId,inboundAccept:true});
  const endpoint={...store.endpoint(c.id)!,nativePermission:{mode:'bypassPermissions',permission:'bypass' as const,observedAt:Date.now()},nativeInbound:{policy:'unknown' as const,observedAt:Date.now()}};
  store.saveEndpoint(endpoint);const waiting=lifecycle(broker).verifyOwnedClaudeLaunch(c.id);
  store.saveEndpoint({...endpoint,nativeInbound:{policy:'accept',observedAt:Date.now()}});await waiting;assert.equal(store.setting<any>('ownedClaudePolicy:'+c.id).verified,true);
});

test('Linux root 明确报告原生启动限制，不要求无效确认或回退人工模式',{skip:process.platform!=='linux'},t=>{
  t.mock.method(process as typeof process&{getuid:()=>number},'getuid',()=>0);assert.equal(claudeLaunchPrerequisite(temporary(t),'/project').code,'claude_bypass_root_unsupported');
});

test('投递最终边界遇到用户切换会话时保留原消息，恢复进程也必须重新核验',async t=>{
  const {broker,store,c,x,claude}=fixture(t),pair=store.pair(c.id,x.id);store.updatePeer(c.id,{owner:'nxbridge'});
  const endpoint=store.endpoint(c.id)!;store.saveEndpoint({...endpoint,nativePermission:{mode:'bypassPermissions',permission:'bypass',observedAt:Date.now()}});
  store.setSetting('ownedClaudePolicy:'+c.id,{sessionId:c.sessionId,inboundAccept:false});await lifecycle(broker).verifyOwnedClaudeLaunch(c.id,false);
  store.saveEndpoint({...store.endpoint(c.id)!,procStart:'restored',nativePermission:{mode:'default',permission:'prompting',observedAt:Date.now()}});
  await assert.rejects(lifecycle(broker).verifyOwnedClaudeLaunch(c.id,false),{code:'claude_bypass_disabled'});
  store.saveEndpoint({...endpoint,nativePermission:{mode:'bypassPermissions',permission:'bypass',observedAt:Date.now()}});await lifecycle(broker).verifyOwnedClaudeLaunch(c.id,false);
  claude.deliver=async(_p,_e,message)=>{store.updatePeer(c.id,{sessionId:'user-rotated'});assert.equal(await message.beforeSubmit!(),false);return{state:'expired',evidence:'核验期间会话已切换'};};
  const msg=store.accept(pair,x,'切换期间的原任务','rotation');await broker.pump();assert.equal(store.message(msg.id).state,'accepted');
});

test('明确新建失败会展示前置条件；重试同一选择提交一次原草稿',async t=>{
  const {broker,store,x,claude}=fixture(t,{implicit:'on-demand'}),actor={host:'codex' as const,sessionId:x.sessionId!,callId:'explicit'};
  const selection=store.selections.create(x,actor,broker.config,{actor,message:'仅提交一次原正文'}) as any;let accepted=false,starts=0;
  claude.create=async()=>{starts++;if(!accepted)throw new BridgeError('claude_bypass_consent_required','等待原生声明');return'new-claude' as any;};
  const commit=()=>broker.dispatch('pair.selection.commit',{actor,selection_id:selection.selection_id,action:'create'}) as Promise<any>;
  const blocked=await commit();assert.equal(blocked.status,'launch_precondition');assert.equal(blocked.launch_precondition.code,'claude_bypass_consent_required');assert.equal(store.messages().length,1);
  accepted=true;const ready=await commit();assert.equal(ready.status,'paired');assert.equal(store.messages().length,1);assert.equal(store.messages()[0]!.body,'仅提交一次原正文');assert.equal(starts,2);
});

test('同一原生会话续租保留引擎判定；代次或会话改变不沿用旧判定',async t=>{
  const {broker,store,c}=fixture(t),input=registration('claude',c.sessionId!,{endpoint:{...store.endpoint(c.id)!,configHome:path.resolve('/renewed-claude'),nativePermission:{mode:'unknown',permission:'bypass',observedAt:1},nativeDecision:{bash:'allow',observedAt:1}}});
  store.adopt(c.id,input);store.updatePeer(c.id,{owner:'nxbridge'});store.setSetting('ownedClaudePolicy:'+c.id,{sessionId:c.sessionId,inboundAccept:false});
  await lifecycle(broker).verifyOwnedClaudeLaunch(c.id,false);
  const before=store.bindings.current(c.id)!;store.bindings.save({...before,active:false});
  store.adopt(c.id,{...input,endpoint:{...input.endpoint,nativeDecision:undefined}});
  assert.notEqual(store.bindings.current(c.id)!.epoch,before.epoch);await lifecycle(broker).verifyOwnedClaudeLaunch(c.id,false);
  assert.equal(store.endpoint(c.id)!.nativeDecision!.bash,'allow');
  store.adopt(c.id,{...input,endpoint:{...input.endpoint,procStart:'next-generation',nativeDecision:undefined}});assert.equal(store.endpoint(c.id)!.nativeDecision,undefined);
  store.adopt(c.id,{...input,sessionId:'user-cleared',endpoint:{...input.endpoint,nativeDecision:undefined}});assert.equal(store.endpoint(c.id)!.nativeDecision,undefined);
});

test('尚未核验的后台被用户切换会话后也退休旧启动条件，不覆盖新会话权限',async t=>{
  const {broker,store,c}=fixture(t);store.updatePeer(c.id,{owner:'nxbridge'});store.setSetting('ownedClaudePolicy:'+c.id,{sessionId:c.sessionId,inboundAccept:true,verified:false});
  store.updatePeer(c.id,{sessionId:'user-cleared'});await lifecycle(broker).verifyOwnedClaudeLaunch(c.id,false);
  assert.equal(store.setting('ownedClaudePolicy:'+c.id),null);
});

test('模拟适配器创建的新后台仍必须核验原生权限，受限后台不接收草稿',async t=>{
  const f=fixture(t),owned=f.store.placeholder('claude',f.x.cwd),pair=f.store.pair(owned.id,f.x.id),message=f.store.accept(pair,f.x,'权限确认前保留原草稿','policy');
  f.claude.discover=async sessionId=>registration('claude',sessionId,{state:'ready',endpoint:{mode:'claude-inbox',address:'restricted',epoch:'restricted',pid:process.pid,procStart:'restricted-generation',configHome:f.broker.home,nativePermission:{mode:'default',permission:'prompting',observedAt:Date.now()}}});
  await f.broker.pump();
  assert.equal(f.claude.created.length,1);assert.equal(f.claude.delivered.length,0);assert.equal(f.store.message(message.id).attempts,0);assert.equal(f.store.message(message.id).state,'accepted');
  assert.equal(f.store.setting<any>('ownedClaudePolicy:'+owned.id).failure.code,'claude_bypass_disabled');
});
