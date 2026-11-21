import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { readFileSync, writeFileSync } from 'node:fs';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import {runCli} from '../process/host-command.js';
import { configClient } from '../hosts/codex/stdio-codex.js';
import { hostControlFailure } from '../hosts/host-control.js';
import {DEFAULT_CONFIG} from '../config/defaults.js';
import { codexInitializeResult } from './support/registration.js';
import { temporary } from './support/temporary.js';
import { ownedProcesses } from '../process/owned-processes.js';
import { ownedProcessState } from '../process/process-stop.js';
import { processIdentity } from '../process/process.js';

test('等待控制客户端关闭会等到容器内原生进程退出，无需持久归属账本',async t=>{
  const home=temporary(t),script=path.join(home,'closing-control.mjs'),pidFile=path.join(home,'control.pid');
  writeFileSync(script,`import{writeFileSync}from'node:fs';import{createInterface}from'node:readline';writeFileSync(${JSON.stringify(pidFile)},String(process.pid));const lines=createInterface({input:process.stdin});lines.on('line',line=>{const m=JSON.parse(line);if(m.id)console.log(JSON.stringify({id:m.id,result:${JSON.stringify(codexInitializeResult)}}));});process.stdin.on('end',()=>setTimeout(()=>process.exit(0),400));`,'utf8');
  const control=await configClient({...DEFAULT_CONFIG,codexBinary:script,codexHome:home},home),identity=await processIdentity(Number(readFileSync(pidFile,'utf8')));
  assert.deepEqual(ownedProcesses(home).records,[]);await control.close();
  assert.equal(await ownedProcessState(identity),'dead','不能把发出关闭请求等同于原代次已退出');
});

test('固定原生入口的控制命令同样串行，非零退出只执行一次且不阻塞后续命令',async t=>{
  const home=temporary(t),script=path.join(home,'native.mjs'),lock=path.join(home,'exclusive'),calls=path.join(home,'calls');
  writeFileSync(script,`import{openSync,closeSync,unlinkSync,appendFileSync}from'node:fs';closeSync(openSync(${JSON.stringify(lock)},'wx'));appendFileSync(${JSON.stringify(calls)},process.argv.at(-1)+'\\n');setTimeout(()=>{unlinkSync(${JSON.stringify(lock)});console.log(process.argv.at(-1));process.exitCode=process.argv.at(-1)==='fail'?23:0;},60);`,'utf8');
  const config={...DEFAULT_CONFIG,claudeBinary:script,claudeHome:home};
  const outcomes=await Promise.allSettled(['first','fail','last'].map(arg=>runCli('claude',[arg],{config,home})));
  for(const outcome of [outcomes[0]!,outcomes[2]!])assert.equal(outcome.status,'fulfilled',outcome.status==='rejected'?outcome.reason:undefined);
  assert.equal(outcomes[1]!.status,'rejected');const error=(outcomes[1] as PromiseRejectedResult).reason;
  assert.equal(error.exitCode,23);assert.match(error.message,/退出码=23/);assert.match(error.message,/标准错误末尾：.*空/);assert.match(error.message,/标准输出末尾：fail/);
  assert.equal(readFileSync(calls,'utf8'),'first\nfail\nlast\n');
});

test('控制命令不写重复归属账本，原生成功或失败都只执行一次',async t=>{
  const home=temporary(t),script=path.join(home,'ownership-failure.mjs'),calls=path.join(home,'calls'),done=path.join(home,'done');
  writeFileSync(script,`import{appendFileSync,writeFileSync}from'node:fs';appendFileSync(${JSON.stringify(calls)},'called\\n');setTimeout(()=>{writeFileSync(${JSON.stringify(done)},'done');console.log('native ok');process.exitCode=Number(process.argv.at(-1));},1000);`,'utf8');
  const config={...DEFAULT_CONFIG,codexBinary:script,codexHome:home},original=fs.writeFileSync;let rejected=0;
  t.mock.method(fs,'writeFileSync',(...args:any[])=>{
    if(String(args[1]).includes('"role": "host-control"')){rejected++;throw Object.assign(Error('测试归属记录不可用'),{code:'EAGAIN'});}
    return Reflect.apply(original,fs,args);
  });syncBuiltinESMExports();
  try{
    assert.equal((await runCli('codex',['0'],{config,home})).trim(),'native ok');
    assert.equal(readFileSync(done,'utf8'),'done','命令结束前不能释放控制租约');
    await assert.rejects(runCli('codex',['23'],{config,home}),error=>{
      assert.equal((error as any).exitCode,23);assert.match((error as Error).message,/标准输出末尾：native ok/);return true;
    });
    assert.equal(rejected,0);assert.equal(readFileSync(calls,'utf8'),'called\ncalled\n');
  }finally{t.mock.restoreAll();syncBuiltinESMExports();}
});

test('短命 App Server 的控制租约保持到实际退出，清单查询不能抢占关闭中的进程',async t=>{
  const home=temporary(t),script=path.join(home,'control.mjs'),lock=path.join(home,'exclusive');
  writeFileSync(script,`import{openSync,closeSync,unlinkSync}from'node:fs';import{createInterface}from'node:readline';const lock=${JSON.stringify(lock)};closeSync(openSync(lock,'wx'));if(process.argv.includes('app-server')&&!process.argv.includes('--help')){const lines=createInterface({input:process.stdin});lines.on('line',line=>{const m=JSON.parse(line);if(m.id)console.log(JSON.stringify({id:m.id,result:${JSON.stringify(codexInitializeResult)}}));});process.stdin.on('end',()=>setTimeout(()=>{unlinkSync(lock);process.exit(0)},100));}else{unlinkSync(lock);console.log('inventory ok');}`,'utf8');
  const config={...DEFAULT_CONFIG,codexBinary:script,codexHome:home};
  const control=await configClient(config,home);
  try{const inventory=runCli('codex',['plugin','list','--json'],{config,home});control.close();assert.equal((await inventory).trim(),'inventory ok');}
  finally{if(!control.closed)control.close();}
});

test('控制进程在初始化前退出时保留退出码和标准错误，不返回空失败原因',async t=>{
  const home=temporary(t),script=path.join(home,'broken.mjs');
  writeFileSync(script,"process.stderr.write('native initialization failed');process.exitCode=17;",'utf8');
  await assert.rejects(configClient({...DEFAULT_CONFIG,codexBinary:script,codexHome:home},home),error=>{assert.match((error as Error).message,/退出码=17/);assert.match((error as Error).message,/native initialization failed/);return true;});
});

test('失败诊断保留边界输出并脱敏参数',()=>{
  const empty=hostControlFailure('codex',['plugin','list','--json'],{code:9});assert.match(empty.message,/退出码=9/);assert.match(empty.message,/标准输出末尾：.*空/);
  const detail=hostControlFailure('claude',['agents','--api-key','不能泄漏'],{code:'ENOENT',stdout:'开头不应保留'+'x'.repeat(5000)+'结尾',stderr:'原生错误'});
  assert.match(detail.message,/ENOENT/);assert.match(detail.message,/结尾/);assert.match(detail.message,/原生错误/);assert.doesNotMatch(detail.message,/不能泄漏|开头不应保留/);
});
