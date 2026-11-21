import { overrideEnvironment } from '../tests/support/environment.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify, stripVTControlCharacters } from 'node:util';
import { readModelBody } from './model-http-fixture.js';
import { stringify } from 'smol-toml';
import {DEFAULT_CONFIG} from '../config/defaults.js';
import {PACKAGE_ROOT} from '../shared/package-location.js';
import {delay} from '../shared/time.js';
import {loadConfig} from '../config/load.js';
import {resolveCli} from '../process/host-command.js';
import { brokerCall } from '../ipc/ipc.js';
import { configClient } from '../hosts/codex/stdio-codex.js';
import { connectAppServer } from '../hosts/codex/adapter.js';
import { managedRuntimes } from '../hosts/managed-runtimes.js';
import { processIdentity } from '../process/process.js';
import { verifyPublish } from '../install/runtime-install.js';
import { temporaryDirectory } from '../tests/support/temporary.js';
import { publishEnvironment } from './publish-fixture.js';
import { NativeTerminal } from './terminal-fixture.js';

const execute=promisify(execFile),previousPublish=process.env.NXBRIDGE_TEST_PREVIOUS_PUBLISH,foreground=process.env.NXBRIDGE_TEST_CODEX_FOREGROUND==='1';

test('实际旧版 Codex 原线程升级后 MCP 连续，hooks 原生重审后同线程恢复',{skip:!previousPublish||foreground&&process.platform!=='win32',timeout:170000},async t=>{
  const temp=temporaryDirectory(),root=temp.directory,home=path.join(root,'bridge'),codexhome=path.join(root,'codex'),claudehome=path.join(root,'claude'),bin=path.join(root,'bin'),old=path.join(root,'old');
  for(const directory of [home,codexhome,claudehome,bin,old])mkdirSync(directory,{recursive:true});
  const manifest=verifyPublish(previousPublish!);assert.equal(manifest.version,'0.1.0');
  for(const relative of [...Object.keys(manifest.files),'publish.json']){const target=path.join(old,relative);mkdirSync(path.dirname(target),{recursive:true});cpSync(path.join(previousPublish!,relative),target);}
  const overrides={NXBRIDGE_HOME:home,CODEX_HOME:codexhome,CLAUDE_CONFIG_DIR:claudehome,OPENAI_API_KEY:'local-upgrade-only'},restoreEnvironment=overrideEnvironment(overrides);
  const requests:any[]=[],errors:string[]=[],hookRuns:any[]=[],completed=new Set<string>();let phase=0,passed=false,hold=false,busyEntered:(()=>void)|undefined,busyRelease:(()=>void)|undefined,client:Awaited<ReturnType<typeof connectAppServer>>|undefined,terminal:NativeTerminal|undefined;
  let busyGate:Promise<void>|undefined;
  const model=http.createServer(async(req,res)=>{try{
    const raw=await readModelBody(req);
    if(!req.url?.includes('/responses')){res.writeHead(200,{'content-type':'application/json'});res.end('{"data":[]}');return;}
    const body=JSON.parse(raw.toString('utf8'));requests.push(body);if(hold){hold=false;busyEntered?.();await busyGate;}const id='retained-status-'+phase,done=(body.input??[]).some((value:any)=>value.type==='function_call_output'&&value.call_id===id);
    let spec:any;for(const tool of body.tools??[]){if(tool.type==='namespace'&&tool.name==='claude'){const inner=tool.tools.find((value:any)=>value.name==='status');if(inner)spec={...inner,namespace:tool.name};}else if(tool.type!=='namespace'&&/^(?:status|(?:mcp__)?claude(?:__|[._])status)$/.test(tool.name))spec=tool;}
    const item=done||!spec?{type:'message',id:'done-'+phase,role:'assistant',status:'completed',content:[{type:'output_text',text:'RETAINED_CODEX_DONE_'+phase}]}:{type:'function_call',id,call_id:id,name:spec.name,...(spec.namespace?{namespace:spec.namespace}:{}),arguments:'{}'};
    res.writeHead(200,{'content-type':'text/event-stream'});for(const event of [{type:'response.created',response:{id:'response-'+requests.length,status:'in_progress',output:[]}},{type:'response.output_item.added',output_index:0,item},{type:'response.output_item.done',output_index:0,item},{type:'response.completed',response:{id:'response-'+requests.length,status:'completed',output:[item],usage:{input_tokens:1,output_tokens:1,total_tokens:2}}}])res.write('event: '+event.type+'\ndata: '+JSON.stringify(event)+'\n\n');res.end();
  }catch(error){errors.push(String(error));res.writeHead(500);res.end(String(error));}});
  await new Promise<void>(resolve=>model.listen(0,'127.0.0.1',resolve));
  t.after(async()=>{try{if(!passed){let status,events;try{status=await brokerCall('status',{}, {home,start:false});events=await brokerCall('events',{}, {home,start:false});}catch{}t.diagnostic(JSON.stringify({phase,foreground,status,events,hookRuns,lastInputs:requests.at(-1)?.input?.slice(-6),terminal:stripVTControlCharacters(terminal?.output??'').slice(-3500),brokerLog:existsSync(path.join(home,'run','broker.log'))?readFileSync(path.join(home,'run','broker.log'),'utf8').slice(-3000):undefined}));}client?.close();await terminal?.close();await temp.cleanup();}finally{model.closeAllConnections();await new Promise<void>(resolve=>model.close(()=>resolve()));restoreEnvironment();}});
  const nativeCli=resolveCli('codex');
  writeFileSync(path.join(home,'config.json'),JSON.stringify({...DEFAULT_CONFIG,codexHome:codexhome,claudeHome:claudehome,codexCommand:[nativeCli.command,...nativeCli.prefix],implicit:'never'}),'utf8');
  writeFileSync(path.join(codexhome,'config.toml'),stringify({model:'gpt-5.1-codex',model_provider:'upgrade_local',web_search:'disabled',approval_policy:'never',sandbox_mode:'read-only',suppress_unstable_features_warning:true,check_for_update_on_startup:false,projects:{[root]:{trust_level:'trusted'}},features:{hooks:true,apps:false,remote_plugin:false,code_mode:false},model_providers:{upgrade_local:{name:'本地升级连续性验收',base_url:`http://127.0.0.1:${(model.address() as any).port}/v1`,wire_api:'responses',requires_openai_auth:false}}}),'utf8');
  const env=publishEnvironment(home,bin),run=async(entry:string,args:string[])=>JSON.parse((await execute(process.execPath,[entry,...args],{env,windowsHide:true,timeout:75000,maxBuffer:8*1024*1024})).stdout);
  await run(path.join(old,'nxbridge.mjs'),['setup','--bin-dir',bin]);
  const control=await configClient(loadConfig(home),home);try{const hooks=(await control.request('hooks/list',{cwds:[root]})).data.flatMap((value:any)=>value.hooks??[]).filter((value:any)=>value.pluginId==='nxbridge@nxbridge-local');assert.equal(hooks.length,9);await control.request('config/batchWrite',{edits:[{keyPath:'hooks.state',value:Object.fromEntries(hooks.map((hook:any)=>[hook.key,{enabled:true,trusted_hash:hook.currentHash}])),mergeStrategy:'replace'}],filePath:path.join(codexhome,'config.toml')},{mutation:true});}finally{control.close();}
  let identity,thread:{id:string}|undefined;
  if(foreground){const cli=resolveCli('codex');terminal=await NativeTerminal.start(root,home,cli.command,[...cli.prefix,'--no-daemon','--no-alt-screen'],root,{...env,TERM:'xterm-256color',COLORTERM:'truecolor'});identity=terminal.identity;}
  else{const {endpoint}=await brokerCall<{endpoint:string}>('codex.endpoint',{}, {home});client=await connectAppServer(endpoint,loadConfig(home),undefined,home);client.on('notification',message=>{if(message.method==='turn/completed')completed.add(message.params.turn.id);if(message.method==='hook/completed')hookRuns.push({phase,...message.params.run});});const record=managedRuntimes(home).find(({value})=>value.pid)?.value;assert.ok(record?.pid&&record.procStart,'未取得旧版自有 App Server 的原生进程证据：'+JSON.stringify(managedRuntimes(home)));identity=await processIdentity(record.pid);thread=(await client.request('thread/start',{cwd:root,approvalPolicy:'never',sandbox:'read-only'})).thread;}
  const turn=async()=>{const first=requests.length,text='在原线程检查搭档状态 '+phase;if(terminal){const offset=terminal.output.length;await terminal.prompt(text);await terminal.wait(()=>{const output=stripVTControlCharacters(terminal!.output.slice(offset)),marker='RETAINED_CODEX_DONE_'+phase,end=output.indexOf(marker);return end!==-1&&output.slice(end+marker.length).includes('Worked for');},'旧版原生前台轮次未完成',25000);assert.doesNotMatch(stripVTControlCharacters(terminal.output.slice(offset)),/Cannot find module.*bridge|ENOENT.*bridge/);}else{const result=await client!.request('turn/start',{threadId:thread!.id,input:[{type:'text',text}]});const end=Date.now()+25000;while(!completed.has(result.turn.id)){assert.ok(Date.now()<end,'原生轮次未完成：'+JSON.stringify(requests.slice(first).map(body=>body.input?.slice(-4))));await delay(50);}}const output=requests.slice(first).flatMap(body=>body.input??[]).find((value:any)=>value.type==='function_call_output'&&value.call_id==='retained-status-'+phase);assert.ok(output,'原线程未调用原生 MCP');assert.match(JSON.stringify(output.output),/paired/);assert.doesNotMatch(JSON.stringify(requests.slice(first)),/Cannot find module.*bridge|ENOENT.*bridge/);};
  await turn();
  const before=await brokerCall('status',{}, {home}),member=before.peers.find((peer:any)=>peer.host==='codex'&&(!thread||peer.sessionId===thread.id));assert.ok(member);thread??={id:member.sessionId};
  let busyTurn:string|undefined;
  if(client){
    const entered=new Promise<void>(resolve=>busyEntered=resolve);busyGate=new Promise<void>(resolve=>busyRelease=resolve);hold=true;
    busyTurn=(await client.request('turn/start',{threadId:thread!.id,input:[{type:'text',text:'这一轮跨越升级，完成时仍需执行原来的 hook'}]})).turn.id;
    await entered;
  }
  let updated:any;
  try{updated=await run(path.join(PACKAGE_ROOT,'publish','nxbridge.mjs'),['update','--from',path.join(PACKAGE_ROOT,'publish'),'--bin-dir',bin]);}finally{busyRelease?.();}
  assert.equal(updated.installed,true);
  if(busyTurn){
    const end=Date.now()+25000;while(!completed.has(busyTurn)){assert.ok(Date.now()<end,'跨升级的原生轮次没有完成');await delay(50);}
    const runs=hookRuns.filter(run=>run.phase===0&&run.source==='plugin');
    assert.ok(runs.some(run=>run.eventName==='stop'),'跨升级的忙碌轮次未报告 Stop hook');
    for(const run of runs){assert.ok(existsSync(run.sourcePath),'忙碌原线程仍引用已删除的旧缓存：'+JSON.stringify(run));assert.equal(run.status,'completed',JSON.stringify(run));}
  }
  assert.equal((await processIdentity(identity.pid)).startedAt,identity.startedAt);phase++;await turn();
  if(!foreground){
    const initial=hookRuns.filter(run=>run.phase===0&&run.source==='plugin'),changed=hookRuns.filter(run=>run.phase===1&&run.source==='plugin');
    assert.ok(initial.some(run=>run.eventName==='userPromptSubmit'));assert.ok(initial.every(run=>run.status==='completed'),JSON.stringify(initial));
    assert.ok(changed.some(run=>run.eventName==='userPromptSubmit'));
    for(const run of changed){assert.ok(existsSync(run.sourcePath),'原线程 hook 指向已删除的缓存：'+JSON.stringify(run));assert.equal(run.status,'failed',JSON.stringify(run));assert.ok(run.entries.some((entry:any)=>entry.kind==='error'&&entry.text==='plugin contents changed; hook approval required'),JSON.stringify(run));}
  }
  const after=await brokerCall('status',{}, {home});assert.ok(after.peers.some((peer:any)=>peer.id===member.id&&peer.sessionId===thread!.id));
  const inspector=client??await configClient(loadConfig(home),home);let hooks:any[];try{
    const list=async()=>(await inspector.request('hooks/list',{cwds:[root]})).data.flatMap((value:any)=>value.hooks??[]).filter((value:any)=>value.pluginId==='nxbridge@nxbridge-local');
    hooks=await list();assert.equal(hooks.length,9);assert.ok(hooks.every(hook=>hook.trustStatus==='modified'&&existsSync(hook.sourcePath)),JSON.stringify(hooks));
                                          
    if(terminal){const offset=terminal.output.length;await terminal.prompt('/hooks');await terminal.wait(()=>stripVTControlCharacters(terminal!.output.slice(offset)).includes('trust all'),'原生 hooks 重审界面未显示');terminal.send('t');await terminal.wait(async()=>{hooks=await list();return hooks.every(hook=>hook.trustStatus==='trusted');},'原生 hooks 批准未写入隔离配置');terminal.send('\x1b');}
    else await inspector.request('config/batchWrite',{edits:[{keyPath:'hooks.state',value:Object.fromEntries(hooks.map(hook=>[hook.key,{trusted_hash:hook.currentHash}])),mergeStrategy:'upsert'}],filePath:path.join(codexhome,'config.toml'),reloadUserConfig:true},{mutation:true});
    const observed=after.capabilities.hookObserved?.at??0;phase++;await turn();
    const resumed=await brokerCall('status',{}, {home});assert.ok(resumed.capabilities.hookObserved?.at>observed,'原线程重审后没有实际执行插件 hook');assert.equal(resumed.capabilities.hookObserved.event,'Stop');
    assert.ok(resumed.peers.some((peer:any)=>peer.id===member.id&&peer.sessionId===thread!.id));assert.equal((await processIdentity(identity.pid)).startedAt,identity.startedAt);
    if(!foreground){const runs=hookRuns.filter(run=>run.phase===2&&run.source==='plugin');assert.ok(runs.some(run=>run.eventName==='userPromptSubmit'));assert.ok(runs.every(run=>run.status==='completed'),JSON.stringify(runs));}
    hooks=await list();assert.ok(hooks.every(hook=>hook.trustStatus==='trusted'),JSON.stringify(hooks));
  }finally{if(inspector!==client)inspector.close();}
  assert.equal(hooks.length,9);for(const hook of hooks)assert.ok(hook.trustStatus!=='trusted'||existsSync(hook.sourcePath),'旧原生线程仍信任已被删除的缓存：'+JSON.stringify(hook));
  assert.equal(errors.length,0);passed=true;t.diagnostic(JSON.stringify({foreground,thread:thread.id,pid:identity.pid,generation:identity.startedAt,originalThreadMcp:true,hooks:hooks.map((hook:any)=>({trust:hook.trustStatus,pathExists:existsSync(hook.sourcePath),source:hook.sourcePath})),realModelCalls:0}));
});
