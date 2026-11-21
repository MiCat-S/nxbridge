import { overrideEnvironment } from '../tests/support/environment.js';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { readModelBody } from './model-http-fixture.js';
import { DatabaseSync } from 'node:sqlite';
import { stringify } from 'smol-toml';
import { temporaryDirectory } from '../tests/support/temporary.js';
import { setupPublish } from './publish-fixture.js';
import { NativeTerminal } from './terminal-fixture.js';
import { brokerCall } from '../ipc/ipc.js';
import { configClient } from '../hosts/codex/stdio-codex.js';
import { connectAppServer } from '../hosts/codex/adapter.js';
import {DEFAULT_CONFIG} from '../config/defaults.js';
import {delay} from '../shared/time.js';
import {loadConfig} from '../config/load.js';
import {resolveCli} from '../process/host-command.js';
import { processIdentity } from '../process/process.js';
import { stopOwnedProcess } from '../process/process-stop.js';

export async function verifyNativeIdleNotice(t:TestContext,linked:boolean,repeat=false):Promise<void>{
  const idleNoticeMinutes=5;
  const temp=temporaryDirectory(),root=temp.directory,home=path.join(root,'bridge'),codexhome=path.join(root,'codex'),claudehome=path.join(root,'claude');
  for(const directory of [home,codexhome,claudehome])mkdirSync(directory,{recursive:true});
  const codexRequests:any[]=[],claudeRequests:any[]=[],completed=new Set<string>(),errors:string[]=[],nativeEvents:any[]=[];
  let phase='init',responsePhase='init',taskId='',held=false,passed=false,terminal:NativeTerminal|undefined,rpc:Awaited<ReturnType<typeof connectAppServer>>|undefined;
  const started=Date.now(),stage=(value:string)=>{phase=value;if(repeat)process.stderr.write(JSON.stringify({idleRepeatStage:value,elapsedMs:Date.now()-started})+'\n');};
  const model=http.createServer(async(req,res)=>{try{
    const raw=await readModelBody(req);
    if(req.url?.includes('/responses')){
      const body=JSON.parse(raw.toString('utf8'));codexRequests.push(body);const name=responsePhase==='init'||responsePhase==='task'&&!linked?'status':'send_message',id='idle-native-'+responsePhase,done=(body.input??[]).some((item:any)=>item.type==='function_call_output'&&item.call_id===id);
      let spec:any;for(const tool of body.tools??[])if(tool.type==='namespace'&&tool.name==='claude'){const inner=tool.tools.find((item:any)=>item.name===name);if(inner)spec={...inner,namespace:'claude'};}else if(tool.type!=='namespace'&&(tool.name===name||tool.name==='mcp__claude__'+name))spec=tool;
      const args=name==='status'?{}:{message:linked?'LINKED_FINAL':'STALE_CHECKPOINT',...(linked?{in_reply_to:taskId}:{})};
      const item=done||!spec?{type:'message',id:'done-'+responsePhase,role:'assistant',status:'completed',content:[{type:'output_text',text:'IDLE_NATIVE_DONE_'+responsePhase}]}:{type:'function_call',id,call_id:id,name:spec.name,...(spec.namespace?{namespace:spec.namespace}:{}),arguments:JSON.stringify(args)};
      res.writeHead(200,{'content-type':'text/event-stream'});for(const event of [{type:'response.created',response:{id:'native-'+codexRequests.length,status:'in_progress',output:[]}},{type:'response.output_item.added',output_index:0,item},{type:'response.output_item.done',output_index:0,item},{type:'response.completed',response:{id:'native-'+codexRequests.length,status:'completed',output:[item],usage:{input_tokens:1,output_tokens:1,total_tokens:2}}}])res.write('event: '+event.type+'\ndata: '+JSON.stringify(event)+'\n\n');res.end();return;
    }
    if(!req.url?.includes('/v1/messages')||req.url.includes('count_tokens')){res.writeHead(200,{'content-type':'application/json'});res.end('{"input_tokens":1,"data":[]}');return;}
    const body=JSON.parse(raw.toString('utf8'));claudeRequests.push(body);const main=body.tools?.some((tool:any)=>tool.name==='ListAgents'),text=main?'CLAUDE_IDLE_NATIVE_DONE':JSON.stringify(body.system).includes('security monitor')?'<severity>0</severity>':'{"state":"done"}';
    if(!body.stream){res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({id:'claude-native',type:'message',role:'assistant',model:body.model,content:[{type:'text',text}],stop_reason:'end_turn',usage:{input_tokens:1,output_tokens:1}}));return;}
    res.writeHead(200,{'content-type':'text/event-stream'});const emit=(event:any)=>res.write('event: '+event.type+'\ndata: '+JSON.stringify(event)+'\n\n');
    emit({type:'message_start',message:{id:'claude-native',type:'message',role:'assistant',model:body.model,content:[],usage:{input_tokens:1,output_tokens:1}}});emit({type:'content_block_start',index:0,content_block:{type:'text',text:''}});
                                              
    if(!repeat&&main&&!held&&/STALE_CHECKPOINT|LINKED_FINAL/.test(JSON.stringify(body.messages))){held=true;const heartbeat=setInterval(()=>res.write(': keepalive\n\n'),5000);try{await delay(65000);}finally{clearInterval(heartbeat);}}
    emit({type:'content_block_delta',index:0,delta:{type:'text_delta',text}});emit({type:'content_block_stop',index:0});emit({type:'message_delta',delta:{stop_reason:'end_turn'},usage:{output_tokens:1}});emit({type:'message_stop'});res.end();
  }catch(error){errors.push(String(error));if(!res.headersSent)res.writeHead(500);res.end(String(error));}});
  await new Promise<void>(resolve=>model.listen(0,'127.0.0.1',resolve));const url=`http://127.0.0.1:${(model.address() as any).port}`,cli=resolveCli('codex');
  const env={NXBRIDGE_HOME:home,CODEX_HOME:codexhome,CLAUDE_CONFIG_DIR:claudehome,OPENAI_API_KEY:'local-idle-test',ANTHROPIC_API_KEY:'local-idle-native-only',ANTHROPIC_BASE_URL:url,DISABLE_AUTOUPDATER:'1',DISABLE_TELEMETRY:'1',CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC:'1'},restoreEnvironment=overrideEnvironment(env);
  const status=()=>brokerCall<any>('status',{}, {home}),wait=async(predicate:()=>Promise<boolean>|boolean,label:string,timeout=30000)=>{const deadline=Date.now()+timeout;while(!await predicate()){assert.ok(Date.now()<deadline,label);await delay(100);}};
  t.after(async()=>{model.closeAllConnections();try{
    if(!passed){let current;try{current=await status();}catch{}process.stderr.write(JSON.stringify({idleNativeFailure:{phase,nativeEvents:nativeEvents.map(event=>({method:event.method,turnId:event.params?.turnId,event:event.params?.run?.eventName,turn:event.params?.turn?.id}))}})+'\n');t.diagnostic(JSON.stringify({linked,phase,taskId,current,errors,lastCodex:codexRequests.at(-1)?.input?.slice(-4),lastClaude:JSON.stringify(claudeRequests.at(-1)?.messages).slice(-2000),terminal:terminal?.output.slice(-1500),log:existsSync(path.join(home,'run','broker.log'))?readFileSync(path.join(home,'run','broker.log'),'utf8').slice(-1500):undefined}));}
    rpc?.close();await terminal?.close();await temp.cleanup();
  }finally{await new Promise<void>(resolve=>model.close(()=>resolve()));restoreEnvironment();}});
  writeFileSync(path.join(home,'config.json'),JSON.stringify({...DEFAULT_CONFIG,implicit:'never',idleNoticeMinutes,compatibilityWake:'strict',codexHome:codexhome,claudeHome:claudehome,codexCommand:[cli.command,...cli.prefix]}),'utf8');
  writeFileSync(path.join(codexhome,'config.toml'),stringify({model:'gpt-5.1-codex',model_provider:'idle_native',web_search:'disabled',approval_policy:'never',sandbox_mode:'read-only',suppress_unstable_features_warning:true,check_for_update_on_startup:false,features:{hooks:true,apps:false,remote_plugin:false,code_mode:false},projects:{[root]:{trust_level:'trusted'}},model_providers:{idle_native:{name:'本地空闲验收',base_url:url+'/v1',wire_api:'responses',requires_openai_auth:false}}}),'utf8');
  writeFileSync(path.join(claudehome,'.claude.json'),JSON.stringify({hasCompletedOnboarding:true,customApiKeyResponses:{approved:[env.ANTHROPIC_API_KEY.slice(-20)],rejected:[]},projects:{[root.replaceAll('\\','/')]:{hasTrustDialogAccepted:true}}}),'utf8');
  writeFileSync(path.join(claudehome,'settings.json'),JSON.stringify({crossSessionInbound:'accept',env:{ANTHROPIC_API_KEY:env.ANTHROPIC_API_KEY,ANTHROPIC_BASE_URL:url,CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC:'1'}}),'utf8');
  stage('安装隔离原生夹具');await setupPublish();const control=await configClient(loadConfig(home),home);try{const hooks=(await control.request('hooks/list',{cwds:[root]})).data.flatMap((value:any)=>value.hooks??[]).filter((hook:any)=>hook.pluginId==='nxbridge@nxbridge-local');await control.request('config/batchWrite',{edits:[{keyPath:'hooks.state',value:Object.fromEntries(hooks.map((hook:any)=>[hook.key,{enabled:true,trusted_hash:hook.currentHash}])),mergeStrategy:'replace'}],filePath:path.join(codexhome,'config.toml')},{mutation:true});}finally{control.close();}
  const {endpoint}=await brokerCall<{endpoint:string}>('codex.endpoint',{}, {home});rpc=await connectAppServer(endpoint,loadConfig(home),undefined,home);rpc.on('notification',message=>{if(['hook/completed','turn/started'].includes(message.method))nativeEvents.push(message);if(message.method==='turn/completed')completed.add(message.params.turn.id);});const {thread}=await rpc.request('thread/start',{cwd:root,approvalPolicy:'never',sandbox:'read-only'});
  const initializeCodex=async()=>{const initial=await rpc!.request('turn/start',{threadId:thread.id,input:[{type:'text',text:'初始化空闲提醒验收'}]});await wait(()=>completed.has(initial.turn.id),'Codex 初始化轮次未完成');};
  const initializeClaude=async()=>{const claude=resolveCli('claude');terminal=await NativeTerminal.start(root,home,claude.command,[...claude.prefix,'--model','claude-sonnet-4-6'],root,{...process.env,TERM:'xterm-256color',COLORTERM:'truecolor'});await terminal.prompt('初始化委派方');await wait(async()=>(await status()).peers.some((peer:any)=>peer.host==='claude'&&peer.state==='ready'&&peer.health?.state==='ready'&&peer.health.observedProgressAt),'Claude 初始化原生输出轮次未完成');};
  stage('初始化两端原生模型');if(repeat)await Promise.all([initializeCodex(),initializeClaude()]);else{await initializeCodex();await initializeClaude();}
  assert.ok(terminal);
  const before=await status(),c=before.peers.find((peer:any)=>peer.host==='claude'),x=before.peers.find((peer:any)=>peer.sessionId===thread.id);assert.ok(c&&x);
  assert.equal(c.health?.source,'native-mod','前台 Claude 的 Mod 必须实际提供健康记录');assert.equal(c.health.state,'ready');
  assert.ok(c.health.observedProgressAt,'实际模型输出必须更新原生进展，不能只有轮次开始记录');
  const promptHook=nativeEvents.find(event=>event.method==='hook/completed'&&event.params?.run?.eventName==='userPromptSubmit'&&event.params?.run?.status==='completed');
  assert.ok(promptHook?.params?.turnId,'成功的原生提示 hook 没有提供轮次编号');
  const start=nativeEvents.find(event=>event.method==='turn/started'&&event.params?.turn?.id===promptHook.params.turnId);
  assert.ok(start,'提示 hook 的编号无法关联到实际原生轮次');
  const evidence=new DatabaseSync(path.join(home,'nxbridge.db'),{readOnly:true});
  try{for(const peer of [c,x])assert.ok(evidence.prepare('SELECT 1 FROM settings WHERE key=?').get('replyContract:'+peer.id),peer.host+' 未验证加载回复协议，静默结果不能视为验收');}finally{evidence.close();}
  await brokerCall('pair',{claude:c.id,codex:x.id},{home});
  if(!linked){
    stage('先发送旧进度，再接收新任务');responsePhase='checkpoint';
    const checkpoint=await rpc.request('turn/start',{threadId:thread.id,input:[{type:'text',text:'同步此前进度'}]});await wait(()=>completed.has(checkpoint.turn.id),'旧进度轮次未结束');
  }
                                  
  stage('task');responsePhase='task';const result=await brokerCall<any>('send',{actor:{host:'claude',memberId:c.id,sessionId:c.sessionId,callId:'native-task'},message:'IDLE_NATIVE_TASK 继续当前已授权任务。',reply_expected:true},{home});taskId=result.message_id;
  await wait(async()=>{const value=await status();return value.peers.find((peer:any)=>peer.id===x.id)?.state==='ready'&&value.messages.some((message:any)=>message.id===taskId&&['contextObserved','responded'].includes(message.state))&&value.messages.some((message:any)=>message.from===x.id&&/STALE_CHECKPOINT|LINKED_FINAL/.test(message.body));},'Codex 没有实际完成搭档轮次');
  if(repeat)await wait(async()=>{const value=await status();return[c.id,x.id].every(id=>value.peers.find((peer:any)=>peer.id===id)?.state==='ready')&&value.messages.length===2&&value.messages.every((message:any)=>message.state==='contextObserved');},'两条普通消息未完成原生上下文核验');
  {
    stage('推进隔离库空闲宽限时钟');
                                               
    const db=new DatabaseSync(path.join(home,'nxbridge.db')),elapsed=idleNoticeMinutes*60000+120001;try{
      db.exec('PRAGMA busy_timeout=300');db.exec('BEGIN IMMEDIATE');
                                                     
      db.prepare('UPDATE pairs SET created_at=created_at-? WHERE claude=? AND codex=?').run(elapsed,c.id,x.id);
      db.prepare('UPDATE messages SET created_at=created_at-?,updated_at=updated_at-? WHERE sender IN (?,?)').run(elapsed,elapsed,c.id,x.id);
      for(const peer of [c,x]){
        const row=db.prepare('SELECT data FROM peers WHERE id=?').get(peer.id)!,data=JSON.parse(row.data as string);data.stateSince-=elapsed;db.prepare('UPDATE peers SET data=? WHERE id=?').run(JSON.stringify(data),peer.id);
        const key='replyContract:'+peer.id,contract=db.prepare('SELECT value FROM settings WHERE key=?').get(key)!;const value=JSON.parse(contract.value as string);value.at-=elapsed;db.prepare('UPDATE settings SET value=? WHERE key=?').run(JSON.stringify(value),key);
        for(const row of db.prepare('SELECT rowid,data FROM window_bindings WHERE peer_id=?').all(peer.id)){const binding=JSON.parse(row.data as string);if(binding.activatedAt!==undefined)binding.activatedAt-=elapsed;db.prepare('UPDATE window_bindings SET data=? WHERE rowid=?').run(JSON.stringify(binding),row.rowid as number);}
      }
      db.exec('COMMIT');
    }finally{if(db.isTransaction)db.exec('ROLLBACK');db.close();}
  }
  const idle=await status(),task=idle.messages.find((message:any)=>message.id===taskId);assert.equal(task.replyExpected,true);assert.equal(task.state,linked?'responded':'contextObserved');const idleAt=Date.now(),codexBaseline=codexRequests.length;
  const claudeMain=()=>claudeRequests.filter(body=>body.tools?.some((tool:any)=>tool.name==='ListAgents'));
  const claudeNotified=()=>claudeMain().some(body=>JSON.stringify(body.messages).includes('source=idle_unanswered'));
  if(!linked){
    stage('等待第 3 档被动空闲提醒');
    await wait(async()=>(await brokerCall<any[]>('events',{}, {home})).some(event=>event.type==='health.idle.unanswered'&&event.data.peerId===x.id),'没有生成待回复任务的被动提醒');
    await wait(async()=>(await status()).peers.find((peer:any)=>peer.id===c.id)?.state==='ready','发起方原有轮次没有结束',85000);
    const beforeInput=claudeMain().length,silentUntil=Date.now()+16000;
                                      
    while(Date.now()<silentUntil){assert.equal(claudeMain().length,beforeInput,'被动提醒自行启动了发起方模型');assert.equal(codexRequests.length,codexBaseline,'被动提醒唤醒了接收方');await delay(250);}
    assert.equal(claudeNotified(),false,'被动提醒在正常输入前进入了模型');
    const passive=await status();for(const peer of [c,x])assert.equal(passive.peers.find((value:any)=>value.id===peer.id)?.activityAt,idle.peers.find((value:any)=>value.id===peer.id)?.activityAt,'被动提醒不能冒充普通输入');
    stage('正常下一轮实际附上空闲提醒');await terminal.prompt('IDLE_NOTICE_NEXT_USER_TURN');
    await wait(claudeNotified,'正常下一轮没有实际收到被动空闲提醒');
  }
  if(repeat){
    const codexNotified=()=>codexRequests.some(body=>JSON.stringify(body.input).includes('idle_unanswered'));
                                                                
    await wait(async()=>{const value=await status(),sender=value.peers.find((peer:any)=>peer.id===c.id),previous=idle.peers.find((peer:any)=>peer.id===c.id);return sender?.health?.turnId!==previous?.health?.turnId&&sender?.activityAt>previous?.activityAt&&[c.id,x.id].every(id=>value.peers.find((peer:any)=>peer.id===id)?.state==='ready');},'附上被动提醒的新轮次及真实输入回执没有完成');
    const after=await status(),events=await brokerCall<any[]>('events',{}, {home}),notices=events.filter(event=>event.type==='health.idle.unanswered');
    assert.equal(notices.length,1);assert.equal(notices[0].data.recipient,c.id);assert.equal(codexNotified(),false,'后续发信已关闭旧方向的指针，不能双向互相唤醒');
    assert.deepEqual(after.messages.map((message:any)=>[message.id,message.state]),idle.messages.map((message:any)=>[message.id,message.state==='runtimeQueued'?'contextObserved':message.state]));
    assert.equal(after.peers.find((peer:any)=>peer.id===x.id)?.activityAt,idle.peers.find((peer:any)=>peer.id===x.id)?.activityAt,'被动提醒不能冒充接收方的普通输入');
    assert.ok(after.peers.find((peer:any)=>peer.id===c.id)?.activityAt>idle.peers.find((peer:any)=>peer.id===c.id)?.activityAt,'发起方的真实新输入应被记录');
    stage('通知后真实重启隔离 broker');
    const ping=await brokerCall<any>('ping',{}, {home}),identity=await processIdentity(ping.pid);assert.equal(identity.startedAt,ping.runtime.generation);await stopOwnedProcess(identity);
    await brokerCall('ping',{}, {home});
    assert.equal((await status()).peers.find((peer:any)=>peer.id===c.id)?.health?.turnId,after.peers.find((peer:any)=>peer.id===c.id)?.health?.turnId,'协调器重启后保留已核验的前台轮次');
                                                 
    const db=new DatabaseSync(path.join(home,'nxbridge.db'));try{
      db.exec('PRAGMA busy_timeout=300');db.exec('BEGIN IMMEDIATE');
      for(const peer of [c,x]){
        const row=db.prepare('SELECT data FROM peers WHERE id=?').get(peer.id)!,data=JSON.parse(row.data as string);assert.equal(data.state,'ready');data.stateSince=Date.now()-600001;db.prepare('UPDATE peers SET data=? WHERE id=?').run(JSON.stringify(data),peer.id);
        const key='healthNoticeAdmission:'+peer.id,admission=db.prepare('SELECT value FROM settings WHERE key=?').get(key);if(peer.id===c.id)assert.ok(admission,'必须先确认原生实际准入');if(admission){const value=JSON.parse(admission.value as string);value.lastAt=Date.now()-600001;for(const kind of Object.values(value.kinds) as {at:number}[])kind.at=value.lastAt;db.prepare('UPDATE settings SET value=?,updated_at=? WHERE key=?').run(JSON.stringify(value),Date.now(),key);}
      }
      db.exec('COMMIT');
    }finally{if(db.isTransaction)db.exec('ROLLBACK');db.close();}
    stage('跨十分钟限频的延长空闲观察');const baseline=[codexRequests.length,claudeRequests.length],until=Date.now()+21000;
    while(Date.now()<until){const repeated=(await brokerCall<any[]>('events',{}, {home})).filter(event=>event.type==='health.idle.unanswered');assert.equal(repeated.length,1,'通知轮次、长时空闲或 broker 重启重新开启了工作阶段');await delay(500);}
    assert.equal(codexRequests.length,baseline[0]);assert.equal(claudeRequests.length,baseline[1]);assert.equal((await status()).messages.length,2);assert.equal(errors.length,0);
    passed=true;t.diagnostic(JSON.stringify({actualCodexThread:thread.id,actualClaudePid:terminal.identity.pid,singlePassiveNotice:true,nextUserTurnObserved:true,noAutomaticModelWake:true,brokerRestart:true,idleCadenceClockAdvanced:true,hookBeforeTurnCorrelated:true,observationMs:21000,ordinaryMessages:2,realModelCalls:0}));return;
  }
  if(linked)await wait(()=>Date.now()-idleAt>=65000,'最终回复静默观察未结束',70000);
  const events=await brokerCall<any[]>('events',{}, {home}),notices=events.filter(event=>event.type==='health.idle.unanswered'&&event.data.peerId===x.id);assert.equal(notices.length,linked?0:1);if(!linked)assert.equal(notices[0].data.recipient,c.id);
  assert.equal(codexRequests.length,codexBaseline,'空闲提醒唤醒了接收方');assert.equal(errors.length,0);passed=true;t.diagnostic(JSON.stringify({linked,actualCodexThread:thread.id,actualClaudePid:terminal.identity.pid,noticeInNativeModel:!linked,receiverNotWoken:true,realModelCalls:0}));
}
