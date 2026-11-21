import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdirSync, writeFileSync, symlinkSync, realpathSync, rmSync } from 'node:fs';
import { temporary } from './support/temporary.js';
import { codexPackageEnvironment } from '../hosts/codex/codex-package.js';
import { selectHostLaunch } from '../hosts/host-launch.js';
import {DEFAULT_CONFIG} from '../config/defaults.js';

function file(name:string,value=''){mkdirSync(path.dirname(name),{recursive:true});writeFileSync(name,value,'utf8');return name;}
function fixture(directory:string,triple='x86_64-unknown-linux-musl',platform='linux-x64',hoisted=false){
  const root=path.join(directory,'node_modules/@openai/codex'),script=file(path.join(root,'bin/codex.js'));
  file(path.join(root,'package.json'),JSON.stringify({name:'@openai/codex'}));
  const dependency=path.join(hoisted?directory:root,'node_modules/@openai/codex-'+platform);file(path.join(dependency,'package.json'),JSON.stringify({name:'@openai/codex-'+platform}));
  const binary=file(path.join(dependency,'vendor',triple,'bin',platform.startsWith('win32')?'codex.exe':'codex'));
  return{root:realpathSync.native(root),script,binary};
}
const inherited={CODEX_MANAGED_PACKAGE_ROOT:'旧包',CODEX_MANAGED_BY_NPM:'1',CODEX_MANAGED_BY_BUN:'1',CODEX_MANAGED_BY_PNPM:'1',CODEX_MANAGED_BY_VITE_PLUS:'1',USER_TOKEN:'保留的凭据'};
const flags=(env:NodeJS.ProcessEnv)=>Object.keys(env).filter(key=>key.startsWith('CODEX_MANAGED_BY_'));

test('包内原生入口在 Windows、Linux、macOS 双架构及提升依赖布局中保留官方安装渠道',t=>{
  const directory=temporary(t);
  for(const [triple,platform]of [['x86_64-pc-windows-msvc','win32-x64'],['aarch64-pc-windows-msvc','win32-arm64'],['x86_64-unknown-linux-musl','linux-x64'],['aarch64-unknown-linux-musl','linux-arm64'],['x86_64-apple-darwin','darwin-x64'],['aarch64-apple-darwin','darwin-arm64']]){
    const f=fixture(path.join(directory,platform!),triple,platform,platform!.endsWith('arm64'));
    for(const executable of [{command:f.binary,prefix:['input.js']},{command:process.execPath,prefix:[f.script]}]){
      const env=codexPackageEnvironment(executable,inherited);assert.equal(env.CODEX_MANAGED_PACKAGE_ROOT,f.root);assert.deepEqual(flags(env),['CODEX_MANAGED_BY_NPM']);assert.equal(env.CODEX_MANAGED_BY_NPM,'1');assert.equal(env.USER_TOKEN,inherited.USER_TOKEN);
    }
  }
  assert.equal(inherited.CODEX_MANAGED_BY_BUN,'1','不修改调用方环境');
});

test('pnpm、Vite+ 的真实安装归属优先于 bun 提示，符号链接不改变包根目录',t=>{
  const directory=temporary(t),f=fixture(path.join(directory,'pnpm'));
  file(path.join(directory,'pnpm/node_modules/.modules.yaml'));
  assert.equal(codexPackageEnvironment({command:f.binary,prefix:[]},{npm_config_user_agent:'bun/1.3'}).CODEX_MANAGED_BY_PNPM,'1');
  const link=path.join(directory,'linked-package');symlinkSync(f.root,link,process.platform==='win32'?'junction':'dir');
  assert.equal(codexPackageEnvironment({command:process.execPath,prefix:[path.join(link,'bin/codex.js')]},{}).CODEX_MANAGED_PACKAGE_ROOT,f.root);
  for(const id of ['', '#old', 'current']){
    const packages=path.join(directory,'vite'+(id||'legacy'),'packages'),install=id.startsWith('#')?path.join(packages,'@openai','codex'+id):path.join(packages,'@openai','codex',id),v=fixture(path.join(install,'lib'));
    file(path.join(packages,'@openai','codex.json'),JSON.stringify({name:'@openai/codex',installId:id}));
    assert.equal(codexPackageEnvironment({command:v.binary,prefix:[]},{npm_config_user_agent:'bun/1.3'}).CODEX_MANAGED_BY_VITE_PLUS,'1');
  }
});

test('bun 检测沿用官方环境与全局目录规则，独立程序和不相关的相邻包不继承渠道标记',t=>{
  const directory=temporary(t),f=fixture(path.join(directory,'.bun/install/global'));
  assert.equal(codexPackageEnvironment({command:f.binary,prefix:[]},{}).CODEX_MANAGED_BY_BUN,'1');
  const npm=fixture(path.join(directory,'npm'));
  for(const hints of [{npm_config_user_agent:'bun/1.3'},{npm_execpath:'/tools/bun/bin/bun'}])assert.equal(codexPackageEnvironment({command:npm.binary,prefix:[]},hints).CODEX_MANAGED_BY_BUN,'1');
  if(process.platform==='win32')assert.equal(codexPackageEnvironment({command:npm.binary,prefix:[]},{NPM_CONFIG_USER_AGENT:'bun/1.3'}).CODEX_MANAGED_BY_BUN,'1');
  for(const name of ['homebrew/Cellar/codex/0.167/bin/codex','ChatGPT.app/Contents/Resources/codex','standalone/codex','npm/node_modules/other/vendor/x86_64-unknown-linux-musl/bin/codex']){
    const env=codexPackageEnvironment({command:file(path.join(directory,name)),prefix:[]},inherited);assert.equal(env.CODEX_MANAGED_PACKAGE_ROOT,undefined);assert.deepEqual(flags(env),[]);assert.equal(env.USER_TOKEN,inherited.USER_TOKEN);
  }
  rmSync(path.join(npm.root,'node_modules'),{recursive:true});
  const bundled=file(path.join(npm.root,'vendor/x86_64-unknown-linux-musl/bin/codex'));assert.equal(codexPackageEnvironment({command:bundled,prefix:[]},{}).CODEX_MANAGED_BY_NPM,'1');
});

test('前台、后台与原窗口入口都由共同选择层补齐安装环境，保持原生可执行文件',t=>{
  const directory=temporary(t),f=fixture(directory),config={...DEFAULT_CONFIG,codexBinary:f.binary,codexHome:directory};
  for(const foreground of [true,false]){
    const launch=selectHostLaunch('codex',config,{home:directory,cwd:directory,current:inherited,baseline:inherited,foreground});
    assert.equal(launch.executable.command,f.binary);assert.equal(launch.env.CODEX_MANAGED_PACKAGE_ROOT,f.root);assert.deepEqual(flags(launch.env),['CODEX_MANAGED_BY_NPM']);
  }
  const recorded=selectHostLaunch('codex',DEFAULT_CONFIG,{home:directory,cwd:directory,baseline:inherited,executable:f.binary,configHome:directory});
  assert.equal(recorded.env.CODEX_MANAGED_PACKAGE_ROOT,f.root);assert.equal(recorded.executable.command,f.binary);
});
