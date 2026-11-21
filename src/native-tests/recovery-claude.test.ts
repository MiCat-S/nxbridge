import { overrideEnvironment } from '../tests/support/environment.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { temporaryDirectory } from '../tests/support/temporary.js';
import { preparePlugins } from '../install/setup.js';
import { brokerCall, ensureBroker } from '../ipc/ipc.js';
import {DEFAULT_CONFIG} from '../config/defaults.js';
import { processIdentity } from '../process/process.js';
import {PACKAGE_ROOT} from '../shared/package-location.js';
import {resolveCli} from '../process/host-command.js';
import { NativeTerminal } from './terminal-fixture.js';

test('实际 Claude Mod：已安装压缩恢复事实，记录自动压缩及预计算的原生边界',{skip:process.platform!=='win32',timeout:170000},async t=>{
  const temp=temporaryDirectory(),root=temp.directory,home=path.join(root,'bridge'),claudehome=path.join(root,'claude'),codexhome=path.join(root,'codex'),eventfile=path.join(root,'compact-events.json');
  for(const d of [home,claudehome,codexhome])mkdirSync(d,{recursive:true});
  const checkpoint=path.join(path.dirname(root),'native-claude-current-'+randomUUID()+'.md'),requests:any[]=[],errors:string[]=[];
  let phase='initial',highSent=false,terminal:NativeTerminal|undefined,passed=false;
  const model=http.createServer(async(req,res)=>{try{
    let raw='';for await(const chunk of req)raw+=chunk;
    if(!req.url?.includes('/v1/messages')||req.url.includes('count_tokens')){res.writeHead(200,{'content-type':'application/json'});res.end('{"input_tokens":1,"data":[]}');return;}
    const body=JSON.parse(raw);requests.push({phase,body});
    const main=body.tools?.some((tool:any)=>tool.name==='ListAgents')&&!JSON.stringify(body.messages?.at(-1)).includes('REMINDER: Do NOT call any tools'),force=main&&phase==='auto'&&!highSent;
    if(force)highSent=true;
    const id='recovery-'+requests.length,text=main?'NATIVE_CLAUDE_RECOVERY_'+phase:'<summary>NATIVE_CONTROLLED_SUMMARY</summary>',tool=force?{type:'tool_use',id:'auto-boundary',name:'ListAgents',input:{}}:undefined;
    if(!body.stream){res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({id,type:'message',role:'assistant',model:body.model,content:[tool??{type:'text',text}],stop_reason:tool?'tool_use':'end_turn',stop_sequence:null,usage:{input_tokens:force?185000:20,output_tokens:5}}));return;}
    res.writeHead(200,{'content-type':'text/event-stream'});
    for(const event of [{type:'message_start',message:{id,type:'message',role:'assistant',model:body.model,content:[],usage:{input_tokens:force?185000:20,output_tokens:1}}},{type:'content_block_start',index:0,content_block:tool??{type:'text',text:''}},{type:'content_block_delta',index:0,delta:tool?{type:'input_json_delta',partial_json:'{}'}:{type:'text_delta',text}},{type:'content_block_stop',index:0},{type:'message_delta',delta:{stop_reason:tool?'tool_use':'end_turn',stop_sequence:null},usage:{output_tokens:5}},{type:'message_stop'}])res.write('event: '+event.type+'\ndata: '+JSON.stringify(event)+'\n\n');res.end();
  }catch(error){errors.push(String(error));res.writeHead(500);res.end(String(error));}});
  await new Promise<void>(resolve=>model.listen(0,'127.0.0.1',resolve));
  const env={NXBRIDGE_HOME:home,CLAUDE_CONFIG_DIR:claudehome,CODEX_HOME:codexhome,ANTHROPIC_API_KEY:'native-claude-recovery-local-only',ANTHROPIC_BASE_URL:`http://127.0.0.1:${(model.address() as any).port}`,DISABLE_AUTOUPDATER:'1',DISABLE_TELEMETRY:'1',CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC:'1'},restoreEnvironment=overrideEnvironment(env);
  const events=()=>existsSync(eventfile)?JSON.parse(readFileSync(eventfile,'utf8')) as any[]:[];
  t.after(async()=>{try{
    if(!passed)t.diagnostic(JSON.stringify({phase,events:events(),requests:requests.map(r=>({phase:r.phase,main:r.body.tools?.some((v:any)=>v.name==='ListAgents'),last:JSON.stringify(r.body.messages?.at(-1)).slice(-800)})),errors}));
    await terminal?.close();try{await brokerCall('shutdown',{releaseOwned:false},{home,start:false});}catch{}await temp.cleanup();
  }finally{model.closeAllConnections();await new Promise<void>(resolve=>model.close(()=>resolve()));restoreEnvironment();}});
  writeFileSync(path.join(home,'config.json'),JSON.stringify({...DEFAULT_CONFIG,implicit:'never',compatibilityWake:'strict',codexHome:codexhome,claudeHome:claudehome}),'utf8');
  writeFileSync(path.join(claudehome,'.claude.json'),JSON.stringify({hasCompletedOnboarding:true,customApiKeyResponses:{approved:[env.ANTHROPIC_API_KEY.slice(-20)],rejected:[]},projects:{[root.replaceAll('\\','/')]:{hasTrustDialogAccepted:true}}}),'utf8');
  writeFileSync(path.join(claudehome,'settings.json'),JSON.stringify({crossSessionInbound:'accept',env:{ANTHROPIC_API_KEY:env.ANTHROPIC_API_KEY,ANTHROPIC_BASE_URL:env.ANTHROPIC_BASE_URL,CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC:'1'}}),'utf8');
  const marketplace=await preparePlugins(home,{packageRoot:path.join(PACKAGE_ROOT,'publish')}),plugin=path.join(marketplace,'plugins/claude'),registerFile=path.join(plugin,'hooks/register.js');
                                               
  const original=readFileSync(registerFile,'utf8'),registration=/([\w$]+)\("session\.compact",([\w$]+)\)/g;
  assert.equal([...original.matchAll(registration)].length,1,'发布 Mod 的压缩处理器必须唯一');
  const probe='const __nativeCompactEvents=[];'+original.replace(registration,(_match,on,handler)=>`${on}("session.compact",async(__nativeCompactApi,__nativeCompactEvent,__nativeCompactNext)=>{__nativeCompactEvents.push({stage:'begin',trigger:__nativeCompactEvent.trigger,instructions:__nativeCompactEvent.instructions});await __nativeCompactApi.fs.write(${JSON.stringify(eventfile)},JSON.stringify(__nativeCompactEvents));const __nativeCompactResult=await ${handler}(__nativeCompactApi,__nativeCompactEvent,__nativeCompactNext);__nativeCompactEvents.push({stage:'end',trigger:__nativeCompactEvent.trigger,skip:__nativeCompactResult?.skip,tokensAfter:__nativeCompactResult?.tokensAfter,usage:__nativeCompactResult?.usage,recovery:__nativeCompactResult?.messages?.filter(__nativeRecoveryMessage=>__nativeRecoveryMessage.text?.includes('nxbridge recovery facts rev ')).map(__nativeRecoveryMessage=>__nativeRecoveryMessage.text)});await __nativeCompactApi.fs.write(${JSON.stringify(eventfile)},JSON.stringify(__nativeCompactEvents));return __nativeCompactResult;})`);
  writeFileSync(registerFile,probe,'utf8');
  const cli=resolveCli('claude');await promisify(execFile)(cli.command,[...cli.prefix,'plugin','validate',plugin],{windowsHide:true,timeout:15000});
  (await ensureBroker(home)).close();terminal=await NativeTerminal.start(root,home,cli.command,[...cli.prefix,'--plugin-dir',plugin,'--model','claude-sonnet-4-6'],root,{...process.env,TERM:'xterm-256color',COLORTERM:'truecolor'});
  const status=()=>brokerCall<any>('status',{}, {home}),turn=async(text:string)=>{const offset=terminal!.output.length;await terminal!.prompt(text);await terminal!.wait(()=>terminal!.output.slice(offset).includes('NATIVE_CLAUDE_RECOVERY_'+phase),'Claude 原生轮次未结束；'+errors.join(';'),30000);};
  await turn('初始化原生压缩恢复验收');const initial=await status(),c=initial.peers.find((p:any)=>p.host==='claude'&&p.context);assert.ok(c,'实际 Mod 未登记窗口');
  const identity=await processIdentity(process.pid),x=await brokerCall<any>('register',{host:'codex',sessionId:'native-recovery-counterpart',cwd:root,kind:'root',endpoint:{mode:'embedded',address:'',epoch:'counterpart',pid:identity.pid,procStart:identity.startedAt}},{home});
  await brokerCall('pair',{claude:c.id,codex:x.id},{home});const binding=initial.bindings.find((b:any)=>b.peerId===c.id&&b.active),actor={host:'claude',memberId:c.id,sessionId:c.sessionId,callId:'checkpoint',binding:{key:binding.key,epoch:binding.epoch}};
  await brokerCall('checkpoint',{actor,input:{action:'set',path:checkpoint}},{home});
  await terminal.prompt('/compact CALLER_KEEP_NATIVE_MARKER');await terminal.wait(()=>events().some(e=>e.stage==='end'&&e.trigger==='manual'),'原生手动压缩未完成',35000);
  phase='after_manual';await turn('继续处理原有任务');
  const manual=events().find(e=>e.stage==='end'&&e.trigger==='manual');assert.equal(manual.recovery?.length,1);assert.ok(manual.recovery[0].includes('checkpoint '+JSON.stringify(path.resolve(checkpoint))));
  assert.ok(manual.recovery[0].startsWith('〔nxbridge 压缩后自动附上的恢复信息，供 AI 接续工作，你无需处理〕\n'));
  assert.match(manual.recovery[0],/partner msgs since your last send \(<=3, newest first\): none;/);assert.doesNotMatch(manual.recovery[0],/w\/o your linked reply|your msgs w\/o partner reply/);
  const after=requests.filter(r=>r.phase==='after_manual'&&r.body.tools?.some((v:any)=>v.name==='ListAgents'));assert.ok(after.some(r=>JSON.stringify(r.body.messages).includes('nxbridge recovery facts rev ')),'已安装恢复事实未进入实际模型请求');
  assert.ok(requests.some(r=>JSON.stringify(r.body.messages).includes('CALLER_KEEP_NATIVE_MARKER')&&JSON.stringify(r.body.messages).includes('keep codex partner tasks/decisions')),'压缩请求未同时保留调用方说明与已批准引导');
  phase='auto';await turn('在此轮触发原生自动压缩边界');
  const observed=events();assert.ok(observed.some(e=>e.stage==='end'&&e.trigger==='auto'),'高用量原生工具轮没有触发自动压缩');
  for(const e of observed.filter(e=>e.stage==='end'&&e.trigger==='precompute'))assert.equal(e.recovery?.length,0,'预计算不能追加已安装恢复事实');
  assert.equal(errors.length,0);passed=true;t.diagnostic(JSON.stringify({nativePid:terminal.identity.pid,manual:true,auto:true,precomputeObserved:observed.some(e=>e.trigger==='precompute'),events:observed,realModelCalls:0}));
});
