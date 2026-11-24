import test from 'node:test';
import { VERSION } from '../version.js';
import assert from 'node:assert/strict';
import path from 'node:path';
import { writeFileSync } from 'node:fs';
import { codexInitializeResult, registration } from './support/registration.js';
import { fixture } from './support/broker-fixture.js';
import { temporary } from './support/temporary.js';
import { diagnoseCurrent } from '../app/commands/doctor.js';
import { listenBroker } from '../ipc/ipc.js';
import {ensureHome} from '../ipc/home.js';
import { agentCommand } from '../app/commands/agent-command.js';
import { pairIssues, type PairObservation } from '../broker/pairing/pair-anomalies.js';

test('当前诊断兼容原生窗口与托管 App Server，仅输出本配对事实而非消息或其他会话',async t=>{
  const f=fixture(t),pair=f.store.pair(f.c.id,f.x.id),otherC=f.store.register(registration('claude','OTHER_SECRET_C')),otherX=f.store.register(registration('codex','OTHER_SECRET_X',{endpoint:{...f.store.endpoint(f.x.id)!,address:'other',epoch:'other',pid:303}}));f.store.pair(otherC.id,otherX.id);
  f.store.accept(pair,f.c,'MESSAGE_SECRET_BODY','task');
  const binding=f.store.bindings.activate({host:'claude',configHome:path.resolve('/caller'),pid:202,procStart:'generation'},f.c.id,'c','verified');
  const before=f.store.events().length,result:any=await f.broker.dispatch('doctor.current',{native:{host:'claude',pid:binding.pid,procStart:binding.procStart}});
  assert.equal(result.status.pair_id,pair.id);assert.equal(result.status.partner.session_id,'x');assert.doesNotMatch(JSON.stringify(result),/OTHER_SECRET|MESSAGE_SECRET/);assert.equal(f.store.events().length,before);
  const endpoint=f.store.endpoint(f.x.id)!;f.store.saveEndpoint({...endpoint,native:{pid:404,procStart:'managed'}});
  assert.equal((await f.broker.dispatch('doctor.current',{native:{host:'codex',pid:404,procStart:'managed'}}) as any).status.self.member_id,f.x.id);
  for(const input of [{},{peer_id:otherX.id},{native:{host:'claude',pid:202,procStart:'stale'}}])await assert.rejects(f.broker.dispatch('doctor.current',input),{code:'diagnostic_context_required'});
});

test('只读诊断仅向本配对配置查询原生 hooks，不写信任、不创建轮次',async t=>{
  const home=temporary(t),configHome=temporary(t),script=path.join(home,'diagnostic-control.mjs');await ensureHome(home);
  writeFileSync(script,"import{createInterface}from'node:readline';createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);if(m.id)console.log(JSON.stringify({id:m.id,result:m.method==='initialize'?"+JSON.stringify(codexInitializeResult)+":m.method==='hooks/list'?{data:[{hooks:[{pluginId:'nxbridge@nxbridge-local',eventName:'userPromptSubmit',enabled:true,trustStatus:'trusted'},{pluginId:'other',eventName:'SECRET'}]}]}:{}}));});",'utf8');
  writeFileSync(path.join(home,'config.json'),JSON.stringify({codexBinary:script}),'utf8');
  const server=await listenBroker(home,async method=>{if(method==='ping')return{runtime:{buildId:'test'}};if(method==='shutdown')return{stopped:true};assert.equal(method,'doctor.current');return{status:{paired:true,pair_id:'only-pair'},codex:{cwd:configHome,configHome}};});t.after(()=>server.close());
  const result:any=await diagnoseCurrent({native:{host:'claude',pid:1,procStart:'verified'}},home);
  assert.equal(result.status.pair_id,'only-pair');assert.deepEqual(result.hooks,[{event:'userPromptSubmit',enabled:true,trust:'trusted'}]);assert.doesNotMatch(JSON.stringify(result),/SECRET/);
});

test('可自行处理的异常给出准确 Bash 命令与边界；信任和用户窗口不指向自动重启',t=>{
  const f=fixture(t),pair=f.store.pair(f.c.id,f.x.id),base:PairObservation={pair,peer:{...f.x,owner:'nxbridge'},endpoint:f.store.endpoint(f.x.id),now:2000000,messages:[],transitioning:false,questionPending:false,integration:{scope:'test',since:1000000,turnsWithoutHook:0},version:VERSION,home:path.resolve("/AI's home")};
  const diagnostic=agentCommand(['doctor','--current'],base.home);assert.match(diagnostic,/AI'"'"'s home/);assert.match(diagnostic,/'doctor' '--current'$/);
  for(const integration of [{hookError:'failed'},{turnsWithoutHook:2},{wakeQueueError:'unreadable'}])assert.ok(pairIssues({...base,integration:{...base.integration,...integration}}).some(issue=>issue.message.includes(diagnostic)));
  const managed=pairIssues({...base,replyContractActive:false}).find(issue=>issue.kind==='contract_inactive')!;assert.match(managed.message,/'restart' 'codex' '--partner'/);assert.match(managed.message,/no polling/);
  const user=pairIssues({...base,peer:{...f.x,owner:'user'},replyContractActive:false}).find(issue=>issue.kind==='contract_inactive')!;assert.doesNotMatch(user.message,/--partner/);assert.match(user.message,/tell user/);
});
