import test,{type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {appendFileSync,writeFileSync} from 'node:fs';
import path from 'node:path';
import {fixture} from './support/broker-fixture.js';
import {temporary} from './support/temporary.js';
import {SILENCE_MS} from '../broker/health/turn-health.js';

function native(t:TestContext,foreground=false){
  const f=fixture(t),pair=f.store.pair(f.c.id,f.x.id),file=path.join(temporary(t),'native.jsonl'),turnId='native-turn';
  const row=(payload:object,type='response_item')=>JSON.stringify({timestamp:new Date().toISOString(),type,payload})+'\n';
  writeFileSync(file,JSON.stringify({type:'session_meta',payload:{id:'x'}})+'\n'+row({type:'task_started',turn_id:turnId},'event_msg'),'utf8');
  const append=(payload:object)=>appendFileSync(file,row(payload),'utf8');
  const endpoint={...f.store.endpoint(f.x.id)!,...(foreground?{mode:'embedded' as const,configHome:path.dirname(file)}:{}),nativeSession:{transcriptPath:file}};
  f.store.saveEndpoint(endpoint);f.store.updatePeer(f.x.id,{state:'busy',owner:foreground?'user':'nxbridge'});
  const thread={id:'x',path:file,status:{type:'active'},turns:[{id:turnId,status:'inProgress',items:[{id:'comment',type:'agentMessage',text:'实验仍在运行'}] as any[]}]};
  let reads=0;
  f.codex.connect=async()=>({request:async(method:string)=>{
    if(method==='thread/read'){reads++;return{thread};}
    if(method==='thread/turns/list')return{data:[...thread.turns].reverse()};
    return{data:thread.turns.at(-1)!.items.slice(-1).map(item=>({turnId,item}))};
  }}) as any;
  if(foreground){f.store.setSetting('codexTranscript:'+f.x.id,{sessionId:'x',file});f.broker.foregroundHealth.observe(f.x,'start',turnId);}
  else f.broker.health.read(endpoint.address,thread);
  const health=()=>((f.broker as any).runtimeHealth.peerHealth(f.store.peer(f.x.id))) as any;
  const check=()=>((f.broker as any).runtimeHealth.checkPairTurnHealth(pair)) as Promise<void>;
  const pending=(id='hidden')=>append({type:'function_call',name:'sleep',namespace:'clock',status:'completed',call_id:id,internal_chat_message_metadata_passthrough:{turn_id:turnId}});
  return{...f,pair,file,turnId,thread,endpoint,append,pending,health,check,reads:()=>reads};
}

for(const foreground of [false,true])test((foreground?'前台 hook':'App Server')+'：接口漏掉在途工具时显示等待，补查不推进进展时间，完成后不粘住旧工具',async t=>{
  t.mock.timers.enable({apis:['Date'],now:1000000});const f=native(t,foreground),progress=f.health().lastProgressAt;
                                 
  f.pending();t.mock.timers.tick(SILENCE_MS);await f.check();
  assert.equal(f.health().state,'waitingTool');assert.deepEqual(f.health().tools,['hidden']);assert.equal(f.health().lastProgressAt,progress);
  t.mock.timers.tick(15*60000);await f.check();
  assert.equal(f.health().state,'waitingTool');assert.equal(f.health().lastProgressAt,progress);
  assert.equal(f.store.events().filter(event=>event.type==='health.alert').length,0);
  if(foreground)await assert.rejects(f.broker.dispatch('codex.recover',{preview:true}),{code:'unowned_runtime'});
  else{const preview:any=await f.broker.dispatch('codex.recover',{preview:true});assert.equal(preview.recoveryCommand,null);}
  f.append({type:'function_call_output',call_id:'hidden',output:'等待正常结束'});
                                          
  f.thread.turns[0]!.items=[{id:'different-native-id',type:'sleep',completedAtMs:Date.now()}];
  if(foreground)f.broker.foregroundHealth.observe(f.x,'progress',f.turnId);
  t.mock.timers.tick(30001);await f.check();assert.deepEqual(f.health().tools,[]);assert.equal(f.health().state,'running');
  const finished=f.health().lastProgressAt;
  t.mock.timers.tick(SILENCE_MS);await f.check();assert.equal(f.health().state,'silent');assert.equal(f.health().progressEvidence,true);assert.equal(f.health().lastProgressAt,finished);
  if(!foreground)assert.equal(f.store.events().filter(event=>event.type==='health.alert').length,1,'证据确认无在途工具后仍保留真实静默提醒');
});

test('读不到原生尾部时撤回静默结论，证据恢复且确认无在途工具后仍能触发提醒',async t=>{
  t.mock.timers.enable({apis:['Date'],now:1000000});const f=native(t),progress=f.health().lastProgressAt;
  f.thread.path=f.file+'.missing';t.mock.timers.tick(SILENCE_MS);await f.check();
  assert.equal(f.health().state,'silent');assert.equal(f.health().progressEvidence,false);assert.equal(f.health().lastProgressAt,progress);
  assert.equal(f.store.events().filter(event=>event.type==='health.alert').length,0);
  f.thread.path=f.file;t.mock.timers.tick(30001);await f.check();assert.equal(f.health().progressEvidence,true);
  assert.equal(f.store.events().filter(event=>event.type==='health.alert').length,1);
});

test('确认工具等待后撤回已有静默告警，不能假称发现新进展；反复状态读取共用限频',async t=>{
  t.mock.timers.enable({apis:['Date'],now:1000000});const f=native(t),progress=f.health().lastProgressAt;
  f.store.setSetting('turnHealthIncident:'+f.pair.id,{id:'old-silence',pairId:f.pair.id,peerId:f.x.id,turnId:f.turnId,lastProgressAt:progress,alertAdmitted:true});
  f.pending();t.mock.timers.tick(SILENCE_MS);await f.check();
  assert.equal(f.health().lastProgressAt,progress);assert.equal(f.store.setting<any>('turnHealthIncident:'+f.pair.id)?.recovered,true);
  const incident=f.store.setting<any>('turnHealthIncident:'+f.pair.id)!,notice=f.broker.deliveryHealth.get(f.pair.id,f.c.id,incident.recoveryId);
  assert.match(notice?.message??'',/native tool wait confirmed.*no new progress claimed/);
  const count=f.reads();for(let i=0;i<3;i++)await f.check();assert.equal(f.reads(),count);
});

test('补查期间的新事件使旧证据失效，下一次核验前只保留未知，不误报停滞',async t=>{
  t.mock.timers.enable({apis:['Date'],now:1000000});const f=native(t),progress=f.health().lastProgressAt;
  const heartbeat=()=>f.broker.health.observe(f.endpoint.address,{method:'thread/status/changed',params:{threadId:'x',status:{type:'active',activeFlags:[]}}});
  const original=f.broker.health.read.bind(f.broker.health);
  let inject=true;t.mock.method(f.broker.health,'read',(...args:Parameters<typeof original>)=>{const health=original(...args);if(inject){inject=false;queueMicrotask(heartbeat);}return health;});
  f.pending();t.mock.timers.tick(SILENCE_MS);await f.check();assert.equal(f.health().state,'silent');assert.equal(f.health().progressEvidence,false);assert.equal(f.health().lastProgressAt,progress);
  assert.equal(f.store.events().filter(event=>event.type==='health.alert').length,0);
  const count=f.reads();t.mock.timers.tick(30001);await f.check();assert.equal(f.reads(),count+1);assert.equal(f.health().state,'waitingTool');
  t.mock.timers.tick(1);heartbeat();assert.equal(f.health().state,'silent');assert.equal(f.health().progressEvidence,false,'新事件之后不能继续信任旧工具证据或无证据断言停滞');
  assert.equal(f.health().lastProgressAt,progress);
});
