import { overrideEnvironment } from '../tests/support/environment.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { temporaryDirectory } from '../tests/support/temporary.js';
import { FakeAdapter } from '../tests/support/fake-adapter.js';
import { setupPublish } from './publish-fixture.js';
import { NativeTerminal } from './terminal-fixture.js';
import { holdModelStream } from './model-stream-fixture.js';
import { listenBroker } from '../ipc/ipc.js';
import { ensureHome } from '../ipc/home.js';
import { DEFAULT_CONFIG } from '../config/defaults.js';
import { resolveCli } from '../process/host-command.js';
import { processIdentity } from '../process/process.js';
import { Store } from '../storage/store.js';
import { Broker } from '../broker/coordinator.js';
import { ClaudeAdapter } from '../hosts/claude/adapter.js';
import { delay } from '../shared/time.js';

                                                              
                                      
test('实际 Claude：Codex 结束一轮未告知时，Claude 忙时不送；空闲后经原生队列叫醒一次并收到原文',{skip:process.platform!=='win32',timeout:170000},async t=>{
  const temp=temporaryDirectory(),root=temp.directory,home=path.join(root,'bridge'),claudehome=path.join(root,'claude'),codexhome=path.join(root,'codex');
  for(const directory of [home,claudehome,codexhome])mkdirSync(directory,{recursive:true});
  const FINAL='NATIVE_CODEX_FINAL 候选已从干净代码构建；剩余公网逐项检查，下一步等 Claude 决定',HOLD='NATIVE_FINAL_HOLD';
  const requests:{text:string;at:number}[]=[],calls:{method:string;at:number;readyBoundary:boolean}[]=[],errors:string[]=[];
  let terminal:NativeTerminal|undefined,holder:ChildProcess|undefined,listener:Awaited<ReturnType<typeof listenBroker>>|undefined,passed=false,phase='启动';
  let held=false,released=false,holding=false;
  const started=Date.now(),stage=(name:string)=>{phase=name;process.stderr.write(JSON.stringify({codexFinalStage:name,elapsedMs:Date.now()-started})+'\n');};
  const model=http.createServer(async(req,res)=>{try{
    let raw='';for await(const chunk of req)raw+=chunk;
    if(!req.url?.includes('/v1/messages')||req.url.includes('count_tokens')){res.writeHead(200,{'content-type':'application/json'});res.end('{"input_tokens":1,"data":[]}');return;}
    const body=JSON.parse(raw),main=body.tools?.some((tool:any)=>tool.name==='ListAgents'),text=JSON.stringify(body.messages??[]);
    if(main)requests.push({text,at:Date.now()});
                                                  
    const hold=main&&!held&&text.includes(HOLD);if(hold)held=true;
    const reply=main?'NATIVE_FINAL_ACK':JSON.stringify(body.system).includes('security monitor')?'<severity>0</severity>':'{"state":"done"}';
    const message={id:'final-'+Date.now(),type:'message',role:'assistant',model:body.model,content:[{type:'text',text:reply}],stop_reason:'end_turn',stop_sequence:null,usage:{input_tokens:10,output_tokens:5}};
    if(!body.stream){res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify(message));return;}
    res.writeHead(200,{'content-type':'text/event-stream'});
    const emit=(event:any)=>res.write('event: '+event.type+'\ndata: '+JSON.stringify(event)+'\n\n');
    emit({type:'message_start',message:{...message,content:[],stop_reason:null}});
    emit({type:'content_block_start',index:0,content_block:{type:'text',text:''}});
    if(hold){holding=true;const until=Date.now()+90000;while(!released&&Date.now()<until)if(!await holdModelStream(res,500))return;holding=false;}
    for(const event of [{type:'content_block_delta',index:0,delta:{type:'text_delta',text:reply}},{type:'content_block_stop',index:0},{type:'message_delta',delta:{stop_reason:'end_turn',stop_sequence:null},usage:{output_tokens:5}},{type:'message_stop'}])emit(event);
    res.end();
  }catch(error){errors.push(String(error));if(!res.headersSent)res.writeHead(500);res.end(String(error));}});
  await new Promise<void>(resolve=>model.listen(0,'127.0.0.1',resolve));
  const env={NXBRIDGE_HOME:home,CLAUDE_CONFIG_DIR:claudehome,CODEX_HOME:codexhome,ANTHROPIC_API_KEY:'native-final-local-key',ANTHROPIC_BASE_URL:`http://127.0.0.1:${(model.address() as any).port}`,DISABLE_AUTOUPDATER:'1',DISABLE_TELEMETRY:'1',CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC:'1',CLAUDE_CODE_DISABLE_BACKGROUND_TASKS:'1'};
  const restore=overrideEnvironment(env);
  const config={...DEFAULT_CONFIG,implicit:'never' as const,compatibilityWake:'strict' as const,claudeHome:claudehome,codexHome:codexhome};
  writeFileSync(path.join(home,'config.json'),JSON.stringify(config),'utf8');
  writeFileSync(path.join(codexhome,'config.toml'),'web_search="disabled"\n[features]\napps=false\nremote_plugin=false\n','utf8');
  writeFileSync(path.join(claudehome,'.claude.json'),JSON.stringify({hasCompletedOnboarding:true,customApiKeyResponses:{approved:[env.ANTHROPIC_API_KEY.slice(-20)],rejected:[]},projects:{[root.replaceAll('\\','/')]:{hasTrustDialogAccepted:true}}}),'utf8');
  writeFileSync(path.join(claudehome,'settings.json'),JSON.stringify({crossSessionInbound:'accept',env:{ANTHROPIC_API_KEY:env.ANTHROPIC_API_KEY,ANTHROPIC_BASE_URL:env.ANTHROPIC_BASE_URL,CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC:'1'}}),'utf8');
  await ensureHome(home);
  const store=new Store(path.join(home,'nxbridge.db')),claudeAdapter=new ClaudeAdapter(config,home);
  const broker=new Broker(store,config,{codex:new FakeAdapter(),claude:claudeAdapter} as any,home);
  t.after(async()=>{
    try{
      if(!passed)t.diagnostic(JSON.stringify({phase,errors,holding,requests:requests.map(r=>({at:r.at-started,codexFinal:r.text.includes('[nxbridge codex_final]'),final:r.text.includes(FINAL)})),calls:calls.slice(-40),pairs:store.pairs(),peers:store.peers().map(p=>({id:p.id,host:p.host,state:p.state,owner:p.owner})),forward:(()=>{try{const codex=store.peers().find(p=>p.host==='codex');return codex?broker.finalForwards.status(codex):undefined;}catch(error){return String(error);}})(),terminal:terminal?.output.slice(-2500)}));
      await terminal?.close();
      if(holder&&holder.exitCode===null&&holder.signalCode===null){const exit=once(holder,'exit');holder.kill();await exit;}
      await listener?.close();await broker.stop(false);claudeAdapter.close();
    }finally{store.close();model.closeAllConnections();if(model.listening)await new Promise<void>(resolve=>model.close(()=>resolve()));restore();await temp.cleanup();}
  });
                                                             
  listener=await listenBroker(home,async(method,input)=>{
    calls.push({method,at:Date.now()-started,readyBoundary:/"ready_?[bB]oundary":true/.test(JSON.stringify(input??{}))});if(calls.length>400)calls.shift();
    return broker.dispatch(method,input);
  });
  stage('安装隔离发布包');await setupPublish();
  stage('启动实际终端');
  const cli=resolveCli('claude');terminal=await NativeTerminal.start(root,home,cli.command,[...cli.prefix,'--model','claude-sonnet-4-6'],root,{...process.env,TERM:'xterm-256color',COLORTERM:'truecolor'});
  const claude=()=>store.peers().find(p=>p.host==='claude'&&p.kind==='root'&&!!p.sessionId);
                                         
  stage('热身一轮');await terminal.prompt('NATIVE_FINAL_WARMUP');
  await terminal.wait(()=>requests.some(r=>r.text.includes('NATIVE_FINAL_WARMUP'))&&claude()?.state==='ready','实际 Claude 没有完成热身一轮',60000);
  const claudePeer=claude()!;
  stage('登记并配对隔离 Codex 窗口');
  holder=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{windowsHide:true,stdio:'ignore'});await once(holder,'spawn');
  const identity=await processIdentity(holder.pid!),codexSession=randomUUID();
  const codex=await broker.dispatch('register',{host:'codex',sessionId:codexSession,cwd:root,name:'隔离 Codex 窗口',kind:'root',permission:'prompting',state:'ready',endpoint:{mode:'embedded',address:'',epoch:'fixture:'+identity.startedAt,pid:holder.pid,procStart:identity.startedAt}}) as {id:string};
  const pair=store.pair(claudePeer.id,codex.id);
  const history=path.join(codexhome,'sessions','2026','11','23','rollout-fixture-'+codexSession+'.jsonl');mkdirSync(path.dirname(history),{recursive:true});
  writeFileSync(history,JSON.stringify({type:'session_meta',payload:{id:codexSession}})+'\n','utf8');
  store.setSetting('codexTranscript:'+codex.id,{sessionId:codexSession,file:history});
                                           
  for(const child of ['first-child','second-child'])broker.subagentCompletions.record(store.peer(codex.id),child,child+'-turn',undefined,history);
  const childWake=broker.subagentCompletions.reserve(store.peer(codex.id),'native');assert.ok(childWake);
  broker.subagentCompletions.outcome(store.peer(codex.id),childWake,'submitted','completed-child-wake');
  assert.ok(broker.subagentCompletions.consume(store.peer(codex.id),broker.subagentCompletions.context(store.peer(codex.id))));
  broker.subagentCompletions.settle(store.peer(codex.id),history,'completed-child-wake');
  assert.equal(broker.subagentCompletions.status(store.peer(codex.id))?.unconfirmed,2);
                                                       
  const last=store.accept(pair,store.peer(codex.id),'隔离进度：控制台候选已构建，接着做公网检查','fixture-last-send');
  store.transition(last.id,'contextObserved','原生上下文已核验');
  const messagesBefore=store.messages().length;
  stage('Claude 进入实际忙碌');
  await terminal.prompt(HOLD);
  await terminal.wait(()=>holding&&claude()?.state==='busy','实际 Claude 没有进入忙碌',40000);
  stage('Codex 这一轮发信后继续干活、只留最终回复就结束');
  const mark=await broker.finalForwards.origin(store.peer(codex.id),'queue');assert.ok(mark,'原生排队来源预约失败');
  const turnId=randomUUID(),base=Date.now();
  const row=(offset:number,payload:unknown,type='response_item')=>({timestamp:new Date(base+offset).toISOString(),type,payload});
  const event=(offset:number,type:string,extra:object={})=>row(offset,{type,turn_id:turnId,...extra},'event_msg');
  appendFileSync(history,[
    event(10,'task_started',{turn_attribution:{turn_id:turnId,turn_trigger:mark.turnTrigger}}),
    event(20,'item_completed',{thread_id:codexSession,item:{type:'UserMessage',id:'fixture-input',client_id:mark.clientUserMessageId}}),
    row(30,{type:'custom_tool_call',name:'exec',call_id:'fixture-exec'}),row(40,{type:'custom_tool_call_output',call_id:'fixture-exec'}),
    event(50,'item_completed',{thread_id:codexSession,item:{type:'AgentMessage',phase:'final_answer',id:'fixture-answer',content:[{type:'Text',text:FINAL}]}}),
    event(60,'task_complete'),
  ].map(value=>JSON.stringify(value)+'\n').join(''),'utf8');
  const codexPeer=()=>store.peer(codex.id),status=()=>broker.finalForwards.status(codexPeer()) as any;
  await broker.finalForwards.scan(codexPeer());broker.finalForwards.refresh(pair);
  assert.equal(status()?.pending,true,'候选应已形成');assert.equal(status()?.turn_id,turnId);assert.equal(status()?.last_read_message_id,last.id);
  assert.equal(status()?.waiting_children,0,'已通知而未确认的旧记录不是待唤醒任务');
  stage('忙碌期间经过至少一次 Mod 监测');
  const busyFrom=Date.now();await delay(17000);
  assert.equal(claude()?.state,'busy');
  assert.equal(requests.some(r=>r.at>=busyFrom&&r.text.includes('[nxbridge codex_final]')),false,'Claude 忙时不得附入或开启转发');
  assert.ok(status()?.pending&&status()?.hold,'忙时仍待处理，并写明保留原因');
  stage('Claude 停下，等待空闲叫醒');
  const readyFrom=Date.now();released=true;
  await terminal.wait(()=>requests.some(r=>r.at>=readyFrom&&r.text.includes('[nxbridge codex_final]')),'Claude 停下后没有被转发叫醒',75000);
  const woken=requests.filter(r=>r.at>=readyFrom&&r.text.includes('[nxbridge codex_final]'));
  assert.ok(woken[0]!.text.includes(FINAL),'转发必须带 Codex 最终回复原文');assert.ok(woken[0]!.text.includes(last.id),'转发写明 Claude 最后读到的消息');
  assert.match(woken[0]!.text,/Auto-forward 1\/2/);
  assert.ok(calls.some(c=>c.readyBoundary),'Mod 只在原生空闲边界领取');
  stage('叫醒这一轮结束，再经过一次监测');
  await terminal.wait(()=>claude()?.state==='ready','叫醒轮次没有结束',40000);
                                          
  const after=Date.now();await delay(17000);
  assert.equal(requests.filter(r=>r.at>=after).length,0,'同一回合只叫醒一次');
  assert.equal(status()?.pending,false);assert.equal(status()?.consecutive,1);
  assert.equal(broker.subagentCompletions.status(codexPeer())?.unconfirmed,2,'自动转达不伪造子结果的读取证明');
  assert.equal(store.messages().length,messagesBefore,'转发不能伪造成搭档消息');
  assert.deepEqual(errors,[]);
  passed=true;t.diagnostic(JSON.stringify({actualClaudePid:terminal.identity.pid,busyHeld:true,idleWokenOnce:true,verbatimFinal:true,realModelCalls:0}));
});
