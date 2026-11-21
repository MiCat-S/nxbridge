import { overrideEnvironment } from '../tests/support/environment.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { temporaryDirectory } from '../tests/support/temporary.js';
import {DEFAULT_CONFIG} from '../config/defaults.js';
import { configClient } from '../hosts/codex/stdio-codex.js';
import { readCodexHookTrust } from '../hosts/codex/codex-hook-trust.js';
import { setupPublish, uninstallPublish } from './publish-fixture.js';

test('原生磁盘 hooks 信任核验区分人工批准前后，诊断全过程不修改配置',{timeout:170000},async t=>{
  const temp=temporaryDirectory(),home=path.join(temp.directory,'bridge'),codexHome=path.join(temp.directory,'codex'),claudeHome=path.join(temp.directory,'claude');
  for(const dir of [home,codexHome,claudeHome])mkdirSync(dir,{recursive:true});
  const config={...DEFAULT_CONFIG,codexHome,claudeHome,...(process.env.NXBRIDGE_TEST_CODEX_BINARY?{codexBinary:process.env.NXBRIDGE_TEST_CODEX_BINARY}:{})};
  writeFileSync(path.join(home,'config.json'),JSON.stringify(config),'utf8');
  const overrides={NXBRIDGE_HOME:home,CODEX_HOME:codexHome,CLAUDE_CONFIG_DIR:claudeHome},restoreEnvironment=overrideEnvironment(overrides);
  t.after(async()=>{try{await uninstallPublish();}finally{restoreEnvironment();await temp.cleanup();}});
  await setupPublish();const file=path.join(codexHome,'config.toml');
  const check=async(expected:'required'|'trusted')=>{const before=readFileSync(file);assert.equal(await readCodexHookTrust(config,home,codexHome,temp.directory),expected);assert.deepEqual(readFileSync(file),before,'诊断不得修改人工信任记录或其他配置');};
  await check('required');
  const client=await configClient(config,home);let hooks:any[];
  try{
    hooks=(await client.request('hooks/list',{cwds:[temp.directory]})).data.flatMap((row:any)=>row.hooks??[]).filter((hook:any)=>hook.pluginId==='nxbridge@nxbridge-local');assert.equal(hooks.length,9);
                                              
    await client.request('config/batchWrite',{edits:[{keyPath:'hooks.state',value:Object.fromEntries(hooks.map(hook=>[hook.key,{enabled:true,trusted_hash:hook.currentHash}])),mergeStrategy:'replace'}],filePath:file},{mutation:true});
  }finally{await client.close();}
  await check('trusted');
  const changed=await configClient(config,home);
  try{await changed.request('config/batchWrite',{edits:[{keyPath:'hooks.state',value:{[hooks![0]!.key]:{enabled:true,trusted_hash:'sha256:obsolete'}},mergeStrategy:'replace'}],filePath:file},{mutation:true});}finally{await changed.close();}
  await check('required');t.diagnostic(JSON.stringify({nativeHooks:hooks!.length,untrusted:true,trusted:true,mismatched:true,readOnlyChecks:3,realModelCalls:0}));
});
