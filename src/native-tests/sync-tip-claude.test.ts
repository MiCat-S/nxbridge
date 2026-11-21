import { overrideEnvironment } from '../tests/support/environment.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import { mkdirSync, writeFileSync } from 'node:fs';
import { temporaryDirectory } from '../tests/support/temporary.js';
import { preparePlugins } from '../install/setup.js';
import { brokerCall, ensureBroker } from '../ipc/ipc.js';
import {DEFAULT_CONFIG} from '../config/defaults.js';
import { processIdentity } from '../process/process.js';
import {PACKAGE_ROOT} from '../shared/package-location.js';
import {resolveCli} from '../process/host-command.js';
import { NativeTerminal } from './terminal-fixture.js';
import { holdModelStream } from './model-stream-fixture.js';

test('实际 Claude Mod：忙碌和真实含缓存用量经 tip-sync 合并为一次协作提醒',{skip:process.platform!=='win32',timeout:170000},async t=>{
  const temp=temporaryDirectory(),root=temp.directory,home=path.join(root,'bridge'),claudehome=path.join(root,'claude'),codexhome=path.join(root,'codex');
  for(const d of [home,claudehome,codexhome])mkdirSync(d,{recursive:true});
  const requests:any[]=[],errors:string[]=[],tip='recheck split per nxbridge routing + any extra user rules';
  const model=http.createServer(async(req,res)=>{try{
    let raw='';for await(const chunk of req)raw+=chunk;
    if(!req.url?.includes('/v1/messages')||req.url.includes('count_tokens')){res.writeHead(200,{'content-type':'application/json'});res.end('{"input_tokens":1,"data":[]}');return;}
    const body=JSON.parse(raw);requests.push(body);
    const main=body.tools?.some((tool:any)=>tool.name==='ListAgents'),working=main&&JSON.stringify(body.messages).includes('SYNC_NATIVE_TASK');
    const results=(body.messages??[]).flatMap((m:any)=>Array.isArray(m.content)?m.content:[]).filter((c:any)=>c.type==='tool_result');
    const tool=working?(!results.some((c:any)=>c.tool_use_id==='sync-first')?'sync-first':!results.some((c:any)=>c.tool_use_id==='sync-second')?'sync-second':undefined):undefined;
    const text=main?'SYNC_NATIVE_DONE':JSON.stringify(body.system).includes('security monitor')?'<severity>0</severity>':'{"state":"done"}',id='sync-'+requests.length;
    const item=tool?{type:'tool_use',id:tool,name:'ListAgents',input:{}}:{type:'text',text:''};
    if(!body.stream){res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({id,type:'message',role:'assistant',model:body.model,content:[tool?item:{type:'text',text}],stop_reason:tool?'tool_use':'end_turn',usage:{input_tokens:10,output_tokens:5}}));return;}
    res.writeHead(200,{'content-type':'text/event-stream'});
    const emit=(event:any)=>res.write('event: '+event.type+'\ndata: '+JSON.stringify(event)+'\n\n');
    emit({type:'message_start',message:{id,type:'message',role:'assistant',model:body.model,content:[],usage:{input_tokens:5,cache_read_input_tokens:40,output_tokens:1}}});
    emit({type:'content_block_start',index:0,content_block:item});
                                             
    if(tool==='sync-second'&&!await holdModelStream(res,65000))return;
    emit({type:'content_block_delta',index:0,delta:tool?{type:'input_json_delta',partial_json:'{}'}:{type:'text_delta',text}});
    emit({type:'content_block_stop',index:0});emit({type:'message_delta',delta:{stop_reason:tool?'tool_use':'end_turn',stop_sequence:null},usage:{output_tokens:5}});emit({type:'message_stop'});res.end();
  }catch(error){errors.push(String(error));res.writeHead(500);res.end(String(error));}});
  await new Promise<void>(resolve=>model.listen(0,'127.0.0.1',resolve));
  const env={NXBRIDGE_HOME:home,CLAUDE_CONFIG_DIR:claudehome,CODEX_HOME:codexhome,ANTHROPIC_API_KEY:'sync-native-local-only',ANTHROPIC_BASE_URL:`http://127.0.0.1:${(model.address() as any).port}`,DISABLE_AUTOUPDATER:'1',DISABLE_TELEMETRY:'1',CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC:'1'},restoreEnvironment=overrideEnvironment(env);
  let terminal:NativeTerminal|undefined;
  t.after(async()=>{try{await terminal?.close();try{await brokerCall('shutdown',{releaseOwned:false},{home,start:false});}catch{}await temp.cleanup();}finally{model.closeAllConnections();await new Promise<void>(resolve=>model.close(()=>resolve()));restoreEnvironment();}});
  writeFileSync(path.join(home,'config.json'),JSON.stringify({...DEFAULT_CONFIG,implicit:'never',compatibilityWake:'strict',syncTipMinutes:1,contextTipTokens:[20,40,60],codexHome:codexhome,claudeHome:claudehome}),'utf8');
  writeFileSync(path.join(claudehome,'.claude.json'),JSON.stringify({hasCompletedOnboarding:true,customApiKeyResponses:{approved:[env.ANTHROPIC_API_KEY.slice(-20)],rejected:[]},projects:{[root.replaceAll('\\','/')]:{hasTrustDialogAccepted:true}}}),'utf8');
  writeFileSync(path.join(claudehome,'settings.json'),JSON.stringify({crossSessionInbound:'accept',env:{ANTHROPIC_API_KEY:env.ANTHROPIC_API_KEY,ANTHROPIC_BASE_URL:env.ANTHROPIC_BASE_URL,CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC:'1'}}),'utf8');
  const marketplace=await preparePlugins(home,{packageRoot:path.join(PACKAGE_ROOT,'publish')});(await ensureBroker(home)).close();const exe=resolveCli('claude');
  terminal=await NativeTerminal.start(root,home,exe.command,[...exe.prefix,'--plugin-dir',path.join(marketplace,'plugins/claude'),'--model','claude-sonnet-4-6'],root,{...process.env,TERM:'xterm-256color',COLORTERM:'truecolor'});
  const status=()=>brokerCall<any>('status',{}, {home});await terminal.prompt('初始化同步提醒验收');
  await terminal.wait(async()=>terminal!.output.includes('SYNC_NATIVE_DONE')&&(await status()).peers.some((peer:any)=>peer.host==='claude'&&peer.state==='ready'),'初始原生轮次未完成',30000);
  const c=(await status()).peers.find((peer:any)=>peer.host==='claude'),identity=await processIdentity(process.pid),x=await brokerCall<any>('register',{host:'codex',sessionId:'sync-counterpart',cwd:root,kind:'root',state:'ready',permission:'prompting',endpoint:{mode:'embedded',address:'',epoch:'sync-counterpart',pid:process.pid,procStart:identity.startedAt}},{home});
  await brokerCall('pair',{claude:c.id,codex:x.id},{home});await brokerCall('send',{actor:{host:'codex',sessionId:x.sessionId,callId:'task'},message:'SYNC_NATIVE_TASK 请继续处理已有任务。'},{home});
  await terminal.wait(()=>requests.some(body=>JSON.stringify(body.messages).includes(tip)),'同步提醒未进入原生模型请求；'+errors.join(';'),95000);
  const events=await brokerCall<any[]>('events',{}, {home}),tips=events.filter(event=>event.type==='communication.syncTip'&&event.data.peerId===c.id);assert.equal(tips.length,1);assert.equal(tips[0].data.contextBand,40);assert.ok(requests.some(body=>JSON.stringify(body.messages).includes(tip)&&JSON.stringify(body.messages).includes('long context')));assert.equal(errors.length,0);
  t.diagnostic(JSON.stringify({nativePid:terminal.identity.pid,tipInModel:true,cachedInputCounted:true,contextInModel:true,realModelCalls:0}));
});
