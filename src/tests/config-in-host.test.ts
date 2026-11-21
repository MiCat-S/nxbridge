import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { InHostConfiguration, configurationArguments, type ConfigurationSession } from '../config/config-in-host.js';
import { loadBridgeConfig, writeConfiguration } from '../config/configuration.js';
import { Broker } from '../broker/coordinator.js';
import { Store } from '../storage/store.js';
import {DEFAULT_CONFIG} from '../config/defaults.js';
import { FakeAdapter } from './support/fake-adapter.js';
import { registration } from './support/registration.js';
import { temporary } from './support/temporary.js';

const session=(host:'claude'|'codex',id='root',window='123:generation'):ConfigurationSession=>({host,sessionId:id,window});
function makeProposal(service:InHostConfiguration,who:ConfigurationSession,input:unknown):any{
  const shown=service.model(who,input) as any,hidden=service.pending(who) as any,token=/confirm ([a-f0-9]{16})$/.exec(hidden.confirmation)![1]!;
  assert.equal(shown.token,undefined);assert.ok(!JSON.stringify(shown).includes(token),'模型结果不能包含确认码');return{...shown,token,confirmation:hidden.confirmation};
}
test('双端模型安全写入直接生效，敏感项只生成精确差异，原生确认单次提交',t=>{
  for(const host of ['claude','codex'] as const){
    const home=temporary(t),service=new InHostConfiguration(home),who=session(host);
    service.model(who,{action:'set',key:'questions.timeout_ms',value:450});assert.equal(loadBridgeConfig(home).questionTimeoutMs,450);
    const proposed=makeProposal(service,who,{action:'set',key:'collaboration.implicit',value:'never'});
    assert.equal(loadBridgeConfig(home).implicit,'on-demand');assert.deepEqual(proposed.diff,[{key:'collaboration.implicit',operation:'set',before:'on-demand',after:'never',managedValue:'never'}]);
    assert.match(proposed.confirmation,/nxbridge config confirm [a-f0-9]{16}$/);
    assert.throws(()=>service.model(who,{action:'confirm',token:proposed.token}));
    for(const foreign of [session(host,'other'),session(host,'root','124:generation'),session(host==='codex'?'claude':'codex')])assert.throws(()=>service.confirm(foreign,proposed.token),{code:'config_confirmation_invalid'});
    service.confirm(who,proposed.token);assert.equal(loadBridgeConfig(home).implicit,'never');assert.throws(()=>service.confirm(who,proposed.token),{code:'config_confirmation_invalid'});
    const audit=readFileSync(path.join(home,'config-last-change.json'),'utf8');assert.equal(JSON.parse(audit).origin,host+'-user');assert.doesNotMatch(audit,new RegExp(proposed.token));
    service.model(who,{action:'unset',key:'questions.timeout_ms'});assert.equal(loadBridgeConfig(home).questionTimeoutMs,DEFAULT_CONFIG.questionTimeoutMs);
  }
});

test('SDK 用户提示默认关闭，模型只能提案，开启和恢复默认均由用户确认',t=>{
  const key='hosts.claude.sdk_user_prompt';
  for(const host of ['claude','codex'] as const){
    const home=temporary(t),service=new InHostConfiguration(home),who=session(host);
    const entry=service.model(who,{action:'get',key}) as any;
    assert.equal(entry.value,false);assert.equal(entry.safe,false);
    const enable=makeProposal(service,who,{action:'set',key,value:true});
    assert.equal(enable.status,'needs_confirmation');assert.equal(loadBridgeConfig(home).claudeSdkUserPrompt,false);
    service.confirm(who,enable.token);assert.equal(loadBridgeConfig(home).claudeSdkUserPrompt,true);
    const reset=makeProposal(service,who,{action:'unset',key});
    assert.equal(reset.status,'needs_confirmation');assert.equal(loadBridgeConfig(home).claudeSdkUserPrompt,true);
    service.confirm(who,reset.token);assert.equal(loadBridgeConfig(home).claudeSdkUserPrompt,false);
    for(const value of ['true',1,null])assert.throws(()=>service.model(who,{action:'set',key,value}),{code:'invalid_config'});
    service.human(who,['set',key,'true']);assert.equal(loadBridgeConfig(home).claudeSdkUserPrompt,true);
  }
});

test('双端同步提醒配置默认三十分钟，允许安全关闭和恢复，拒绝无效分钟',t=>{
  for(const host of ['claude','codex'] as const){
    const home=temporary(t),service=new InHostConfiguration(home),who=session(host);
    assert.equal(loadBridgeConfig(home).syncTipMinutes,30);
    assert.equal((service.model(who,{action:'set',key:'collaboration.sync_tip_minutes',value:0}) as any).status,undefined);
    assert.equal(loadBridgeConfig(home).syncTipMinutes,0);
    for(const value of [-1,.5,'30'])assert.throws(()=>service.model(who,{action:'set',key:'collaboration.sync_tip_minutes',value}),{code:'invalid_config'});
    service.model(who,{action:'unset',key:'collaboration.sync_tip_minutes'});assert.equal(loadBridgeConfig(home).syncTipMinutes,30);
  }
});

test('双端空闲提醒默认五分钟，模型可安全关闭和恢复，拒绝无效分钟',t=>{
  for(const host of ['claude','codex'] as const){
    const home=temporary(t),service=new InHostConfiguration(home),who=session(host);
    assert.equal(loadBridgeConfig(home).idleNoticeMinutes,5);
    service.model(who,{action:'set',key:'collaboration.idle_notice_minutes',value:0});assert.equal(loadBridgeConfig(home).idleNoticeMinutes,0);
    for(const value of [-1,.5,'2'])assert.throws(()=>service.model(who,{action:'set',key:'collaboration.idle_notice_minutes',value}),{code:'invalid_config'});
    service.model(who,{action:'unset',key:'collaboration.idle_notice_minutes'});assert.equal(loadBridgeConfig(home).idleNoticeMinutes,5);
  }
});

test('过期、替换、结束和协调器重启使提案失效；文件变化整批拒绝且不覆盖',t=>{
  const home=temporary(t);let now=100;const service=new InHostConfiguration(home,()=>now),who=session('codex');
  const propose=()=>makeProposal(service,who,{action:'propose',edits:[{key:'collaboration.implicit',value:'never'},{key:'questions.timeout_ms',value:123}]});
  const expired=propose();now+=600000;assert.throws(()=>service.confirm(who,expired.token),{code:'config_confirmation_invalid'});
  const first=propose(),second=propose();assert.throws(()=>service.confirm(who,first.token),{code:'config_confirmation_invalid'});service.cancel(who);assert.throws(()=>service.confirm(who,second.token),{code:'config_confirmation_invalid'});
  const restart=propose();assert.throws(()=>new InHostConfiguration(home,()=>now).confirm(who,restart.token),{code:'config_confirmation_invalid'});
  for(const filename of ['config.managed.toml','config.toml']){
    const proposal=propose(),file=path.join(home,filename);writeFileSync(file,'# 用户另行修改\n','utf8');
    assert.throws(()=>service.confirm(who,proposal.token),{code:'config_changed'});assert.equal(readFileSync(file,'utf8'),'# 用户另行修改\n');assert.equal(loadBridgeConfig(home).implicit,'on-demand');
    assert.throws(()=>service.confirm(who,proposal.token),{code:'config_confirmation_invalid'});
  }
  const proposal=propose();writeConfiguration(home,[{key:'retention.max_events',value:10}],'terminal');assert.throws(()=>service.confirm(who,proposal.token),{code:'config_changed'});assert.equal(loadBridgeConfig(home).retention!.maxEvents,10);
});

test('原生命令允许敏感写入但不改用户 TOML，非法批次不写入，秘密不进入差异',t=>{
  const home=temporary(t),service=new InHostConfiguration(home),who=session('claude');
  assert.deepEqual(configurationArguments('set hosts.codex.command ["程序", "带 空格", ""]'),['set','hosts.codex.command','["程序", "带 空格", ""]']);
  service.human(who,configurationArguments('set collaboration.implicit never'));assert.equal(loadBridgeConfig(home).implicit,'never');
  assert.throws(()=>service.model(who,{action:'propose',edits:[{key:'collaboration.implicit',value:'on-demand'},{key:'questions.timeout_ms',value:0}]}));assert.equal(loadBridgeConfig(home).implicit,'never');
  const command=makeProposal(service,who,{action:'set',key:'hosts.codex.command',value:['程序','--token','不能展示']});assert.doesNotMatch(JSON.stringify(command),/不能展示/);service.human(who,['confirm',command.token]);assert.deepEqual(loadBridgeConfig(home).codexCommand,['程序','--token','不能展示']);
  const user=path.join(home,'config.toml'),raw='\ufeff# 用户文件\r\n[collaboration]\r\nimplicit="never"\r\n';writeFileSync(user,raw,'utf8');
  assert.throws(()=>service.human(who,['unset','collaboration.implicit']),{code:'config_user_override'});assert.equal(readFileSync(user,'utf8'),raw);
  assert.equal(existsSync(path.join(home,'config.json')),false);
});

test('协调器仅根窗口可信确认入口可提交，模型参数与子代理不能伪造；两类 Codex 所有者一致',async t=>{
  for(const owner of ['user','nxbridge'] as const){
    const home=temporary(t),store=new Store(':memory:'),codex=new FakeAdapter(),claude=new FakeAdapter(),broker=new Broker(store,{...DEFAULT_CONFIG},{codex,claude} as any,home);
    t.after(async()=>{await broker.stop();store.close();});
    const root=store.register(registration('codex','root'));store.updatePeer(root.id,{owner});
    const actor={host:'codex',sessionId:'root',callId:'config'};
    const propose=async()=>{const shown:any=await broker.dispatch('config.model',{actor,input:{action:'set',key:'collaboration.implicit',value:'never'}}),hidden:any=broker.configuration!.pending(session('codex','root',`${process.pid}:test`));return{...shown,token:/confirm ([a-f0-9]{16})$/.exec(hidden.confirmation)![1]};};
    const proposed=await propose(),prompt='nxbridge config confirm '+proposed.token,context_key=`${process.pid}:test:root`;
    const hook={session_id:'root',hook_event_name:'UserPromptSubmit',context_key,prompt};
    assert.equal((await broker.dispatch('hook',{...hook,context_key:`${process.pid}:test:foreign.jsonl`}) as any).decision,'block');assert.equal(loadBridgeConfig(home).implicit,'on-demand');
    await broker.dispatch('hook',{session_id:'root',hook_event_name:'SessionStart',source:'startup',context_key});
    await broker.dispatch('hook',{...hook,agent_id:'child'});await broker.dispatch('hook',{...hook,context_key:'other-process:root-transcript'});assert.equal(loadBridgeConfig(home).implicit,'on-demand');
    await assert.rejects(broker.dispatch('config.model',{actor,input:{action:'confirm',token:proposed.token}}));
    const child=store.register(registration('codex','child',{kind:'subagent',parentId:'root'}));
    await assert.rejects(broker.dispatch('config.model',{actor:{...actor,sessionId:child.sessionId},input:{action:'set',key:'questions.timeout_ms',value:12}}),{code:'subagent_denied'});
    assert.match((await broker.dispatch('hook',hook) as any).reason,/保存成功/);assert.equal(loadBridgeConfig(home).implicit,'never');assert.equal(broker.config.implicit,'never');assert.equal(DEFAULT_CONFIG.implicit,'on-demand');
    assert.match((await broker.dispatch('hook',hook) as any).reason,/已使用/);
    const next=await propose();await broker.dispatch('hook',{session_id:'root',hook_event_name:'SessionEnd',context_key});
    assert.match((await broker.dispatch('hook',{...hook,prompt:'nxbridge config confirm '+next.token}) as any).reason,/核验当前宿主进程|已过期/);
  }
});

test('App Server 无进程字段时使用原生 MCP 的独立证据，不覆盖路由或父链',async t=>{
  const home=temporary(t),store=new Store(':memory:'),codex=new FakeAdapter(),claude=new FakeAdapter(),broker=new Broker(store,DEFAULT_CONFIG,{codex,claude} as any,home);
  t.after(async()=>{await broker.stop();store.close();});
  const direct=registration('codex','root');direct.endpoint.pid=null;direct.endpoint.procStart=null;
  const root=store.register(direct),actor={host:'codex',sessionId:'root',callId:'config'};
  await assert.rejects(broker.dispatch('config.model',{actor,input:{action:'list'}}),{code:'config_context_unverified'});
  const embedded=registration('codex','root',{kind:'unknown',endpoint:{mode:'embedded',address:'',epoch:'native',pid:process.pid,procStart:'native-generation'}});
  await broker.dispatch('mcp.register',embedded);
  const proposed:any=await broker.dispatch('config.model',{actor,input:{action:'set',key:'collaboration.implicit',value:'never'}});
  assert.equal(proposed.status,'needs_confirmation');assert.deepEqual(store.endpoint(root.id),{...direct.endpoint,native:{pid:process.pid,procStart:'native-generation'},peerId:root.id,active:true,seenAt:store.endpoint(root.id)!.seenAt});assert.equal(store.peer(root.id).kind,'root');
                                  
  codex.emit('register',direct);assert.ok((broker.configuration!.pending(session('codex','root',`${process.pid}:native-generation`)) as any).confirmation);
  store.deactivate(root.id);codex.emit('register',{...direct,endpoint:{...direct.endpoint,epoch:'new-server'}});
  await assert.rejects(broker.dispatch('config.model',{actor,input:{action:'list'}}),{code:'config_context_unverified'});
});
