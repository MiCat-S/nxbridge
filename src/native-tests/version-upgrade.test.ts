import { overrideEnvironment } from '../tests/support/environment.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import { promisify, stripVTControlCharacters } from 'node:util';
import { VERSION } from '../version.js';
import {DEFAULT_CONFIG} from '../config/defaults.js';
import { brokerCall } from '../ipc/ipc.js';
import { processIdentity } from '../process/process.js';
import { stopOwnedProcess } from '../process/process-stop.js';
import { reserveBrokerStartup } from '../broker/broker-startup.js';
import { activeRuntime, fileHashes, verifyPublish } from '../install/runtime-install.js';
import { installedCacheDirectories } from '../install/installation.js';
import {PACKAGE_ROOT} from '../shared/package-location.js';
import {readJson} from '../shared/files.js';
import {resolveCli,runCli} from '../process/host-command.js';
import { temporaryDirectory } from '../tests/support/temporary.js';
import { publishEnvironment } from './publish-fixture.js';
import { NativeTerminal } from './terminal-fixture.js';

const execute=promisify(execFile),previousPublish=process.env.NXBRIDGE_TEST_PREVIOUS_PUBLISH,legacyUpdate=process.env.NXBRIDGE_TEST_LEGACY_UPDATE==='1';

                                         
test('实际旧构建安装升级：两端缓存、原生重载、运行时保留和故障期间普通输入',{skip:process.platform!=='win32'||!previousPublish,timeout:170000},async t=>{
  const temp=temporaryDirectory(),root=temp.directory,home=path.join(root,'bridge'),claudehome=path.join(root,'claude'),codexhome=path.join(root,'codex'),bin=path.join(root,'bin'),oldSource=path.join(root,'old-publish');
  for(const directory of [home,claudehome,codexhome,bin,oldSource])mkdirSync(directory,{recursive:true});
  const oldManifest=verifyPublish(previousPublish!),sameVersion=oldManifest.version===VERSION;
  assert.ok(oldManifest.version==='0.1.0'||sameVersion,'仅接受已支持的旧发布版本');
  assert.notEqual(oldManifest.buildId,verifyPublish(path.join(PACKAGE_ROOT,'publish')).buildId,'基线必须是真正不同的旧构建');
  assert.equal(legacyUpdate&&sameVersion,false,'旧安装器缺陷夹具只用于跨版本旧包');
  for(const relative of [...Object.keys(oldManifest.files),'publish.json']){const target=path.join(oldSource,relative);mkdirSync(path.dirname(target),{recursive:true});cpSync(path.join(previousPublish!,relative),target);}
  const requests:any[]=[],errors:string[]=[],httpCalls:{url:string|undefined;at:number}[]=[],nativeLog=path.join(root,'native-debug.log');let phase=0,discover=false,legacySend=false,terminal:NativeTerminal|undefined,completed=false;
  const model=http.createServer(async(req,res)=>{try{
    httpCalls.push({url:req.url,at:Date.now()});
    let raw='';for await(const chunk of req)raw+=chunk;
    if(!req.url?.includes('/v1/messages')||req.url.includes('count_tokens')){res.writeHead(200,{'content-type':'application/json'});res.end('{"input_tokens":1,"data":[]}');return;}
    const body=JSON.parse(raw);requests.push(body);const text='VERSION_UPGRADE_DONE_'+phase,searchId='upgrade-search-'+phase,sendId='upgrade-legacy-send-'+phase;
    const results=(body.messages??[]).flatMap((message:any)=>Array.isArray(message.content)?message.content:[]),search=discover&&!results.some((value:any)=>value.type==='tool_result'&&value.tool_use_id===searchId);
    const send=legacySend&&!results.some((value:any)=>value.type==='tool_result'&&value.tool_use_id===sendId),toolUse=search||send;
    const input=send?{to:'nxbridge:codex',message:'旧 Mod 升级后保持原消息 ID'}:{query:'select:mcp__nxbridge__select_partner'},content=toolUse?{type:'tool_use',id:send?sendId:searchId,name:send?'SendMessage':'ToolSearch',input}:{type:'text',text};
    const reply={id:'upgrade-'+requests.length,type:'message',role:'assistant',model:body.model,content:[content],stop_reason:toolUse?'tool_use':'end_turn',stop_sequence:null,usage:{input_tokens:10,output_tokens:5}};
    if(!body.stream){res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify(reply));return;}
    res.writeHead(200,{'content-type':'text/event-stream'});
    for(const event of [{type:'message_start',message:{...reply,content:[],stop_reason:null}},{type:'content_block_start',index:0,content_block:toolUse?{...content,input:{}}:{type:'text',text:''}},{type:'content_block_delta',index:0,delta:toolUse?{type:'input_json_delta',partial_json:JSON.stringify(input)}:{type:'text_delta',text}},{type:'content_block_stop',index:0},{type:'message_delta',delta:{stop_reason:reply.stop_reason,stop_sequence:null},usage:{output_tokens:5}},{type:'message_stop'}])res.write('event: '+event.type+'\ndata: '+JSON.stringify(event)+'\n\n');res.end();
  }catch(error){errors.push(String(error));res.writeHead(500);res.end(String(error));}});
  await new Promise<void>(resolve=>model.listen(0,'127.0.0.1',resolve));
  const overrides={NXBRIDGE_HOME:home,CLAUDE_CONFIG_DIR:claudehome,CODEX_HOME:codexhome,ANTHROPIC_API_KEY:'nxbridge-local-upgrade-key',ANTHROPIC_BASE_URL:`http://127.0.0.1:${(model.address() as any).port}`,DISABLE_AUTOUPDATER:'1',DISABLE_TELEMETRY:'1',CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC:'1'},restoreEnvironment=overrideEnvironment(overrides);
  t.after(async()=>{try{
    if(!completed){
      let status;try{status=await brokerCall('status',{}, {home,start:false,timeout:2000});}catch(error){status=String(error);}
      const debug=existsSync(nativeLog)?readFileSync(nativeLog,'utf8').split(/\r?\n/).filter(line=>/MCP server.*(?:connect|error|fail|timeout)|(?:request|hook).*(?:start|end|fail|timeout)|API Error/i.test(line)).slice(-30):[];
      t.diagnostic(JSON.stringify({runtime:activeRuntime(home),requests:requests.length,httpCalls,status,debug,brokerLog:existsSync(path.join(home,'run','broker.log'))?readFileSync(path.join(home,'run','broker.log'),'utf8').slice(-3500):'',tools:requests.at(-1)?.tools?.map((tool:any)=>tool.name),messages:requests.at(-1)?.messages?.slice(-4),terminal:stripVTControlCharacters(terminal?.output??'').slice(-2500)}));
    }
    await terminal?.close();try{await brokerCall('shutdown',{releaseOwned:false},{home,start:false});}catch{}await temp.cleanup();
  }finally{model.closeAllConnections();await new Promise<void>(resolve=>model.close(()=>resolve()));restoreEnvironment();}});
  writeFileSync(path.join(home,'config.json'),JSON.stringify({...DEFAULT_CONFIG,implicit:'never',compatibilityWake:'strict',claudeHome:claudehome,codexHome:codexhome}),'utf8');
  writeFileSync(path.join(claudehome,'.claude.json'),JSON.stringify({hasCompletedOnboarding:true,customApiKeyResponses:{approved:[overrides.ANTHROPIC_API_KEY.slice(-20)],rejected:[]},projects:{[root.replaceAll('\\','/')]:{hasTrustDialogAccepted:true}}}),'utf8');
  writeFileSync(path.join(claudehome,'settings.json'),JSON.stringify({crossSessionInbound:'accept',autoUpdatesChannel:'stable',env:{ANTHROPIC_API_KEY:overrides.ANTHROPIC_API_KEY,ANTHROPIC_BASE_URL:overrides.ANTHROPIC_BASE_URL,CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC:'1'}}),'utf8');
  writeFileSync(path.join(codexhome,'config.toml'),'# 跨版本保留用户设置\nmodel_verbosity = "low"\n','utf8');
  const env=publishEnvironment(home,bin),run=async(entry:string,args:string[],cwd=root)=>JSON.parse((await execute(process.execPath,['--no-warnings',entry,...args],{cwd,env,windowsHide:true,timeout:75000,maxBuffer:8*1024*1024})).stdout);
  const installed=await run(path.join(oldSource,'nxbridge.mjs'),['setup','--bin-dir',bin]);assert.equal(installed.runtime.buildId,oldManifest.buildId);
  const launcher=path.join(home,'bin','nxbridge.cjs'),before=activeRuntime(home)!;
  const inventory=async(host:'claude'|'codex')=>{const value=JSON.parse(await runCli(host,['plugin','list','--json'],{home}));return Array.isArray(value)?value:value.installed;};
  const baseline=await Promise.all(['claude','codex'].map(async host=>({host,plugins:await inventory(host as 'claude'|'codex')})));
  for(const host of ['claude','codex'] as const){const caches=installedCacheDirectories(host==='claude'?claudehome:codexhome,host);assert.ok(caches.some(directory=>path.basename(directory)===oldManifest.version));}
  const cli=resolveCli('claude');terminal=await NativeTerminal.start(root,home,cli.command,[...cli.prefix,'--model','claude-sonnet-4-6','--debug-file',nativeLog],root,{...env,TERM:'xterm-256color',COLORTERM:'truecolor'});
                                                  
  const oldStartupAt=Date.now();await terminal.wait(()=>existsSync(nativeLog)&&/nxbridge@nxbridge-local session\.start settled/.test(readFileSync(nativeLog,'utf8')),'旧构建的原生 Mod 初始化未完成',35000);const oldNativeStartupMs=Date.now()-oldStartupAt;
  const turn=async(text:string,timeout=20000)=>{const offset=terminal!.output.length;await terminal!.prompt(text);await terminal!.wait(()=>terminal!.output.slice(offset).includes('VERSION_UPGRADE_DONE_'+phase),'原生升级验收轮次未完成',timeout);};
  await turn('初始化旧版安装的原生插件');assert.ok(requests.some(body=>body.tools?.some((tool:any)=>tool.name==='mcp__nxbridge__answer_question')));
  const oldNative=terminal.identity;
  const oldStatus=await brokerCall('status',{}, {home}),oldClaude=oldStatus.peers.find((peer:any)=>peer.host==='claude'),counterpart=await processIdentity(process.pid);
  assert.ok(oldClaude);
  const codex=await brokerCall('register',{host:'codex',sessionId:'version-upgrade-counterpart',cwd:root,kind:'root',permission:'prompting',endpoint:{mode:'embedded',address:'',epoch:'upgrade-counterpart',pid:counterpart.pid,procStart:counterpart.startedAt}},{home});
  const pair=await brokerCall('pair',{claude:oldClaude.id,codex:codex.id},{home});
  const reload=async()=>{const offset=terminal!.output.length;await terminal!.prompt('/reload-plugins');await terminal!.wait(()=>/Reloaded:/.test(stripVTControlCharacters(terminal!.output.slice(offset))),'原生重载未返回');};
  const newModTurn=async(text:string)=>{
    await reload();phase++;const first=requests.length;discover=true;try{await turn(text);}finally{discover=false;}
                                                      
    return requests.slice(first).some(body=>(body.messages??[]).flatMap((message:any)=>Array.isArray(message.content)?message.content:[]).some((value:any)=>value.type==='tool_result'&&value.tool_use_id==='upgrade-search-'+phase&&!value.is_error&&Array.isArray(value.content)&&value.content.some((entry:any)=>entry.type==='tool_reference'&&entry.tool_name==='mcp__nxbridge__select_partner')));
  };
  let legacyModLoaded:boolean|undefined;
  if(legacyUpdate){
    const legacy=await run(launcher,['update','--from',path.join(PACKAGE_ROOT,'publish'),'--bin-dir',bin]);assert.equal(legacy.installed,true,JSON.stringify(legacy));
                                          
    assert.equal(readJson<any>(path.join(home,'marketplace','.claude-plugin','marketplace.json')).plugins[0].version,'0.1.0');
    legacyModLoaded=await newModTurn('旧命令更新后检查实际插件加载');
  }
  const codexBefore=Object.fromEntries(installedCacheDirectories(codexhome,'codex').map(directory=>[directory,fileHashes(directory)]));
  const delivery=path.join(PACKAGE_ROOT,'publish'),updated=await run(path.join(delivery,'nxbridge.mjs'),['update','--from','.','--bin-dir',bin],delivery);assert.equal(updated.installed,true,JSON.stringify(updated));
  const current=activeRuntime(home)!;assert.equal(current.version,VERSION);assert.equal(current.previous?.buildId,before.buildId);assert.ok(existsSync(before.entry));
  assert.equal((await execute(process.execPath,[launcher,'--version'],{env,windowsHide:true,timeout:10000})).stdout.trim(),'nxbridge '+VERSION);
  const caches=Object.fromEntries((['claude','codex'] as const).map(host=>[host,installedCacheDirectories(host==='claude'?claudehome:codexhome,host)]));
  for(const host of ['claude','codex'] as const){assert.ok(caches[host]!.length);assert.ok(caches[host]!.some(directory=>path.basename(directory)===VERSION));for(const directory of caches[host]!){
    if(host==='codex'&&codexBefore[directory]&&!sameVersion)assert.deepEqual(fileHashes(directory),codexBefore[directory],'仍被旧宿主引用的低版本缓存不能同步成新字节');
    else{
      assert.equal(readJson<any>(path.join(directory,host==='claude'?'.claude-plugin':'.codex-plugin','plugin.json')).version,VERSION);
      if(sameVersion){const actual=fileHashes(directory);for(const [relative,hash]of Object.entries(fileHashes(path.join(home,'marketplace','plugins',host))))assert.equal(actual[relative],hash,'同版本缓存必须同步已生成运行时路径的发布字节：'+relative);}
    }
  }}
  for(const {host,plugins} of baseline){const after=await inventory(host as 'claude'|'codex'),old=plugins.find((plugin:any)=>(plugin.id??plugin.pluginId)==='nxbridge@nxbridge-local'),fresh=after.find((plugin:any)=>(plugin.id??plugin.pluginId)==='nxbridge@nxbridge-local');assert.ok(old&&fresh);assert.equal(fresh.enabled,old.enabled,host);assert.equal(fresh.version,VERSION,host+' '+JSON.stringify(fresh));}
  assert.equal(readJson<any>(path.join(home,'marketplace','.claude-plugin','marketplace.json')).plugins[0].version,VERSION);
  if(!legacyUpdate){
    phase++;const first=requests.length;legacySend=true;try{await turn('重载之前使用旧 Mod 向原搭档发送消息');}finally{legacySend=false;}
    const rendered=requests.slice(first).flatMap(body=>(body.messages??[]).flatMap((message:any)=>Array.isArray(message.content)?message.content:[])).find((value:any)=>value.type==='tool_result'&&value.tool_use_id==='upgrade-legacy-send-'+phase);
    assert.ok(rendered,'实际旧 Mod 没有返回发送结果');const result=JSON.stringify(rendered),id=/message_id=([0-9a-f-]{36})/.exec(result)?.[1];assert.ok(id,result);assert.doesNotMatch(result,/message_id=undefined/);
    const saved=await brokerCall('message',{message_id:id},{home});assert.equal(saved.body,'旧 Mod 升级后保持原消息 ID');
  }
  assert.ok(await newModTurn('新版交付包更新并重载后检查插件'),'新版 Mod 原生选择工具未进入真实模型请求');
  const status=await brokerCall('status',{}, {home});assert.ok(status.pairs.some((value:any)=>value.id===pair.id));assert.ok(status.peers.some((peer:any)=>peer.id===oldClaude.id&&peer.sessionId===oldClaude.sessionId));
  assert.equal((await processIdentity(oldNative.pid)).startedAt,oldNative.startedAt);assert.match(readFileSync(path.join(codexhome,'config.toml'),'utf8'),/model_verbosity = "low"/);
  for(const body of requests)assert.doesNotMatch(JSON.stringify(body.messages),/\[nxbridge system_notice [^\]]+\]\\nundefined/,'仍加载旧 Mod 时也不能把通知信号渲染为 undefined');
  const keeper=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore',windowsHide:true});await once(keeper,'spawn');const keeperIdentity=await processIdentity(keeper.pid!);
  const release=await reserveBrokerStartup(home,keeperIdentity);let ordinaryTurnMs=0;
  try{
    const ping=await brokerCall('ping',{}, {home,start:false});await stopOwnedProcess({pid:ping.pid,startedAt:ping.runtime.generation});
    phase++;const started=Date.now();await turn('协调器暂时离线时继续普通工作',8000);ordinaryTurnMs=Date.now()-started;
  }finally{await release();await stopOwnedProcess(keeperIdentity);}
  assert.equal(errors.length,0);completed=true;t.diagnostic(JSON.stringify({from:oldManifest.buildId,to:current.buildId,sameVersion,oldNativeStartupMs,pair:pair.id,member:oldClaude.id,nativePid:oldNative.pid,nativeReload:true,relativeFrom:true,legacyRecovery:legacyUpdate,legacyModLoaded,cacheDirectories:caches,previousRuntimeRetained:true,ordinaryTurnMs,realModelCalls:0}));
});
