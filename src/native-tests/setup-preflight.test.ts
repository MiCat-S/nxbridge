import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import {PACKAGE_ROOT} from '../shared/package-location.js';
import {resolveCli} from '../process/host-command.js';
import { ownsFile } from '../install/installation.js';
import { temporaryDirectory } from '../tests/support/temporary.js';

test('真实宿主连续三轮 dry-run：相同必需预检、版本与目录理由可见，配置不写入',async()=>{
  const temp=temporaryDirectory(),home=path.join(temp.directory,'bridge'),bin=path.join(temp.directory,'bin');
  const codex=path.join(temp.directory,'codex'),claude=path.join(temp.directory,'claude');
  try{
    for(const directory of [bin,codex,claude])mkdirSync(directory);
    const config='# 保留用户原字节\r\nmodel_verbosity = "low"\r\n',settings='{"env":{}}\n';
    writeFileSync(path.join(codex,'config.toml'),config,'utf8');writeFileSync(path.join(claude,'settings.json'),settings,'utf8');
    const hosts={codex:resolveCli('codex',process.env.NXBRIDGE_TEST_CODEX_BINARY),claude:resolveCli('claude')};
    const directories=(process.env.PATH??'').split(path.delimiter).filter(directory=>!['nxbridge','nxbridge.cmd','nxbridge.ps1','nxbridge.cjs','nxbridge.exe'].some(name=>{const file=path.join(directory,name);return existsSync(file)&&!ownsFile(file,home);}));
    const env={...process.env,NXBRIDGE_HOME:home,CODEX_HOME:codex,CLAUDE_CONFIG_DIR:claude,PATH:[bin,...directories].join(path.delimiter)};
    const args=['setup','--dry-run','--bin-dir',bin,'--codex-home',codex,'--claude-home',claude,...(['codex','claude'] as const).flatMap(host=>['--'+host+'-command',hosts[host].command,...hosts[host].prefix.flatMap(arg=>['--'+host+'-command-arg',arg])])];
    for(let attempt=0;attempt<3;attempt++){
                                                  
      const probeEnv:NodeJS.ProcessEnv={...env};if(attempt===2){delete probeEnv.NXBRIDGE_TEST_SCOPE;probeEnv.NXBRIDGE_PROCESS_REGISTRY=path.join(temp.directory,'normal-processes');}
      const {stdout}=await promisify(execFile)(process.execPath,[path.join(PACKAGE_ROOT,'publish','nxbridge.mjs'),...args],{cwd:temp.directory,env:probeEnv,windowsHide:true,timeout:45000,maxBuffer:2*1024*1024});
      const preview=JSON.parse(stdout);
      assert.equal(preview.dryRun,true);assert.equal(preview.preflight.requiredCapabilities.passed,true);assert.equal(preview.bin.directory,bin);assert.ok(preview.bin.reason);
      for(const host of ['codex','claude']){assert.ok(preview.preflight.compatibility.hosts[host].version);assert.ok(preview.preflight.compatibility.hosts[host].testedVersions.length);}
      assert.equal(existsSync(home),false,'dry-run 遗留私有目录：'+JSON.stringify(existsSync(home)?readdirSync(home,{recursive:true}):[]));assert.equal(readFileSync(path.join(codex,'config.toml'),'utf8'),config);assert.equal(readFileSync(path.join(claude,'settings.json'),'utf8'),settings);
    }
  }finally{await temp.cleanup();}
});
