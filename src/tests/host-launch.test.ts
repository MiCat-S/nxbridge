import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { once } from 'node:events';
import { temporary } from './support/temporary.js';
import { registration } from './support/registration.js';
import { Store } from '../storage/store.js';
import { cleanInstanceEnvironment, neutralEnvironment } from '../process/environment.js';
import { captureUserLaunch, profileState, saveUserProfile, setPreferredProfiles, type LaunchProfile } from '../hosts/launch-profiles.js';
import { launchMetadata, launchStatus, prepareOwnedLaunch, selectHostLaunch, spawnSelectedHost } from '../hosts/host-launch.js';
import {DEFAULT_CONFIG} from '../config/defaults.js';
import {runCli} from '../process/host-command.js';

function profile(directory:string,patch:Partial<LaunchProfile>={}):LaunchProfile{
  const configHome=path.join(directory,'native-home');mkdirSync(configHome,{recursive:true});
  return{id:'profile-a',host:'codex',exe:process.execPath,version:'codex-cli 0.166.0',configHome,cwd:directory,env:{PATH:'C:\\native-bin',CODEX_HOME:configHome,USER_TOKEN:'用户凭据',HTTPS_PROXY:'http://127.0.0.1:7897',CODEX_THREAD_ID:'旧线程',NODE_OPTIONS:'旧实例'},sourceSession:'user-a',sourcePid:1,sourceGeneration:'1',capturedAt:1,dropped:[],...patch};
}

test('Windows 前台及普通环境的 Path 均能解析独立安装目录和裸命令名',{skip:process.platform!=='win32'},t=>{
  const home=temporary(t),bin=path.join(home,'独立安装目录');mkdirSync(bin);
  const codex=path.join(bin,'codex.exe'),custom=path.join(bin,'custom-codex.exe');writeFileSync(codex,'');writeFileSync(custom,'');
  const current={Path:bin,CODEX_HOME:home},foreground=selectHostLaunch('codex',DEFAULT_CONFIG,{home,current,foreground:true});
  assert.equal(foreground.executable.command,codex);assert.equal(foreground.env.PATH,bin);assert.equal(foreground.env.Path,undefined);
  for(const options of [{current,foreground:true},{baseline:current,current:{}}]){
    const chosen=selectHostLaunch('codex',{...DEFAULT_CONFIG,codexCommand:['custom-codex']},{home,...options});assert.equal(chosen.executable.command,custom);
  }
});

test('Codex 终端仅继承请求方 Claude 的真实检测值，多配对不借用其他窗口或认证',t=>{
  const directory=temporary(t),codex=profile(directory,{env:{TERM:'codex-term',TERM_PROGRAM:'旧终端',WT_SESSION:'旧标记'}});
  saveUserProfile(directory,codex);
  saveUserProfile(directory,profile(directory,{id:'claude-a',host:'claude',sourceSession:'claude-a',env:{TERM:'真实终端甲',WT_SESSION:'真实窗口甲',ANTHROPIC_API_KEY:'不准复制'},capturedAt:2}));
  saveUserProfile(directory,profile(directory,{id:'claude-b',host:'claude',sourceSession:'claude-b',configHome:directory,env:{TERM:'真实终端乙'},capturedAt:3}));
  const options={home:directory,cwd:directory,baseline:{PATH:'',TERM_PROGRAM:'broker 终端'},current:{}};
  let chosen=selectHostLaunch('codex',{...DEFAULT_CONFIG,codexBinary:process.execPath,codexHome:directory},{...options,requesterSession:'claude-a'});
  assert.equal(chosen.env.TERM,'真实终端甲');assert.equal(chosen.env.WT_SESSION,'真实窗口甲');assert.equal(chosen.env.TERM_PROGRAM,undefined);assert.equal(chosen.env.ANTHROPIC_API_KEY,undefined);
  chosen=selectHostLaunch('codex',DEFAULT_CONFIG,{...options,requesterSession:'claude-b'});assert.equal(chosen.env.TERM,'真实终端乙');assert.equal(chosen.env.WT_SESSION,undefined);
  chosen=selectHostLaunch('codex',DEFAULT_CONFIG,{...options,requesterSession:'unknown'});assert.equal(chosen.env.TERM,'codex-term');
});

test('Claude-first 没有 Codex 模板也传递终端；没有窗口记录时不猜测终端',t=>{
  const directory=temporary(t),config={...DEFAULT_CONFIG,codexBinary:process.execPath,codexHome:directory};
  const options={home:directory,cwd:directory,baseline:{PATH:'',TERM:'broker 环境'},current:{}};
  assert.equal(selectHostLaunch('codex',config,options).env.TERM,undefined);
  saveUserProfile(directory,profile(directory,{host:'claude',sourceSession:'requester',env:{TERM:'实际终端',WT_SESSION:'实际窗口'}}));
  const chosen=selectHostLaunch('codex',config,{...options,requesterSession:'requester'});
  assert.equal(chosen.env.TERM,'实际终端');assert.equal(chosen.env.WT_SESSION,'实际窗口');assert.equal(chosen.profile,undefined);assert.equal(chosen.method,'pin');
});


test('空环境覆盖项在写入 process.env 前移除，不变成字面量 undefined',()=>{
  const {env}=neutralEnvironment({NXBRIDGE_SERVICE_ORIGIN:undefined,NXBRIDGE_HOME:'隔离目录'});
  assert.equal(Object.hasOwn(env,'NXBRIDGE_SERVICE_ORIGIN'),false);assert.equal(env.NXBRIDGE_HOME,'隔离目录');
});

test('隔离验收的禁用自更新设置经过中性环境后仍传给宿主',t=>{
  const directory=temporary(t),keys=['NXBRIDGE_TEST_SCOPE','DISABLE_AUTOUPDATER'] as const;
  const previous=Object.fromEntries(keys.map(key=>[key,process.env[key]]));
  try{
    process.env.NXBRIDGE_TEST_SCOPE='隔离验收';process.env.DISABLE_AUTOUPDATER='1';
    assert.equal(neutralEnvironment({DISABLE_AUTOUPDATER:undefined}).env.DISABLE_AUTOUPDATER,'1');
    const launch=selectHostLaunch('claude',{...DEFAULT_CONFIG,claudeBinary:process.execPath,claudeHome:directory},{home:directory});
    assert.equal(launch.env.DISABLE_AUTOUPDATER,'1');
    delete process.env.NXBRIDGE_TEST_SCOPE;
    assert.equal(Object.hasOwn(neutralEnvironment({DISABLE_AUTOUPDATER:undefined}).env,'DISABLE_AUTOUPDATER'),false);
  }finally{
    for(const key of keys){if(previous[key]===undefined)delete process.env[key];else process.env[key]=previous[key];}
  }
});

test('两个安装与配置组合按明确配对及项目选择，跨项目有明确说明',t=>{
  const directory=temporary(t),other=path.join(directory,'other');mkdirSync(other);
  const first=profile(directory),second=profile(other,{id:'profile-b',sourceSession:'user-b',capturedAt:2});
  saveUserProfile(directory,first);saveUserProfile(directory,second);setPreferredProfiles(directory,{codex:'user-a'});
  let chosen=selectHostLaunch('codex',DEFAULT_CONFIG,{home:directory,cwd:directory,baseline:{PATH:''}});assert.equal(chosen.profile?.id,first.id);assert.equal(chosen.env.USER_TOKEN,'用户凭据');assert.equal(chosen.env.CODEX_THREAD_ID,undefined);assert.equal(chosen.env.NODE_OPTIONS,undefined);assert.equal(chosen.env.HTTPS_PROXY,first.env.HTTPS_PROXY);
  setPreferredProfiles(directory,{});chosen=selectHostLaunch('codex',DEFAULT_CONFIG,{home:directory,cwd:directory,baseline:{PATH:''}});assert.equal(chosen.profile?.id,first.id);assert.equal(chosen.notes.length,0);assert.equal(chosen.env.PWD,directory);
  const sameInstall=profile(directory,{id:'profile-c',configHome:second.configHome,capturedAt:1.5});saveUserProfile(directory,sameInstall);
  chosen=selectHostLaunch('codex',DEFAULT_CONFIG,{home:directory,cwd:directory,baseline:{PATH:''}});assert.equal(chosen.profile?.id,'profile-c');
  assert.equal(profileState(directory).profiles.length,3);assert.doesNotMatch(JSON.stringify(launchStatus(directory,DEFAULT_CONFIG,directory)),/用户凭据|37584|7897/);
});

test('一次启动选择共用同一记录快照，程序、配对偏好和终端不混读其他状态',t=>{
  const directory=temporary(t),first=profile(directory,{env:{TERM:'原窗口终端'}});
  saveUserProfile(directory,first);setPreferredProfiles(directory,{codex:first.sourceSession});
  const state=profileState(directory);rmSync(path.join(directory,'launch-profiles.json'));
  const chosen=selectHostLaunch('codex',DEFAULT_CONFIG,{home:directory,cwd:directory,baseline:{PATH:''},current:{}},state);
  assert.equal(chosen.profile?.id,first.id);assert.equal(chosen.method,'paired-profile');assert.equal(chosen.env.TERM,'原窗口终端');
});

test('恢复选择已核验版本时，启动准备复用结果而不再运行一次版本命令',async t=>{
  const directory=temporary(t),launch=selectHostLaunch('codex',{...DEFAULT_CONFIG,codexBinary:process.execPath,codexHome:directory},{home:directory,cwd:directory,baseline:{PATH:''},current:{}});
  launch.updatedFrom=path.join(directory,'old-codex');launch.version='codex-cli 0.167.1';
  const prepared=await prepareOwnedLaunch(launch);
  assert.equal(prepared.version,launch.version);assert.match(prepared.env.NXBRIDGE_OWNED_LAUNCH!,/^codex:/);
});

test('已消失项目不作为跨项目默认模板，明确配对仍保留原窗口环境',t=>{
  const directory=temporary(t),project=path.join(directory,'deleted-project'),current=path.join(directory,'new-project');
  mkdirSync(project);mkdirSync(current);
  const older=profile(directory),latest=profile(project,{id:'deleted',sourceSession:'deleted-session',capturedAt:2,configHome:older.configHome});
  saveUserProfile(directory,older);saveUserProfile(directory,latest);
  rmSync(project,{recursive:true});
  let chosen=selectHostLaunch('codex',DEFAULT_CONFIG,{home:directory,cwd:current,baseline:{PATH:''}});
  assert.equal(chosen.profile?.id,older.id);
  setPreferredProfiles(directory,{codex:latest.sourceSession});
  chosen=selectHostLaunch('codex',DEFAULT_CONFIG,{home:directory,cwd:current,baseline:{PATH:''}});
  assert.equal(chosen.profile?.id,latest.id);
  assert.equal(profileState(directory).profiles.length,2,'只改变选择，不删除历史记录');
});

test('仅剩已消失项目时回到系统环境，不沿用过期模板',t=>{
  const directory=temporary(t),missing=path.join(directory,'missing');
  const record=profile(directory,{cwd:missing});
  saveUserProfile(directory,record);
  writeFileSync(path.join(directory,process.platform==='win32'?'codex.exe':'codex'),'隔离入口，不执行');
  const chosen=selectHostLaunch('codex',DEFAULT_CONFIG,{home:directory,cwd:directory,baseline:{PATH:directory},current:{}});
  assert.equal(chosen.profile,undefined);assert.equal(chosen.method,'fallback');
  assert.equal(chosen.env.USER_TOKEN,undefined);assert.equal(chosen.notes.length,1);assert.match(chosen.notes[0]!,/已不存在的项目目录/);
});

test('命令 pin 优先且按 argv 追加参数，子进程使用干净环境并保留配置引用的临时凭据',async t=>{
  const directory=temporary(t),configHome=path.join(directory,'config'),script=path.join(directory,'host.mjs');mkdirSync(configHome);
  writeFileSync(path.join(configHome,'config.toml'),'[model_providers.example]\nenv_key="SHELL_PROVIDER_KEY"\n','utf8');
  writeFileSync(script,"console.log(JSON.stringify({args:process.argv.slice(2),proxy:process.env.HTTPS_PROXY??null,key:process.env.SHELL_PROVIDER_KEY,home:process.env.CODEX_HOME,thread:process.env.CODEX_THREAD_ID??null}));",'utf8');
  saveUserProfile(directory,profile(directory));
  const chosen=selectHostLaunch('codex',{...DEFAULT_CONFIG,codexCommand:[process.execPath,script,'固定 参数','--'],codexHome:configHome},{home:directory,cwd:directory,baseline:{PATH:''},current:{HTTPS_PROXY:'http://poisoned',SHELL_PROVIDER_KEY:'临时凭据',CODEX_THREAD_ID:'poisoned'}});
  assert.equal(chosen.method,'command');assert.equal(chosen.profile,undefined);
  const metadata=launchMetadata({...chosen,executable:{...chosen.executable,prefix:[...chosen.executable.prefix,'--auth-token','诊断秘密','--api-key=内联秘密']}});assert.doesNotMatch(JSON.stringify(metadata),/诊断秘密|内联秘密/);
  const child=spawnSelectedHost(chosen,['app-server','空 参数'],{stdio:['ignore','pipe','pipe']});let output='';child.stdout!.setEncoding('utf8').on('data',value=>output+=value);const [code]=await once(child,'exit');assert.equal(code,0);
  assert.deepEqual(JSON.parse(output),{args:['固定 参数','--','app-server','空 参数'],proxy:null,key:'临时凭据',home:configHome,thread:null});
});

test('同会话原生观测不能绕过显式启动包装器或固定的配置目录',t=>{
  const directory=temporary(t),observed=profile(directory,{host:'claude',sourceSession:'same-session'});
  writeFileSync(path.join(directory,'launch-profiles.json'),JSON.stringify({version:1,profiles:[],observations:[{...observed,owned:true}],preferred:{}}));
  const chosen=selectHostLaunch('claude',{...DEFAULT_CONFIG,claudeCommand:[process.execPath,'wrapper.mjs'],claudeHome:directory},{home:directory,sessionId:'same-session',baseline:{PATH:''}});
  assert.equal(chosen.method,'command');assert.equal(chosen.profile,undefined);assert.ok(chosen.executable.prefix.includes('wrapper.mjs'));assert.equal(chosen.configHome,directory);
});

test('自定义包装器的并发控制命令串行执行，失败后继续后续命令',async t=>{
  const directory=temporary(t),script=path.join(directory,'exclusive.mjs'),lock=path.join(directory,'active.lock');
  writeFileSync(script,`import{openSync,closeSync,unlinkSync}from'node:fs';const file=${JSON.stringify(lock)};closeSync(openSync(file,'wx'));setTimeout(()=>{unlinkSync(file);console.log(process.argv.at(-1));process.exitCode=process.argv.at(-1)==='fail'?23:0;},80);`,'utf8');
  const config={...DEFAULT_CONFIG,claudeCommand:[process.execPath,script],claudeHome:directory};
  const outcomes=await Promise.allSettled(['first','fail','last'].map(arg=>runCli('claude',[arg],{config,home:directory})));
  assert.equal(outcomes[0]!.status,'fulfilled');assert.equal(outcomes[1]!.status,'rejected');assert.equal(outcomes[2]!.status,'fulfilled');
  assert.equal((outcomes[0] as PromiseFulfilledResult<string>).value.trim(),'first');assert.equal((outcomes[1] as PromiseRejectedResult).reason.code,23);assert.equal((outcomes[2] as PromiseFulfilledResult<string>).value.trim(),'last');
});

test('自有会话只更新独立观测，不覆盖用户启动记录；间接 shell 不能冒充原生捕获',async t=>{
  const directory=temporary(t),user=profile(directory);saveUserProfile(directory,user);
  const store=new Store(':memory:');t.after(()=>store.close());const peer=store.register(registration('codex','owned',{cwd:directory}));
  const capture={host:'codex' as const,sessionId:'owned',nativePid:2,nativeGeneration:'2',sourcePid:3,sourceGeneration:'3',env:{CODEX_HOME:user.configHome,NXBRIDGE_OWNED_LAUNCH:'codex:test',HTTPS_PROXY:'http://poisoned'}};
  const native={pid:2,parentPid:1,name:'codex.exe',image:process.execPath,startedAt:'2'},source={pid:3,parentPid:2,name:'node.exe',startedAt:'3'};
  const dependencies={ancestors:async()=>[source,native],version:async()=> 'codex-cli 0.166.0'};
  assert.equal((await captureUserLaunch(directory,capture,peer,2,dependencies)).owned,true);assert.equal(profileState(directory).profiles[0]?.env.HTTPS_PROXY,user.env.HTTPS_PROXY);assert.equal(profileState(directory).observations?.[0]?.env.NXBRIDGE_OWNED_LAUNCH,undefined);
  await assert.rejects(captureUserLaunch(directory,{...capture,force:true,env:{CODEX_HOME:user.configHome}},peer,2,{...dependencies,ancestors:async()=>[source,{pid:4,parentPid:2,name:'powershell.exe',startedAt:'2.5'},native]}),{code:'launch_capture_unverified'});
  assert.equal(readFileSync(path.join(directory,'launch-profiles.json'),'utf8').includes('codex:test'),false);
});

test('实例变量与临时 PATH 被剥离，代理和用户认证保留',()=>{
  const nativeBin=process.platform==='win32'?'C:\\native-bin':'/opt/native-bin';
  const env={PATH:[path.join(os.tmpdir(),'codex-arg0-test'),nativeBin].join(path.delimiter),ANTHROPIC_API_KEY:'user-key',HTTPS_PROXY:'http://proxy',CLAUDE_CODE_MESSAGING_SOCKET:'old',CLAUDECODE:'1',NXBRIDGE_SERVICE_ORIGIN:'old',CODEX_HOME:'native-home'};
  const clean=cleanInstanceEnvironment(env);assert.equal(clean.env.PATH,nativeBin);assert.equal(clean.env.HTTPS_PROXY,env.HTTPS_PROXY);assert.equal(clean.env.ANTHROPIC_API_KEY,env.ANTHROPIC_API_KEY);assert.equal(clean.env.CLAUDECODE,undefined);assert.equal(clean.env.NXBRIDGE_SERVICE_ORIGIN,undefined);assert.equal(clean.env.CODEX_HOME,'native-home');
});

for(const host of ['codex','claude'] as const)test('前台沿用实时终端、语言及命令环境，后台仍使用原有隔离记录：'+host,async t=>{
  const directory=temporary(t),nativeHome=path.join(directory,'live-home');mkdirSync(nativeHome);
  saveUserProfile(directory,profile(directory,{host,env:{TERM:'旧终端',COLORTERM:'旧颜色',LANG:'旧语言',HTTPS_PROXY:'http://old-proxy',PATH:'old-path'}}));
  const script=path.join(directory,'foreground.mjs');writeFileSync(script,'console.log(JSON.stringify({args:process.argv.slice(2),env:process.env}));','utf8');
  const current={PATH:path.join(directory,'temporary-bin'),TERM:'xterm-256color',COLORTERM:'truecolor',WT_SESSION:'当前窗口',LANG:'zh_CN.UTF-8',LC_ALL:'C.UTF-8',HTTPS_PROXY:'http://127.0.0.1:7891',OPENAI_API_KEY:'当前临时凭据',NODE_OPTIONS:'--no-warnings',npm_config_user_agent:'当前 Node 环境',CODEX_THREAD_ID:'旧线程',NXBRIDGE_ACTOR:'旧路由',[host==='codex'?'CODEX_HOME':'CLAUDE_CONFIG_DIR']:nativeHome};
  const config={...DEFAULT_CONFIG,[host==='codex'?'codexCommand':'claudeCommand']:[process.execPath,script]};
  const chosen=selectHostLaunch(host,config,{home:directory,cwd:directory,current,foreground:true});
  for(const key of ['PATH','TERM','COLORTERM','WT_SESSION','LANG','LC_ALL','HTTPS_PROXY','OPENAI_API_KEY','NODE_OPTIONS','npm_config_user_agent'])assert.equal(chosen.env[key],current[key as keyof typeof current],key);
  assert.equal(chosen.env.CODEX_THREAD_ID,undefined);assert.equal(chosen.env.NXBRIDGE_ACTOR,undefined);assert.equal(chosen.configHome,nativeHome);assert.equal(chosen.environment.source,'foreground-terminal');
  const child=spawnSelectedHost(chosen,['resume','原会话'],{stdio:['ignore','pipe','pipe']});let output='';child.stdout!.setEncoding('utf8').on('data',value=>output+=value);const[code]=await once(child,'exit');assert.equal(code,0);
  const observed=JSON.parse(output);assert.deepEqual(observed.args,['resume','原会话']);assert.equal(observed.env.LANG,current.LANG);assert.equal(observed.env.COLORTERM,current.COLORTERM);assert.equal(observed.env.HTTPS_PROXY,current.HTTPS_PROXY);assert.equal(observed.env.PWD,directory);
  const background=selectHostLaunch(host,DEFAULT_CONFIG,{home:directory,cwd:directory,current,baseline:{PATH:''}});assert.equal(background.env.LANG,'旧语言');assert.equal(background.env.NODE_OPTIONS,undefined);assert.equal(background.env.HTTPS_PROXY,'http://old-proxy');
});

test('普通调用只首次采集，重新登记刷新；后台注册先于接管仍不成为用户模板',async t=>{
  const directory=temporary(t),user=profile(directory),store=new Store(':memory:');t.after(()=>store.close());
  const peer=store.register(registration('claude','user',{cwd:directory}));
  const capture={host:'claude' as const,sessionId:'user',nativePid:2,nativeGeneration:'2',sourcePid:3,sourceGeneration:'3',env:{CLAUDE_CONFIG_DIR:user.configHome,HTTPS_PROXY:'http://original'}};
  let checks=0;const dependencies={ancestors:async()=>{checks++;return[{pid:3,parentPid:2,name:'node.exe',startedAt:'3'},{pid:2,parentPid:1,name:'claude.exe',image:process.execPath,startedAt:'2'}];},version:async()=> '2.1.316 (Claude Code)'};
  await captureUserLaunch(directory,capture,peer,2,dependencies);
  assert.equal((await captureUserLaunch(directory,{...capture,env:{...capture.env,HTTPS_PROXY:'http://changed'}},peer,2,dependencies)).cached,true);assert.equal(checks,1);assert.equal(profileState(directory).profiles[0]!.env.HTTPS_PROXY,'http://original');
  await captureUserLaunch(directory,{...capture,force:true,env:{...capture.env,HTTPS_PROXY:'http://changed'}},peer,2,dependencies);assert.equal(checks,2);assert.equal(profileState(directory).profiles[0]!.env.HTTPS_PROXY,'http://changed');
  const owned=await captureUserLaunch(directory,capture,peer,2,{...dependencies,owned:true});assert.equal(owned.owned,true);assert.equal(profileState(directory).profiles.length,0);assert.equal(profileState(directory).observations?.[0]?.owned,true);
  assert.equal((await captureUserLaunch(directory,capture,peer,2,dependencies)).owned,true);assert.equal(checks,3);
});

test('捕获在异步核验后合并其他窗口的新记录，观测与模板共用最终记录 ID',async t=>{
  const directory=temporary(t),original=profile(directory,{host:'claude'});saveUserProfile(directory,original);
  const store=new Store(':memory:');t.after(()=>store.close());const peer=store.register(registration('claude','new-session',{cwd:directory}));
  const capture={host:'claude' as const,sessionId:'new-session',nativePid:2,nativeGeneration:'native',sourcePid:3,sourceGeneration:'source',env:{CLAUDE_CONFIG_DIR:original.configHome}};
  const other=profile(directory,{id:'other-window',host:'codex'});
  const result=await captureUserLaunch(directory,capture,peer,2,{
    ancestors:async()=>[{pid:3,parentPid:2,name:'node',startedAt:'source'},{pid:2,parentPid:1,name:'claude',image:process.execPath,startedAt:'native'}],
    version:async()=>{saveUserProfile(directory,other);return'2.1.316 (Claude Code)';}
  });
  const state=profileState(directory);
  assert.equal(result.profile?.id,original.id);assert.equal(state.profiles.length,2);
  assert.equal(state.profiles.find(value=>value.id===other.id)?.host,'codex');
  assert.equal(state.observations?.[0]?.id,result.profile?.id);assert.equal(state.observations?.[0]?.sourceSession,'new-session');
});
