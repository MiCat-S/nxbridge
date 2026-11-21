                                                 
import {spawn,execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {globSync,mkdtempSync,mkdirSync,realpathSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';
const workspace=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
                                    
process.env.DISABLE_AUTOUPDATER='1';
const args=process.argv.length>2?process.argv.slice(2):['--test','--test-timeout=30000','dist/tests/**/*.test.js'];
const files=args.filter(value=>value.endsWith('.test.js')).flatMap(value=>/[*?{]/.test(value)?[...globSync(value,{cwd:workspace})].sort():[value]);
const batchSize=args.includes('--test-concurrency=1')?1:6;
if(files.length>batchSize){
                                             
  const flags=args.filter(value=>!value.endsWith('.test.js'));let code=0,active,interrupted=false;
  const interrupt=()=>{interrupted=true;active?.kill('SIGTERM');};for(const signal of ['SIGINT','SIGTERM'])process.on(signal,interrupt);
  for(let offset=0;offset<files.length&&!interrupted;offset+=batchSize){
    console.log(JSON.stringify({testBatch:{index:Math.floor(offset/batchSize)+1,total:Math.ceil(files.length/batchSize),files:files.slice(offset,offset+batchSize)}}));
    active=spawn(process.execPath,[fileURLToPath(import.meta.url),...flags,...files.slice(offset,offset+batchSize)],{cwd:workspace,env:process.env,windowsHide:true,stdio:'inherit'});
    const status=await new Promise(resolve=>{active.once('error',()=>resolve(1));active.once('exit',value=>resolve(value??1));});if(status)code=status;
  }
  process.exit(interrupted?130:code);
}
const parent=realpathSync(tmpdir()),registry=mkdtempSync(path.join(parent,'nxbridge-test-processes-')),scope=randomUUID();
process.env.NXBRIDGE_TEST_PROTECTED_HOMES??=JSON.stringify([...new Set([process.env.NXBRIDGE_HOME,path.join((await import('node:os')).homedir(),'.nxbridge')].filter(Boolean).map(value=>path.resolve(value)))]);
process.env.NXBRIDGE_PROCESS_REGISTRY=registry;process.env.NXBRIDGE_TEST_SCOPE=scope;
                                         
const scopeHome=path.join(registry,'runner');mkdirSync(scopeHome);
for(const [key,name]of [['NXBRIDGE_HOME','bridge'],['CODEX_HOME','codex'],['CLAUDE_CONFIG_DIR','claude']]){
  process.env[key]=path.join(scopeHome,name);mkdirSync(process.env[key]);
}
writeFileSync(path.join(process.env.NXBRIDGE_HOME,'config.json'),JSON.stringify({codexHome:process.env.CODEX_HOME,claudeHome:process.env.CLAUDE_CONFIG_DIR}),'utf8');
const {processIdentity}=await import('../dist/process/process.js');
const {recordOwnedProcess,rememberOwnedChild,releaseOwnedProcess}=await import('../dist/process/owned-processes.js');
const {assignGatedWindowsJob,windowsHookIdentityHelper}=await import('../dist/process/windows/windows-hook-identity.js');
const {windowsPowerShell}=await import('../dist/shared/windows-tools.js');
const {spawnPosixSupervisor,posixSupervisorExit}=await import('../dist/process/posix/posix-supervisor.js');
const {cleanupTestProcesses,registerTestDirectory}=await import('../dist/process/test-processes.js');
const {ownedProcessState,stopOwnedProcess}=await import('../dist/process/process-stop.js');
const {atomicJson}=await import('../dist/shared/files.js');
registerTestDirectory(registry);
const gate=path.join(scopeHome,'start.json');
const launch=process.platform==='win32'?spawn:spawnPosixSupervisor;
const child=launch(process.execPath,['--import',new URL('./test-process-gate.mjs',import.meta.url).href,...args],{cwd:workspace,env:{...process.env,NXBRIDGE_TEST_START_GATE:gate},windowsHide:true,stdio:'inherit'});
const ended=new Promise(resolve=>{child.once('error',error=>resolve({code:1,error:String(error)}));child.once('close',(code,signal)=>{const native=posixSupervisorExit(child);resolve({code:native?.code??code??1,signal:native?.signal??signal});});});
let root,rootRecord,watchdog,interrupted=false,trackingErrors=[];
const interrupt=()=>{if(interrupted)return;interrupted=true;if(child.exitCode===null&&child.signalCode===null)child.kill('SIGTERM');};
for(const signal of ['SIGINT','SIGTERM'])process.on(signal,interrupt);
let result;
try{
  const timeout=Number(process.env.NXBRIDGE_TEST_SESSION_TIMEOUT_MS??180000);
  if(!Number.isSafeInteger(timeout)||timeout<100||timeout>180000)throw Error('测试会话上限必须为 100～180000 毫秒');
  const deadline=performance.now()+timeout;
  const expired=new Promise(resolve=>{watchdog=setTimeout(()=>{interrupt();resolve({code:124,error:'测试会话超时'});},timeout);});
  if(process.platform==='win32'){
                                                    
    const budget=()=>{const remaining=Math.floor(deadline-performance.now());if(remaining<=0)throw Error('测试会话超时');return Math.min(30000,remaining);};
    await windowsHookIdentityHelper(undefined,budget());
    await promisify(execFile)(windowsPowerShell(),['-NoLogo','-NoProfile','-NonInteractive','-Command',"$null=[Microsoft.Win32.Registry]::CurrentUser.Name;$null=(@{}|ConvertTo-Json -Compress)"],{windowsHide:true,timeout:budget()});
  }
  if(child.pid){
    root=await processIdentity(child.pid);
    if(process.platform==='win32'){const job=await assignGatedWindowsJob(root,path.join(scopeHome,'container.done'));rootRecord=await recordOwnedProcess(scopeHome,{role:'host-control',identity:root,parent:await processIdentity(process.pid),proof:{kind:'spawn',launchId:scope},windowsJob:job.name,windowsHolder:job.holder,completionFile:job.completionFile});}
    else rootRecord=await rememberOwnedChild(scopeHome,child,'host-control',{posixGroup:true},scope);
  }
  atomicJson(gate,{scope});
  result=await Promise.race([ended,expired]);
}catch(error){result={code:1,error:error?.stack??String(error)};
}finally{
  clearTimeout(watchdog);
                                            
  if(rootRecord)try{await releaseOwnedProcess(rootRecord);}catch(error){trackingErrors.push(String(error));}
  else if(child.exitCode===null&&child.signalCode===null){if(root)try{await stopOwnedProcess(root,{force:true});}catch(error){trackingErrors.push(String(error));}else child.kill();}
  const cleanup=await cleanupTestProcesses();
  console.log(JSON.stringify({testProcessCleanup:{scope,trackedPids:[...new Set(cleanup.pids)],processes:cleanup.processes,notes:cleanup.notes,diagnostics:cleanup.diagnostics,trackingErrors}}));
  if(cleanup.notes.length||trackingErrors.length){process.exitCode=1;console.error('测试进程清理尚未完成，证据保留：'+registry);}
  else{
    if(realpathSync(registry)!==registry||path.dirname(registry)!==parent)throw Error('测试归属目录越界，未清理');
    rmSync(registry,{recursive:true,force:true,maxRetries:6,retryDelay:200});
  }
}
if(result?.error)console.error(result.error);
process.exitCode=process.exitCode||result?.code||0;
