import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import { temporary } from './support/temporary.js';
import {managedMarker} from '../install/installation.js';
import {saveManagedRuntime} from '../hosts/managed-runtimes.js';
import {saveNativeOwnership} from '../process/owned-native.js';
import {retirementViews} from '../broker/recovery/retirement-state.js';

test('回收诊断依据当前代次，历史失败独立；无身份记录不能伪称进程已退出',async t=>{
  const home=temporary(t),ids=Array.from({length:4},()=>randomUUID()),pending=Object.fromEntries(ids.map(id=>[id,{attempts:3,nextAt:Number.MAX_SAFE_INTEGER,error:'旧独占核验失败'}]));
  for(const [index,pid]of [41,42,43].entries())saveManagedRuntime(home,{id:randomUUID(),owner:managedMarker(home),kind:'owned',state:'ready',createdAt:0,peerId:ids[index],endpoint:'unix://test-'+pid,pid,procStart:'generation'});
  saveNativeOwnership({version:1,id:randomUUID(),home,peerId:ids[3]!,configHome:home,createdAt:0,phase:'intent'});
  const views=await retirementViews(home,pending,async identity=>identity.pid===41?'dead':identity.pid===42?'alive':'unknown');
  assert.deepEqual(views.map(view=>view.state),['dead','alive','unknown','record-only']);
  assert.ok(views.every(view=>view.lastFailure==='旧独占核验失败'&&!('error'in view)));
  assert.match(views[0]!.currentReason,/均已退出/);assert.match(views[3]!.currentReason,/不代表未知启动已经退出/);
});
