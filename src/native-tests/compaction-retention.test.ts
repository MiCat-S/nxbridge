import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { readModelBody } from './model-http-fixture.js';
import { stringify } from 'smol-toml';
import { connectAppServer } from '../hosts/codex/adapter.js';
import {DEFAULT_CONFIG} from '../config/defaults.js';
import {delay} from '../shared/time.js';
import {ensureHome,socketDirectory} from '../ipc/home.js';
import {PACKAGE_ROOT} from '../shared/package-location.js';
import {resolveCli} from '../process/host-command.js';
import { ownedProcesses, rememberOwnedDescendants, rememberOwnedHost } from '../process/owned-processes.js';
import { FakeAdapter } from '../tests/support/fake-adapter.js';
import { registration } from '../tests/support/registration.js';
import { temporaryDirectory } from '../tests/support/temporary.js';
import { Store } from '../storage/store.js';
import { Broker } from '../broker/coordinator.js';
import { listenBroker } from '../ipc/ipc.js';
import { RECOVERY_DIGEST_LIMIT } from '../broker/recovery/recovery-digest.js';
import { nativeDescendant } from '../process/process.js';

                                                   
test('安装版 Codex 本地压缩：真实窗口的最后五条通信直接恢复；再次压缩不回填旧消息',{timeout:90000},async t=>{
  const temp=temporaryDirectory(),root=temp.directory,home=path.join(root,'bridge'),codexhome=path.join(root,'codex');mkdirSync(codexhome);await ensureHome(home);
  const requests:any[]=[],launchId=randomUUID(),recoveries:string[]=[];let phase='initial';
  const store=new Store(path.join(home,'nxbridge.db')),broker=new Broker(store,{...DEFAULT_CONFIG,implicit:'never'},{codex:new FakeAdapter(),claude:new FakeAdapter()} as any,home),partner=store.register(registration('claude','counterpart',{cwd:root}));
  const ipc=await listenBroker(home,async(method,params)=>{const result:any=await broker.dispatch(method,params);if(method==='hook'&&(params as any).source==='compact')recoveries.push(result?.hookSpecificOutput?.additionalContext??'');return result;});
  const model=http.createServer(async(req,res)=>{
    try{
      const raw=await readModelBody(req);
      if(!req.url?.includes('/responses')){res.writeHead(200,{'content-type':'application/json'});res.end('{"data":[]}');return;}
      const body=JSON.parse(raw.toString());requests.push({phase,url:req.url,body});
      const id='retention-'+requests.length,item={type:'message',id:'msg-'+id,role:'assistant',status:'completed',content:[{type:'output_text',text:phase.startsWith('summary')?'CONTROLLED_COMPACTION_SUMMARY':'NATIVE_RETENTION_DONE'}]};
      res.writeHead(200,{'content-type':'text/event-stream'});
      for(const event of[{type:'response.created',response:{id,status:'in_progress',output:[]}},{type:'response.output_item.added',output_index:0,item},{type:'response.output_item.done',output_index:0,item},{type:'response.completed',response:{id,status:'completed',output:[item],usage:{input_tokens:20,output_tokens:5,total_tokens:25}}}])res.write('data: '+JSON.stringify(event)+'\n\n');res.end();
    }catch(e){res.writeHead(500);res.end(String(e));}
  });
  await new Promise<void>(r=>model.listen(0,'127.0.0.1',r));
  const provider='local_retention';
  const baseUrl=`http://127.0.0.1:${(model.address() as any).port}/v1`;
  writeFileSync(path.join(codexhome,'config.toml'),stringify({model:'gpt-5.1-codex',model_provider:provider,compact_prompt:'COMPACT_PROMPT_OVERRIDE_MARKER',features:{hooks:true,apps:false,remote_plugin:false},model_providers:{[provider]:{name:'本地压缩探针',base_url:baseUrl,wire_api:'responses',requires_openai_auth:false}}}),'utf8');
  let client:Awaited<ReturnType<typeof connectAppServer>>|undefined;
  t.after(async()=>{
    client?.close();await ipc.close();await broker.stop();store.close();model.closeAllConnections();await new Promise<void>(r=>model.close(()=>r()));
                                            
    const launcher=ownedProcesses(home).records.find(record=>record.proof.launchId===launchId&&record.parent?.pid===process.pid);
    if(launcher)await rememberOwnedDescendants(home,launcher.identity,launchId);
    await temp.cleanup();
  });
  const exe=resolveCli('codex'),endpoint='unix://'+path.join(await socketDirectory(home),'retention.sock');
  const child=spawn(exe.command,[...exe.prefix,'--dangerously-bypass-hook-trust','app-server','--listen',endpoint],{cwd:root,env:{...process.env,CODEX_HOME:codexhome,NXBRIDGE_HOME:home,OPENAI_API_KEY:'local-only',OPENAI_BASE_URL:baseUrl},stdio:'ignore',windowsHide:true});
  await rememberOwnedHost(home,child,'codex','codex-runtime',launchId,codexhome);
  for(let i=0;i<80&&!client;i++){try{client=await connectAppServer(endpoint,{...DEFAULT_CONFIG,codexHome:codexhome},undefined,home);}catch{await delay(50);}}
  assert.ok(client);const completed=new Set<string>();let serial=0;
  client.on('notification',message=>{if(message.method==='turn/completed'){completed.add(message.params.turn.id);serial++;}});
  const wait=async(check:()=>boolean)=>{const end=Date.now()+15000;while(!check()){if(Date.now()>end)throw Error('原生压缩探针等待超时');await delay(20);}};
  const spec=JSON.parse(readFileSync(path.join(PACKAGE_ROOT,'plugins/codex/hooks/hooks.json'),'utf8')).hooks.SessionStart[0].hooks[0];
  writeFileSync(path.join(codexhome,'hooks.json'),JSON.stringify({hooks:{SessionStart:[{hooks:[{...spec,command:'node "'+path.join(PACKAGE_ROOT,'publish/nxbridge.mjs').replaceAll('\\','/')+'" hook --host codex'}]}]}}),'utf8');
  const hooks=(await client.request('hooks/list',{cwds:[root]})).data.flatMap((v:any)=>v.hooks??[]);assert.equal(hooks.length,1);
  await client.request('config/batchWrite',{edits:[{keyPath:'hooks.state',value:Object.fromEntries(hooks.map((h:any)=>[h.key,{trusted_hash:h.currentHash}])),mergeStrategy:'upsert'}],filePath:path.join(codexhome,'config.toml'),reloadUserConfig:true},{mutation:true});
  const {thread}=await client.request('thread/start',{cwd:root,approvalPolicy:'never',sandbox:'read-only',developerInstructions:'CONTINUITY_DEVELOPER_INSTRUCTION'});
  const native=await nativeDescendant(child.pid!,'codex',0);
  const peer=store.register(registration('codex',thread.id,{cwd:root,endpoint:{mode:'app-server',address:endpoint,epoch:launchId,pid:native.pid,procStart:native.startedAt}})),pair=store.pair(partner.id,peer.id),messages=[];
  const turn=async(input:any)=>{const value=await client!.request('turn/start',{threadId:thread.id,...input});await wait(()=>completed.has(value.turn.id));};
  await turn({input:[{type:'text',text:'OLD_WINDOW_USER_PROMPT'}]});
  phase='partner';
  for(let index=0;index<6;index++){
    const body=index===0?'EXCLUDED_SIXTH_OLDEST':index===1?'中文旧消息'.repeat(12000):index===5?'NEW_PARTNER_TASK_MARKER '+('最新完整正文'.repeat(2000)):'WINDOW_EXCHANGE_'+index;
    const message=store.accept(pair,index%2?partner:peer,body,'exchange-'+index);messages.push(message);
    await turn({input:[],toolOutput:{namespace:'claude',name:index%2?'receive_messages':'send_message',output:JSON.stringify(index%2?{messages:[{message_id:message.id,message:body}]}:{message_id:message.id,persisted:true})}});
  }
  store.accept(pair,partner,'EXCLUDED_UNOBSERVED_NEW_MESSAGE','unseen');
  assert.ok(JSON.stringify(requests.findLast(r=>r.phase==='partner').body).includes('NEW_PARTNER_TASK_MARKER'));
  phase='summary';const before=serial;await client.request('thread/compact/start',{threadId:thread.id});await wait(()=>serial>before);
  phase='after';await turn({input:[{type:'text',text:'FOLLOWUP_USER_PROMPT'}]});
  const summary=requests.find(r=>r.phase==='summary')?.body,after=requests.find(r=>r.phase==='after')?.body;
  assert.equal(requests.find(r=>r.phase==='summary')?.url.endsWith('/compact'),false,'夹具必须实际经过本地压缩路径');
  assert.ok(summary&&after);const serialized=JSON.stringify(after);
  assert.ok(serialized.includes('OLD_WINDOW_USER_PROMPT'));
  assert.ok(serialized.includes('CONTROLLED_COMPACTION_SUMMARY'));assert.ok(serialized.includes('CONTINUITY_DEVELOPER_INSTRUCTION'));
  assert.equal((after.input??[]).some((item:any)=>item.type==='function_call_output'&&JSON.stringify(item).includes('NEW_PARTNER_TASK_MARKER')),false);
  assert.equal(recoveries.length,1,'实际 SessionStart(compact) 未生成恢复上下文');
  const digest=recoveries[0]!.slice(recoveries[0]!.indexOf('nxbridge partner recovery digest rev '));
  const ids=digest.trimEnd().split('\n').slice(1).filter((_:string,index:number)=>index%2===0).map((line:string)=>JSON.parse(line).message_id);
  assert.deepEqual(ids,messages.slice(-5).map(message=>message.id));assert.ok(digest.length<=RECOVERY_DIGEST_LIMIT);assert.match(digest,/truncated; read_messages/);
  assert.ok(serialized.includes('NEW_PARTNER_TASK_MARKER')&&serialized.includes('最新完整正文'),'恢复正文必须直接进入原生模型上下文，不能被默认限额转存文件');
  assert.ok(!digest.includes('EXCLUDED_SIXTH_OLDEST')&&!digest.includes('EXCLUDED_UNOBSERVED_NEW_MESSAGE'));
  assert.ok(JSON.stringify(summary).includes('COMPACT_PROMPT_OVERRIDE_MARKER'));
  phase='summary2';const second=serial;await client.request('thread/compact/start',{threadId:thread.id});await wait(()=>serial>second);
  phase='after2';await turn({input:[{type:'text',text:'SECOND_COMPACT_FOLLOWUP'}]});
  assert.equal(recoveries.length,2);assert.match(recoveries[1]!,/0 actual exchange msgs/);assert.ok(!recoveries[1]!.includes('NEW_PARTNER_TASK_MARKER'));
  t.diagnostic(JSON.stringify({remote:false,url:requests.find(r=>r.phase==='summary')?.url,userRetained:serialized.includes('OLD_WINDOW_USER_PROMPT'),toolBodyRetained:false,developerRetained:true,compactPromptUsed:true,digestChars:digest.length,attached:ids.length,nextWindow:0,summaryInputHasPartner:JSON.stringify(summary).includes('NEW_PARTNER_TASK_MARKER')}));
});
