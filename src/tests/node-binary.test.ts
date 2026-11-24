import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { lstatSync, realpathSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import { copyNodeBinary } from './support/node-binary.js';
import { temporary } from './support/temporary.js';

test('复制的 Node 保留独立映像路径，并能在同目录重复准备多个可执行文件',async t=>{
  const directory=temporary(t);
  for(const name of ['claude','codex','claude']){
    const binary=path.join(directory,name+(process.platform==='win32'?'.exe':''));
    copyNodeBinary(binary);
    assert.equal(lstatSync(binary).isSymbolicLink(),false);
    const {stdout}=await promisify(execFile)(binary,['-p','JSON.stringify({version:process.version,executable:process.execPath})'],{windowsHide:true,timeout:10000});
    assert.deepEqual(JSON.parse(stdout),{version:process.version,executable:realpathSync(binary)});
    unlinkSync(binary);
  }
});
