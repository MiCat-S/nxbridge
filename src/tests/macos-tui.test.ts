import test from 'node:test';
import assert from 'node:assert/strict';
import {parseLsofFields,readMacProcessOutput,macosEvidenceIdentity} from '../hosts/macos-tui.js';

test('Mac 采集身份忽略运行状态和 TTY，只比较 PID、启动时间和程序路径',()=>{
  const line='6658 501 Thu Nov 12 02:11:01 2026 Ss ?? /Applications/ChatGPT App/codex';
  assert.deepEqual(macosEvidenceIdentity(line),macosEvidenceIdentity(line.replace('Ss ??','Rs ttys001')));
  assert.notDeepEqual(macosEvidenceIdentity(line),macosEvidenceIdentity(line.replace('02:11:01','02:11:02')));
  assert.notDeepEqual(macosEvidenceIdentity(line),macosEvidenceIdentity(line.replace('6658','6659')));
  assert.notDeepEqual(macosEvidenceIdentity(line),macosEvidenceIdentity(line.replace('/codex','/other')));assert.equal(macosEvidenceIdentity('不可解析'),undefined);
});

test('Mac 部分 PID 消失时保留成功输出，超时输出不能用作证明',async()=>{
  const partial={code:1,stdout:'有效的其他进程\n'},timeout={code:1,stdout:'超时前的旧快照',killed:true,signal:'SIGTERM'};
  assert.equal(await readMacProcessOutput('/bin/ps',[],async(_binary,_args,options)=>{assert.equal(options.env?.LC_TIME,'C');assert.equal(options.env?.TZ,'UTC');throw partial;}),partial.stdout);
  await assert.rejects(readMacProcessOutput('/bin/ps',[],async()=>{throw timeout;}),error=>error===timeout);
});

test('Mac socket 字段解析保留各进程的描述符、类型和完整路径',()=>{
  const fields='p5731\nf9u\ntunix\nn/private/tmp/with space.sock type=STREAM\nf10u\ntunix\nn/private/tmp/other.sock->0x111\np6861\nf0\ntCHR\nn/dev/ttys002\n';
  const expected=[
    {pid:5731,fd:'9u',type:'unix',name:'/private/tmp/with space.sock type=STREAM'},
    {pid:5731,fd:'10u',type:'unix',name:'/private/tmp/other.sock->0x111'},
    {pid:6861,fd:'0',type:'CHR',name:'/dev/ttys002'}
  ];
  assert.deepEqual(parseLsofFields(fields),expected);
  assert.deepEqual(parseLsofFields(fields.replaceAll('\n','\0')),expected);
});
