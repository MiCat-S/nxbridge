import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { claudeBackground, probeClaudeBackground, requireClaudeBackground, saveClaudeBackground } from '../hosts/claude/claude-capability.js';
import { ClaudeAdapter } from '../hosts/claude/adapter.js';
import { Broker, type Adapters } from '../broker/coordinator.js';
import { Store } from '../storage/store.js';
import {DEFAULT_CONFIG} from '../config/defaults.js';
import { FakeAdapter } from './support/fake-adapter.js';
import { registration } from './support/registration.js';
import { temporary } from './support/temporary.js';
import {ensureHome} from '../ipc/home.js';
import {atomicJson} from '../shared/files.js';
import { claudeChildFile } from '../hosts/claude/claude-child.js';

test('后台控制能力按启动命令和配置目录绑定，诊断不保存命令秘密，入口拒绝绕过包装器',async t=>{
  const home=temporary(t),config={...DEFAULT_CONFIG,claudeCommand:[process.execPath,'--auth-token','测试秘密'],claudeHome:home};
  const unavailable=await probeClaudeBackground(async()=>{throw Error('包装器不支持后台');});saveClaudeBackground(home,config,unavailable);
  assert.equal(claudeBackground(home,config)?.available,false);assert.ok(unavailable.notice);
  assert.ok(!readFileSync(path.join(home,'claude-background.json'),'utf8').includes('测试秘密'));
  assert.equal(claudeBackground(home,{...config,claudeCommand:[process.execPath,'另一个命令']}),undefined);
  assert.equal(claudeBackground(home,{...config,claudeHome:home+'/other'}),undefined);
  const previous=process.env.NXBRIDGE_HOME;process.env.NXBRIDGE_HOME=home;t.after(()=>{if(previous===undefined)delete process.env.NXBRIDGE_HOME;else process.env.NXBRIDGE_HOME=previous;});
  const adapter=new ClaudeAdapter(config);t.after(()=>adapter.close());
  if(process.platform!=='linux'){
    await assert.rejects(adapter.create({id:'placeholder'} as any),{code:'claude_background_unavailable'});
    await assert.rejects(adapter.wake({sessionId:'old'} as any),{code:'claude_background_unavailable'});
  }else assert.doesNotThrow(()=>requireClaudeBackground(home,config));
  saveClaudeBackground(home,config,await probeClaudeBackground(async()=>'[]'));assert.equal(claudeBackground(home,config)?.available,true);
});

test('托管启动中、存活或确认失败的占位成员都不能被独立前台窗口抢占',async t=>{
  const home=temporary(t);await ensureHome(home);const config={...DEFAULT_CONFIG,claudeCommand:[process.execPath,'wrapper'],claudeHome:home},store=new Store(':memory:'),codex=new FakeAdapter(),claude=new FakeAdapter();
  saveClaudeBackground(home,config,{available:false,checkedAt:Date.now()});claude.create=async()=>{throw Error('启动失败待处理');};
  const broker=new Broker(store,config,{codex,claude} as unknown as Adapters,home);t.after(async()=>{await broker.stop();store.close();});store.register(registration('codex','sender',{cwd:home}));
  broker.send({actor:{host:'codex',sessionId:'sender',callId:'queued'},message:'不能被新窗口抢走'});await broker.pump();const pair=store.currentPair()!,waiting=store.peer(pair.claude),file=claudeChildFile(home,waiting.id);
  atomicJson(file,{version:1,peerId:waiting.id,sessionId:'owned-reserved',phase:'starting',worker:{pid:process.pid}});await broker.dispatch('register',registration('claude','foreground',{cwd:home}));assert.equal(store.peer(waiting.id).sessionId,null);
  atomicJson(file,{version:1,peerId:waiting.id,sessionId:'owned-reserved',phase:'failed',worker:{pid:process.pid}});await broker.dispatch('register',registration('claude','foreground',{cwd:home}));assert.equal(store.peer(waiting.id).sessionId,null);
  atomicJson(file,{version:1,peerId:waiting.id,sessionId:'owned-reserved',phase:'failed'});const foreground=await broker.dispatch('register',registration('claude','foreground',{cwd:home})) as any;assert.notEqual(foreground.id,waiting.id);assert.equal(store.peer(waiting.id).owner,'nxbridge');assert.equal(store.peer(waiting.id).sessionId,null);assert.equal(store.pairFor(foreground.id),undefined);
});

test('后台不可用时保留未尝试消息和占位预约，新前台窗口不能抢占原成员',async t=>{
  const home=temporary(t),config={...DEFAULT_CONFIG,claudeCommand:[process.execPath,'wrapper'],claudeHome:home},store=new Store(':memory:'),codex=new FakeAdapter(),claude=new FakeAdapter();
  saveClaudeBackground(home,config,{available:false,checkedAt:Date.now()});let launches=0;
  claude.create=async()=>{requireClaudeBackground(home,config);launches++;throw Error('不应启动');};
  const broker=new Broker(store,config,{codex,claude} as unknown as Adapters,home);t.after(async()=>{await broker.stop();store.close();});
  store.register(registration('codex','sender',{cwd:home}));
  const sent=broker.send({actor:{host:'codex',sessionId:'sender',callId:'queued'},message:'窗口打开后继续投递'}) as any;await broker.pump();
  const pair=store.currentPair()!,waiting=store.peer(pair.claude);assert.equal(waiting.state,'offline');assert.ok(waiting.launchFailure);assert.equal(waiting.sessionId,null);assert.equal(launches,process.platform==='linux'?1:0);
  assert.equal(store.message(sent.message_id).state,'accepted');assert.equal(store.message(sent.message_id).attempts,0);
  await broker.dispatch('register',registration('claude','wrong-directory',{cwd:home+'/other'}));
  await broker.dispatch('register',registration('claude','child',{cwd:home,kind:'subagent',parentId:'parent'}));assert.equal(store.peer(waiting.id).sessionId,null);
  const bound=await broker.dispatch('register',registration('claude','foreground',{cwd:home})) as any;await broker.pump();
  assert.notEqual(bound.id,waiting.id);assert.equal(store.currentPair()?.id,pair.id);assert.equal(store.peer(waiting.id).owner,'nxbridge');assert.equal(store.peer(waiting.id).sessionId,null);assert.equal(store.pairFor(bound.id),undefined);
  assert.equal(claude.delivered.length,0);assert.equal(store.message(sent.message_id).attempts,0);
  await broker.dispatch('register',registration('claude','another-window',{cwd:home}));await broker.pump();assert.equal(store.peer(pair.claude).sessionId,null);assert.equal(claude.delivered.length,0);
});
