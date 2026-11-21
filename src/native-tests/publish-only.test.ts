import test from 'node:test';
import { VERSION } from '../version.js';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { cpSync, existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {PACKAGE_ROOT} from '../shared/package-location.js';
import {resolveCli} from '../process/host-command.js';
import {windowsPowerShell} from '../shared/windows-tools.js';
import { ownsFile } from '../install/installation.js';
import { temporaryDirectory } from '../tests/support/temporary.js';
import { writeFileSync } from 'node:fs';
import { registerTestDirectory } from '../process/test-processes.js';
const execute=promisify(execFile);
test('仅 publish 的陌生用户安装：非提权、缺失用户 PATH 目录、移走来源后的更新诊断卸载',async t=>{
  const temp=temporaryDirectory(),directory=temp.directory,home=path.join(directory,'bridge'),bin=path.join(directory,'user-bin'),publish=path.join(directory,'delivery');t.after(temp.cleanup);
  const processRegistry=path.join(directory,'normal-user-processes');registerTestDirectory(directory,processRegistry);
  cpSync(path.join(PACKAGE_ROOT,'publish'),publish,{recursive:true});
  const worker=path.join(directory,'worker.mjs');cpSync(fileURLToPath(new URL('./publish-only-worker.js',import.meta.url)),worker);
  const fixtureFile=path.join(directory,'fixture.json'),fixture={directory,home,bin,publish,codexHome:path.join(directory,'codex'),claudeHome:path.join(directory,'claude'),codex:resolveCli('codex',process.env.NXBRIDGE_TEST_CODEX_BINARY),claude:resolveCli('claude'),path:(process.env.PATH??'').split(path.delimiter).filter(dir=>!['nxbridge','nxbridge.cmd','nxbridge.ps1','nxbridge.cjs','nxbridge.exe'].some(name=>existsSync(path.join(dir,name))&&!ownsFile(path.join(dir,name),home)))};
  writeFileSync(fixtureFile,JSON.stringify({...fixture,processRegistry,version:VERSION}),'utf8');
  let failure;try{
    if(process.platform==='win32')await execute(windowsPowerShell(),['-NoLogo','-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',path.join(PACKAGE_ROOT,'tools/test-normal-user.ps1'),'-Node',process.execPath,'-Worker',worker,'-Fixture',fixtureFile],{cwd:directory,windowsHide:true,timeout:180000,maxBuffer:8*1024*1024});
    else await execute(process.execPath,[worker,fixtureFile],{cwd:directory,windowsHide:true,timeout:180000,maxBuffer:8*1024*1024});
  }catch(error){failure=error;}
  const resultFile=path.join(directory,'result.json'),result=existsSync(resultFile)?JSON.parse(readFileSync(resultFile,'utf8')):{error:String(failure)};assert.equal(result.passed,true,JSON.stringify(result,null,2));t.diagnostic(JSON.stringify(result));
});
