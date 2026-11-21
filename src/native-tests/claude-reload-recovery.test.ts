import { overrideEnvironment } from '../tests/support/environment.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { temporaryDirectory } from '../tests/support/temporary.js';
import { preparePlugins } from '../install/setup.js';
import { brokerCall, ensureBroker } from '../ipc/ipc.js';
import {DEFAULT_CONFIG} from '../config/defaults.js';
import { processIdentity } from '../process/process.js';
import {PACKAGE_ROOT} from '../shared/package-location.js';
import {resolveCli,runCli} from '../process/host-command.js';
import { NativeTerminal } from './terminal-fixture.js';

test('实际 Claude：跨配置目录在应用内恢复原搭档；重载插件后空闲和忙碌来信均有回执',{skip:process.platform!=='win32',timeout:170000},async t=>{
  const temp=temporaryDirectory(),root=temp.directory,home=path.join(root,'bridge'),claudehome=path.join(root,'new-slot'),oldhome=path.join(root,'old-slot'),codexhome=path.join(root,'codex');
  for(const directory of [home,claudehome,oldhome,codexhome])mkdirSync(directory,{recursive:true});
  const requests:any[]=[],errors:string[]=[];let phase=0,hold=false,release:(()=>void)|undefined;
  const model=http.createServer(async(req,res)=>{try{
    let raw='';for await(const chunk of req)raw+=chunk;
    if(!req.url?.includes('/v1/messages')||req.url.includes('count_tokens')){res.writeHead(200,{'content-type':'application/json'});res.end('{"input_tokens":1,"data":[]}');return;}
    const body=JSON.parse(raw);requests.push(body);
    if(hold){hold=false;await new Promise<void>(resolve=>{release=resolve;});release=undefined;}
    const text='RELOAD_RECOVERY_DONE_'+phase,id='msg-'+requests.length;
    if(!body.stream){res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({id,type:'message',role:'assistant',model:body.model,content:[{type:'text',text}],stop_reason:'end_turn',stop_sequence:null,usage:{input_tokens:10,output_tokens:5}}));return;}
    res.writeHead(200,{'content-type':'text/event-stream'});
    for(const event of [{type:'message_start',message:{id,type:'message',role:'assistant',model:body.model,content:[],stop_reason:null,stop_sequence:null,usage:{input_tokens:10,output_tokens:1}}},{type:'content_block_start',index:0,content_block:{type:'text',text:''}},{type:'content_block_delta',index:0,delta:{type:'text_delta',text}},{type:'content_block_stop',index:0},{type:'message_delta',delta:{stop_reason:'end_turn',stop_sequence:null},usage:{output_tokens:5}},{type:'message_stop'}])res.write('event: '+event.type+'\ndata: '+JSON.stringify(event)+'\n\n');res.end();
  }catch(error){errors.push(String(error));res.writeHead(500);res.end(String(error));}});
  await new Promise<void>(resolve=>model.listen(0,'127.0.0.1',resolve));
  const env={NXBRIDGE_HOME:home,CLAUDE_CONFIG_DIR:claudehome,CODEX_HOME:codexhome,ANTHROPIC_API_KEY:'nxbridge-local-reload-key',ANTHROPIC_BASE_URL:`http://127.0.0.1:${(model.address() as any).port}`,DISABLE_AUTOUPDATER:'1',DISABLE_TELEMETRY:'1',CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC:'1',CLAUDE_CODE_USER_DIALOG_TIMEOUT_MS:'5000'},restoreEnvironment=overrideEnvironment(env);
  let terminal:NativeTerminal|undefined,passed=false;
  const events=()=>{const db=new DatabaseSync(path.join(home,'nxbridge.db'),{readOnly:true});try{return db.prepare('SELECT type,data FROM events ORDER BY seq').all().map(row=>({type:row.type,data:JSON.parse(String(row.data))}));}finally{db.close();}};
  t.after(async()=>{try{
    release?.();if(!passed)try{const status=await brokerCall<any>('status',{}, {home,start:false});t.diagnostic(JSON.stringify({errors,nativePid:terminal?.identity.pid,output:terminal?.output.slice(-4000),requestEvidence:requests.map(body=>({idle:JSON.stringify(body.messages).includes('RELOAD_IDLE_INCOMING'),midturn:JSON.stringify(body.messages).includes('RELOAD_MIDTURN_INCOMING')})),peers:status.peers.map((peer:any)=>({id:peer.id,sessionId:peer.sessionId,state:peer.state})),bindings:status.bindings,endpoints:status.endpoints,messages:status.messages,diagnostics:events().filter(e=>/^(mod\.|context\.|message\.|delivery\.|pump\.)/.test(String(e.type))).slice(-30)}));}catch{}
    await terminal?.close();try{await brokerCall('shutdown',{releaseOwned:false},{home,start:false});}catch{}await temp.cleanup();
  }finally{model.closeAllConnections();await new Promise<void>(resolve=>model.close(()=>resolve()));restoreEnvironment();}});
  writeFileSync(path.join(home,'config.json'),JSON.stringify({...DEFAULT_CONFIG,implicit:'never',compatibilityWake:'strict',codexHome:codexhome,claudeHome:claudehome}),'utf8');
  writeFileSync(path.join(claudehome,'.claude.json'),JSON.stringify({hasCompletedOnboarding:true,customApiKeyResponses:{approved:[env.ANTHROPIC_API_KEY.slice(-20)],rejected:[]},projects:{[root.replaceAll('\\','/')]:{hasTrustDialogAccepted:true}}}),'utf8');
  writeFileSync(path.join(claudehome,'settings.json'),JSON.stringify({autoUpdatesChannel:'stable',env:{ANTHROPIC_API_KEY:env.ANTHROPIC_API_KEY,ANTHROPIC_BASE_URL:env.ANTHROPIC_BASE_URL,CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC:'1'}}),'utf8');
  const marketplace=await preparePlugins(home,{packageRoot:path.join(PACKAGE_ROOT,'publish')});(await ensureBroker(home)).close();const cli=resolveCli('claude');
  await runCli('claude',['plugin','validate',path.join(marketplace,'plugins/claude')],{cwd:root,home,timeout:15000});
  terminal=await NativeTerminal.start(root,home,cli.command,[...cli.prefix,'--plugin-dir',path.join(marketplace,'plugins/claude'),'--model','claude-sonnet-4-6'],root,{...process.env,TERM:'xterm-256color',COLORTERM:'truecolor'});
  const status=()=>brokerCall<any>('status',{}, {home}),wait=(check:()=>boolean|Promise<boolean>,reason:string)=>terminal!.wait(check,reason+'；'+errors.join(';'),25000);
  const turn=async(text:string)=>{const offset=terminal!.output.length;await terminal!.prompt(text);await wait(()=>terminal!.output.slice(offset).includes('RELOAD_RECOVERY_DONE_'+phase),'原生轮次未完成');};
  await turn('创建用于恢复的原生历史');await wait(async()=>(await status()).peers.some((peer:any)=>peer.host==='claude'&&peer.context),'Mod 未登记窗口');
  let s=await status();const provisional=s.peers.find((peer:any)=>peer.host==='claude'&&peer.context),original=provisional.sessionId;
  await terminal.prompt('/clear');await wait(async()=>(await status()).peers.find((peer:any)=>peer.id===provisional.id)?.sessionId!==original,'未建立新的原生上下文');
                                      
  const old=await brokerCall<any>('register',{host:'claude',sessionId:original,cwd:root,name:'旧槽位原成员',kind:'root',endpoint:{mode:'claude-inbox',address:'retired-inbox',epoch:'retired-window',pid:2_000_000_000,procStart:'retired-generation',configHome:oldhome}},{home});
  const identity=await processIdentity(process.pid),counterpart=await brokerCall<any>('register',{host:'codex',sessionId:'reload-counterpart',cwd:root,name:'原 Codex 搭档',kind:'root',permission:'prompting',endpoint:{mode:'embedded',address:'',epoch:'counterpart',pid:process.pid,procStart:identity.startedAt}},{home});
  const pair=await brokerCall<any>('pair',{claude:old.id,codex:counterpart.id},{home}),actor={host:'codex',memberId:counterpart.id,sessionId:counterpart.sessionId,callId:'idle-receipt'};
  await terminal.prompt('/resume '+original);await wait(async()=>(await status()).endpoints.some((endpoint:any)=>endpoint.peerId===old.id&&endpoint.active&&endpoint.pid===terminal!.identity.pid&&endpoint.configHome===claudehome),'应用内恢复未接续原成员');phase++;await turn('恢复原会话后继续');
  s=await status();assert.equal(s.pair.id,pair.id);assert.ok(!s.peers.some((peer:any)=>peer.id===provisional.id));assert.ok(s.endpoints.some((endpoint:any)=>endpoint.peerId===old.id&&endpoint.active&&endpoint.configHome===claudehome));
                                       
  const registerFile=path.join(marketplace,'plugins/claude/hooks/register.js'),reloadMarker=path.join(root,'reloaded-hook.json'),source=readFileSync(registerFile,'utf8');
  const receive=/(\w+)\("session.receive",async\((\w+),(\w+),(\w+)\)=>\{/.exec(source);assert.ok(receive,'发布入口缺少原生收信处理器');
  writeFileSync(registerFile,source.replace(receive[0],receive[0]+'await '+receive[2]+'.fs.write('+JSON.stringify(reloadMarker)+',"loaded");'),'utf8');
  await runCli('claude',['plugin','validate',path.join(marketplace,'plugins/claude')],{cwd:root,home,timeout:15000});
  const reloadOffset=terminal.output.length;await terminal.prompt('/reload-plugins');await wait(()=>/Reloaded|重新加载/.test(terminal!.output.slice(reloadOffset)),'插件未完成实际重载');
  const observed=async(id:string)=>['contextObserved','responded'].includes((await status()).messages.find((message:any)=>message.id===id)?.state);
  const idle=await brokerCall<any>('send',{actor,message:'RELOAD_IDLE_INCOMING'},{home});await wait(()=>observed(idle.message_id),'重载后的空闲来信缺少入上下文回执');
  assert.equal(readFileSync(reloadMarker,'utf8'),'loaded','同版本替换后的新收信处理器必须实际执行');
  await wait(async()=>(await status()).peers.find((peer:any)=>peer.id===old.id)?.state==='ready','空闲来信结束后未报告 ready');
  hold=true;phase++;await terminal.prompt('保持这一轮以验证忙碌期间来信');await wait(()=>!!release,'未进入受控的忙碌模型请求');
  const queued=await brokerCall<any>('send',{actor:{...actor,callId:'queued-receipt'},message:'RELOAD_MIDTURN_INCOMING'},{home});release!();
  await wait(()=>observed(queued.message_id),'重载后的忙碌来信缺少入上下文回执');await wait(async()=>(await status()).peers.find((peer:any)=>peer.id===old.id)?.state==='ready','忙碌来信结束后未报告 ready');
  await wait(()=>requests.some(body=>JSON.stringify(body.messages).includes('RELOAD_MIDTURN_INCOMING')),'忙碌来信虽有原生回执，但尚未进入模型请求');
                                                 
  await brokerCall('register',{host:'codex',sessionId:counterpart.sessionId,cwd:root,name:'原 Codex 搭档',kind:'root',permission:'bypass',endpoint:{mode:'embedded',address:'',epoch:'counterpart',pid:process.pid,procStart:identity.startedAt}},{home});
  const blocked=await brokerCall<any>('send',{actor:{...actor,callId:'approval-required'},message:'RELOAD_APPROVAL_BLOCKED'},{home});
  assert.equal(blocked.inbound_admission?.state,'approval_required');
  await wait(async()=>(await status()).messages.find((message:any)=>message.id===blocked.message_id)?.state==='held','实际原生审核未报告 held');
  await wait(()=>events().some(e=>e.type==='message.inbound.expiry_unconfirmed'&&e.data.messageId===blocked.message_id),'原生审核等待超过观察期限后缺少未确认提示');
  s=await status();assert.equal(s.messages.find((message:any)=>message.id===blocked.message_id)?.state,'held');assert.equal(s.messages.find((message:any)=>message.id===blocked.message_id)?.attempts,1);
  assert.ok(!requests.some(body=>JSON.stringify(body.messages).includes('RELOAD_APPROVAL_BLOCKED')),'被原生审核扣住的消息不能宣称进入模型');
  const changes=events().filter(e=>e.type==='peer.state'&&e.data.peerId===old.id).map(e=>e.data.state);assert.ok(changes.includes('busy')&&changes.includes('ready'));assert.equal(errors.length,0);passed=true;
  t.diagnostic(JSON.stringify({pair:pair.id,member:old.id,crossHomeResume:true,reloaded:true,idleReceipt:true,midturnReceipt:true,approvalHeld:true,expiryUnconfirmed:true,realModelCalls:0}));
});
