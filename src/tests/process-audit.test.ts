import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, rmSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { Broker, type Adapters } from '../broker/coordinator.js';
import { Store } from '../storage/store.js';
import {DEFAULT_CONFIG} from '../config/defaults.js';
import {atomicJson} from '../shared/files.js';
import { processRegistryDirectory } from '../process/owned-processes.js';
import { FakeAdapter } from './support/fake-adapter.js';
import { temporaryDirectory } from './support/temporary.js';

test('外部状态只展示已登记的进程事实，保留损坏记录诊断',async t=>{
  const temp=temporaryDirectory(),home=temp.directory,directory=processRegistryDirectory(home),id=randomUUID(),broken=randomUUID();
  const store=new Store(':memory:'),config={...DEFAULT_CONFIG,codexBinary:path.join(home,'missing-codex'),claudeBinary:path.join(home,'missing-claude')};
  const broker=new Broker(store,config,{codex:new FakeAdapter(),claude:new FakeAdapter()} as unknown as Adapters,home);
  t.after(async()=>{await broker.stop();store.close();rmSync(directory,{recursive:true});await temp.cleanup();});
  mkdirSync(directory,{recursive:true});
                                              
  atomicJson(path.join(directory,id+'.json'),{version:1,id,home,role:'host-control',identity:{pid:2147483647,startedAt:'登记代次'},peerId:'登记成员',sessionId:'登记会话',windowsJob:'不存在的 Job',proof:{kind:'spawn'},createdAt:1});
  atomicJson(path.join(directory,broken+'.json'),{version:0,id:broken,home});
  const status=await broker.dispatch('status',{}) as any;
  assert.deepEqual(status.processes.records,[{pid:2147483647,procStart:'登记代次',role:'host-control',peerId:'登记成员',sessionId:'登记会话',releasedToUser:false}]);
  assert.equal(status.processes.notes.length,1);assert.match(status.processes.notes[0],new RegExp(broken));
});
