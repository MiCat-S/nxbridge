import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import { mkdirSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { readModelBody } from './model-http-fixture.js';
import { stringify } from 'smol-toml';
import { registration } from '../tests/support/registration.js';
import { temporaryDirectory } from '../tests/support/temporary.js';
import { releaseNativeTestLaunches } from '../tests/support/native-launch.js';
import {DEFAULT_CONFIG} from '../config/defaults.js';
import {delay} from '../shared/time.js';
import {privateDirectory} from '../process/permissions.js';
import { codexTerminalVariables, selectHostLaunch, spawnSelectedHost } from '../hosts/host-launch.js';
import { connectAppServer } from '../hosts/codex/adapter.js';
import { configClient } from '../hosts/codex/stdio-codex.js';
import { rememberOwnedHost } from '../process/owned-processes.js';
import { startTerminal,type Terminal } from './portable-terminal-fixture.js';
import { captureUserLaunch, profileState } from '../hosts/launch-profiles.js';
import { nativeDescendant } from '../process/process.js';
import { Store } from '../storage/store.js';

test('官方 TUI 与已记录原生启动环境的专用后台 UA 逐字一致，只读控制握手不改变用户身份',{timeout:120000},async t=>{
  const temp=temporaryDirectory(),root=temp.directory,home=path.join(root,'bridge'),codexHome=path.join(root,'codex'),launchId=randomUUID();
  for(const directory of [home,codexHome])mkdirSync(directory);
  const config={...DEFAULT_CONFIG,codexHome,...(process.env.NXBRIDGE_TEST_CODEX_BINARY?{codexBinary:process.env.NXBRIDGE_TEST_CODEX_BINARY}:{})};
  const requests:{ua:string;originator:string;body:any}[]=[],errors:string[]=[],store=new Store(':memory:');let terminal:Terminal|undefined,output='',rpc:Awaited<ReturnType<typeof configClient>>|undefined;
  const model=http.createServer(async(req,res)=>{try{
    if(!req.url?.includes('/responses')){res.writeHead(200,{'content-type':'application/json'});res.end('{"data":[]}');return;}
    const raw=await readModelBody(req);
    const body=JSON.parse(raw.toString());requests.push({ua:String(req.headers['user-agent']),originator:String(req.headers.originator),body});
    const id='identity-'+requests.length,item={type:'message',id:'msg-'+id,role:'assistant',status:'completed',content:[{type:'output_text',text:'IDENTITY_LOCAL_DONE'}]};
    res.writeHead(200,{'content-type':'text/event-stream'});
    for(const event of [{type:'response.created',response:{id,status:'in_progress',output:[]}},{type:'response.output_item.added',output_index:0,item},{type:'response.output_item.done',output_index:0,item},{type:'response.completed',response:{id,status:'completed',output:[item],usage:{input_tokens:1,output_tokens:1,total_tokens:2}}}])res.write('data: '+JSON.stringify(event)+'\n\n');
    res.end();
  }catch(error){errors.push(String(error));res.writeHead(500);res.end(String(error));}});
  await new Promise<void>(resolve=>model.listen(0,'127.0.0.1',resolve));
  t.after(async()=>{
    await rpc?.close();await terminal?.close();const notes=await releaseNativeTestLaunches(home,record=>record.proof.launchId===launchId);assert.deepEqual(notes,[]);
    model.closeAllConnections();await new Promise<void>(resolve=>model.close(()=>resolve()));store.close();await temp.cleanup();
  });
  writeFileSync(path.join(codexHome,'config.toml'),stringify({
    model:'gpt-5.1-codex',model_provider:'identity_local',model_reasoning_effort:'low',approval_policy:'never',sandbox_mode:'read-only',web_search:'disabled',suppress_unstable_features_warning:true,check_for_update_on_startup:false,
    analytics:{enabled:false},features:{apps:false,remote_plugin:false,daemon_auto_start:false,code_mode:false},
    model_providers:{identity_local:{name:'本地身份验收',base_url:'http://127.0.0.1:'+(model.address() as any).port+'/v1',wire_api:'responses',requires_openai_auth:false,request_max_retries:0,stream_max_retries:0}},
    projects:{[root]:{trust_level:'trusted'}}
  }),'utf8');
  const launch=selectHostLaunch('codex',config,{home,cwd:root}),env:NodeJS.ProcessEnv={...launch.env,TERM:'xterm-256color',COLORTERM:'truecolor',OPENAI_API_KEY:'identity-local-only'};
  const wait=async(check:()=>boolean)=>{const end=Date.now()+25000;while(!check()){if(Date.now()>end)assert.fail('身份验收未收到本地请求：'+errors.join(';')+'\n'+output+'\n'+terminal?.output.slice(-3500));await delay(50);}};
  const args=[...launch.executable.prefix,'--no-daemon','--no-alt-screen','IDENTITY_OFFICIAL_TUI'];
  terminal=await startTerminal(root,home,launch.executable.command,args,root,env);
  await wait(()=>requests.some(r=>JSON.stringify(r.body.input).includes('IDENTITY_OFFICIAL_TUI')));
  const official=requests.find(r=>JSON.stringify(r.body.input).includes('IDENTITY_OFFICIAL_TUI'))!;
  const native=terminal.identity,peer=store.register(registration('codex','identity-tui',{cwd:root}));
  await captureUserLaunch(home,{host:'codex',sessionId:peer.sessionId!,nativePid:native.pid,nativeGeneration:native.startedAt,sourcePid:native.pid,sourceGeneration:native.startedAt,env:Object.fromEntries(Object.entries(env).filter((v):v is [string,string]=>v[1]!==undefined))},peer,native.pid);
  await terminal?.close();terminal=undefined;assert.deepEqual(await releaseNativeTestLaunches(home,record=>record.proof.launchId===launchId),[]);
  const run=path.join(root,'run');await privateDirectory(run);const endpoint='unix://'+path.join(run,'identity.sock');
  const profileConfig={...DEFAULT_CONFIG},recorded=selectHostLaunch('codex',profileConfig,{home,cwd:root});assert.equal(recorded.method,'profile');
  const child=spawnSelectedHost(recorded,['app-server','--listen',endpoint],{stdio:['ignore','ignore','pipe']});
  child.stderr!.on('data',chunk=>output=(output+chunk.toString()).slice(-3500));await rememberOwnedHost(home,child,'codex','codex-runtime',launchId,codexHome);
  for(let attempt=0;attempt<50&&!rpc;attempt++){try{rpc=await connectAppServer(endpoint,config,undefined,home);}catch(error){if(attempt===49)throw error;await delay(100);}}
  const turn=async(label:string)=>{
    try{
      const {thread}=await rpc!.request('thread/start',{cwd:root,approvalPolicy:'never',sandbox:'read-only'});
      await rpc!.request('turn/start',{threadId:thread.id,input:[{type:'text',text:label}]});
      await wait(()=>requests.some(r=>JSON.stringify(r.body.input).includes(label)));
      return requests.find(r=>JSON.stringify(r.body.input).includes(label))!;
    }catch(error){
      t.diagnostic(JSON.stringify({phase:label,output,errors,requestCount:requests.length}));throw error;
    }
  };
  const dedicated=await turn('IDENTITY_DEDICATED');
  const readOnly=await connectAppServer(endpoint,profileConfig,undefined,home,{readOnly:true});
  try{await readOnly.request('thread/loaded/list');}finally{await readOnly.close();}
  const afterReadOnly=await turn('IDENTITY_AFTER_READ_ONLY');await rpc!.close();rpc=undefined;
  const claudeFirstHome=path.join(root,'claude-first'),claudeHome=path.join(root,'claude');mkdirSync(claudeFirstHome);mkdirSync(claudeHome);
  const claudeLaunch=selectHostLaunch('claude',{...DEFAULT_CONFIG,claudeHome},{home:claudeFirstHome,cwd:root});
  claudeLaunch.env.DISABLE_AUTOUPDATER='1';
  for(const key of codexTerminalVariables){delete claudeLaunch.env[key];if(env[key]!==undefined)claudeLaunch.env[key]=env[key];}
  const claude=spawnSelectedHost(claudeLaunch,['--print','--input-format','stream-json','--output-format','stream-json','--verbose'],{stdio:['pipe','ignore','pipe']});
  claude.stderr!.on('data',chunk=>output=(output+chunk.toString()).slice(-3500));await rememberOwnedHost(home,claude,'claude','host-control',launchId,claudeHome);
  const claudeNative=await nativeDescendant(claude.pid!,'claude',0),claudePeer=store.register(registration('claude','identity-claude-first',{cwd:root}));
  await captureUserLaunch(claudeFirstHome,{host:'claude',sessionId:claudePeer.sessionId!,nativePid:claudeNative.pid,nativeGeneration:claudeNative.startedAt,sourcePid:claudeNative.pid,sourceGeneration:claudeNative.startedAt,env:Object.fromEntries(Object.entries(claudeLaunch.env).filter((v):v is [string,string]=>v[1]!==undefined))},claudePeer,claudeNative.pid);
  assert.equal(profileState(claudeFirstHome).profiles.some(value=>value.host==='codex'),false);
  const firstLaunch=selectHostLaunch('codex',config,{home:claudeFirstHome,cwd:root,requesterSession:claudePeer.sessionId!}),firstAddress='unix://'+path.join(run,'claude-first.sock');
  const firstChild=spawnSelectedHost(firstLaunch,['app-server','--listen',firstAddress],{stdio:'ignore'});await rememberOwnedHost(home,firstChild,'codex','codex-runtime',launchId,codexHome);
  for(let attempt=0;attempt<50&&!rpc;attempt++){try{rpc=await connectAppServer(firstAddress,config,undefined,home);}catch(error){if(attempt===49)throw error;await delay(100);}}
  const claudeFirst=await turn('IDENTITY_CLAUDE_FIRST');await rpc!.close();rpc=undefined;
  const beforeSetup=requests.length;rpc=await configClient(profileConfig,home);await rpc.request('config/read',{includeLayers:false});await rpc.close();rpc=undefined;
  assert.equal(requests.length,beforeSetup,'安装控制只读取配置，不发起模型轮次');
  const split=(ua:string)=>{
    const match=/^(.+? \([^)]*\)) (.*)( \(codex-tui; ([^)]+)\))$/.exec(ua);assert.ok(match,'实际 UA 缺少官方 TUI 后缀：'+ua);
    return{stable:match[1]!+match[3]!,terminal:match[2]!,version:match[4]!};
  };
  const baseline=split(official.ua);
  for(const actual of [official,dedicated,afterReadOnly,claudeFirst]){
    assert.equal(actual.originator,official.originator);assert.equal(actual.ua,official.ua,'保留真实用户启动环境后 UA 必须逐字一致');
    assert.doesNotMatch(actual.ua,/nxbridge/);assert.equal(actual.originator,'codex-tui');
  }
  assert.deepEqual(errors,[]);
  t.diagnostic(JSON.stringify({version:baseline.version,official:official.ua,dedicated:dedicated.ua,afterReadOnly:afterReadOnly.ua,claudeFirst:claudeFirst.ua,byteEqual:true,setupModelCalls:requests.length-beforeSetup,profileTerminal:recorded.env.TERM}));
});
