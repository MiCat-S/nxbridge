import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdirSync, writeFileSync } from 'node:fs';
import { Store } from '../storage/store.js';
import {ensureHome} from '../ipc/home.js';
import { processIdentity } from '../process/process.js';
import { collectRuntimeNotices, acknowledgeRuntimeNotice } from '../broker/health/runtime-monitor.js';
import { pairChangeKey, settleChangedPair, type PairChange } from '../broker/pairing/pair-changes.js';
import { registration } from './support/registration.js';
import { temporaryDirectory } from './support/temporary.js';

for(const paused of [false,true])test('主动解除'+(paused?'暂停配对':'配对')+'后旧窗口独立读取一次通知，按原生代次回执且不唤醒或重放',async t=>{
  const temp=temporaryDirectory(),home=temp.directory;await ensureHome(home);
  let store=new Store(path.join(home,'nxbridge.db'));t.after(async()=>{store.close();await temp.cleanup();});
  const native=await processIdentity(process.pid),runtime={pid:process.pid,procStart:native.startedAt};
  const configHome=path.join(home,'claude');mkdirSync(path.join(configHome,'sessions'),{recursive:true});writeFileSync(path.join(configHome,'sessions',runtime.pid+'.json'),JSON.stringify({sessionId:'changed-claude',procStart:runtime.procStart}),'utf8');
  const c=store.register(registration('claude','changed-claude',{endpoint:{mode:'claude-inbox',address:'inbox',epoch:'c',configHome,...runtime}}));
  const x=store.register(registration('codex','changed-codex',{endpoint:{mode:'embedded',address:'',epoch:'x',...runtime}})),pair=store.pair(c.id,x.id);
  if(paused)store.setPaused(true,pair.id);
  store.transaction(()=>{settleChangedPair(store,pair);store.unpair(pair.id);});store.close();store=new Store(path.join(home,'nxbridge.db'));
  for(const peer of [c,x]){
    const read=(options?:{admit?:boolean;noticeId?:string})=>collectRuntimeNotices(home,peer.host,peer.sessionId!,runtime,undefined,undefined,undefined,options);
    assert.deepEqual(await collectRuntimeNotices(home,peer.host,peer.sessionId!,{...runtime,procStart:'wrong'}),[]);
    store.updatePeer(peer.id,{state:'paused'});assert.deepEqual(await read(),[]);store.updatePeer(peer.id,{state:'ready'});
    const signal=await read({admit:false});assert.equal(signal.length,1);assert.equal(signal[0]!.source,'pair_changed');assert.equal(signal[0]!.wake,false);assert.equal(signal[0]!.message,undefined);
    assert.deepEqual(await read({noticeId:'stale-notice'}),[]);
    const notices=await read({noticeId:signal[0]!.id});assert.equal(notices.length,1);assert.match(notices[0]!.message,/Nothing forwarded or replayed/);
    await acknowledgeRuntimeNotice(home,peer.host,peer.sessionId!,{...runtime,procStart:'wrong'},notices[0]!.id,'submitted');
    assert.equal(store.setting<PairChange>(pairChangeKey(peer.id))!.state,'unknown');
    await acknowledgeRuntimeNotice(home,peer.host,peer.sessionId!,runtime,notices[0]!.id,'submitted');
    assert.equal(store.setting<PairChange>(pairChangeKey(peer.id))!.state,'submitted');assert.deepEqual(await read(),[]);
  }
  assert.equal(store.pairs().length,0);assert.equal(store.messages().length,0);
});
