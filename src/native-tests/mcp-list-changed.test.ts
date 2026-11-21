import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { readModelBody } from './model-http-fixture.js';
import { stringify } from 'smol-toml';
import { temporaryDirectory } from '../tests/support/temporary.js';
import {ensureHome,socketDirectory} from '../ipc/home.js';
import {delay} from '../shared/time.js';
import { selectHostLaunch, spawnSelectedHost } from '../hosts/host-launch.js';
import {DEFAULT_CONFIG} from '../config/defaults.js';
import { rememberOwnedHost, releaseRecordedProcesses } from '../process/owned-processes.js';
import { connectAppServer } from '../hosts/codex/adapter.js';
import { randomUUID } from 'node:crypto';

test('原生 MCP 工具清单刷新探针：实际记录 list_changed 与显式 reload 后模型看到的清单',{timeout:60000},async t=>{
  const temp=temporaryDirectory(),root=temp.directory,home=path.join(root,'bridge'),configHome=path.join(root,'codex'),signal=path.join(root,'change'),events=path.join(root,'mcp-events');await ensureHome(home);mkdirSync(configHome);
  const script=path.join(root,'dynamic.mjs');writeFileSync(script,`import{createInterface}from'node:readline';import{existsSync,appendFileSync}from'node:fs';let changed=false;const out=x=>console.log(JSON.stringify({jsonrpc:'2.0',...x}));setInterval(()=>{if(!changed&&existsSync(${JSON.stringify(signal)})){changed=true;appendFileSync(${JSON.stringify(events)},'notification\\n');out({method:'notifications/tools/list_changed'});}},50).unref();createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);if(m.id===undefined)return;appendFileSync(${JSON.stringify(events)},m.method+'\\n');const result=m.method==='initialize'?{protocolVersion:m.params.protocolVersion,capabilities:{tools:{listChanged:true}},serverInfo:{name:'dynamic',version:'1'}}:m.method==='tools/list'?{tools:[{name:'original_probe',description:'原工具',inputSchema:{type:'object',properties:{}}},...(changed?[{name:'new_probe',description:'更新后工具',inputSchema:{type:'object',properties:{}}}]:[])]}:{};out({id:m.id,result});});`,'utf8');
  const requests:any[]=[],errors:string[]=[],model=http.createServer(async(req,res)=>{try{const raw=await readModelBody(req);if(!req.url?.includes('/responses')){res.end('{"data":[]}');return;}const body=JSON.parse(raw.toString());requests.push(body);const id='probe-'+requests.length,item={type:'message',id:'msg-'+requests.length,role:'assistant',status:'completed',content:[{type:'output_text',text:'原生工具清单探针完成'}]};res.writeHead(200,{'content-type':'text/event-stream'});for(const event of [{type:'response.created',response:{id,status:'in_progress',output:[]}},{type:'response.output_item.added',output_index:0,item},{type:'response.output_item.done',output_index:0,item},{type:'response.completed',response:{id,status:'completed',output:[item],usage:{input_tokens:10,output_tokens:5,total_tokens:15}}}])res.write('data: '+JSON.stringify(event)+'\n\n');res.end();}catch(error){errors.push(String(error));res.writeHead(500);res.end();}});
  await new Promise<void>(resolve=>model.listen(0,'127.0.0.1',resolve));let client:Awaited<ReturnType<typeof connectAppServer>>|undefined;const launchId=randomUUID();
  t.after(async()=>{client?.close();model.closeAllConnections();await new Promise<void>(resolve=>model.close(()=>resolve()));try{assert.deepEqual(await releaseRecordedProcesses(home,r=>r.proof.launchId===launchId),[]);}finally{await temp.cleanup();}});
  writeFileSync(path.join(configHome,'config.toml'),stringify({model:'gpt-5.1-codex',model_provider:'probe',approval_policy:'never',sandbox_mode:'read-only',check_for_update_on_startup:false,features:{apps:false,remote_plugin:false,code_mode:false},mcp_servers:{dynamic:{command:process.execPath,args:[script],required:true}},model_providers:{probe:{name:'本地无费用探针',base_url:`http://127.0.0.1:${(model.address() as any).port}/v1`,wire_api:'responses',requires_openai_auth:false}}}),'utf8');
  const config={...DEFAULT_CONFIG,codexHome:configHome,...(process.env.NXBRIDGE_TEST_CODEX_BINARY?{codexBinary:process.env.NXBRIDGE_TEST_CODEX_BINARY}:{})},launch=selectHostLaunch('codex',config,{home,cwd:root}),address='unix://'+path.join(await socketDirectory(home),'mcp-probe.sock'),child=spawnSelectedHost(launch,['--no-daemon','app-server','--listen',address],{stdio:'ignore'});await rememberOwnedHost(home,child,'codex','codex-runtime',launchId,configHome);
  const wait=async(check:()=>boolean|Promise<boolean>,reason:string)=>{const end=Date.now()+15000;while(!await check()){assert.ok(Date.now()<end,reason+' '+errors.join(';'));await delay(50);}};
  await wait(async()=>{try{client=await connectAppServer(address,config,undefined,home,{readOnly:true});return true;}catch{return false;}},'专用后台未就绪');let completed=0;client!.on('notification',event=>{if(event.method==='turn/completed')completed++;});
  const {thread}=await client!.request('thread/start',{cwd:root,approvalPolicy:'never',sandbox:'read-only'}),turn=async()=>{const before=completed;await client!.request('turn/start',{threadId:thread.id,input:[{type:'text',text:'只输出探针完成，不调用任何工具'}]},{mutation:true});await wait(()=>completed>before,'原生轮次未结束');};
  await turn();assert.match(JSON.stringify(requests[0]!.tools),/original_probe/);writeFileSync(signal,'changed','utf8');await wait(()=>readFileSync(events,'utf8').includes('notification'),'MCP 通知未发出');await delay(1000);await turn();
  const notified=JSON.stringify(requests.at(-1).tools).includes('new_probe');let reloadSupported=false,reloaded=false;
  if(!notified)try{await client!.request('config/mcpServer/reload',{}, {timeout:3000});reloadSupported=true;await delay(500);await turn();reloaded=JSON.stringify(requests.at(-1).tools).includes('new_probe');}catch{}
  assert.equal(errors.length,0);t.diagnostic(JSON.stringify({listChangedRefreshesModelTools:notified,reloadSupported,reloadRefreshesModelTools:reloaded,mcpEvents:readFileSync(events,'utf8').trim().split('\n'),realModelCalls:0}));
});
