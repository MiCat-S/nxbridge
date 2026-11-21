import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {chmodSync,existsSync,mkdirSync,readFileSync,statSync,symlinkSync,writeFileSync} from 'node:fs';
import { temporary, temporaryDirectory } from './support/temporary.js';

test('Windows 夹具清理支持只读 Git 长路径，目录联接之外的文件保持原样',{skip:process.platform!=='win32'},async t=>{
  const outside=temporary(t),sentinel=path.join(outside,'sentinel');writeFileSync(sentinel,'外部文件','utf8');chmodSync(sentinel,0o444);
  const temp=temporaryDirectory();t.after(temp.cleanup);
  const nested=path.join(temp.directory,'codex','.tmp','plugins-clone','.git','objects','pack','long-segment-'.repeat(18));mkdirSync(nested,{recursive:true});
  const pack=path.join(nested,'sample.pack');writeFileSync(pack,'隔离只读 pack','utf8');chmodSync(pack,0o444);
  symlinkSync(outside,path.join(temp.directory,'outside-link'),'junction');
  await temp.cleanup();assert.equal(existsSync(temp.directory),false);
  assert.equal(readFileSync(sentinel,'utf8'),'外部文件');assert.equal(statSync(sentinel).mode&0o200,0);
});
