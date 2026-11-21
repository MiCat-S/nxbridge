import { overrideEnvironment } from '../tests/support/environment.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import type { AddressInfo } from 'node:net';
import { existsSync,mkdirSync,readFileSync,writeFileSync } from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import { readModelBody } from './model-http-fixture.js';
import { stringify } from 'smol-toml';
import { preparePlugins } from '../install/setup.js';
import { brokerCall,ensureBroker } from '../ipc/ipc.js';
import { connectAppServer } from '../hosts/codex/adapter.js';
import { stopOwnedProcess } from '../process/process-stop.js';
import {DEFAULT_CONFIG} from '../config/defaults.js';
import { loadBridgeConfig } from '../config/configuration.js';
import {runCli} from '../process/host-command.js';
import {delay} from '../shared/time.js';
import {PACKAGE_ROOT} from '../shared/package-location.js';
import { temporaryDirectory } from '../tests/support/temporary.js';
import { Store } from '../storage/store.js';
import { managedRuntimes } from '../hosts/managed-runtimes.js';
import { rememberOwnedChild } from '../process/owned-processes.js';

const registrationDelay=Number(process.env.NXBRIDGE_TEST_MCP_REGISTER_DELAY_MS??0);
test(registrationDelay?'官方 Codex MCP 注册延迟：真实配置和发信不在身份核验前丢失':'官方 Codex never：真实配置工具、可信根确认、工具投递/队列/V1 子代理隔离与所有者一致',async t=>{
  const temp=temporaryDirectory(),directory=temp.directory,home=path.join(directory,'bridge'),codexhome=path.join(directory,'codex'),hooklog=path.join(directory,'hook.jsonl');
  mkdirSync(home);mkdirSync(codexhome);
  const config={...DEFAULT_CONFIG,implicit:'never' as const,compatibilityWake:'strict' as const,codexHome:codexhome,...(process.env.NXBRIDGE_TEST_CODEX_BINARY?{codexBinary:process.env.NXBRIDGE_TEST_CODEX_BINARY}:{})};
  writeFileSync(path.join(home,'config.json'),JSON.stringify(config),'utf8');
  const env={NXBRIDGE_HOME:home,CODEX_HOME:codexhome,CLAUDE_CONFIG_DIR:path.join(directory,'claude')},restoreEnvironment=overrideEnvironment(env);
  const registrationLog=path.join(directory,'mcp-registration.jsonl');
  assert.ok([0,2100,15100].includes(registrationDelay),'注册延迟诊断只接受既定的隔离探针值');
  const hook=path.join(directory,'capture.mjs');writeFileSync(hook,`import{readFileSync,appendFileSync}from'node:fs';appendFileSync(${JSON.stringify(hooklog)},JSON.stringify(JSON.parse(readFileSync(0,'utf8')))+'\\n','utf8');`,'utf8');
  writeFileSync(path.join(codexhome,'hooks.json'),JSON.stringify({hooks:{UserPromptSubmit:[{hooks:[{type:'command',command:'node "'+hook.replaceAll('\\','/')+'"'}]}]}}),'utf8');
  let phase='config',rootId='',hold=false,release:(()=>void)|undefined;const bodies:any[]=[],errors:string[]=[];
  const tool=(body:any,name:RegExp):any=>{for(const entry of [...body.tools??[],...(body.input??[]).filter((v:any)=>v.type==='additional_tools').flatMap((v:any)=>v.tools??[])]){if(entry.type==='namespace'){const found=entry.tools.find((v:any)=>name.test(v.name));if(found)return{...found,namespace:entry.name};}else if(name.test(entry.name))return entry;}};
  const call=(spec:any,id:string,input:unknown)=>({type:'function_call',id,call_id:id,name:spec.name,...(spec.namespace?{namespace:spec.namespace}:{}),arguments:JSON.stringify(input)});
  const model=http.createServer(async(req,res)=>{try{
    const raw=await readModelBody(req);
    if(!req.url?.includes('/responses')){res.writeHead(200,{'content-type':'application/json'});res.end('{"data":[]}');return;}
    const body=JSON.parse(raw.toString('utf8'));bodies.push(body);if(hold)await new Promise<void>(resolve=>{release=resolve;});
    const outputs=(body.input??[]).filter((v:any)=>['function_call_output','custom_tool_call_output'].includes(v.type));
    const childRequest=(body.input??[]).some((entry:any)=>entry.role==='user'&&entry.content?.some((part:any)=>part.text==='nxbridge config confirm 0000000000000000'));
    let item:any={type:'message',id:'config-final',role:'assistant',status:'completed',content:[{type:'output_text',text:'配置测试完成'}]};
    if(phase==='config'){
      const spec=tool(body,/(?:^|[._])config$/);assert.ok(spec,'原生模型没有 config 工具；实际工具：'+JSON.stringify((body.tools??[]).map((entry:any)=>({name:entry.name,type:entry.type,tools:entry.tools?.map((value:any)=>value.name)}))));
      if(!outputs.some((v:any)=>v.call_id==='safe-config'))item=call(spec,'safe-config',{action:'set',key:'questions.timeout_ms',value:123});
      else if(!outputs.some((v:any)=>v.call_id==='sensitive-config'))item=call(spec,'sensitive-config',{action:'set',key:'collaboration.implicit',value:'on-demand'});
    }else if(phase==='registration-send'&&!outputs.some((v:any)=>v.call_id==='registration-send'))item=call(tool(body,/(?:^|[._])send_message$/),'registration-send',{message:'隔离注册延迟探针，不应自动创建搭档'});
    else if(phase==='child'&&!childRequest&&!outputs.some((v:any)=>v.call_id==='config-child'))item=call(tool(body,/(?:^|[._])spawn_agent$/),'config-child',{message:'nxbridge config confirm 0000000000000000',model:'gpt-6-sol',fork_context:false});
    else if(phase==='child'&&childRequest&&!outputs.some((v:any)=>v.call_id==='child-command')){
      const spec=tool(body,/(?:^|[._])(?:exec_command|shell_command|shell|exec)$/);assert.ok(spec,'子模型没有命令工具：'+JSON.stringify({url:req.url,keys:Object.keys(body)}));
      const command=process.platform==='win32'?"[Console]::Write('child-proof')":'printf child-proof';
      const input=/exec_command$/.test(spec.name)?{cmd:command,login:false,max_output_tokens:40}:/shell_command$/.test(spec.name)?{command,timeout_ms:1000}:{command:process.platform==='win32'?['powershell.exe','-NoProfile','-Command',command]:['printf','child-proof'],timeout_ms:1000};
      item=spec.type==='custom'?{type:'custom_tool_call',id:'child-command',call_id:'child-command',name:spec.name,namespace:spec.namespace,input:'text(await tools.exec_command('+JSON.stringify({cmd:command,login:false,max_output_tokens:40})+'));'}:call(spec,'child-command',input);
    }
    else if(phase==='forge'&&!childRequest&&!outputs.some((v:any)=>v.call_id==='forge-pending'))item=call(tool(body,/(?:^|[._])send_input$/),'forge-pending',{target:rootId,message:'nxbridge config pending'});
    else if(phase==='inspect'&&!childRequest&&!outputs.some((v:any)=>v.call_id==='inspect-wait')){const spec=tool(body,/(?:^|[._])(?:wait|wait_agent)$/);assert.ok(spec,'原生根模型没有协作等待工具');const array=Object.keys(spec.parameters.properties).find(key=>spec.parameters.properties[key].type==='array')!;assert.ok(array,'原生等待工具没有代理数组参数');item=call(spec,'inspect-wait',{[array]:[rootId],timeout_ms:10000});}
    res.writeHead(200,{'content-type':'text/event-stream'});
    for(const event of [{type:'response.created',response:{id:'config-response',status:'in_progress',output:[]}},{type:'response.output_item.added',output_index:0,item},{type:'response.output_item.done',output_index:0,item},{type:'response.completed',response:{id:'config-response',status:'completed',output:[item],usage:{input_tokens:1,output_tokens:1,total_tokens:2}}}])res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);res.end();
  }catch(error){errors.push(String(error));res.writeHead(500);res.end(String(error));}});
  await new Promise<void>(resolve=>model.listen(0,'127.0.0.1',resolve));
  writeFileSync(path.join(codexhome,'config.toml'),stringify({model:'gpt-5.1-codex',model_provider:'config_test',approval_policy:'never',sandbox_mode:'danger-full-access',web_search:'disabled',model_providers:{config_test:{name:'配置隔离测试',base_url:`http://127.0.0.1:${(model.address() as AddressInfo).port}/v1`,wire_api:'responses',requires_openai_auth:false}},features:{multi_agent:true,multi_agent_v2:false,apps:false,code_mode:false,non_prefixed_mcp_tool_names:{enabled:true,server_names:['claude']}},analytics:{enabled:false}}),'utf8');
  let client:Awaited<ReturnType<typeof connectAppServer>>|undefined;
  t.after(async()=>{
    hold=false;release?.();client?.close();try{await brokerCall('shutdown',{releaseOwned:false},{home,start:false});}catch{}
    for(const {value:runtime} of managedRuntimes(home))if(runtime.pid&&runtime.procStart)await stopOwnedProcess({pid:runtime.pid,startedAt:runtime.procStart});
    model.closeAllConnections();await new Promise<void>(resolve=>model.close(()=>resolve()));
    restoreEnvironment();await temp.cleanup();
  });
  const marketplace=await preparePlugins(home),trace=path.join(directory,'mcp.jsonl'),mcpFile=path.join(marketplace,'plugins/codex/.mcp.json'),mcpConfig=JSON.parse(readFileSync(mcpFile,'utf8'));
  mcpConfig.mcpServers.claude={command:process.execPath,args:[fileURLToPath(new URL('../../tools/trace-hook-mcp.mjs',import.meta.url)),'mcp','--host','codex'],env:{NXBRIDGE_HOME:home,CODEX_HOME:codexhome,NXBRIDGE_PROFILE_LOG:trace}};writeFileSync(mcpFile,JSON.stringify(mcpConfig),'utf8');
  await runCli('codex',['plugin','marketplace','add',marketplace,'--json'],{config});await runCli('codex',['plugin','add','nxbridge@nxbridge-local','--json'],{config});
                                                              
  const declared=JSON.parse(readFileSync(path.join(PACKAGE_ROOT,'plugins/codex/hooks/hooks.json'),'utf8'));
  for(const groups of Object.values(declared.hooks) as any[])for(const group of groups)for(const entry of group.hooks)if(entry.type==='command')entry.command=entry.command.replaceAll('${PLUGIN_ROOT}',path.join(marketplace,'plugins/codex').replaceAll('\\','/'));
  declared.hooks.UserPromptSubmit.push({hooks:[{type:'command',command:'node "'+hook.replaceAll('\\','/')+'"'}]});writeFileSync(path.join(codexhome,'hooks.json'),JSON.stringify(declared),'utf8');
  if(registrationDelay){
                                           
    const launcher=path.join(directory,'delayed-broker.mjs');
    writeFileSync(launcher,`import{Broker}from ${JSON.stringify(new URL('../broker/coordinator.js',import.meta.url).href)};import{runService}from ${JSON.stringify(new URL('../broker/service.js',import.meta.url).href)};import{appendFileSync}from'node:fs';import{setTimeout as delay}from'node:timers/promises';let calls=0;const original=Broker.prototype.dispatch;Broker.prototype.dispatch=async function(method,params){const started=Date.now(),index=method==='mcp.register'?++calls:undefined;if(index===1||index===3)await delay(${registrationDelay});try{const value=await original.call(this,method,params);if(index||method==='send'||method==='config.model')appendFileSync(${JSON.stringify(registrationLog)},JSON.stringify({method,index,elapsedMs:Date.now()-started,ok:true})+'\\n','utf8');return value;}catch(error){appendFileSync(${JSON.stringify(registrationLog)},JSON.stringify({method,index,elapsedMs:Date.now()-started,error:String(error)})+'\\n','utf8');throw error;}};await runService();`,'utf8');
    const child=spawn(process.execPath,['--no-warnings',launcher],{cwd:directory,env:process.env,stdio:['ignore','ignore','pipe'],windowsHide:true});
    child.stderr.on('data',chunk=>errors.push('隔离协调器：'+chunk.toString('utf8')));await rememberOwnedChild(home,child,'broker');
    const readyBy=Date.now()+10000;for(;;){try{await brokerCall('ping',{}, {home,start:false,timeout:500});break;}catch(error){if(Date.now()>=readyBy)throw error;await delay(50);}}
  }
  let service;try{service=await ensureBroker(home);}catch(error){const logfile=path.join(home,'run','broker.log');assert.fail(String(error)+'；'+(existsSync(logfile)?readFileSync(logfile,'utf8').slice(-5000):'无协调器日志'));}service.close();
  const {endpoint}=await brokerCall<{endpoint:string}>('codex.endpoint');client=await connectAppServer(endpoint,config,undefined,home);const hooks=await client.request('hooks/list',{cwds:[directory]}),state=Object.fromEntries(hooks.data.flatMap((item:any)=>item.hooks.filter((hook:any)=>hook.source==='user').map((hook:any)=>[hook.key,{enabled:true,trusted_hash:hook.currentHash}])));
  const completed=new Set<string>(),feedback:string[]=[],notes:any[]=[];client.on('notification',message=>{notes.push(message);if(message.method==='turn/completed')completed.add(message.params.turn.id);if(message.method==='hook/completed')for(const entry of message.params.run.entries??[])if(entry.kind==='feedback')feedback.push(entry.text);});
  client.on('request',message=>errors.push('原生交互请求：'+JSON.stringify(message)));
  const wait=async(predicate:()=>boolean,timeout=30000)=>{const end=Date.now()+timeout;while(!predicate()){if(Date.now()>=end)assert.fail('原生配置测试等待超时；'+JSON.stringify({errors,feedback,completed:[...completed],count:bodies.length,last:bodies.at(-1)?.input?.slice(-1),notes:notes.filter(note=>/error|hook\/completed|turn\/completed/.test(note.method)).slice(-12),status:await brokerCall('status')},null,2));await delay(30);}};
  const start=async(id:string,input:any)=>{const result=await client!.request('turn/start',{threadId:id,...input});await wait(()=>completed.has(result.turn.id));return result;};
  const {thread}=await client.request('thread/start',{cwd:directory,approvalPolicy:'never',sandbox:'danger-full-access',config:{'hooks.state':state}});
  rootId=thread.id;
                                             
  const mcp=await client.request('mcpServerStatus/list',{threadId:thread.id,limit:100}),bridge=mcp.data.find((server:any)=>server.name==='claude');
  assert.ok(bridge?.tools?.config,'原生插件尚未提供配置工具：'+JSON.stringify(mcp.data.map((server:any)=>({name:server.name,status:server.runtimeStatus,error:server.toolsError}))));
  await start(thread.id,{input:[{type:'text',text:'测试模型配置入口'}]});
  if(registrationDelay){
    phase='registration-send';await start(thread.id,{input:[{type:'text',text:'测试延迟注册后的真实发信工具'}]});
    const toolOutputs=[...new Map(bodies.flatMap(body=>(body.input??[]).filter((item:any)=>item.type==='function_call_output')).map(item=>[item.call_id,item])).values()];
    t.diagnostic(JSON.stringify({registrationDelay,toolOutputs,registration:existsSync(registrationLog)?readFileSync(registrationLog,'utf8'):null}));
    assert.ok(toolOutputs.some((item:any)=>item.call_id==='registration-send'),'真实 send_message 调用必须返回工具结果');
    assert.equal(loadBridgeConfig(home).questionTimeoutMs,123,'延迟注册后安全配置仍应提交');
    const sent=toolOutputs.findLast((item:any)=>item.call_id==='registration-send');assert.doesNotMatch(JSON.stringify(sent),/等待确认超时|"isError":true/);
    assert.ok(sent.output.some((item:any)=>{try{return JSON.parse(item.text).code==='partner_missing';}catch{return false;}}),'隔离未配对会话应到达业务处理并返回准确的缺少搭档错误');
    assert.ok(readFileSync(registrationLog,'utf8').split('\n').filter(Boolean).some(line=>JSON.parse(line).method==='send'),'延迟注册后必须到达真实 send 处理器');
    return;
  }
  const configuredTimeout=loadBridgeConfig(home).questionTimeoutMs;
  if(configuredTimeout!==123)t.diagnostic(JSON.stringify({errors,feedback,toolOutputs:bodies.flatMap(body=>(body.input??[]).filter((item:any)=>item.type==='function_call_output')),nativeNotes:notes.filter(note=>/error|hook\/completed|turn\/completed/.test(note.method)).slice(-12),status:await brokerCall('status')}));
  assert.equal(configuredTimeout,123);assert.equal(loadBridgeConfig(home).implicit,'never');
  const output=bodies.at(-1).input.find((item:any)=>item.type==='function_call_output'&&item.call_id==='sensitive-config').output;
  const unpack=(value:any):any=>{if(typeof value==='string')return unpack(JSON.parse(value));if(Array.isArray(value)){for(const item of value)try{return unpack(item.text);}catch{}}if(value.status==='needs_confirmation')return value;if(value.content)return unpack(value.content);throw Error('配置工具结果格式未知：'+JSON.stringify(value));};
  const proposed=unpack(output);assert.equal(proposed.token,undefined);assert.equal(proposed.review,'nxbridge config pending');phase='final';
  await start(thread.id,{input:[],toolOutput:{namespace:'claude',name:'receive_messages',output:JSON.stringify({message:proposed.review})}});assert.equal(loadBridgeConfig(home).implicit,'never');
  hold=true;release=undefined;const active=await client.request('turn/start',{threadId:thread.id,input:[{type:'text',text:'队列测试'}]});await wait(()=>!!release);
  await client.request('turn/start',{threadId:thread.id,input:[],toolOutput:{namespace:'claude',name:'receive_messages',output:JSON.stringify({message:proposed.review})}});hold=false;release!();await wait(()=>completed.has(active.turn.id));assert.equal(loadBridgeConfig(home).implicit,'never');
  phase='child';await start(thread.id,{input:[{type:'text',text:'启动 V1 子代理核验确认隔离'}]});await wait(()=>bodies.some(body=>body.model==='gpt-6-sol'&&body.input?.some((item:any)=>['function_call_output','custom_tool_call_output'].includes(item.type)&&item.call_id==='child-command')));phase='final';assert.equal(loadBridgeConfig(home).implicit,'never');
  const seen=readFileSync(hooklog,'utf8').trim().split('\n').map(line=>JSON.parse(line)),child=seen.find(item=>item.prompt==='nxbridge config confirm 0000000000000000');assert.ok(child?.agent_id,'V1 子代理必须有原生子代理标记');assert.notEqual(child.transcript_path,seen[0].transcript_path);
  phase='forge';await start(thread.id,{input:[{type:'text',text:'核验模型自发 pending 不能获得确认码'}]});await wait(()=>feedback.some(text=>/nxbridge config confirm [a-f0-9]{16}/.test(text)));assert.equal(loadBridgeConfig(home).implicit,'never');
  const confirmation=/nxbridge config confirm [a-f0-9]{16}/.exec(feedback.at(-1)!)![0],token=confirmation.split(' ').at(-1)!;
  phase='inspect';await start(thread.id,{input:[{type:'text',text:'继续并检查原生等待结果'}]});phase='final';assert.ok(!JSON.stringify(bodies).includes(token),'自发命令、原生等待或后续上下文泄露了人类确认码');
  const before=bodies.length;await start(thread.id,{input:[{type:'text',text:proposed.review}]});assert.equal(bodies.length,before);assert.ok(feedback.at(-1)?.includes(confirmation));
  await start(thread.id,{input:[{type:'text',text:confirmation}]});assert.equal(bodies.length,before,'确认应由原生 hook 消费，不调用模型');assert.equal(loadBridgeConfig(home).implicit,'on-demand');
  await start(thread.id,{input:[{type:'text',text:confirmation}]});assert.equal(loadBridgeConfig(home).implicit,'on-demand');assert.equal(bodies.length,before);
                                           
  const store=new Store(path.join(home,'nxbridge.db'));try{const peer=store.find('codex',thread.id)!;store.updatePeer(peer.id,{owner:'nxbridge'});}finally{store.close();}
  const next:any=await brokerCall('config.model',{actor:{host:'codex',sessionId:thread.id,callId:'owned-config'},input:{action:'set',key:'collaboration.subagent_send',value:'deny'}});
  await start(thread.id,{input:[{type:'text',text:next.review}]});const nextConfirmation=/nxbridge config confirm [a-f0-9]{16}/.exec(feedback.at(-1)!)![0];
  await start(thread.id,{input:[{type:'text',text:nextConfirmation}]});assert.equal(loadBridgeConfig(home).subagentSend,'deny');assert.equal(bodies.length,before);
  await start(thread.id,{input:[{type:'text',text:'确认后继续，核验上下文没有确认码'}]});assert.ok(!JSON.stringify(bodies).includes(token));assert.ok(!JSON.stringify(bodies).includes(nextConfirmation.split(' ').at(-1)!));
  const postTools=notes.filter(note=>note.method==='hook/completed'&&note.params.run.eventName==='postToolUse').map(note=>note.params.run);assert.ok(postTools.length);
  if(postTools.some(run=>run.status!=='completed')){
    const meta=JSON.parse(readFileSync(child.transcript_path,'utf8').split('\n')[0]!).payload,logfile=path.join(home,'run/broker.log');
    const calls=existsSync(trace)?readFileSync(trace,'utf8').trim().split('\n').map(line=>JSON.parse(line)).filter(call=>call.params.name==='nxbridge_hook').map(call=>({threadId:call.params._meta.threadId,input:call.params.arguments,error:call.error})):[];
    t.diagnostic(JSON.stringify({child,meta:{id:meta.id,source:meta.source,parent_thread_id:meta.parent_thread_id,thread_source:meta.thread_source},calls,broker:existsSync(logfile)?readFileSync(logfile,'utf8').slice(-4000):undefined}));
  }
  assert.ok(postTools.every(run=>run.status==='completed'),JSON.stringify(postTools.filter(run=>run.status!=='completed')));
  assert.deepEqual(errors,[]);t.diagnostic('官方 CLI + 回环假模型；never/bypass 不变；真人输入由测试模拟；根及 V1 子代理 PostToolUse 均通过；真实付费模型调用 0。');
});
