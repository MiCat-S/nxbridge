import { overrideEnvironment } from '../tests/support/environment.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { readModelBody } from './model-http-fixture.js';
import { stringify } from 'smol-toml';
import { temporaryDirectory } from '../tests/support/temporary.js';
import { FakeAdapter } from '../tests/support/fake-adapter.js';
import { registration } from '../tests/support/registration.js';
import { Store } from '../storage/store.js';
import { Broker } from '../broker/coordinator.js';
import {DEFAULT_CONFIG} from '../config/defaults.js';
import {ensureHome,socketDirectory} from '../ipc/home.js';
import {PACKAGE_ROOT} from '../shared/package-location.js';
import {delay} from '../shared/time.js';
import {resolveCli} from '../process/host-command.js';
import { listenBroker } from '../ipc/ipc.js';
import { connectAppServer } from '../hosts/codex/adapter.js';
import { rememberOwnedHost } from '../process/owned-processes.js';
import { CODEX_DEVELOPER_ANCHOR } from '../broker/recovery/recovery.js';
import {deliveryHealthKey} from '../broker/health/contracts.js';
import { nativeDescendant } from '../process/process.js';

test('实际 Codex 自动压缩恢复；超时 hook 的取件保留未知且不重放',{timeout:170000},async t=>{
  const temp=temporaryDirectory(),root=temp.directory,home=path.join(root,'bridge'),codexhome=path.join(root,'codex'),claudehome=path.join(root,'claude'),eventfile=path.join(root,'hook-events.jsonl'),held=path.join(root,'held-once');
  for(const d of [home,codexhome,claudehome])mkdirSync(d,{recursive:true});await ensureHome(home);
  const env={NXBRIDGE_HOME:home,CODEX_HOME:codexhome,CLAUDE_CONFIG_DIR:claudehome,OPENAI_API_KEY:'local-recovery-only'},restoreEnvironment=overrideEnvironment(env);
  const store=new Store(path.join(home,'nxbridge.db')),broker=new Broker(store,{...DEFAULT_CONFIG,implicit:'never'},{codex:new FakeAdapter(),claude:new FakeAdapter()} as any,home),requests:any[]=[],notifications:any[]=[],errors:string[]=[];
  const partner=store.register(registration('claude','recovery-counterpart',{cwd:root})),checkpoint=path.join(path.dirname(root),'nxbridge-native-current-'+randomUUID()+'.md');
  let nativePeer:any,pair:any,noticeId:string|undefined,usedStatus=false,summarySeen=false,done=false,passed=false;
  const rpcMethods:string[]=[];
  const server=await listenBroker(home,async(method,params)=>{
    rpcMethods.push(method);
    if(method==='launch.capture'){
      const captured=(params as {env:Record<string,string>}).env;
      assert.equal(captured.NXBRIDGE_HOME,home,'原生 MCP 不能回落到真实 nxbridge 目录');
      assert.equal(captured.CODEX_HOME,codexhome,'原生 MCP 不能回落到真实 Codex 配置');
    }
    const result:any=await broker.dispatch(method,params);
    if(method==='mcp.register'&&!nativePeer){
      nativePeer=result;pair=store.pair(partner.id,result.id);
      broker.recovery.checkpoint({host:'codex',memberId:result.id,sessionId:result.sessionId,callId:'checkpoint',...(result.binding?{binding:result.binding}:{})},{action:'set',path:checkpoint});
    }
    if(method==='hook'&&(params as any).hook_event_name==='PostToolUse'&&!noticeId){noticeId=randomUUID();broker.deliveryHealth.enqueue(pair.id,nativePeer.id,{id:noticeId,message:'NATIVE_TIMEOUT_NOTICE',state:'pending'});}
    return result;
  });
  const model=http.createServer(async(req,res)=>{try{
    const raw=await readModelBody(req);
    if(!req.url?.includes('/responses')){res.writeHead(200,{'content-type':'application/json'});res.end('{"data":[]}');return;}
    const body=JSON.parse(raw.toString());requests.push(body);
    let statusTool:any;for(const tool of body.tools??[]){if(tool.type==='namespace'){const inner=tool.tools?.find((v:any)=>/(?:^|__)status$/.test(v.name));if(inner)statusTool={...inner,namespace:tool.name};}else if(/(?:^|__)status$/.test(tool.name??''))statusTool=tool;}
    const compact=/CONTEXT CHECKPOINT COMPACTION|context checkpoint|compact.*conversation|summari[sz].*(?:conversation|context)/i.test(JSON.stringify(body.input?.at(-1)))||usedStatus&&!statusTool&&!summarySeen;
    let item:any,high=false;
    if(!usedStatus&&statusTool&&!compact){usedStatus=true;high=true;item={type:'function_call',id:'status-item',call_id:'native-recovery-status',name:statusTool.name,...(statusTool.namespace?{namespace:statusTool.namespace}:{}),arguments:'{}'};}
    else{if(compact)summarySeen=true;const text=compact?'CONTROLLED_NATIVE_AUTO_SUMMARY':'NATIVE_RECOVERY_DONE';item={type:'message',id:'msg-'+requests.length,role:'assistant',status:'completed',content:[{type:'output_text',text}]};}
    const id='recovery-'+requests.length;res.writeHead(200,{'content-type':'text/event-stream'});for(const event of [{type:'response.created',response:{id,status:'in_progress',output:[]}},{type:'response.output_item.added',output_index:0,item},{type:'response.output_item.done',output_index:0,item},{type:'response.completed',response:{id,status:'completed',output:[item],usage:{input_tokens:high?5000:20,output_tokens:5,total_tokens:high?5005:25}}}])res.write('data: '+JSON.stringify(event)+'\n\n');res.end();
  }catch(error){errors.push(String(error));res.writeHead(500);res.end(String(error));}});
  await new Promise<void>(resolve=>model.listen(0,'127.0.0.1',resolve));let client:Awaited<ReturnType<typeof connectAppServer>>|undefined;
  const events=()=>existsSync(eventfile)?readFileSync(eventfile,'utf8').trim().split('\n').filter(Boolean).map(line=>JSON.parse(line)):[];
  t.after(async()=>{try{
    if(!passed)t.diagnostic(JSON.stringify({usedStatus,summarySeen,rpcMethods,events:events(),notifications:notifications.filter(n=>/hook|mcp|error/i.test(n.method)||/mcp|error/i.test(JSON.stringify(n.params?.item))).slice(-12),requests:requests.map(r=>({outputs:r.input?.filter((i:any)=>i.type==='function_call_output'),last:r.input?.at(-1),tools:r.tools?.filter((v:any)=>/claude/.test(v.name)).map((v:any)=>({name:v.name,tools:v.tools?.map((t:any)=>t.name)}))})),errors}));
    client?.close();await server.close();await broker.stop();store.close();model.closeAllConnections();await new Promise<void>(resolve=>model.close(()=>resolve()));await temp.cleanup();
  }finally{restoreEnvironment();}});
  const wrapper=path.join(root,'hook.cjs'),entry=path.join(PACKAGE_ROOT,'publish/nxbridge.mjs');
                                               
  writeFileSync(wrapper,`const fs=require('node:fs'),{spawn}=require('node:child_process');let input='';process.stdin.on('data',c=>input+=c);process.stdin.on('end',()=>{const e=JSON.parse(input),began=Date.now(),child=spawn(${JSON.stringify(process.execPath)},['--no-warnings',${JSON.stringify(entry)},'hook','--host','codex'],{env:process.env,stdio:['pipe','pipe','pipe'],windowsHide:true});let out='',err='';child.stdout.on('data',c=>out+=c);child.stderr.on('data',c=>err+=c);child.on('close',code=>{fs.appendFileSync(${JSON.stringify(eventfile)},JSON.stringify({event:e.hook_event_name,source:e.source,code,out,err,elapsedMs:Date.now()-began})+'\\n');const send=()=>{process.stdout.write(out);process.stderr.write(err);};if(e.hook_event_name==='PostToolUse'&&!fs.existsSync(${JSON.stringify(held)})){fs.writeFileSync(${JSON.stringify(held)},'held');setTimeout(send,12000);}else send();});child.stdin.end(input);});`,'utf8');
  writeFileSync(path.join(codexhome,'hooks.json'),JSON.stringify({hooks:Object.fromEntries(['SessionStart','UserPromptSubmit','PostToolUse','Stop'].map(event=>[event,[{hooks:[{type:'command',command:'node "'+wrapper.replaceAll('\\','/')+'"',timeout:10}]}]]))}),'utf8');
                                                    
  const mcpEnv={...env,...Object.fromEntries(['NXBRIDGE_TEST_SCOPE','NXBRIDGE_PROCESS_REGISTRY'].flatMap(k=>process.env[k]?[[k,process.env[k]!]]:[]))};
  writeFileSync(path.join(codexhome,'config.toml'),stringify({model:'gpt-5.1-codex',model_provider:'native_recovery',model_auto_compact_token_limit:2000,model_reasoning_effort:'low',approval_policy:'never',sandbox_mode:'read-only',web_search:'disabled',check_for_update_on_startup:false,suppress_unstable_features_warning:true,projects:{[root]:{trust_level:'trusted'}},features:{hooks:true,apps:false,remote_plugin:false,code_mode:false},mcp_servers:{claude:{command:process.execPath,args:['--no-warnings',entry,'mcp','--host','codex'],env:mcpEnv}},model_providers:{native_recovery:{name:'本地恢复验收',base_url:`http://127.0.0.1:${(model.address() as any).port}/v1`,wire_api:'responses',requires_openai_auth:false}}}),'utf8');
  const cli=resolveCli('codex'),endpoint='unix://'+path.join(await socketDirectory(home),'recovery.sock'),child=spawn(cli.command,[...cli.prefix,'--dangerously-bypass-hook-trust','app-server','--listen',endpoint],{cwd:root,env:process.env,windowsHide:true,stdio:'ignore'});
  await rememberOwnedHost(home,child,'codex','codex-runtime',randomUUID(),codexhome);
  const wait=async(check:()=>boolean|Promise<boolean>,reason:string,ms=30000)=>{const end=Date.now()+ms;while(!await check()){assert.ok(Date.now()<end,reason+'；'+errors.join(';'));await delay(40);}};
  await wait(async()=>{try{client=await connectAppServer(endpoint,{...DEFAULT_CONFIG,codexHome:codexhome},undefined,home);return true;}catch{return false;}},'原生 App Server 未就绪');
  const hooks=(await client!.request('hooks/list',{cwds:[root]})).data.flatMap((v:any)=>v.hooks??[]);assert.equal(hooks.length,4);
                                                           
  await client!.request('config/batchWrite',{edits:[{keyPath:'hooks.state',value:Object.fromEntries(hooks.map((h:any)=>[h.key,{trusted_hash:h.currentHash}])),mergeStrategy:'upsert'}],filePath:path.join(codexhome,'config.toml'),reloadUserConfig:true},{mutation:true});
  client!.on('notification',event=>{notifications.push(event);if(event.method==='turn/completed')done=true;});
  const {thread}=await client!.request('thread/start',{cwd:root,approvalPolicy:'never',sandbox:'read-only'});
                                                         
  const native=await nativeDescendant(child.pid!,'codex',0);
  nativePeer=store.register(registration('codex',thread.id,{cwd:root,endpoint:{mode:'app-server',address:endpoint,epoch:'native-recovery',pid:native.pid,procStart:native.startedAt,configHome:codexhome,processKind:'app-server'}}));
  pair=store.pair(partner.id,nativePeer.id);
  broker.recovery.checkpoint({host:'codex',memberId:nativePeer.id,sessionId:thread.id,callId:'checkpoint'},{action:'set',path:checkpoint});
  await client!.request('turn/start',{threadId:thread.id,input:[{type:'text',text:'单轮自动压缩恢复验收'}]});await wait(()=>done,'单轮自动压缩未完成',65000);
  assert.ok(usedStatus,'实际模型没有调用 MCP');assert.ok(rpcMethods.includes('mcp.register'),'MCP 必须登记到隔离协调器');assert.ok(summarySeen,'没有发生原生自动压缩');assert.ok(nativePeer&&pair&&noticeId);
  const compactDuringTurn=events().some(e=>e.event==='SessionStart'&&e.source==='compact'),during=JSON.stringify(requests).includes('nxbridge recovery facts rev ');
  if(!during){done=false;await client!.request('turn/start',{threadId:thread.id,input:[{type:'text',text:'压缩后的正常下一轮'}]});await wait(()=>done,'下一轮恢复未完成');}
  const grounded=requests.flatMap(r=>r.input??[]).flatMap((m:any)=>m.content??[]).map((c:any)=>c.text??'').filter((text:string)=>text.includes('nxbridge recovery facts rev '));assert.ok(grounded.length,'原生模型未收到恢复事实');assert.ok(grounded.some((text:string)=>text.includes('checkpoint '+JSON.stringify(path.resolve(checkpoint)))));
  assert.ok(requests.some(r=>JSON.stringify(r).includes(CODEX_DEVELOPER_ANCHOR)));assert.ok(requests.every(r=>!JSON.stringify(r).includes('NATIVE_TIMEOUT_NOTICE')),'超时 hook 的取件正文进入了模型');
  const notice=store.setting<any>(deliveryHealthKey(pair.id,nativePeer.id)).notices.find((n:any)=>n.id===noticeId);assert.equal(notice.state,'unknown');assert.equal(broker.deliveryHealth.take(pair.id,nativePeer.id).some(n=>n.id===noticeId),false);
  assert.ok(notifications.some(n=>n.method==='hook/completed'&&n.params?.run?.status==='failed'),'原生宿主没有确认预期的超时');assert.equal(errors.length,0);passed=true;
  t.diagnostic(JSON.stringify({nativeAuto:true,compactDuringTurn,recoveryDuringTurn:during,recoveryAtNextPrompt:!during,hookTimeoutNotice:'unknown/not replayed',requests:requests.length,realModelCalls:0}));
});
