import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { parseFileReferences, fileHintFields, type DeliveryMessage } from '../broker/delivery/file-references.js';
import {encodePeerMessage} from '../hosts/claude/claude-inbox.js';
import { CodexAdapter } from '../hosts/codex/adapter.js';
import {DEFAULT_CONFIG} from '../config/defaults.js';
import { fixture } from './support/broker-fixture.js';
import { temporary } from './support/temporary.js';
import {PACKAGE_ROOT} from '../shared/package-location.js';

test('引用保留行范围，兼容 Markdown、裸路径、目录与 Windows，按路径和范围去重',t=>{
  const cwd=temporary(t);
  for(const dir of ['src','plugins/claude','logs/2026','Program Files/应用'])mkdirSync(path.join(cwd,dir),{recursive:true});
  for(const file of ['src/main.ts','README.md','Program Files/应用/配置.json'])writeFileSync(path.join(cwd,file),'测试','utf8');
  const absolute=path.join(cwd,'src/main.ts'),spaced=path.join(cwd,'Program Files/应用/配置.json');
  const refs=parseFileReferences(`检查 [实现](./src/main.ts:12-20) 和 src/main.ts#L12-L20；另看 src/main.ts:21。
[说明](README.md#L2) README.md:2，plugins/claude/ plugins/claude。
[配置](<${spaced}:3>) ${absolute}:12-20 logs/2026/`,cwd);
  assert.equal(refs.length,6);
  assert.deepEqual(refs[0],{path:'./src/main.ts',start:12,end:20});
  assert.ok(refs.some(r=>r.path==='src/main.ts'&&r.start===21));
  assert.ok(refs.some(r=>r.path==='logs/2026/'));
  assert.ok(refs.some(r=>r.path===spaced&&r.start===3));
  if(process.platform==='win32')assert.equal(parseFileReferences(`${absolute}:7 ${absolute.toUpperCase().replaceAll('\\','/')}#L7`,cwd).length,1);
});

test('忽略 fenced code、URL、版本号、邮件及无效范围，单处或重复引用不提醒',()=>{
  const text='普通消息，版本 1.2:3 v1.2.3，邮箱 person@example.com\n'+
    '[网页](https://example.com/src/a.ts:3) https://example.com/src/b.ts#L4 www.example.com/c.ts\n'+
    '```ts\nsrc/inside.ts:1\n~~~\nsrc/still-inside.ts:2\n```\n'+
    '~~~\nsrc/hidden.ts\n~~~\n'+
    'src/a.ts:0 src/a.ts:5-2 src/a.ts#L0\n';
  assert.deepEqual(parseFileReferences(text),[]);
  assert.deepEqual(fileHintFields('单个 `src/a.ts:1`'),{});
  assert.deepEqual(fileHintFields('src/a.ts:1 [重复](./src/a.ts#L1)'),{});
  assert.deepEqual(fileHintFields(text),{});
  assert.match(fileHintFields('src/cli.ts:1 src/cli.ts:2',PACKAGE_ROOT).hint!,/nxbridge: 2 file refs/);
  for(const phrase of ['message/model/reasoning_effort','prompt/message/tool_use_id','inject_items/steer','build/test/typecheck/doctor','question/blocker/decision/anomaly'])assert.deepEqual(parseFileReferences(phrase,PACKAGE_ROOT),[]);
  assert.equal(parseFileReferences('src/cli.ts:38 docs/behavior.md plugins/claude/',PACKAGE_ROOT).length,3);
});

test('中文无 BOM UTF-8 消息与目录引用保持正文，hint 不包含重复清单',()=>{
  const source=readFileSync(new URL('../../src/tests/fixtures/file-references-utf8.txt',import.meta.url));
  assert.notDeepEqual([...source.subarray(0,3)],[0xef,0xbb,0xbf]);
  const body=source.toString('utf8');
  assert.equal(parseFileReferences(body,PACKAGE_ROOT).length,3);
  const hint=fileHintFields(body,PACKAGE_ROOT).hint!;
  assert.match(hint,/nxbridge: 3 file refs/);assert.doesNotMatch(hint,/源码|plugins|\p{Script=Han}/u);
});

test('broker 双向只添加临时 hint，Claude 封套与 Codex 工具输出均保留原正文',async t=>{
  const {store,broker,c,x,claude}=fixture(t),body='检查 src/integration/mcp/questions.ts:12 和 plugins/claude/。';
  store.updatePeer(c.id,{cwd:PACKAGE_ROOT});store.updatePeer(x.id,{cwd:PACKAGE_ROOT});
  store.pair(c.id,x.id);store.updatePeer(c.id,{state:'busy'});store.updatePeer(x.id,{state:'busy'});
  const toCodex=broker.send({actor:{host:'claude',sessionId:'c',callId:'refs-c'},message:body}) as any;
  const toClaude=broker.send({actor:{host:'codex',sessionId:'x',callId:'refs-x'},message:body}) as any;
  await broker.pump();
  const received=(broker.receive({host:'codex',sessionId:'x',callId:'refs-pickup'}) as any).messages[0],codexMessage={...store.message(toCodex.message_id),hint:received.hint};
  assert.equal(received.message,body);
  for(const message of [codexMessage,claude.delivered[0]!] as DeliveryMessage[]){
    assert.equal(message.body,body);assert.match(message.hint!,/nxbridge: 2 file refs/);
    assert.equal(store.message(message.id).body,body);assert.equal((store.message(message.id) as any).hint,undefined);
  }
  assert.equal(received.message_id,toCodex.message_id);assert.equal(claude.delivered[0]!.id,toClaude.message_id);
  const encoded=encodePeerMessage(claude.delivered[0] as DeliveryMessage,x,'c') as any;
  assert.ok(encoded.message.content.includes(body+'\n\n'+fileHintFields(body).hint));
  const adapter=new CodexAdapter(DEFAULT_CONFIG);t.after(()=>adapter.close());let output:any;
  adapter.connect=async()=>({request:async(_method:string,args:any)=>{output=args.toolOutput;return{thread:{id:x.sessionId,cwd:x.cwd,status:{type:'idle'}},turn:{id:'test'}};}}) as any;
  await adapter.wake(x,store.endpoint(x.id)!);
  assert.equal(output,undefined,'唤醒不携带正文或伪造工具输出');
});

test('embedded 取件和重复回执都带 hint，持久记录及缓存正文不变',t=>{
  const {store,broker,c,x}=fixture(t,{compatibilityWake:'strict'}),body='src/integration/mcp/questions.ts plugins/claude/';
  store.updatePeer(x.id,{cwd:PACKAGE_ROOT});
  store.pair(c.id,x.id);store.saveEndpoint({...store.endpoint(x.id)!,mode:'embedded'});
  const sent=broker.send({actor:{host:'claude',sessionId:'c',callId:'refs'},message:body}) as any;
  const actor={host:'codex' as const,sessionId:'x',callId:'pickup'};
  const first=broker.receive(actor) as any,second=broker.receive(actor) as any;
  assert.deepEqual(second,first);assert.equal(first.messages[0].message,body);assert.equal(first.messages[0].hint,fileHintFields(body).hint);
  assert.equal(store.message(sent.message_id).body,body);
  assert.equal((store.setting<any>(`receive:${x.id}:x:pickup`)).messages[0].hint,undefined);
});

test('hint 按收件方 cwd 确认存在性，自动投递与 embedded 使用相同规则',async t=>{
  const {store,broker,c,x,codex,claude}=fixture(t),cwd=temporary(t),body='a.ts b.ts';
  writeFileSync(path.join(cwd,'a.ts'),'甲','utf8');writeFileSync(path.join(cwd,'b.ts'),'乙','utf8');
  store.updatePeer(c.id,{cwd});store.updatePeer(x.id,{cwd:temporary(t)});store.pair(c.id,x.id);
  broker.send({actor:{host:'claude',sessionId:'c',callId:'c-cwd'},message:body});broker.send({actor:{host:'codex',sessionId:'x',callId:'x-cwd'},message:body});await broker.pump();
  assert.equal(JSON.parse(codex.injected[0]!.output).messages[0].hint,undefined);assert.equal((broker.receive({host:'codex',sessionId:'x',callId:'direct-cwd'}) as any).messages.length,0);assert.match((claude.delivered[0] as DeliveryMessage).hint!,/2 file refs/);
  store.saveEndpoint({...store.endpoint(x.id)!,mode:'embedded'});broker.send({actor:{host:'claude',sessionId:'c',callId:'embedded-cwd'},message:body});
  assert.equal((broker.receive({host:'codex',sessionId:'x',callId:'pick-cwd'}) as any).messages[0].hint,undefined);
});
