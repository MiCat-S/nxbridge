import test from 'node:test';
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {CLI_PATH} from '../shared/package-location.js';
const run=promisify(execFile);
test('普通 CLI 隐藏 SQLite 实验提示，其他 Node 警告仍正常显示',async()=>{
  const version=await run(process.execPath,[CLI_PATH,'--version'],{windowsHide:true});assert.match(version.stdout,/nxbridge/);assert.equal(version.stderr,'');
  const module=new URL('../sqlite-warning.js',import.meta.url).href,other=await run(process.execPath,['--input-type=module','-e',`await import(${JSON.stringify(module)});process.emitWarning('必须保留的提示','ExperimentalWarning');`],{windowsHide:true});assert.match(other.stderr,/必须保留的提示/);
});
