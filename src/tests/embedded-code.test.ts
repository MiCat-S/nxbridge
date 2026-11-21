import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,readdirSync,writeFileSync} from 'node:fs';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {DatabaseSync} from 'node:sqlite';
import {pathToFileURL} from 'node:url';
import {runInNewContext} from 'node:vm';
import {createHash} from 'node:crypto';
import path from 'node:path';
import ts from 'typescript';
import {PACKAGE_ROOT} from '../shared/package-location.js';
import {windowsPowerShell} from '../shared/windows-tools.js';
import {initializeSchema} from '../storage/schema.js';
import {windowsHookIdentitySource} from '../process/windows/native-sources.js';
import {WINDOWS_IDENTITY_REVISION} from '../process/windows/identity-revision.js';
import { temporary } from './support/temporary.js';

interface CodeRecord {file:string;line:number;language:string;original:string;compact:string;expressions:string[]}
const execute=promisify(execFile);
const tooling=()=>import(pathToFileURL(path.join(PACKAGE_ROOT,'tools/embedded-code.mjs')).href);
async function records():Promise<CodeRecord[]>{
  const {compressOwnSource}=await tooling(),rows:CodeRecord[]=[];
  for(const file of readdirSync(path.join(PACKAGE_ROOT,'src'),{recursive:true,encoding:'utf8'}).filter(name=>name.endsWith('.ts')&&!/^(?:tests|native-tests)[/\\]/.test(name))){
    rows.push(...(await compressOwnSource(file,readFileSync(path.join(PACKAGE_ROOT,'src',file),'utf8'))).records);
  }
  return rows;
}
function statements(text:string):string[]{
  const rows:string[]=[];let from=0;
  for(let i=0;i<text.length;i++){
    const ch=text[i],next=text[i+1];
    if(ch==='-'&&next==='-'){const end=text.indexOf('\n',i+2);i=end<0?text.length:end;continue;}
    if(ch==='/'&&next==='*'){const end=text.indexOf('*/',i+2);assert.ok(end>=0);i=end+1;continue;}
    if(ch==="'"||ch==='"'||ch==='['||ch==='`'){
      const closing=ch==='['?']':ch;let end=i+1;
      for(;end<text.length;end++)if(text[end]===closing){if(text[end+1]===closing){end++;continue;}break;}
      assert.ok(end<text.length);i=end;continue;
    }
    if(ch===';'){rows.push(text.slice(from,i));from=i+1;}
  }
  rows.push(text.slice(from));return rows.map(value=>value.trim()).filter(Boolean);
}
function sqlTemplate(row:CodeRecord,text:string):string{
  if(!row.expressions.length)return text;
  const ast=ts.createSourceFile(row.file,readFileSync(path.join(PACKAGE_ROOT,'src',row.file),'utf8'),ts.ScriptTarget.Latest,true),values=new Map<string,string>();
  const visit=(node:ts.Node)=>{if(ts.isVariableDeclaration(node)&&node.initializer&&ts.isStringLiteralLike(node.initializer))values.set(node.name.getText(ast),node.initializer.text);ts.forEachChild(node,visit);};visit(ast);
  for(let i=0;i<row.expressions.length;i++){const name=row.expressions[i]!;assert.ok(values.has(name),'SQL 插槽需要可核验的常量：'+name);text=text.replaceAll('__NXBRIDGE_EMBED_HOLE_'+i+'__',values.get(name)!);}
  return text;
}
test('SQL 压缩保留每条语句的 SQLite 字节码和数据库结构',async()=>{
  const {compactCode}=await tooling(),rows=(await records()).filter(row=>row.language==='sql'&&row.original!==row.compact);
  assert.ok(rows.length>0);
  for(const row of rows){
    const left=new DatabaseSync(':memory:'),right=new DatabaseSync(':memory:');
    try{
      const before=statements(sqlTemplate(row,row.original)),after=statements(sqlTemplate(row,row.compact));assert.equal(after.length,before.length);
                                              
      const addingLease=before.some(sql=>/^ALTER\s+TABLE\s+reservation\s+ADD\s+COLUMN\s+expires_at\b/i.test(sql));
      for(const db of [left,right]){initializeSchema(db);db.exec('CREATE TEMP TABLE protected_messages(id TEXT PRIMARY KEY);CREATE TEMP TABLE retained_messages(id TEXT PRIMARY KEY);CREATE TABLE reservation(slot INTEGER PRIMARY KEY,pid,generation,token'+(addingLease?'':',expires_at INTEGER NOT NULL DEFAULT 0')+')');}
      const normalize=(ops:Record<string,unknown>[])=>ops.map(op=>({...op,p4:typeof op.p4==='string'&&/^CREATE\b/i.test(op.p4)?compactCode('sql',op.p4):op.p4}));
      for(let i=0;i<before.length;i++){
                                         
        const explain=(sql:string)=>{try{return normalize(left.prepare('EXPLAIN '+sql).all());}catch(error){throw new Error(row.file+':'+row.line+' SQL 编译失败：'+sql,{cause:error});}};
        assert.deepEqual(explain(before[i]!),explain(after[i]!),row.file+':'+row.line);
        if(/^(?:CREATE|DROP|ALTER)\b/i.test(before[i]!)){left.exec(before[i]!);right.exec(after[i]!);}
      }
      const schema=(db:DatabaseSync)=>db.prepare('SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY type,name').all().map(value=>({...value,sql:typeof value.sql==='string'?compactCode('sql',value.sql):value.sql}));
      assert.deepEqual(schema(left),schema(right));
    }finally{left.close();right.close();}
  }
});
test('SQL 片段压缩保留动态拼接两侧的词法分隔',async()=>{
  const {compressOwnSource}=await tooling(),source='const prefix=/* @nxbridge-embed sql */ " SELECT 1 AS value WHERE 0 OR ";const suffix=/* @nxbridge-embed sql */ " ORDER BY value ";globalThis.query=prefix+"1"+suffix;',before:any={},after:any={};
  runInNewContext(source,before);runInNewContext((await compressOwnSource('fragments.ts',source)).contents,after);
  const db=new DatabaseSync(':memory:');
  try{assert.deepEqual(db.prepare(after.query).get(),db.prepare(before.query).get());}finally{db.close();}
});

test('构建标记只修改指定表达式，保留提示词、模板转换和原始反斜线',async()=>{
  const {compressOwnSource}=await tooling(),bt=String.fromCharCode(96),source=[
    'const prompt='+JSON.stringify('规则\\n原样  保留 /* @nxbridge-embed csharp */')+';',
    'const code=/* @nxbridge-embed csharp */ String.raw'+bt+'public class Demo { public string Value="a  // b"; }'+bt+';',
    'const dynamic=/* @nxbridge-embed powershell */ '+bt+"Write-Output '${value}'"+bt+';',
    'globalThis.output={prompt,dynamic,code};'
  ].join('\n');
  const transformed=await compressOwnSource('sample.ts',source);assert.equal(transformed.records.length,2);
  const value={valueOf(){throw Error('不能改变模板的 ToString 提示');},toString(){return 'a  b';}},before:any={value},after:any={value};
  runInNewContext(source,before);runInNewContext(transformed.contents,after);
  assert.equal(after.output.prompt,before.output.prompt);assert.equal(after.output.dynamic,before.output.dynamic);assert.ok(after.output.code.includes('"a  // b"'));
  await assert.rejects(compressOwnSource('bad.ts','/* @nxbridge-embed sql */ const value=1;'));
});

test('原生源码共享模块保留助手内容与开发版修订号',async()=>{
  const {originalIdentityRevision}=await tooling();
  assert.equal(originalIdentityRevision(PACKAGE_ROOT),createHash('sha256').update(windowsHookIdentitySource).digest('hex').slice(0,16));
  assert.equal(WINDOWS_IDENTITY_REVISION,originalIdentityRevision(PACKAGE_ROOT));
  const rows=(await records()).filter(row=>row.file==='process/windows/native-sources.ts'&&row.language==='csharp');
  const identity=rows.find(row=>row.original.includes('public static class NxHookIdentity')),holder=rows.find(row=>row.original.includes('public static class NxJobHolder'));assert.ok(identity&&holder);
  const published=await import(pathToFileURL(path.join(PACKAGE_ROOT,'publish/runtime-native-source.mjs')).href);
  assert.equal(published.windowsHookIdentitySource,identity.compact+holder.compact);
  for(const entry of ['hook-control','mod-entry','mcp-entry']){
    const source=readFileSync(path.join(PACKAGE_ROOT,'publish',entry+'.mjs'),'utf8');
    assert.doesNotMatch(source,/from\s*["']\.\/runtime-native-source\.mjs["']/);
    assert.match(source,/import\(["']\.\/runtime-native-source\.mjs["']\)/);
  }
});
test('C# 和 PowerShell 压缩通过真实编译器与语法树验证',{skip:process.platform!=='win32',timeout:30000},async t=>{
  const {compactCode}=await tooling(),rows=await records(),directory=temporary(t);
                                            
  const identity=rows.find(row=>row.file==='process/windows/native-sources.ts'&&row.language==='csharp'&&row.original.includes('public static class NxHookIdentity')),holder=rows.find(row=>row.file==='process/windows/native-sources.ts'&&row.language==='csharp'&&row.original.includes('public static class NxJobHolder'));
  assert.ok(identity&&holder);
  identity.original+=holder.original;identity.compact+=holder.compact;rows.splice(rows.indexOf(holder),1);
  assert.equal(identity.original,windowsHookIdentitySource);
  const fixtures=[
    {file:'csharp-trivia.cs',language:'csharp',original:'#define FLAG\nusing System;\npublic class Trivia { public static string S=@"a "" b // c"; public static int F(){ int x=1; // 保留下一句\n#if FLAG\nreturn x + +2;\n#else\nreturn 0;\n#endif\n} }'},
    {file:'powershell-lines.ps1',language:'powershell',original:"$a=1 # 保留换行\n  $b=2\nif($true){\n  $value='a  # b'\n} else {\n  $value=@'\na  b\n'@\n}\nWrite-Output $a `\n   $b\n"}
  ];
  for(const fixture of fixtures)rows.push({...fixture,line:1,compact:compactCode(fixture.language,fixture.original),expressions:[]});
  const file=path.join(directory,'records.json');writeFileSync(file,JSON.stringify(rows),'utf8');
  const script="$ErrorActionPreference='Stop';& ([scriptblock]::Create([IO.File]::ReadAllText($env:NXBRIDGE_EMBEDDED_VALIDATION_SCRIPT,[Text.Encoding]::UTF8))) -Records $env:NXBRIDGE_EMBEDDED_VALIDATION_RECORDS";
  const result=await execute(windowsPowerShell(),['-NoLogo','-NoProfile','-NonInteractive','-Command',script],{windowsHide:true,timeout:25000,maxBuffer:2*1024*1024,env:{...process.env,NXBRIDGE_EMBEDDED_VALIDATION_SCRIPT:path.join(PACKAGE_ROOT,'tools/embedded-validation.ps1'),NXBRIDGE_EMBEDDED_VALIDATION_RECORDS:file}});
  assert.match(result.stdout,/"validation":"PASS"/);t.diagnostic(result.stdout.trim());
});
test('POSIX 入口保留 shebang、所有权标记及 sh 语法',{skip:process.platform==='win32'},async()=>{
  const rows=(await records()).filter(row=>row.language==='sh');assert.ok(rows.length>0);
  for(const row of rows){assert.equal(row.compact,row.original);await execute('sh',['-n','-c',row.original]);await execute('sh',['-n','-c',row.compact]);}
});
