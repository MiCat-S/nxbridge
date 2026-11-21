import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync,writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {PACKAGE_ROOT} from '../shared/package-location.js';
import { temporary } from './support/temporary.js';

test('许可证清单按实际输出输入统计，保留全文与多版本，跳过摇树后为空的依赖',async t=>{
  const {thirdPartyNotices}=await import(pathToFileURL(path.join(PACKAGE_ROOT,'tools/third-party-notices.mjs')).href),root=temporary(t);
  const dependency=(directory:string,name:string,version:string,license:unknown)=>{const target=path.join(root,directory);mkdirSync(path.join(target,'dist'),{recursive:true});writeFileSync(path.join(target,'package.json'),JSON.stringify({name,version,...(license?{license}:{})}),'utf8');writeFileSync(path.join(target,'LICENSE'),'版权所有 示例\n\n完整授权正文\n','utf8');return directory+'/dist/index.js';};
  const first=dependency('node_modules/@scope/one','@scope/one','1.0.0','MIT'),second=dependency('node_modules/nested/node_modules/@scope/one','@scope/one','2.0.0','GPL-3.0-or-later'),unknown=dependency('node_modules/unknown','unknown','1.2.3',null);
  writeFileSync(path.join(root,'node_modules/@scope/one/dist/package.json'),'{"type":"module"}','utf8');writeFileSync(path.join(root,'node_modules/@scope/one/NOTICE.txt'),'附加归属声明','utf8');
  const result=thirdPartyNotices([{outputs:{'bundle.js':{inputs:{[first]:{bytesInOutput:10},[second]:{bytesInOutput:10},[unknown]:{bytesInOutput:2},'node_modules/absent/index.js':{bytesInOutput:0},'src/main.ts':{bytesInOutput:100}}}}}],root);
  assert.deepEqual(result.packages.map((item:any)=>[item.name,item.version,item.review]),[['@scope/one','1.0.0',false],['@scope/one','2.0.0',true],['unknown','1.2.3',true]]);assert.ok(result.text.includes('完整授权正文'));assert.ok(result.text.includes('附加归属声明'));assert.ok(result.text.includes('UNKNOWN'));assert.ok(!result.text.includes('absent'));
});

test('已打包依赖缺少元数据或许可证全文会阻止发布，不借用根项目许可证',async t=>{
  const {thirdPartyNotices}=await import(pathToFileURL(path.join(PACKAGE_ROOT,'tools/third-party-notices.mjs')).href),root=temporary(t),directory=path.join(root,'node_modules/no-license');mkdirSync(directory,{recursive:true});
  writeFileSync(path.join(root,'package.json'),'{"name":"root","version":"1.0.0","license":"MIT"}','utf8');writeFileSync(path.join(root,'LICENSE'),'根许可证','utf8');
  const input=[{outputs:{'bundle.js':{inputs:{'node_modules/no-license/index.js':{bytesInOutput:10}}}}}];assert.throws(()=>thirdPartyNotices(input,root),/package.json/);
  writeFileSync(path.join(directory,'package.json'),'{"name":"no-license","version":"1.0.0","license":"MIT"}','utf8');assert.throws(()=>thirdPartyNotices(input,root),/缺少许可证全文/);
  writeFileSync(path.join(directory,'LICENSE'),' \n\t','utf8');assert.throws(()=>thirdPartyNotices(input,root),/缺少许可证全文/);
});
