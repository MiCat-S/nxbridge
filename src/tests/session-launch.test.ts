import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {mkdirSync,writeFileSync} from 'node:fs';
import { temporary } from './support/temporary.js';
import {saveUserProfile,profileState,captureDaemonLaunch,captureUserLaunch,recordManagedSessionLaunch,type LaunchProfile} from '../hosts/launch-profiles.js';
import {selectSessionLaunch,selectNewSessionLaunch} from '../hosts/session-launch.js';
import {setPreferredProfiles} from '../hosts/launch-profiles.js';

test('新后台按当前实际版本比较同 home 入口，跨 home 不借环境，明确配对和固定配置保留',async t=>{
  const home=temporary(t),app=record(home,'ChatGPT','codex-cli 0.170.0','recent',2),brew=record(home,'brew','codex-cli 0.167.0','older',1);
  saveUserProfile(home,app);saveUserProfile(home,brew);
  const other=path.join(home,'other-home');mkdirSync(other);saveUserProfile(home,record(other,'other','codex-cli 99.0.0','other',0));
  const checked:string[]=[],probe=async(launch:any)=>{checked.push(launch.executable.command);return launch.executable.command===app.exe?'codex-cli 0.167.0-alpha.3':'codex-cli 0.167.2';},options={home,cwd:home};
  let chosen=await selectNewSessionLaunch('codex',DEFAULT_CONFIG,options,probe);assert.equal(chosen.executable.command,brew.exe);assert.equal(checked.length,2);assert.equal(chosen.configHome,home);assert.match(chosen.selectionReason!,/重新核验.*0.167.2/);
  setPreferredProfiles(home,{codex:app.sourceSession});checked.length=0;
  chosen=await selectNewSessionLaunch('codex',DEFAULT_CONFIG,options,probe);assert.equal(chosen.executable.command,app.exe);assert.equal(checked.length,0);assert.match(chosen.selectionReason!,/明确选择/);
  chosen=await selectNewSessionLaunch('codex',{...DEFAULT_CONFIG,codexBinary:app.exe},options,probe);assert.equal(chosen.executable.command,app.exe);assert.match(chosen.selectionReason!,/显式固定/);
});
import {selectHostLaunch} from '../hosts/host-launch.js';
import {deterministicLaunchFailure} from '../hosts/launch-park.js';
import {recoveryPrecondition} from '../broker/recovery/managed-recovery.js';
import {BridgeError} from '../shared/errors.js';
import {DEFAULT_CONFIG} from '../config/defaults.js';

function record(root:string,name:string,version:string,session='other',at=1):LaunchProfile{
  const exe=path.join(root,name);writeFileSync(exe,'隔离入口','utf8');
  return{id:name,host:'codex',exe,version,configHome:root,cwd:root,env:{PATH:'',TERM:'原终端'},sourceSession:session,sourcePid:2,sourceGeneration:'2',capturedAt:at,dropped:[]};
}
const version=async(launch:any)=>launch.profile?.version??'codex-cli 0.167.1';

test('同 home 未知来源先过滤写入版本，较新的不兼容记录不能遮住合格入口',async t=>{
  const home=temporary(t),brew=record(home,'brew','codex-cli 0.167.1'),app=record(home,'chatgpt','codex-cli 0.167.0-alpha.3.2','unrelated',2);
  saveUserProfile(home,brew);saveUserProfile(home,app);
  const result=await selectSessionLaunch('codex',DEFAULT_CONFIG,{home,cwd:home,configHome:home,sessionId:'original'},{version,writer:'0.167.1'});
  assert.equal(result.executable.command,brew.exe);assert.match(result.notes.join(' '),/已核验兼容/);
});

test('已知会话来源不跨安装借用；显式配置可替换并仍检查写入版本',async t=>{
  const home=temporary(t),original=record(home,'original','codex-cli 0.167.0','session'),other=record(home,'unrelated','codex-cli 0.168.0','other',2);
  saveUserProfile(home,original);saveUserProfile(home,other);
  await assert.rejects(selectSessionLaunch('codex',DEFAULT_CONFIG,{home,cwd:home,configHome:home,sessionId:'session'},{version,writer:'0.167.1'}),error=>{
    assert.equal((error as any).code,'profile_version_unsupported');assert.equal((error as any).launchCandidates.length,1);assert.match(String(error),/config set hosts.codex.binary/);return true;
  });
  const selected=await selectSessionLaunch('codex',{...DEFAULT_CONFIG,codexBinary:other.exe},{home,cwd:home,configHome:home,sessionId:'session'},{version,writer:'0.167.1'});
  assert.equal(selected.executable.command,other.exe);assert.equal(selected.profile,undefined);
  const different=path.join(home,'different');mkdirSync(different);
  await assert.rejects(selectSessionLaunch('codex',{...DEFAULT_CONFIG,codexBinary:other.exe,codexHome:different},{home,cwd:home,configHome:home,sessionId:'session'},{version}),{code:'original_home_changed'});
});

test('临时版本探测及混合失败不永久暂停，历史异常保持原错误',async t=>{
  const home=temporary(t),a=record(home,'a','codex-cli 0.167.0'),b=record(home,'b','codex-cli 0.167.0','other',2);
  saveUserProfile(home,a);saveUserProfile(home,b);
  const options={home,cwd:home,configHome:home,sessionId:'original'};
  for(const code of ['timeout','host_control_timeout','EACCES','EPERM']){
    await assert.rejects(selectSessionLaunch('codex',DEFAULT_CONFIG,options,{writer:'0.167.1',version:async launch=>{if(launch.executable.command===a.exe)return 'codex-cli 0.167.0';throw new BridgeError(code,'临时探测失败');}}),error=>{
      assert.equal((error as any).code,'launch_probe_unavailable');assert.equal(deterministicLaunchFailure(error),false);assert.equal(recoveryPrecondition(error),true);return true;
    });
  }
  await assert.rejects(selectSessionLaunch('codex',DEFAULT_CONFIG,options,{writer:'0.167.1',version:async()=>{throw new BridgeError('session_ambiguous','原历史重复');}}),{code:'session_ambiguous'});
  assert.equal(deterministicLaunchFailure(new BridgeError('bootstrap_required','启动助手暂时未响应')),false);
});

test('Claude 自动入口保留版本筛选，用户显式固定旧入口会显示写入版本提示',async t=>{
  const home=temporary(t),entry={...record(home,'claude','2.1.0 (Claude Code)','session'),host:'claude' as const};saveUserProfile(home,entry);
  const options={home,cwd:home,configHome:home,sessionId:'session'},dependencies={writer:'2.2.0',version:async()=>entry.version};
  await assert.rejects(selectSessionLaunch('claude',DEFAULT_CONFIG,options,dependencies),{code:'profile_version_unsupported'});
  const selected=await selectSessionLaunch('claude',{...DEFAULT_CONFIG,claudeBinary:entry.exe},options,dependencies);
  assert.equal(selected.executable.command,entry.exe);assert.match(selected.notes.join(' '),/2\.1\.0.*2\.2\.0/);
});

test('仅固定 home 时使用固定目录和中性认证环境，不借用另一个窗口模板',t=>{
  const home=temporary(t),original=record(home,'codex','codex-cli 0.167.1'),pinned=path.join(home,'pinned');mkdirSync(pinned);saveUserProfile(home,original);
  const binary=path.join(home,process.platform==='win32'?'codex.exe':'codex');writeFileSync(binary,'隔离入口','utf8');
  const selected=selectHostLaunch('codex',{...DEFAULT_CONFIG,codexHome:pinned},{home,cwd:home,baseline:{PATH:home},current:{}});
  assert.equal(selected.configHome,pinned);assert.equal(selected.env.CODEX_HOME,pinned);assert.equal(selected.executable.command,binary);assert.equal(selected.profile,undefined);assert.equal(selected.method,'pin');
});

test('自有后台删除运行时账本后仍能按原会话恢复，独立观测不成为其他会话模板',async t=>{
  const home=temporary(t),exe=record(home,'managed','codex-cli 0.167.1').exe;
  recordManagedSessionLaunch(home,'managed-session',home,{id:'managed',owner:'nxbridge',kind:'owned',state:'ready',dedicated:true,endpoint:'ws://127.0.0.1:1',createdAt:1,pid:123,procStart:'generation',configHome:home,executable:exe});
  assert.equal(profileState(home).profiles.length,0);assert.equal(profileState(home).observations?.[0]?.kind,'managed');assert.deepEqual(profileState(home).observations?.[0]?.env,{});
  const options={home,cwd:home,configHome:home},selected=await selectSessionLaunch('codex',DEFAULT_CONFIG,{...options,sessionId:'managed-session'},{version:async()=> 'codex-cli 0.167.1',writer:'0.167.1'});
  assert.equal(selected.executable.command,exe);
  await assert.rejects(selectSessionLaunch('codex',DEFAULT_CONFIG,{...options,sessionId:'unrelated'},{version,writer:'0.167.1'}),{code:'launch_provenance_missing'});
});

test('daemon 来源保存映像和版本，环境不成为用户模板，恢复使用中性环境',async t=>{
  const home=temporary(t),exe=record(home,'daemon','codex-cli 0.167.1').exe,native={pid:2,parentPid:1,name:'codex',startedAt:'generation',image:exe},endpoint={daemon:{address:'unix://isolated'},pid:2,procStart:'generation',configHome:home};
  const observed=await captureDaemonLaunch(home,{sessionId:'daemon-session',cwd:home},endpoint,{identity:async()=>native,daemon:async()=>true,version:async()=> 'codex-cli 0.167.1'});
  assert.equal(observed?.kind,'daemon');assert.deepEqual(observed?.env,{});assert.equal(profileState(home).profiles.length,0);
  const capture={host:'codex' as const,sessionId:'daemon-session',nativePid:2,nativeGeneration:'generation',sourcePid:3,sourceGeneration:'source',force:true,env:{CODEX_HOME:home,NXBRIDGE_OWNED_LAUNCH:'codex:owned',HTTPS_PROXY:'不准用作模板'}};
  await captureUserLaunch(home,capture,{id:'member',host:'codex',sessionId:'daemon-session',cwd:home,owner:'nxbridge'}as any,2,{ancestors:async()=>[{pid:3,parentPid:2,name:'node',startedAt:'source'},native],version:async()=> 'codex-cli 0.167.1'});
  assert.equal(profileState(home).observations?.[0]?.kind,'daemon');assert.deepEqual(profileState(home).observations?.[0]?.env,{});assert.equal(profileState(home).profiles.length,0);
  const selected=await selectSessionLaunch('codex',DEFAULT_CONFIG,{home,cwd:home,configHome:home,sessionId:'daemon-session'},{version,writer:'0.167.1'});
  assert.equal(selected.method,'daemon');assert.equal(selected.executable.command,exe);assert.equal(selected.env.CODEX_HOME,home);
  await assert.rejects(captureDaemonLaunch(home,{sessionId:'changed',cwd:home},{...endpoint,procStart:'different'},{identity:async()=>native,daemon:async()=>true}),{code:'launch_capture_unverified'});
});
