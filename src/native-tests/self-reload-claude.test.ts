import { overrideEnvironment } from '../tests/support/environment.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import {mkdirSync,readFileSync,writeFileSync} from 'node:fs';
import { temporaryDirectory } from '../tests/support/temporary.js';
import {preparePlugins} from '../install/setup.js';
import {brokerCall,ensureBroker} from '../ipc/ipc.js';
import {DEFAULT_CONFIG} from '../config/defaults.js';
import {PACKAGE_ROOT} from '../shared/package-location.js';
import {resolveCli,runCli} from '../process/host-command.js';
import {processIdentity} from '../process/process.js';
import {MOD_REVISION} from '../mod-revision.js';
import {NativeTerminal} from './terminal-fixture.js';
import {stripVTControlCharacters} from 'node:util';

test('实际 Claude 新进程提供搭档模型参数，空闲时自动重载且继续原会话',{skip:process.platform!=='win32',timeout:170000},async t=>{
  const temp=temporaryDirectory(),root=temp.directory,home=path.join(root,'bridge'),claudehome=path.join(root,'claude'),codexhome=path.join(root,'codex');
  for(const directory of [home,claudehome,codexhome])mkdirSync(directory,{recursive:true});
  const requests:any[]=[],errors:string[]=[],discovery:Record<string,string>={};let phase='init',terminal:NativeTerminal|undefined,passed=false;
  const model=http.createServer(async(req,res)=>{try{
    let raw='';for await(const chunk of req)raw+=chunk;
    if(!req.url?.includes('/v1/messages')||req.url.includes('count_tokens')){res.writeHead(200,{'content-type':'application/json'});res.end('{"input_tokens":1,"data":[]}');return;}
    const body=JSON.parse(raw);requests.push({phase,body});
    const tools=body.tools??[];
    for(const name of ['reload_plugins','config','checkpoint','read_messages','choose_partner','set_enabled','answer_question','select_partner']){const tool=tools.find((item:any)=>item.name==='mcp__nxbridge__'+name);discovery[name]=tool?(tool.defer_loading===true?'deferred':'loaded'):(discovery[name]??'absent');}
    const text='SELF_RELOAD_DONE_'+phase,id='reload-'+requests.length;
    res.writeHead(200,{'content-type':'text/event-stream'});
    const events=[{type:'message_start',message:{id,type:'message',role:'assistant',model:body.model,content:[],stop_reason:null,stop_sequence:null,usage:{input_tokens:10,output_tokens:1}}},{type:'content_block_start',index:0,content_block:{type:'text',text:''}},{type:'content_block_delta',index:0,delta:{type:'text_delta',text}},{type:'content_block_stop',index:0},{type:'message_delta',delta:{stop_reason:'end_turn',stop_sequence:null},usage:{output_tokens:5}},{type:'message_stop'}];
    for(const event of events)res.write('event: '+event.type+'\ndata: '+JSON.stringify(event)+'\n\n');res.end();
  }catch(error){errors.push(String(error));res.writeHead(500);res.end(String(error));}});
  await new Promise<void>(resolve=>model.listen(0,'127.0.0.1',resolve));
  const env={ENABLE_TOOL_SEARCH:'true',NXBRIDGE_HOME:home,CLAUDE_CONFIG_DIR:claudehome,CODEX_HOME:codexhome,ANTHROPIC_API_KEY:'native-self-reload-local-only',ANTHROPIC_BASE_URL:`http://127.0.0.1:${(model.address() as any).port}`,DISABLE_AUTOUPDATER:'1',DISABLE_TELEMETRY:'1',CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC:'1'},restoreEnvironment=overrideEnvironment(env);
  t.after(async()=>{model.closeAllConnections();try{
    if(!passed)t.diagnostic(JSON.stringify({phase,errors,requests:requests.length,discovery,tools:requests.map(request=>[request.phase,(request.body.tools??[]).filter((tool:any)=>/nxbridge|ToolSearch/.test(tool.name)).map((tool:any)=>tool.name.replace('mcp__nxbridge__','')+(tool.defer_loading?'*':''))]),output:terminal?.output.slice(-2500),status:await brokerCall('status',{}, {home,start:false}).catch(()=>undefined)}));
    await terminal?.close();try{await brokerCall('shutdown',{releaseOwned:false},{home,start:false});}catch{}await temp.cleanup();
  }finally{await new Promise<void>(resolve=>model.close(()=>resolve()));restoreEnvironment();}});
  writeFileSync(path.join(home,'config.json'),JSON.stringify({...DEFAULT_CONFIG,implicit:'never',compatibilityWake:'strict',codexHome:codexhome,claudeHome:claudehome}),'utf8');
  writeFileSync(path.join(claudehome,'.claude.json'),JSON.stringify({hasCompletedOnboarding:true,customApiKeyResponses:{approved:[env.ANTHROPIC_API_KEY.slice(-20)],rejected:[]},projects:{[root.replaceAll('\\','/')]:{hasTrustDialogAccepted:true}}}),'utf8');
  writeFileSync(path.join(claudehome,'settings.json'),JSON.stringify({crossSessionInbound:'accept',env:{ANTHROPIC_API_KEY:env.ANTHROPIC_API_KEY,ANTHROPIC_BASE_URL:env.ANTHROPIC_BASE_URL,CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC:'1'}}),'utf8');
  const marketplace=await preparePlugins(home,{packageRoot:path.join(PACKAGE_ROOT,'publish')}),plugin=path.join(marketplace,'plugins/claude'),registerFile=path.join(plugin,'hooks/register.js'),original=readFileSync(registerFile,'utf8');
  assert.ok(original.includes(MOD_REVISION),'发布 Mod 与测试修订号不一致');writeFileSync(registerFile,original.replaceAll(MOD_REVISION,'0000000000000000'),'utf8');
  await runCli('claude',['plugin','validate',plugin],{cwd:root,home,timeout:15000});(await ensureBroker(home)).close();const cli=resolveCli('claude');
  terminal=await NativeTerminal.start(root,home,cli.command,[...cli.prefix,'--plugin-dir',plugin,'--model','claude-sonnet-4-6'],root,{...process.env,TERM:'xterm-256color',COLORTERM:'truecolor'});
  const status=()=>brokerCall<any>('status',{}, {home}),wait=(predicate:()=>boolean|Promise<boolean>,reason:string)=>terminal!.wait(predicate,reason,35000);
                                                                     
  await wait(async()=>stripVTControlCharacters(terminal!.output).includes('for shortcuts')&&(await status()).endpoints.some((endpoint:any)=>endpoint.modRevision==='0000000000000000'&&endpoint.nativeDecision),'原生 Claude 启动未就绪');
  await terminal.prompt('初始化原生自行重载验收');await wait(()=>terminal!.output.includes('SELF_RELOAD_DONE_init'),'初始化轮次未结束');
                                                    
  const select=requests.find(request=>request.phase==='init'&&request.body.tools?.some((tool:any)=>tool.name==='mcp__nxbridge__select_partner'))?.body.tools.find((tool:any)=>tool.name==='mcp__nxbridge__select_partner');
  assert.ok(select,'新 Claude 进程没有提供 select_partner');
  assert.deepEqual(select.input_schema.properties.model,{type:'string'});
  assert.deepEqual(select.input_schema.properties.effort,{anyOf:[{type:'string'},{type:'number',minimum:0}]});
  assert.equal(select.input_schema.additionalProperties,false);
  t.diagnostic(JSON.stringify({freshSelectPartnerProfile:true,model:select.input_schema.properties.model,effort:select.input_schema.properties.effort}));
  const initial=await status(),c=initial.peers.find((peer:any)=>peer.host==='claude'&&peer.context);assert.ok(c);assert.ok(initial.endpoints.some((endpoint:any)=>endpoint.peerId===c.id&&endpoint.modRevision==='0000000000000000'));
                                                                        
  await wait(async()=>(await status()).endpoints.some((endpoint:any)=>endpoint.peerId===c.id&&endpoint.nativeDecision?.bash==='ask'&&!endpoint.nativeDecision.rule),'普通模式的引擎判定没有登记为 ask');
  const native=await processIdentity(process.pid),x=await brokerCall<any>('register',{host:'codex',sessionId:'self-reload-counterpart',cwd:root,kind:'root',permission:'prompting',endpoint:{mode:'embedded',address:'',epoch:'counterpart',pid:native.pid,procStart:native.startedAt}},{home});await brokerCall('pair',{claude:c.id,codex:x.id},{home});
                                                
  const beforeReload=requests.length;phase='reload';writeFileSync(registerFile,original,'utf8');
  await wait(async()=>{const current=await status();return current.endpoints.some((endpoint:any)=>endpoint.peerId===c.id&&endpoint.active&&endpoint.modRevision===MOD_REVISION)&&!current.capabilities.integrationIssues.some((issue:any)=>issue.peerId===c.id&&issue.code==='mod_stale');},'实际插件没有重载为当前修订号');
  assert.equal(requests.length,beforeReload,'自动重载不应额外调用模型');
                                           
  t.diagnostic(JSON.stringify({discovery}));
  for(const name of ['answer_question','select_partner'])assert.equal(discovery[name],'loaded',name+' 应常驻');
  phase='after';const offset=terminal.output.length;await terminal.prompt('重载后继续原任务');await wait(()=>terminal!.output.slice(offset).includes('SELF_RELOAD_DONE_after'),'重载后原生模型无法继续');
  const after=await status();assert.equal(after.peers.find((peer:any)=>peer.id===c.id)?.sessionId,c.sessionId);assert.ok(after.endpoints.some((endpoint:any)=>endpoint.peerId===c.id&&endpoint.active&&endpoint.pid===terminal!.identity.pid));assert.equal(after.messages.length,0);assert.equal(errors.length,0);passed=true;
  t.diagnostic(JSON.stringify({nativePid:terminal.identity.pid,automaticReload:true,extraModelRequests:0,newRevision:MOD_REVISION,sameSession:true,nextTurn:true,ordinaryMessages:0,realModelCalls:0}));
});
