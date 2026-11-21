import { overrideEnvironment } from '../tests/support/environment.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import {mkdirSync,writeFileSync} from 'node:fs';
import { readModelBody } from './model-http-fixture.js';
import {CodexAdapter,threadRegistration} from '../hosts/codex/adapter.js';
import {Broker,type Adapters} from '../broker/coordinator.js';
import {Store} from '../storage/store.js';
import {DEFAULT_CONFIG} from '../config/defaults.js';
import {delay} from '../shared/time.js';
import {ensureHome} from '../ipc/home.js';
import {liveProcess,processDescendants,type ProcessIdentity} from '../process/process.js';
import {ownedProcesses} from '../process/owned-processes.js';
import {ownedProcessState} from '../process/process-stop.js';
import {managedRuntimes} from '../hosts/managed-runtimes.js';
import { FakeAdapter } from '../tests/support/fake-adapter.js';
import { registration } from '../tests/support/registration.js';
import { temporaryDirectory } from '../tests/support/temporary.js';
import { releaseNativeTestLaunches } from '../tests/support/native-launch.js';

test('真实子代理忙碌时拒绝重启，结束后原根会话恢复并停用原宿主全部子端点',{timeout:170000},async t=>{
  const temp=temporaryDirectory(),home=path.join(temp.directory,'bridge'),codexHome=path.join(temp.directory,'codex');mkdirSync(codexHome,{recursive:true});
  const env={NXBRIDGE_HOME:home,CODEX_HOME:codexHome,CLAUDE_CONFIG_DIR:path.join(temp.directory,'claude'),OPENAI_API_KEY:'isolated-subagent-restart'};
  const restoreEnvironment=overrideEnvironment(env);
  const config={...DEFAULT_CONFIG,codexHome,...(process.env.NXBRIDGE_TEST_CODEX_BINARY?{codexBinary:process.env.NXBRIDGE_TEST_CODEX_BINARY}:{})};
  const adapter=new CodexAdapter(config,home),store=new Store(':memory:'),broker=new Broker(store,config,{codex:adapter,claude:new FakeAdapter()} as unknown as Adapters,home);
  const stoppedTree=new Map<string,ProcessIdentity>();
  const captureTree=async()=>{for(const record of ownedProcesses(home).records.filter(value=>value.role==='codex-runtime'))if(record.windowsJob||record.posixGroup)for(const identity of [record.identity,...await processDescendants(record.identity,record)])stoppedTree.set(identity.pid+':'+identity.startedAt,identity);};
  const treeState=()=>Promise.all([...stoppedTree.values()].map(async identity=>({pid:identity.pid,procStart:identity.startedAt,name:identity.name,state:await ownedProcessState(identity)})));
  let releaseChild!:()=>void,childStarted=false,rootSpawned=false,spawnResult='',serverError='';const held=new Promise<void>(resolve=>releaseChild=resolve);
  const model=http.createServer(async(req,res)=>{
    try{
      const raw=await readModelBody(req);
      if(!req.url?.includes('/responses')){res.writeHead(200,{'content-type':'application/json'});res.end('{"data":[]}');return;}
      const body=JSON.parse(raw.toString('utf8')),child=body.model==='gpt-6-sol';let item:any;
      if(child){childStarted=true;await held;}
      const output=(body.input??[]).find((entry:any)=>entry.type==='function_call_output'&&entry.call_id==='spawn-child');if(output)spawnResult=String(output.output);
      if(!child&&!rootSpawned){
        let spawn:any;for(const entry of body.tools??[]){if(entry.type==='namespace'){const found=entry.tools.find((value:any)=>/(?:^|\.)spawn_agent$/.test(value.name));if(found)spawn={...found,namespace:entry.name};}else if(/(?:^|\.)spawn_agent$/.test(entry.name))spawn=entry;}
        assert.ok(spawn,'原生多代理工具必须可用');const v2=(spawn.parameters??spawn.input_schema??{}).required?.includes('task_name');rootSpawned=true;
        item={type:'function_call',id:'spawn-child',call_id:'spawn-child',name:spawn.name,...(spawn.namespace?{namespace:spawn.namespace}:{}),arguments:JSON.stringify({message:'隔离子代理：完成当前测试任务。',model:'gpt-6-sol',...(v2?{task_name:'restart_child',fork_turns:'none'}:{fork_context:false})})};
      }else item={type:'message',id:child?'child-done':'root-done',role:'assistant',status:'completed',content:[{type:'output_text',text:child?'CHILD_DONE':'ROOT_DONE'}]};
      res.writeHead(200,{'content-type':'text/event-stream'});
      for(const event of [{type:'response.created',response:{id:'scope-response',status:'in_progress',output:[]}},{type:'response.output_item.added',output_index:0,item},{type:'response.output_item.done',output_index:0,item},{type:'response.completed',response:{id:'scope-response',status:'completed',output:[item],usage:{input_tokens:10,output_tokens:10,total_tokens:20}}}])res.write('data: '+JSON.stringify(event)+'\n\n');res.end();
    }catch(error){serverError=String(error);res.writeHead(500);res.end(serverError);}
  });
  await new Promise<void>(resolve=>model.listen(0,'127.0.0.1',resolve));
  t.after(async()=>{
    releaseChild();await captureTree();await broker.stop(false);adapter.close();
    const notes=await releaseNativeTestLaunches(home);assert.deepEqual(notes,[]);store.close();
    const proof=await treeState();t.diagnostic(JSON.stringify({preStopNativeTree:proof}));assert.deepEqual(proof.filter(identity=>identity.state!=='dead'),[],'停止前核验的原生后代必须全部退出');
    model.closeAllConnections();await new Promise<void>(resolve=>model.close(()=>resolve()));
    restoreEnvironment();
    await temp.cleanup();
  });
  const base=`http://127.0.0.1:${(model.address() as {port:number}).port}/v1`;
  writeFileSync(path.join(codexHome,'config.toml'),`model_provider = "scope_test"\nmodel = "gpt-5.1-codex"\nmodel_reasoning_effort = "low"\nweb_search = "disabled"\nsandbox_mode = "read-only"\napproval_policy = "never"\n[model_providers.scope_test]\nname = "隔离子代理重启验收"\nbase_url = ${JSON.stringify(base)}\nwire_api = "responses"\nrequires_openai_auth = false\nrequest_max_retries = 0\nstream_max_retries = 0\n[features]\nmulti_agent = true\nmulti_agent_v2 = false\napps = false\nremote_plugin = false\n[features.code_mode]\nenabled = false\n[analytics]\nenabled = false\n`,'utf8');
  await ensureHome(home);
  const placeholder=store.placeholder('codex',temp.directory),address=await adapter.ensureEndpoint(temp.directory,placeholder.id),runtime=managedRuntimes(home).find(record=>record.value.peerId===placeholder.id)!.value;
  const rpc=await adapter.connect(address),started=await rpc.request('thread/start',{cwd:temp.directory}),input=threadRegistration(started.thread,address,started)!;
                                                   
  (adapter as any).attached.add(address+'|'+started.thread.id);
  input.endpoint={...input.endpoint,configHome:codexHome,runtimeId:runtime.id,pid:runtime.pid!,procStart:runtime.procStart!};const root=store.adopt(placeholder.id,input),endpoint=store.endpoint(root.id)!;
  const partner=store.register(registration('claude','subagent-counterpart'));store.pair(partner.id,root.id);await adapter.attach(root,endpoint);
  const completed=new Set<string>();rpc.on('notification',message=>{if(message.method==='turn/completed')completed.add(message.params.turn.id);});
  const wait=async(check:()=>boolean|Promise<boolean>)=>{const deadline=Date.now()+30000;while(!await check()){if(serverError)throw Error(serverError);if(Date.now()>deadline)throw Error('原生子代理状态超时；spawn='+spawnResult);await delay(50);}};
  const turn=await rpc.request('turn/start',{threadId:root.sessionId,input:[{type:'text',text:'生成隔离子代理后结束主轮次。'}]});
  await wait(()=>childStarted&&completed.has(turn.turn.id)&&store.peer(root.id).state==='ready');
  assert.ok(spawnResult,'原生子代理的启动结果必须进入根会话');
  await assert.rejects(broker.dispatch('codex.restart',{}),{code:'subagent_active'});assert.equal(liveProcess(runtime.pid!),true);
  releaseChild();
  await wait(async()=>{const ids=(await rpc.request('thread/loaded/list',{limit:100})).data;const children=ids.filter((value:any)=>(typeof value==='string'?value:value.id)!==root.sessionId);if(!children.length)return false;for(const value of children){const thread=(await rpc.request('thread/read',{threadId:typeof value==='string'?value:value.id,includeTurns:false})).thread;if(thread.status.type==='active')return false;}return true;});
  const children=store.peers().filter(peer=>peer.kind==='subagent'&&peer.rootPeerId===root.id);assert.ok(children.length,'实际子代理应以父链登记');
  await captureTree();const result=await broker.dispatch('codex.restart',{}) as any;assert.equal(result.restarted,true);assert.equal(result.session_id,root.sessionId);assert.equal(result.old_pid,runtime.pid);assert.notEqual(result.pid,runtime.pid);
  const proof=await treeState();t.diagnostic(JSON.stringify({preStopNativeTree:proof}));assert.deepEqual(proof.filter(identity=>identity.state!=='dead'),[],'重启必须释放原宿主的已核验后代');stoppedTree.clear();
  for(const child of children){assert.equal(store.endpoint(child.id),undefined);assert.equal(store.peer(child.id).state,'offline');}
  assert.equal(store.endpoint(root.id)?.address===address,false);assert.equal(store.pairs().length,1);
  t.diagnostic('真实 App Server 子代理处于活跃与已完成两种状态时，分别验证拒绝停止和保留原根会话恢复。');
});
