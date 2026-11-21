import test from 'node:test';
import assert from 'node:assert/strict';
import {ensureHome} from '../ipc/home.js';
import {atomicJson} from '../shared/files.js';
import {ipcAddress} from '../shared/local-paths.js';
import { listenBroker } from '../ipc/ipc.js';
import { claudeChild, claudeChildFile, type ClaudeChildRecord } from '../hosts/claude/claude-child.js';
import { Broker, type Adapters } from '../broker/coordinator.js';
import { Store } from '../storage/store.js';
import {DEFAULT_CONFIG} from '../config/defaults.js';
import { FakeAdapter } from './support/fake-adapter.js';
import { registration } from './support/registration.js';
import { temporary } from './support/temporary.js';
import { Takeovers } from '../broker/recovery/takeover.js';
import { processIdentity, type ProcessIdentity } from '../process/process.js';
import { WindowRecovery } from '../broker/recovery/window-recovery.js';

test('接管原生后代登记复用原租约，外国代次和配置目录不能借同会话接管',async t=>{
  const store=new Store(':memory:');t.after(()=>store.close());
  const home=temporary(t),prior=registration('claude','leased',{endpoint:{mode:'claude-inbox',address:'old-inbox',epoch:'old',pid:10,procStart:'old',configHome:home}}),c=store.register(prior),x=store.register(registration('codex','sender'));
  const pair=store.pair(c.id,x.id);store.updatePeer(c.id,{owner:'nxbridge'});const message=store.accept(pair,x,'接管期间的原消息','saved');
  let generation='wrapper',chain:ProcessIdentity[]=[];
  const takeovers=new Takeovers(store,undefined,undefined,undefined,undefined,async()=>chain),lease=takeovers.begin(store.peer(c.id),store.endpoint(c.id),'handoff');
  takeovers.claim(c.id,lease.id,{pid:20,procStart:generation});
  const input={...prior,endpoint:{...prior.endpoint,pid:30,procStart:'native',epoch:'new',address:'new-inbox'}};
  chain=[{pid:30,startedAt:'native',name:'claude'},{pid:20,startedAt:'foreign',name:'wrapper'}] as ProcessIdentity[];
  assert.equal(await takeovers.registration(input),undefined);assert.equal(store.endpoint(c.id)?.epoch,'old');
  assert.equal(await takeovers.registration({...input,endpoint:{...input.endpoint,configHome:home+'-other'}}),undefined);
  chain[1]!.startedAt=generation;const restored=await takeovers.registration(input);
  assert.equal(restored?.id,c.id);assert.equal(restored?.owner,'nxbridge');assert.equal(takeovers.get(c.id)?.id,lease.id);assert.equal(takeovers.get(c.id)?.foreground?.pid,20);assert.equal(store.pairFor(c.id)?.id,pair.id);assert.equal(store.message(message.id).attempts,0);assert.equal(store.message(message.id).state,'accepted');
});

test('远程附着不接纳前台窗口，后台重登记与子进程同窗口心跳不查询祖先',async t=>{
  const store=new Store(':memory:');t.after(()=>store.close());const home=temporary(t);
  const input=registration('claude','remote',{endpoint:{mode:'claude-inbox',address:'background',epoch:'background',pid:10,procStart:'background',configHome:home}}),c=store.register(input),x=store.register(registration('codex','sender'));
  store.pair(c.id,x.id);store.updatePeer(c.id,{owner:'nxbridge'});
  let lookups=0;const takeovers=new Takeovers(store,undefined,undefined,undefined,undefined,async()=>{lookups++;return[];}),windows=new WindowRecovery(store,async values=>values.map(()=>'alive'));
  const remote=takeovers.begin(store.peer(c.id),store.endpoint(c.id),undefined,{pid:20,procStart:'attach'});
  assert.equal(await takeovers.registration(input),undefined);assert.equal((await windows.register(input)).id,c.id);
  const attach={...input,endpoint:{...input.endpoint,pid:30,procStart:'attach-native',epoch:'attach',address:'attach'}};
  assert.equal(await takeovers.registration(attach),undefined);
  const foreign=await windows.register(attach);assert.notEqual(foreign.id,c.id);assert.equal((windows.status(foreign.id) as any)?.state,'needs_choice');
  assert.equal(store.bindings.current(c.id)?.pid,10);assert.equal(store.endpoint(c.id)?.epoch,'background');assert.equal(takeovers.get(c.id)?.id,remote.id);
  store.setSetting('takeover:'+c.id,null);const child=takeovers.begin(store.peer(c.id),store.endpoint(c.id),'handoff',{pid:20,procStart:'wrapper'});
  assert.equal(await takeovers.registration(input),undefined);assert.equal(lookups,0);assert.equal(takeovers.get(c.id)?.id,child.id);
  const stoppedBackground=new WindowRecovery(store,async values=>values.map((_,index)=>index===0?'alive':'dead'));
  const resumed={...attach,endpoint:{...attach.endpoint,pid:40,procStart:'foreign-resume',epoch:'foreign-resume',address:'foreign-resume'}};
  assert.equal(await takeovers.registration(resumed),undefined);
  const choice=await stoppedBackground.register(resumed);assert.notEqual(choice.id,c.id);assert.equal((stoppedBackground.status(choice.id) as any)?.state,'needs_choice');assert.equal(takeovers.get(c.id)?.id,child.id);assert.equal(lookups,1);
});

test('接管核验等待期间归还后回到普通登记，换租约或换持有者不能借用旧证明',async t=>{
  const store=new Store(':memory:');t.after(()=>store.close());const home=temporary(t),input=registration('claude','race',{endpoint:{mode:'claude-inbox',address:'background',epoch:'background',pid:10,procStart:'background',configHome:home}}),c=store.register(input),x=store.register(registration('codex','sender'));
  store.pair(c.id,x.id);store.updatePeer(c.id,{owner:'nxbridge'});
  let during=()=>{};const takeovers=new Takeovers(store,undefined,undefined,undefined,undefined,async()=>{during();return[{pid:30,startedAt:'native'},{pid:20,startedAt:'wrapper'}] as ProcessIdentity[];});
  const native={...input,endpoint:{...input.endpoint,pid:30,procStart:'native',epoch:'foreground',address:'foreground'}};
  let lease=takeovers.begin(store.peer(c.id),store.endpoint(c.id),'handoff',{pid:20,procStart:'wrapper'});
  during=()=>store.setSetting('takeover:'+c.id,null);assert.equal(await takeovers.registration(native),undefined);
  lease=takeovers.begin(store.peer(c.id),store.endpoint(c.id),'handoff',{pid:20,procStart:'wrapper'});
  during=()=>store.setSetting('takeover:'+c.id,{...lease,id:'replacement'});await assert.rejects(takeovers.registration(native),{code:'session_changed'});
  store.setSetting('takeover:'+c.id,lease);during=()=>takeovers.claim(c.id,lease.id,{pid:40,procStart:'other'});await assert.rejects(takeovers.registration(native),{code:'foreground_active'});
  assert.equal(store.bindings.current(c.id)?.pid,10);assert.equal(store.peer(c.id).owner,'nxbridge');
});

test('托管接管拒绝忙碌轮并保留消息，陈旧 SessionEnd 不归还活窗口，核验退出后归还原成员',async t=>{
  const home=temporary(t);await ensureHome(home);const store=new Store(':memory:'),codex=new FakeAdapter(),claude=new FakeAdapter();
  claude.discover=async id=>({...registration('claude',id),state:undefined});
  const broker=new Broker(store,DEFAULT_CONFIG,{codex,claude} as unknown as Adapters,home);
  let foregroundAlive=true;const takeovers=(broker as any).takeovers;
  t.mock.method(takeovers,'probe',async(values:unknown[])=>values.map(()=>foregroundAlive?'alive':'dead'));
  t.mock.method(takeovers,'alive',()=>false);
  const c=store.register(registration('claude','child')),x=store.register(registration('codex','sender'));store.pair(c.id,x.id);store.updatePeer(c.id,{owner:'nxbridge',state:'busy'});
  const record:ClaudeChildRecord={version:1,peerId:c.id,sessionId:'child',cwd:c.cwd,address:ipcAddress(home),phase:'active',hasSession:true,updatedAt:Date.now(),health:{turnId:'old',lastProgressAt:1,lastEventAt:1,state:'ready',tools:[]}};
  atomicJson(claudeChildFile(home,c.id),record);const server=await listenBroker(home,async()=>record);t.after(async()=>{await broker.stop();await server.close();store.close();});
  await assert.rejects(broker.dispatch('open',{host:'claude'}),{code:'claude_turn_busy'});
  const handoff=await broker.dispatch('open',{host:'claude',interrupt:true}) as any;assert.equal(handoff.mode,'child');assert.equal(claudeChild(home,c.id)?.phase,'handoff');
  const actor={host:'codex' as const,sessionId:'sender',callId:'held'},sent=broker.send({actor,message:'接管期间保留'}) as any;await broker.pump();
  assert.equal(store.message(sent.message_id).state,'accepted');assert.equal(store.message(sent.message_id).attempts,0);assert.equal(claude.woken.length,0);
  await assert.rejects(broker.dispatch('open',{host:'claude'}),{code:'foreground_active'});
  const identity=await processIdentity(process.pid);
  await broker.dispatch('open.claim',{peer_id:c.id,session_id:'child',handoff_id:handoff.handoffId,lease_id:handoff.leaseId,foreground:{pid:process.pid,procStart:identity.startedAt}});assert.equal(store.peer(c.id).owner,'nxbridge');
  await broker.dispatch('peer.state',{actor:{host:'claude',sessionId:'child',callId:'end'},state:'offline'});assert.equal(claudeChild(home,c.id)?.phase,'user');
  foregroundAlive=false;assert.deepEqual(await broker.dispatch('open.return',{peer_id:c.id,session_id:'child',handoff_id:handoff.handoffId,lease_id:handoff.leaseId}),{returned:true});assert.equal(store.currentPair()?.paused,false);assert.equal(claudeChild(home,c.id)?.phase,'stopped');
  assert.equal(store.currentPair()?.claude,c.id);assert.equal(store.peer(c.id).sessionId,'child');
});
