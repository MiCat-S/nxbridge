import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import {mkdirSync,writeFileSync,realpathSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import {temporaryDirectory} from '../tests/support/temporary.js';
import {overrideEnvironment} from '../tests/support/environment.js';
import {releaseNativeTestLaunches} from '../tests/support/native-launch.js';
import {DEFAULT_CONFIG} from '../config/defaults.js';
import {writeConfiguration} from '../config/configuration.js';
import {preparePlugins} from '../install/setup.js';
import {brokerCall,ensureBroker} from '../ipc/ipc.js';
import {selectHostLaunch,spawnSelectedHost} from '../hosts/host-launch.js';
import {rememberOwnedHost} from '../process/owned-processes.js';
import {PACKAGE_ROOT} from '../shared/package-location.js';
import {delay} from '../shared/time.js';

test('官方 SDK 输入按实时开关记录用户活动，关闭后不沿用旧策略',{skip:!['win32','linux','darwin'].includes(process.platform),timeout:120000},async t=>{
  const temp=temporaryDirectory(),root=temp.directory,home=path.join(root,'bridge'),claudeHome=path.join(root,'claude'),codexHome=path.join(root,'codex');
  for(const directory of [home,claudeHome,codexHome])mkdirSync(directory,{recursive:true});
  const sessionId=randomUUID(),launchId=randomUUID(),errors:string[]=[],results:any[]=[];let output='',stderr='',passed=false;
  const model=http.createServer(async(req,res)=>{try{
    let raw='';for await(const chunk of req)raw+=chunk;
    if(!req.url?.includes('/v1/messages')||req.url.includes('count_tokens')){res.writeHead(200,{'content-type':'application/json'});res.end('{"input_tokens":1,"data":[]}');return;}
    const body=JSON.parse(raw),id=randomUUID();
    res.writeHead(200,{'content-type':'text/event-stream'});
    for(const event of [{type:'message_start',message:{id,type:'message',role:'assistant',model:body.model,content:[],stop_reason:null,stop_sequence:null,usage:{input_tokens:10,output_tokens:1}}},{type:'content_block_start',index:0,content_block:{type:'text',text:''}},{type:'content_block_delta',index:0,delta:{type:'text_delta',text:'SDK_INPUT_DONE'}},{type:'content_block_stop',index:0},{type:'message_delta',delta:{stop_reason:'end_turn',stop_sequence:null},usage:{output_tokens:2}},{type:'message_stop'}])res.write('event: '+event.type+'\ndata: '+JSON.stringify(event)+'\n\n');
    res.end();
  }catch(error){errors.push(String(error));res.writeHead(500);res.end(String(error));}});
  await new Promise<void>(resolve=>model.listen(0,'127.0.0.1',resolve));
  const env={NXBRIDGE_HOME:home,CLAUDE_CONFIG_DIR:claudeHome,CODEX_HOME:codexHome,ANTHROPIC_API_KEY:'sdk-prompt-local-only',ANTHROPIC_BASE_URL:`http://127.0.0.1:${(model.address() as any).port}`,DISABLE_AUTOUPDATER:'1',DISABLE_TELEMETRY:'1',CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC:'1'},restore=overrideEnvironment(env);
  t.after(async()=>{
    try{
      if(!passed)t.diagnostic(JSON.stringify({stderr,output:output.slice(-2000),results,errors,status:await brokerCall('status',{}, {home,start:false}).catch(()=>undefined)}));
      assert.deepEqual(await releaseNativeTestLaunches(home,record=>record.proof.launchId===launchId),[]);
      try{await brokerCall('shutdown',{releaseOwned:false},{home,start:false});}catch{}
      await temp.cleanup();
    }finally{model.closeAllConnections();await new Promise<void>(resolve=>model.close(()=>resolve()));restore();}
  });
  const config={...DEFAULT_CONFIG,implicit:'never' as const,compatibilityWake:'strict' as const,claudeHome,codexHome};
  writeFileSync(path.join(home,'config.json'),JSON.stringify(config),'utf8');
  const projects=Object.fromEntries([root,realpathSync(root)].map(directory=>[directory.replaceAll('\\','/'),{hasTrustDialogAccepted:true}]));
  writeFileSync(path.join(claudeHome,'.claude.json'),JSON.stringify({hasCompletedOnboarding:true,customApiKeyResponses:{approved:[env.ANTHROPIC_API_KEY.slice(-20)],rejected:[]},projects}),'utf8');
  writeFileSync(path.join(claudeHome,'settings.json'),JSON.stringify({crossSessionInbound:'accept',env:{ANTHROPIC_API_KEY:env.ANTHROPIC_API_KEY,ANTHROPIC_BASE_URL:env.ANTHROPIC_BASE_URL,CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC:'1'}}),'utf8');
  const marketplace=await preparePlugins(home,{packageRoot:path.join(PACKAGE_ROOT,'publish')});(await ensureBroker(home)).close();
  const launch=selectHostLaunch('claude',config,{home,cwd:root}),child=spawnSelectedHost(launch,['--print','--input-format','stream-json','--output-format','stream-json','--verbose','--session-id',sessionId,'--plugin-dir',path.join(marketplace,'plugins/claude'),'--model','claude-sonnet-4-6'],{stdio:['pipe','pipe','pipe']});
  await rememberOwnedHost(home,child,'claude','host-control',launchId,claudeHome);
  child.stderr!.on('data',chunk=>stderr=(stderr+chunk.toString()).slice(-3000));
  child.stdout!.on('data',chunk=>{output+=chunk.toString();let newline;while((newline=output.indexOf('\n'))>=0){const line=output.slice(0,newline);output=output.slice(newline+1);try{const event=JSON.parse(line);if(event.type==='result')results.push(event);}catch{}}});
  const status=()=>brokerCall<any>('status',{}, {home});
  const wait=async(check:()=>boolean|Promise<boolean>)=>{const until=Date.now()+25000;while(!await check()){assert.ok(Date.now()<until,'SDK 输入未在原生宿主完成；'+stderr);await delay(50);}};
  const submit=async(text:string)=>{
    const count=results.length;child.stdin!.write(JSON.stringify({type:'user',message:{role:'user',content:text}})+'\n');
    await wait(()=>results.length>count);assert.equal(results.at(-1).is_error,false);
    await wait(async()=>(await status()).peers.some((peer:any)=>peer.sessionId===sessionId&&peer.state==='ready'));
    return(await status()).peers.find((peer:any)=>peer.sessionId===sessionId);
  };
  const off=await submit('默认关闭的 SDK 输入');assert.equal(off.activityAt,undefined);
  writeConfiguration(home,[{key:'hosts.claude.sdk_user_prompt',value:true}],'terminal');
  const enabled=await submit('第三方界面的 SDK 输入');assert.ok(enabled.activityAt>0,'开启后必须通过真实 prompt 回执记录活动');
  writeConfiguration(home,[{key:'hosts.claude.sdk_user_prompt',value:false}],'terminal');
  const disabled=await submit('关闭后的 SDK 输入');assert.equal(disabled.activityAt,enabled.activityAt,'同一进程下一次输入必须使用关闭后的策略');
  assert.deepEqual(errors,[]);assert.doesNotMatch(stderr,/hook skipped|config_human_origin_required/);passed=true;
  t.diagnostic(JSON.stringify({sdkDefaultIgnored:true,sdkEnabledRecorded:true,sdkDisabledAgainIgnored:true,sameSession:true,realModelCalls:0}));
});
