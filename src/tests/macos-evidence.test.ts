import test from 'node:test';
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {cpSync} from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {homedir} from 'node:os';
import { temporary } from './support/temporary.js';

test('正式采集器复制后无需源码、dist 或 node_modules 即可查询，并区分源码隔离验收',async t=>{
  const root=temporary(t),runtime=path.join(root,'runtime');cpSync('publish',runtime,{recursive:true});
  const entry=pathToFileURL(path.join(runtime,'tools','collect-macos-evidence.mjs')).href;
                                      
  const program="Object.defineProperty(process,'platform',{value:'darwin'});process.argv=['node','collector',...JSON.parse(process.argv[1])];await import("+JSON.stringify(entry)+");";
  const run=(args:string[])=>promisify(execFile)(process.execPath,['--input-type=module','-e',program,JSON.stringify(args)],{cwd:root,windowsHide:true,timeout:12000});
  const result=await run(['--pid',String(process.pid),'--home',root,'--session','00000000-0000-4000-8000-000000000001','--endpoint','unix://'+path.join(root,'absent.sock')]);
  const report=JSON.parse(result.stdout);assert.equal(report.sessionHold.state,'unobservable');assert.notEqual(report.sessionHold.reason,'ERR_MODULE_NOT_FOUND');assert.ok(report.before&&report.after);assert.equal(typeof report.secondResolutionIdentityUnchanged,'boolean');
  await assert.rejects(run(['--validate-transfer']),error=>{assert.match((error as {stderr:string}).stderr,/自动隔离验收需要源码仓库/);return true;});
});

test('采集器固定时间 locale 与时区，展开 home、socket 和 UNIX 端点中的波浪号',async t=>{
  const root=temporary(t),runtime=path.join(root,'runtime');cpSync('publish',runtime,{recursive:true});
  const entry=pathToFileURL(path.join(runtime,'tools','collect-macos-evidence.mjs')).href;
  const program=`import {createRequire,syncBuiltinESMExports} from 'node:module';
const cp=createRequire(import.meta.url)('node:child_process');
cp.execFileSync=(binary,args,options)=>{if(options.env.LC_TIME!=='C'||options.env.TZ!=='UTC'||options.env.LC_ALL)throw Error('wrong_locale');if(binary==='/bin/ps')return '123 501 Wed Nov 11 16:14:59 2026 S ?? /usr/bin/codex';throw Object.assign(Error('partial'),{status:1,stdout:'p123\\nf0\\ntCHR\\nn/dev/ttys002\\n'});};
syncBuiltinESMExports();Object.defineProperty(process,'platform',{value:'darwin'});
process.argv=['node','collector','--pid','123','--home','~/nxbridge-missing-home','--socket','~/nxbridge-missing.sock','--session','00000000-0000-4000-8000-000000000001','--endpoint','unix://~/nxbridge-missing.sock'];
await import(${JSON.stringify(entry)});`;
  const result=await promisify(execFile)(process.execPath,['--input-type=module','-e',program],{cwd:root,windowsHide:true,timeout:12000}),report=JSON.parse(result.stdout);
  assert.equal(report.before.ok,true);assert.equal(report.files.partial,true);assert.equal(report.secondResolutionIdentityUnchanged,true);assert.equal(report.userSuppliedHome.path,path.join(homedir(),'nxbridge-missing-home'));assert.equal(report.endpoint.path,path.join(homedir(),'nxbridge-missing.sock'));
});
