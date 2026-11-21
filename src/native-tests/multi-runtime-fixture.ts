import { overrideEnvironment } from '../tests/support/environment.js';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import { mkdirSync, writeFileSync,readFileSync,readdirSync } from 'node:fs';
import { readModelBody } from './model-http-fixture.js';
import { stringify } from 'smol-toml';
import type { TestContext } from 'node:test';
import { temporaryDirectory } from '../tests/support/temporary.js';
import {DEFAULT_CONFIG} from '../config/defaults.js';
import { brokerCall,ensureBroker } from '../ipc/ipc.js';
import {delay} from '../shared/time.js';
import {resolveCli} from '../process/host-command.js';
import { processIdentity } from '../process/process.js';
import { setupPublish } from './publish-fixture.js';
import { configClient } from '../hosts/codex/stdio-codex.js';
import { connectAppServer } from '../hosts/codex/adapter.js';

export async function multiRuntimeFixture(t:TestContext,installed=false){
  const temp=temporaryDirectory(),root=temp.directory,home=path.join(root,'bridge'),codexhome=path.join(root,'codex'),claudehome=path.join(root,'claude');for(const d of [home,codexhome,claudehome])mkdirSync(d,{recursive:true});
  const requests:any[]=[],held=new Map<number,()=>void>(),holding=new Set<number>(),errors:string[]=[];
  const model=http.createServer(async(req,res)=>{try{
    const raw=await readModelBody(req);
    if(!req.url?.includes('/responses')){res.writeHead(200,{'content-type':'application/json'});res.end('{"data":[]}');return;}
    const body=JSON.parse(raw.toString());requests.push(body);const busy=/MULTI_BUSY_(\d)/.exec(JSON.stringify(body.input)),index=busy?Number(busy[1]):-1;
    if(holding.has(index))await new Promise<void>(r=>held.set(index,r));
    const id='multi-'+requests.length,item={type:'message',id:'msg-'+id,role:'assistant',status:'completed',content:[{type:'output_text',text:'MULTI_NATIVE_DONE'}]};res.writeHead(200,{'content-type':'text/event-stream'});
    for(const event of [{type:'response.created',response:{id,status:'in_progress',output:[]}},{type:'response.output_item.added',output_index:0,item},{type:'response.output_item.done',output_index:0,item},{type:'response.completed',response:{id,status:'completed',output:[item],usage:{input_tokens:20,output_tokens:5,total_tokens:25}}}])res.write('data: '+JSON.stringify(event)+'\n\n');res.end();
  }catch(e){errors.push(String(e));res.writeHead(500);res.end(String(e));}});await new Promise<void>(r=>model.listen(0,'127.0.0.1',r));
  const env={NXBRIDGE_HOME:home,CODEX_HOME:codexhome,CLAUDE_CONFIG_DIR:claudehome,OPENAI_API_KEY:'multi-local-only'},restoreEnvironment=overrideEnvironment(env);
  t.after(async()=>{for(const resolve of held.values())resolve();holding.clear();try{await temp.cleanup();}finally{model.closeAllConnections();await new Promise<void>(r=>model.close(()=>r()));restoreEnvironment();}});
  const codex=resolveCli('codex',process.env.NXBRIDGE_TEST_CODEX_BINARY),config={...DEFAULT_CONFIG,implicit:'on-demand' as const,compatibilityWake:'strict' as const,codexCommand:[codex.command,...codex.prefix],codexHome:codexhome,claudeHome:claudehome};writeFileSync(path.join(home,'config.json'),JSON.stringify(config),'utf8');
  writeFileSync(path.join(codexhome,'config.toml'),stringify({model:'gpt-5.1-codex',model_provider:'multi_local',approval_policy:'never',sandbox_mode:'read-only',web_search:'disabled',features:{apps:false,remote_plugin:false},model_providers:{multi_local:{name:'多运行时本地验收',base_url:`http://127.0.0.1:${(model.address() as any).port}/v1`,wire_api:'responses',requires_openai_auth:false}}}),'utf8');
                                                            
  const control=await configClient(config,home);try{await control.request('config/read',{});}finally{await control.close();}
  if(installed)assert.equal((await setupPublish() as any).installed,true);else(await ensureBroker(home)).close();
  const call=<T=any>(method:string,params:any={})=>brokerCall<T>(method,params,{home,timeout:60000}),status=()=>call('status');
  const wait=async(check:()=>boolean|Promise<boolean>,reason:string,timeout=60000)=>{const end=Date.now()+timeout;while(!await check()){
    if(Date.now()>=end){let brokerLog='';try{brokerLog=readFileSync(path.join(home,'run','broker.log'),'utf8').slice(-10000);}catch{}
      assert.fail(reason+'；'+JSON.stringify({errors,status:await status(),events:await call('events'),requests:requests.map(request=>request.input),brokerLog}));}
    await delay(50);
  }};
  const identity=await processIdentity(process.pid),sources:any[]=[];
  for(let i=0;i<2;i++){const cwd=path.join(root,'project-'+i);mkdirSync(cwd);sources.push(await call('register',{host:'claude',sessionId:'multi-source-'+i,cwd,name:'原生运行时搭档 '+i,kind:'root',permission:'prompting',endpoint:{mode:'embedded',address:'',epoch:'source-'+i,pid:process.pid,procStart:identity.startedAt}}));}
  const actor=(p:any,id:string)=>({host:p.host,memberId:p.id,sessionId:p.sessionId,callId:id});
  await Promise.all(sources.map((p,i)=>call('send',{actor:actor(p,'initial-'+i),message:'MULTI_INITIAL_'+i})));
  await wait(async()=>{const s=await status();if(s.peers.some((p:any)=>p.launchFailure))assert.fail('原生后台启动失败；'+JSON.stringify({status:s,logs:Object.fromEntries(readdirSync(path.join(home,'run')).filter(name=>/^codex-.*\.log$/.test(name)).map(name=>[name,readFileSync(path.join(home,'run',name),'utf8').slice(-5000)]))}));return s.pairs.length===2&&s.pairs.every((p:any)=>s.peers.some((x:any)=>x.id===p.codex&&x.sessionId&&x.state==='ready'));},'两组独立原生运行时未完成初始轮次',80000);
  const s=await status(),pairs=sources.map(c=>s.pairs.find((p:any)=>p.claude===c.id)),targets=pairs.map(p=>s.peers.find((x:any)=>x.id===p.codex)),endpoints=targets.map(x=>s.endpoints.find((e:any)=>e.peerId===x.id&&e.active&&e.mode==='app-server'));
  assert.notEqual(endpoints[0].address,endpoints[1].address);assert.notEqual(endpoints[0].pid,endpoints[1].pid);assert.ok(endpoints.every(e=>e.pid&&e.procStart));
  const inspectors=await Promise.all(endpoints.map(endpoint=>connectAppServer(endpoint.address,config,undefined,home,{readOnly:true})));
  try{await wait(async()=>{
    const current=await status();
    if(!sources.every((source,i)=>current.messages.some((message:any)=>message.from===source.id&&message.body==='MULTI_INITIAL_'+i&&message.state==='contextObserved')))return false;
    const threads=await Promise.all(inspectors.map((rpc,i)=>rpc.request('thread/read',{threadId:targets[i].sessionId,includeTurns:true})));
    return targets.every(target=>current.peers.find((peer:any)=>peer.id===target.id)?.state==='ready')&&threads.every(value=>value.thread.status.type==='idle'&&value.thread.turns?.at(-1)?.status==='completed');
  },'初始输入尚未确认消费并完成原生轮次');}finally{await Promise.all(inspectors.map(rpc=>rpc.close()));}
  const busy=async(i:number)=>{holding.add(i);await call('send',{actor:actor(sources[i],'busy-'+i),message:'MULTI_BUSY_'+i});await wait(()=>held.has(i),'真实模型请求未进入挂起状态');};
  const question=(i:number)=>call('question.create',{actor:actor(targets[i],'q-'+i),questions:[{id:'q',header:'独立',question:'选择第 '+i+' 组？',options:[{label:'甲',description:'甲'},{label:'乙',description:'乙'}]}]});
  return{root,home,call,status,wait,actor,sources,pairs,targets,endpoints,requests,errors,busy,question,release:(i:number)=>{holding.delete(i);held.get(i)?.();held.delete(i);}};
}
