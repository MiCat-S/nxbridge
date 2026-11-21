import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { closeSync, openSync, readFileSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { capLog } from '../storage/logs.js';
import { temporary } from './support/temporary.js';

test('运行中日志超限保留最近内容，原追加句柄随后仍可写入',t=>{
  const file=path.join(temporary(t),'active.log');writeFileSync(file,'a'.repeat(100)+'最近日志','utf8');
  const fd=openSync(file,'a');try{assert.equal(capLog(file,64),true);assert.ok(statSync(file).size<=64);writeSync(fd,'随后追加');}finally{closeSync(fd);}
  assert.ok(readFileSync(file,'utf8').endsWith('最近日志随后追加'));assert.equal(capLog(file,64),false);
});
