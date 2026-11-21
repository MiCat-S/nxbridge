import test from 'node:test';
import { runtimeFor } from '../hosts/managed-runtimes.js';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { readModelBody } from './model-http-fixture.js';
import { parse } from 'smol-toml';
import { temporaryDirectory } from '../tests/support/temporary.js';
import { setupPublish as setup, uninstallPublish as uninstall } from './publish-fixture.js';
import {CODEX_PARTNER_INSTRUCTIONS} from '../integration/instructions.js';
import {DEFAULT_CONFIG} from '../config/defaults.js';
import {WAKE_NOTICE} from '../types.js';
import {delay} from '../shared/time.js';
import {privateDirectory,isElevated} from '../process/permissions.js';
import {spawnCli} from '../process/host-command.js';
import {PACKAGE_ROOT} from '../shared/package-location.js';
import { connectAppServer, CodexAdapter } from '../hosts/codex/adapter.js';
import { Store } from '../storage/store.js';
import {peerKeyFile} from '../hosts/claude/claude-inbox.js';
import {processIdentity,processAncestors,liveProcess} from '../process/process.js';
import { brokerCall, ensureBroker } from '../ipc/ipc.js';
import { diagnose } from '../app/commands/doctor.js';
import { readCodexHistory } from '../hosts/codex/codex-history.js';
import { stopOwnedProcess, type OwnedIdentity } from '../process/process-stop.js';

async function waitFor(predicate:()=>boolean,timeout=10000):Promise<void>{const end=Date.now()+timeout;while(!predicate()){if(Date.now()>end)throw Error('等待条件超时');await delay(50);}}
const identities=new Map<number,OwnedIdentity>();
async function remember(pid:number|undefined):Promise<number|undefined>{if(pid)identities.set(pid,await processIdentity(pid));return pid;}
async function stop(pid:number|undefined):Promise<void>{if(!pid)return;const identity=identities.get(pid);assert.ok(identity,'停止测试进程前必须已有代次记录');await stopOwnedProcess(identity);}

test('隔离官方 CLI：安装保留配置、直连、命名空间工具、双向消息与卸载',async t=>{
  const temporary=temporaryDirectory(),directory=temporary.directory,nxhome=path.join(directory,'bridge'),codexhome=path.join(directory,'codex'),claudehome=path.join(directory,'claude');
  let brokerPid:number|undefined,serverPid:number|undefined,managedPid:number|undefined;
  let client:Awaited<ReturnType<typeof connectAppServer>>|undefined,receiver:net.Server|undefined,model:http.Server|undefined;
  mkdirSync(codexhome,{recursive:true});mkdirSync(claudehome,{recursive:true});
  const config={...DEFAULT_CONFIG,codexHome:codexhome,claudeHome:claudehome,...(process.env.NXBRIDGE_TEST_CODEX_BINARY?{codexBinary:process.env.NXBRIDGE_TEST_CODEX_BINARY}:{})};
  mkdirSync(nxhome,{recursive:true});writeFileSync(path.join(nxhome,'config.json'),JSON.stringify(config),'utf8');
  const keys=['NXBRIDGE_HOME','CODEX_HOME','CLAUDE_CONFIG_DIR','OPENAI_API_KEY'];const previous=Object.fromEntries(keys.map(k=>[k,process.env[k]]));
  Object.assign(process.env,{NXBRIDGE_HOME:nxhome,CODEX_HOME:codexhome,CLAUDE_CONFIG_DIR:claudehome,OPENAI_API_KEY:'nxbridge-not-a-real-key'});
  t.after(async()=>{
    client?.close();await stop(brokerPid);await stop(serverPid);await stop(managedPid);
    if(model){model.closeAllConnections();await new Promise<void>(resolve=>model!.close(()=>resolve()));}
    if(receiver)await new Promise<void>(resolve=>receiver!.close(()=>resolve()));
    for(const k of keys){if(previous[k]===undefined)delete process.env[k];else process.env[k]=previous[k];}
    await temporary.cleanup();
  });
  writeFileSync(path.join(codexhome,'config.toml'),'# 保留用户注释\nmodel_verbosity = "low"\n[features]\ncode_mode = false\n','utf8');
  const installed=await setup() as any;assert.equal(installed.installed,true);
  assert.equal((await setup() as any).installed,true,'重复安装应保留原始恢复记录');
  const configText=readFileSync(path.join(codexhome,'config.toml'),'utf8'),configured=parse(configText) as any;
  assert.match(configText,/保留用户注释/);assert.equal(configured.model_verbosity,'low');assert.equal(configured.features.code_mode.enabled,false);
  assert.deepEqual(configured.features.code_mode.direct_only_tool_namespaces,['claude']);

  const modelRequests:any[]=[],outgoing='原生协议往返成功 '+ '原生长结果 '.repeat(400);let askNext=false,sentOutgoing=false,pickupNext=false;
  model=http.createServer(async(req,res)=>{
    try{
      const raw=await readModelBody(req);
      if(!req.url?.includes('/responses')){res.writeHead(200,{'Content-Type':'application/json'});res.end('{"data":[]}');return;}
      const body=JSON.parse(raw.toString());modelRequests.push(body);const n=modelRequests.length;
      const lastWake=body.input?.findLastIndex((item:any)=>item.type==='message'&&item.role==='user'&&JSON.stringify(item).includes(WAKE_NOTICE))??-1,lastPickup=body.input?.findLastIndex((item:any)=>item.type==='function_call_output'&&String(item.call_id).startsWith('native-pickup-'))??-1;
      const pickup=pickupNext||lastWake>lastPickup;pickupNext=false;
      const item=askNext?{type:'function_call',id:'fc_ask',call_id:'native-ask',name:'ask',namespace:'claude',arguments:JSON.stringify({questions:[{id:'format',header:'格式',question:'输出格式？',options:[{label:'摘要',description:'结论'},{label:'全文',description:'详细'}]}]})}:pickup?{type:'function_call',id:'fc_pickup_'+n,call_id:'native-pickup-'+n,name:'receive_messages',namespace:'claude',arguments:'{}'}:!sentOutgoing?{type:'function_call',id:'fc_nxbridge',call_id:'native-call',name:'send_message',namespace:'claude',arguments:JSON.stringify({message:outgoing})}:{type:'message',id:'msg_'+n,role:'assistant',status:'completed',content:[{type:'output_text',text:'协议检查完成'}]};
      if(item.type==='function_call'&&item.name==='send_message')sentOutgoing=true;
      askNext=false;
      res.writeHead(200,{'Content-Type':'text/event-stream'});
      for(const event of[{type:'response.created',response:{id:'r'+n,status:'in_progress',output:[]}},{type:'response.output_item.added',output_index:0,item},{type:'response.output_item.done',output_index:0,item},{type:'response.completed',response:{id:'r'+n,status:'completed',output:[item],usage:{input_tokens:30,output_tokens:10,total_tokens:40}}}])res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
      res.end();
    }catch(error){res.writeHead(500);res.end(String(error));}
  });
  await new Promise<void>(resolve=>model!.listen(0,'127.0.0.1',resolve));
  const port=(model.address() as net.AddressInfo).port;
  const socketDirectory=path.join(directory,'run');await privateDirectory(socketDirectory);
  const endpoint='unix://'+path.join(socketDirectory,'codex.sock');
  const option=(key:string,value:unknown)=>['-c',`${key}=${JSON.stringify(value)}`];
  const args=['app-server','--listen',endpoint,
    ...option('model_provider','nxbridge_test'),...option('model','gpt-5.1-codex'),
    ...option('model_providers.nxbridge_test.name','隔离协议测试'),...option('model_providers.nxbridge_test.base_url',`http://127.0.0.1:${port}/v1`),
    ...option('model_providers.nxbridge_test.wire_api','responses'),...option('model_providers.nxbridge_test.requires_openai_auth',false),
    ...option('features.apps',false),...option('features.remote_plugin',false),...option('analytics.enabled',false),...option('web_search','disabled')];
  const child=spawnCli('codex',args,{stdio:['ignore','pipe','pipe']},config);let logs='';child.stderr?.on('data',b=>{logs=(logs+b.toString()).slice(-4000);});
  serverPid=await remember(child.pid);
  for(let i=0;i<40;i++){try{client=await connectAppServer(endpoint,config,undefined,nxhome);break;}catch{await delay(100);}}
  assert.ok(client,'无法连接官方 App Server：'+logs);
  const control=await ensureBroker(nxhome);const identity=await control.request('ping');control.close();brokerPid=await remember(identity.pid);
  await brokerCall('codex.connect',{endpoint});
  const {thread}=await client.request('thread/start',{cwd:directory,approvalPolicy:'never',sandbox:'read-only'});
  assert.equal(modelRequests.length,0);
  let status:any;
  for(let i=0;i<30;i++){status=await brokerCall('status');if(status.peers.some((p:any)=>p.sessionId===thread.id))break;await delay(100);}
  const codexPeer=status.peers.find((p:any)=>p.sessionId===thread.id);assert.ok(codexPeer,'并列客户端没有发现 thread/started');

  const inbox=process.platform==='win32'?`\\\\.\\pipe\\LOCAL\\cc-msg-${randomBytes(16).toString('hex')}`:path.join(socketDirectory,'claude.sock');
  const frames:any[]=[];
  const taskFrames=()=>frames.filter(f=>f.type==='user'&&!String(f.message?.content).includes('[nxbridge system_notice source=runtime_monitor notice_id='));
  receiver=net.createServer(socket=>{let buffered='';socket.setEncoding('utf8');socket.on('error',()=>{});socket.on('data',chunk=>{buffered+=chunk;let i:number;while((i=buffered.indexOf('\n'))>=0){frames.push(JSON.parse(buffered.slice(0,i)));buffered=buffered.slice(i+1);}});});
  await new Promise<void>(resolve=>receiver!.listen(inbox,resolve));
  mkdirSync(path.join(claudehome,'sessions'),{recursive:true});
  const identityInfo=await processIdentity(process.pid),identityFields=process.platform==='win32'?{procStartFt:identityInfo.procStartFt}:{procStart:identityInfo.procStart};
  writeFileSync(path.join(claudehome,'sessions',`${process.pid}.json`),JSON.stringify({sessionId:'claude-probe',cwd:directory,...identityFields}));
  if(process.platform==='win32')writeFileSync(peerKeyFile(process.pid,inbox,claudehome),JSON.stringify({peerToken:'a'.repeat(32),...identityFields}));
  const claudePeer=await brokerCall<any>('register',{host:'claude',sessionId:'claude-probe',cwd:directory,name:'Claude 协议测试',kind:'root',permission:'prompting',endpoint:{mode:'claude-inbox',address:inbox,epoch:'native-test',pid:process.pid,procStart:identityInfo.startedAt}});
  await brokerCall('pair',{claude:claudePeer.id,codex:codexPeer.id});
  const incoming=await brokerCall<any>('send',{actor:{host:'claude',sessionId:'claude-probe',callId:'first-message'},message:`请检查原生工具和回信，参考 [问答](<${path.join(PACKAGE_ROOT,'src/integration/mcp/questions.ts')}:12>) [插件](<${path.join(PACKAGE_ROOT,'plugins/claude')}>)`});
  try{await waitFor(()=>modelRequests.length>=2,20000);}catch(error){
    assert.fail(JSON.stringify({error:String(error),modelRequests:modelRequests.length,tools:modelRequests[0]?.tools?.map((v:any)=>v.name),status:await brokerCall('status'),logs,brokerLog:readFileSync(path.join(nxhome,'run','broker.log'),'utf8').slice(-3000)},null,2));
  }
  const namespace=modelRequests[0].tools.find((tool:any)=>tool.type==='namespace'&&tool.name==='claude');
  assert.ok(namespace,'首个请求缺少直接暴露的 claude 命名空间');
  assert.deepEqual(namespace.tools.map((tool:any)=>tool.name).sort(),['answer_question','ask','checkpoint','choose_partner','config','partner_profile','read_messages','receive_messages','recover_partner','select_partner','send_message','set_enabled','status']);
  const injected=modelRequests[0].input.find((item:any)=>item.type==='function_call_output'&&String(item.output).includes(incoming.message_id));assert.ok(injected);
  assert.ok(modelRequests[0].input.some((item:any)=>item.type==='function_call'&&item.call_id===injected.call_id));
  assert.ok(modelRequests.every(body=>body.input.every((item:any)=>item.type!=='message'||item.role!=='user'||!JSON.stringify(item).includes(incoming.message_id))));
  assert.match(JSON.stringify(injected),/nxbridge: 2 file refs/);
  assert.match(JSON.stringify(modelRequests[1].input),/message_id/);
  assert.match(JSON.stringify(modelRequests[1].input),/nxbridge tip \(auto length check, not judgment/);
  try{await waitFor(()=>frames.some(f=>f.type==='user'),10000);}catch(error){assert.fail(JSON.stringify({error:String(error),frames,outputs:modelRequests[1]?.input?.filter((i:any)=>i.type==='function_call_output'),status:await brokerCall('status'),events:await brokerCall('events'),logs},null,2));}
  assert.ok(frames.some(f=>f.message?.content?.includes('原生协议往返成功')));
  assert.equal(taskFrames().length,1);
  const after=await brokerCall<any>('status');assert.equal(after.messages.length,2);
  assert.equal(after.messages.find((m:any)=>m.from===codexPeer.id).body,outgoing);assert.equal(after.communicationTips.find((s:any)=>s.peerId===codexPeer.id).firings.report,1);
  const monitoredEndpoint=after.endpoints.find((e:any)=>e.peerId===codexPeer.id&&e.active&&e.mode==='app-server');
  assert.ok(monitoredEndpoint,'已连接的线程没有原生端点记录');
                                                         
  const ancestry=await processAncestors(monitoredEndpoint.native.pid,10),native=ancestry[0],launched=identities.get(serverPid!);
  assert.ok(native);assert.ok(launched);assert.match(native.name,/^codex(?:\.exe)?$/i);assert.equal(native.startedAt,monitoredEndpoint.native.procStart);
  assert.ok(ancestry.some(value=>value.pid===launched.pid&&value.startedAt===launched.startedAt),'原生宿主不属于本次启动的进程代次');
  assert.ok(monitoredEndpoint.bridge.pid);assert.ok(monitoredEndpoint.bridge.procStart);
  const launches=await brokerCall<any>('launch.status');assert.ok(launches.profiles.some((profile:any)=>profile.host==='codex'&&profile.sourceSession===thread.id),'直接 MCP 没有登记用户的原生启动记录');assert.ok(launches.profiles.every((profile:any)=>!('env' in profile)));
  assert.equal(after.messages.find((m:any)=>m.id===incoming.message_id).state,'contextObserved');
  const history=await client.request('thread/read',{threadId:thread.id,includeTurns:true});
  const evidence=await readCodexHistory(history.thread.path,thread.id);assert.equal(evidence.status,'supported');assert.equal(evidence.receipts.filter(receipt=>receipt.messageId===incoming.message_id).length,1);
  const diagnosis=await diagnose(nxhome),capabilities=diagnosis.codexCapabilities as any;
  assert.equal(capabilities.hooks.length,9);assert.ok(capabilities.hooks.every((h:any)=>h.trust==='untrusted'));
  assert.ok(capabilities.mcp.some((m:any)=>m.name==='claude'&&m.tools.includes('send_message')));assert.deepEqual(capabilities.errors,{});

                                                 
  await stop(brokerPid);brokerPid=undefined;
  const restarted=await ensureBroker(nxhome);brokerPid=await remember((await restarted.request('ping')).pid);restarted.close();
  const recovered=await brokerCall<any>('status');assert.equal(recovered.pair.id,after.pair.id);
  const resumed=await brokerCall('send',{actor:{host:'claude',sessionId:'claude-probe',callId:'after-restart'},message:'重启后继续同一线程'});
  await waitFor(()=>modelRequests.some(r=>JSON.stringify(r.input).includes(resumed.message_id)),10000);assert.equal(taskFrames().length,1);
  const waitIdle=async()=>{const idleDeadline=Date.now()+10000;while((await client!.request('thread/read',{threadId:thread.id,includeTurns:false})).thread.status.type!=='idle'){assert.ok(Date.now()<idleDeadline,'原生线程未空闲');await delay(50);}};
  await waitIdle();
                                            
  assert.match(JSON.stringify(recovered.capabilities.notes),/bridge restarted/);
  const pickupBaseline=modelRequests.length;pickupNext=true;
  await client.request('turn/start',{threadId:thread.id,input:[{type:'text',text:'正常继续并取件，核对桥接恢复后的现有事实'}]});
  await waitFor(()=>modelRequests.slice(pickupBaseline).some(r=>r.input?.some((item:any)=>item.type==='function_call_output'&&String(item.call_id).startsWith('native-pickup-'))),15000);
  assert.doesNotMatch(JSON.stringify(modelRequests.slice(pickupBaseline)),/bridge restarted/);
  await waitIdle();assert.equal(taskFrames().length,1);
  assert.equal((await client.request('thread/read',{threadId:thread.id,includeTurns:false})).thread.id,thread.id);

                                           
  const ledger=new Store(':memory:'),implicitAdapter=new CodexAdapter({...config,codexEndpoint:endpoint},nxhome),count=modelRequests.length;
  try{
    const implicit=await implicitAdapter.create(ledger.placeholder('codex',directory));
    assert.equal(implicit.kind,'root');assert.equal(implicit.parentId,undefined);assert.equal(modelRequests.length,count);
    await implicitAdapter.release({...ledger.peers()[0]!,sessionId:implicit.sessionId},{...implicit.endpoint,peerId:'test',seenAt:Date.now(),active:true});
    const restoredThread=await client.request('thread/resume',{threadId:implicit.sessionId});assert.equal(restoredThread.thread.id,implicit.sessionId);assert.equal(modelRequests.length,count);
    const completed=new Set<string>();
    client.on('notification',m=>{if(m.method==='turn/completed')completed.add(m.params.turn.id);});
    const checkReminder=async(threadId:string,input:any)=>{
      const before=modelRequests.length,result=await client!.request('turn/start',{threadId,...input});
      await waitFor(()=>completed.has(result.turn.id),10000);
      assert.equal(modelRequests.length,before+1);
      const serialized=JSON.stringify(modelRequests.at(-1));
      assert.equal(serialized.split('nxbridge: claude=peer partner').length-1,1);
      assert.ok(serialized.includes(JSON.stringify(CODEX_PARTNER_INSTRUCTIONS).slice(1,-1)));
    };
    await checkReminder(implicit.sessionId,{input:[{type:'text',text:'检查托管线程首轮提醒'}]});
    await checkReminder(implicit.sessionId,{input:[{type:'text',text:'检查连续轮次不重复提醒'}]});
    const beforeCompact=completed.size;
    await client.request('thread/compact/start',{threadId:implicit.sessionId});
    await waitFor(()=>completed.size>beforeCompact,15000);
    await checkReminder(implicit.sessionId,{input:[{type:'text',text:'检查原生压缩后提醒'}]});
    const forked=await client.request('thread/fork',{threadId:implicit.sessionId,cwd:directory});
    await checkReminder(forked.thread.id,{input:[{type:'text',text:'检查派生线程提醒'}]});
    await client.request('thread/unsubscribe',{threadId:forked.thread.id});
    await client.request('thread/unsubscribe',{threadId:implicit.sessionId});
  }finally{implicitAdapter.close();ledger.close();}
  if(await isElevated()){
    const managed=new CodexAdapter(config,nxhome);
    try{
      const managedEndpoint=await managed.ensureEndpoint(),record=runtimeFor(nxhome,{endpoint:managedEndpoint})!,runtime=record.value;assert.ok(runtime.pid);managedPid=await remember(runtime.pid);
                                      
      const rpc=await managed.connect(managedEndpoint),created=await rpc.request('thread/start',{cwd:directory,config:{thread_unload_delay_secs:0}});
      assert.match(await managed.releaseRuntime()??'',/仍有已加载线程/);assert.equal(liveProcess(managedPid!),true);
      await rpc.request('thread/unsubscribe',{threadId:created.thread.id});
      const unloadedBy=Date.now()+5000;
      while((await rpc.request('thread/loaded/list',{limit:1})).data.length){if(Date.now()>unloadedBy)throw Error('原生线程未按配置卸载');await delay(50);}
      assert.equal(await managed.releaseRuntime(),undefined);assert.equal(existsSync(record.file),false);
      await waitFor(()=>!liveProcess(managedPid!),5000);managedPid=undefined;
    }finally{managed.close();}
  }
  askNext=true;
  await client.request('turn/start',{threadId:thread.id,input:[{type:'text',text:'验证显式搭档提问'}]});
  await waitFor(()=>modelRequests.some(r=>r.input?.some((item:any)=>item.type==='function_call_output'&&item.call_id==='native-ask')),15000);
  const askOutput=modelRequests.flatMap(r=>r.input??[]).find((item:any)=>item.type==='function_call_output'&&item.call_id==='native-ask');
  assert.match(JSON.stringify(askOutput),/pending/);
  const pending=(await brokerCall('status')).questions.find((q:any)=>q.format==='codex'&&q.status==='pending');assert.ok(pending);
  await brokerCall('question.answer',{actor:{host:'claude',sessionId:'claude-probe',callId:'native-answer'},input:{request_id:pending.id,answers:{'输出格式？':'摘要'},rationale:'测试搭档答案来源。'}});
  await waitFor(()=>modelRequests.some(r=>JSON.stringify(r.input).includes('nxbridge.question_result')),15000);
  const returned=modelRequests.find(r=>JSON.stringify(r.input).includes('nxbridge.question_result'));
  assert.match(JSON.stringify(returned.input),/测试搭档答案来源/);assert.match(JSON.stringify(returned.input),/partner/);
  const removed=await uninstall();t.diagnostic(JSON.stringify(removed));assert.equal(removed.removed,true,JSON.stringify(removed));
  const restored=parse(readFileSync(path.join(codexhome,'config.toml'),'utf8')) as any;
  assert.equal(restored.features.code_mode,false);assert.equal(restored.model_verbosity,'low');
  assert.equal(restored.features.non_prefixed_mcp_tool_names,undefined);
  await setup();
                                     
  const edited=parse(readFileSync(path.join(codexhome,'config.toml'),'utf8')) as any;
  edited.features.code_mode.enabled=true;
  const {stringify}=await import('smol-toml');writeFileSync(path.join(codexhome,'config.toml'),stringify(edited));
  const preserved=await uninstall() as any;assert.ok(preserved.notes.some((n:string)=>n.includes('code_mode')));
  assert.equal((parse(readFileSync(path.join(codexhome,'config.toml'),'utf8')) as any).features.code_mode.enabled,true);
  t.diagnostic('官方 CLI 安装、配置保留、Unix socket 直连、首轮命名空间、双向消息、卸载全部通过；真实模型调用为 0。');
});
