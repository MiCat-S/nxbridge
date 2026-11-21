import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Store } from '../storage/store.js';
import { recordSessionHistory, sessionHistoryKey, sessionHistoryPath, sessionHistoryState, sessionHistoryNeedsVerification, verifySessionHistory } from '../broker/recovery/session-history.js';
import type { Endpoint, Host } from '../types.js';
import { registration } from './support/registration.js';
import { temporary } from './support/temporary.js';

const body=(host:Host,id:string)=>host==='codex'?JSON.stringify({type:'session_meta',payload:{id}})+'\n':JSON.stringify({type:'file-history-snapshot'})+'\n'+JSON.stringify({type:'user',sessionId:id})+'\n';
function fixture(t:TestContext,host:Host='codex'){
  const home=temporary(t),store=new Store(':memory:');t.after(()=>store.close());
  const input=registration(host,'history');input.endpoint.configHome=home;
  const peer=store.register(input),endpoint=store.endpoint(peer.id)!;
  const directory=path.join(home,host==='codex'?'sessions':'projects','original');fs.mkdirSync(directory,{recursive:true});
  const file=path.join(directory,host==='codex'?'rollout-2026-history.jsonl':'history.jsonl');fs.writeFileSync(file,body(host,peer.sessionId!),'utf8');
  return{home,store,peer,endpoint,file,record:()=>recordSessionHistory(store,peer,endpoint,file),state:()=>verifySessionHistory(store,peer,endpoint,{fresh:true}),peek:()=>sessionHistoryState(store,peer,endpoint)};
}

for(const host of ['codex','claude'] as const)test(host+' 历史只有实际核验落盘后才能判定删除，重复登记缺失路径不抹除凭据',async t=>{
  const f=fixture(t,host);assert.equal(await f.state(),'unknown');
  f.record();assert.equal(await f.state(),'present');assert.ok(f.store.setting(sessionHistoryKey(f.peer.id)));
  fs.unlinkSync(f.file);f.record();assert.equal(await f.state(),'missing');
  assert.equal(sessionHistoryState(f.store,{...f.peer,sessionId:'new'},f.endpoint),'unknown');
});

for(const host of ['codex','claude'] as const)test(host+' 历史库链接到其他目录仍可核验，目标被替换或离线时保留未知',async t=>{
  const f=fixture(t,host),active=path.join(f.home,host==='codex'?'sessions':'projects'),target=path.join(temporary(t),'history-store');
  fs.renameSync(active,target);fs.symlinkSync(target,active,process.platform==='win32'?'junction':'dir');
  f.record();assert.equal(await f.state(),'present');assert.ok(sessionHistoryPath(f.store,f.peer,f.endpoint));
  fs.unlinkSync(f.file);assert.equal(await f.state(),'missing');
  const original=target+'-original';fs.renameSync(target,original);assert.equal(await f.state(),'unknown');
  fs.mkdirSync(target);assert.equal(await f.state(),'unknown');
  fs.rmdirSync(target);fs.renameSync(original,target);assert.equal(await f.state(),'missing');
});

test('链接的归档库可保存物理原生路径，换链不能证明旧会话删除',async t=>{
  const f=fixture(t),target=temporary(t),archive=path.join(f.home,'archived_sessions');fs.symlinkSync(target,archive,process.platform==='win32'?'junction':'dir');
  const physical=path.join(target,'renamed.jsonl');fs.renameSync(f.file,physical);
  recordSessionHistory(f.store,f.peer,f.endpoint,physical);assert.equal(await f.state(),'present');
  fs.unlinkSync(physical);assert.equal(await f.state(),'missing');
  fs.rmSync(archive);fs.symlinkSync(temporary(t),archive,process.platform==='win32'?'junction':'dir');assert.equal(await f.state(),'unknown');
});

test('Codex 归档、改名迁移与压缩副本均不能误判成删除',async t=>{
  const f=fixture(t);f.record();
  const archive=path.join(f.home,'archived_sessions');fs.mkdirSync(archive);
  const moved=path.join(archive,'renamed.jsonl');fs.renameSync(f.file,moved);assert.equal(await f.state(),'present');
  const offline=path.join(f.home,'archive-offline');fs.renameSync(archive,offline);assert.equal(await f.state(),'unknown');fs.renameSync(offline,archive);
  fs.unlinkSync(moved);
  const alternate=path.join(f.home,'sessions','alternate.jsonl');fs.writeFileSync(alternate,body('codex','history'),'utf8');assert.equal(await f.state(),'present');fs.unlinkSync(alternate);
  const compressed=path.join(archive,path.basename(f.file)+'.zst');fs.writeFileSync(compressed,'已压缩的历史副本','utf8');assert.equal(await f.state(),'present');
  fs.unlinkSync(compressed);assert.equal(await f.state(),'missing');
});

test('原生路径、配置目录和成员变化后必须重新获得本会话的历史凭据',async t=>{
  const f=fixture(t);f.record();
  assert.equal(sessionHistoryState(f.store,f.peer,{...f.endpoint,configHome:undefined}),'unknown');
  assert.equal(sessionHistoryState(f.store,f.peer,{...f.endpoint,peerId:'another-member'}),'unknown');
  const other=path.join(f.home,'other-home');fs.mkdirSync(other);
  assert.equal(sessionHistoryState(f.store,f.peer,{...f.endpoint,configHome:other}),'unknown');
  const moved=path.join(f.home,'sessions','new-native.jsonl'),endpoint:Endpoint&{nativeSession:{transcriptPath:string}}={...f.endpoint,nativeSession:{transcriptPath:moved}};
  assert.equal(sessionHistoryState(f.store,f.peer,endpoint),'unknown');
  recordSessionHistory(f.store,f.peer,endpoint);assert.equal(await f.state(),'unknown','不能继续拿旧路径的记录证明新路径已经落盘');
  fs.writeFileSync(moved,body('codex','history'),'utf8');recordSessionHistory(f.store,f.peer,endpoint);assert.equal(sessionHistoryState(f.store,f.peer,endpoint),'present');
  recordSessionHistory(f.store,f.peer,{...endpoint,configHome:other});assert.equal(sessionHistoryState(f.store,f.peer,endpoint),'unknown');
});

for(const host of ['codex','claude'] as const)test(host+' 错误身份、未完成文件和目录不能生成或复用历史凭据',async t=>{
  const f=fixture(t,host);
  fs.writeFileSync(f.file,body(host,'wrong-session'),'utf8');f.record();assert.equal(await f.state(),'unknown');
  fs.writeFileSync(f.file,body(host,'history'),'utf8');f.record();assert.equal(await f.state(),'present');
  fs.writeFileSync(f.file,body(host,'wrong-session'),'utf8');assert.equal(await f.state(),'unknown');f.record();fs.unlinkSync(f.file);assert.equal(await f.state(),'unknown');
  fs.writeFileSync(f.file,'{"session','utf8');f.record();assert.equal(f.store.setting(sessionHistoryKey(f.peer.id)),null);fs.unlinkSync(f.file);
  fs.mkdirSync(f.file);f.record();assert.equal(await f.state(),'unknown');
});

test('不接受配置目录外的历史，Codex 身份必须来自首条会话记录',async t=>{
  const f=fixture(t),outside=path.join(temporary(t),'history.jsonl');fs.writeFileSync(outside,body('codex','history'),'utf8');
  recordSessionHistory(f.store,f.peer,f.endpoint,outside);assert.equal(await f.state(),'unknown');
  fs.writeFileSync(f.file,JSON.stringify({type:'event_msg'})+'\n'+body('codex','history'),'utf8');f.record();assert.equal(await f.state(),'unknown');
  fs.unlinkSync(f.file);f.record();assert.equal(await f.state(),'unknown');
});

test('读文件和枚举目录的权限或 IO 错误均为未知，故障恢复后才允许判定缺失',async t=>{
  t.mock.timers.enable({apis:['Date'],now:1000000});
  const f=fixture(t);f.record();
  const read=t.mock.method(fs,'readSync',()=>{throw Object.assign(new Error('读取失败'),{code:'EIO'});});
  assert.equal(await f.state(),'unknown');read.mock.restore();
  fs.unlinkSync(f.file);
  const list=t.mock.method(fs.promises,'readdir',async()=>{throw Object.assign(new Error('拒绝访问'),{code:'EACCES'});});
  assert.equal(await f.state(),'unknown');list.mock.restore();t.mock.timers.tick(15000);assert.equal(await f.state(),'missing');
});

test('活动历史库、曾观测的归档库或配置目录不可用时，不能推断单个会话被删除',async t=>{
  const f=fixture(t),archive=path.join(f.home,'archived_sessions');fs.mkdirSync(archive);f.record();fs.unlinkSync(f.file);
  const inactive=path.join(f.home,'archive-offline');fs.renameSync(archive,inactive);assert.equal(await f.state(),'unknown');fs.renameSync(inactive,archive);
  const active=path.join(f.home,'sessions'),offline=path.join(f.home,'sessions-offline');fs.renameSync(active,offline);assert.equal(await f.state(),'unknown');fs.renameSync(offline,active);assert.equal(await f.state(),'missing');
  assert.equal(sessionHistoryState(f.store,f.peer,{...f.endpoint,configHome:path.join(f.home,'unavailable')}),'unknown');
});

test('搜索遇到无法识别的新历史时保留未知，完整识别为其他会话才可排除',async t=>{
  t.mock.timers.enable({apis:['Date'],now:1000000});
  const f=fixture(t);f.record();fs.unlinkSync(f.file);
  const incomplete=path.join(f.home,'sessions','another.jsonl');fs.writeFileSync(incomplete,'','utf8');assert.equal(await f.state(),'unknown');
  fs.writeFileSync(incomplete,body('codex','another'),'utf8');t.mock.timers.tick(15000);assert.equal(await f.state(),'missing');
  const pending=path.join(f.home,'sessions','history.jsonl.pending');fs.writeFileSync(pending,'未完成的历史搬移','utf8');assert.equal(await f.state(),'unknown');
});

for(const host of ['codex','claude'] as const)test(host+' 历史库同路径被新目录替换后仍然未知，恢复原目录后才重新核验',async t=>{
  const f=fixture(t,host);f.record();
  const active=path.join(f.home,host==='codex'?'sessions':'projects'),offline=path.join(f.home,'old-store');
  fs.renameSync(active,offline);fs.mkdirSync(active);assert.equal(await f.state(),'unknown');
  fs.rmdirSync(active);fs.renameSync(offline,active);assert.equal(await f.state(),'present');
  fs.unlinkSync(f.file);assert.equal(await f.state(),'missing');
});

test('曾记录的归档库被替换也不能证明单个会话删除',async t=>{
  const f=fixture(t),archive=path.join(f.home,'archived_sessions');fs.mkdirSync(archive);f.record();fs.unlinkSync(f.file);
  fs.renameSync(archive,path.join(f.home,'old-archive'));fs.mkdirSync(archive);assert.equal(await f.state(),'unknown');
});

test('旧版凭据缺少目录身份时不能凭空目录判定删除',async t=>{
  const f=fixture(t);f.record();const key=sessionHistoryKey(f.peer.id),proof=f.store.setting<Record<string,unknown>>(key)!;
  delete proof.storeIdentities;f.store.setSetting(key,proof);assert.equal(await f.state(),'present');
  fs.unlinkSync(f.file);assert.equal(await f.state(),'unknown');
});

test('迁移后直接核验发现的路径，保持原生绑定稳定并返回可恢复路径',async t=>{
  const f=fixture(t),endpoint:Endpoint&{nativeSession:{transcriptPath:string}}={...f.endpoint,nativeSession:{transcriptPath:f.file}};
  recordSessionHistory(f.store,f.peer,endpoint);
  const archive=path.join(f.home,'archived_sessions');fs.mkdirSync(archive);
  const moved=path.join(archive,'renamed.jsonl');fs.renameSync(f.file,moved);
  assert.equal(await verifySessionHistory(f.store,f.peer,endpoint,{fresh:true}),'present');
  const list=t.mock.method(fs.promises,'readdir',async()=>{throw new Error('不应再次扫描历史库');});
  const canonical=fs.realpathSync.native(moved);
  assert.equal(sessionHistoryPath(f.store,f.peer,endpoint),process.platform==='win32'?canonical.toLowerCase():canonical);
  recordSessionHistory(f.store,f.peer,endpoint);assert.equal(sessionHistoryState(f.store,f.peer,endpoint),'present');
  assert.equal(list.mock.callCount(),0);
});

test('压缩副本阻止误删，但不能作为原生恢复路径',async t=>{
  const f=fixture(t);f.record();fs.unlinkSync(f.file);
  fs.writeFileSync(f.file+'.zst','压缩后的历史','utf8');assert.equal(await f.state(),'present');
  const list=t.mock.method(fs.promises,'readdir',async()=>{throw new Error('压缩副本也应直接复查');});
  assert.equal(sessionHistoryPath(f.store,f.peer,f.endpoint),undefined);
  assert.equal(f.peek(),'present');assert.equal(list.mock.callCount(),0);
});

test('Claude 工具输出和记忆文件不阻止识别真正删除的历史',async t=>{
  const f=fixture(t,'claude');f.record();fs.unlinkSync(f.file);
  const project=path.dirname(f.file);
  for(const [directory,file] of [['tool-results','output.txt'],['memory','MEMORY.md']] as const){
    const folder=path.join(project,directory);fs.mkdirSync(folder);fs.writeFileSync(path.join(folder,file),'与会话身份无关的内容','utf8');
  }
  const read=t.mock.method(fs,'openSync',()=>{throw new Error('辅助文件不应作为历史读取');});
  assert.equal(await f.state(),'missing');assert.equal(read.mock.callCount(),0);
});

test('未知核验采用退避，原路径恢复与显式刷新不受退避影响',async t=>{
  t.mock.timers.enable({apis:['Date'],now:1000000});
  const f=fixture(t);f.record();fs.unlinkSync(f.file);
  const incomplete=path.join(f.home,'sessions','another.jsonl');fs.writeFileSync(incomplete,'未完成','utf8');
  const read=t.mock.method(fs,'readSync');
  assert.equal(await f.state(),'unknown');const first=read.mock.callCount();assert.ok(first>0);
  const verify=()=>verifySessionHistory(f.store,f.peer,f.endpoint);
  t.mock.timers.tick(5000);assert.equal(await verify(),'unknown');t.mock.timers.tick(5000);assert.equal(await verify(),'unknown');assert.equal(read.mock.callCount(),first);
  t.mock.timers.tick(5000);assert.equal(await verify(),'unknown');assert.ok(read.mock.callCount()>first);
  const second=read.mock.callCount();t.mock.timers.tick(15000);assert.equal(await verify(),'unknown');assert.equal(read.mock.callCount(),second);
  fs.writeFileSync(f.file,body('codex','history'),'utf8');assert.equal(await f.state(),'present');
  fs.unlinkSync(f.file);fs.unlinkSync(incomplete);assert.equal(await f.state(),'missing');assert.equal(await f.state(),'missing','调用方可以立即再次确认删除');
  const moved=path.join(f.home,'sessions','moved.jsonl');fs.writeFileSync(moved,body('codex','history'),'utf8');assert.equal(await f.state(),'present','缺失结果不能遮蔽后来恢复的文件');
});

test('其他会话的身份缓存避开重复读取，但文件改变后必须重新核验',async t=>{
  const f=fixture(t);f.record();fs.unlinkSync(f.file);
  const other=path.join(f.home,'sessions','other.jsonl');fs.writeFileSync(other,body('codex','another'),'utf8');
  const read=t.mock.method(fs,'readSync');assert.equal(await f.state(),'missing');const reads=read.mock.callCount();assert.ok(reads>0);
  assert.equal(f.peek(),'missing');assert.equal(read.mock.callCount(),reads);
  fs.writeFileSync(other,body('codex','history'),'utf8');assert.equal(await f.state(),'present');assert.ok(read.mock.callCount()>reads);
});

test('一次异步核验跨越读取批次后仍能完成，不因总量返回永久未知',async t=>{
  t.mock.timers.enable({apis:['Date'],now:1000000});
  const f=fixture(t);f.record();fs.unlinkSync(f.file);
  const directory=path.join(f.home,'sessions');
  for(let index=0;index<129;index++)fs.writeFileSync(path.join(directory,index+'.jsonl'),body('codex','another-'+index)+' '.repeat(64*1024),'utf8');
  const read=t.mock.method(fs,'readSync');assert.equal(await f.state(),'missing');
  const bytes=read.mock.calls.reduce((sum,call)=>sum+Number(call.result),0);assert.equal(bytes,129*64*1024);
});

test('超出读取上限的 Codex 元数据保持未知，不从截断内容猜测身份',async t=>{
  const f=fixture(t),large=JSON.stringify({type:'session_meta',payload:{id:'history',instructions:'长'.repeat(64*1024)}})+'\n';
  fs.writeFileSync(f.file,large,'utf8');f.record();assert.equal(await f.state(),'unknown');
  fs.writeFileSync(f.file,body('codex','history'),'utf8');f.record();fs.unlinkSync(f.file);
  fs.writeFileSync(path.join(f.home,'sessions','large.jsonl'),large,'utf8');assert.equal(await f.state(),'unknown');
});

test('状态查询不启动扫描，缺失快照过期后等待显式核验',async t=>{
  t.mock.timers.enable({apis:['Date'],now:1000000});
  const f=fixture(t);f.record();fs.unlinkSync(f.file);
  fs.writeFileSync(path.join(f.home,'sessions','another.jsonl'),body('codex','another'),'utf8');assert.equal(await f.state(),'missing');
  const read=t.mock.method(fs,'readSync'),list=t.mock.method(fs.promises,'readdir');
  for(let index=0;index<12;index++){
    t.mock.timers.tick(5000);assert.equal(f.peek(),index<5?'missing':'unknown');assert.equal(sessionHistoryPath(f.store,f.peer,f.endpoint),undefined);
  }
  assert.equal(read.mock.callCount(),0);assert.equal(list.mock.callCount(),0);
  assert.equal(await f.state(),'missing');assert.ok(read.mock.callCount()>0);assert.ok(list.mock.callCount()>0);
});

test('恢复核验立即发现新路径和原地改写，不受缺失快照影响',async t=>{
  const f=fixture(t);f.record();fs.unlinkSync(f.file);assert.equal(await f.state(),'missing');
  const restored=path.join(f.home,'sessions','restored.jsonl');fs.writeFileSync(restored,body('codex','history'),'utf8');
  assert.equal(await f.state(),'present');fs.unlinkSync(restored);
  const other=path.join(f.home,'sessions','other.jsonl');fs.writeFileSync(other,body('codex','another'),'utf8');assert.equal(await f.state(),'missing');
  fs.writeFileSync(other,body('codex','history'),'utf8');
  const expected=fs.realpathSync.native(other);
  assert.equal(await f.state(),'present');
  assert.equal(sessionHistoryPath(f.store,f.peer,f.endpoint,{fresh:true}),process.platform==='win32'?expected.toLowerCase():expected);
});

test('超过旧缓存容量的大历史库分批遍历后仍可确认删除，正文只读取一次',async t=>{
  t.mock.timers.enable({apis:['Date'],now:1000000});
  const f=fixture(t);f.record();fs.unlinkSync(f.file);
  for(let index=0;index<2050;index++)fs.writeFileSync(path.join(f.home,'sessions',index+'.jsonl'),body('codex','another-'+index)+' '.repeat(4096),'utf8');
  const read=t.mock.method(fs,'readSync');assert.equal(await f.state(),'missing');assert.equal(read.mock.callCount(),2050);
  assert.equal(sessionHistoryState(f.store,f.peer,f.endpoint,{fresh:true}),'missing');assert.equal(read.mock.callCount(),2050);
});

test('同一原生目录的不同成员共享历史清单',async t=>{
  const f=fixture(t);f.record();
  const input=registration('codex','second-history');input.endpoint.configHome=f.home;
  const peer=f.store.register(input),endpoint=f.store.endpoint(peer.id)!,file=path.join(f.home,'sessions','second.jsonl');
  fs.writeFileSync(file,body('codex',peer.sessionId!),'utf8');recordSessionHistory(f.store,peer,endpoint,file);
  fs.unlinkSync(f.file);fs.unlinkSync(file);
  fs.writeFileSync(path.join(f.home,'sessions','unrelated.jsonl'),body('codex','unrelated'),'utf8');assert.equal(await f.state(),'missing');
  const read=t.mock.method(fs,'readSync'),list=t.mock.method(fs.promises,'readdir');
  assert.equal(sessionHistoryState(f.store,peer,endpoint),'missing');assert.equal(read.mock.callCount(),0);assert.equal(list.mock.callCount(),0);
  fs.writeFileSync(path.join(f.home,'sessions','relocated-second.jsonl'),body('codex',peer.sessionId!),'utf8');
  assert.equal(await f.state(),'missing');assert.equal(sessionHistoryNeedsVerification(f.store,peer,endpoint),false,'其他成员核验发现的路径也能阻止多余的持有者探测');
});

test('Claude 项目内辅助目录不枚举，项目本身名为 memory 仍需核验',async t=>{
  const f=fixture(t,'claude');f.record();fs.unlinkSync(f.file);
  const auxiliary=path.join(path.dirname(f.file),'tool-results');fs.mkdirSync(auxiliary);
  fs.writeFileSync(path.join(auxiliary,'large-output.jsonl'),'工具输出，不是会话','utf8');
  const read=fs.promises.readdir,list=t.mock.method(fs.promises,'readdir',((...args:Parameters<typeof fs.promises.readdir>)=>{
    assert.notEqual(path.basename(String(args[0])),'tool-results');return read(...args);
  }) as typeof fs.promises.readdir);
  assert.equal(await f.state(),'missing');list.mock.restore();
  const project=path.join(f.home,'projects','memory');fs.mkdirSync(project);fs.writeFileSync(path.join(project,'renamed.jsonl'),body('claude','history'),'utf8');
  assert.equal(await f.state(),'present');
});

test('已缓存缺失不能掩盖最终确认遇到的文件 IO 错误',async t=>{
  const f=fixture(t);f.record();fs.unlinkSync(f.file);
  const file=path.join(f.home,'sessions','another.jsonl');fs.writeFileSync(file,body('codex','another'),'utf8');assert.equal(await f.state(),'missing');
  const stat=fs.lstatSync;t.mock.method(fs,'lstatSync',((...args:Parameters<typeof fs.lstatSync>)=>{
    if(path.basename(String(args[0]))==='another.jsonl')throw Object.assign(new Error('无法访问历史'),{code:'EIO'});
    return stat(...args);
  }) as typeof fs.lstatSync);
  assert.equal(await f.state(),'unknown');
});

test('时间戳完全相同也必须发现原地改写、改名恢复和压缩副本',async t=>{
  const stat=fs.lstatSync;
  t.mock.method(fs,'lstatSync',((...args:Parameters<typeof fs.lstatSync>)=>{
    const value=stat(...args);return value&&Object.assign(value,{mtimeNs:1n,ctimeNs:1n});
  }) as typeof fs.lstatSync);
  const f=fixture(t);f.record();fs.unlinkSync(f.file);
  const other=path.join(f.home,'sessions','another.jsonl');fs.writeFileSync(other,body('codex','another'),'utf8');
  assert.equal(await f.state(),'missing');fs.writeFileSync(other,body('codex','history'),'utf8');assert.equal(await f.state(),'present');
  fs.unlinkSync(other);assert.equal(await f.state(),'missing');
  const renamed=path.join(f.home,'sessions','renamed.jsonl');fs.writeFileSync(renamed,body('codex','history'),'utf8');assert.equal(await f.state(),'present');
  fs.unlinkSync(renamed);assert.equal(await f.state(),'missing');
  fs.writeFileSync(f.file+'.zst','压缩副本','utf8');assert.equal(await f.state(),'present');
});

test('异步核验期间凭据失效时不能恢复旧凭据或返回删除证明',async t=>{
  const f=fixture(t);f.record();fs.unlinkSync(f.file);
  const read=fs.promises.readdir;let changed=false;
  t.mock.method(fs.promises,'readdir',(async(...args:Parameters<typeof fs.promises.readdir>)=>{
    const entries=await read(...args);
    if(!changed){changed=true;f.store.setSetting(sessionHistoryKey(f.peer.id),null);}
    return entries;
  }) as typeof fs.promises.readdir);
  assert.equal(await f.state(),'unknown');assert.equal(f.store.setting(sessionHistoryKey(f.peer.id)),null);
});

test('低成本核验门槛仅接受有作用域凭据且已知路径缺失的成员',t=>{
  const f=fixture(t),needed=()=>sessionHistoryNeedsVerification(f.store,f.peer,f.endpoint);
  assert.equal(needed(),false);f.record();assert.equal(needed(),false);fs.unlinkSync(f.file);assert.equal(needed(),true);
  const read=t.mock.method(fs,'readSync',()=>{throw new Error('门槛判断不能读取正文');});
  const list=t.mock.method(fs.promises,'readdir',async()=>{throw new Error('门槛判断不能枚举目录');});
  assert.equal(needed(),true);assert.equal(read.mock.callCount(),0);assert.equal(list.mock.callCount(),0);
  assert.equal(sessionHistoryNeedsVerification(f.store,{...f.peer,sessionId:'another'},f.endpoint),false);
  assert.equal(sessionHistoryNeedsVerification(f.store,f.peer,{...f.endpoint,peerId:'another'}),false);
  const active=path.join(f.home,'sessions');fs.renameSync(active,path.join(f.home,'old-sessions'));fs.mkdirSync(active);assert.equal(needed(),false);
});

for(const reader of ['门槛','状态'] as const)test(reader+' 查询见过的新归档库离线后不能证明单会话删除',async t=>{
  const f=fixture(t);f.record();fs.unlinkSync(f.file);const archive=path.join(f.home,'archived_sessions');fs.mkdirSync(archive);
  if(reader==='门槛')assert.equal(sessionHistoryNeedsVerification(f.store,f.peer,f.endpoint),true);
  else assert.equal(f.peek(),'unknown');
  fs.renameSync(archive,path.join(f.home,'offline-archive'));
  assert.equal(sessionHistoryNeedsVerification(f.store,f.peer,f.endpoint),false);assert.equal(await f.state(),'unknown');
});

test('路径不可读、辅助缓存内已有历史或未知退避期间不需要探测持有者',async t=>{
  t.mock.timers.enable({apis:['Date'],now:1000000});
  const f=fixture(t);f.record();fs.unlinkSync(f.file);
  const stat=fs.lstatSync,blocked=t.mock.method(fs,'lstatSync',((...args:Parameters<typeof fs.lstatSync>)=>{
    if(path.basename(String(args[0]))===path.basename(f.file))throw Object.assign(new Error('无法访问历史'),{code:'EACCES'});
    return stat(...args);
  }) as typeof fs.lstatSync);
  assert.equal(sessionHistoryNeedsVerification(f.store,f.peer,f.endpoint),false);blocked.mock.restore();
  const incomplete=path.join(f.home,'sessions','another.jsonl');fs.writeFileSync(incomplete,'未完成','utf8');
  assert.equal(await verifySessionHistory(f.store,f.peer,f.endpoint),'unknown');assert.equal(sessionHistoryNeedsVerification(f.store,f.peer,f.endpoint),false);
  t.mock.timers.tick(15000);assert.equal(sessionHistoryNeedsVerification(f.store,f.peer,f.endpoint),true);
  fs.unlinkSync(incomplete);const moved=path.join(f.home,'sessions','relocated.jsonl');fs.writeFileSync(moved,body('codex','history'),'utf8');
  assert.equal(await f.state(),'present');assert.equal(sessionHistoryNeedsVerification(f.store,f.peer,f.endpoint),false);
  fs.unlinkSync(moved);assert.equal(sessionHistoryNeedsVerification(f.store,f.peer,f.endpoint),true);
  fs.writeFileSync(f.file+'.zst','压缩副本','utf8');assert.equal(await f.state(),'present');assert.equal(sessionHistoryNeedsVerification(f.store,f.peer,f.endpoint),false);
});

test('同一成员绑定的并发核验共用正在进行的扫描，完成后释放',async t=>{
  const f=fixture(t);f.record();fs.unlinkSync(f.file);
  fs.writeFileSync(path.join(f.home,'sessions','unrelated.jsonl'),body('codex','unrelated'),'utf8');
  let release!:()=>void;const gate=new Promise<void>(resolve=>release=resolve),read=fs.promises.readdir;
  t.after(()=>release());
  const list=t.mock.method(fs.promises,'readdir',(async(...args:Parameters<typeof fs.promises.readdir>)=>{await gate;return read(...args);}) as typeof fs.promises.readdir);
  const first=f.state(),second=verifySessionHistory(f.store,{...f.peer},{...f.endpoint},{fresh:true}),calls=list.mock.callCount();release();
  assert.equal(calls,1);assert.deepEqual(await Promise.all([first,second]),['missing','missing']);
  const completed=list.mock.callCount();assert.equal(await f.state(),'missing');assert.ok(list.mock.callCount()>completed);
});

test('同一 home 的不同成员并发核验互不取消，端点变化也不复用旧扫描',async t=>{
  const f=fixture(t);f.record();
  const input=registration('codex','second-history');input.endpoint.configHome=f.home;
  const peer=f.store.register(input),endpoint=f.store.endpoint(peer.id)!,file=path.join(f.home,'sessions','second.jsonl');
  fs.writeFileSync(file,body('codex',peer.sessionId!),'utf8');recordSessionHistory(f.store,peer,endpoint,file);fs.unlinkSync(f.file);fs.unlinkSync(file);
  let release!:()=>void;const gate=new Promise<void>(resolve=>release=resolve),read=fs.promises.readdir;t.after(()=>release());
  const list=t.mock.method(fs.promises,'readdir',(async(...args:Parameters<typeof fs.promises.readdir>)=>{await gate;return read(...args);}) as typeof fs.promises.readdir);
  const first=f.state(),second=verifySessionHistory(f.store,peer,endpoint,{fresh:true}),changed=verifySessionHistory(f.store,f.peer,{...f.endpoint,epoch:f.endpoint.epoch+'-new'},{fresh:true});
  const calls=list.mock.callCount();release();assert.equal(calls,3);
  assert.deepEqual(await Promise.all([first,second,changed]),['missing','missing','missing']);
});
