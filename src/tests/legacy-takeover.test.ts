import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fixture } from './support/broker-fixture.js';
import { temporary } from './support/temporary.js';
import { captureLegacyTakeovers, returnLegacyTakeover } from '../broker/recovery/legacy-takeover.js';
import { saveManagedRuntime } from '../hosts/managed-runtimes.js';
import { managedMarker } from '../install/installation.js';

for(const owned of [false,true])test(`旧接管迁移${owned?'只接续原成员的私有启动':'不认领普通 wrapper 的共享前台运行时'}`,async t=>{
  const f=fixture(t),home=temporary(t),runtimeId=randomUUID(),endpoint={...f.store.endpoint(f.x.id)!,address:'unix://'+path.join(home,'run','cx-test.sock'),pid:90101,procStart:'old',configHome:home,runtimeId};f.store.saveEndpoint(endpoint);f.store.pair(f.c.id,f.x.id);
  saveManagedRuntime(home,{id:runtimeId,owner:managedMarker(home),kind:'owned',state:'ready',endpoint:endpoint.address,pid:90101,procStart:'old',configHome:home,createdAt:1,...(owned?{peerId:f.x.id}:{})});
  const returned=await returnLegacyTakeover(f.store,home,f.x,async values=>values.map(()=>'dead'));
  assert.equal(returned,owned);assert.equal(f.store.peer(f.x.id).owner,owned?'nxbridge':'user');
});

test('迁移候选只保存一次；升级后新建的用户记录不会被后续扫描认领',async t=>{
  const f=fixture(t),home=temporary(t);captureLegacyTakeovers(f.store,home);f.store.pair(f.c.id,f.x.id);
  let probes=0;assert.equal(await returnLegacyTakeover(f.store,home,f.x,async()=>{probes++;return['dead'];}),false);assert.equal(probes,0);assert.equal(f.store.peer(f.x.id).owner,'user');
});

test('旧记录已清理归属证据时只在证明退出后提示，重新存活清除阻塞，不认领用户进程',async t=>{
  const f=fixture(t),home=temporary(t),endpoint={...f.store.endpoint(f.x.id)!,address:'unix://'+path.join(home,'run','cx-pruned.sock'),pid:2147483647,procStart:'old',runtimeId:randomUUID(),configHome:home};f.store.saveEndpoint(endpoint);f.store.pair(f.c.id,f.x.id);
  let state:'alive'|'dead'='alive';const probe=async(values:unknown[])=>values.map(()=>state);
  assert.equal(await returnLegacyTakeover(f.store,home,f.x,probe),false);assert.equal(f.store.setting('legacyTakeoverNeedsUser:'+f.x.id),null);
  const migration=f.store.setting<any>('legacyTakeoverMigration:v2');migration[f.x.id].nextAt=0;f.store.setSetting('legacyTakeoverMigration:v2',migration);state='dead';
  assert.equal(await returnLegacyTakeover(f.store,home,f.x,probe),false);assert.ok(f.store.setting('legacyTakeoverNeedsUser:'+f.x.id));assert.equal(f.store.peer(f.x.id).owner,'user');
  migration[f.x.id].nextAt=0;f.store.setSetting('legacyTakeoverMigration:v2',migration);state='alive';await returnLegacyTakeover(f.store,home,f.x,probe);assert.equal(f.store.setting('legacyTakeoverNeedsUser:'+f.x.id),null);
});
