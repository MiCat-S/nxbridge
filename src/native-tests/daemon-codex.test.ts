import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { readFileSync, writeFileSync, existsSync, cpSync, mkdirSync, symlinkSync, realpathSync } from 'node:fs';
import {tmpdir} from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { temporaryDirectory } from '../tests/support/temporary.js';
import {PACKAGE_ROOT} from '../shared/package-location.js';

test('原生共享 daemon：按线程登记、取件、fork/new 生命周期、跨项目和重连',{skip:!['linux','darwin'].includes(process.platform),timeout:170000},async t=>{
                                                               
  const temp=temporaryDirectory(process.platform==='darwin'?realpathSync('/tmp'):tmpdir()),workspace=path.join(temp.directory,'code'),fixture=path.join(temp.directory,'fixture.json');
  t.after(temp.cleanup);mkdirSync(workspace);
  for(const name of ['dist','plugins','tools','package.json','docs'])cpSync(path.join(PACKAGE_ROOT,name),path.join(workspace,name),{recursive:true});
  symlinkSync(process.env.NXBRIDGE_TEST_NODE_MODULES??path.join(PACKAGE_ROOT,'node_modules'),path.join(workspace,'node_modules'),'dir');
                                        
  const daemonFile=path.join(workspace,'dist','hosts','codex','codex-daemon.js'),daemon=readFileSync(daemonFile,'utf8'),signature='async registration(configHome, runtime, sessionId, contextStart = false) {';
  assert.ok(daemon.includes(signature));writeFileSync(daemonFile,daemon.replace(signature,signature+"\n        if(contextStart&&!this.fixtureRegistrationDelayed){this.fixtureRegistrationDelayed=true;await new Promise(resolve=>setTimeout(resolve,2100));}"),'utf8');
  writeFileSync(fixture,JSON.stringify({workspace,directory:temp.directory}),'utf8');
  let failure:unknown;
  try{await promisify(execFile)(process.execPath,[path.join(workspace,'tools/test-codex-daemon.mjs'),fixture],{windowsHide:true,timeout:165000,maxBuffer:200000});}catch(error){failure=error;}
  const log=path.join(temp.directory,'stages.jsonl');if(existsSync(log))t.diagnostic(readFileSync(log,'utf8'));
  const resultFile=path.join(temp.directory,'result.json'),result=existsSync(resultFile)?JSON.parse(readFileSync(resultFile,'utf8')):undefined;
  assert.equal(failure,undefined,JSON.stringify({error:result?.error,failure:String(failure)}));
  assert.equal(result?.daemonReproduced,true);assert.equal(result?.realModelCalls,0);
});
