import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net, { type AddressInfo } from 'node:net';
import path from 'node:path';
import { mkdirSync } from 'node:fs';
import { temporaryDirectory } from '../tests/support/temporary.js';
import {spawnCli} from '../process/host-command.js';
import {delay} from '../shared/time.js';
import {DEFAULT_CONFIG} from '../config/defaults.js';
import { connectAppServer } from '../hosts/codex/adapter.js';
import { TurnHealthTracker } from '../broker/health/turn-health.js';
import type { RpcMessage } from '../ipc/rpc.js';

test('原生重连信号区分内部 HTTP 重试、外层 SSE 重连和最终失败',async t=>{
  const temporary=temporaryDirectory(),directory=temporary.directory,codex=path.join(directory,'codex');mkdirSync(codex);
  let rpc:Awaited<ReturnType<typeof connectAppServer>>|undefined,child:ReturnType<typeof spawnCli>|undefined,requests=0;
  const model=http.createServer((req,res)=>{if(req.url?.includes('/responses'))requests++;req.resume();res.writeHead(503,{'content-type':'application/json'});res.end(JSON.stringify({error:{message:'隔离网络重试探针',type:'server_error'}}));});
  await new Promise<void>(resolve=>model.listen(0,'127.0.0.1',resolve));
  const reserve=net.createServer();await new Promise<void>(resolve=>reserve.listen(0,'127.0.0.1',resolve));const port=(reserve.address() as AddressInfo).port;await new Promise<void>(resolve=>reserve.close(()=>resolve()));
  const endpoint=`ws://127.0.0.1:${port}`,modelPort=(model.address() as AddressInfo).port,events:RpcMessage[]=[],health=new TurnHealthTracker();
  t.after(async()=>{rpc?.close();if(child?.exitCode===null)child.kill();model.closeAllConnections();await new Promise<void>(resolve=>model.close(()=>resolve()));await delay(300);await temporary.cleanup();});
  const option=(key:string,value:unknown)=>['-c',key+'='+JSON.stringify(value)];
  child=spawnCli('codex',['app-server','--listen',endpoint,...option('model_provider','retry_probe'),...option('model_providers.retry_probe.name','本地探针'),...option('model_providers.retry_probe.base_url',`http://127.0.0.1:${modelPort}/v1`),...option('model_providers.retry_probe.wire_api','responses'),...option('model_providers.retry_probe.requires_openai_auth',false),...option('model_providers.retry_probe.request_max_retries',2),...option('model_providers.retry_probe.stream_max_retries',1)],{env:{...process.env,CODEX_HOME:codex,NXBRIDGE_HOME:path.join(directory,'bridge'),RUST_LOG:'error'},stdio:['ignore','ignore','pipe']},DEFAULT_CONFIG);
  child.stderr!.on('data',()=>{});
  for(let i=0;i<50;i++){try{rpc=await connectAppServer(endpoint,DEFAULT_CONFIG);break;}catch{await delay(100);}}
  assert.ok(rpc,'隔离 App Server 未就绪');
  const retryStates:string[]=[];
  rpc.on('notification',(event:RpcMessage)=>{health.observe(endpoint,event);if(event.method==='error'){events.push(event);retryStates.push(health.get(endpoint,event.params.threadId)!.state);}if(event.method==='turn/completed')events.push(event);});
  const {thread}=await rpc.request('thread/start',{cwd:directory,model:'gpt-5.1-codex',approvalPolicy:'never',sandbox:'read-only'});
  await rpc.request('turn/start',{threadId:thread.id,input:[{type:'text',text:'隔离重试探针',text_elements:[]}]},{mutation:true});
  const end=Date.now()+25000;while(Date.now()<end&&!events.some(e=>e.method==='turn/completed'))await delay(50);
  assert.equal(requests,6);assert.ok(events.some(e=>e.method==='error'&&e.params.willRetry===true));
  assert.ok(retryStates.includes('networkRetrying'));assert.equal(health.get(endpoint,thread.id)?.state,'failed');
  assert.ok(events.some(e=>e.method==='turn/completed'&&e.params.turn.status==='failed'));t.diagnostic('本地 503 共 6 次请求；真实模型调用 0。');
});
