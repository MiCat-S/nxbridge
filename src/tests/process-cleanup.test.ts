import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { existsSync,readFileSync } from 'node:fs';
import { releaseOwnedOfflineStatus,retireUnconfirmedContainers } from '../process/process-cleanup.js';
import { managedRuntimes,saveManagedRuntime,runtimeFor,removeManagedRuntime } from '../hosts/managed-runtimes.js';
import { forgetOwnedProcess,ownedProcesses,ownedRecordState,processRegistryDirectory,processRegistryRoot } from '../process/owned-processes.js';
import { managedMarker } from '../install/installation.js';
import {atomicJson} from '../shared/files.js';
import { processIdentity } from '../process/process.js';
import {DEFAULT_CONFIG} from '../config/defaults.js';
import {type Endpoint} from '../types.js';
import { temporaryDirectory } from './support/temporary.js';
import { unknownContainerFixture } from './unknown-container-fixture.js';
import { saveNativeOwnership,forgetNativeOwnership,nativeOwnership,type NativeOwnership } from '../process/owned-native.js';

test('自动离线清理保留未知容器；显式 purge 仅撤销归属且不伪造完成凭据',{skip:process.platform!=='win32'},async t=>{
  const temp=temporaryDirectory(),home=path.join(temp.directory,'bridge'),peerId=randomUUID(),record=await unknownContainerFixture(home,peerId);
  t.after(async()=>{forgetOwnedProcess(record);await temp.cleanup();});
  saveManagedRuntime(home,{id:record.proof.launchId!,peerId,owner:managedMarker(home),kind:'owned',state:'starting',createdAt:Date.now(),endpoint:'unix://unconfirmed'});
  assert.equal(await ownedRecordState(record),'unknown');
  const automatic=await releaseOwnedOfflineStatus(home,DEFAULT_CONFIG);assert.equal(automatic.pending,true);assert.equal(ownedProcesses(home).records.length,1);assert.equal(managedRuntimes(home).length,1);
  const explicit=await releaseOwnedOfflineStatus(home,DEFAULT_CONFIG,{purge:true});assert.equal(explicit.pending,false);assert.match(explicit.notes.join(' '),/显式请求.*未.*发送信号.*未确认.*全部退出/);
  assert.match(explicit.notes.join(' '),/未声明的 App Server 可能仍在运行.*重新配对前请核对/);
  assert.deepEqual(ownedProcesses(home).records,[]);assert.deepEqual(managedRuntimes(home),[]);assert.equal(existsSync(record.completionFile!),false);
  const retired=JSON.parse(readFileSync(path.join(processRegistryRoot(),'retired',record.id+'.json'),'utf8'));assert.equal(retired.reason,'explicit-unknown-retirement');assert.equal(existsSync(path.join(processRegistryRoot(),'retired',record.id+'.done')),false);
});

test('已记录的原生代次、包装器或声明冲突仍未知时，显式退役保留接管门禁',{skip:process.platform!=='win32'},async t=>{
  const temp=temporaryDirectory(),home=path.join(temp.directory,'bridge');t.after(temp.cleanup);
  for(const unknown of ['native','runtime','binding','root','wrapper','ambiguous-native'] as const){
    const peerId=randomUUID(),record=await unknownContainerFixture(home,peerId),identity={pid:process.pid,startedAt:''},binding:NativeOwnership={version:1,id:record.proof.launchId!,home,peerId,configHome:home,phase:'bound',createdAt:Date.now(),native:identity};
    const runtime={id:record.proof.launchId!,peerId,owner:managedMarker(home),kind:'owned' as const,state:'starting' as const,endpoint:'unix://'+peerId,createdAt:Date.now(),...(unknown==='runtime'?{pid:identity.pid,procStart:identity.startedAt}:{}),...(unknown==='wrapper'?{wrapperPid:identity.pid,wrapperProcStart:identity.startedAt}:{})};
    const sibling={...record,id:randomUUID(),role:'host-control' as const,windowsJob:undefined,completionFile:undefined,native:{pid:2147483646,startedAt:'1'}};
    if(unknown==='native')record.native=identity;
    if(unknown==='root')record.identity={...record.identity,...identity};
    if(unknown==='binding')saveNativeOwnership(binding);
    if(unknown==='ambiguous-native'){record.native={pid:2147483647,startedAt:'1'};atomicJson(path.join(processRegistryDirectory(home),sibling.id+'.json'),sibling);}
    atomicJson(path.join(processRegistryDirectory(home),record.id+'.json'),record);saveManagedRuntime(home,runtime);
    try{
      assert.deepEqual(await retireUnconfirmedContainers(home,{peerId}),{notes:[],peerIds:[]});
      assert.ok(ownedProcesses(home).records.some(value=>value.id===record.id));assert.equal(runtimeFor(home,{id:runtime.id})!.value.state,'starting');
      if(unknown==='binding')assert.deepEqual(nativeOwnership(home,peerId),binding);
    }finally{forgetOwnedProcess(record);if(unknown==='ambiguous-native')forgetOwnedProcess(sibling);if(unknown==='binding')forgetNativeOwnership(binding);removeManagedRuntime(runtimeFor(home,{id:runtime.id})!);}
  }
});

test('显式撤销未知容器仍保护已知活原生代次和用户窗口引用',{skip:process.platform!=='win32'},async t=>{
  const temp=temporaryDirectory(),home=path.join(temp.directory,'bridge'),identity=await processIdentity(process.pid);t.after(temp.cleanup);
  for(const protection of ['native','runtime','user'] as const){
    const peerId=randomUUID(),record=await unknownContainerFixture(home,peerId),runtime={id:record.proof.launchId!,peerId,owner:managedMarker(home),kind:'owned' as const,state:'starting' as const,createdAt:Date.now(),endpoint:'unix://'+peerId,...(protection==='runtime'?{pid:identity.pid,procStart:identity.startedAt}:{})};
    if(protection==='native'){record.native=identity;atomicJson(path.join(processRegistryDirectory(home),record.id+'.json'),record);}
    saveManagedRuntime(home,runtime);
    try{
      const result=await retireUnconfirmedContainers(home,{peerId,...(protection==='user'?{protectedEndpoints:[{address:runtime.endpoint,active:true} as Endpoint]}:{})});
      assert.deepEqual(result,{notes:[],peerIds:[]});assert.ok(ownedProcesses(home).records.some(value=>value.id===record.id));assert.ok(runtimeFor(home,{id:runtime.id}));
    }finally{forgetOwnedProcess(record);removeManagedRuntime(runtimeFor(home,{id:runtime.id})!);}
  }
});

test('显式退役异步核验期间出现用户绑定、新进程或新运行时，保留新的归属证据',{skip:process.platform!=='win32'},async t=>{
  const temp=temporaryDirectory(),home=path.join(temp.directory,'bridge'),identity=await processIdentity(process.pid);t.after(temp.cleanup);
  for(const change of ['binding','process','runtime'] as const){
    const peerId=randomUUID(),record=await unknownContainerFixture(home,peerId),binding:NativeOwnership={version:1,id:record.proof.launchId!,home,peerId,configHome:home,phase:'intent',createdAt:Date.now()};
    if(change==='binding')saveNativeOwnership(binding);
    const added={...record,id:randomUUID(),role:'proxy' as const,identity,windowsJob:undefined,completionFile:undefined};
    try{
      const retiring=retireUnconfirmedContainers(home,{peerId});
      await Promise.resolve().then(()=>{
        if(change==='binding')saveNativeOwnership({...binding,releasedToUser:true,native:identity});
        else if(change==='process')atomicJson(path.join(processRegistryDirectory(home),added.id+'.json'),added);
        else saveManagedRuntime(home,{id:randomUUID(),peerId,owner:managedMarker(home),kind:'owned',state:'ready',endpoint:'unix://new-holder',createdAt:Date.now(),pid:identity.pid,procStart:identity.startedAt});
      });
      assert.deepEqual(await retiring,{notes:[],peerIds:[]});assert.ok(ownedProcesses(home).records.some(value=>value.id===record.id));
      if(change==='binding')assert.equal(nativeOwnership(home,peerId)!.releasedToUser,true);
      else if(change==='process')assert.ok(ownedProcesses(home).records.some(value=>value.id===added.id));
      else assert.ok(managedRuntimes(home).some(value=>value.value.peerId===peerId));
    }finally{forgetOwnedProcess(record);if(change==='binding')forgetNativeOwnership(nativeOwnership(home,peerId)!);if(change==='process')forgetOwnedProcess(added);for(const runtime of managedRuntimes(home).filter(value=>value.value.peerId===peerId))removeManagedRuntime(runtime);}
  }
});
