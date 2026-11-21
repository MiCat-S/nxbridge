import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net, { type AddressInfo } from 'node:net';
import path from 'node:path';
import { mkdirSync, readFileSync } from 'node:fs';
import { once } from 'node:events';
import { readModelBody } from './model-http-fixture.js';
import { temporaryDirectory } from '../tests/support/temporary.js';
import { releaseNativeTestLaunches } from '../tests/support/native-launch.js';
import { rememberOwnedHost } from '../process/owned-processes.js';
import { randomUUID } from 'node:crypto';
import {spawnCli} from '../process/host-command.js';
import {delay} from '../shared/time.js';
import {DEFAULT_CONFIG} from '../config/defaults.js';
import { connectAppServer } from '../hosts/codex/adapter.js';
import type { RpcMessage } from '../ipc/rpc.js';

test('隔离原生 Codex：流中及空闲转活动时成对注入不拆散工具事务',{timeout:120000},async t=>{
  const temp=temporaryDirectory(),directory=temp.directory,codex=path.join(directory,'codex'),home=path.join(directory,'bridge');mkdirSync(codex);
  const requests:any[]=[],events:RpcMessage[]=[],errors:string[]=[];
  let releaseStream!:()=>void,streamStarted!:()=>void;
  const started=new Promise<void>(resolve=>streamStarted=resolve),released=new Promise<void>(resolve=>releaseStream=resolve);
  const model=http.createServer(async(req,res)=>{try{
    const raw=await readModelBody(req);
    if(!req.url?.includes('/responses')){res.writeHead(200,{'content-type':'application/json'});res.end('{"data":[]}');return;}
    const body=JSON.parse(raw.toString('utf8'));requests.push(body);
    const first=requests.length===1,id='boundary-'+requests.length;
    const item=first?{type:'function_call',id:'boundary-tool-item',call_id:'boundary-tool-call',name:'boundary_probe',arguments:'{}'}:{type:'message',id:'msg-'+requests.length,role:'assistant',status:'completed',content:[{type:'output_text',text:'隔离边界完成'}]};
    const send=(event:unknown)=>res.write('data: '+JSON.stringify(event)+'\n\n');
    res.writeHead(200,{'content-type':'text/event-stream'});send({type:'response.created',response:{id,status:'in_progress',output:[]}});
    send({type:'response.output_item.added',output_index:0,item:first?{...item,arguments:''}:item});
    if(first){streamStarted();await released;if(res.destroyed)return;}
    send({type:'response.output_item.done',output_index:0,item});
    send({type:'response.completed',response:{id,status:'completed',output:[item],usage:{input_tokens:20,output_tokens:5,total_tokens:25}}});res.end();
  }catch(error){errors.push(String(error));res.writeHead(500);res.end('隔离服务失败');}});
  let rpc:Awaited<ReturnType<typeof connectAppServer>>|undefined,child:ReturnType<typeof spawnCli>|undefined;
  t.after(async()=>{
    releaseStream();rpc?.close();
    try{
      if(child){
        assert.deepEqual(await releaseNativeTestLaunches(home),[]);
        if(child.exitCode===null&&child.signalCode===null)await once(child,'exit');
      }
    }finally{
      model.closeAllConnections();await new Promise<void>(resolve=>model.close(()=>resolve()));await temp.cleanup();
    }
  });
  await new Promise<void>(resolve=>model.listen(0,'127.0.0.1',resolve));
  const reserve=net.createServer();await new Promise<void>(resolve=>reserve.listen(0,'127.0.0.1',resolve));const port=(reserve.address() as AddressInfo).port;await new Promise<void>(resolve=>reserve.close(()=>resolve()));
  const endpoint=`ws://127.0.0.1:${port}`,option=(key:string,value:unknown)=>['-c',key+'='+JSON.stringify(value)];
  child=spawnCli('codex',['app-server','--listen',endpoint,...option('model_provider','boundary_probe'),...option('model_providers.boundary_probe.name','隔离边界探针'),...option('model_providers.boundary_probe.base_url',`http://127.0.0.1:${(model.address() as AddressInfo).port}/v1`),...option('model_providers.boundary_probe.wire_api','responses'),...option('model_providers.boundary_probe.requires_openai_auth',false),...option('model_providers.boundary_probe.request_max_retries',0),...option('model_providers.boundary_probe.stream_max_retries',0)],{cwd:directory,env:{...process.env,CODEX_HOME:codex,NXBRIDGE_HOME:home,RUST_LOG:'error'},stdio:['ignore','ignore','pipe']},DEFAULT_CONFIG,home);
  child.stderr!.on('data',()=>{});
  await rememberOwnedHost(home,child,'codex','codex-runtime',randomUUID(),codex);
  const wait=async(check:()=>boolean,reason:string)=>{const until=Date.now()+20000;while(!check()){assert.ok(Date.now()<until,reason+'；'+errors.join(';'));await delay(20);}};
  for(let i=0;i<80;i++){try{rpc=await connectAppServer(endpoint,DEFAULT_CONFIG);break;}catch{await delay(100);}}assert.ok(rpc,'隔离 App Server 未就绪');
  rpc.on('notification',(event:RpcMessage)=>events.push(event));
  const {thread}=await rpc.request('thread/start',{cwd:directory,model:'gpt-5.1-codex',approvalPolicy:'never',sandbox:'read-only',dynamicTools:[{type:'function',name:'boundary_probe',description:'隔离边界工具',inputSchema:{type:'object',properties:{},additionalProperties:false}}]});
                                         
  let toolRequest:RpcMessage|undefined;rpc.on('request',(event:RpcMessage)=>{if(event.method==='item/tool/call')toolRequest=event;});
  const inject=(suffix:string)=>rpc!.request('thread/inject_items',{threadId:thread.id,items:[{type:'function_call',call_id:'nxbridge-'+suffix,name:'receive_messages',namespace:'claude',arguments:'{}'},{type:'function_call_output',call_id:'nxbridge-'+suffix,output:JSON.stringify({messages:[{message_id:suffix,message:'隔离成对注入'}]})}]},{mutation:true});
  await rpc.request('turn/start',{threadId:thread.id,input:[{type:'text',text:'隔离流边界'}]},{mutation:true});
  await Promise.race([started,new Promise<never>((_,reject)=>{const timer=setTimeout(()=>reject(Error('隔离模型流未开始')),20000);timer.unref();})]);
  await inject('stream');releaseStream();await wait(()=>!!toolRequest,'未收到隔离动态工具调用');
  rpc.respond(toolRequest!.id!,{contentItems:[{type:'inputText',text:'隔离工具完成'}],success:true});
  await wait(()=>events.some(event=>event.method==='turn/completed'),'首轮未完成');
  for(let index=0;index<4;index++){
    const before=events.filter(event=>event.method==='turn/completed').length;
    await Promise.all([rpc.request('turn/start',{threadId:thread.id,input:[{type:'text',text:'隔离空闲转活动 '+index}]},{mutation:true}),inject('race-'+index)]);
    await wait(()=>events.filter(event=>event.method==='turn/completed').length>before,'竞态轮次未完成');
  }
  const rows=readFileSync(thread.path,'utf8').split('\n').filter(Boolean).map(line=>JSON.parse(line)).filter(row=>row.type==='response_item').map(row=>row.payload);
  const calls=new Set<string>(),outputs=new Set<string>();
  for(const item of rows){if(item.type==='function_call')calls.add(item.call_id);if(item.type==='function_call_output'){assert.ok(calls.has(item.call_id),'工具结果没有在前的调用：'+item.call_id);outputs.add(item.call_id);}}
  for(const id of ['stream',...Array.from({length:4},(_,i)=>'race-'+i)]){assert.ok(calls.has('nxbridge-'+id));assert.ok(outputs.has('nxbridge-'+id));}
  assert.equal(errors.length,0);assert.ok(requests.length>=5);t.diagnostic('本地假模型；真实模型调用 0；覆盖流中注入与四次空闲转活动。');
});
