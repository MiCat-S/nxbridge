import { overrideEnvironment } from '../tests/support/environment.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { ClaudeAdapter } from '../hosts/claude/adapter.js';
import { temporaryDirectory } from '../tests/support/temporary.js';
import { setupPublish as setup, uninstallPublish as uninstall } from './publish-fixture.js';
import { brokerCall } from '../ipc/ipc.js';
import {DEFAULT_CONFIG} from '../config/defaults.js';
import {delay} from '../shared/time.js';
import {runCli,resolveCli} from '../process/host-command.js';
import {PACKAGE_ROOT} from '../shared/package-location.js';
import {windowsPowerShell} from '../shared/windows-tools.js';
import { processIdentity } from '../process/process.js';
import { pairLegacyClaude } from './legacy-claude-fixture.js';

const execute=promisify(execFile);

test('官方 Claude：消息、搭档问答、来源路由与可取消等待', {skip:!['win32','linux','darwin'].includes(process.platform),timeout:Math.max(180000,Number(process.env.NXBRIDGE_TEST_ASK_HOLD_MS??0)+180000)},async t=>{
  const temp=temporaryDirectory(),directory=temp.directory,nxhome=path.join(directory,'bridge'),claudehome=path.join(directory,'claude'),codexhome=path.join(directory,'codex');
  for(const d of [nxhome,claudehome,codexhome])mkdirSync(d,{recursive:true});
  const requests:any[]=[],pids=new Set<number>();let sessionId:string|undefined;
  let phase='messages',questionId='';
  let checkpoint='setup';
  const trace=setInterval(()=>process.stderr.write(JSON.stringify({nativeCheckpoint:checkpoint,phase,modelRequests:requests.length})+'\n'),15000);trace.unref();
  const nativeQuestions=[{question:'选择输出格式？',header:'格式',options:[{label:'搭档答案',description:'由搭档回答'},{label:'原生回退',description:'升级时使用'}],multiSelect:false}];
  const model=http.createServer(async(req,res)=>{
    let raw='';for await(const chunk of req)raw+=chunk;
    if(!req.url?.includes('/v1/messages')||req.url.includes('count_tokens')){res.writeHead(200,{'content-type':'application/json'});res.end('{"input_tokens":1,"data":[]}');return;}
    const body=JSON.parse(raw);requests.push(body);const n=requests.length;
    const main=body.tools?.some((v:any)=>v.name==='ListAgents');
    const results=(body.messages??[]).flatMap((m:any)=>Array.isArray(m.content)?m.content:[]).filter((c:any)=>c.type==='tool_result');
    const answerName=body.tools?.find((v:any)=>/answer_question$/.test(v.name))?.name;
    const phaseId='native-question-'+phase;
    const tool=main&&phase==='codexAsk'&&!results.some((r:any)=>r.tool_use_id===phaseId)?answerName:main&&['claudeAsk','needsUser','timeout'].includes(phase)&&!results.some((r:any)=>r.tool_use_id===phaseId)?'AskUserQuestion':main&&!results.some((r:any)=>r.tool_use_id==='native-list')?'ListAgents':main&&!results.some((r:any)=>r.tool_use_id==='native-send')?'SendMessage':undefined;
    const answer=main?'测试完成':JSON.stringify(body.system).includes('security monitor')?'<severity>0</severity>':'{"state":"done"}';
    const id=tool==='ListAgents'?'native-list':tool==='SendMessage'?'native-send':phaseId;
    const toolInput=tool==='ListAgents'?{}:tool==='SendMessage'?{to:'nxbridge:codex',message:'Claude 原生 Mod 回信成功'}:tool==='AskUserQuestion'?{questions:nativeQuestions}:{request_id:questionId,answers:{'选择输出格式？':'搭档答案'},rationale:'原生注册工具回答。'};
    const block=tool?{type:'tool_use',id,name:tool,input:{}}:{type:'text',text:''};
    const delta=tool?{type:'input_json_delta',partial_json:JSON.stringify(toolInput)}:{type:'text_delta',text:answer};
    if(!body.stream){res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({id:`msg_${n}`,type:'message',role:'assistant',model:body.model,content:[{type:'text',text:answer}],stop_reason:'end_turn',stop_sequence:null,usage:{input_tokens:10,output_tokens:10}}));return;}
    res.writeHead(200,{'content-type':'text/event-stream'});
    const events=[
      {type:'message_start',message:{id:`msg_${n}`,type:'message',role:'assistant',model:body.model,content:[],stop_reason:null,stop_sequence:null,usage:{input_tokens:10,output_tokens:1}}},
      {type:'content_block_start',index:0,content_block:block},{type:'content_block_delta',index:0,delta},{type:'content_block_stop',index:0},
      {type:'message_delta',delta:{stop_reason:tool?'tool_use':'end_turn',stop_sequence:null},usage:{output_tokens:10}},{type:'message_stop'},
    ];
    for(const e of events)res.write(`event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`);res.end();
  });
  await new Promise<void>(resolve=>model.listen(0,'127.0.0.1',resolve));
  const env:Record<string,string>={NXBRIDGE_HOME:nxhome,CLAUDE_CONFIG_DIR:claudehome,CODEX_HOME:codexhome,ANTHROPIC_API_KEY:'nxbridge-test-key',ANTHROPIC_BASE_URL:`http://127.0.0.1:${(model.address() as AddressInfo).port}`,DISABLE_AUTOUPDATER:'1',DISABLE_TELEMETRY:'1',CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC:'1'};
  const restoreEnvironment=overrideEnvironment(env);
  t.after(async()=>{
    clearInterval(trace);
                                                   
    try{await temp.cleanup();}finally{model.closeAllConnections();await new Promise<void>(resolve=>model.close(()=>resolve()));restoreEnvironment();}
  });
                                  
  const wrapper=path.join(directory,'claude-wrapper.mjs'),nativeClaude=resolveCli('claude');
  writeFileSync(wrapper,`import {spawn} from 'node:child_process';delete process.env.NXBRIDGE_OWNED_LAUNCH;const c=spawn(${JSON.stringify(nativeClaude.command)},[...${JSON.stringify(nativeClaude.prefix)},...process.argv.slice(2)],{env:process.env,stdio:'inherit',windowsHide:true});c.on('exit',code=>process.exit(code??1));c.on('error',()=>process.exit(1));`,'utf8');
  const config={...DEFAULT_CONFIG,compatibilityWake:'strict' as const,claudeCommand:[process.execPath,wrapper],claudeHome:claudehome};
  writeFileSync(path.join(nxhome,'config.json'),JSON.stringify(config));
                               
  const nativeCwd=process.platform==='win32'?(await execute(windowsPowerShell(),['-NoProfile','-NonInteractive','-Command','(Get-Location).Path'],{cwd:directory,windowsHide:true})).stdout.trim():directory;
  const shortCwd=process.platform==='win32'?(await execute(windowsPowerShell(),['-NoProfile','-NonInteractive','-Command','$fs=New-Object -ComObject Scripting.FileSystemObject; $fs.GetFolder((Get-Location).Path).ShortPath'],{cwd:directory,windowsHide:true})).stdout.trim():directory;
                                              
  const projects=Object.fromEntries([directory,nativeCwd,shortCwd,realpathSync(directory)].map(p=>[p.replaceAll('\\','/'),{hasTrustDialogAccepted:true}]));
  writeFileSync(path.join(claudehome,'.claude.json'),JSON.stringify({hasCompletedOnboarding:true,customApiKeyResponses:{approved:[env.ANTHROPIC_API_KEY!.slice(-20)],rejected:[]},projects}));
  writeFileSync(path.join(claudehome,'settings.json'),JSON.stringify({crossSessionInbound:'accept',autoUpdatesChannel:'stable',env:{ANTHROPIC_API_KEY:env.ANTHROPIC_API_KEY,ANTHROPIC_BASE_URL:env.ANTHROPIC_BASE_URL,CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC:'1'}}));
  await setup();
  checkpoint='plugin-inventory';
  assert.match(await runCli('claude',['plugin','validate',path.join(nxhome,'marketplace','plugins','claude')]),/Validation passed/);
  const installedPlugins=JSON.parse(await runCli('claude',['plugin','list','--json']));
  const runtime=await processIdentity(process.pid);
  const source=await brokerCall('register',{host:'codex',sessionId:'codex-fixture',cwd:directory,name:'Codex 测试搭档',kind:'root',permission:'prompting',endpoint:{mode:'embedded',address:'',epoch:'fixture',pid:process.pid,procStart:runtime.startedAt}});
                                                           
  await pairLegacyClaude(nxhome,directory,config,source.id);
  assert.equal(requests.length,0);
  checkpoint='initial-delivery';
  const incoming=await brokerCall('send',{actor:{host:'codex',sessionId:'codex-fixture',callId:'initial'},message:`测试原生 inbox 和搭档回信，参考 [问答](<${path.join(PACKAGE_ROOT,'src/integration/mcp/questions.ts')}:12>) [插件](<${path.join(PACKAGE_ROOT,'plugins/claude')}>)`},{timeout:60000});
  let status:any;
  const deadline=Date.now()+60000;
  while(Date.now()<deadline){
    status=await brokerCall('status');const partner=status.pair&&status.peers.find((p:any)=>p.id===status.pair.claude);sessionId=partner?.sessionId;
    const endpoint=status.endpoints?.find((e:any)=>e.peerId===partner?.id&&e.active);if(endpoint?.pid)pids.add(endpoint.pid);
    const returned=requests.some(r=>(r.messages??[]).some((m:any)=>Array.isArray(m.content)&&m.content.some((c:any)=>c.type==='tool_result'&&c.tool_use_id==='native-send')));
    if(status.messages?.some((m:any)=>m.body==='Claude 原生 Mod 回信成功')&&returned)break;
    if(partner?.state==='needsHuman')break;
    await delay(300);
  }
  if(!status.messages?.some((m:any)=>m.body==='Claude 原生 Mod 回信成功')){
    const logs=path.join(nxhome,'run','broker.log');
    const agents=JSON.parse(await runCli('claude',['agents','--json','--all']));
    let workerLog='';if(agents[0]?.id)try{workerLog=await runCli('claude',['logs',agents[0].id],{timeout:3000});}catch(e){workerLog=String(e);}
    const sessions=path.join(claudehome,'sessions');const records=existsSync(sessions)?readdirSync(sessions).filter(f=>/^\d+\.json$/.test(f)).map(f=>JSON.parse(readFileSync(path.join(sessions,f),'utf8'))):[];
    t.diagnostic(JSON.stringify({installedPlugins,settings:JSON.parse(readFileSync(path.join(claudehome,'settings.json'),'utf8')),requests:requests.map(r=>({model:r.model,tools:r.tools?.map((v:any)=>v.name),output_config:r.output_config,system:JSON.stringify(r.system).slice(0,700),lastMessage:JSON.stringify(r.messages?.at(-1)).slice(-2200)})),sessionId,nativeCwd,agents,records,workerLog:workerLog.slice(-2500),status,events:await brokerCall('events'),brokerLog:readFileSync(logs,'utf8').slice(-2500),claudeFiles:readdirSync(claudehome,{recursive:true}).filter(p=>!p.includes('plugins'))},null,2));
  }
  assert.ok(sessionId);assert.equal(status.peers.find((p:any)=>p.sessionId===sessionId).owner,'nxbridge');
  assert.ok(status.messages.some((m:any)=>m.body==='Claude 原生 Mod 回信成功'));
  const mainRequests=requests.filter(r=>r.tools?.some((v:any)=>v.name==='ListAgents'));
  assert.ok(mainRequests.length>=3);
  assert.match(JSON.stringify(mainRequests),/bar: you usually set it, once per task/,'原生模型请求没有载入任务完成度规则');
  assert.match(JSON.stringify(mainRequests),/watch codex for waste/,'原生模型请求没有载入 Codex 偏移提醒');
  const results=mainRequests.flatMap(r=>r.messages??[]).flatMap(m=>Array.isArray(m.content)?m.content:[]).filter(c=>c.type==='tool_result');
  assert.match(JSON.stringify(results.find(c=>c.tool_use_id==='native-list')?.content),/codex peer: nxbridge:codex/);
  assert.match(JSON.stringify(mainRequests),new RegExp(incoming.message_id));
  assert.match(JSON.stringify(mainRequests),/nxbridge: 2 file refs/);
  const sendResult=results.find(c=>c.tool_use_id==='native-send');assert.ok(sendResult&&!sendResult.is_error);
  assert.match(JSON.stringify(sendResult.content),/handed to nxbridge; it delivers \+ reports problems itself \(routine, not user news\); message_id=/);
  assert.ok(['contextObserved','responded'].includes(status.messages.find((m:any)=>m.id===incoming.message_id).state),'正文必须已进入上下文；自动关联回复可能已将回执推进到 responded');
  assert.ok(mainRequests.some(r=>r.tools?.some((v:any)=>/answer_question$/.test(v.name))),'Mod 未注册 answer_question');
  const launches=await brokerCall<any>('launch.status');assert.equal(launches.profiles.some((profile:any)=>profile.host==='claude'&&profile.sourceSession===sessionId),false,'自有后台 Claude 不能覆盖用户启动记录');assert.ok(launches.observations.some((profile:any)=>profile.host==='claude'&&profile.sourceSession===sessionId),'Mod 没有绑定自有会话的实际配置目录');
                                 
  const noticeId=randomUUID(),target=status.peers.find((p:any)=>p.sessionId===sessionId),sender=status.peers.find((p:any)=>p.sessionId==='codex-fixture');
  const targetEndpoint=status.endpoints.find((e:any)=>e.peerId===target.id&&e.active),noticeAdapter=new ClaudeAdapter(DEFAULT_CONFIG);
  try{await noticeAdapter.deliver(target,targetEndpoint,{...status.messages.find((m:any)=>m.id===incoming.message_id),id:noticeId,body:'nxbridge runtime monitor (not partner reply): 原生通知验收',inReplyTo:null,notice:true},sender);}
  finally{noticeAdapter.close();}
  const noticeDeadline=Date.now()+15000;
  while(!requests.some(r=>r.tools?.some((v:any)=>v.name==='ListAgents')&&JSON.stringify(r.messages).includes(noticeId))){
    assert.ok(Date.now()<noticeDeadline,'系统通知未自动进入 Claude 模型上下文');await delay(100);
  }
  const noticeRequest=requests.find(r=>r.tools?.some((v:any)=>v.name==='ListAgents')&&JSON.stringify(r.messages).includes(noticeId));
  assert.match(JSON.stringify(noticeRequest.messages),/system_notice source=runtime_monitor notice_id=/);
  assert.equal((await brokerCall('status')).messages.some((m:any)=>m.id===noticeId),false);
  const actor={host:'codex',sessionId:'codex-fixture',callId:'codex-ask'};
  checkpoint='partner-questions';
  phase='codexAsk';
  const asked=await brokerCall('question.create',{actor,questions:[{id:'format',header:'格式',question:'选择输出格式？',options:nativeQuestions[0]!.options}]});questionId=asked.request_id;
  const waitUntil=async(predicate:()=>Promise<boolean>,timeout=45000)=>{
    const deadline=Date.now()+timeout;
    while(!await predicate()){
      if(Date.now()>deadline){
        let logs='';try{const agents=JSON.parse(await runCli('claude',['agents','--json','--all'])),agent=agents.find((a:any)=>a.sessionId===sessionId);if(agent?.id)logs=await runCli('claude',['logs',agent.id],{timeout:3000});}catch{}
        throw Error(JSON.stringify({phase,logs:logs.slice(-3500),status:await brokerCall('status'),last:requests.slice(-2).map(r=>({tools:r.tools?.map((v:any)=>v.name),messages:r.messages?.slice(-3)}))}));
      }
      await delay(100);
    }
  };
  await waitUntil(async()=> (await brokerCall('status')).questions.some((q:any)=>q.id===questionId&&q.status==='answered'));
  assert.equal((await brokerCall('status')).questions.find((q:any)=>q.id===questionId).source.kind,'partner');
  await waitUntil(async()=>requests.some(r=>r.messages?.some((m:any)=>Array.isArray(m.content)&&m.content.some((v:any)=>v.type==='tool_result'&&v.tool_use_id==='native-question-codexAsk'))));
  const answerReceipt=requests.flatMap(r=>r.messages??[]).flatMap(m=>Array.isArray(m.content)?m.content:[]).find(v=>v.type==='tool_result'&&v.tool_use_id==='native-question-codexAsk');assert.equal(Boolean(answerReceipt.is_error),false);assert.match(JSON.stringify(answerReceipt.content),/answered/);
                                          
  await waitUntil(async()=> (await brokerCall('status')).peers.some((p:any)=>p.sessionId===sessionId&&p.state==='ready'));
  for(const scenario of ['claudeAsk',process.env.NXBRIDGE_TEST_ASK_HOLD_MS?'timeout':'needsUser']){
    phase=scenario;
    await brokerCall('send',{actor:{...actor,callId:scenario},message:'请调用原生提问验证 '+scenario});
    let pending:any;
    await waitUntil(async()=>{pending=(await brokerCall('status')).questions.find((q:any)=>q.format==='claude'&&q.status==='pending'&&q.id!==questionId);return Boolean(pending);});
    questionId=pending.id;
    if(scenario==='timeout'){
      await waitUntil(async()=> (await brokerCall('status')).questions.some((q:any)=>q.id===questionId&&q.status==='timed_out'),Number(process.env.NXBRIDGE_TEST_ASK_HOLD_MS)+20000);
    }else{
      await delay(scenario==='claudeAsk'?1100:100);
      await brokerCall('question.answer',{actor:{...actor,callId:'answer-'+scenario},input:scenario==='needsUser'?{request_id:questionId,action:'needs_user',rationale:'需要用户决定。'}:{request_id:questionId,answers:{q1:{answers:['搭档答案']}},rationale:'Codex 控制回答。'}});
    }
    if(scenario!=='claudeAsk'){
      await waitUntil(async()=> (await brokerCall('status')).peers.some((p:any)=>p.sessionId===sessionId&&p.state==='needsHuman'));
      const agent=JSON.parse(await runCli('claude',['agents','--json','--all'])).find((a:any)=>a.sessionId===sessionId);
      assert.match(await runCli('claude',['logs',agent.id]),/Enter to select/);
      if(scenario==='timeout')assert.ok(Date.now()-pending.createdAt>=600000,'默认十分钟边界未实际等待');
      break;
    }
    await waitUntil(async()=>requests.some(r=>r.messages?.some((m:any)=>Array.isArray(m.content)&&m.content.some((v:any)=>v.type==='tool_result'&&v.tool_use_id==='native-question-'+scenario))));
    const result=requests.flatMap(r=>r.messages??[]).flatMap(m=>Array.isArray(m.content)?m.content:[]).find(v=>v.type==='tool_result'&&v.tool_use_id==='native-question-'+scenario);
    assert.equal(Boolean(result.is_error),false);assert.match(JSON.stringify(result.content),scenario==='claudeAsk'?/搭档答案/:/原生回退/);
    assert.ok(requests.some(r=>r.tools?.some((v:any)=>v.name==='ListAgents')&&JSON.stringify(r.messages).includes('answered by codex partner, not user')));
    await waitUntil(async()=> (await brokerCall('status')).peers.some((p:any)=>p.sessionId===sessionId&&p.state==='ready'));
  }
  checkpoint='uninstall';
  const removed=await uninstall() as any;assert.equal(removed.removed,true);assert.deepEqual(removed.notes,[]);
  await assert.rejects(brokerCall('ping'),/已卸载/);
  t.diagnostic('真实 Claude 后台会话、peerToken、Mod 工具接管和回信通过；真实模型调用为 0。');
});
