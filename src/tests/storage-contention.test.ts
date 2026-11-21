import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { DatabaseSync } from 'node:sqlite';
import { Store } from '../storage/store.js';
import { fixture } from './support/broker-fixture.js';
import { registration } from './support/registration.js';
import { temporaryDirectory, temporary } from './support/temporary.js';
import {DeliveryHealth} from '../broker/health/delivery.js';
import {readHealthSnapshot,updateHealthSnapshot} from '../broker/health/snapshot.js';
import { acknowledgeRuntimeNotice, collectRuntimeNotices } from '../broker/health/runtime-monitor.js';
import { modelError } from '../integration/mcp/model-output.js';
import { storageError, StorageBusyError, retryStorageReceipt, preSubmitError } from '../storage/storage-errors.js';
import { connectBroker, listenBroker } from '../ipc/ipc.js';
import {ensureHome} from '../ipc/home.js';
import { pairChangeKey } from '../broker/pairing/pair-changes.js';

function healthFixture(t:TestContext){
  const temp=temporaryDirectory(),filename=path.join(temp.directory,'nxbridge.db'),store=new Store(filename),x=store.register(registration('codex','storage-root')),c=store.register(registration('claude','storage-partner')),pair=store.pair(c.id,x.id);
  t.after(async()=>{store.close();await temp.cleanup();});return{home:temp.directory,filename,store,x,c,pair};
}
async function holdWriter(t:TestContext,filename:string,duration?:number){
  const child=spawn(process.execPath,['--no-warnings','-e',"const {DatabaseSync}=require('node:sqlite'),db=new DatabaseSync(process.argv[1]);db.exec('PRAGMA busy_timeout=3000; BEGIN IMMEDIATE');const release=()=>{db.exec('ROLLBACK');db.close();process.disconnect();};if(process.argv[2])setTimeout(release,Number(process.argv[2]));else process.once('message',release);process.send('locked');",filename,...(duration===undefined?[]:[String(duration)])],{windowsHide:true,stdio:['ignore','ignore','inherit','ipc']});
  const exited=once(child,'exit');t.after(async()=>{if(child.exitCode===null&&child.signalCode===null){child.kill();await exited;}});assert.equal((await once(child,'message'))[0],'locked');return{exited,release:async()=>{child.send('release');await exited;}};
}

test('健康写入跨进程等候短暂写锁，WAL 读取不受写事务阻塞',async t=>{
  const f=healthFixture(t);await holdWriter(t,f.filename,900);
  assert.ok(readHealthSnapshot(f.home,'codex','storage-root'));
  const began=performance.now();assert.equal(updateHealthSnapshot(f.home,'codex','storage-root',undefined,(_health,_value,storage)=>{storage.setSetting('contention-proof',true);return true;}),true);
  assert.ok(performance.now()-began>=400,'必须真正等待超过旧版 300ms 限制');assert.equal(f.store.setting('contention-proof'),true);
});

test('长期写锁有界退出，数字 busy 类型穿过 IPC 后仍只允许明确提交前重试',async t=>{
  const f=healthFixture(t),{release}=await holdWriter(t,f.filename);
                                       
  let busy:unknown;const began=performance.now();try{updateHealthSnapshot(f.home,'codex','storage-root',undefined,()=>true);}catch(error){busy=error;}finally{await release();}
  assert.ok(busy instanceof StorageBusyError);assert.ok(performance.now()-began>=2500);assert.equal(modelError(busy).uncertain,true);assert.equal(modelError(busy).phase,undefined);
  const home=temporary(t);await ensureHome(home);
  const server=await listenBroker(home,async()=>{throw storageError(busy,'monitor-prepare','prepare');}),rpc=await connectBroker(home);
  try{await assert.rejects(rpc.request('health.monitor'),error=>{const detail=modelError(error);assert.equal(detail.code,'storage_busy');assert.equal(detail.phase,'prepare');assert.equal(detail.uncertain,false);assert.equal(detail.sqliteCode,5);return true;});}finally{rpc.close();await server.close();}
  assert.equal(modelError({errcode:5}).code,'storage_busy');assert.equal(modelError({errcode:262}).code,'storage_busy');assert.notEqual(modelError(new Error('database locked text only')).code,'storage_busy');
  const unknown=Object.assign(new StorageBusyError('post-submit','enqueue'),{uncertain:true});assert.equal(modelError(unknown).uncertain,true);
  const remote={code:'storage_busy',uncertain:true};assert.equal(modelError(preSubmitError(remote,'outer','prepare')).uncertain,true);assert.equal(modelError(preSubmitError(remote,'outer','prepare')).phase,undefined);
  assert.equal(modelError(preSubmitError(new StorageBusyError('inner','enqueue'),'outer','prepare')).phase,'enqueue');
});

test('同批通知的后续领取失败时整体回滚，重试仍能领取原正文',async t=>{
  const {broker,store,c,x}=fixture(t),pair=store.pair(c.id,x.id),health=new DeliveryHealth(store),id='atomic-admission';health.enqueue(pair.id,c.id,{id,message:'必须保留的通知正文',state:'pending',kind:'explicit_recovery'});
  store.contextNotices=()=>[{id:'rotation',peerId:x.id,oldSessionId:'old',sessionId:x.sessionId!,oldEpoch:'old',epoch:'new',reason:'reset',at:Date.now(),unanswered:[],uncertain:[]}];
  let recoveries=0;(broker as any).runtimeHealth.outageRecovery=()=>{recoveries++;return undefined;};
  let fail=true;store.admitContextNotice=()=>{if(fail)throw{errcode:5,code:'ERR_SQLITE_ERROR'};return true;};
  const params={actor:{host:'claude',sessionId:c.sessionId,callId:'atomic-monitor'}};
  await assert.rejects(broker.dispatch('health.monitor',params),error=>{const detail=modelError(error);assert.equal(detail.code,'storage_busy');assert.equal(detail.phase,'prepare');assert.equal(detail.uncertain,false);return true;});
  assert.equal(health.get(pair.id,c.id,id)?.message,'必须保留的通知正文');
  assert.equal(recoveries,0,'SQL 回滚前不能提交独立故障账本');
  fail=false;const result=await broker.dispatch('health.monitor',params) as any;assert.ok(result.notices.some((notice:any)=>notice.id===id));assert.equal(health.get(pair.id,c.id,id),undefined);
});

test('hook 剩余预算不足时不领取，已提交的领取 RPC 超时不转为本地再次领取',async t=>{
  const f=healthFixture(t);await ensureHome(f.home);let calls=0;const server=await listenBroker(f.home,async()=>{calls++;return new Promise(()=>{});});
  try{
    f.store.setSetting(pairChangeKey(f.x.id),{id:'short-budget-change',pair_id:f.pair.id,session_id:f.x.sessionId,state:'pending',source:'pair_changed',message:'配对变更',at:Date.now(),cancelled_message_ids:[],uncertain_message_ids:[]});
    assert.deepEqual(await collectRuntimeNotices(f.home,'codex','storage-root',{pid:process.pid,procStart:'test'},undefined,undefined,undefined,{deadline:performance.now()+100}),[]);assert.equal(calls,0);
    assert.notEqual(f.store.setting<any>(pairChangeKey(f.x.id)).admitted,true);f.store.setSetting(pairChangeKey(f.x.id),null);
    const began=performance.now();await assert.rejects(collectRuntimeNotices(f.home,'codex','storage-root',{pid:process.pid,procStart:'test'},undefined,undefined,undefined,{deadline:performance.now()+6000}),{code:'timeout',uncertain:true});assert.ok(performance.now()-began<5000);
  }finally{await server.close();}
});

test('只重试幂等回执，锁释放后标记提交；其他错误不重试',async t=>{
  const f=healthFixture(t),native={pid:process.pid,procStart:'test'},id='ack-after-busy';new DeliveryHealth(f.store).enqueue(f.pair.id,f.x.id,{id,message:'回执测试',state:'pending',kind:'explicit_recovery'});
  await holdWriter(t,f.filename,1350);await acknowledgeRuntimeNotice(f.home,'codex','storage-root',native,id,'submitted');
  assert.equal(new DeliveryHealth(f.store).peek(f.pair.id,f.x.id).some(notice=>notice.id===id),false);assert.equal(f.store.messages().length,0);
  let calls=0;await assert.rejects(retryStorageReceipt(()=>{calls++;throw new Error('非锁错误');}),/非锁错误/);assert.equal(calls,1);
});

test('例行 checkpoint 在旧读快照存在时立即返回并保留该读者',t=>{
  const f=healthFixture(t),reader=new DatabaseSync(f.filename,{readOnly:true});
  try{reader.exec('BEGIN');reader.prepare('SELECT * FROM settings').all();f.store.setSetting('checkpoint-proof',true);const began=performance.now();f.store.checkpoint();assert.ok(performance.now()-began<1000);assert.ok(reader.prepare('SELECT count(*) AS n FROM peers').get());}finally{reader.exec('ROLLBACK');reader.close();}
});
