import { overrideEnvironment } from '../tests/support/environment.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { temporaryDirectory } from '../tests/support/temporary.js';
import { setupPublish } from './publish-fixture.js';
import { brokerCall } from '../ipc/ipc.js';
import {DEFAULT_CONFIG} from '../config/defaults.js';
import {delay} from '../shared/time.js';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { processIdentity } from '../process/process.js';
import { preparePlugins } from '../install/setup.js';
import { claudeChild } from '../hosts/claude/claude-child.js';
import { stopOwnedProcess } from '../process/process-stop.js';
import { writeConfiguration } from '../config/configuration.js';
import { resolveCli } from '../process/host-command.js';

test('新自有 Claude 使用原生绕过和会话接收设置，跨权限来信直接执行且不改用户设置',{skip:process.platform!=='win32'&&(process.platform!=='linux'||process.getuid?.()===0),timeout:150000},async t=>{
  const temp=temporaryDirectory(),root=temp.directory,home=path.join(root,'bridge'),claudehome=path.join(root,'claude'),codexhome=path.join(root,'codex'),proof=path.join(root,'proof.txt'),script=path.join(root,'action.mjs');
  for(const directory of [home,claudehome,codexhome])mkdirSync(directory);
  writeFileSync(script,`import{writeFileSync}from'node:fs';writeFileSync(${JSON.stringify(proof)},'AUTONOMOUS_ACTION');`,'utf8');
  const errors:string[]=[];let requests=0,status:any,passed=false,phase=1;
  const model=http.createServer(async(req,res)=>{try{
    let raw='';for await(const chunk of req)raw+=chunk;
    if(!req.url?.includes('/v1/messages')||req.url.includes('count_tokens')){res.end('{"input_tokens":1,"data":[]}');return;}
    const body=JSON.parse(raw);requests++;const id='owned-claude-action-'+phase,done=JSON.stringify(body.messages).includes(id);
    const block=done?{type:'text',text:'AUTONOMOUS_DONE'}:{type:'tool_use',id,name:'Bash',input:{command:`node "${script.replaceAll('\\','/')}"`}};
    res.writeHead(200,{'content-type':'text/event-stream'});
    for(const event of [{type:'message_start',message:{id:'autonomy-'+requests,type:'message',role:'assistant',model:body.model,content:[],usage:{input_tokens:10,output_tokens:1}}},{type:'content_block_start',index:0,content_block:block.type==='tool_use'?{...block,input:{}}:{type:'text',text:''}},{type:'content_block_delta',index:0,delta:block.type==='tool_use'?{type:'input_json_delta',partial_json:JSON.stringify(block.input)}:{type:'text_delta',text:block.text}},{type:'content_block_stop',index:0},{type:'message_delta',delta:{stop_reason:block.type==='tool_use'?'tool_use':'end_turn',stop_sequence:null},usage:{output_tokens:5}},{type:'message_stop'}])res.write('event: '+event.type+'\ndata: '+JSON.stringify(event)+'\n\n');res.end();
  }catch(error){errors.push(String(error));res.writeHead(500);res.end();}});
  await new Promise<void>(resolve=>model.listen(0,'127.0.0.1',resolve));
  const env={NXBRIDGE_HOME:home,CLAUDE_CONFIG_DIR:claudehome,CODEX_HOME:codexhome,ANTHROPIC_API_KEY:'autonomy-local-only',ANTHROPIC_BASE_URL:`http://127.0.0.1:${(model.address() as any).port}`,DISABLE_AUTOUPDATER:'1',DISABLE_TELEMETRY:'1',CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC:'1'},restoreEnvironment=overrideEnvironment(env);
  t.after(async()=>{try{
    if(!passed)t.diagnostic(JSON.stringify({requests,errors,status,events:await brokerCall('events').catch(()=>undefined)}));
    await temp.cleanup();
  }finally{model.closeAllConnections();await new Promise<void>(resolve=>model.close(()=>resolve()));restoreEnvironment();}});
  const extra:Record<string,unknown>={};
  if(process.platform==='linux'){
    const cli=resolveCli('claude'),plugin=path.join(await preparePlugins(home),'plugins','claude'),wrapper=path.join(root,'child-wrapper.mjs');
    writeFileSync(wrapper,`import{spawn}from'node:child_process';const args=process.argv.slice(2);if(args[0]==='agents'||args.includes('--bg'))process.exit(2);const launch=args[0]==='plugin'||args.includes('--version')?args:[...args,'--plugin-dir',${JSON.stringify(plugin)}];const c=spawn(${JSON.stringify(cli.command)},[...${JSON.stringify(cli.prefix)},...launch],{stdio:'inherit',env:process.env});for(const s of ['SIGTERM','SIGINT'])process.on(s,()=>c.kill(s));c.once('exit',code=>process.exit(code??1));`,'utf8');
    extra.claudeCommand=[process.execPath,wrapper];
  }
  writeFileSync(path.join(home,'config.json'),JSON.stringify({...DEFAULT_CONFIG,compatibilityWake:'strict',claudeHome:claudehome,codexHome:codexhome,...extra}),'utf8');
  if(extra.claudeCommand)writeConfiguration(home,[{key:'hosts.claude.command',value:extra.claudeCommand},{key:'hosts.claude.home',value:claudehome},{key:'hosts.codex.home',value:codexhome},{key:'collaboration.compatibility_wake',value:'strict'}],'setup');
  writeFileSync(path.join(codexhome,'config.toml'),'web_search="disabled"\n[features]\napps=false\nremote_plugin=false\n','utf8');
  writeFileSync(path.join(claudehome,'.claude.json'),JSON.stringify({hasCompletedOnboarding:true,customApiKeyResponses:{approved:[env.ANTHROPIC_API_KEY.slice(-20)],rejected:[]},projects:{[root.replaceAll('\\','/')]:{hasTrustDialogAccepted:true}}}),'utf8');
                                        
  const settings=JSON.stringify({skipDangerousModePermissionPrompt:true,permissions:{defaultMode:'default'},env:{ANTHROPIC_API_KEY:env.ANTHROPIC_API_KEY,ANTHROPIC_BASE_URL:env.ANTHROPIC_BASE_URL,CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC:'1'}});writeFileSync(path.join(claudehome,'settings.json'),settings,'utf8');
  await setupPublish();const userSettings=readFileSync(path.join(claudehome,'settings.json'),'utf8'),native=await processIdentity(process.pid);
  const source=await brokerCall<any>('register',{host:'codex',sessionId:'autonomous-source',cwd:root,kind:'root',permission:'prompting',endpoint:{mode:'embedded',address:'',epoch:'source',pid:process.pid,procStart:native.startedAt}});
  const receipt=await brokerCall('send',{actor:{host:'codex',sessionId:'autonomous-source',callId:'task'},message:'AUTONOMOUS_LOCAL_TASK'});
  const end=Date.now()+60000;while(true){status=await brokerCall('status');if(existsSync(proof)&&status.messages.find((m:any)=>m.id===receipt.message_id)?.state==='contextObserved')break;assert.ok(Date.now()<end,'新后台未完成跨权限来信和工具执行');await delay(100);}
  const peer=status.peers.find((p:any)=>p.host==='claude'&&p.owner==='nxbridge'),endpoint=status.endpoints.find((e:any)=>e.peerId===peer?.id&&e.active);
  const verified=(await brokerCall<any[]>('events')).find((event:any)=>event.type==='claude.launch.verified'&&event.data.peerId===peer.id);
  assert.ok(verified,'必须在首条任务之前获得原生启动策略回执');assert.equal(verified.data.decision,'allow');
  assert.equal(peer.permission,'bypass');assert.equal(endpoint.nativePermission.mode,'bypassPermissions');assert.equal(endpoint.nativeInbound.policy,'accept');assert.equal(peer.claude_auto_mode,undefined);assert.notEqual(peer.state,'needsHuman');
  if(process.platform==='linux'){
    const original=claudeChild(home,peer.id)!;assert.equal(original.launchSourcePermission,'prompting');
    const idleEnd=Date.now()+15000;while(claudeChild(home,peer.id)?.health?.state!=='ready'){assert.ok(Date.now()<idleEnd);await delay(100);}
    await brokerCall('pause');await stopOwnedProcess(original.native!,{force:true});phase++;
    await brokerCall('resume');const next=await brokerCall('send',{actor:{host:'codex',sessionId:'autonomous-source',callId:'after-restart'},message:'AUTONOMOUS_AFTER_RESTART'});
    const restoredEnd=Date.now()+45000;while(true){status=await brokerCall('status');if(status.messages.find((m:any)=>m.id===next.message_id)?.state==='contextObserved'&&claudeChild(home,peer.id)?.health?.state==='ready')break;assert.ok(Date.now()<restoredEnd,'子进程恢复未保持自动策略');await delay(100);}
    const restored=claudeChild(home,peer.id)!;assert.notEqual(restored.native!.pid,original.native!.pid);assert.equal(restored.sessionId,original.sessionId);assert.equal(restored.launchSourcePermission,'prompting');
    assert.equal(status.peers.find((p:any)=>p.id===peer.id).permission,'bypass');assert.ok(requests>=4,'恢复后的工具轮次没有执行');
  }
  const replacement=await brokerCall<any>('register',{host:'claude',sessionId:'autonomy-replacement',cwd:root,kind:'root',permission:'prompting',endpoint:{mode:'embedded',address:'',epoch:'replacement',pid:process.pid,procStart:native.startedAt}});
  await brokerCall('pair',{claude:replacement.id,codex:source.id,replace:true});
  const releasedEnd=Date.now()+25000;while(true){status=await brokerCall('status');if(status.peers.find((value:any)=>value.id===peer.id)?.state==='offline'&&!status.capabilities.retirements.some((value:any)=>value.peerId===peer.id))break;assert.ok(Date.now()<releasedEnd,'切换后的 Claude 后台未完成回收');await delay(100);}
  const restored=await promisify(execFile)(process.execPath,[path.join(home,'bin','nxbridge.cjs'),'pair','--claude',peer.sessionId,'--codex',source.id,'--replace'],{cwd:root,env:process.env,windowsHide:true,timeout:60000,maxBuffer:4*1024*1024});
  assert.match(restored.stdout,/原来的会话/);status=await brokerCall('status');assert.equal(status.pairs.find((value:any)=>value.codex===source.id)?.claude,peer.id);assert.equal(status.peers.find((value:any)=>value.id===peer.id)?.sessionId,peer.sessionId);
  assert.equal(readFileSync(proof,'utf8'),'AUTONOMOUS_ACTION');assert.equal(readFileSync(path.join(claudehome,'settings.json'),'utf8'),userSettings);assert.deepEqual(errors,[]);passed=true;
  t.diagnostic(JSON.stringify({startupVerification:verified.data,mode:endpoint.nativePermission.mode,inbound:endpoint.nativeInbound.policy,requests,realModelCalls:0,userSettingsUnchanged:true}));
});
