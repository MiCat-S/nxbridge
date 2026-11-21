import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './support/broker-fixture.js';
import { IdleNotices } from '../broker/health/idle-notices.js';
import { PairAnomalies } from '../broker/pairing/pair-anomalies.js';
import {DeliveryHealth} from '../broker/health/delivery.js';
import { VERSION } from '../version.js';

test('代表性长历史的空闲监控只读取元数据，保留未回复和正文边界',t=>{
  t.mock.timers.enable({apis:['Date'],now:1000000});
  const f=fixture(t),pair=f.store.pair(f.c.id,f.x.id),body='历史正文'.repeat(4096),large='长正文'.repeat(29126);
  let protectedId='',originalId='';
  f.store.transaction(()=>{
    for(let n=0;n<1024;n++){
      const message=f.store.accept(pair,n%2?f.c:f.x,n===0||n===1022?large:body,'history-'+n);
      f.store.transition(message.id,'contextObserved','原生上下文证据');
      if(n===0)originalId=message.id;
    }
    const pending=f.store.accept(pair,f.c,'尚未答复的近期任务','protected');protectedId=pending.id;
    f.store.transition(pending.id,'contextObserved','原生上下文证据');
    const replay=f.store.accept(pair,f.x,large,'replay');f.store.transition(replay.id,'contextObserved','原生上下文证据');
  });
  assert.ok(f.store.seenUnansweredFacts(pair.id,f.x.id).some(message=>message.id===protectedId));
  const facts=f.store.deliveryIssueFacts(pair.id,f.x.id);assert.ok(facts.every(message=>!('body'in message)));
                                    
  t.mock.method(f.store,'messagesFor',()=>{throw Error('健康监控不能物化全历史正文');});
  const notices=new DeliveryHealth(f.store),idle=new IdleNotices(f.store,notices),anomalies=new PairAnomalies(f.store,notices,VERSION);
  t.mock.timers.tick(180000);
  const cpu=process.cpuUsage(),began=performance.now();
  for(let n=0;n<50;n++){idle.observe(pair,f.store.peer(f.x.id),2);anomalies.observe(pair,f.store.peer(f.x.id));}
  const used=process.cpuUsage(cpu);
  assert.equal(f.store.message(protectedId).body,'尚未答复的近期任务');assert.equal(f.store.message(originalId).body,large);
  t.diagnostic(JSON.stringify({historyRows:1026,largeBodyBytes:Buffer.byteLength(large),sweeps:50,wallMs:performance.now()-began,cpuMs:(used.user+used.system)/1000,fullHistoryBodyReads:0,scope:'isolated repeated idle/anomaly observers; SQLite retains full bodies; no model or OS process query'}));
});

test('连续原生文本增量不查询成员 SQL，轮次与 hook 完成仍更新集成证据',t=>{
  const f=fixture(t),pair=f.store.pair(f.c.id,f.x.id),address=f.store.endpoint(f.x.id)!.address;
  const peerReads=t.mock.method(f.store,'peers',f.store.peers.bind(f.store)),endpointReads=t.mock.method(f.store,'endpoints',f.store.endpoints.bind(f.store));
  const emit=(method:string,params:Record<string,unknown>={})=>f.codex.emit('native',{address,message:{method,params:{threadId:f.x.sessionId,turnId:'resource-turn',...params}}});
  const cpu=process.cpuUsage(),began=performance.now();
  for(let n=0;n<10000;n++)emit('item/agentMessage/delta',{delta:'继续'});
  const used=process.cpuUsage(cpu);
  assert.equal(peerReads.mock.callCount(),0);assert.equal(endpointReads.mock.callCount(),0);
  emit('turn/started',{turn:{id:'resource-turn'}});assert.ok(peerReads.mock.callCount()>0);
  const key='integration:'+f.x.id;assert.equal(f.store.setting<any>(key).turnsWithoutHook,1);
  emit('hook/completed',{run:{source:'plugin',sourcePath:'nxbridge/hooks',status:'completed'}});
  assert.equal(f.store.setting<any>(key).turnsWithoutHook,0);assert.equal(f.store.currentPair()!.id,pair.id);
  emit('hook/completed',{run:{source:'plugin',sourcePath:'nxbridge/hooks',status:'failed',eventName:'postToolUse',startedAt:1000,completedAt:4000,durationMs:3000,entries:[{kind:'error',text:'hook timed out after 3s'},{kind:'stdout',text:'不应保存的命令正文'}]}});
  const failed=f.store.events(0,1000).filter(row=>row.type==='hook.native.failed');assert.equal(failed.length,1);
  assert.deepEqual(failed[0]!.data,{peerId:f.x.id,sessionId:f.x.sessionId,turnId:'resource-turn',event:'postToolUse',startedAt:1000,completedAt:4000,durationMs:3000});
  t.diagnostic(JSON.stringify({nativeDeltas:10000,deltaPeerQueries:0,deltaEndpointQueries:0,wallMs:performance.now()-began,cpuMs:(used.user+used.system)/1000,scope:'native progress remains observed; lifecycle/hook evidence still resolves current member'}));
});

test('队列元数据计数保留暂停、归档、收件人和状态过滤，避免复制长正文',t=>{
  const f=fixture(t),pair=f.store.pair(f.c.id,f.x.id),body='长'.repeat(87380);
  for(let index=0;index<32;index++)f.store.accept(pair,index%2?f.c:f.x,body,'queue-'+index);
  const check=()=>{for(const id of [undefined,f.c.id,f.x.id])assert.equal(f.store.pendingCount(id),f.store.pending(id).length);};
  check();const message=f.store.pending(f.x.id)[0]!;f.store.claim(message.id);check();
  const started=performance.now();for(let index=0;index<50;index++)f.store.pending();const fullMs=performance.now()-started;
  const began=performance.now();for(let index=0;index<50;index++)f.store.pendingCount();const countMs=performance.now()-began;
  f.store.setPaused(true,pair.id);check();assert.equal(f.store.pendingCount(),0);
  f.store.setPaused(false,pair.id);check();assert.equal(f.store.pendingCount(),31);
  f.store.unpair(pair.id);check();assert.equal(f.store.pendingCount(),0);
  t.diagnostic(JSON.stringify({queueRows:32,bodyBytes:Buffer.byteLength(body),iterations:50,fullBodyMs:fullMs,metadataCountMs:countMs,scope:'same paused/archive/state/recipient filters; isolated SQLite read cost only'}));
});
