import test from 'node:test';
import assert from 'node:assert/strict';
import { ClaudeStreamHealth } from '../hosts/claude/claude-stream.js';
import { SILENCE_MS } from '../broker/health/turn-health.js';
import { claudeBackgroundMode } from '../hosts/claude/claude-capability.js';
import { claudeHistoryExists } from '../hosts/claude/claude-child.js';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { temporary } from './support/temporary.js';

test('托管 Claude 的审批、原生进展、重试及失败分开记录，不保留正文',()=>{
  let now=1000;const health=new ClaudeStreamHealth(()=>now);
  health.observe({type:'system',subtype:'status',status:'requesting',uuid:'turn'});now+=SILENCE_MS;
  health.observe({type:'user',message:{content:[{type:'text',text:'后来信'}]}});assert.equal(health.get()?.state,'silent');
  health.observe({type:'system',subtype:'api_retry',attempt:2,max_retries:10});assert.equal(health.get()?.state,'networkRetrying');assert.equal(health.get()?.lastProgressAt,1000);
  health.observe({type:'stream_event',event:{type:'content_block_delta',delta:{text:'不保存正文'}}});assert.equal(health.get()?.state,'running');assert.equal(health.get()?.retry,undefined);
  health.observe({type:'assistant',message:{content:[{type:'tool_use',id:'tool',name:'Bash',input:{secret:'不保存'}}]}});now+=SILENCE_MS;assert.equal(health.get()?.state,'waitingTool');
  health.observe({type:'control_request',request:{subtype:'can_use_tool',tool_name:'AskUserQuestion',input:{secret:'不保存'}}});assert.equal(health.get()?.state,'needsHuman');assert.deepEqual(health.human,{kind:'question',tool:'AskUserQuestion'});
  health.observe({type:'result',subtype:'error_during_execution',is_error:true,result:'不保存'});assert.equal(health.get()?.state,'failed');assert.equal(health.human,undefined);assert.ok(!JSON.stringify(health).includes('不保存'));
});

test('原生 PID 登记不等于已有会话历史，空会话和已落盘会话分别识别',t=>{
  const home=temporary(t),id=randomUUID();assert.equal(claudeHistoryExists(home,id),false);
  const project=path.join(home,'projects','project');mkdirSync(project,{recursive:true});writeFileSync(path.join(project,id+'.jsonl'),'{}\n','utf8');
  assert.equal(claudeHistoryExists(home,id),true);assert.equal(claudeHistoryExists(home,randomUUID()),false);
});

test('后台能力的路由按平台选择，Windows 保留原生后台且不启用子进程替代',()=>{
  assert.equal(claudeBackgroundMode(undefined,'win32'),'native');assert.equal(claudeBackgroundMode({available:true},'linux'),'native');
  assert.equal(claudeBackgroundMode({available:false},'linux'),'child');assert.equal(claudeBackgroundMode({available:false},'win32'),'unsupported');
});
