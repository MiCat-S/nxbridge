import { overrideEnvironment } from '../tests/support/environment.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import { mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { temporaryDirectory } from '../tests/support/temporary.js';
import { setupPublish } from './publish-fixture.js';
import { brokerCall } from '../ipc/ipc.js';
import {DEFAULT_CONFIG} from '../config/defaults.js';
import {delay} from '../shared/time.js';
import {resolveCli,runCli} from '../process/host-command.js';
import { processIdentity } from '../process/process.js';
import { ClaudeAdapter } from '../hosts/claude/adapter.js';
import { NativeTerminal } from './terminal-fixture.js';
import { stripVTControlCharacters } from 'node:util';
import { Store } from '../storage/store.js';
import { prepareOwnedLaunch, selectHostLaunch } from '../hosts/host-launch.js';
import { beginNativeLaunch, saveNativeOwnership, nativeLaunchHandle, bindNativeLaunch } from '../process/owned-native.js';

test('官方 Claude 自动模式不可用：保留历史的手动副本、实际审批和普通恢复',{skip:process.platform!=='win32',timeout:165000},async t=>{
  const temp=temporaryDirectory(),root=temp.directory,home=path.join(root,'bridge'),claudehome=path.join(root,'claude'),codexhome=path.join(root,'codex'),proof=path.join(root,'manual-proof.txt');
  for(const directory of [home,claudehome,codexhome])mkdirSync(directory,{recursive:true});
  const requests:any[]=[],errors:string[]=[],emittedTools:string[]=[];let phase='auto',terminal:NativeTerminal|undefined;
  const nativeEvents=path.join(root,'native-events.jsonl'),recorder=path.join(root,'record.mjs'),overlay=path.join(root,'native-observer'),wrapper=path.join(root,'claude-wrapper.mjs'),nativeCli=resolveCli('claude').command;
  mkdirSync(path.join(overlay,'.claude-plugin'),{recursive:true});mkdirSync(path.join(overlay,'hooks'));
  writeFileSync(recorder,`import{appendFileSync}from'node:fs';let text='';for await(const chunk of process.stdin)text+=chunk;appendFileSync(${JSON.stringify(nativeEvents)},text.trim()+'\\n','utf8');`,'utf8');
  writeFileSync(path.join(overlay,'.claude-plugin/plugin.json'),JSON.stringify({name:'nxbridge-native-observer',version:'0.0.1'}),'utf8');
  writeFileSync(path.join(overlay,'hooks/hooks.json'),JSON.stringify({modules:['./register.js']}),'utf8');
  writeFileSync(path.join(overlay,'hooks/register.js'),`export const register=on=>{on('tool.call',async($,e,next)=>{const r=await next(e);await $.process.run(['node',${JSON.stringify(recorder)}],{stdin:JSON.stringify({event:'tool.call',tool:e.tool,id:e.tool_use_id,result:r})});return r;});on('telemetry.log',{to:'collector',event:'tool_decision'},async($,e,next)=>{await $.process.run(['node',${JSON.stringify(recorder)}],{stdin:JSON.stringify({event:'tool_decision',attributes:e.attributes})});return next(e);});on('classic.Stop',async($,e,next)=>{await $.process.run(['node',${JSON.stringify(recorder)}],{stdin:JSON.stringify({event:'Stop',payload:e})});return next(e);});};`,'utf8');
  writeFileSync(wrapper,`import{spawn}from'node:child_process';const args=process.argv.slice(2);if(args.includes('--bg')&&(!args.includes('--resume')||args.includes('--permission-mode')))args.push('--plugin-dir',${JSON.stringify(overlay)});const child=spawn(${JSON.stringify(nativeCli)},args,{stdio:'inherit',env:process.env,windowsHide:true});child.on('exit',code=>process.exit(code??1));child.on('error',()=>process.exit(1));`,'utf8');
  const proofScript=path.join(root,'write-proof.mjs');writeFileSync(proofScript,`import fs from 'node:fs';fs.writeFileSync(${JSON.stringify(proof)},'MANUAL_APPROVED','utf8');`,'utf8');
  const command=JSON.stringify(process.execPath.replaceAll('\\','/'))+' '+JSON.stringify(proofScript.replaceAll('\\','/'));
  const model=http.createServer(async(req,res)=>{try{
    let raw='';for await(const chunk of req)raw+=chunk;
    if(!req.url?.includes('/v1/messages')||req.url.includes('count_tokens')){res.writeHead(200,{'content-type':'application/json'});res.end('{"input_tokens":1,"data":[]}');return;}
    const body=JSON.parse(raw);requests.push(body);const main=!/haiku/.test(body.model)&&body.tools?.some((tool:any)=>tool.name==='ListAgents'),results=(body.messages??[]).flatMap((message:any)=>Array.isArray(message.content)?message.content:[]),tool=main&&!results.some((block:any)=>block.type==='tool_result'&&block.tool_use_id==='mode-proof-'+phase);
    const content=tool?{type:'tool_use',id:'mode-proof-'+phase,name:phase==='auto'?'Agent':'Bash',input:phase==='auto'?{description:'核验分类器不可用',subagent_type:'general-purpose',model:'haiku',prompt:'只输出 AUTO_PROOF'}:{command}}:{type:'text',text:main?'MODE_PROOF_DONE':'AUTO_PROOF'};
    if(tool)emittedTools.push(phase);
    const response={id:'mode-'+requests.length,type:'message',role:'assistant',model:body.model,content:[content],stop_reason:tool?'tool_use':'end_turn',stop_sequence:null,usage:{input_tokens:10,output_tokens:5}};
    if(!body.stream){res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify(response));return;}
    res.writeHead(200,{'content-type':'text/event-stream'});
    for(const event of [{type:'message_start',message:{...response,content:[],stop_reason:null}},{type:'content_block_start',index:0,content_block:tool?{...content,input:{}}:{type:'text',text:''}},{type:'content_block_delta',index:0,delta:tool?{type:'input_json_delta',partial_json:JSON.stringify(content.input)}:{type:'text_delta',text:content.text}},{type:'content_block_stop',index:0},{type:'message_delta',delta:{stop_reason:response.stop_reason,stop_sequence:null},usage:{output_tokens:5}},{type:'message_stop'}])res.write('event: '+event.type+'\ndata: '+JSON.stringify(event)+'\n\n');res.end();
  }catch(error){errors.push(String(error));res.writeHead(500);res.end(String(error));}});
  await new Promise<void>(resolve=>model.listen(0,'127.0.0.1',resolve));
  const env={NXBRIDGE_HOME:home,CLAUDE_CONFIG_DIR:claudehome,CODEX_HOME:codexhome,ANTHROPIC_API_KEY:'nxbridge-auto-local-only',ANTHROPIC_BASE_URL:`http://127.0.0.1:${(model.address() as any).port}`,DISABLE_AUTOUPDATER:'1',DISABLE_TELEMETRY:'1',CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC:'1'},restoreEnvironment=overrideEnvironment(env);
  const config={...DEFAULT_CONFIG,compatibilityWake:'strict' as const,claudeHome:claudehome,codexHome:codexhome,claudeBinary:nativeCli,claudeCommand:[process.execPath,wrapper]},adapter=new ClaudeAdapter(config,home);
  t.after(async()=>{try{if(existsSync(nativeEvents))t.diagnostic('原生观察 '+JSON.stringify(readFileSync(nativeEvents,'utf8').trim().split(/\r?\n/).map(line=>{const v=JSON.parse(line);return{event:v.event,tool:v.tool??v.attributes?.tool_name,decision:v.attributes?.decision,mode:v.attributes?.permission_mode,classifier:v.attributes?.classifier_verdict,permission:v.payload?.permission_mode};})));adapter.close();await terminal?.close();await temp.cleanup();}finally{model.closeAllConnections();await new Promise<void>(resolve=>model.close(()=>resolve()));restoreEnvironment();}});
  writeFileSync(path.join(home,'config.json'),JSON.stringify(config),'utf8');
  writeFileSync(path.join(codexhome,'config.toml'),'web_search="disabled"\n[features]\napps=false\nremote_plugin=false\n','utf8');
  writeFileSync(path.join(claudehome,'.claude.json'),JSON.stringify({hasCompletedOnboarding:true,customApiKeyResponses:{approved:[env.ANTHROPIC_API_KEY.slice(-20)],rejected:[]},projects:{[root.replaceAll('\\','/')]:{hasTrustDialogAccepted:true}}}),'utf8');
  writeFileSync(path.join(claudehome,'settings.json'),JSON.stringify({crossSessionInbound:'accept',env:{ANTHROPIC_API_KEY:env.ANTHROPIC_API_KEY,ANTHROPIC_BASE_URL:env.ANTHROPIC_BASE_URL,CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC:'1'}}),'utf8');
  await setupPublish();const identity=await processIdentity(process.pid);
  const source=await brokerCall('register',{host:'codex',sessionId:'mode-source',cwd:root,kind:'root',permission:'prompting',endpoint:{mode:'embedded',address:'',epoch:'mode-source',pid:process.pid,procStart:identity.startedAt}});
                                               
  const store=new Store(path.join(home,'nxbridge.db'));
  try{
    const peer=store.placeholder('claude',root),launch=await prepareOwnedLaunch(selectHostLaunch('claude',config,{home,cwd:root}));
    let ownership=await beginNativeLaunch(home,peer,claudehome);
    launch.env.NXBRIDGE_OWNED_LAUNCH='claude:'+ownership.id;launch.env.NXBRIDGE_MANAGED_PEER=peer.id;
    const output=await runCli('claude',['--bg','--name','legacy-auto-'+peer.id],{home,config,cwd:root,launch,timeout:30000});
    ownership={...ownership,handle:nativeLaunchHandle(output)};saveNativeOwnership(ownership);
    const until=Date.now()+15000;
    while(!ownership.sessionId){const agent=(await adapter.list(undefined,claudehome)).find(agent=>agent.id===ownership.handle);if(agent?.sessionId)ownership=await bindNativeLaunch(ownership,agent);else{assert.ok(Date.now()<until,'既有自动模式夹具未就绪');await delay(100);}}
    store.updatePeer(peer.id,{sessionId:ownership.sessionId});store.pair(peer.id,source.id);
  }finally{store.close();}
  const sent=await brokerCall('send',{actor:{host:'codex',sessionId:'mode-source',callId:'initial'},message:'AUTO_MODE_INITIAL'});
  let status:any,sourceId='',memberId='',pairId='';
  const wait=async(check:()=>boolean|Promise<boolean>,reason:string,timeout=65000)=>{const end=Date.now()+timeout;while(!await check()){if(Date.now()>end)throw Error(reason+' '+JSON.stringify({peers:status?.peers,events:await brokerCall('events'),results:requests.flatMap(body=>(body.messages??[]).flatMap((message:any)=>Array.isArray(message.content)?message.content:[])).filter((block:any)=>block.type==='tool_result'&&block.tool_use_id==='mode-proof-manual').slice(-2),terminal:terminal?stripVTControlCharacters(terminal.output).slice(-3500):undefined}));await delay(100);}};
  await wait(async()=>{status=await brokerCall('status');const peer=status.peers.find((peer:any)=>peer.host==='claude'&&peer.owner==='nxbridge');if(peer){memberId=peer.id;sourceId=peer.claude_auto_mode?.old_session_id??peer.sessionId;pairId=status.pair?.id;}return peer?.claude_auto_mode?.phase==='ready';},'未完成原生手动副本接续');
  const current=status.peers.find((peer:any)=>peer.id===memberId);assert.notEqual(current.sessionId,sourceId);assert.equal(status.pair.id,pairId);assert.equal(status.messages.find((message:any)=>message.id===sent.message_id).attempts,1);
  const initialResults=requests.flatMap(body=>(body.messages??[]).flatMap((message:any)=>Array.isArray(message.content)?message.content:[])).filter((block:any)=>block.type==='tool_result'&&block.tool_use_id==='mode-proof-auto');assert.ok(initialResults.some((result:any)=>result.is_error&&String(result.content).startsWith('Auto mode is unavailable:')));
  phase='manual';await brokerCall('send',{actor:{host:'codex',sessionId:'mode-source',callId:'manual'},message:'MANUAL_APPROVAL_PROOF'});
  await wait(async()=>{status=await brokerCall('status');return status.peers.find((peer:any)=>peer.id===memberId)?.state==='needsHuman';},'手动模式未等待人工审批',20000);assert.equal(existsSync(proof),false);
  const handle=await adapter.handle(current.sessionId);terminal=await NativeTerminal.start(root,home,config.claudeBinary,['attach',handle],root,{...process.env,TERM:'xterm-256color',COLORTERM:'truecolor'});
  await terminal.wait(()=>/write-proof/.test(terminal!.output)&&/Yes|Do you want|Enter to select/.test(terminal!.output),'未绘制原生工具审批',20000);assert.equal(existsSync(proof),false);await terminal.prompt('');
  await wait(()=>existsSync(proof),'用户批准后工具没有执行',15000);assert.equal(readFileSync(proof,'utf8'),'MANUAL_APPROVED');
  await wait(async()=>{status=await brokerCall('status');return status.peers.find((peer:any)=>peer.id===memberId)?.state==='ready';},'手动模式轮次未完成',15000);
  assert.ok(requests.some(body=>JSON.stringify(body.messages).includes('AUTO_MODE_INITIAL')&&JSON.stringify(body.messages).includes('MANUAL_APPROVAL_PROOF')),'副本未保留原历史');assert.deepEqual(errors,[]);
  const decisions=readFileSync(nativeEvents,'utf8').trim().split(/\r?\n/).map(line=>JSON.parse(line)).filter(value=>value.event==='tool_decision');
  assert.ok(decisions.some(value=>value.attributes.tool_use_id==='mode-proof-manual'&&value.attributes.permission_mode==='default'&&value.attributes.decision==='accept'),'用户批准后的原生实际模式必须为 default');
  assert.deepEqual(emittedTools,['auto','manual'],'被拒工具不能在副本中自动重放');
  await terminal.close();terminal=undefined;await brokerCall('pause',{pair_id:pairId});const before=status.peers.find((peer:any)=>peer.id===memberId);await adapter.release(before);await adapter.wake(before);const resumed=await adapter.discover(before.sessionId);assert.equal(resumed?.sessionId,before.sessionId,'不加权限参数的普通恢复必须保留手动副本 ID');
  t.diagnostic(JSON.stringify({oldSessionId:sourceId,sessionId:current.sessionId,memberId,pairId,approved:true,plainResumeSameId:true,realModelCalls:0}));
});
