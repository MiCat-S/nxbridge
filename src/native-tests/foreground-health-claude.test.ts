import { overrideEnvironment } from '../tests/support/environment.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import { mkdirSync, writeFileSync } from 'node:fs';
import { temporaryDirectory } from '../tests/support/temporary.js';
import { setupPublish } from './publish-fixture.js';
import { NativeTerminal } from './terminal-fixture.js';
import { holdModelStream } from './model-stream-fixture.js';
import { brokerCall } from '../ipc/ipc.js';
import {DEFAULT_CONFIG} from '../config/defaults.js';
import {resolveCli} from '../process/host-command.js';

test('前台 Claude：批准后长工具恢复运行，当前子代理输出推进根进展',{skip:process.platform!=='win32',timeout:170000},async t=>{
  const temp=temporaryDirectory(),root=temp.directory,home=path.join(root,'bridge'),claudehome=path.join(root,'claude'),codexhome=path.join(root,'codex');
  for(const directory of [home,claudehome,codexhome])mkdirSync(directory,{recursive:true});
  let terminal:NativeTerminal|undefined,childStarted=0,phase='permission',passed=false;const errors:string[]=[];
  const started=Date.now(),stage=(name:string)=>process.stderr.write(JSON.stringify({foregroundHealthStage:name,elapsedMs:Date.now()-started})+'\n');
  const model=http.createServer(async(req,res)=>{try{
    let raw='';for await(const chunk of req)raw+=chunk;
    if(!req.url?.includes('/v1/messages')||req.url.includes('count_tokens')){res.writeHead(200,{'content-type':'application/json'});res.end('{"input_tokens":1,"data":[]}');return;}
    const body=JSON.parse(raw),main=body.tools?.some((tool:any)=>tool.name==='ListAgents'),child=/haiku/.test(body.model);
    const results=(body.messages??[]).flatMap((message:any)=>Array.isArray(message.content)?message.content:[]);
    const id=phase==='permission'?'health-approved-tool':'health-agent';
    const tool=main&&!child&&!results.some((block:any)=>block.type==='tool_result'&&block.tool_use_id===id)?phase==='permission'?'Bash':'Agent':undefined;
    const input=tool==='Bash'?{command:'node -e "setTimeout(()=>console.log(12345),35000)"',description:'核验批准后的原生长工具状态'}:{description:'核验子代理进度',subagent_type:'general-purpose',model:'haiku',prompt:'输出 NATIVE_HEALTH_CHILD_PROGRESS。'};
    const text=child?'NATIVE_HEALTH_CHILD_PROGRESS':main?'NATIVE_HEALTH_DONE':'{"state":"done"}',content=tool?{type:'tool_use',id,name:tool,input}:{type:'text',text};
    const message={id:'health-'+Date.now(),type:'message',role:'assistant',model:body.model,content:[content],stop_reason:tool?'tool_use':'end_turn',stop_sequence:null,usage:{input_tokens:10,output_tokens:5}};
    if(!body.stream){res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify(message));return;}
    res.writeHead(200,{'content-type':'text/event-stream'});
    const emit=(event:any)=>res.write('event: '+event.type+'\ndata: '+JSON.stringify(event)+'\n\n');
    emit({type:'message_start',message:{...message,content:[],stop_reason:null}});
    emit({type:'content_block_start',index:0,content_block:tool?{...content,input:{}}:{type:'text',text:''}});
    if(child){childStarted=Date.now();if(!await holdModelStream(res,1500))return;}
    emit({type:'content_block_delta',index:0,delta:tool?{type:'input_json_delta',partial_json:JSON.stringify(input)}:{type:'text_delta',text}});
    if(child&&!await holdModelStream(res,16000))return;
    for(const event of [{type:'content_block_stop',index:0},{type:'message_delta',delta:{stop_reason:message.stop_reason,stop_sequence:null},usage:{output_tokens:5}},{type:'message_stop'}])emit(event);res.end();
  }catch(error){errors.push(String(error));res.writeHead(500);res.end(String(error));}});
  await new Promise<void>(resolve=>model.listen(0,'127.0.0.1',resolve));
                                                               
  const env={NXBRIDGE_HOME:home,CLAUDE_CONFIG_DIR:claudehome,CODEX_HOME:codexhome,ANTHROPIC_API_KEY:'native-health-local-key',ANTHROPIC_BASE_URL:`http://127.0.0.1:${(model.address() as any).port}`,DISABLE_AUTOUPDATER:'1',DISABLE_TELEMETRY:'1',CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC:'1',CLAUDE_CODE_DISABLE_BACKGROUND_TASKS:'1'},restoreEnvironment=overrideEnvironment(env);
  const peer=async()=>(await brokerCall<any>('status',{}, {home})).peers.find((value:any)=>value.host==='claude'&&value.kind==='root');
  t.after(async()=>{try{if(!passed)t.diagnostic(JSON.stringify({phase,childStarted,status:await brokerCall('status',{}, {home,start:false,timeout:1000}).catch(error=>String(error)),errors,terminal:terminal?.output.slice(-3000)}));await terminal?.close();await temp.cleanup();}finally{model.closeAllConnections();await new Promise<void>(resolve=>model.close(()=>resolve()));restoreEnvironment();}});
  writeFileSync(path.join(home,'config.json'),JSON.stringify({...DEFAULT_CONFIG,implicit:'never',compatibilityWake:'strict',claudeHome:claudehome,codexHome:codexhome}),'utf8');
  writeFileSync(path.join(codexhome,'config.toml'),'web_search="disabled"\n[features]\napps=false\nremote_plugin=false\n','utf8');
  writeFileSync(path.join(claudehome,'.claude.json'),JSON.stringify({hasCompletedOnboarding:true,customApiKeyResponses:{approved:[env.ANTHROPIC_API_KEY.slice(-20)],rejected:[]},projects:{[root.replaceAll('\\','/')]:{hasTrustDialogAccepted:true}}}),'utf8');
  writeFileSync(path.join(claudehome,'settings.json'),JSON.stringify({crossSessionInbound:'accept',env:{ANTHROPIC_API_KEY:env.ANTHROPIC_API_KEY,ANTHROPIC_BASE_URL:env.ANTHROPIC_BASE_URL,CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC:'1'}}),'utf8');
  stage('安装隔离发布包');await setupPublish();stage('启动实际终端');const cli=resolveCli('claude');terminal=await NativeTerminal.start(root,home,cli.command,[...cli.prefix,'--model','claude-sonnet-4-6'],root,{...process.env,TERM:'xterm-256color',COLORTERM:'truecolor'});
  stage('等待实际权限表单');
  await terminal.prompt('NATIVE_HEALTH_APPROVAL');
  await terminal.wait(async()=>(await peer())?.health?.state==='needsHuman','原生权限等待没有进入健康状态',40000);
  const waiting=(await peer()).health;assert.deepEqual(waiting.tools,['health-approved-tool']);
  stage('批准长工具');
  await terminal.prompt('');
  await terminal.wait(async()=>{const value=(await peer())?.health;return value?.state==='waitingTool'&&value.tools.includes('health-approved-tool')&&value.lastProgressAt>waiting.lastProgressAt;},'批准后仍显示等待人工，或直到工具结束才恢复',25000);
  await terminal.wait(async()=>(await peer())?.state==='ready','批准后的原生工具未完成',45000);
  stage('等待实际子代理输出');
  phase='delegation';await terminal.prompt('NATIVE_HEALTH_DELEGATION');
  await terminal.wait(async()=>{const value=(await peer())?.health;return childStarted>0&&value?.tools.includes('health-agent')&&value.observedProgressAt>childStarted;},'当前子代理的实际输出没有推进根进展',35000);
  const delegated=(await peer()).health;assert.equal(delegated.source,'native-mod');assert.equal(delegated.state,'waitingTool');
  stage('等待原生子代理结束');
  await terminal.wait(async()=>(await peer())?.state==='ready','原生子代理未完成',30000);
  assert.deepEqual(errors,[]);passed=true;t.diagnostic(JSON.stringify({actualClaudePid:terminal.identity.pid,permissionResolvedBeforeToolEnd:true,childOutputAdvancedRoot:true,telemetryExportDisabled:true,realModelCalls:0}));
});
