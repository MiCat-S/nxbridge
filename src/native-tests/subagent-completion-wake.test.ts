import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { stringify } from 'smol-toml';
import { Broker, type Adapters } from '../broker/coordinator.js';
import { DEFAULT_CONFIG } from '../config/defaults.js';
import { CodexAdapter, threadRegistration } from '../hosts/codex/adapter.js';
import type { CodexSubagentReadFloor } from '../hosts/codex/codex-subagent-read.js';
import { configClient } from '../hosts/codex/stdio-codex.js';
import { managedRuntimes } from '../hosts/managed-runtimes.js';
import { preparePlugins } from '../install/setup.js';
import { hookGuardTimeout } from '../integration/hooks/hook-output.js';
import { ensureHome } from '../ipc/home.js';
import { listenBroker } from '../ipc/ipc.js';
import { runCli } from '../process/host-command.js';
import { processIdentity } from '../process/process.js';
import { DeliveryError } from '../shared/errors.js';
import { delay } from '../shared/time.js';
import { Store } from '../storage/store.js';
import { overrideEnvironment } from '../tests/support/environment.js';
import { FakeAdapter } from '../tests/support/fake-adapter.js';
import { releaseNativeTestLaunches } from '../tests/support/native-launch.js';
import { registration } from '../tests/support/registration.js';
import { temporaryDirectory } from '../tests/support/temporary.js';
import { HEALTH_WAKE_NOTICE } from '../types.js';
import { readModelBody } from './model-http-fixture.js';

function scenario(name:string){
  let release!:()=>void;
  const held=new Promise<void>(resolve=>release=resolve);
  return {name,held,release,childResult:'NX_CHILD_DONE_'+name,callId:'spawn-'+name,spawned:false,childStarted:false,childReleased:false,childTurnId:'',agentId:'',parentTranscript:'',childTranscript:'',floor:undefined as CodexSubagentReadFloor|undefined,waited:false,resultRead:false,contextRead:false};
}

function tool(body:any,pattern:RegExp):{name:string;namespace?:string;parameters?:any;input_schema?:any}|undefined{
  for(const entry of body.tools??[]){
    if(entry.type==='namespace'){
      const inner=entry.tools.find((item:any)=>pattern.test(item.name));
      if(inner)return{...inner,namespace:entry.name};
    }else if(pattern.test(entry.name))return entry;
  }
}

test('官方 Codex 原生专用后台以原会话承接子代理结果，RPC 与入队各只续跑一次',{timeout:155000},async t=>{
  const temp=temporaryDirectory(),cwd=temp.directory,home=path.join(cwd,'bridge'),codexHome=path.join(cwd,'codex'),claudeHome=path.join(cwd,'claude');
  for(const directory of [home,codexHome,claudeHome])mkdirSync(directory);
  const config={...DEFAULT_CONFIG,implicit:'never' as const,codexHome,claudeHome,...(process.env.NXBRIDGE_TEST_CODEX_BINARY?{codexBinary:process.env.NXBRIDGE_TEST_CODEX_BINARY}:{})};
  const restore=overrideEnvironment({NXBRIDGE_HOME:home,CODEX_HOME:codexHome,CLAUDE_CONFIG_DIR:claudeHome,OPENAI_API_KEY:'nxbridge-local-test-only'});
  const primary=scenario('primary'),fallback=scenario('queue');let phase=primary,requests=0,providerError:unknown;
  const rootModel='gpt-5.1-codex',childModel='gpt-6-sol';
  const model=http.createServer(async(req,res)=>{
    try{
      const raw=await readModelBody(req);
      if(!req.url?.includes('/responses')){res.writeHead(200,{'content-type':'application/json'});res.end('{"data":[]}');return;}
      const body=JSON.parse(raw.toString('utf8')),step=phase,id='completion-fixture-'+ ++requests;
      const message=(text:string)=>({type:'message',id:'msg-'+id,role:'assistant',status:'completed',content:[{type:'output_text',text}]});
      const call=(spec:NonNullable<ReturnType<typeof tool>>,callId:string,args:object)=>({type:'function_call',id:'call-'+id,call_id:callId,name:spec.name,...(spec.namespace?{namespace:spec.namespace}:{}),arguments:JSON.stringify(args)});
      let item:ReturnType<typeof message>|ReturnType<typeof call>;
      if(body.model===childModel){step.childStarted=true;await step.held;item=message(step.childResult);}
      else{
        assert.equal(body.model,rootModel);
        if(!step.spawned){
          const spawn=tool(body,/(?:^|\.)spawn_agent$/);assert.ok(spawn,'原生子代理工具未加载');
          const v2=(spawn.parameters??spawn.input_schema)?.required?.includes('task_name');
          step.spawned=true;item=call(spawn,step.callId,{message:'完成隔离的子代理验收任务。',model:childModel,...(v2?{task_name:'completion_'+step.name,fork_turns:'none'}:{fork_context:false})});
        }else if(!step.childReleased)item=message('NX_ROOT_IDLE_'+step.name);
        else{
          const input=JSON.stringify(body.input);
          step.contextRead||=!!step.childTurnId&&body.input.some((entry:unknown)=>{
            const text=JSON.stringify(entry);
            return text.includes('[nxbridge own_subagents_completed]')&&text.includes(step.childTurnId);
          });
          if(input.includes(step.childResult)){step.resultRead=true;item=message('NX_ROOT_READ_'+step.name);}
          else{
            assert.equal(step.waited,false,'续跑后子代理结果未进入模型请求');step.waited=true;
            const wait=tool(body,/(?:^|\.)(?:wait_agent|wait)$/);assert.ok(wait,'原生等待工具未加载');
            const spawn=body.input.find((entry:any)=>entry.type==='function_call_output'&&entry.call_id===step.callId);
            const spawned=JSON.parse(spawn?.output),idKey=Object.keys((wait.parameters??wait.input_schema)?.properties??{}).find(key=>(wait.parameters??wait.input_schema).properties[key].type==='array');
            const child=spawned.agent_id??spawned.id;assert.ok(!idKey||typeof child==='string','原生子代理启动没有返回会话编号');
            item=call(wait,'wait-'+step.name,{...(idKey?{[idKey]:[child]}:{}),timeout_ms:10000});
          }
        }
      }
      res.writeHead(200,{'content-type':'text/event-stream'});
      for(const event of [{type:'response.created',response:{id,status:'in_progress',output:[]}},{type:'response.output_item.added',output_index:0,item},{type:'response.output_item.done',output_index:0,item},{type:'response.completed',response:{id,status:'completed',output:[item],usage:{input_tokens:20,output_tokens:5,total_tokens:25}}}])res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
      res.end();
    }catch(error){providerError=error;res.writeHead(500);res.end(String(error));}
  });
  const adapter=new CodexAdapter(config,home),store=new Store(path.join(home,'nxbridge.db'));
  const broker=new Broker(store,config,{codex:adapter,claude:new FakeAdapter()} as unknown as Adapters,home);
  let listener:Awaited<ReturnType<typeof listenBroker>>|undefined;
  t.after(async()=>{
    primary.release();fallback.release();
    try{await listener?.close();await broker.stop(false);adapter.close();assert.deepEqual(await releaseNativeTestLaunches(home),[]);}
    finally{store.close();model.closeAllConnections();if(model.listening)await new Promise<void>(resolve=>model.close(()=>resolve()));restore();await temp.cleanup();}
  });
  await new Promise<void>(resolve=>model.listen(0,'127.0.0.1',resolve));
  const base=`http://127.0.0.1:${(model.address() as {port:number}).port}/v1`,configFile=path.join(codexHome,'config.toml');
  writeFileSync(path.join(home,'config.json'),JSON.stringify(config),'utf8');
  writeFileSync(configFile,stringify({model:rootModel,model_provider:'local_completion_canary',model_reasoning_effort:'low',web_search:'disabled',sandbox_mode:'read-only',approval_policy:'never',check_for_update_on_startup:false,
    analytics:{enabled:false},features:{hooks:true,multi_agent:true,multi_agent_v2:false,apps:false,remote_plugin:false,code_mode:{enabled:false}},projects:{[cwd]:{trust_level:'trusted'}},
    model_providers:{local_completion_canary:{name:'本机子代理完成验收',base_url:base,wire_api:'responses',requires_openai_auth:false,request_max_retries:0,stream_max_retries:0}}}),'utf8');
  await ensureHome(home);
  const marketplace=await preparePlugins(home);
  await runCli('codex',['plugin','marketplace','add',marketplace,'--json'],{config,home,cwd});
  await runCli('codex',['plugin','add','nxbridge@nxbridge-local','--json'],{config,home,cwd});
  const control=await configClient(config,home);
  try{
    const hooks=(await control.request('hooks/list',{cwds:[cwd]})).data.flatMap((row:any)=>row.hooks??[]).filter((hook:any)=>hook.pluginId==='nxbridge@nxbridge-local');
    assert.ok(hooks.some((hook:any)=>String(hook.eventName).toLowerCase()==='subagentstop'||String(hook.key).includes('SubagentStop')),'插件必须交给原生宿主执行子代理完成 hook');
    await control.request('config/batchWrite',{edits:[{keyPath:'hooks.state',value:Object.fromEntries(hooks.map((hook:any)=>[hook.key,{enabled:true,trusted_hash:hook.currentHash}])),mergeStrategy:'replace'}],filePath:configFile},{mutation:true});
  }finally{await control.close();}

  const syntheticTurns=new Set<string>();
  listener=await listenBroker(home,async(method,input)=>{
    if(method==='hook'){
      const hook=input as {hook_event_name?:string;prompt?:unknown;turn_id?:string;agent_id?:string;transcript_path?:string;agent_transcript_path?:string};
      if(hook.prompt===HEALTH_WAKE_NOTICE&&hook.turn_id)syntheticTurns.add(hook.turn_id);
      if(hook.hook_event_name==='SubagentStop'&&hook.turn_id){
        const current=phase;
        current.childTurnId=hook.turn_id;current.agentId=hook.agent_id??'';
        current.parentTranscript=hook.transcript_path??'';current.childTranscript=hook.agent_transcript_path??'';
        const result=await broker.dispatch(method,input);
        current.floor=ledger()?.pending?.find(entry=>entry.agentId===current.agentId&&entry.childTurnId===current.childTurnId)?.floor;
        return result;
      }
    }
    return broker.dispatch(method,input);
  });
  const placeholder=store.placeholder('codex',cwd),address=await adapter.ensureEndpoint(cwd,placeholder.id);
  const runtime=managedRuntimes(home).find(record=>record.value.peerId===placeholder.id)?.value;
  assert.ok(runtime?.pid&&runtime.procStart);
  const rpc=await adapter.connect(address),started=await rpc.request('thread/start',{cwd}),sessionId=started.thread.id;
  const input=threadRegistration(started.thread,address,started)!;
  input.endpoint={...input.endpoint,configHome:codexHome,runtimeId:runtime.id,pid:runtime.pid,procStart:runtime.procStart};
  const root=store.adopt(placeholder.id,input),self=await processIdentity(process.pid);
  const ledger=()=>store.setting<{pending:{agentId:string;childTurnId:string;floor?:CodexSubagentReadFloor}[]}>('subagentCompletions:'+root.id);
  const partner=store.register(registration('claude','completion-counterpart',{cwd,endpoint:{mode:'claude-inbox',address:'local-counterpart',epoch:'fixture',pid:self.pid,procStart:self.startedAt}}));
  store.pair(partner.id,root.id);
  await broker.start();
  const completed=new Map<string,string>(),hookFailures:{event:unknown;message:unknown;entries:unknown}[]=[];
  rpc.on('notification',message=>{
    if(message.method==='turn/completed'&&message.params.threadId===sessionId)completed.set(message.params.turn.id,message.params.turn.status);
    if(message.method==='hook/completed'&&(message.params.run?.status==='failed'||hookGuardTimeout(message.params.run?.entries))){
      const run=message.params.run;
      hookFailures.push({event:run.eventName,message:run.statusMessage,entries:run.entries});
    }
  });
  const nativeRequest=rpc.request.bind(rpc);let primarySends=0,forcedFallback=0,queueAccepted=0;
  t.mock.method(rpc,'request',async(method:string,params:any,options:any)=>{
    if(method==='turn/start'&&params?.threadId===sessionId&&params.input?.[0]?.text===HEALTH_WAKE_NOTICE){
      if(phase===fallback&&forcedFallback===0){forcedFallback++;throw new DeliveryError('-32601','隔离验收：原生 turn/start 明确拒绝');}
      primarySends++;
    }
    return nativeRequest(method,params,options);
  });
  const nativeQueue=adapter.queueWake.bind(adapter);
  t.mock.method(adapter,'queueWake',async(...args:Parameters<typeof adapter.queueWake>)=>{await nativeQueue(...args);queueAccepted++;});
  const relevantEvents=()=>store.events(0,1500).filter(event=>/^subagent\.|^wake\.|^hook\./.test(String(event.type)));
  const idle=async()=>(await rpc.request('thread/read',{threadId:sessionId,includeTurns:false},{timeout:5000})).thread.status?.type==='idle';
  const rollout=(file:string)=>{
    assert.ok(path.isAbsolute(file),'原生 hook 必须携带历史的绝对路径');
    const resolved=realpathSync.native(file),relative=path.relative(realpathSync.native(codexHome),resolved);
    assert.ok(relative&&!path.isAbsolute(relative)&&relative.split(path.sep)[0]!=='..','原生历史必须在隔离 Codex 配置目录内');
    return readFileSync(resolved,'utf8').trim().split('\n').map(line=>JSON.parse(line));
  };
  const wait=async(check:()=>boolean|Promise<boolean>,why:string)=>{
    const deadline=Date.now()+25000;
    while(!await check()){
      if(providerError)throw providerError;
      if(Date.now()>=deadline){t.diagnostic(JSON.stringify({phase:phase.name,completed:[...completed],syntheticTurns:[...syntheticTurns],requests,primarySends,forcedFallback,queueAccepted,state:store.peer(root.id).state,hookFailures,events:relevantEvents()}));assert.fail(why);}
      await delay(75);
    }
  };

  for(const next of [primary,fallback]){
    phase=next;
    const before=new Set(completed.keys()),beforeSynthetic=new Set(syntheticTurns),beforeRead=relevantEvents().filter(event=>event.type==='subagent.results_read').length;
    const {turn}=await rpc.request('turn/start',{threadId:sessionId,input:[{type:'text',text:'启动子代理，先结束父轮次。'+phase.name}]},{mutation:true});
    await wait(async()=>phase.childStarted&&completed.get(turn.id)==='completed'&&await idle(),'父会话没有在子代理结束前空闲');
    phase.childReleased=true;phase.release();
    await wait(async()=>phase.resultRead&&[...syntheticTurns].some(id=>!beforeSynthetic.has(id)&&completed.get(id)==='completed')&&await idle(),'自己的子代理完成后未续跑原父会话');
    for(let round=0;round<3;round++){await broker.pump();await delay(75);}
    assert.ok(phase.contextRead,'完成通知必须实际到达本机模型请求');
    const parentRows=rollout(phase.parentTranscript),childRows=rollout(phase.childTranscript);
    assert.equal(parentRows[0]?.payload.id,sessionId);
    assert.equal(childRows[0]?.payload.id,phase.agentId);
    assert.notEqual(phase.childTurnId,turn.id);
    assert.ok(childRows.some(row=>row.type==='event_msg'&&['task_started','turn_started'].includes(row.payload?.type)&&row.payload.turn_id===phase.childTurnId),'子代理 hook 必须携带子轮次编号');
    const {dev,ino,size}=statSync(phase.parentTranscript);
    assert.ok(phase.floor&&phase.floor.dev===dev&&phase.floor.ino===ino&&phase.floor.offset>0&&phase.floor.offset<size,'父会话的原生历史必须有已核验的追加位置');
    if(ledger()?.pending.length){
      t.diagnostic(JSON.stringify({phase:phase.name,floor:phase.floor,pending:ledger()?.pending,parentRows:parentRows.slice(-28).map(row=>({type:row.type,payloadType:row.payload?.type,turnId:row.payload?.turn_id??row.payload?.internal_chat_message_metadata_passthrough?.turn_id,role:row.payload?.role,kinds:row.payload?.internal_chat_message_metadata_passthrough?.content_item_kinds,hasChildResult:JSON.stringify(row.payload)?.includes(phase.childResult),historySequence:row.metadata?.history_sequence,sampledThrough:row.metadata?.sampled_through_sequence}))}));
    }
    assert.equal(ledger()?.pending.length,0,'真实父会话 Stop 必须结算已读子代理结果');
    assert.equal(relevantEvents().filter(event=>event.type==='subagent.results_read').length,beforeRead+1);
    assert.equal(store.peer(root.id).sessionId,sessionId);
    assert.equal([...syntheticTurns].filter(id=>!beforeSynthetic.has(id)).length,1);
    assert.equal([...completed.keys()].filter(id=>!before.has(id)).length,2,'每个阶段应恰好有手动轮次和一次完成唤醒');
  }
  assert.equal(primarySends,1);assert.equal(forcedFallback,1);assert.equal(queueAccepted,1);
  assert.equal(relevantEvents().filter(event=>event.type==='subagent.wake.fallback').length,1);
  assert.equal(providerError,undefined);
  t.diagnostic(JSON.stringify({nativePrimary:primarySends,officialQueue:queueAccepted,rootWakeTurns:syntheticTurns.size,loopbackModelRequests:requests,realModelCalls:0}));
});
