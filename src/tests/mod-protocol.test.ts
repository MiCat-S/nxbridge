import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { modContextSchema, modResponse, modInput } from '../integration/mod/mod-protocol.js';
import {PACKAGE_ROOT} from '../shared/package-location.js';

test('原生 Mod 宿主 API 只直接调用，不读取能力对象或方法值',()=>{
                                                     
  const invalidReads=(name:string,source:string)=>{
    const ast=ts.createSourceFile(name,source,ts.ScriptTarget.Latest,true,ts.ScriptKind.JS),invalid:string[]=[];
    const visit=(node:ts.Node)=>{
      if((ts.isPropertyAccessExpression(node)||ts.isElementAccessExpression(node))&&ts.isIdentifier(node.expression)&&node.expression.text==='$'){
        const member=node.parent;
        const direct=ts.isPropertyAccessExpression(node)&&!node.questionDotToken&&ts.isPropertyAccessExpression(member)&&!member.questionDotToken;
                                                 
        const metadata=direct&&node.name.text==='plugin'&&member.name.text==='root';
        const called=direct&&ts.isCallExpression(member.parent)&&member.parent.expression===member&&!member.parent.questionDotToken;
        if(!metadata&&!called)invalid.push(name+':'+(ast.getLineAndCharacterOfPosition(node.getStart(ast)).line+1)+' '+node.getText(ast));
      }
      ts.forEachChild(node,visit);
    };
    visit(ast);return invalid;
  };
  assert.deepEqual(invalidReads('允许.js',`await $.http.fetch(url); await $.clock.now(); const root=$.plugin.root; const text="typeof $.http"; // $.http?.fetch`),[]);
  for(const source of ['typeof $.http','typeof $.http.fetch','$.http?.fetch(url)','const api=$.http','const fetch=$.http.fetch','$["http"].fetch(url)'])assert.equal(invalidReads('拒绝.js',source).length,1,source);
  const directory=path.join(PACKAGE_ROOT,'plugins/claude/hooks');
  const invalid=readdirSync(directory).filter(name=>name.endsWith('.js')).flatMap(name=>invalidReads(name,readFileSync(path.join(directory,name),'utf8')));
  assert.deepEqual(invalid,[],'原生宿主不能编译这些 API 属性读取');
});

test('Mod 标准输入支持长正文和跨块 UTF-8，旧 argv 兼容，输入限额保持 2 MiB',async()=>{
  const input={operation:'send',message:'回复'.repeat(20000),auto_reply_to:'source',auto_reply_text:'中文证据'.repeat(20000)},raw=JSON.stringify(input),bytes=Buffer.from(raw,'utf8');
  const chunks=async function*(){for(let offset=0;offset<bytes.length;offset+=65537)yield bytes.subarray(offset,offset+65537);};
  assert.deepEqual(await modInput('-',chunks()),input);assert.deepEqual(await modInput(raw),input);assert.deepEqual(await modInput(undefined),{});
  const limit=2*1024*1024,boundary=Buffer.from(JSON.stringify('x'.repeat(limit-2)));
  assert.equal((await modInput('-',(async function*(){yield boundary;})()) as string).length,limit-2);
  await assert.rejects(modInput('-',(async function*(){yield boundary;yield Buffer.from(' ');})()),{code:'input_too_large'});
  await assert.rejects(modInput('-',(async function*(){yield Buffer.from('{');})()),SyntaxError);
});

test('问答和普通 Mod 调用共享完整上下文；宿主权限观察仍需校验',()=>{
  const context={sessionId:'current',inbox:'native-inbox',contextStart:true,contextReason:'switch',binding:{key:'window',epoch:'epoch'},nativeSession:{transcriptPath:'/native/current.jsonl',interactive:false},nativePermission:{mode:'default',observedAt:100},nativeDecision:{bash:'ask',observedAt:100},nativeInbound:{policy:'default',dialogExpiry:'5m',dialogTimeoutMs:5000,observedAt:101}};
  assert.deepEqual(modContextSchema.strict().parse(context),context);
  assert.equal(modContextSchema.strict().safeParse({...context,nativePermission:{mode:'default',observedAt:-1}}).success,false);
  assert.equal(modContextSchema.strict().safeParse({...context,nativeDecision:{bash:'allow',observedAt:-1}}).success,false);
  assert.equal(modContextSchema.strict().safeParse({...context,nativeInbound:{policy:'reject',observedAt:101}}).success,false);
  assert.equal(modContextSchema.strict().safeParse({...context,actor:{host:'claude'}}).success,false);
  assert.equal(modContextSchema.strict().safeParse({...context,nativeSession:{interactive:'false'}}).success,false);
});

test('升级后旧 Mod 仍直接读到已保存的消息 ID，新 Mod 保留上下文租约',()=>{
  const saved={message_id:'original',persisted:true,status:'queued'},context={sessionId:'current',binding:{key:'window',epoch:'epoch'}};
  const legacy=modResponse({},saved,context) as typeof saved;
  assert.equal(legacy.message_id,'original');assert.equal(legacy.persisted,true);
  for(const input of [{contextStart:true},{contextStart:false},{binding:context.binding}]){
    const modern=modResponse(input,saved,context) as {value:typeof saved;context:typeof context};
    assert.deepEqual(modern.value,saved);assert.deepEqual(modern.context,context);
  }
});
