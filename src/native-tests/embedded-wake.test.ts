import { overrideEnvironment } from '../tests/support/environment.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { freemem,totalmem,cpus } from 'node:os';
import { mkdirSync, writeFileSync, readdirSync } from 'node:fs';
import { readModelBody } from './model-http-fixture.js';
import { stringify } from 'smol-toml';
import { temporaryDirectory } from '../tests/support/temporary.js';
import { preparePlugins } from '../install/setup.js';
import { brokerCall, ensureBroker } from '../ipc/ipc.js';
import {DEFAULT_CONFIG} from '../config/defaults.js';
import {WAKE_NOTICE,HEALTH_WAKE_NOTICE} from '../types.js';
import { processIdentity, codexArguments, probeProcesses } from '../process/process.js';
import { windowsFileLockOwners } from '../process/windows/windows-file-lock.js';
import { recordOwnedProcess } from '../process/owned-processes.js';
import {delay} from '../shared/time.js';
import {PACKAGE_ROOT} from '../shared/package-location.js';
import {runCli} from '../process/host-command.js';
import { readWakeQueue } from '../ipc/embedded-wake.js';
import {deliveryHealthKey} from '../broker/health/contracts.js';
import { NativeTerminal } from './terminal-fixture.js';

test('真实 Codex 队列：忙碌期合并、终态失败唤醒一次、零依赖故障不叫醒模型',{skip:process.platform!=='win32',timeout:170000},async t=>{
  const temp=temporaryDirectory(),root=temp.directory,home=path.join(root,'bridge'),codexhome=path.join(root,'codex'),claudehome=path.join(root,'claude');
  for(const d of [home,codexhome,claudehome])mkdirSync(d,{recursive:true});
  const requests:any[]=[],errors:string[]=[];let release:(()=>void)|undefined,held=false;
  const model=http.createServer(async(req,res)=>{try{
    const raw=await readModelBody(req);
    if(!req.url?.includes('/responses')){res.writeHead(200,{'content-type':'application/json'});res.end('{"data":[]}');return;}
    const body=JSON.parse(raw.toString());requests.push(body);
    if(!held&&JSON.stringify(body.input).includes('HOLD_WAKE_BUSY')){held=true;await new Promise<void>(resolve=>release=resolve);}
    const lastUser=body.input.findLastIndex((item:any)=>item.role==='user'),lastOutput=body.input.findLastIndex((item:any)=>item.type==='function_call_output');
    let spec:any;for(const tool of body.tools??[]){if(tool.type==='namespace'){const inner=tool.tools.find((v:any)=>v.name==='receive_messages');if(inner)spec={...inner,namespace:tool.name};}else if(tool.name==='receive_messages')spec=tool;}
    const pick=spec&&lastUser>lastOutput&&JSON.stringify(body.input[lastUser]).includes(WAKE_NOTICE),id='wake-'+requests.length;
    const item=pick?{type:'function_call',id:'fc-'+id,call_id:id,name:spec.name,...(spec.namespace?{namespace:spec.namespace}:{}),arguments:'{}'}:{type:'message',id:'msg-'+id,role:'assistant',status:'completed',content:[{type:'output_text',text:'WAKE_NATIVE_DONE'}]};
    res.writeHead(200,{'content-type':'text/event-stream'});
    for(const event of [{type:'response.created',response:{id,status:'in_progress',output:[]}},{type:'response.output_item.added',output_index:0,item:pick?{...item,arguments:''}:item},{type:'response.output_item.done',output_index:0,item},{type:'response.completed',response:{id,status:'completed',output:[item],usage:{input_tokens:20,output_tokens:5,total_tokens:25}}}])res.write('data: '+JSON.stringify(event)+'\n\n');res.end();
  }catch(error){errors.push(String(error));res.writeHead(500);res.end(String(error));}});
  await new Promise<void>(resolve=>model.listen(0,'127.0.0.1',resolve));
  const env={NXBRIDGE_HOME:home,CODEX_HOME:codexhome,CLAUDE_CONFIG_DIR:claudehome,OPENAI_API_KEY:'wake-local-only'},restoreEnvironment=overrideEnvironment(env);
  let terminal:NativeTerminal|undefined,source:ReturnType<typeof spawn>|undefined,sourceExit:Promise<unknown>|undefined;
  t.after(async()=>{release?.();source?.stdin?.end();try{await sourceExit;await terminal?.close();await temp.cleanup();}finally{model.closeAllConnections();await new Promise<void>(resolve=>model.close(()=>resolve()));restoreEnvironment();}});
  writeFileSync(path.join(home,'config.json'),JSON.stringify({...DEFAULT_CONFIG,implicit:'never',compatibilityWake:'notify',codexHome:codexhome,claudeHome:claudehome}),'utf8');
  writeFileSync(path.join(codexhome,'config.toml'),stringify({model:'gpt-5.1-codex',model_provider:'wake_local',model_reasoning_effort:'low',approval_policy:'never',sandbox_mode:'read-only',web_search:'disabled',suppress_unstable_features_warning:true,check_for_update_on_startup:false,features:{hooks:true,apps:false,remote_plugin:false,code_mode:{enabled:false,direct_only_tool_namespaces:['claude']},non_prefixed_mcp_tool_names:{enabled:true,server_names:['claude']}},model_providers:{wake_local:{name:'本地唤醒验收',base_url:`http://127.0.0.1:${(model.address() as any).port}/v1`,wire_api:'responses',requires_openai_auth:false}},projects:{[root]:{trust_level:'trusted'}}}),'utf8');
  const marketplace=await preparePlugins(home,{packageRoot:path.join(PACKAGE_ROOT,'publish')});await runCli('codex',['plugin','marketplace','add',marketplace,'--json']);await runCli('codex',['plugin','add','nxbridge@nxbridge-local','--json']);(await ensureBroker(home)).close();
  const entry=path.join(PACKAGE_ROOT,'publish','nxbridge.mjs'),flags=['--no-daemon','--no-alt-screen','--dangerously-bypass-hook-trust'],start=(args:string[])=>NativeTerminal.start(root,home,process.execPath,[entry,'shell-codex',Buffer.from(JSON.stringify(args)).toString('base64')],root,{...process.env,TERM:'xterm-256color',COLORTERM:'truecolor'});terminal=await start(flags);
  const status=()=>brokerCall<any>('status',{}, {home}),events=()=>brokerCall<any[]>('events',{}, {home}),wait=(check:()=>boolean|Promise<boolean>,why:string,timeout=25000)=>terminal!.wait(check,why+'；'+errors.join(';'),timeout);
  t.diagnostic('阶段：初始化真实嵌入窗口');await terminal.prompt('初始化唤醒验收');await wait(async()=>requests.length>0&&(await status()).peers.some((p:any)=>p.host==='codex'&&p.sessionId&&p.state==='ready'&&p.health?.state==='ready'),'初始化原生轮次未完成');
                                              
  source=spawn(process.execPath,['-e','process.stdin.resume()'],{stdio:['pipe','ignore','ignore'],windowsHide:true});sourceExit=once(source,'exit');void sourceExit.catch(()=>{});await once(source,'spawn');
  const s=await status(),x=s.peers.find((p:any)=>p.host==='codex'&&p.sessionId),identity=await processIdentity(source.pid!);
  assert.equal(x.endpoint?.mode??s.endpoints?.find((ep:any)=>ep.peerId===x.id)?.mode,'embedded','包装器必须由原生 hook 登记嵌入窗口');
  assert.equal(x.health?.source,'native-hook','前台 Codex 的原生 hooks 必须实际提供健康记录');assert.equal(x.health.state,'ready',JSON.stringify({health:x.health,hook:s.capabilities.hookObserved}));
  await recordOwnedProcess(home,{role:'test-daemon',identity,parent:await processIdentity(process.pid),proof:{kind:'spawn'}});
  const c=await brokerCall<any>('register',{host:'claude',sessionId:'wake-source',cwd:root,name:'唤醒搭档',kind:'root',endpoint:{mode:'embedded',address:'',epoch:'source',pid:identity.pid,procStart:identity.startedAt}},{home});
  const pair=await brokerCall<any>('pair',{claude:c.id,codex:x.id},{home});
  const oldEndpoint=s.endpoints.find((endpoint:any)=>endpoint.peerId===x.id&&endpoint.mode==='embedded'&&endpoint.active),oldNative=await processIdentity(oldEndpoint.pid);
  assert.equal(oldNative.startedAt,oldEndpoint.procStart);
  t.diagnostic('阶段：经包装器恢复原 UUID，保留官方原生入口及队列唤醒');await terminal.close();terminal=await start([...flags,'resume',x.sessionId]);
  try{await terminal.prompt('HOLD_WAKE_BUSY');await wait(()=>held,'忙碌轮次未进入本地模型');}
  catch(error){
    const locks=readdirSync(codexhome,{recursive:true,withFileTypes:true}).filter(file=>file.isFile()&&file.name.includes(x.sessionId)&&file.name.endsWith('.lock')).map(file=>{const filename=path.join(file.parentPath,file.name);return{filename,owners:windowsFileLockOwners(filename)};});
    const snapshot=await status();t.diagnostic(JSON.stringify({coldResumeFailure:{oldNativeState:(await probeProcesses([{pid:oldNative.pid,procStart:oldNative.startedAt}]))[0],locks,requests:requests.length,held,queue:readWakeQueue(codexhome,x.sessionId).items,peer:snapshot.peers.find((peer:any)=>peer.id===x.id),endpoints:snapshot.endpoints.filter((endpoint:any)=>endpoint.peerId===x.id)}}));throw error;
  }
                                                              
  let endpoint:any;
  await wait(async()=>{endpoint=(await status()).endpoints.find((value:any)=>value.peerId===x.id&&value.mode==='embedded'&&value.active&&(value.pid!==oldNative.pid||value.procStart!==oldNative.startedAt));return endpoint!==undefined;},'恢复后的原生 hook 未登记新代次');
  const native=await processIdentity(endpoint.pid);
  assert.equal(native.startedAt,endpoint.procStart);
  t.diagnostic(JSON.stringify({coldResume:{old:{pid:oldNative.pid,procStart:oldNative.startedAt,state:(await probeProcesses([{pid:oldNative.pid,procStart:oldNative.startedAt}]))[0]},current:{pid:native.pid,procStart:native.startedAt}}}));
  const nativeArgs=await codexArguments(native);assert.ok(nativeArgs.includes('resume')&&nativeArgs.includes(x.sessionId));assert.equal(nativeArgs.includes('--remote'),false);
  const busy=(await status()).peers.find((p:any)=>p.id===x.id);assert.equal(busy.health?.source,'native-hook');assert.equal(busy.health.state,'running');
  t.diagnostic('阶段：忙碌期间提交十条消息');
  for(let i=0;i<10;i++)await brokerCall('send',{actor:{host:'claude',sessionId:c.sessionId,callId:'task-'+i},message:'WAKE_TASK_'+i},{home});
  assert.deepEqual(readWakeQueue(codexhome,x.sessionId).items,[]);release!();
  const cpuTimes=()=>cpus().reduce((sum,cpu)=>({idle:sum.idle+cpu.times.idle,total:sum.total+Object.values(cpu.times).reduce((a,b)=>a+b,0)}),{idle:0,total:0}),cpuBefore=cpuTimes();
  try{await wait(async()=>(await status()).messages.filter((m:any)=>m.to===x.id).every((m:any)=>m.state==='contextObserved'),'转为空闲后未确认工具输出进入上下文');}
  catch(error){const cpuAfter=cpuTimes(),snapshot=await status();t.diagnostic(JSON.stringify({receiptTimeout:{freeMemory:freemem(),totalMemory:totalmem(),cpuBusyFraction:1-(cpuAfter.idle-cpuBefore.idle)/(cpuAfter.total-cpuBefore.total),peer:snapshot.peers.find((p:any)=>p.id===x.id),messages:snapshot.messages.filter((m:any)=>m.to===x.id).map((m:any)=>({id:m.id,state:m.state,attempts:m.attempts,evidence:m.evidence})),events:(await events()).slice(-40),requests:requests.map(r=>({inputTypes:r.input?.slice(-4).map((item:any)=>({type:item.type,role:item.role,name:item.name,call_id:item.call_id}))}))}}));throw error;}
  await wait(async()=>(await status()).peers.find((p:any)=>p.id===x.id).state==='ready','取件轮次未结束');
  const queued=(await events()).filter((e:any)=>e.type==='wake.queued');assert.equal(queued.length,1);
  const count=requests.length,discarded=()=>events().then(rows=>rows.filter(e=>e.type==='wake.discarded').length),before=await discarded();
  t.diagnostic('阶段：消费三条过期原生通知，不进入模型');
  for(let i=0;i<3;i++)await runCli('codex',['queue','--thread',x.sessionId,'--message',WAKE_NOTICE],{config:{...DEFAULT_CONFIG,codexHome:codexhome},cwd:root,home});
  await wait(async()=>await discarded()>=before+3,'过期通知没有被原生 hook 静默丢弃');assert.equal(requests.length,count);
  await brokerCall('pause',{pair_id:pair.id},{home});await runCli('codex',['queue','--thread',x.sessionId,'--message',WAKE_NOTICE],{config:{...DEFAULT_CONFIG,codexHome:codexhome},cwd:root,home});
  await wait(async()=>await discarded()>=before+4,'暂停后的通知未丢弃');assert.equal(requests.length,count);assert.deepEqual(readWakeQueue(codexhome,x.sessionId).items,[]);
  t.diagnostic('阶段：原生压缩后自动恢复已入工具输出的搭档任务正文');
  await brokerCall('resume',{pair_id:pair.id},{home});
  const task=await brokerCall<any>('send',{actor:{host:'claude',sessionId:c.sessionId,callId:'compact-task'},message:'COMPACT_PARTNER_TASK_BODY'},{home});
  await wait(async()=>(await status()).messages.some((m:any)=>m.id===task.message_id&&!['accepted','sending'].includes(m.state)),'压缩前任务未取件');
  await wait(async()=>(await status()).peers.find((p:any)=>p.id===x.id).state==='ready','压缩前未空闲');
  await terminal.prompt('/compact');await delay(1500);const afterCompact=requests.length;
  await terminal.prompt('AFTER_PARTNER_COMPACT');
  await wait(()=>requests.length>afterCompact&&requests.some((r,i)=>i>=afterCompact&&JSON.stringify(r.input).includes('nxbridge partner recovery digest')&&JSON.stringify(r.input).includes('COMPACT_PARTNER_TASK_BODY')),'压缩后恢复上下文没有自动携带搭档任务');
  await wait(async()=>(await status()).peers.find((p:any)=>p.id===x.id).state==='ready','压缩验收后未空闲');
  t.diagnostic('阶段：搭档失败经真实原生队列叫醒 Codex，正文只进入上下文一次');
  const beforeFailure=requests.length,messagesBeforeFailure=(await status()).messages.length,wakesBeforeFailure=(await events()).filter(e=>e.type==='wake.queued').length;
  const failedAt=Date.now(),failedTurn='NATIVE_TERMINAL_FAILED';
  await brokerCall('register',{host:'claude',sessionId:c.sessionId,cwd:root,name:'唤醒搭档',kind:'root',state:'ready',endpoint:{mode:'embedded',address:'',epoch:'source',pid:identity.pid,procStart:identity.startedAt,nativeHealth:{turnId:failedTurn,state:'failed',completion:'failed',lastProgressAt:failedAt,lastEventAt:failedAt,tools:[],error:'原生模型重试已经耗尽',source:'native-mod'}}},{home});
  await wait(()=>requests.some((r,i)=>i>=beforeFailure&&JSON.stringify(r.input).includes(failedTurn)&&JSON.stringify(r.input).includes('system_notice source=pair_anomaly')),'终态失败没有沿原生队列进入真实模型上下文',60000);
  await wait(async()=>(await status()).peers.find((p:any)=>p.id===x.id).state==='ready','失败通知轮次未结束');
  assert.equal((await events()).filter(e=>e.type==='wake.queued').length,wakesBeforeFailure+1);
  assert.equal((await status()).messages.length,messagesBeforeFailure,'失败事实不能伪造搭档消息');
  const afterFailure=requests.length;await delay(1500);assert.equal(requests.length,afterFailure,'同一失败不能重复启动模型');
  t.diagnostic('阶段：零消息和回复依赖时保留可达性观察，不生成投递故障提醒');
  const beforeHealth=requests.length;
  source.stdin!.end();await sourceExit;
                                                       
  try{
    const db=new DatabaseSync(path.join(home,'nxbridge.db'),{readOnly:true});
    try{await wait(()=>{
      const row=db.prepare('SELECT value FROM settings WHERE key=?').get(deliveryHealthKey(pair.id,x.id));
      return row!==undefined&&JSON.parse(row.value as string).active===true;
    },'原生进程退出后未保留可达性观察',45000);}finally{db.close();}
    assert.equal((await events()).some(e=>e.type==='health.delivery.alert'&&e.data?.senderId===x.id),false,'没有消息和回复依赖时不能报告投递失败');
    assert.equal(requests.length,beforeHealth,'信息类健康通知不能启动模型轮次');
    await terminal.prompt('AFTER_PARTNER_EXIT');
    await wait(()=>requests.some((r,i)=>i>=beforeHealth&&JSON.stringify(r.input).includes('AFTER_PARTNER_EXIT')),'正常任务未进入模型');
    for(const request of requests.slice(beforeHealth))assert.doesNotMatch(JSON.stringify(request.input),/Partner delivery remains unconfirmed[^\n]*pending: none/,'正常操作不能附带零依赖投递故障提醒');
  }
  catch(error){t.diagnostic(JSON.stringify({healthStatus:await status(),healthEvents:(await events()).filter(e=>e.type.startsWith('health.')||e.type.startsWith('wake.')).slice(-30),healthRequests:requests.slice(beforeHealth).map(r=>r.input)}));throw error;}
  await wait(async()=>(await status()).peers.find((p:any)=>p.id===x.id).state==='ready','健康通知轮次未结束');
  const healthCount=requests.length,discardedHealth=await discarded();
  await runCli('codex',['queue','--thread',x.sessionId,'--message',HEALTH_WAKE_NOTICE],{config:{...DEFAULT_CONFIG,codexHome:codexhome},cwd:root,home});
  await wait(async()=>await discarded()>discardedHealth,'已消费的健康通知未被丢弃');assert.equal(requests.length,healthCount);
  assert.equal(errors.length,0);t.diagnostic('十条任务合并为一次唤醒并确认上下文；搭档失败主动唤醒一次；零依赖只保留可达性观察；五条无效通知均未调用模型。');
});
