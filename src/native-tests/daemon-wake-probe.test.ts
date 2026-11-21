import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { cpSync,existsSync,mkdirSync,readFileSync,symlinkSync,writeFileSync,realpathSync } from 'node:fs';
import {tmpdir} from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { temporaryDirectory } from '../tests/support/temporary.js';
import {PACKAGE_ROOT} from '../shared/package-location.js';

test('原生 daemon 唤醒协议探针：不订阅、不恢复，仅对隔离线程注入并续跑',{skip:!['linux','darwin'].includes(process.platform),timeout:170000},async t=>{
  const temp=temporaryDirectory(process.platform==='darwin'?realpathSync('/tmp'):tmpdir()),workspace=path.join(temp.directory,'code'),fixture=path.join(temp.directory,'fixture.json');t.after(temp.cleanup);mkdirSync(workspace);
  for(const name of ['dist','plugins','tools','package.json','docs'])cpSync(path.join(PACKAGE_ROOT,name),path.join(workspace,name),{recursive:true});
  symlinkSync(process.env.NXBRIDGE_TEST_NODE_MODULES??path.join(PACKAGE_ROOT,'node_modules'),path.join(workspace,'node_modules'),'dir');
  writeFileSync(fixture,JSON.stringify({workspace,directory:temp.directory,wakeProbeOnly:true}),'utf8');
  let failure:unknown;
  try{await promisify(execFile)(process.execPath,[path.join(workspace,'tools/test-codex-daemon.mjs'),fixture],{windowsHide:true,timeout:160000,maxBuffer:200000});}catch(error){failure=error;}
  const stages=path.join(temp.directory,'stages.jsonl');if(existsSync(stages))t.diagnostic(readFileSync(stages,'utf8'));
  const file=path.join(temp.directory,'result.json'),result=existsSync(file)?JSON.parse(readFileSync(file,'utf8')):undefined;
  assert.equal(failure,undefined,JSON.stringify({error:result?.error,failure:String(failure)}));
  assert.equal(result?.wakeProbe?.injected,true,JSON.stringify(result?.wakeProbe));
  assert.equal(result?.wakeProbe?.tuiRendered,true,JSON.stringify(result?.wakeProbe));
  assert.equal(result?.wakeProbe?.persistentReceipt,true,JSON.stringify(result?.wakeProbe));
  assert.equal(result?.wakeProbe?.afterTuiClosed?.type,'notLoaded',JSON.stringify(result?.wakeProbe));
  assert.equal(result?.wakeProbe?.error,undefined,JSON.stringify(result?.wakeProbe));
});
