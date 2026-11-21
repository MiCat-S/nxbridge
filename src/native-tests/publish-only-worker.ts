                                               
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
const execute=promisify(execFile),fixture=JSON.parse(readFileSync(process.argv[2]!,'utf8'));
const {directory,home,bin,codexHome,claudeHome,publish,codex,claude,version}=fixture;
if(fixture.processRegistry){
  process.env.NXBRIDGE_PROCESS_REGISTRY=fixture.processRegistry;
  const roots=path.join(fixture.processRegistry,'test-roots');mkdirSync(roots,{recursive:true});
  writeFileSync(path.join(roots,'fixture.json'),JSON.stringify({scope:process.env.NXBRIDGE_TEST_SCOPE,directory,createdAt:Date.now()}),'utf8');
}
const env={...process.env,NXBRIDGE_HOME:home,CODEX_HOME:codexHome,CLAUDE_CONFIG_DIR:claudeHome,PATH:[bin,...fixture.path].join(path.delimiter),NODE_PATH:'',DISABLE_AUTOUPDATER:'1',DISABLE_TELEMETRY:'1',CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC:'1'};
const result:any={steps:[]},output=path.join(directory,'result.json');
const run=async(entry:string,args:string[])=>{const response=await execute(process.execPath,['--no-warnings',entry,...args],{cwd:directory,env,windowsHide:true,timeout:80000,maxBuffer:8*1024*1024});return response.stdout;};
const json=async(entry:string,args:string[])=>JSON.parse(await run(entry,args));
const launcher=path.join(home,'bin','nxbridge.cjs');
let installed=false;
try{
  if(process.platform==='win32'){
    const groups=(await execute(path.join(process.env.SystemRoot!,'System32','whoami.exe'),['/groups','/fo','csv','/nh'],{windowsHide:true})).stdout;
    result.integrity=groups.match(/S-1-16-\d+/)?.[0];assert.equal(result.integrity,'S-1-16-8192','必须以真正的中完整性非提权令牌验收');
  }
  for(const dir of [codexHome,claudeHome])mkdirSync(dir,{recursive:true});
  const original='# 独立安装保留用户设置\r\nmodel_verbosity = "low"\r\n';writeFileSync(path.join(codexHome,'config.toml'),original,'utf8');
  assert.equal(existsSync(home),false,'陌生用户安装前没有 nxbridge 配置或安装记录');assert.equal(existsSync(bin),false,'用户 PATH 目标尚未创建');
  const source=path.join(publish,'nxbridge.mjs'),args=['setup','--bin-dir',bin,'--codex-command',codex.command,...codex.prefix.flatMap((arg:string)=>['--codex-command-arg',arg]),'--claude-command',claude.command,...claude.prefix.flatMap((arg:string)=>['--claude-command-arg',arg]),'--codex-home',codexHome,'--claude-home',claudeHome];
  const setup=await json(source,args);assert.equal(setup.installed,true);installed=true;result.steps.push('fresh-setup');
  const state=JSON.parse(readFileSync(path.join(home,'setup-state.json'),'utf8'));assert.ok(state.managedFiles.some((file:any)=>file.file===path.join(bin,process.platform==='win32'?'nxbridge.cmd':'nxbridge')));assert.ok(state.managedFiles.every((file:any)=>file.file.startsWith(home+path.sep)||file.file.startsWith(bin+path.sep)));
  if(process.platform==='win32'){
    const shell=path.join(process.env.SystemRoot!,'System32','WindowsPowerShell','v1.0','powershell.exe'),script='chcp 65001 > $null; $OutputEncoding=[Text.UTF8Encoding]::new($false); [Console]::OutputEncoding=$OutputEncoding; (Get-Command nxbridge).Source; nxbridge --version; exit $LASTEXITCODE';
    const command=await execute(shell,['-NoLogo','-NoProfile','-NonInteractive','-Command',script],{cwd:directory,env,windowsHide:true,timeout:15000});assert.ok(command.stdout.includes(path.join(bin,'nxbridge.cmd')));assert.ok(command.stdout.split(/\r?\n/).includes('nxbridge '+version));result.steps.push('bare-command-from-user-path');
  }
  assert.match(readFileSync(path.join(codexHome,'config.toml'),'utf8'),/独立安装保留用户设置/);
                              
  renameSync(publish,publish+'.removed');assert.equal((await run(launcher,['--version'])).trim(),'nxbridge '+version);result.steps.push('version-without-source');
  const updated=await json(launcher,['update','--bin-dir',bin]);assert.equal(updated.installed,true);assert.ok(updated.notes.some((note:string)=>note.includes('修复')));result.steps.push('update-without-source');
  const doctor=await json(launcher,['doctor']);assert.equal(doctor.elevated,false);assert.equal(doctor.runtime.independent,true);assert.deepEqual(doctor.runtime.drift,[]);assert.deepEqual(doctor.codexCapabilities.errors,{});assert.ok(doctor.codexCapabilities.mcp.some((server:any)=>server.tools.includes('config')));result.steps.push('doctor-without-source');
  const removed=await json(launcher,['uninstall']);assert.equal(removed.removed,true,JSON.stringify(removed));installed=false;result.steps.push('uninstall-without-source');assert.equal(existsSync(path.join(bin,process.platform==='win32'?'nxbridge.cmd':'nxbridge')),false);assert.match(readFileSync(path.join(codexHome,'config.toml'),'utf8'),/独立安装保留用户设置/);assert.equal(existsSync(path.join(home,'config.managed.toml')),true);
  result.passed=true;
}catch(error){
  result.passed=false;result.error=error instanceof Error?error.stack:String(error);
  const failure=error as {code?:string|number;signal?:string;killed?:boolean;stdout?:string;stderr?:string};
  result.commandFailure={code:failure?.code,signal:failure?.signal,killed:failure?.killed,stdout:failure?.stdout?.slice(-12000),stderr:failure?.stderr?.slice(-12000)};process.exitCode=1;
}
finally{if(installed)try{result.cleanup=await json(launcher,['uninstall']);}catch(error){result.cleanupError=String(error);}writeFileSync(output,JSON.stringify(result,null,2),'utf8');}
