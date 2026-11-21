import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {PACKAGE_ROOT} from '../shared/package-location.js';
import { temporaryDirectory } from '../tests/support/temporary.js';

test('Linux 官方 Claude 托管后端：回环模型、归属、审批接管与同会话恢复',{skip:process.platform!=='linux',timeout:180000},async t=>{
  const temp=temporaryDirectory();
  try{
    const {stdout}=await promisify(execFile)(process.execPath,[path.join(PACKAGE_ROOT,'tools','test-claude-child.mjs'),temp.directory,path.join(PACKAGE_ROOT,'publish','nxbridge.mjs')],{timeout:170000,maxBuffer:8*1024*1024});
    const report=JSON.parse(stdout);assert.equal(report.passed,true);assert.equal(report.paidCalls,0);assert.ok(report.steps.length>=9);
  }catch(error){
    try{const report=JSON.parse((error as {stdout?:string}).stdout??'');t.diagnostic(JSON.stringify({error:report.error,cleanupError:report.cleanupError,processCleanup:report.processCleanup,shutdownError:report.shutdownError,steps:report.steps,source:report.diagnostics?.filter((event:any)=>event.type==='mod.question_source'),modDiagnostic:report.modDiagnostic,nativeInit:report.nativeInit,toolResults:report.toolResults,nativeDebug:report.nativeDebug,nativeErrors:report.nativeErrors,diagnosticError:report.diagnosticError}));}catch{}
    throw error;
  }finally{await temp.cleanup();}
});
