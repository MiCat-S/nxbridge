import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, lstatSync, symlinkSync } from 'node:fs';
import { temporary } from './support/temporary.js';
import {ensureHome} from '../ipc/home.js';
import { windowKey } from '../integration/hooks/session-bindings.js';
import { openModReadReceipt, readModReadReceipt, bindModReadReceipt, pruneModReadReceipts, sameModReadSecret } from '../integration/mod/mod-read-receipt.js';

test('Mod 只读票据隔离窗口、目录、会话与秘密代次，同窗口始终只有一个文件',async t=>{
  const root=temporary(t),home=path.join(root,'bridge'),configHome=path.join(root,'claude');
  await ensureHome(home);mkdirSync(path.join(configHome,'sessions'),{recursive:true});
  const record={sessionId:'original',cwd:root,procStart:'generation'},native={pid:101,parentPid:1,name:'claude',startedAt:'generation',procStart:'generation'};
  const official=path.join(configHome,'sessions','101.json');writeFileSync(official,JSON.stringify(record),'utf8');
  const identity={pid:101,record,native},first=await openModReadReceipt(home,configHome,identity,'1234567890abcdef');
  const binding={key:windowKey({host:'claude',configHome,pid:101,procStart:'generation'}),epoch:'original-epoch'};
  assert.equal(readModReadReceipt(home,first).sessionId,'original');assert.deepEqual(bindModReadReceipt(home,first,'original',binding).binding,binding);
  assert.throws(()=>readModReadReceipt(home,{...first,secret:'0'.repeat(64)}),{code:'mod_read_unavailable'});
  assert.throws(()=>readModReadReceipt(path.join(root,'other-home'),first),{code:'mod_read_unavailable'});
  assert.throws(()=>readModReadReceipt(home,{...first,id:'../../outside'}),{code:'mod_read_unavailable'});
  for(const changed of [{sessionId:'other'}, {procStart:'reused-pid'}]){
    writeFileSync(official,JSON.stringify({...record,...changed}),'utf8');
    assert.throws(()=>readModReadReceipt(home,first),{code:'mod_read_unavailable'});
  }
  writeFileSync(official,JSON.stringify(record),'utf8');
  assert.throws(()=>bindModReadReceipt(home,first,'other',binding),{code:'mod_read_unavailable'});
  assert.throws(()=>bindModReadReceipt(home,first,'original',{...binding,key:windowKey({host:'claude',configHome,pid:102,procStart:'generation'})}),{code:'mod_read_unavailable'});
  const second=await openModReadReceipt(home,configHome,identity,'1234567890abcdef');
  assert.equal(first.id,second.id);assert.notEqual(first.secret,second.secret);
  assert.throws(()=>bindModReadReceipt(home,first,'original',binding),{code:'mod_read_unavailable'});
  assert.equal(readModReadReceipt(home,second).sessionId,'original');
  const file=path.join(home,'run','mod-read',second.id+'.json');
  if(process.platform!=='win32'){
    assert.equal(lstatSync(path.dirname(file)).mode&0o777,0o700);assert.equal(lstatSync(file).mode&0o777,0o600);
  }
  assert.equal(JSON.parse(readFileSync(file,'utf8')).scope,'mod-read');assert.equal(JSON.parse(readFileSync(file,'utf8')).protocol,2);
  assert.deepEqual(readdirSync(path.dirname(file)),[second.id+'.json']);
  assert.equal(sameModReadSecret('a'.repeat(64),'a'.repeat(64)),true);assert.equal(sameModReadSecret('a'.repeat(64),'b'.repeat(64)),false);assert.equal(sameModReadSecret('a','a'),false);
});

test('Mod 只读票据按真实路径识别配置目录，链接或短文件名写法仍能绑定原窗口',async t=>{
  const root=temporary(t),home=path.join(root,'bridge'),configHome=path.join(root,'claude'),alias=path.join(root,'claude-link');
  await ensureHome(home);mkdirSync(path.join(configHome,'sessions'),{recursive:true});symlinkSync(configHome,alias,process.platform==='win32'?'junction':'dir');
  const record={sessionId:'original',cwd:root,procStart:'generation'},native={pid:101,parentPid:1,name:'claude',startedAt:'generation',procStart:'generation'};
  writeFileSync(path.join(configHome,'sessions','101.json'),JSON.stringify(record),'utf8');
  const credential=await openModReadReceipt(home,alias,{pid:101,record,native},'1234567890abcdef');
  const binding={key:windowKey({host:'claude',configHome,pid:101,procStart:'generation'}),epoch:'epoch'};
  assert.deepEqual(bindModReadReceipt(home,credential,'original',binding).binding,binding);
});

test('Mod 启动清理仅核验已记录的 PID，保留存活或无法判断的旧秘密并删除已死窗口与空指针',async t=>{
  const root=temporary(t),home=path.join(root,'bridge'),configHome=path.join(root,'claude');await ensureHome(home);mkdirSync(path.join(configHome,'sessions'),{recursive:true});
  const credentials=[];
  for(const pid of [101,102]){
    const record={sessionId:'session-'+pid,cwd:root,procStart:'generation-'+pid},native={pid,parentPid:1,name:'claude',startedAt:record.procStart};
    writeFileSync(path.join(configHome,'sessions',pid+'.json'),JSON.stringify(record),'utf8');
    credentials.push(await openModReadReceipt(home,configHome,{pid,record,native}));
  }
  const directory=path.join(home,'run','mod-read'),base=readModReadReceipt(home,credentials[0]);
  const legacy={...base,protocol:1,id:'f'.repeat(64),secret:'e'.repeat(64),sessionId:'legacy',native:{pid:103,procStart:'generation-103'},windowId:createHash('sha256').update(windowKey({host:'claude',configHome,pid:103,procStart:'generation-103'})).digest('hex')};
  writeFileSync(path.join(configHome,'sessions','103.json'),JSON.stringify({sessionId:legacy.sessionId,procStart:legacy.native.procStart}),'utf8');
  const file=path.join(directory,legacy.id+'.json'),pointer=path.join(directory,'window-'+legacy.windowId+'.json'),empty=path.join(directory,'window-'+'0'.repeat(64)+'.json');
  writeFileSync(file,JSON.stringify(legacy),'utf8');writeFileSync(pointer,JSON.stringify({id:legacy.id}),'utf8');writeFileSync(empty,JSON.stringify({id:'0'.repeat(64)}),'utf8');
  const observed:number[]=[];
  await pruneModReadReceipts(home,async records=>records.map(record=>{observed.push(record.pid);return record.pid===102?'dead':record.pid===101?'unknown':'alive';}));
  assert.deepEqual(observed.sort(),[101,102,103]);assert.equal(existsSync(path.join(directory,credentials[1]!.id+'.json')),false);assert.equal(existsSync(empty),false);
  assert.equal(readModReadReceipt(home,credentials[0]).sessionId,base.sessionId);assert.equal(readModReadReceipt(home,{id:legacy.id,secret:legacy.secret}).sessionId,'legacy');assert.equal(existsSync(pointer),true);
  await pruneModReadReceipts(home,async records=>records.map(()=>'dead'));
  assert.deepEqual(readdirSync(directory),[]);
});
