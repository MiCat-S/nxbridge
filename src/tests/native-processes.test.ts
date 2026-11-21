import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { knownNativeProcesses } from '../process/native-processes.js';
import { processIdentity } from '../process/process.js';
import { recordOwnedProcess, forgetOwnedProcess, type OwnedProcessRecord } from '../process/owned-processes.js';
import { Store } from '../storage/store.js';
import {ensureHome} from '../ipc/home.js';
import { temporaryDirectory } from './support/temporary.js';
import { registration } from './support/registration.js';

test('已登记宿主查询只使用当前安装及指定配置目录，合并重复代次并排除死记录',async t=>{
  const fixture=temporaryDirectory(),second=temporaryDirectory(),home=fixture.directory,other=second.directory;await ensureHome(home);await ensureHome(other);
  const store=new Store(path.join(home,'nxbridge.db'));t.after(async()=>{store.close();await fixture.cleanup();await second.cleanup();});const identity=await processIdentity(process.pid),configHome=path.join(home,'codex');
  store.register(registration('codex','known',{endpoint:{mode:'app-server',address:'unix://known',pid:identity.pid,procStart:identity.startedAt,configHome,epoch:'known'}}));
  store.register(registration('codex','dead',{endpoint:{mode:'app-server',address:'unix://dead',pid:2147483647,procStart:'old',configHome,epoch:'dead'}}));
  assert.deepEqual(await knownNativeProcesses(home,'codex',configHome),[{pid:identity.pid,startedAt:identity.startedAt,configHome}]);
  assert.deepEqual(await knownNativeProcesses(other,'codex'),[]);assert.deepEqual(await knownNativeProcesses(home,'codex',path.join(other,'codex')),[]);
});

test('Claude 自有 worker 与原生 child 的启动记录在端点发布前也属于已知持有者',async t=>{
  const fixture=temporaryDirectory(),home=fixture.directory,identity=await processIdentity(process.pid),configHome=path.join(home,'claude'),records:OwnedProcessRecord[]=[];
  for(const role of ['claude-worker','claude-child'] as const)records.push(await recordOwnedProcess(home,{role,identity,configHome,proof:{kind:'spawn'}}));
  t.after(async()=>{for(const record of records)forgetOwnedProcess(record);await fixture.cleanup();});
  assert.deepEqual(await knownNativeProcesses(home,'claude',configHome),[{pid:identity.pid,startedAt:identity.startedAt,configHome}]);assert.deepEqual(await knownNativeProcesses(home,'codex'),[]);
});
