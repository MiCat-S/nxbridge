import { overrideEnvironment } from '../tests/support/environment.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { readModelBody } from './model-http-fixture.js';
import { preparePlugins } from '../install/setup.js';
import { brokerCall, ensureBroker } from '../ipc/ipc.js';
import {DEFAULT_CONFIG} from '../config/defaults.js';
import {runCli,spawnCli} from '../process/host-command.js';
import { Store } from '../storage/store.js';
import { temporaryDirectory } from '../tests/support/temporary.js';
import { configClient } from '../hosts/codex/stdio-codex.js';

                                    
test('原生 Codex：nxref 首请求展开、短父调用、模型覆盖、最终答案捕获与正常失败拒绝',async t=>{
  const temp=temporaryDirectory(),home=path.join(temp.directory,'bridge'),codexhome=path.join(temp.directory,'codex');
  mkdirSync(home,{recursive:true});mkdirSync(codexhome,{recursive:true});
  const config={...DEFAULT_CONFIG,codexHome:codexhome,implicit:'never' as const,compatibilityWake:'strict' as const,...(process.env.NXBRIDGE_TEST_CODEX_BINARY?{codexBinary:process.env.NXBRIDGE_TEST_CODEX_BINARY}:{})};
  writeFileSync(path.join(home,'config.json'),JSON.stringify(config),'utf8');
  const env={NXBRIDGE_HOME:home,CODEX_HOME:codexhome,CLAUDE_CONFIG_DIR:path.join(temp.directory,'claude'),OPENAI_API_KEY:'not-a-real-key'};
  const restoreEnvironment=overrideEnvironment(env);
  let phase='valid',sourceId='',childId='',rootId='',logs='',schemaV2=false,waitCount=0,expanded:any;const requests:{phase:string;body:any;child:boolean}[]=[];
  const full='完整引用正文 NATIVE_REF_FULL '+ '中文内容 '.repeat(3000);
  const tool=(body:any,name:RegExp):any=>{
    for(const entry of body.tools??[]){if(entry.type==='namespace'){const found=entry.tools.find((v:any)=>name.test(v.name));if(found)return{...found,namespace:entry.name};}else if(name.test(entry.name))return entry;}
  };
  const model=http.createServer(async(req,res)=>{
    try{
      const raw=await readModelBody(req);
      if(!req.url?.includes('/responses')){res.writeHead(200,{'content-type':'application/json'});res.end('{"data":[]}');return;}
      const body=JSON.parse(raw.toString('utf8')),child=body.model==='gpt-6-sol';requests.push({phase,body,child});
      const outputs=(body.input??[]).filter((v:any)=>v.type==='function_call_output');let item:any;
      if(child)item={type:'message',id:'child-final',role:'assistant',status:'completed',content:[{type:'output_text',text:'NATIVE_REF_CHILD_FINAL 子代理最终答案'}]};
      else if(!outputs.length){
        const status:any=await brokerCall('status'),registered=status.peers.findLast((p:any)=>p.host==='codex'&&p.kind==='root');
        assert.ok(registered,'首请求前缺少 SessionStart 登记；请求字段 '+Object.keys(body).join(',')+'；'+JSON.stringify(status));rootId=registered.sessionId;
        const root=status.peers.find((p:any)=>p.sessionId===rootId),peer:any=await brokerCall('register',{host:'claude',sessionId:'fixture',cwd:temp.directory,kind:'root',endpoint:{mode:'claude-inbox',address:'fixture',epoch:'fixture',pid:process.pid,procStart:'fixture'}});
        await brokerCall('pair',{claude:peer.id,codex:root.id,replace:true});
        const source:any=await brokerCall('send',{actor:{host:'claude',sessionId:'fixture',callId:phase},message:full});sourceId=source.message_id;
        const spawn=tool(body,/^(?:.*[.])?spawn_agent$/);assert.ok(spawn,'原生工具没有 spawn_agent');
        const parameters=spawn.parameters??spawn.input_schema??{},v2=parameters.required?.includes('task_name');
        schemaV2=v2===true;
        item={type:'function_call',id:'spawn-ref',call_id:'spawn-ref',name:spawn.name,...(spawn.namespace?{namespace:spawn.namespace}:{}),arguments:JSON.stringify({message:phase==='valid'?`任务 nxref:msg:${sourceId}`:'nxref:msg:missing',model:'gpt-6-sol',reasoning_effort:'high',...(v2?{task_name:'reference_child',fork_turns:'none'}:{fork_context:false})})};
      }else if(phase==='valid'&&outputs.some((v:any)=>v.call_id==='spawn-ref')){
        const output=outputs.find((v:any)=>v.call_id==='spawn-ref');let result:any;try{result=JSON.parse(output.output);}catch{}
        childId=result?.task_name??result?.agent_id??result?.id;assert.ok(childId,'原生 spawn 失败：'+JSON.stringify(output));
        let complete=false;
        try{const captured:any=await brokerCall('ref.expand',{actor:{host:'codex',sessionId:rootId,callId:'ready'},text:'nxref:agent:'+childId});complete=captured.text.includes('NATIVE_REF_CHILD_FINAL');if(complete)expanded=captured;}catch{}
        if(complete)item={type:'message',id:'parent-final',role:'assistant',status:'completed',content:[{type:'output_text',text:'NATIVE_REF_PARENT_DONE'}]};
        else{
          const wait=tool(body,/^(?:.*[.])?(?:wait|wait_agent)$/);assert.ok(wait,'原生工具没有 wait');
          const waitParameters=wait.parameters??wait.input_schema??{},idKey=Object.keys(waitParameters.properties??{}).find(k=>waitParameters.properties[k].type==='array');
          assert.ok(idKey||schemaV2,'未知 wait schema：'+JSON.stringify(wait));
          const id='wait-ref-'+(++waitCount);
          item={type:'function_call',id,call_id:id,name:wait.name,...(wait.namespace?{namespace:wait.namespace}:{}),arguments:JSON.stringify({...(!schemaV2&&idKey?{[idKey]:[childId]}:{}),timeout_ms:10000})};
        }
      }else item={type:'message',id:'parent-final',role:'assistant',status:'completed',content:[{type:'output_text',text:'NATIVE_REF_PARENT_DONE'}]};
      res.writeHead(200,{'content-type':'text/event-stream'});
      for(const e of [{type:'response.created',response:{id:'ref-response',status:'in_progress',output:[]}},{type:'response.output_item.added',output_index:0,item},{type:'response.output_item.done',output_index:0,item},{type:'response.completed',response:{id:'ref-response',status:'completed',output:[item],usage:{input_tokens:10,output_tokens:10,total_tokens:20}}}])res.write(`event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`);
      res.end();
    }catch(error){logs+=String(error)+'\n';res.writeHead(400);res.end(String(error));}
  });
  await new Promise<void>(resolve=>model.listen(0,'127.0.0.1',resolve));
  t.after(async()=>{
    try{await brokerCall('shutdown',{releaseOwned:false},{home,start:false});}catch{}
    model.closeAllConnections();await new Promise<void>(resolve=>model.close(()=>resolve()));
    restoreEnvironment();
    await temp.cleanup();
  });
  const marketplace=await preparePlugins(home);
  await runCli('codex',['plugin','marketplace','add',marketplace,'--json'],{config});await runCli('codex',['plugin','add','nxbridge@nxbridge-local','--json'],{config});
  const control=await configClient(config);try{const hooks=await control.request('hooks/list',{cwds:[temp.directory]});assert.equal(hooks.data[0].hooks.length,9);}finally{control.close();}
  const service=await ensureBroker(home);service.close();
  const option=(key:string,value:unknown)=>['-c',`${key}=${JSON.stringify(value)}`];
  const args=['exec','--skip-git-repo-check','--dangerously-bypass-hook-trust','--json','-C',temp.directory,
    ...option('model_provider','ref_test'),...option('model','gpt-5.1-codex'),...option('model_providers.ref_test.name','引用测试'),...option('model_providers.ref_test.base_url',`http://127.0.0.1:${(model.address() as AddressInfo).port}/v1`),...option('model_providers.ref_test.wire_api','responses'),...option('model_providers.ref_test.requires_openai_auth',false),...option('features.multi_agent',true),...option('features.multi_agent_v2',process.env.NXBRIDGE_TEST_CODEX_V2==='1'),...option('features.code_mode',false),...option('features.apps',false),...option('analytics.enabled',false),...option('web_search','disabled')];
  for(const scenario of ['valid','missing']){
    phase=scenario;
    try{await new Promise<void>((resolve,reject)=>{
      const child=spawnCli('codex',[...args,'NATIVE_REF_ROOT '+scenario],{cwd:temp.directory,stdio:['ignore','pipe','pipe']},config);let output='';
      const timer=setTimeout(()=>{child.kill();reject(Error('自有 Codex 测试进程超时\n'+output));},45000);
      child.stdout?.on('data',b=>{output+=b.toString();});child.stderr?.on('data',b=>{output+=b.toString();});
      child.once('error',error=>{clearTimeout(timer);reject(error);});child.once('close',code=>{clearTimeout(timer);logs+=output;code===0?resolve():reject(Error(output));});
    });}
    catch(error){assert.fail(String(error)+'\n'+logs+'\n'+JSON.stringify(requests.slice(-2).map(r=>({phase:r.phase,model:r.body.model,tools:r.body.tools?.map((v:any)=>v.name),last:r.body.input?.slice(-2)}))));}
    const own=requests.filter(r=>r.phase===phase),children=own.filter(r=>r.child);
    if(phase==='valid'){
      if(process.env.NXBRIDGE_TEST_CODEX_V2==='1')assert.equal(schemaV2,true,'请求启用 V2，但原生工具仍是旧 schema');
      assert.equal(children.length,1,logs);assert.ok(JSON.stringify(children[0]!.body.input).includes(full));assert.ok(JSON.stringify(children[0]!.body.input).includes('[nxref msg:'+sourceId+']'));assert.ok(!JSON.stringify(children[0]!.body.input).includes('nxref:msg:'+sourceId));assert.equal(children[0]!.body.reasoning?.effort,'high');
      const parent=own.filter(r=>!r.child).at(-1)!.body;
      assert.ok(parent.input.some((v:any)=>v.type==='function_call'&&v.call_id==='spawn-ref'&&JSON.parse(v.arguments).message===`任务 nxref:msg:${sourceId}`));
                                            
      assert.ok(expanded,'原生父轮结束前未取得子代理最终引用；'+logs.slice(-3500));
      assert.equal(expanded.text,`[nxref agent:${childId}]\nNATIVE_REF_CHILD_FINAL 子代理最终答案\n[/nxref]`);
      t.diagnostic(JSON.stringify({schemaV2,spawnResultId:childId,rootId,capture:true}));
      const store=new Store(path.join(home,'nxbridge.db'));try{assert.equal(store.message(sourceId).body,full);}finally{store.close();}
    }else{assert.equal(children.length,0);assert.match(JSON.stringify(own.at(-1)!.body.input),/nxref not expanded: nxref not found: msg must be in current pair/);}
  }
  t.diagnostic('真实原生 CLI + 回环假模型；真实模型调用 0。');
});
