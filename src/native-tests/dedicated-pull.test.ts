import { overrideEnvironment } from '../tests/support/environment.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import { mkdirSync,writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { readModelBody } from './model-http-fixture.js';
import { temporaryDirectory } from '../tests/support/temporary.js';
import { setupPublish } from './publish-fixture.js';
import { brokerCall } from '../ipc/ipc.js';
import {DEFAULT_CONFIG} from '../config/defaults.js';
import {WAKE_NOTICE} from '../types.js';
import { readCodexHistory } from '../hosts/codex/codex-history.js';
import {spawnCli} from '../process/host-command.js';
import {delay} from '../shared/time.js';
import {privateDirectory} from '../process/permissions.js';
import { processIdentity } from '../process/process.js';
import { connectAppServer } from '../hosts/codex/adapter.js';
import { rememberOwnedHost,releaseRecordedProcesses } from '../process/owned-processes.js';

test('官方专用 Codex HTTP：空闲成对注入、忙碌真实取件、中断与重启去重、续跑失败保留历史证据',{timeout:120000},async t=>{
  const temp=temporaryDirectory(),root=temp.directory,home=path.join(root,'bridge'),codexHome=path.join(root,'codex'),claudeHome=path.join(root,'claude');
  for(const directory of [home,codexHome,claudeHome])mkdirSync(directory);
  const env={NXBRIDGE_HOME:home,CODEX_HOME:codexHome,CLAUDE_CONFIG_DIR:claudeHome,OPENAI_API_KEY:'isolated-http-pull-only'},restoreEnvironment=overrideEnvironment(env);
  const config={...DEFAULT_CONFIG,implicit:'never' as const,codexHome,claudeHome,...(process.env.NXBRIDGE_TEST_CODEX_BINARY?{codexBinary:process.env.NXBRIDGE_TEST_CODEX_BINARY}:{})};writeFileSync(path.join(home,'config.json'),JSON.stringify(config),'utf8');
  writeFileSync(path.join(codexHome,'config.toml'),'[features]\ncode_mode = false\n','utf8');
  const requests:any[]=[],protocolErrors:unknown[]=[],nativeItems:any[]=[],completed=new Map<string,any>(),launchId=randomUUID();let client:Awaited<ReturnType<typeof connectAppServer>>|undefined,hold=false,pull=false,fail=false,stderr='',gate:Promise<void>|undefined,finishHeld:(()=>void)|undefined,diagnostics:(()=>Promise<unknown>)|undefined;
  const model=http.createServer(async(req,res)=>{try{
    const raw=await readModelBody(req);
    if(!req.url?.includes('/responses')){res.writeHead(200,{'content-type':'application/json'});res.end('{"data":[]}');return;}
    const body=JSON.parse(raw.toString());requests.push(body);
    assert.equal(Object.hasOwn(body,'previous_response_id'),false,'HTTP 必须提交完整历史，不能使用仅 WebSocket 支持的 previous_response_id');
    if(gate)await gate;
    const calls=new Set((body.input??[]).filter((item:any)=>item.type==='function_call').map((item:any)=>item.call_id));
    assert.ok(!(body.input??[]).some((item:any)=>item.type==='function_call_output'&&(!item.call_id||!calls.has(item.call_id))),'HTTP 收到无对应 call_id 的工具输出');
    if(fail){fail=false;res.writeHead(429,{'content-type':'application/json'});res.end(JSON.stringify({error:{message:'隔离的模型限流失败',type:'rate_limit_error'}}));return;}
    const id='pull-http-'+requests.length;
    const respond=()=>{
    let spec:any;for(const tool of body.tools??[]){if(tool.type==='namespace'){const inner=tool.tools.find((value:any)=>/receive_messages$/.test(value.name));if(inner)spec={...inner,namespace:tool.name};}else if(/receive_messages$/.test(tool.name))spec=tool;}
    const fetch=pull&&!!spec;pull=false;
    const item=fetch?{type:'function_call',id:'fc-'+id,call_id:'call-'+id,name:spec.name,...(spec.namespace?{namespace:spec.namespace}:{}),arguments:'{}'}:{type:'message',id:'msg-'+id,role:'assistant',status:'completed',content:[{type:'output_text',text:'HTTP_PULL_DONE'}]};
    if(!res.headersSent){res.writeHead(200,{'content-type':'text/event-stream'});res.write('data: '+JSON.stringify({type:'response.created',response:{id,status:'in_progress',output:[]}})+'\n\n');}
    for(const event of[{type:'response.output_item.added',output_index:0,item},{type:'response.output_item.done',output_index:0,item},{type:'response.completed',response:{id,status:'completed',output:[item],usage:{input_tokens:1,output_tokens:1,total_tokens:2}}}])res.write('data: '+JSON.stringify(event)+'\n\n');res.end();
    };
    if(hold){res.writeHead(200,{'content-type':'text/event-stream'});res.write('data: '+JSON.stringify({type:'response.created',response:{id,status:'in_progress',output:[]}})+'\n\n');finishHeld=respond;return;}
    respond();
  }catch(error){protocolErrors.push(error);res.writeHead(500);res.end(String(error));}});
  await new Promise<void>(resolve=>model.listen(0,'127.0.0.1',resolve));
  t.after(async()=>{client?.close();try{await brokerCall('shutdown',{releaseOwned:false},{home,start:false});}catch{}await releaseRecordedProcesses(home,record=>record.proof.launchId===launchId);model.closeAllConnections();await new Promise<void>(resolve=>model.close(()=>resolve()));restoreEnvironment();await temp.cleanup();});
  await setupPublish();
  const run=path.join(root,'run');await privateDirectory(run);
  const endpoint='unix://'+path.join(run,'app.sock'),option=(key:string,value:unknown)=>['-c',key+'='+JSON.stringify(value)];
  const child=spawnCli('codex',['app-server','--listen',endpoint,...option('model','gpt-5.1-codex'),...option('model_provider','pull_http'),...option('model_providers.pull_http.name','本地 HTTP 取件验收'),...option('model_providers.pull_http.base_url',`http://127.0.0.1:${(model.address() as any).port}/v1`),...option('model_providers.pull_http.wire_api','responses'),...option('model_providers.pull_http.requires_openai_auth',false),...option('model_providers.pull_http.request_max_retries',0),...option('model_providers.pull_http.stream_max_retries',0),...option('features.apps',false),...option('features.remote_plugin',false),...option('web_search','disabled')],{stdio:['ignore','ignore','pipe']},config,home);
  child.stderr!.on('data',data=>stderr=(stderr+data).slice(-3000));await rememberOwnedHost(home,child,'codex','codex-runtime',launchId);
  const wait=async(check:()=>boolean|Promise<boolean>,timeout=20000)=>{const end=Date.now()+timeout;while(!await check()){if(Date.now()>=end){t.diagnostic(JSON.stringify({completed:[...completed.values()],requests:requests.map(body=>({tools:body.tools?.map((tool:any)=>({name:tool.name,tools:tool.tools?.map((value:any)=>value.name)})),inputTypes:body.input?.slice(-5).map((item:any)=>({type:item.type,call_id:item.call_id,name:item.name,namespace:item.namespace}))})),status:await diagnostics?.(),events:(await brokerCall<any[]>('events',{}, {home})).filter(event=>/blocked|failed|unknown/.test(event.type)).map(event=>({type:event.type,data:event.data}))}));assert.fail('等待原生取件超时 '+stderr);}await delay(50);}};
  await wait(async()=>{try{client=await connectAppServer(endpoint,config,undefined,home);return true;}catch{return false;}});
  client!.on('notification',message=>{if(message.method==='turn/completed')completed.set(message.params.turn.id,message.params.turn);if(message.method==='item/completed')nativeItems.push(message.params.item);});
  await brokerCall('codex.connect',{endpoint},{home});const {thread}=await client!.request('thread/start',{cwd:root,approvalPolicy:'never',sandbox:'read-only'});
  const status=()=>brokerCall<any>('status',{}, {home});let target:any;await wait(async()=>{target=(await status()).peers.find((peer:any)=>peer.sessionId===thread.id);return!!target;});
  diagnostics=async()=>{const value=await status(),native=(await client!.request('thread/read',{threadId:thread.id,includeTurns:false})).thread;return{peers:value.peers,messages:value.messages.map((message:any)=>({id:message.id,state:message.state})),history:await readCodexHistory(native.path,thread.id),nativeItems};};
  const identity=await processIdentity(process.pid),sender=await brokerCall<any>('register',{host:'claude',sessionId:'http-source',cwd:root,kind:'root',endpoint:{mode:'embedded',address:'',epoch:'source',pid:identity.pid,procStart:identity.startedAt}},{home});
  await brokerCall('pair',{claude:sender.id,codex:target.id},{home});
  let sequence=0;const send=async(body:string)=>brokerCall<any>('send',{actor:{host:'claude',sessionId:'http-source',callId:'send-'+sequence++},message:body},{home});
  const observed=async(id:string)=>(await status()).messages.find((message:any)=>message.id===id)?.state==='contextObserved';
  const bootstrap=await send('HTTP_PRIVATE_BODY_FIRST_UNMATERIALIZED');await wait(()=>observed(bootstrap.message_id));await wait(()=>[...completed.values()].some(turn=>turn.status==='completed'));
  await wait(async()=>(await client!.request('thread/read',{threadId:thread.id,includeTurns:false})).thread.status.type==='idle');
  let release!:()=>void;gate=new Promise<void>(resolve=>{release=resolve;});const first=await send('HTTP_PRIVATE_BODY_A'),second=await send('HTTP_PRIVATE_BODY_B');release();gate=undefined;await wait(()=>observed(first.message_id));await wait(()=>observed(second.message_id));await wait(()=>[...completed.values()].some(turn=>turn.status==='completed'));
  const outputs=requests.flatMap(body=>body.input??[]).filter(item=>item.type==='function_call_output'&&JSON.stringify(item.output).includes('HTTP_PRIVATE_BODY_A'));
  assert.ok(outputs.length);assert.ok(outputs.every(item=>typeof item.call_id==='string'));
  for(const body of requests)for(const item of body.input??[])if(item.type==='message'&&item.role==='user')assert.doesNotMatch(JSON.stringify(item),/HTTP_PRIVATE_BODY_[AB]/);
  const idle=async()=>(await client!.request('thread/read',{threadId:thread.id,includeTurns:false})).thread.status.type==='idle';await wait(idle);
  hold=true;const active=await client!.request('turn/start',{threadId:thread.id,input:[{type:'text',text:'隔离的忙碌取件轮次'}]});await wait(()=>!!finishHeld);
  const during=await send('HTTP_PRIVATE_BODY_WHILE_BUSY');assert.equal((await status()).messages.find((message:any)=>message.id===during.message_id).state,'accepted');
                                              
  hold=false;pull=true;finishHeld!();finishHeld=undefined;await wait(()=>observed(during.message_id),40000);await wait(()=>completed.has(active.turn.id));await wait(idle);
  const baseline=completed.size;hold=true;const busy=await client!.request('turn/start',{threadId:thread.id,input:[{type:'text',text:'隔离的待中断轮次'}]});await wait(()=>!!finishHeld);
  const pending=await send('HTTP_PRIVATE_BODY_AFTER_INTERRUPT');assert.equal((await status()).messages.find((message:any)=>message.id===pending.message_id).state,'accepted');
  await client!.request('turn/interrupt',{threadId:thread.id,turnId:busy.turn.id});await wait(()=>completed.size>baseline);hold=false;finishHeld=undefined;
                                          
  const resumeBaseline=new Set(completed.keys());await brokerCall('shutdown',{releaseOwned:false},{home,start:false});await delay(300);assert.equal((await status()).messages.find((message:any)=>message.id===pending.message_id).state,'accepted');
  await brokerCall('resume',{}, {home});await wait(()=>observed(pending.message_id));await wait(()=>[...completed.values()].some(turn=>!resumeBaseline.has(turn.id)&&turn.status==='completed'));await wait(idle);
  const failureBaseline=new Set(completed.keys());fail=true;const failed=await send('HTTP_PRIVATE_BODY_AFTER_FAILURE');await wait(()=>[...completed.values()].some(turn=>!failureBaseline.has(turn.id)&&turn.status==='failed'));
  await wait(()=>observed(failed.message_id));await wait(async()=>(await status()).peers.find((peer:any)=>peer.id===target.id).health?.state==='failed');
  assert.equal((await client!.request('thread/read',{threadId:thread.id,includeTurns:false})).thread.status.type,'systemError','真实 429 失败必须保留原生 systemError 状态');
  const afterFailure=await send('HTTP_PRIVATE_BODY_NEW_AFTER_429');await wait(()=>observed(afterFailure.message_id));await wait(idle);
  await brokerCall('shutdown',{releaseOwned:false},{home,start:false});await delay(300);await status();
  const history=(await client!.request('thread/read',{threadId:thread.id,includeTurns:true})).thread,evidence=await readCodexHistory(history.path,thread.id);
  assert.equal(evidence.status,'supported');
  for(const id of [bootstrap.message_id,first.message_id,second.message_id,during.message_id,pending.message_id,failed.message_id,afterFailure.message_id])assert.equal(evidence.receipts.filter(receipt=>receipt.messageId===id).length,1,'每条消息只进入一次工具结果');
  const afterMessage=(await status()).messages.find((message:any)=>message.id===afterFailure.message_id);assert.equal(afterMessage.attempts,1);assert.ok(requests.some(body=>JSON.stringify(body.input).includes('HTTP_PRIVATE_BODY_NEW_AFTER_429')),'失败后的新来信必须自动进入真实模型上下文');
  assert.ok(evidence.receipts.some(receipt=>receipt.messageId===during.message_id&&!receipt.callId.startsWith('nxbridge-')),'忙碌时通过原生真实 MCP 调用取件');
  assert.equal([...completed.values()].filter(turn=>turn.status==='failed').length,1,JSON.stringify([...completed.values()].filter(turn=>turn.status==='failed')));
  assert.ok(!requests.some(body=>(body.input??[]).some((item:any)=>item.type==='message'&&item.role==='user'&&JSON.stringify(item).includes(WAKE_NOTICE))));
  assert.deepEqual(protocolErrors,[],'HTTP 协议断言不得被请求回调吞掉');
});
