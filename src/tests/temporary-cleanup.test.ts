import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import path from 'node:path';
import { temporaryDirectory } from './support/temporary.js';

test('Windows 夹具遍历后文件被并发移除时仍清理其余只读项',{skip:process.platform!=='win32'},async t=>{
  const temp=temporaryDirectory();t.after(()=>temp.cleanup());
  const vanishing=path.join(temp.directory,'短暂文件'),readonly=path.join(temp.directory,'只读文件');
  fs.writeFileSync(vanishing,'并发移除','utf8');fs.writeFileSync(readonly,'保留清理','utf8');fs.chmodSync(readonly,0o444);
  let removed=false;const original=fs.chmodSync;
  t.mock.method(fs,'chmodSync',(file:fs.PathLike,mode:fs.Mode)=>{
    if(file===vanishing&&!removed){removed=true;fs.unlinkSync(vanishing);}
    return original(file,mode);
  });
  syncBuiltinESMExports();
  try{
    await temp.cleanup();assert.equal(removed,true);assert.equal(fs.existsSync(temp.directory),false);
  }finally{t.mock.restoreAll();syncBuiltinESMExports();}
});
