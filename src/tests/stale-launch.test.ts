import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { captureUserLaunch, saveUserProfile, setPreferredProfiles, type LaunchProfile } from '../hosts/launch-profiles.js';
import { launchStatus, prepareOwnedLaunch, selectHostLaunch, verifyLaunchImages } from '../hosts/host-launch.js';
import { selectSessionLaunch } from '../hosts/session-launch.js';
import { launchInputFingerprint } from '../hosts/launch-park.js';
import {DEFAULT_CONFIG} from '../config/defaults.js';
import { registration } from './support/registration.js';
import { temporary } from './support/temporary.js';
import { Store } from '../storage/store.js';

function record(home:string,exe:string,patch:Partial<LaunchProfile>={}):LaunchProfile{
  return{id:exe,host:'claude',exe,version:'2.1.321 (Claude Code)',configHome:home,cwd:home,env:{PATH:'',USER_TOKEN:'原窗口凭据'},sourceSession:exe,sourcePid:1,sourceGeneration:'原代次',capturedAt:1,dropped:[],...patch};
}
function desktop(home:string,version:string,hash:string,cpu=0x0100000c){
  const file=path.join(home,'Library','Application Support','Claude','claude-code',version,hash,'claude.app','Contents','MacOS','claude');mkdirSync(path.dirname(file),{recursive:true});
  const image=Buffer.alloc(32);image.writeUInt32LE(0xfeedfacf,0);image.writeUInt32LE(cpu,4);image.writeUInt32LE(2,12);writeFileSync(file,image,{mode:0o755});return file;
}

test('失效默认记录只尝试同 home 记录，回到 PATH 时保留原 home 且不继承旧环境',t=>{
  const home=temporary(t),native=path.join(home,'native'),other=path.join(home,'other'),project=path.join(home,'other-project');for(const file of [native,other,project])mkdirSync(file);
  const valid=path.join(home,'valid'),fallback=path.join(home,process.platform==='win32'?'claude.exe':'claude');writeFileSync(valid,'隔离入口');writeFileSync(fallback,'隔离 PATH 入口');
  const missing=record(native,path.join(home,'gone'),{cwd:home,capturedAt:3}),available=record(native,valid,{cwd:home,capturedAt:1}),foreign=record(other,process.execPath,{cwd:project,capturedAt:4,version:'99.0.0 (Claude Code)'});
  for(const value of [missing,available,foreign])saveUserProfile(home,value);
  const options={home,cwd:home,baseline:{PATH:home},current:{}};
  assert.equal(selectHostLaunch('claude',DEFAULT_CONFIG,options).executable.command,valid);
  writeFileSync(path.join(home,'launch-profiles.json'),JSON.stringify({version:1,profiles:[missing,foreign],preferred:{}}));
  const before=readFileSync(path.join(home,'launch-profiles.json')),chosen=selectHostLaunch('claude',DEFAULT_CONFIG,options);
  assert.equal(chosen.method,'fallback');assert.equal(chosen.executable.command,fallback);assert.equal(chosen.configHome,native);assert.equal(chosen.env.CLAUDE_CONFIG_DIR,native);assert.equal(chosen.env.USER_TOKEN,undefined);assert.match(chosen.notes.join(' '),/配置目录仍是/);
  assert.equal((launchStatus(home,DEFAULT_CONFIG,home).profiles[0] as any).availability.reason,'exe_missing');assert.deepEqual(readFileSync(path.join(home,'launch-profiles.json')),before);
  setPreferredProfiles(home,{claude:missing.sourceSession});assert.throws(()=>selectHostLaunch('claude',DEFAULT_CONFIG,options),{code:'launch_profile_missing'});
});

test('后继入口匹配原 profile 与证明，但原记录和旧运行进程的捕获路径不被重写',async t=>{
  const home=temporary(t),old=desktop(home,'2.1.321','aaaa'),next=desktop(home,'2.1.325','bbbb'),value=record(home,old,{sourceSession:'original'});saveUserProfile(home,value);setPreferredProfiles(home,{claude:'original'});
  const file=path.join(home,'launch-profiles.json'),before=readFileSync(file),selected=selectHostLaunch('claude',DEFAULT_CONFIG,{home,cwd:home,executable:next,profileId:value.id,configHome:home,baseline:{PATH:''},current:{}});
  assert.equal(selected.profile?.id,value.id);assert.equal(selected.profile?.exe,old);assert.equal(selected.method,'paired-profile');assert.equal(selected.executable.command,next);assert.deepEqual(readFileSync(file),before);
  const store=new Store(':memory:');t.after(()=>store.close());const peer=store.register(registration('claude','original',{cwd:home}));
  const capture={host:'claude' as const,sessionId:'original',nativePid:1,nativeGeneration:'one',sourcePid:2,sourceGeneration:'two',env:{CLAUDE_CONFIG_DIR:home}};
  const dependencies={ancestors:async()=>[{pid:2,parentPid:1,name:'node',startedAt:'two'},{pid:1,parentPid:0,name:'claude',startedAt:'one',image:old}],version:async()=> '2.1.321 (Claude Code)'};
  assert.equal((await captureUserLaunch(home,capture,peer,1,dependencies)).profile?.exe,old);
  const captured=readFileSync(file);assert.equal((await captureUserLaunch(home,capture,peer,1,{...dependencies,ancestors:async()=>{throw Error('缓存不应因磁盘更新而重读旧进程');}})).cached,true);assert.deepEqual(readFileSync(file),captured);
});

test('旧会话未记写入版本时，自动更新入口复用已有输出核验版本，不重复探测',async t=>{
  const home=temporary(t),old=desktop(home,'2.1.321','aaaa'),next=desktop(home,'2.1.325','bbbb');
  saveUserProfile(home,record(home,old,{sourceSession:'original'}));
  const options={home,cwd:home,configHome:home,sessionId:'original',baseline:{PATH:''},current:{}};
  let probes=0;
  for(const output of ['', '正在更新，请稍后', '社区发行版：2.1.325']){
    const launch=await selectSessionLaunch('claude',DEFAULT_CONFIG,options,{version:async()=>{probes++;return output;}});
    assert.equal(launch.updatedFrom,old);assert.equal(launch.executable.command,next);assert.equal(launch.version,output);
    if(output.includes('2.1.325'))assert.equal((await prepareOwnedLaunch(launch)).version,output);
    else await assert.rejects(prepareOwnedLaunch(launch),error=>{
      assert.equal((error as {code:string}).code,'launch_profile_missing');assert.match(String(error),/更新还没完成/);return true;
    });
  }
  assert.equal(probes,3);
});

test('显式包装器没有可比较版本时仍交给原生能力检查，不套用自动更新入口规则',async t=>{
  const home=temporary(t),options={home,cwd:home,configHome:home,sessionId:'original',baseline:{PATH:''},current:{}};
  for(const pin of [{claudeCommand:[process.execPath,'wrapper.mjs']},{claudeBinary:process.execPath}]){
    const launch=await selectSessionLaunch('claude',{...DEFAULT_CONFIG,...pin},options,{version:async()=> '包装器自己的版本说明'});
    assert.equal(launch.explicitExecutable,true);assert.equal(launch.updatedFrom,undefined);
    assert.equal((await prepareOwnedLaunch(launch)).version,'包装器自己的版本说明');
  }
});

test('原启动证明的 home 消失时拒绝恢复，不通过显式程序创建空目录',t=>{
  const home=temporary(t),options={home,cwd:home,configHome:path.join(home,'missing-home'),sessionId:'original',executable:process.execPath,baseline:{PATH:''},current:{}};
  for(const config of [DEFAULT_CONFIG,{...DEFAULT_CONFIG,claudeBinary:process.execPath}])assert.throws(()=>selectHostLaunch('claude',config,options),{code:'launch_profile_missing'});
  const foreign=path.join(home,'other-home');mkdirSync(foreign);
  assert.throws(()=>selectHostLaunch('claude',DEFAULT_CONFIG,{...options,configHome:home,record:record(foreign,process.execPath)}),{code:'launch_profile_missing'});
});

test('多 hash 证明按实际环境与全部映像复用，仅固定 home 仍核验，显式程序可直接选择',async t=>{
  const home=temporary(t),first=desktop(home,'2.1.325','aaaa'),second=desktop(home,'2.1.325','bbbb');saveUserProfile(home,record(home,first));
  const options={home,cwd:home,baseline:{PATH:''},current:{}},choose=()=>selectHostLaunch('claude',DEFAULT_CONFIG,options);let probes=0;
  const probe=async()=>{probes++;return'2.1.325 (Claude Code)';};
  await Promise.all([verifyLaunchImages(choose(),probe),verifyLaunchImages(choose(),probe)]);assert.equal(probes,2);
  const peer={host:'claude' as const,sessionId:first,cwd:home},before=launchInputFingerprint(home,DEFAULT_CONFIG,peer,home,{executable:first});
  writeFileSync(second,Buffer.concat([readFileSync(second),Buffer.from('更新')]),{mode:0o755});
  assert.notEqual(launchInputFingerprint(home,DEFAULT_CONFIG,peer,home,{executable:first}),before);await verifyLaunchImages(choose(),probe);assert.equal(probes,4);
  const changed=choose();changed.env={...changed.env,LANG:'新的语言'};await verifyLaunchImages(changed,probe);assert.equal(probes,6);
  const homeOnly=selectHostLaunch('claude',{...DEFAULT_CONFIG,claudeHome:home},{...options,executable:first,configHome:home});homeOnly.env={...homeOnly.env,LANG:'仅固定 home'};await verifyLaunchImages(homeOnly,probe);assert.equal(probes,8);
  const pinned=selectHostLaunch('claude',{...DEFAULT_CONFIG,claudeBinary:first,claudeHome:home},options);await verifyLaunchImages(pinned,async()=>{throw Error('显式入口不需要比较其他 hash');});assert.equal(pinned.executable.command,first);
});
