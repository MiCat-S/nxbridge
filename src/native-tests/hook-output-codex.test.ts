import { overrideEnvironment } from '../tests/support/environment.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net, { type AddressInfo } from 'node:net';
import path from 'node:path';
import { mkdirSync, writeFileSync } from 'node:fs';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { temporaryDirectory } from '../tests/support/temporary.js';
import { releaseNativeTestLaunches } from '../tests/support/native-launch.js';
import { FakeAdapter } from '../tests/support/fake-adapter.js';
import { registration } from '../tests/support/registration.js';
import { preparePlugins } from '../install/setup.js';
import {DEFAULT_CONFIG} from '../config/defaults.js';
import { VERSION } from '../version.js';
import {spawnCli,runCli} from '../process/host-command.js';
import {delay} from '../shared/time.js';
import {PACKAGE_ROOT} from '../shared/package-location.js';
import { rememberOwnedHost } from '../process/owned-processes.js';
import { connectAppServer } from '../hosts/codex/adapter.js';
import { Store } from '../storage/store.js';
import { Broker } from '../broker/coordinator.js';
import { hookGuardTimeout } from '../integration/hooks/hook-output.js';
import { brokerCall } from '../ipc/ipc.js';
import { stringify } from 'smol-toml';

test('原生 Codex 接受保护器 systemMessage，完成告警保留超时证据并提供数字耗时',{timeout:90000},async t=>{
  const temp=temporaryDirectory(),root=temp.directory,home=path.join(root,'bridge'),codexhome=path.join(root,'codex');for(const dir of [home,codexhome])mkdirSync(dir,{recursive:true});
  const env={NXBRIDGE_HOME:home,CODEX_HOME:codexhome,CLAUDE_CONFIG_DIR:path.join(root,'claude')},restoreEnvironment=overrideEnvironment(env);
  const config={...DEFAULT_CONFIG,codexHome:codexhome,...(process.env.NXBRIDGE_TEST_CODEX_BINARY?{codexBinary:process.env.NXBRIDGE_TEST_CODEX_BINARY}:{})},events:any[]=[];
  writeFileSync(path.join(codexhome,'config.toml'),stringify({projects:{[root]:{trust_level:'trusted'}},features:{hooks:true}}),'utf8');
  let modelCalls=0;const model=http.createServer(async(req,res)=>{
    for await(const _ of req){}modelCalls++;const item={type:'message',id:'guard-final',role:'assistant',status:'completed',content:[{type:'output_text',text:'本地保护器验收完成'}]};
    res.writeHead(200,{'content-type':'text/event-stream'});for(const value of [{type:'response.created',response:{id:'guard-response',status:'in_progress',output:[]}},{type:'response.output_item.added',output_index:0,item},{type:'response.output_item.done',output_index:0,item},{type:'response.completed',response:{id:'guard-response',status:'completed',output:[item],usage:{input_tokens:1,output_tokens:1,total_tokens:2}}}])res.write('data: '+JSON.stringify(value)+'\n\n');res.end();
  });await new Promise<void>(resolve=>model.listen(0,'127.0.0.1',resolve));
  let rpc:Awaited<ReturnType<typeof connectAppServer>>|undefined,child:ReturnType<typeof spawnCli>|undefined;
  t.after(async()=>{await rpc?.close();assert.deepEqual(await releaseNativeTestLaunches(home),[]);if(child&&child.exitCode===null&&child.signalCode===null)await once(child,'exit');try{await brokerCall('shutdown',{releaseOwned:false},{home,start:false});}catch{}model.closeAllConnections();await new Promise<void>(resolve=>model.close(()=>resolve()));restoreEnvironment();await temp.cleanup();});
  const marketplace=await preparePlugins(home,{packageRoot:path.join(PACKAGE_ROOT,'publish')});await runCli('codex',['plugin','marketplace','add',marketplace,'--json'],{config});await runCli('codex',['plugin','add','nxbridge@nxbridge-local','--json'],{config});
                                           
  const fixture=path.join(root,'marker.cjs');writeFileSync(fixture,"process.stdin.resume();process.stdin.on('end',()=>console.log(JSON.stringify({systemMessage:'nxbridge hook timed out after 10s; result unconfirmed'})));",'utf8');
  const command='node "'+fixture.replaceAll('\\','/')+'"',hooks=Object.fromEntries(['SessionStart','UserPromptSubmit','Stop'].map(event=>[event,[{hooks:[{type:'command',command,timeout:10}]}]]));
  writeFileSync(path.join(codexhome,'plugins','cache','nxbridge-local','nxbridge',VERSION,'hooks','hooks.json'),JSON.stringify({hooks}),'utf8');
  const reserve=net.createServer();await new Promise<void>(resolve=>reserve.listen(0,'127.0.0.1',resolve));const port=(reserve.address() as AddressInfo).port;await new Promise<void>(resolve=>reserve.close(()=>resolve()));
  const address=`ws://127.0.0.1:${port}`,option=(key:string,value:unknown)=>['-c',key+'='+JSON.stringify(value)];
  child=spawnCli('codex',['--no-daemon','--dangerously-bypass-hook-trust','app-server','--listen',address,...option('features.hooks',true),...option('features.apps',false),...option('model_provider','hook_probe'),...option('model_providers.hook_probe.name','本地 hook 验收'),...option('model_providers.hook_probe.base_url',`http://127.0.0.1:${(model.address() as AddressInfo).port}/v1`),...option('model_providers.hook_probe.wire_api','responses'),...option('model_providers.hook_probe.requires_openai_auth',false)],{cwd:root,stdio:['ignore','ignore','pipe']},config);
  let stderr='';child.stderr!.on('data',value=>stderr+=value.toString());await rememberOwnedHost(home,child,'codex','codex-runtime',randomUUID(),codexhome);
  for(let index=0;index<80;index++){try{rpc=await connectAppServer(address,config);break;}catch{await delay(100);}}assert.ok(rpc,stderr);
  const listed=await rpc.request('hooks/list',{cwds:[root]});t.diagnostic(JSON.stringify({hooks:listed}));
  rpc.on('notification',event=>events.push(event));const {thread}=await rpc.request('thread/start',{cwd:root,model:'gpt-5.1-codex',approvalPolicy:'never',sandbox:'read-only',config:{bypass_hook_trust:true}});
  await rpc.request('turn/start',{threadId:thread.id,input:[{type:'text',text:'仅使用本地假模型验证 hook'}]},{mutation:true});
  const until=Date.now()+20000;while(!events.some(event=>event.method==='turn/completed')){assert.ok(Date.now()<until,stderr+'\n'+JSON.stringify(events));await delay(20);}
  const completed=events.filter(event=>event.method==='hook/completed').map(event=>event.params.run);assert.ok(completed.length>=2,JSON.stringify({methods:events.map(event=>event.method),stderr}));
  for(const run of completed){assert.equal(run.status,'completed',JSON.stringify(run));assert.equal(hookGuardTimeout(run.entries),'nxbridge hook timed out after 10s; result unconfirmed');assert.equal(typeof run.durationMs,'number');}
  const store=new Store(':memory:'),codex=new FakeAdapter(),broker=new Broker(store,config,{codex,claude:new FakeAdapter()} as any,home);t.after(async()=>{await broker.stop();store.close();});
  const peer=store.register(registration('codex',thread.id,{cwd:root,endpoint:{mode:'app-server',address,epoch:'native-hook-evidence',pid:null,procStart:null}}));
  for(const event of events.filter(event=>event.method==='hook/completed'))codex.emit('native',{address,message:event});
  assert.equal(broker.pairAnomalies.evidence(peer).hookTimeouts?.count,completed.length);assert.ok((broker.status() as any).capabilities.hookTimings[0].events.every((event:any)=>typeof event.lastMs==='number'));
  t.diagnostic(JSON.stringify({version:(await runCli('codex',['--version'],{config})).trim(),runs:completed.map(run=>({event:run.eventName,durationMs:run.durationMs,status:run.status})),fakeModelCalls:modelCalls,realModelCalls:0}));
});
