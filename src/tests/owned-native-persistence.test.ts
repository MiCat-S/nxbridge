import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { existsSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs';
import fs from 'node:fs';
import { Store } from '../storage/store.js';
import { processRegistryDirectory } from '../process/owned-processes.js';
import { captureNativeProcess, forgetNativeOwnership, nativeOwnership, nativeOwnershipForSession, nativeOwnershipRecords, saveNativeOwnership, type NativeOwnership } from '../process/owned-native.js';
import { temporary } from './support/temporary.js';

function proof(t:TestContext):NativeOwnership{
  const home=temporary(t);
  return{version:1,id:randomUUID(),home,peerId:randomUUID(),configHome:home,phase:'bound',createdAt:Date.now(),sessionId:randomUUID(),handle:'abc00001'};
}
const filename=(value:NativeOwnership)=>path.join(processRegistryDirectory(value.home),'native-'+value.peerId+'.json');

test('旧版双写中断留下的数据库分歧不否定已提交文件，也不能恢复过期归属',async t=>{
  const current=proof(t),store=new Store(path.join(current.home,'nxbridge.db'));
  try{
    const old={...current,id:randomUUID(),sessionId:'old-session',releasedToUser:false};
    store.setSetting('ownedNative:'+current.peerId,old);
    const transferred={...current,releasedToUser:true};saveNativeOwnership(transferred);
    assert.deepEqual(nativeOwnership(current.home,current.peerId),transferred);
    assert.deepEqual(nativeOwnershipRecords(current.home),[transferred]);
    assert.equal(nativeOwnershipForSession(current.home,'old-session'),undefined);
    await assert.rejects(captureNativeProcess(transferred,{id:transferred.handle,sessionId:transferred.sessionId,kind:'background'}),{code:'claude_launch_unverified'});
    assert.throws(()=>forgetNativeOwnership(old),{code:'process_record_changed'});
    forgetNativeOwnership(transferred);
    assert.equal(nativeOwnership(current.home,current.peerId),undefined);assert.deepEqual(nativeOwnershipRecords(current.home),[]);
    assert.deepEqual(store.setting('ownedNative:'+current.peerId),old,'旧数据库副本不再参与读取或写入');
  }finally{store.close();}
});

test('独占数据库锁不影响原生归属保存、枚举、替换或撤销',t=>{
  const value=proof(t),database=path.join(value.home,'nxbridge.db'),store=new Store(database);store.close();
  const {DatabaseSync}=createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite'),db=new DatabaseSync(database);
  db.exec('PRAGMA journal_mode=DELETE; BEGIN EXCLUSIVE');
  try{
    saveNativeOwnership(value);assert.deepEqual(nativeOwnershipRecords(value.home),[value]);
    const updated={...value,phase:'failed' as const,failure:'已拒绝'};saveNativeOwnership(updated);
    assert.deepEqual(nativeOwnership(value.home,value.peerId),updated);
    forgetNativeOwnership(updated);assert.equal(nativeOwnership(value.home,value.peerId),undefined);
  }finally{db.exec('ROLLBACK');db.close();}
});

test('原子替换失败保留旧归属，崩溃残留临时文件不会成为启动证据',t=>{
  const value=proof(t);saveNativeOwnership(value);
  const file=filename(value),directory=path.dirname(file),original=fs.renameSync;
  t.mock.method(fs,'renameSync',(...args:Parameters<typeof fs.renameSync>)=>{
    if(args[1]===file)throw Object.assign(Error('模拟提交前存储失败'),{code:'EIO'});
    return Reflect.apply(original,fs,args);
  });syncBuiltinESMExports();
  try{assert.throws(()=>saveNativeOwnership({...value,id:randomUUID()}),{code:'EIO'});}
  finally{t.mock.restoreAll();syncBuiltinESMExports();}
  assert.deepEqual(nativeOwnership(value.home,value.peerId),value);
  assert.equal(readdirSync(directory).some(name=>name.endsWith('.tmp')),false);
  const interrupted=file+'.interrupted.tmp';writeFileSync(interrupted,'{"version":1,"id":','utf8');
  try{assert.deepEqual(nativeOwnershipRecords(value.home),[value]);}
  finally{unlinkSync(interrupted);forgetNativeOwnership(value);}
});

test('升级移除旧数据库归属副本，回滚读取不能复活已删除文件的停止授权',t=>{
  const value=proof(t),database=path.join(value.home,'nxbridge.db');let store=new Store(database);
  saveNativeOwnership(value);store.setSetting('ownedNative:'+value.peerId,value);
  store.setSetting('ownedNativeOther:preserved',{keep:true});store.setSetting('ownedNative:lower-case-test',{keep:false});
  store.close();store=new Store(database);
  try{
    assert.equal(store.setting('ownedNative:'+value.peerId),undefined);assert.equal(store.setting('ownedNative:lower-case-test'),undefined);
    assert.deepEqual(store.setting('ownedNativeOther:preserved'),{keep:true});
    assert.deepEqual(nativeOwnership(value.home,value.peerId),value,'升级仅移除冗余副本，保留原子文件');
    forgetNativeOwnership(value);assert.equal(existsSync(filename(value)),false);
    assert.equal(store.setting('ownedNative:'+value.peerId),undefined,'旧版数据库回退也找不到已撤销记录');
  }finally{store.close();}
});

test('原生归属的未知版本或不可解析文件不能提供停止授权',t=>{
  const value=proof(t);saveNativeOwnership(value);
  try{
    writeFileSync(filename(value),JSON.stringify({...value,version:2}),'utf8');
    assert.throws(()=>nativeOwnership(value.home,value.peerId),{code:'process_record_invalid'});
    assert.throws(()=>forgetNativeOwnership(value),{code:'process_record_invalid'});
    writeFileSync(filename(value),'{"version":1,','utf8');
    assert.throws(()=>nativeOwnership(value.home,value.peerId),SyntaxError);
    assert.equal(existsSync(filename(value)),true);
  }finally{unlinkSync(filename(value));}
});
