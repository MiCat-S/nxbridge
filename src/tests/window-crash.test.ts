import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { Store } from '../storage/store.js';
import { processIdentity } from '../process/process.js';
import {delay} from '../shared/time.js';
import {PACKAGE_ROOT} from '../shared/package-location.js';
import { fixture } from './support/broker-fixture.js';
import { registration } from './support/registration.js';
import { temporaryDirectory } from './support/temporary.js';

for(const host of ['claude','codex'] as const)test(host+' 实际宿主代次被终止后按配置目录身份恢复原成员',async t=>{
  const {store,broker,c,x}=fixture(t),pair=store.pair(c.id,x.id),peer=host==='claude'?c:x,children:ReturnType<typeof spawn>[]=[];
  t.after(async()=>{for(const child of children)if(child.exitCode===null&&child.signalCode===null){const closed=once(child,'close');child.kill();await closed;}});
  const launch=async()=>{const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore',windowsHide:true});children.push(child);await once(child,'spawn');return{child,identity:await processIdentity(child.pid!)};};
  const old=await launch(),oldInput=registration(host,peer.sessionId!,{endpoint:{mode:host==='claude'?'claude-inbox':'embedded',address:host==='claude'?'crash-inbox':'',epoch:'old-native',pid:old.identity.pid,procStart:old.identity.startedAt,configHome:path.resolve('/isolated/old-home',host)}});
  store.adopt(peer.id,oldInput);store.updatePeer(peer.id,{state:'paused'});const queued=store.accept(pair,host==='claude'?x:c,'崩溃前的来信','before-crash');
  const closed=once(old.child,'close');old.child.kill();await closed;const replacement=await launch();
  const restored=await broker.dispatch('register',{...oldInput,endpoint:{...oldInput.endpoint,epoch:'replacement-native',pid:replacement.identity.pid,procStart:replacement.identity.startedAt,configHome:host==='codex'?oldInput.endpoint.configHome:path.resolve('/isolated/new-home',host)}}) as any;
  assert.equal(restored.id,peer.id);assert.equal(restored.state,'ready');assert.equal(store.pairFor(peer.id)?.id,pair.id);assert.equal(store.message(queued.id).state,'accepted');
  assert.equal(store.endpoint(peer.id)?.pid,replacement.identity.pid);assert.equal(store.endpoints(peer.id).filter(e=>e.active).length,1);
});

test('写事务中实际进程崩溃：WAL 保留已提交配对和消息，回滚半次替换及领取',async t=>{
  const temp=temporaryDirectory(),directory=temp.directory,database=path.join(directory,'crash.db'),ready=path.join(directory,'ready.json'),module=pathToFileURL(path.join(PACKAGE_ROOT,'dist/storage/store.js')).href;let recovered:Store|undefined,phase='launch';
  const source=`import{writeFileSync}from'node:fs';import{Store}from${JSON.stringify(module)};
const s=new Store(${JSON.stringify(database)}),input=(host,id)=>({host,sessionId:id,cwd:${JSON.stringify(directory)},kind:'root',permission:'prompting',endpoint:{mode:'embedded',address:'',epoch:id,pid:process.pid,procStart:'fixture'}});
const c=s.register(input('claude','c')),x=s.register(input('codex','x')),other=s.register(input('claude','other')),pair=s.pair(c.id,x.id),queued=s.accept(pair,c,'已提交排队消息','queued'),sending=s.accept(pair,x,'已提交但未确认','sending');s.claim(sending.id);
s.transaction(()=>{s.pair(other.id,x.id,true);s.claim(queued.id);s.updatePeer(c.id,{state:'offline'});writeFileSync(${JSON.stringify(ready)},JSON.stringify({c:c.id,x:x.id,pair:pair.id,queued:queued.id,sending:sending.id}),'utf8');Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0);});`;
  const child=spawn(process.execPath,['--input-type=module','-e',source],{stdio:['ignore','ignore','pipe'],windowsHide:true});let logs='';child.stderr!.on('data',chunk=>logs+=chunk);const closed=once(child,'close');
  const waitExit=async()=>{let timer:NodeJS.Timeout|undefined;try{await Promise.race([closed,new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(Error('隔离写进程未退出：'+phase)),5000);})]);}finally{clearTimeout(timer);}};
  t.after(async()=>{if(phase!=='passed')t.diagnostic(JSON.stringify({phase,pid:child.pid,exitCode:child.exitCode,signal:child.signalCode,logs}));if(child.exitCode===null&&child.signalCode===null)child.kill();await waitExit();recovered?.close();await temp.cleanup();});
  const deadline=Date.now()+10000;while(!existsSync(ready)){if(Date.now()>deadline||child.exitCode!==null)throw Error('隔离写事务未就绪：'+logs);await delay(20);}
  phase='kill-uncommitted';const ids=JSON.parse(readFileSync(ready,'utf8'));child.kill();await waitExit();phase='open-wal';recovered=new Store(database);phase='recover';recovered.recover();
  assert.equal(recovered.pairs().length,1);assert.equal(recovered.pairFor(ids.c)?.id,ids.pair);assert.equal(recovered.pairFor(ids.x)?.id,ids.pair);
  assert.equal(recovered.peer(ids.c).state,'ready');assert.equal(recovered.message(ids.queued).state,'accepted');assert.equal(recovered.message(ids.sending).state,'unknown');assert.equal(recovered.pending().length,1);
  const retry=recovered.accept(recovered.pairFor(ids.c)!,recovered.peer(ids.c),'已提交排队消息','queued');assert.equal(retry.id,ids.queued);assert.equal(recovered.messages().length,2);
  phase='passed';
});
