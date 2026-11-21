import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { processIdentity } from '../process/process.js';
import { ownedProcessState,stopOwnedProcess } from '../process/process-stop.js';
import { setupPublish,uninstallPublish } from './publish-fixture.js';
import { multiRuntimeFixture } from './multi-runtime-fixture.js';
import { ownedProcesses } from '../process/owned-processes.js';
import { managedRuntimes } from '../hosts/managed-runtimes.js';

test('两组忙碌原生运行时更新保留进程，卸载回收全部自有资源并保留用户进程',{timeout:170000},async t=>{
  const f=await multiRuntimeFixture(t,true),identities=await Promise.all(f.endpoints.map(e=>processIdentity(e.pid)));
  const user=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore',windowsHide:true});await once(user,'spawn');const native=await processIdentity(user.pid!);t.after(()=>stopOwnedProcess(native));
  await Promise.all([f.busy(0),f.busy(1)]);const questions=await Promise.all([f.question(0),f.question(1)]),before=(await f.call('ping')).pid;
  const updated=await setupPublish() as any;assert.equal(updated.installed,true,JSON.stringify(updated));assert.equal(updated.brokerRestarted,true,JSON.stringify(updated));assert.notEqual((await f.call('ping')).pid,before);
  const s=await f.status();assert.deepEqual(s.pairs.map((p:any)=>p.id).sort(),f.pairs.map(p=>p.id).sort());
  for(let i=0;i<2;i++){assert.equal((await processIdentity(identities[i]!.pid)).startedAt,identities[i]!.startedAt);assert.equal(s.peers.find((p:any)=>p.id===f.targets[i].id).sessionId,f.targets[i].sessionId);const q=s.questions.find((v:any)=>v.id===questions[i].request_id);assert.equal(q.status,'expired');assert.equal(q.terminalReason,'broker_restarted');}
  const ownership=ownedProcesses(f.home),runtimes=managedRuntimes(f.home),removed=await uninstallPublish() as any;assert.equal(removed.removed,true,JSON.stringify(removed));
  for(const id of identities){
    const record=runtimes.find(record=>record.value.pid===id.pid);assert.ok(record);
    if(record.value.dedicated===true)assert.equal(await ownedProcessState(id),'dead');
    else{assert.equal(await ownedProcessState(id),'alive');assert.match(removed.notes.join('；'),/独占|共享/);assert.ok(ownership.records.some(record=>record.identity.pid===id.pid));}
  }
  assert.equal(await ownedProcessState(native),'alive');
  f.release(0);f.release(1);assert.equal(f.errors.length,0);t.diagnostic(JSON.stringify({updated:true,uninstalled:true,owned:identities.map(v=>v.pid),userPreserved:native.pid,realModelCalls:0}));
});
