import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { readModelBody } from './model-http-fixture.js';
import { execFileSync } from 'node:child_process';
import { temporaryDirectory } from '../tests/support/temporary.js';
import { configClient } from '../hosts/codex/stdio-codex.js';
import {DEFAULT_CONFIG} from '../config/defaults.js';
import {delay} from '../shared/time.js';
import {resolveCli} from '../process/host-command.js';
import { startOwnedCodex } from '../hosts/owned-launch-policy.js';
import { readSessionProfile } from '../hosts/codex/codex-session-profile.js';
import { CodexModelRequests } from '../hosts/codex/codex-model-request.js';
import type { RpcClient } from '../ipc/rpc.js';
import { persistedCodexPermission, classifyCodexPermission } from '../hosts/codex/codex-permission.js';
import { TurnHealthTracker } from '../broker/health/turn-health.js';
import { codexProcessIdentity } from '../process/process.js';

test('原生 Codex 自动审核执行、持久权限、工具暴露与 HTTP 故障证据',{timeout:150000},async t=>{
  const temp=temporaryDirectory(),root=temp.directory,home=path.join(root,'codex'),bridge=path.join(root,'bridge'),script=path.join(root,'mcp.mjs'),mcpPid=path.join(root,'mcp.pid');mkdirSync(home);
  writeFileSync(script,`import{createInterface}from'node:readline';import{writeFileSync}from'node:fs';writeFileSync(${JSON.stringify(mcpPid)},String(process.pid));const out=x=>console.log(JSON.stringify({jsonrpc:'2.0',...x}));createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);if(m.id===undefined)return;out({id:m.id,result:m.method==='initialize'?{protocolVersion:m.params.protocolVersion,capabilities:{tools:{}},serverInfo:{name:'capability',version:'1'}}:m.method==='tools/list'?{tools:['status','config'].map(name=>({name,description:name,inputSchema:{type:'object',properties:{}},_meta:{defer_loading:name==='config'}}))}:{}});});`,'utf8');
  let phase='tools',rpc:RpcClient|undefined;const requests:{phase:string;body:any}[]=[],events:any[]=[],approvals:string[]=[],errors:string[]=[];
  const model=http.createServer(async(req,res)=>{try{
    const raw=await readModelBody(req);
    if(!req.url?.includes('/responses')){res.end('{"data":[]}');return;}
    const body=JSON.parse(raw.toString());requests.push({phase,body});
    if(phase==='provider'){res.writeHead(503);res.end('{"error":{"message":"isolated provider failure"}}');return;}
    const format=body.text?.format??body.response_format;let text='LOCAL_DONE',item:any;
    if(format){const schema=format.schema??format.json_schema?.schema??{},output:Record<string,unknown>={};for(const [key,spec]of Object.entries<any>(schema.properties??{}))output[key]=spec.enum?.[0]??(spec.type==='number'?0:spec.type==='boolean'?true:key.includes('risk')?'low':key.includes('decision')?'allow':'LOCAL_REVIEW');text=JSON.stringify(output);}
    if(phase==='auto'&&!format&&!JSON.stringify(body.input).includes('autonomy-exec'))item={type:'function_call',id:'fc-autonomy',call_id:'autonomy-exec',name:'exec_command',arguments:JSON.stringify({cmd:process.platform==='win32'?"Write-Output 'LOCAL_ACTION_DONE'":"printf LOCAL_ACTION_DONE",sandbox_permissions:'require_escalated',justification:'隔离本地自动审核验收'})};
    else item={type:'message',id:'msg-'+requests.length,role:'assistant',status:'completed',content:[{type:'output_text',text}]};
    const id='native-'+requests.length;res.writeHead(200,{'content-type':'text/event-stream'});
    for(const event of [{type:'response.created',response:{id,status:'in_progress',output:[]}},{type:'response.output_item.added',output_index:0,item},{type:'response.output_item.done',output_index:0,item},{type:'response.completed',response:{id,status:'completed',output:[item],usage:{input_tokens:10,output_tokens:5,total_tokens:15}}}])res.write('data: '+JSON.stringify(event)+'\n\n');res.end();
  }catch(error){errors.push(String(error));res.writeHead(500);res.end();}});
  await new Promise<void>(resolve=>model.listen(0,'127.0.0.1',resolve));
  t.after(async()=>{try{await rpc?.close();await temp.cleanup();}finally{model.closeAllConnections();await new Promise<void>(resolve=>model.close(()=>resolve()));}});
  const config=`model="gpt-5.4"\nmodel_provider="local"\nweb_search="disabled"\ncheck_for_update_on_startup=false\n[features]\napps=false\nremote_plugin=false\ncode_mode=false\ntool_search=true\ntool_search_always_defer_mcp_tools=true\n[mcp_servers.claude]\ncommand=${JSON.stringify(process.execPath)}\nargs=[${JSON.stringify(script)}]\nrequired=true\n[model_providers.local]\nname="local"\nbase_url="http://127.0.0.1:${(model.address() as any).port}/v1"\nwire_api="responses"\nrequires_openai_auth=false\nrequest_max_retries=1\nstream_max_retries=0\n`;
  writeFileSync(path.join(home,'config.toml'),config,'utf8');
  const binary=process.env.NXBRIDGE_TEST_CODEX_BINARY,cli=resolveCli('codex',binary);
  const features=execFileSync(cli.command,[...cli.prefix,'--no-daemon','features','list'],{env:{...process.env,CODEX_HOME:home},encoding:'utf8',windowsHide:true,timeout:10000});
  rpc=await configClient({...DEFAULT_CONFIG,codexHome:home,...(binary?{codexBinary:binary}:{})},bridge);
  rpc.on('request',message=>approvals.push(message.method));rpc.on('notification',message=>events.push(message));
  const run=async(threadId:string,text:string,overrides:Record<string,unknown>={})=>{const start=events.length;await rpc!.request('turn/start',{threadId,input:[{type:'text',text}],...overrides},{mutation:true});const until=Date.now()+30000;while(!events.slice(start).some(e=>e.method==='turn/completed')){assert.ok(Date.now()<until,'隔离原生轮次未结束');await delay(50);}return events.slice(start);};
  let unsupportedThread='';
  const ignoredReviewer={request:async(method:string,params:any,options:any)=>{
    if(method==='thread/start'){params={...params,config:{...params.config}};delete params.approvalsReviewer;delete params.config.approvals_reviewer;}
    const result=await rpc!.request<any>(method,params,options);if(method==='thread/start'&&!unsupportedThread)unsupportedThread=result.thread.id;return result;
  }} as RpcClient;
  const tools=await startOwnedCodex(ignoredReviewer,root,'prompting');assert.equal(tools.approvalPolicy,'never');assert.equal(tools.sandbox.type,'dangerFullAccess');
  assert.notEqual(tools.thread.id,unsupportedThread);
  const loaded=await rpc.request<any>('thread/loaded/list',{});assert.ok(!loaded.data.includes(unsupportedThread),'未采用自动审核的空线程不能遗留在运行时');
  const empty=await rpc.request<any>('thread/start',{cwd:root,approvalPolicy:'on-request',sandbox:'workspace-write'},{mutation:true});
  await rpc.request('thread/delete',{threadId:empty.thread.id},{mutation:true});
  assert.ok(!(await rpc.request<any>('thread/loaded/list',{})).data.includes(empty.thread.id),'本次未使用空线程删除后应卸载');
  await run(tools.thread.id,'LOCAL_TOOL_EXPOSURE');
                                         
  let healthNow=Date.now();const health=new TurnHealthTracker(()=>healthNow);
  for(const event of events)health.observe('native',event);
  const idle=(await rpc.request<any>('thread/read',{threadId:tools.thread.id,includeTurns:true})).thread;
  assert.equal(idle.status.type,'idle');assert.equal(health.read('native',idle)?.state,'ready');
  healthNow+=11*60*60*1000;assert.equal(health.get('native',tools.thread.id)?.state,'ready');
  const exposed=JSON.stringify(requests.find(request=>request.phase==='tools')!.body.tools);
  assert.match(exposed,/status/);assert.match(exposed,/config/);
  t.diagnostic(JSON.stringify({searchFeatures:features.split(/\r?\n/).filter(line=>/tool_search|code_mode/.test(line)),perToolMetadataDeferred:/"defer_loading":true/.test(exposed),startupSearchFlags:true,tools:requests.find(request=>request.phase==='tools')!.body.tools.map((tool:any)=>({name:tool.name,type:tool.type,defer_loading:tool.defer_loading,tools:tool.tools?.map((item:any)=>item.name)})),effectiveFeatures:(await rpc.request<any>('config/read',{includeLayers:false,cwd:root})).config.features}));
  phase='auto';const value=await startOwnedCodex(rpc,root,'prompting'),completed=await run(value.thread.id,'执行本地自动审核验收');
  assert.equal(value.approvalsReviewer,'auto_review');assert.equal(approvals.length,0);
  assert.ok(completed.some(e=>e.method==='item/completed'&&e.params?.item?.type==='commandExecution'&&String(e.params.item.aggregatedOutput).includes('LOCAL_ACTION_DONE')),'真实工具没有执行完成');
  const profile=await readSessionProfile(value.thread.path,value.thread.id);assert.equal(profile.settings.approvalsReviewer,'auto_review');
  const resumed=await rpc.request<any>('thread/resume',{threadId:value.thread.id},{mutation:true});assert.equal(resumed.approvalsReviewer,'auto_review');assert.equal(resumed.approvalPolicy,'on-request');
  phase='permissions';await run(value.thread.id,'LOCAL_AUTO_TO_FULL',{approvalPolicy:'never',sandboxPolicy:{type:'dangerFullAccess'}});
  assert.equal(classifyCodexPermission((await persistedCodexPermission(value.thread.path,value.thread.id))!),'bypass','有效完整访问优先于残留自动审核设置');
  phase='permissions';const changed=await rpc.request<any>('thread/start',{cwd:root,approvalPolicy:'on-request',sandbox:'workspace-write',approvalsReviewer:'user'},{mutation:true});
  await run(changed.thread.id,'LOCAL_PERMISSION_BEFORE');assert.equal(classifyCodexPermission((await persistedCodexPermission(changed.thread.path,changed.thread.id))!),'prompting');
  await run(changed.thread.id,'LOCAL_PERMISSION_AFTER',{approvalPolicy:'never',sandboxPolicy:{type:'dangerFullAccess'}});
  const changedEvidence=(await persistedCodexPermission(changed.thread.path,changed.thread.id))!;assert.equal(classifyCodexPermission(changedEvidence),'bypass');assert.equal(changedEvidence.autoReview,false);
  phase='provider';const failed=await run(value.thread.id,'LOCAL_PROVIDER_FAILURE'),turn=failed.find(e=>e.method==='turn/completed')!.params.turn.id;
                                          
  const native=await codexProcessIdentity(10000,Number(readFileSync(mcpPid,'utf8')));
  let evidence;const until=Date.now()+15000;while(!(evidence=new CodexModelRequests().read(home,value.thread.id,turn,native.pid))){assert.ok(Date.now()<until,'未读到实际 HTTP 故障日志');await delay(200);}
  assert.equal(evidence.statusCode,503);assert.equal(evidence.source,'native-log');assert.doesNotMatch(JSON.stringify(evidence),/127\.0\.0\.1|isolated provider/);
  assert.equal(readFileSync(path.join(home,'config.toml'),'utf8'),config);assert.deepEqual(errors,[]);
  t.diagnostic(JSON.stringify({autoReviewer:value.approvalsReviewer,nativeApprovals:approvals.length,actionExecuted:true,resumeBaselineKept:true,nativePermissionChange:changedEvidence,provider:evidence.statusCode,idleNativeSnapshot:true,idleElevenHoursReady:true,userConfigUnchanged:true,realModelCalls:0}));
});
