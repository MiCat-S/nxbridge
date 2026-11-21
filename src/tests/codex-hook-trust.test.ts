import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { readFileSync, writeFileSync } from 'node:fs';
import { CodexHookTrust, hookTrustFromList, hookTrustMessage, readCodexHookTrust } from '../hosts/codex/codex-hook-trust.js';
import {DEFAULT_CONFIG} from '../config/defaults.js';
import { codexInitializeResult } from './support/registration.js';
import { fixture } from './support/broker-fixture.js';
import { temporary } from './support/temporary.js';
import { MOD_REVISION } from '../mod-revision.js';

const approval='plugin contents changed; hook approval required';
const nativeHook=(trustStatus:string)=>({pluginId:'nxbridge@nxbridge-local',enabled:true,trustStatus,currentHash:'sha256:current/sha256:script'});

test('当前磁盘信任按原生校验区分缺失、内容变更和已信任；未知结果不推断需要重启',()=>{
  for(const trust of ['untrusted','modified'])assert.equal(hookTrustFromList([nativeHook('trusted'),nativeHook(trust)]),'required');
  assert.equal(hookTrustFromList([nativeHook('trusted'),nativeHook('managed')]),'trusted');
  for(const hooks of [[],[nativeHook('unknown')],[{...nativeHook('trusted'),enabled:false}],[{...nativeHook('untrusted'),pluginId:'other@market'}]])assert.equal(hookTrustFromList(hooks),'unknown');
});

test('新控制进程只读取目标配置与 hooks 清单，不写入信任或创建工作线程',async t=>{
  const home=temporary(t),configHome=temporary(t),script=path.join(home,'hook-control.mjs'),calls=path.join(home,'calls.jsonl'),file=path.join(configHome,'config.toml'),before='[hooks.state]\n';
  writeFileSync(file,before,'utf8');
  writeFileSync(script,`import{createInterface}from'node:readline';import{appendFileSync}from'node:fs';createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);appendFileSync(${JSON.stringify(calls)},JSON.stringify({method:m.method,params:m.params,configHome:process.env.CODEX_HOME})+'\\n');if(m.id)console.log(JSON.stringify({id:m.id,result:m.method==='initialize'?${JSON.stringify(codexInitializeResult)}:m.method==='hooks/list'?{data:[{hooks:[${JSON.stringify(nativeHook('trusted'))}]}]}:{}}));});`,'utf8');
  assert.equal(await readCodexHookTrust({...DEFAULT_CONFIG,codexBinary:script},home,configHome,home),'trusted');
  const methods=readFileSync(calls,'utf8').trim().split('\n').map(line=>JSON.parse(line));
  assert.deepEqual(methods.map(row=>row.method),['initialize','initialized','hooks/list']);
  assert.deepEqual(methods[0].params.clientInfo,{name:'codex-backend',title:null,version:''});
  assert.ok(methods.every(row=>path.resolve(row.configHome)===path.resolve(configHome)));
  assert.deepEqual(methods.at(-1).params,{cwds:[home]});assert.equal(readFileSync(file,'utf8'),before);
});

test('并发故障共用一次磁盘检查，人工信任或一分钟到期后刷新；检查中变化不采用旧结果',async t=>{
  t.mock.timers.enable({apis:['Date'],now:1000000});
  const home=temporary(t),file=path.join(home,'config.toml');writeFileSync(file,'before','utf8');
  let reads=0,release!:(value:'trusted'|'required')=>void;
  const checks=new CodexHookTrust(async()=>{reads++;return new Promise(resolve=>{release=resolve;});});
  const first=Array.from({length:20},()=>checks.check(home,home));await Promise.resolve();assert.equal(reads,1);
  writeFileSync(file,'user trusted the new hashes','utf8');release('required');assert.deepEqual(await Promise.all(first),Array(20).fill('unknown'));
  const trusted=checks.check(home,home);await Promise.resolve();assert.equal(reads,2);release('trusted');assert.equal(await trusted,'trusted');
  assert.equal(await checks.check(home,home),'trusted');assert.equal(reads,2);
  t.mock.timers.tick(60000);const expired=checks.check(home,home);await Promise.resolve();assert.equal(reads,3);release('required');assert.equal(await expired,'required');
});

test('控制面不可读时保留未知诊断，后续检查仍可恢复',async t=>{
  t.mock.timers.enable({apis:['Date'],now:1000000});
  const home=temporary(t);let calls=0;
  const checks=new CodexHookTrust(async()=>{if(++calls===1)throw Error('原生控制面不可用');return'trusted';});
  assert.equal(await checks.check(home,home),'unknown');assert.equal(await checks.check(home,home),'unknown');assert.equal(calls,1);
  t.mock.timers.tick(60000);assert.equal(await checks.check(home,home),'trusted');
});

test('原生失败区分重新信任与旧会话重启，状态和通知包含精确操作，成功 hook 撤销故障',async t=>{
  const f=fixture(t),pair=f.store.pair(f.c.id,f.x.id),home=temporary(t);
  f.store.saveEndpoint({...f.store.endpoint(f.x.id)!,configHome:home});f.store.savePeer({...f.x,owner:'nxbridge'});
  let trust:'required'|'trusted'='required',checks=0;
  t.mock.method((f.broker as any).hookTrust,'check',async()=>{checks++;return trust;});
  const emit=(status:string,error=approval)=>f.codex.emit('native',{address:f.store.endpoint(f.x.id)!.address,message:{method:'hook/completed',params:{threadId:'x',run:{source:'plugin',sourcePath:'nxbridge/hooks',eventName:'postToolUse',status,entries:[{kind:'error',text:error}]}}}});
  const settle=async()=>{await Promise.allSettled([(f.broker as any).runtimeHealth.waitForIdle()]);};
  emit('failed');await settle();
  let status:any=f.broker.status({host:'codex',sessionId:'x',callId:'check'});
  assert.match(status.integrationIssues.find((issue:any)=>issue.code==='hooks_trust_required').message,/\/hooks.*nxbridge/);
  trust='trusted';(f.broker as any).runtimeHealth.refreshNoticeConditions(pair);await settle();
  status=f.broker.status({host:'codex',sessionId:'x',callId:'check2'});
  const restart=status.integrationIssues.find((issue:any)=>issue.code==='hooks_restart_required');assert.ok(restart);assert.equal(restart.owner,'nxbridge');assert.match(restart.message,/'restart' 'codex' '--partner'/);assert.match(restart.message,/paired Claude.*safe idle moment/);
  assert.match(hookTrustMessage({...f.x,owner:'nxbridge'},'hooks_restart_required',true),new RegExp('空闲.*Codex 之外.*--member '+f.x.id));
  assert.match(hookTrustMessage(f.x,'hooks_trust_required',true),/\/hooks.*nxbridge/);
  assert.equal(status.integrationIssues.some((issue:any)=>issue.code==='hooks_trust_required'||issue.code==='hooks_blocked'),false);
  const notice=f.broker.deliveryHealth.peek(pair.id,f.c.id)[0]!;assert.match(notice.message,/'restart' 'codex' '--partner'/);assert.match(notice.message,/no polling\/restart loop/);
  emit('completed');await settle();assert.equal(f.broker.pairAnomalies.evidence(f.x).hookTrustIssue,undefined);assert.equal(f.broker.deliveryHealth.hasPending(pair.id,f.c.id),false);
  emit('failed','other hook failure');await settle();assert.equal(f.broker.pairAnomalies.evidence(f.x).hookTrustIssue,undefined);
  f.broker.pairAnomalies.observe(pair,f.x);assert.equal(f.broker.pairAnomalies.issues(f.x.id)[0]!.kind,'hooks_blocked');assert.equal(checks,2);
});

test('普通状态及 Mod 只读状态按故障成员的归属提供重启提示，其他告警不扩展归属字段',async t=>{
  const f=fixture(t);f.store.pair(f.c.id,f.x.id);
  const binding=f.store.bindings.activate({host:'claude',configHome:path.resolve('/owner-status'),pid:101,procStart:'native'},f.c.id,'c','verified');
  const endpoint={...f.store.endpoint(f.c.id)!,pid:binding.pid,procStart:binding.procStart,modRevision:MOD_REVISION};f.store.saveEndpoint(endpoint);
  const actor={host:'claude' as const,sessionId:'c',callId:'owner-status',binding:{key:binding.key,epoch:binding.epoch}},receipt={sessionId:'c',native:{pid:binding.pid,procStart:binding.procStart},revision:MOD_REVISION};
  const codes=['hooks_restart_required','contract_inactive','hooks_missing'];
  for(const owner of ['nxbridge','user'] as const){
    f.store.updatePeer(f.x.id,{owner});f.store.updatePeer(f.c.id,{owner:owner==='user'?'nxbridge':'user'});
    f.store.setSetting('pairIssues:'+f.x.id,{issues:codes.map(kind=>({kind,message:kind}))});
    const scoped:any=f.broker.status(actor),all:any=f.broker.status(),fast:any=await(f.broker as any).modRead(actor,'status',receipt,endpoint.epoch);
    for(const issues of [scoped.integrationIssues,all.capabilities.integrationIssues,fast.integrationIssues]){
      const partner=issues.filter((issue:any)=>issue.peerId===f.x.id);assert.equal(partner.length,3);
      for(const issue of partner)if(issue.code==='hooks_missing')assert.equal(Object.hasOwn(issue,'owner'),false);else assert.equal(issue.owner,owner);
    }
  }
});

test('人工窗口重启提示不指向托管重启；检查迟到不能覆盖成功或新原生代次',async t=>{
  for(const change of ['success','generation','user'] as const){
    const f=fixture(t),pair=f.store.pair(f.c.id,f.x.id),home=temporary(t);f.store.saveEndpoint({...f.store.endpoint(f.x.id)!,configHome:home});
    let release!:(trust:'trusted')=>void;t.mock.method((f.broker as any).hookTrust,'check',()=>new Promise(resolve=>{release=resolve;}));
    const emit=(status:string)=>f.codex.emit('native',{address:f.store.endpoint(f.x.id)!.address,message:{method:'hook/completed',params:{threadId:'x',run:{source:'plugin',sourcePath:'nxbridge/hooks',status,entries:[{kind:'error',text:approval}]}}}});
    emit('failed');
    if(change==='success')emit('completed');
    if(change==='generation')f.store.saveEndpoint({...f.store.endpoint(f.x.id)!,procStart:'new-generation'});
    release('trusted');await Promise.allSettled([(f.broker as any).runtimeHealth.waitForIdle()]);
    if(change==='user'){
      f.broker.pairAnomalies.observe(pair,f.x);const issue=f.broker.pairAnomalies.issues(f.x.id).find(issue=>issue.kind==='hooks_restart_required')!;
      assert.match(issue.message,/same session id.*reopens/);assert.doesNotMatch(issue.message,/nxbridge restart codex/);
      assert.match(hookTrustMessage(f.x,'hooks_restart_required',true),/原会话 ID.*重新打开/);
    }else assert.equal(f.broker.pairAnomalies.evidence(f.x).hookTrustIssue,undefined,change);
  }
});
