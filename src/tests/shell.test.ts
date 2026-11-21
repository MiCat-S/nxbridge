import test from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { installWrapper, removeInstalledWrappers, removeWrapper, updateInstalledWrappers, wrapperBlock, type WrapperShell } from '../hosts/shell.js';
import { temporary } from './support/temporary.js';
import { uninstall } from '../install/setup.js';

test('包装重复安装和移除保留 profile 的原始编码、换行与用户追加内容',t=>{
  const home=temporary(t);
  for(const [index,encoding,bom] of [[0,'utf8',Buffer.alloc(0)],[1,'utf8',Buffer.from([0xef,0xbb,0xbf])],[2,'utf16le',Buffer.from([0xff,0xfe])]] as const){
    const file=path.join(home,`profile-${index}.ps1`),original=Buffer.concat([bom,Buffer.from('# 用户配置\r\n$answer = 42',encoding)]);
    writeFileSync(file,original);
    assert.equal(installWrapper({home,file,shell:'powershell'}).changed,true);
    const installed=readFileSync(file);assert.equal(installWrapper({home,file,shell:'powershell'}).changed,false);assert.deepEqual(readFileSync(file),installed);
    const extra=Buffer.from('\r\n# 用户追加配置\r\n',encoding);appendFileSync(file,extra);
    assert.equal(removeWrapper({home,file}).removed,true);
    assert.deepEqual(readFileSync(file),Buffer.concat([original,extra]));
  }
  assert.equal(existsSync(path.join(home,'shell-wrappers.json')),false);
});

test('包装移除只删除自己创建的空 profile，已有空文件保留',t=>{
  const home=temporary(t),created=path.join(home,'new','profile.ps1'),existing=path.join(home,'existing.ps1');
  writeFileSync(existing,'');
  installWrapper({home,file:created,shell:'powershell'});installWrapper({home,file:existing,shell:'powershell'});
  assert.deepEqual(readFileSync(created).subarray(0,3),Buffer.from([0xef,0xbb,0xbf]));
  assert.deepEqual(removeInstalledWrappers(home).removed.sort(),[created,existing].sort());
  assert.equal(existsSync(created),false);assert.equal(readFileSync(existing,'utf8'),'');
  assert.equal(removeWrapper({home,file:created}).removed,false);
});

test('卸载保留用户改过的包装，仍清理未修改的其他 profile',t=>{
  const home=temporary(t),modified=path.join(home,'modified.ps1'),clean=path.join(home,'clean.sh');
  installWrapper({home,file:modified,shell:'powershell'});installWrapper({home,file:clean,shell:'bash'});
  const customized=readFileSync(modified,'utf8').replace('function global:codex {','function global:codex { # 用户调整');writeFileSync(modified,customized,'utf8');
  const result=removeInstalledWrappers(home);
  assert.deepEqual(result.removed,[clean]);assert.equal(result.notes.length,1);assert.match(result.notes[0]!,/已被修改/);
  assert.equal(readFileSync(modified,'utf8'),customized);assert.equal(existsSync(clean),false);
});

test('仅安装包装时不依赖宿主程序仍存在，也可通过完整卸载命令回收',async t=>{
  const home=temporary(t),file=path.join(home,'profile.ps1');installWrapper({home,file,shell:'powershell'});
  writeFileSync(path.join(home,'config.json'),JSON.stringify({codexCommand:['nxbridge-uninstalled-codex-missing'],claudeCommand:['nxbridge-uninstalled-claude-missing']}),'utf8');
  const result=await uninstall(home) as {removed:boolean;wrappers:{removed:string[]}};
  assert.equal(result.removed,true);assert.deepEqual(result.wrappers.removed,[file]);assert.equal(existsSync(file),false);
});

test('兼容旧别名标记，拒绝在残缺或重复标记下改写 profile',t=>{
  const home=temporary(t),file=path.join(home,'profile.sh');
  const legacy='# 用户内容\n# nxbridge begin\ncodex() { old "$@"; }\n# nxbridge end\n';writeFileSync(file,legacy);
  installWrapper({home,file,shell:'bash'});assert.equal(removeWrapper({home,file}).removed,true);assert.equal(readFileSync(file,'utf8'),'# 用户内容\n');
  for(const invalid of ['# nxbridge begin\n用户内容\n','# nxbridge end\n','# nxbridge begin\n# nxbridge begin\n# nxbridge end\n']){
    writeFileSync(file,invalid);assert.throws(()=>installWrapper({home,file,shell:'bash'}),/标记/);assert.equal(readFileSync(file,'utf8'),invalid);
  }
  writeFileSync(file,Buffer.from([0xe9,0xff]));assert.throws(()=>installWrapper({home,file,shell:'powershell'}),/编码/);assert.deepEqual(readFileSync(file),Buffer.from([0xe9,0xff]));
});

test('自动迁移只更新与记录一致的包装区块，稳定入口不再依赖工程 dist',t=>{
  const home=temporary(t),clean=path.join(home,'old.ps1'),modified=path.join(home,'custom.ps1');
  installWrapper({home,file:clean,shell:'powershell'});installWrapper({home,file:modified,shell:'powershell'});
  const stateFile=path.join(home,'shell-wrappers.json'),state=JSON.parse(readFileSync(stateFile,'utf8'));
  const record=state.profiles.find((value:any)=>value.file===clean),old=wrapperBlock('powershell',process.execPath,'C:\\old project\\dist\\cli.js','\r\n');
  const current=readFileSync(clean,'utf8');writeFileSync(clean,current.replace(record.block,old),'utf8');record.block=old;writeFileSync(stateFile,JSON.stringify(state),'utf8');
  const user=readFileSync(modified,'utf8').replace('function global:codex {','function global:codex { # 用户修改');writeFileSync(modified,user,'utf8');
  const result=updateInstalledWrappers(home);assert.deepEqual(result.updated,[clean]);assert.equal(result.notes.length,1);
  assert.ok(readFileSync(clean,'utf8').includes(path.join(home,'bin','nxbridge.cjs')));assert.equal(readFileSync(modified,'utf8'),user);
});

const psQuote=(value:string)=>"'"+value.replaceAll("'","''")+"'";
const shQuote=(value:string)=>"'"+value.replaceAll("'","'\\''")+"'";
for(const shell of ['powershell','bash','zsh'] as const){
  let available=process.platform==='win32'?shell==='powershell':shell!=='powershell';
  if(available&&shell!=='powershell')try{execFileSync(shell,['--version'],{timeout:2000,stdio:'ignore'});}catch{available=false;}
  test(`${shell} 实际函数完整转发 argv 与退出码`,{skip:!available},t=>{
    const home=temporary(t),folder=path.join(home,"含 空格'的路径");mkdirSync(folder);
    const entry=path.join(folder,'cli.cjs');
    writeFileSync(entry,"const [mode,...args]=process.argv.slice(2);const argv=mode==='shell-codex'?JSON.parse(Buffer.from(args[0],'base64').toString('utf8')):args;console.log(JSON.stringify(argv.includes('--stdin')?{argv,stdin:require('node:fs').readFileSync(0,'utf8')}:argv));process.exitCode=argv.includes('--fail')?23:0;\n");
    const block=wrapperBlock(shell as WrapperShell,process.execPath,entry);
    for(const argv of [[],['resume','原会话 ID'],['resume','--last','--all'],['--version'],['-C','C:\\含 空格\\','-c','model_reasoning_effort="xhigh"','提示\n第二行','a"b',"'",'', 'literal $() ` ${} ; & |'],['--fail']]){
      const script=shell==='powershell'?`[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false); $ProgressPreference = 'SilentlyContinue';\n${block}\ncodex${argv.length?' '+argv.map(psQuote).join(' '):''}\nexit $LASTEXITCODE`:`${block}\ncodex${argv.length?' '+argv.map(shQuote).join(' '):''}`;
      const command=shell==='powershell'?'powershell.exe':shell;
      const args=shell==='powershell'?['-NoLogo','-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')]:['-c',script];
      try{
        const output=execFileSync(command,args,{encoding:'utf8',timeout:10000,windowsHide:true});
        assert.deepEqual(JSON.parse(output.trim()),argv);assert.equal(argv.includes('--fail'),false);
      }catch(error){
        const failure=error as {status?:number;stdout?:string};
        if(!argv.includes('--fail'))throw error;
        assert.equal(failure.status,23);assert.deepEqual(JSON.parse(failure.stdout!.trim()),argv);
      }
    }
    const input=['stdin 中文','line "two"'];
    const script=shell==='powershell'?`[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false); $ProgressPreference='SilentlyContinue';\n${block}\n@(${input.map(psQuote).join(',')}) | codex --stdin\nexit $LASTEXITCODE`:`${block}\nprintf '%s\\n' ${input.map(shQuote).join(' ')} | codex --stdin`;
    const command=shell==='powershell'?'powershell.exe':shell;
    const args=shell==='powershell'?['-NoLogo','-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')]:['-c',script];
    const result=JSON.parse(execFileSync(command,args,{encoding:'utf8',timeout:10000,windowsHide:true}).trim());
    assert.deepEqual(result.argv,['--stdin']);assert.equal(result.stdin.replaceAll('\r\n','\n'),input.join('\n')+'\n');
  });
}
