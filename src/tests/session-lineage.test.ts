import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { createRequire } from 'node:module';
import { Store } from '../storage/store.js';
import { Questions } from '../integration/mcp/questions.js';
import { registrationWindow } from '../integration/hooks/session-bindings.js';
import {DEFAULT_CONFIG} from '../config/defaults.js';
import {type Actor,type Host,type RegisterInput} from '../types.js';
import { fixture } from './support/broker-fixture.js';
import { registration } from './support/registration.js';
import { temporaryDirectory } from './support/temporary.js';

function window(host:Host,sessionId:string,pid:number,extra:Partial<RegisterInput>={}):RegisterInput{
  return registration(host,sessionId,{endpoint:{mode:host==='claude'?'claude-inbox':'embedded',address:host==='claude'?'inbox-'+pid:'',epoch:host+':'+pid+':'+sessionId,pid,procStart:'generation-'+pid,configHome:path.resolve('/isolated',host)},...extra});
}
function actor(store:Store,peerId:string,callId='call'):Actor{
  const peer=store.peer(peerId),binding=store.bindings.current(peerId)!;
  return{host:peer.host,sessionId:peer.sessionId!,callId,binding:{key:binding.key,epoch:binding.epoch}};
}

test('会话迁移保留旧配对、成员、消息及调用幂等，重复打开不再迁移',t=>{
  const temp=temporaryDirectory(),file=path.join(temp.directory,'legacy.db'),{DatabaseSync}=createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');
  const db=new DatabaseSync(file),c={...registration('claude','c'),id:'member-c',owner:'user',state:'ready',updatedAt:1},x={...c,id:'member-x',host:'codex',sessionId:'x'};
  db.exec(`CREATE TABLE peers(id TEXT PRIMARY KEY,host TEXT NOT NULL,session_id TEXT,data TEXT NOT NULL,UNIQUE(host,session_id));
    CREATE TABLE pairs(id TEXT PRIMARY KEY,claude TEXT REFERENCES peers(id),codex TEXT REFERENCES peers(id),paused INTEGER DEFAULT 0,archived INTEGER DEFAULT 0,created_at INTEGER);
    CREATE UNIQUE INDEX one_current_pair ON pairs(archived) WHERE archived=0; PRAGMA user_version=4`);
  for(const p of [c,x])db.prepare('INSERT INTO peers VALUES(?,?,?,?)').run(p.id,p.host,p.sessionId,JSON.stringify(p));
  db.exec("INSERT INTO pairs VALUES('pair-old','member-c','member-x',0,0,42)");db.close();
  let store=new Store(file);const pair=store.currentPair()!,before=store.peers(),message=store.accept(pair,store.peer(c.id),'迁移后仍可回复','original');
  const c2=store.register(window('claude','c2',20)),x2=store.register(window('codex','x2',21));store.pair(c2.id,x2.id);store.close();
  store=new Store(file);t.after(async()=>{store.close();await temp.cleanup();});
  assert.equal(store.pairFor(c.id)?.id,'pair-old');assert.deepEqual(store.peers().slice(0,2),before);
  assert.equal(store.message(message.id).body,'迁移后仍可回复');assert.equal(store.accept(pair,store.peer(c.id),'迁移后仍可回复','original').id,message.id);
  assert.equal(store.pairs().length,2);assert.throws(()=>store.currentPair(),{code:'pair_selector_required'});
});

test('失败迁移整笔回滚，解除故障后可重新迁移',t=>{
  const temp=temporaryDirectory(),file=path.join(temp.directory,'rollback.db'),{DatabaseSync}=createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');
  let db=new DatabaseSync(file);
  db.exec(`CREATE TABLE peers(id TEXT PRIMARY KEY,host TEXT,session_id TEXT,data TEXT,UNIQUE(host,session_id));
    CREATE TABLE settings(key TEXT PRIMARY KEY,value TEXT,updated_at INTEGER DEFAULT 0);
    INSERT INTO settings VALUES('keep','42',0);
    CREATE TRIGGER fail_migration BEFORE UPDATE ON settings BEGIN SELECT RAISE(ABORT,'fixture failure'); END;
    PRAGMA user_version=4`);db.close();
  assert.throws(()=>new Store(file),/fixture failure/);
  db=new DatabaseSync(file);assert.equal(db.prepare('PRAGMA user_version').get()?.user_version,4);
  assert.equal(db.prepare("SELECT name FROM sqlite_master WHERE name='window_bindings'").get(),undefined);
  assert.match(String(db.prepare("SELECT sql FROM sqlite_master WHERE name='peers'").get()?.sql),/UNIQUE/);
  db.exec('DROP TRIGGER fail_migration');db.close();
  const store=new Store(file);t.after(async()=>{store.close();await temp.cleanup();});assert.equal(store.setting('keep'),42);
});

test('两端清空、分支、切回旧会话均保留窗口成员与搭档，旧调用失效',t=>{
  const store=new Store(':memory:');t.after(()=>store.close());
  const c=store.register(window('claude','c',10)),x=store.register(window('codex','x',11)),pair=store.pair(c.id,x.id);
  const old=actor(store,c.id);
  for(const [id,reason] of [['new','reset'],['branch','fork'],['c','switch']] as const){
    assert.equal(store.register(window('claude',id,10,{contextStart:true,contextReason:reason})).id,c.id);
    assert.equal(store.pairFor(c.id)?.id,pair.id);
  }
  assert.equal(store.bindings.lineage(c.id).length,4);assert.throws(()=>store.resolve(old),{code:'stale_context'});
  assert.equal(store.contextNotices(x.id).length,3);assert.equal(new Set(store.contextNotices(x.id).map(n=>n.epoch)).size,3);
  const epoch=store.bindings.current(c.id)!.epoch;store.register(window('claude','c',10));assert.equal(store.bindings.current(c.id)!.epoch,epoch);
  assert.throws(()=>store.register(window('claude','new',10)),{code:'stale_context'});
});

test('新会话原因未知仍在原配对内，结束旧上下文不暂停配对',t=>{
  const store=new Store(':memory:');t.after(()=>store.close());
  const c=store.register(window('claude','c',10)),x=store.register(window('codex','x',11));store.pair(c.id,x.id);
  const old=actor(store,x.id);assert.equal(store.endContext(old),true);assert.equal(store.pairFor(x.id)?.paused,false);
  assert.equal(store.register(window('codex','new',11)).id,x.id);
  assert.equal(store.contextNotices(c.id)[0]?.reason,'unknown');assert.throws(()=>store.endContext(old),{code:'stale_context'});
  assert.equal(store.peer(x.id).sessionId,'new');
});

test('结束原因随旧窗口租约保存，普通 hook 先登记后继也保留原因且只消费一次',t=>{
  const store=new Store(':memory:');t.after(()=>store.close());
  const c=store.register(window('claude','c',10)),x=store.register(window('codex','x',11));store.pair(c.id,x.id);
  for(const reason of ['reset','switch'] as const){
    const old=actor(store,c.id);store.endContext(old,reason);
                                        
    store.register(window('claude',old.sessionId,10));store.endContext(actor(store,c.id));
    const next='after-'+reason;store.register(window('claude',next,10));
    assert.equal(store.bindings.lineage(c.id).at(-1)?.reason,reason);
    assert.equal(store.contextNotices(x.id).at(-1)?.reason,reason);
    assert.throws(()=>store.endContext(old,reason),{code:'stale_context'});
    store.register(window('claude','later-'+reason,10));assert.equal(store.bindings.lineage(c.id).at(-1)?.reason,'unknown');
  }
});

test('同一会话明确恢复后旧结束原因作废，不污染随后真正切换的上下文',t=>{
  const store=new Store(':memory:');t.after(()=>store.close());
  for(const host of ['claude','codex'] as const){
    const peer=store.register(window(host,'continued',10));
    for(const reason of ['reset','switch'] as const){
      const before=actor(store,peer.id);store.endContext(before,reason);
      store.register(window(host,before.sessionId,10,{contextStart:true,contextReason:'unknown'}));
      assert.equal(store.bindings.current(peer.id)?.transitionReason,undefined);
      assert.equal(store.bindings.current(peer.id)?.epoch,before.binding!.epoch);
      store.endContext(actor(store,peer.id));store.register(window(host,'after-'+reason,10));
      assert.equal(store.bindings.lineage(peer.id).at(-1)?.reason,'unknown');
    }
  }
});

for(const state of ['online','offline','archived'] as const)test('同窗口恢复另一成员的'+state+'历史不迁移配对',t=>{
  const store=new Store(':memory:');t.after(()=>store.close());
  const a=store.register(window('claude','a',10)),b=store.register(window('claude','b',20)),x=store.register(window('codex','x',11)),y=store.register(window('codex','y',21));
  const p1=store.pair(a.id,x.id),p2=store.pair(b.id,y.id);
  if(state==='offline')store.updatePeer(b.id,{state:'offline'});if(state==='archived')store.unpair(p2.id);
  assert.equal(store.register(window('claude','b',10,{contextStart:true,contextReason:'switch'})).id,a.id);
  assert.equal(store.pairFor(a.id)?.id,p1.id);assert.equal(store.pairFor(y.id)?.id,state==='archived'?undefined:p2.id);
  assert.equal(store.resolve(actor(store,a.id))?.id,a.id);assert.equal(store.resolve(actor(store,b.id))?.id,b.id);
  assert.throws(()=>store.find('claude','b'),{code:'ambiguous_context'});
});

test('新窗口不能只凭历史、离线缓存或已归档关系接管成员',t=>{
  const store=new Store(':memory:');t.after(()=>store.close());
  const c=store.register(window('claude','c',10)),x=store.register(window('codex','x',11)),pair=store.pair(c.id,x.id);
  store.updatePeer(c.id,{state:'offline'});
  const fresh=store.register(window('claude','c',20));assert.notEqual(fresh.id,c.id);assert.equal(store.pairFor(fresh.id),undefined);
  assert.equal(store.bindings.reopen(registrationWindow(window('claude','c',30))!,'c')?.peerId,c.id);
  store.unpair(pair.id);
  assert.equal(store.bindings.reopen(registrationWindow(window('claude','c',30))!,'c'),undefined);
  const archived=store.register(window('claude','c',30));assert.notEqual(archived.id,c.id);assert.equal(store.pairFor(archived.id),undefined);
});

test('前台恢复托管历史不夺取托管成员，托管原生调用按成员区分同一历史',async t=>{
  const {store,broker,c,x}=fixture(t),pair=store.pair(c.id,x.id);store.updatePeer(x.id,{owner:'nxbridge'});
  const foreground=await broker.dispatch('mcp.register',window('codex','x',501,{endpoint:{...window('codex','x',501).endpoint,processKind:'foreground'}})) as any;
  assert.notEqual(foreground.id,x.id);assert.equal(store.pairFor(foreground.id),undefined);assert.equal(store.pairFor(x.id)?.id,pair.id);
  assert.equal(store.resolve({host:'codex',memberId:x.id,sessionId:'x',callId:'managed'})?.id,x.id);
  assert.equal(store.resolve({...actor(store,foreground.id),memberId:foreground.id})?.id,foreground.id);
  assert.throws(()=>store.resolve({host:'codex',sessionId:'x',callId:'legacy'}),{code:'ambiguous_context'});
  assert.throws(()=>store.resolve({...actor(store,foreground.id),memberId:x.id}),{code:'stale_context'});
});

test('切回同名会话后旧边界和子代理租约失效，新代次可正常发信',t=>{
  const {store,broker,c}=fixture(t),root=store.register(window('codex','root',511));store.pair(c.id,root.id);
  const lease=actor(store,root.id),oldTime=Date.now()-1000;
  const child=store.register({...window('codex','child',511),kind:'subagent',parentId:'root',expectedBinding:lease.binding});
  assert.equal(store.resolve({host:'codex',sessionId:'child',via:'child',callId:'before',binding:lease.binding})?.id,child.id);
  store.register(window('codex','other',511));store.register(window('codex','root',511,{contextStart:true}));
  assert.throws(()=>store.register(window('codex','root',511,{boundaryStartedAt:oldTime})),{code:'stale_context'});
  assert.throws(()=>broker.send({actor:{host:'codex',sessionId:'child',via:'child',callId:'late',binding:lease.binding},message:'旧子代理'}),{code:'stale_context'});
  const sent=broker.send({actor:actor(store,root.id,'fresh'),message:'新代次'});assert.equal(store.message(sent.message_id).from,root.id);
});

test('托管启动接续临时成员时保留原生租约、沿袭、子代理归属和端点能力',t=>{
  const {store,c}=fixture(t),owned=store.placeholder('claude',c.cwd),x=store.register(window('codex','adoption-partner',519)),pair=store.pair(owned.id,x.id);
  const input=window('claude','adoption-native',518),provisional=store.register({...input,endpoint:{...input.endpoint,questionSupport:true}}),lease=actor(store,provisional.id);
  const child=store.register({...input,sessionId:'adoption-native#child',kind:'subagent',parentId:input.sessionId,expectedBinding:lease.binding});
  assert.equal(store.adopt(owned.id,input).id,owned.id);
  assert.equal(store.resolve(lease)?.id,owned.id);assert.equal(store.bindings.current(owned.id)?.epoch,lease.binding!.epoch);
  assert.equal(store.find('claude',input.sessionId)?.id,owned.id);assert.equal(store.pairFor(owned.id)?.id,pair.id);
  assert.equal(store.bindings.lineage(owned.id).length,1);assert.equal(store.endpoint(owned.id)?.questionSupport,true);
  assert.equal(store.peer(child.id).rootPeerId,owned.id);assert.equal(store.resolve({host:'claude',sessionId:child.sessionId!,callId:'after-adoption',via:'child',binding:lease.binding})?.id,child.id);
});

test('App Server 首次原生调用补齐唯一旧路由，歧义或代次冲突不能另建配对',async t=>{
  const {store,broker,c}=fixture(t);
  const x=store.register(registration('codex','native-route',{endpoint:{mode:'app-server',address:'unix://route-a',epoch:'route-a',pid:null,procStart:null}})),pair=store.pair(c.id,x.id);
  const input=registration('codex','native-route',{endpoint:{mode:'embedded',address:'',epoch:'mcp',pid:101,procStart:'native-generation',processKind:'app-server'}});
  assert.equal((await broker.dispatch('mcp.register',input) as any).id,x.id);assert.equal(store.pairFor(x.id)?.id,pair.id);
  assert.equal(store.endpoint(x.id)?.native?.pid,101);assert.equal(store.peers().filter(p=>p.sessionId==='native-route').length,1);
  const legacy={...input,endpoint:{...input.endpoint,processKind:undefined,configHome:'/legacy-mcp-home'}};
  assert.equal((await broker.dispatch('mcp.register',legacy) as any).id,x.id,'旧 MCP 类型缺失不能把已核验 App Server 建成另一前台窗口');
  assert.equal(store.bindings.current(x.id),undefined);assert.equal(store.peers().filter(p=>p.sessionId==='native-route').length,1);
  await assert.rejects(broker.dispatch('mcp.register',{...input,endpoint:{...input.endpoint,pid:102}}),{code:'ambiguous_context'});
  store.register(registration('codex','native-route',{endpoint:{mode:'app-server',address:'unix://route-b',epoch:'route-b',pid:null,procStart:null}}));
  await assert.rejects(broker.dispatch('mcp.register',{...input,endpoint:{...input.endpoint,pid:103}}),{code:'ambiguous_context'});
  assert.equal(store.pairs().length,1);assert.equal(store.peer(x.id).sessionId,'native-route');
});

test('发送竞态保留不确定证据，未提交入站留给新上下文且旧取件缓存不复用',t=>{
  const {store,broker,c}=fixture(t);const x=store.register(window('codex','foreground',11)),pair=store.pair(c.id,x.id);
  const accepted=store.accept(pair,c,'下一上下文取件','accepted'),sending=store.accept(pair,c,'传输中','sending'),seen=store.accept(pair,c,'已见未答','seen');
  store.claim(sending.id);store.transition(seen.id,'contextObserved');
  const old=actor(store,x.id,'pickup');store.register(window('codex','new',11));
  assert.equal(store.message(sending.id).state,'unknown');assert.equal(store.message(seen.id).state,'contextObserved');
  assert.throws(()=>broker.receive(old),{code:'stale_context'});
  const result=broker.receive(actor(store,x.id,'pickup')) as any;
  assert.deepEqual(result.messages.map((m:any)=>m.message_id),[accepted.id]);assert.equal(store.message(sending.id).attempts,1);
  const notice=store.contextNotices(c.id)[0]!;assert.deepEqual(notice.unanswered,[seen.id]);assert.deepEqual(notice.uncertain,[sending.id]);
});

test('两组配对可分别挂起问题，回答方切换保留请求和截止时间，提问方切换取消',t=>{
  const store=new Store(':memory:');t.after(()=>store.close());const questions=new Questions(store,DEFAULT_CONFIG);store.onRotation=r=>questions.rotate(r);
  const c=store.register(window('claude','c',10)),x=store.register(window('codex','x',11)),c2=store.register(window('claude','c2',20)),x2=store.register(window('codex','x2',21));
  const p1=store.pair(c.id,x.id),p2=store.pair(c2.id,x2.id),input={questions:[{id:'q',header:'选项',question:'选择哪项？',options:[{label:'甲',description:'甲'},{label:'乙',description:'乙'}]}]};
  const q1=questions.create(p1,x,actor(store,x.id),input) as any,q2=questions.create(p2,x2,actor(store,x2.id),input) as any;
  const old=actor(store,c.id);questions.answer(c,old,{request_id:q1.request_id,action:'ask_user'});
  store.register(window('claude','new',10,{contextStart:true,contextReason:'reset'}));
  const reoffered=store.question(q1.request_id);assert.equal(reoffered.status,'pending');assert.equal(reoffered.expiresAt,Date.parse(q1.expires_at));assert.equal(store.question(q2.request_id).status,'pending');
  assert.throws(()=>questions.answer(store.peer(c.id),old,{request_id:q1.request_id,answers:{'选择哪项？':'甲'},rationale:'理由'}),{code:'stale_context'});
  questions.answer(store.peer(c.id),actor(store,c.id),{request_id:q1.request_id,answers:{'选择哪项？':'甲'},rationale:'理由'});
  assert.equal(store.question(q1.request_id).status,'answered');
  store.register(window('codex','new-x2',21));assert.equal(store.question(q2.request_id).status,'cancelled');
  assert.equal(store.question(q2.request_id).terminalReason,'origin_context_changed');assert.equal(store.question(q1.request_id).status,'answered');
});

test('配对暂停和全局重启分别作用于正确问题，所有组的安全队列保留',t=>{
  const {store,broker,c,x}=fixture(t),c2=store.register(registration('claude','c2',{cwd:path.resolve('/other')})),x2=store.register(registration('codex','x2',{cwd:path.resolve('/other')}));
  const p1=store.pair(c.id,x.id),p2=store.pair(c2.id,x2.id);
  const a=store.accept(p1,c,'第一组','a'),b=store.accept(p2,c2,'第二组','b');store.setPaused(true,p1.id);
  assert.deepEqual(store.pending().map(m=>m.id),[b.id]);assert.equal((broker.status({host:'claude',sessionId:'c2',callId:'s'}) as any).partner.id,x2.id);
  assert.equal((broker.status() as any).pairs.length,2);assert.equal(store.message(a.id).state,'accepted');
  store.claim(b.id);store.recover();assert.equal(store.message(b.id).state,'unknown');assert.equal(store.message(a.id).state,'accepted');assert.equal(store.pairs().length,2);
});
