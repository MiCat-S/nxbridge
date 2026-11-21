import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdirSync,writeFileSync,readFileSync,existsSync} from 'node:fs';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {Store} from '../storage/store.js';
import {ensureHome} from '../ipc/home.js';
import {PACKAGE_ROOT} from '../shared/package-location.js';
import {VERSION} from '../version.js';
import { registration } from './support/registration.js';
import { temporaryDirectory } from './support/temporary.js';

test('更新审计先持久化快照，允许普通终态轮转，拒绝待处理消息和祖先丢失并保留失败证据',async t=>{
  const temp=temporaryDirectory(),root=temp.directory,home=path.join(root,'bridge'),codex=path.join(root,'codex'),cache=path.join(codex,'plugins/cache/nxbridge-local/nxbridge',VERSION);
  await ensureHome(home);mkdirSync(cache,{recursive:true});writeFileSync(path.join(cache,'fixture.json'),'{}','utf8');
  writeFileSync(path.join(codex,'config.toml'),'[hooks.state]\n','utf8');writeFileSync(path.join(home,'config.json'),JSON.stringify({codexHome:codex}),'utf8');
  const store=new Store(path.join(home,'nxbridge.db'));t.after(async()=>{store.close();await temp.cleanup();});
  const c=store.register(registration('claude','audit-c')),x=store.register(registration('codex','audit-x')),pair=store.pair(c.id,x.id);
  const old=store.accept(pair,c,'允许过期的历史','old');store.transition(old.id,'responded');
  const parent=store.accept(pair,c,'需要保留的祖先','parent');store.transition(parent.id,'responded');
  const pending=store.accept(pair,x,'仍待处理的回复','pending',parent.id);
                                      
  (store as any).db.prepare('INSERT INTO questions(id,pair_id,actor_key,status,expires_at,data) VALUES(?,?,?,?,?,?)').run('坏问题',pair.id,'audit-malformed','pending',Date.now()+600000,'{invalid');
  const tool=path.join(PACKAGE_ROOT,'tools/audit-runtime-update.mjs'),file=path.join(root,'before.json'),run=(...args:string[])=>promisify(execFile)(process.execPath,['--no-warnings',tool,...args],{env:{...process.env,NXBRIDGE_HOME:home},windowsHide:true,timeout:10000});
  await run('snapshot',file);const before=JSON.parse(readFileSync(file,'utf8'));
  assert.equal(before.state.messages.find((row:any)=>row.id===parent.id).protected,true);
  assert.equal(before.state.messages.find((row:any)=>row.id===pending.id).protected,true);
  assert.equal(before.state.messages.find((row:any)=>row.id===old.id).protected,false);
  store.maintain({maxMessages:0});
  const report=JSON.parse((await run('verify',file)).stdout);assert.deepEqual(report.removedUnprotectedTerminalIds,[old.id]);assert.equal(report.protectedMessagesPreserved,true);
  const after=JSON.parse(readFileSync(file+'.after.json','utf8')),audit=await import(pathToFileURL(tool).href);
  for(const id of [pending.id,parent.id])assert.throws(()=>audit.verifyUpdateAudit(before,{...after,state:{...after.state,messages:after.state.messages.filter((row:any)=>row.id!==id)}}),/待处理消息及受保护/);
  const badFile=path.join(root,'invalid-before.json'),bad=structuredClone(before);bad.state.messages.push({id:'必须报告的缺失消息',state:'unknown',protected:true});writeFileSync(badFile,JSON.stringify(bad),'utf8');
  await assert.rejects(run('verify',badFile));
  assert.ok(existsSync(badFile+'.after.json'));assert.match(JSON.parse(readFileSync(badFile+'.report.json','utf8')).error,/待处理消息及受保护/);
});
