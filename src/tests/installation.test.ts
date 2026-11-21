import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync, mkdirSync, writeFileSync, readFileSync, cpSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { installShim, planShim, preferredBinDirectories, toolSpecificBin, installedCacheStatus } from '../install/installation.js';
import {windowsPowerShell} from '../shared/windows-tools.js';
import {PACKAGE_ROOT} from '../shared/package-location.js';
import { temporary, temporaryDirectory } from './support/temporary.js';

test('状态查询共用同次缓存清单，保留归属核验且下次重新读取磁盘',t=>{
  const root=temporary(t),home=path.join(root,'bridge'),hostHome=path.join(root,'claude');mkdirSync(home);
  const directories=Array.from({length:8},(_,index)=>path.join(hostHome,'plugins','cache','nxbridge-local','nxbridge','v'+index));
  for(const[index,directory]of directories.entries()){
    mkdirSync(path.join(directory,'.claude-plugin'),{recursive:true});
    writeFileSync(path.join(directory,'.claude-plugin','plugin.json'),JSON.stringify({name:'nxbridge',version:'0.1.'+index}),'utf8');
    writeFileSync(path.join(directory,'runtime.json'),JSON.stringify({home:index===7?path.join(root,'foreign'):home}),'utf8');
  }
  writeFileSync(path.join(home,'setup-state.json'),JSON.stringify({cacheDirectories:directories.map(directory=>({host:'claude',directory}))}),'utf8');
  assert.equal(installedCacheStatus(home).length,7);
  writeFileSync(path.join(directories[0]!,'.claude-plugin','plugin.json'),JSON.stringify({name:'other-plugin',version:'0.1.0'}),'utf8');
  assert.equal(installedCacheStatus(home).length,6);
  writeFileSync(path.join(directories[1]!,'runtime.json'),JSON.stringify({home:path.join(root,'foreign')}),'utf8');
  assert.equal(installedCacheStatus(home).length,5);
});

test('全新安装创建尚不存在的用户 PATH 目录，不选择 Node 系统目录；更新保留自有入口',t=>{
  const tmp=temporaryDirectory(homedir());t.after(tmp.cleanup);
  const home=path.join(tmp.directory,'home'),bin=path.join(tmp.directory,'missing','npm'),prefix=path.join(tmp.directory,'node-install'),system=process.platform==='win32'?prefix:path.join(prefix,'bin'),delimiter=path.delimiter;
  const node=path.join(system,path.basename(process.execPath));mkdirSync(system,{recursive:true});
  const oldPrefix=process.env.npm_config_prefix;process.env.npm_config_prefix=prefix;
  t.after(()=>{if(oldPrefix===undefined)delete process.env.npm_config_prefix;else process.env.npm_config_prefix=oldPrefix;});
  const plan=planShim(home,{node,pathValue:[bin,system].join(delimiter)});assert.equal(plan.directory,bin);assert.equal(existsSync(bin),false,'规划不能提前创建目录');installShim(plan);assert.equal(existsSync(plan.files[0]!.file),true);
  const next=path.join(tmp.directory,'other');mkdirSync(next);
  const updated=planShim(home,{node,pathValue:[next,bin,system].join(delimiter)});assert.equal(updated.directory,bin,'不能因新增 PATH 目录而搬走已有自有命令');
  const fresh=path.join(tmp.directory,'fresh-home'),absent=planShim(fresh,{node,pathValue:system});assert.equal(absent.directory,null);assert.match(absent.notice!,/没有修改 PATH/);
  installShim(planShim(fresh,{node,pathValue:system,directories:[system]}));
  assert.equal(planShim(fresh,{node,pathValue:system}).directory,system,'显式安装后保留该自有命令');
});

test('只保护选中目录的命令，其他 PATH 目录的同名命令仅在遮挡时提示',t=>{
  const directory=temporary(t),home=path.join(directory,'home'),bin=path.join(directory,'bin'),foreign=path.join(directory,'foreign');
  mkdirSync(bin);mkdirSync(foreign);
  const filename=path.join(foreign,process.platform==='win32'?'nxbridge.cmd':'nxbridge');writeFileSync(filename,'其他安装的命令','utf8');
  const options={directories:[bin],pathValue:[foreign,bin].join(path.delimiter)},shadowed=planShim(home,options);
  assert.equal(shadowed.directory,bin);assert.match(shadowed.notice!,/会遮住/);assert.ok(shadowed.notice!.includes(filename));assert.match(shadowed.notice!,/nxbridge\.cjs/);
  installShim(shadowed);assert.equal(readFileSync(filename,'utf8'),'其他安装的命令');
  assert.equal(planShim(home,{...options,pathValue:[bin,foreign].join(path.delimiter)}).notice,undefined);
  assert.throws(()=>planShim(home,{directories:[foreign],pathValue:options.pathValue}),{code:'shim_conflict'});
});

test('生成的命令入口支持中文路径并转发参数、标准输入和退出码',async t=>{
  const directory=temporary(t),home=path.join(directory,'中文 私有目录'),bin=path.join(directory,'中文 命令目录'),entry=path.join(directory,'隔离 入口.mjs');mkdirSync(bin);
  writeFileSync(entry,"import {readFileSync} from 'node:fs';console.log(JSON.stringify({args:process.argv.slice(2),input:process.argv.includes('--no-stdin')?'':readFileSync(0,'utf8')}));process.exitCode=7;",'utf8');
  const plan=planShim(home,{directories:[bin],pathValue:bin,entry});installShim(plan);
  const launcher=process.platform==='win32'?path.join(bin,'nxbridge.cjs'):path.join(home,'bin','nxbridge.cjs');
  const args=['中文 参数','','a"b','x&y'];
  const result=await new Promise<{code:number|null;stdout:string;stderr:string}>((resolve,reject)=>{
    const child=spawn(process.execPath,[launcher,...args],{stdio:['pipe','pipe','pipe'],windowsHide:true});let stdout='',stderr='';
    child.stdout!.setEncoding('utf8').on('data',value=>stdout+=value);child.stderr!.setEncoding('utf8').on('data',value=>stderr+=value);child.on('error',reject);child.on('close',code=>resolve({code,stdout,stderr}));child.stdin!.end('中文标准输入');
  });
  assert.equal(result.code,7);assert.equal(result.stderr,'');assert.deepEqual(JSON.parse(result.stdout),{args,input:'中文标准输入'});
  if(process.platform==='win32'){
    const shim=path.join(bin,'nxbridge.cmd'),quote=(value:string)=>"'"+value.replaceAll("'","''")+"'";
    const command=`chcp 65001 > $null; [Console]::OutputEncoding=[Text.UTF8Encoding]::new($false); & ${quote(shim)} --no-stdin '中文 参数'; exit $LASTEXITCODE`;
    const running=promisify(execFile)(windowsPowerShell(),['-NoLogo','-NoProfile','-NonInteractive','-Command',command],{windowsHide:true,timeout:10000});running.child.stdin?.end();
    await assert.rejects(running,error=>{const result=error as Error&{code:number;stdout:string};assert.equal(result.code,7);assert.deepEqual(JSON.parse(result.stdout).args,['--no-stdin','中文 参数']);return true;});
  }
});

test('相同 Node 的安装入口及两端插件不创建额外父进程，新调用读取当前运行时',async t=>{
  const directory=temporary(t),home=path.join(directory,'home'),entry=path.join(directory,'entry.mjs'),next=path.join(directory,'next.mjs');
  const stub=(revision:string)=>`console.log(JSON.stringify({pid:process.pid,parent:process.ppid,revision:${JSON.stringify(revision)},args:process.argv.slice(2)}));`;
  writeFileSync(entry,stub('first'),'utf8');writeFileSync(next,stub('next'),'utf8');const plan=planShim(home,{entry,pathValue:''});installShim(plan);
  const launch=async(file:string,command='mcp')=>new Promise<any>((resolve,reject)=>{const child=spawn(process.execPath,[file,command,'--host','codex'],{stdio:['ignore','pipe','pipe'],windowsHide:true});let output='',error='';child.stdout!.on('data',chunk=>output+=chunk);child.stderr!.on('data',chunk=>error+=chunk);child.once('error',reject);child.once('close',code=>{try{assert.equal(code,0,error);const result=JSON.parse(output);assert.equal(result.pid,child.pid);assert.equal(result.parent,process.pid);resolve(result);}catch(error){reject(error);}});});
  const launcher=path.join(home,'bin','nxbridge.cjs');assert.equal((await launch(launcher)).revision,'first');
  for(const host of ['codex','claude'])for(const installed of [false,true]){
    const plugin=path.join(directory,host+installed);mkdirSync(plugin);cpSync(path.join(PACKAGE_ROOT,'plugins',host,'bridge.cjs'),path.join(plugin,'bridge.cjs'));
    writeFileSync(path.join(plugin,'runtime.json'),JSON.stringify({node:process.execPath,entry,home,...(installed?{launcher}:{})}),'utf8');assert.equal((await launch(path.join(plugin,'bridge.cjs'))).revision,'first');
  }
  const pointer=path.join(home,'bin','runtime.json'),runtime=JSON.parse(readFileSync(pointer,'utf8'));writeFileSync(pointer,JSON.stringify({...runtime,entry:next}),'utf8');assert.equal((await launch(launcher)).revision,'next');
  for(const command of ['mcp','mod','hook']){
    writeFileSync(path.join(directory,command+'-entry.mjs'),stub(command),'utf8');assert.equal((await launch(launcher,command)).revision,command);
    for(const host of ['codex','claude'])for(const installed of [false,true])assert.equal((await launch(path.join(directory,host+installed,'bridge.cjs'),command)).revision,command);
  }
});

test('插件经安装入口切换 Node 时仍继承首个进程的 hook 预算起点',async t=>{
  const directory=temporary(t),home=path.join(directory,'home'),entry=path.join(directory,'hook-entry.mjs'),alternate=path.join(directory,process.platform==='win32'?'alternate-node.exe':'alternate-node');
  const fs=await import('node:fs');try{fs.linkSync(process.execPath,alternate);}catch{fs.copyFileSync(process.execPath,alternate);}
  writeFileSync(entry,'console.log(JSON.stringify({started:Number(process.env.NXBRIDGE_HOOK_STARTED_AT),current:performance.timeOrigin}));','utf8');
  installShim(planShim(home,{node:alternate,entry,pathValue:''}));const plugin=path.join(directory,'plugin');mkdirSync(plugin);cpSync(path.join(PACKAGE_ROOT,'plugins','codex','bridge.cjs'),path.join(plugin,'bridge.cjs'));
  writeFileSync(path.join(plugin,'runtime.json'),JSON.stringify({node:alternate,entry,home,launcher:path.join(home,'bin','nxbridge.cjs')}),'utf8');
  const env={...process.env};delete env.NXBRIDGE_HOOK_STARTED_AT;
  const result=await promisify(execFile)(process.execPath,[path.join(plugin,'bridge.cjs'),'hook','--host','codex'],{env,windowsHide:true,timeout:10000});const budget=JSON.parse(result.stdout);
  assert.ok(Number.isFinite(budget.started));assert.ok(budget.started<budget.current,'子 Node 必须继承父进程起点，不能重置预算');
});

test('安装入口仅为 Mod/MCP 启用官方编译缓存，尊重禁用与已有目录，切换 Node 仍生效',async t=>{
  const directory=temporary(t),home=path.join(directory,'中文 缓存'),entry=path.join(directory,'entry.mjs'),alternate=path.join(directory,process.platform==='win32'?'cache-node.exe':'cache-node');
  writeFileSync(entry,"import {getCompileCacheDir} from 'node:module';console.log(JSON.stringify({cache:getCompileCacheDir()??null}));",'utf8');
  installShim(planShim(home,{entry,pathValue:''}));const launcher=path.join(home,'bin','nxbridge.cjs');
  const run=async(command:string,extra:NodeJS.ProcessEnv={})=>{
    const env:NodeJS.ProcessEnv={...process.env,NXBRIDGE_HOME:home};delete env.NODE_COMPILE_CACHE;delete env.NODE_DISABLE_COMPILE_CACHE;
    const result=await promisify(execFile)(process.execPath,[launcher,command],{env:{...env,...extra},windowsHide:true,timeout:10000});return JSON.parse(result.stdout).cache as string|null;
  };
  const expected=path.join(home,'run','compile-cache')+path.sep;
  for(const command of ['mod','mcp'])assert.ok((await run(command))?.startsWith(expected));
  assert.equal(await run('hook'),null);assert.equal(await run('mcp',{NODE_DISABLE_COMPILE_CACHE:'1'}),null);
  const custom=path.join(directory,'用户自有缓存');assert.ok((await run('mcp',{NODE_COMPILE_CACHE:custom}))?.startsWith(custom+path.sep));
  const unavailable=path.join(directory,'不能写缓存');mkdirSync(path.join(unavailable,'run'),{recursive:true});writeFileSync(path.join(unavailable,'run','compile-cache'),'普通文件','utf8');
  assert.equal(await run('mcp',{NXBRIDGE_HOME:unavailable}),null,'缓存不可写不能阻止原命令运行');
  const fs=await import('node:fs');try{fs.linkSync(process.execPath,alternate);}catch{fs.copyFileSync(process.execPath,alternate);}
  installShim(planShim(home,{entry,node:alternate,pathValue:''}));assert.ok((await run('mod'))?.startsWith(expected));assert.equal(await run('hook'),null);
});

test('新安装跳过工具专属目录，已有自有入口和显式目录仍可保留',t=>{
  const tmp=temporaryDirectory(homedir());t.after(tmp.cleanup);
  const home=path.join(tmp.directory,'bridge'),cargo=path.join(tmp.directory,'.cargo','bin'),general=path.join(tmp.directory,'bin');
  const choices=[cargo,general].join(path.delimiter),selected=planShim(home,{pathValue:choices});
  assert.equal(selected.directory,general);assert.match(selected.reason,/其他/);assert.equal(existsSync(general),false);
  assert.equal(planShim(home,{pathValue:cargo}).directory,null);
  installShim(planShim(home,{directories:[cargo],pathValue:choices}));
  const update=planShim(home,{pathValue:[general,cargo].join(path.delimiter)});assert.equal(update.directory,cargo);assert.match(update.reason,/保留已有/);
});

test('通用目录、npm 前缀和 Homebrew 的优先次序独立于 PATH 次序',()=>{
  const preferred=preferredBinDirectories("/Users/example1",{npm_config_prefix:"/Users/example1/npm-global",HOMEBREW_PREFIX:'/opt/homebrew'},'darwin');
  assert.deepEqual(preferred.slice(0,3).map(value=>value.directory),["/Users/example1/.local/bin","/Users/example1/bin","/Users/example1/npm-global/bin"]);
  assert.ok(preferred.some(value=>value.directory==='/opt/homebrew/bin'));
  assert.equal(preferredBinDirectories("C:\\Users\\example1",{npm_config_prefix:'C:\\Program Files\\nodejs'},'win32').some(value=>value.directory==='C:\\Program Files\\nodejs'),false);
  for(const value of ['/Users/u/.cargo/bin','/Users/u/.rustup/toolchains/x/bin','/Users/u/.pyenv/shims','/Users/u/.rbenv/shims','/Users/u/.asdf/shims','/Users/u/.nvm/versions/node/v24/bin','/Users/u/go/bin'])assert.equal(toolSpecificBin(value),true);
});
