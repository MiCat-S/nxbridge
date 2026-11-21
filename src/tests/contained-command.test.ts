import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { promisify } from 'node:util';
import { once } from 'node:events';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { spawnContainedCommand, executeContainedCommand, containedCommandExit } from '../process/contained-command.js';
import {delay} from '../shared/time.js';
import { processIdentity, type ProcessIdentity } from '../process/process.js';
import { ownedProcessState } from '../process/process-stop.js';
import { rememberOwnedChild, recordOwnedProcess, releaseRecordedProcesses } from '../process/owned-processes.js';
import { temporary } from './support/temporary.js';
import { containedCommandStatus } from '../process/contained-command.js';

async function capture(child:ChildProcess):Promise<{stdout:Buffer;stderr:Buffer;code:number|null}>{
  const stdout:Buffer[]=[],stderr:Buffer[]=[];
  child.stdout!.on('data',value=>stdout.push(value));child.stderr!.on('data',value=>stderr.push(value));child.stdin!.end();
  const [code,signal]=await once(child,'close');return{stdout:Buffer.concat(stdout),stderr:Buffer.concat(stderr),code:containedCommandExit(child,code,signal).code};
}
async function until(check:()=>boolean|Promise<boolean>):Promise<void>{
  const end=Date.now()+8000;while(!await check()){assert.ok(Date.now()<end,'控制进程状态未在期限内收敛');await delay(20);}
}

test('容器参数、标准流字节和退出码与直接执行一致',async t=>{
  const home=temporary(t),script=path.join(home,'参数 空格.mjs');
  writeFileSync(script,"import{readFileSync}from'node:fs';process.stdout.write(Buffer.from([0,255,1]));process.stdout.write(JSON.stringify({args:process.argv.slice(2),input:readFileSync(0,'utf8')}));process.stderr.write(Buffer.from([254,0,13,10]));process.exitCode=23;",'utf8');
  const args=[script,'','中文 🚀','with space','quote"value','slash\\','trailing \\','\\\\"nested"\\','line\nfeed'];
  const directPending=promisify(execFile)(process.execPath,args,{encoding:'buffer'});directPending.child.stdin?.end();
  const direct=await directPending.catch(error=>error as {stdout:Buffer;stderr:Buffer;code:number});
  const began=performance.now(),contained=await capture(await spawnContainedCommand(process.execPath,args,{home,stdio:['pipe','pipe','pipe']}));
  assert.equal(contained.code,23);assert.deepEqual(contained.stdout,direct.stdout);assert.deepEqual(contained.stderr,direct.stderr);
  const warm=performance.now();await executeContainedCommand(process.execPath,['-e',"console.log('ok')"],{home,timeout:5000,maxBuffer:1024});
  const status=containedCommandStatus(home);assert.equal(status.observedReapings,0,'系统控制台宿主不应污染异常后代统计：'+JSON.stringify(status));
  t.diagnostic(JSON.stringify({containedColdMs:Math.round(warm-began),containedWarmMs:Math.round(performance.now()-warm)}));
});

test('目标启动失败保留系统错误，宿主输出不能冒充容器失败，输出上限仍回收容器',async t=>{
  const home=temporary(t),options={home,timeout:5000,maxBuffer:1024};let submitted=false;
  await assert.rejects(executeContainedCommand(path.join(home,'不存在的程序'),[],{...options,onSpawn:()=>submitted=true}),{code:'ENOENT'});assert.equal(submitted,false);
  await assert.rejects(executeContainedCommand(process.execPath,['-e',"console.error('nxbridge command ownership: child output');process.exitCode=125;"],options),error=>{assert.equal((error as any).code,125);return true;});
  await assert.rejects(executeContainedCommand(process.execPath,['-e',"process.stdout.write('x'.repeat(10000));setInterval(()=>{},1000);"],options),{code:'ERR_CHILD_PROCESS_STDIO_MAXBUFFER'});
});

test('正常退出给仍在收尾的子进程有限时间，完成写入后不计入强制回收',async t=>{
  const home=temporary(t),done=path.join(home,'已完成'),script=path.join(home,'收尾.mjs');
  const child="import{writeFileSync}from'node:fs';process.stdout.write('ready');setTimeout(()=>writeFileSync("+JSON.stringify(done)+",'ok','utf8'),250);";
  writeFileSync(script,`import{spawn}from'node:child_process';const child=spawn(process.execPath,['--input-type=module','-e',${JSON.stringify(child)}],{detached:process.platform==='win32',windowsHide:true,stdio:['ignore','pipe',2]});child.stdout.once('data',()=>process.exit(0));`,'utf8');
  await executeContainedCommand(process.execPath,[script],{home,timeout:5000,maxBuffer:1024});
  assert.equal(readFileSync(done,'utf8'),'ok');assert.equal(containedCommandStatus(home).observedReapings,0);
});

test('命令超时整组回收包装器与后代，不停止旁边的同名进程',async t=>{
  const home=temporary(t),ready=path.join(home,'tree.json'),script=path.join(home,'tree.mjs');
  writeFileSync(script,`import{spawn}from'node:child_process';import{writeFileSync}from'node:fs';const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});child.once('spawn',()=>writeFileSync(${JSON.stringify(ready)},JSON.stringify([process.pid,child.pid])));setInterval(()=>{},1000);`,'utf8');
  const neighbor=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});
  await rememberOwnedChild(home,neighbor,'host-control');
  const closed=once(neighbor,'close');t.after(async()=>{neighbor.kill();await closed;await releaseRecordedProcesses(home,()=>true);});
  const pending=executeContainedCommand(process.execPath,[script],{home,timeout:5000,maxBuffer:1024});void pending.catch(()=>{});
  await until(()=>existsSync(ready));const identities=await Promise.all((JSON.parse(readFileSync(ready,'utf8')) as number[]).map(processIdentity));
  for(const identity of identities)await recordOwnedProcess(home,{role:'host-control',identity,parent:await processIdentity(process.pid),proof:{kind:'spawn'}});
  await assert.rejects(pending,error=>{assert.equal((error as any).killed,true);return true;});
  await until(async()=>!(await Promise.all(identities.map(ownedProcessState))).some(state=>state!=='dead'));assert.equal(neighbor.exitCode,null);assert.equal(neighbor.signalCode,null);
});

test('调用方被强制终止后容器仍回收全部后代，正常退出也清理继承管道的后代',async t=>{
  const home=temporary(t),ready=path.join(home,'orphan.json'),script=path.join(home,'orphan.mjs'),module=new URL('../process/contained-command.js',import.meta.url).href;
                                                          
  writeFileSync(script,`import{spawn}from'node:child_process';import{writeFileSync}from'node:fs';const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{detached:process.platform==='win32',windowsHide:true,stdio:['ignore',1,2]});child.once('spawn',()=>writeFileSync(${JSON.stringify(ready)},JSON.stringify([process.pid,child.pid])));if(process.argv.includes('exit'))setTimeout(()=>process.exit(0),300);else setInterval(()=>{},1000);`,'utf8');
  const outer=spawn(process.execPath,['--input-type=module','-e',`import{spawnContainedCommand}from ${JSON.stringify(module)};const c=await spawnContainedCommand(process.execPath,${JSON.stringify([script])},{home:${JSON.stringify(home)},stdio:['pipe','pipe','pipe']});c.stdin.end();c.stdout.resume();c.stderr.resume();setInterval(()=>{},1000);`],{stdio:['ignore','ignore','pipe']});
  let errors='';outer.stderr!.on('data',value=>errors+=value);const closed=once(outer,'close');
  await rememberOwnedChild(home,outer,'host-control');t.after(async()=>{if(outer.exitCode===null&&outer.signalCode===null)outer.kill();await closed;await releaseRecordedProcesses(home,()=>true);});
  await until(()=>{assert.equal(outer.exitCode,null,errors);return existsSync(ready);});
  const identities:ProcessIdentity[]=await Promise.all((JSON.parse(readFileSync(ready,'utf8')) as number[]).map(processIdentity));
  for(const identity of identities)await recordOwnedProcess(home,{role:'host-control',identity,parent:await processIdentity(outer.pid!),proof:{kind:'spawn'}});
  outer.kill('SIGKILL');await closed;
  await until(async()=>!(await Promise.all(identities.map(ownedProcessState))).some(state=>state!=='dead'));
  assert.equal((await executeContainedCommand(process.execPath,[script,'exit'],{home,timeout:5000,maxBuffer:1024})).stdout,'');
  const normal=await Promise.all((JSON.parse(readFileSync(ready,'utf8')) as number[]).map(async pid=>{try{return await processIdentity(pid);}catch{return undefined;}}));
  assert.ok(normal.every(identity=>!identity||['Z','X'].includes(identity.state??'')),'正常返回不能留下仍持有管道的后代');
  const reaping=containedCommandStatus(home);assert.equal(reaping.observedReapings,1);assert.ok((reaping.recent[0] as any).count>=1);
});

test('原生命令已经成功但后代收尾超过调用预算时，仍保留超时而不返回成功',async t=>{
  const home=temporary(t),script="const{spawn}=require('node:child_process');const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{detached:process.platform==='win32',windowsHide:true,stdio:'ignore'});child.unref();";
  await assert.rejects(executeContainedCommand(process.execPath,['-e',script],{home,timeout:300,maxBuffer:1024}),error=>{
    assert.equal((error as NodeJS.ErrnoException).code,'ETIMEDOUT');assert.equal((error as any).killed,true);return true;
  });
});
