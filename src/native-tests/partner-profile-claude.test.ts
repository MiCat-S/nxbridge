import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {PACKAGE_ROOT} from '../shared/package-location.js';
import { temporaryDirectory } from '../tests/support/temporary.js';

test('Linux 真实 Claude：双字段控制、同会话冷恢复、忙碌延后及用户默认值不变',{skip:process.platform!=='linux',timeout:170000},async t=>{
  const temp=temporaryDirectory();
  try{
    const {stdout}=await promisify(execFile)(process.execPath,[path.join(PACKAGE_ROOT,'tools','test-claude-child.mjs'),temp.directory,path.join(PACKAGE_ROOT,'publish','nxbridge.mjs'),'--profile-only'],{timeout:160000,maxBuffer:8*1024*1024});
    const report=JSON.parse(stdout);assert.equal(report.passed,true);assert.equal(report.paidCalls,0);assert.ok(report.steps.length>=5);t.diagnostic(JSON.stringify({steps:report.steps,requests:report.requests,sessionId:report.sessionId}));
  }catch(error){try{const report=JSON.parse((error as {stdout?:string}).stdout??'');t.diagnostic(JSON.stringify({error:report.error,cleanupError:report.cleanupError,steps:report.steps,nativeEffortEvidence:report.nativeEffortEvidence,brokerLog:report.brokerLog,nativeErrors:report.nativeErrors,nativeDebug:report.nativeDebug}));}catch{}throw error;}
  finally{await temp.cleanup();}
});
