import { overrideEnvironment } from '../tests/support/environment.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { readModelBody } from './model-http-fixture.js';
import { stripVTControlCharacters } from 'node:util';
import { stringify } from 'smol-toml';
import { temporaryDirectory } from '../tests/support/temporary.js';
import { preparePlugins } from '../install/setup.js';
import { brokerCall, ensureBroker } from '../ipc/ipc.js';
import {DEFAULT_CONFIG} from '../config/defaults.js';
import { processIdentity } from '../process/process.js';
import {PACKAGE_ROOT} from '../shared/package-location.js';
import {resolveCli,runCli} from '../process/host-command.js';
import { NativeTerminal } from './terminal-fixture.js';

test('安装版 Codex 窗口：延迟新建、压缩、分支、恢复及关闭重接保留配对', {skip:process.platform!=='win32',timeout:170000},async t=>{
  const temp=temporaryDirectory(),root=temp.directory,home=path.join(root,'bridge'),codexhome=path.join(root,'codex'),claudehome=path.join(root,'claude'),eventfile=path.join(root,'events.jsonl');
  for(const d of [home,codexhome,claudehome])mkdirSync(d,{recursive:true});
  const env={NXBRIDGE_HOME:home,CODEX_HOME:codexhome,CLAUDE_CONFIG_DIR:claudehome,OPENAI_API_KEY:'isolated-lineage-only'},restoreEnvironment=overrideEnvironment(env);
  writeFileSync(path.join(home,'config.json'),JSON.stringify({...DEFAULT_CONFIG,implicit:'never',compatibilityWake:'strict',codexHome:codexhome,claudeHome:claudehome}),'utf8');
  let phase=0,pickup=false,hold=false;const requests:any[]=[],errors:string[]=[];
  const model=http.createServer(async(req,res)=>{try{
    const raw=await readModelBody(req);
    if(!req.url?.includes('/responses')){res.writeHead(200,{'content-type':'application/json'});res.end('{"data":[]}');return;}
    const body=JSON.parse(raw.toString());requests.push(body);const callId='lineage-pickup-'+phase;
    if(hold){res.writeHead(200,{'content-type':'text/event-stream'});res.write('data: '+JSON.stringify({type:'response.created',response:{id:'interrupt-fixture',status:'in_progress',output:[]}})+'\n\n');return;}
    let spec:any;for(const tool of body.tools??[]){if(tool.type==='namespace'){const inner=tool.tools.find((v:any)=>/receive_messages$/.test(v.name));if(inner)spec={...inner,namespace:tool.name};}else if(/receive_messages$/.test(tool.name))spec=tool;}
    const fetch=pickup&&!!spec&&!body.input?.some((v:any)=>v.type==='function_call_output'&&v.call_id===callId);
    const id='lineage-'+requests.length,item=fetch?{type:'function_call',id:'fc-'+id,call_id:callId,name:spec.name,...(spec.namespace?{namespace:spec.namespace}:{}),arguments:'{}'}:{type:'message',id:'msg-'+id,role:'assistant',status:'completed',content:[{type:'output_text',text:'LINEAGE_DONE_'+phase}]};
    res.writeHead(200,{'content-type':'text/event-stream'});for(const event of [{type:'response.created',response:{id,status:'in_progress',output:[]}},{type:'response.output_item.added',output_index:0,item},{type:'response.output_item.done',output_index:0,item},{type:'response.completed',response:{id,status:'completed',output:[item],usage:{input_tokens:20,output_tokens:5,total_tokens:25}}}])res.write('data: '+JSON.stringify(event)+'\n\n');res.end();
  }catch(e){errors.push(String(e));res.writeHead(500);res.end(String(e));}});
  await new Promise<void>(r=>model.listen(0,'127.0.0.1',r));let terminal:NativeTerminal|undefined;
  const events=()=>existsSync(eventfile)?readFileSync(eventfile,'utf8').trim().split('\n').filter(Boolean).map(v=>JSON.parse(v)):[];
  t.after(async()=>{try{await terminal?.close();try{await brokerCall('shutdown',{releaseOwned:false},{home,start:false});}catch{}await temp.cleanup();}finally{model.closeAllConnections();await new Promise<void>(r=>model.close(()=>r()));restoreEnvironment();}});
  const marketplace=await preparePlugins(home),bridge=path.join(marketplace,'plugins/codex/bridge.cjs'),capture=path.join(root,'capture.cjs');
  writeFileSync(capture,`const fs=require('node:fs');let s='';process.stdin.on('data',c=>s+=c);process.stdin.on('end',()=>{fs.appendFileSync(${JSON.stringify(eventfile)},JSON.stringify(JSON.parse(s))+'\\n');console.log('{}');});`,'utf8');
  const hooks=JSON.parse(readFileSync(path.join(PACKAGE_ROOT,'plugins/codex/hooks/hooks.json'),'utf8')).hooks;
  for(const groups of Object.values(hooks) as any[])for(const group of groups)for(const entry of group.hooks)if(entry.type==='command')entry.command=entry.command.replaceAll('${PLUGIN_ROOT}',path.dirname(bridge).replaceAll('\\','/'));
  for(const event of ['SessionStart','SessionEnd','UserPromptSubmit','Stop','PostCompact','Interrupt']){hooks[event]??=[];hooks[event].unshift({hooks:[{type:'command',command:'node "'+capture+'"',timeout:5}]});}
  writeFileSync(path.join(codexhome,'hooks.json'),JSON.stringify({hooks:Object.fromEntries(['SessionStart','SessionEnd','UserPromptSubmit','Stop','PostCompact','Interrupt'].map(event=>[event,[{hooks:[{type:'command',command:'node "'+capture+'"',timeout:5}]}]]))}),'utf8');
  writeFileSync(path.join(codexhome,'config.toml'),stringify({model:'gpt-5.1-codex',model_provider:'local_lineage',model_reasoning_effort:'low',approval_policy:'never',sandbox_mode:'read-only',suppress_unstable_features_warning:true,check_for_update_on_startup:false,features:{hooks:true,apps:false,remote_plugin:false,code_mode:{enabled:false,direct_only_tool_namespaces:['claude']},non_prefixed_mcp_tool_names:{enabled:true,server_names:['claude']}},model_providers:{local_lineage:{name:'本地沿袭验收',base_url:`http://127.0.0.1:${(model.address() as any).port}/v1`,wire_api:'responses',requires_openai_auth:false}},projects:{[root]:{trust_level:'trusted'}}}),'utf8');
  await runCli('codex',['plugin','marketplace','add',marketplace,'--json']);await runCli('codex',['plugin','add','nxbridge@nxbridge-local','--json']);
  (await ensureBroker(home)).close();const exe=resolveCli('codex'),start=async(args:string[]=[])=>NativeTerminal.start(root,home,exe.command,[...exe.prefix,'--no-daemon','--no-alt-screen','--dangerously-bypass-hook-trust',...args],root,{...process.env,TERM:'xterm-256color',COLORTERM:'truecolor'});
  terminal=await start();const wait=async(check:()=>boolean|Promise<boolean>,why:string)=>terminal!.wait(check,why+'；'+errors.join(';'),25000);
  const status=()=>brokerCall<any>('status',{}, {home}),turn=async(text:string)=>{const count=events().filter(e=>e.hook_event_name==='Stop').length,offset=terminal!.output.length,marker='LINEAGE_DONE_'+phase;await terminal!.prompt(text);await wait(()=>{const output=stripVTControlCharacters(terminal!.output.slice(offset)),end=output.lastIndexOf(marker);return events().filter(e=>e.hook_event_name==='Stop').length>count&&end!==-1&&output.slice(end+marker.length).includes('Worked for');},'原生轮次未完成');};
  const identity=await processIdentity(process.pid),c=await brokerCall<any>('register',{host:'claude',sessionId:'lineage-counterpart',cwd:root,name:'沿袭搭档',kind:'root',permission:'prompting',endpoint:{mode:'embedded',address:'',epoch:'counterpart',pid:process.pid,procStart:identity.startedAt}},{home});
  await wait(async()=>{const snapshot=await status();return snapshot.endpoints.some((e:any)=>e.active&&e.pid===terminal!.identity.pid&&e.pendingContext);},'第一轮之前的空闲新窗口未登记候选');
  let s=await status();const candidate=s.peers.find((p:any)=>s.endpoints.some((e:any)=>e.peerId===p.id&&e.active&&e.pid===terminal!.identity.pid&&e.pendingContext));assert.ok(candidate);assert.equal(candidate.sessionId,null);assert.equal(requests.length,0);
  await brokerCall('pair',{claude:c.id,codex:candidate.id},{home});
  const ca={host:'claude',sessionId:c.sessionId,callId:'lineage-send'},beforeFirst=await brokerCall<any>('send',{actor:{...ca,callId:'before-first'},message:'NX_BEFORE_FIRST_PROMPT'},{home});
  assert.equal(beforeFirst.waiting_context,true,JSON.stringify({beforeFirst,snapshot:await status()}));assert.equal((await status()).messages.find((m:any)=>m.id===beforeFirst.message_id).attempts,0);
  pickup=true;await turn('初始化沿袭验收');s=await status();const x=s.peers.find((p:any)=>p.id===candidate.id&&p.context);assert.ok(x,'真实 hook 未沿用候选成员');const original=x.sessionId,native=terminal.identity,pair=s.pair;
  assert.ok(requests.some(r=>JSON.stringify(r.input).includes('NX_BEFORE_FIRST_PROMPT')));assert.equal(pair.codex,x.id);
  const xa={host:'codex',sessionId:x.sessionId,callId:'lineage-question',binding:{key:s.bindings.find((b:any)=>b.peerId===x.id&&b.active).key,epoch:x.context.epoch}};
  const pending=await brokerCall<any>('question.create',{actor:xa,questions:[{id:'q',header:'验证',question:'沿袭验证？',options:[{label:'甲',description:'甲'},{label:'乙',description:'乙'}]}]},{home});
  const newOffset=terminal.output.length;await terminal.prompt('/new');await wait(()=>stripVTControlCharacters(terminal!.output.slice(newOffset)).includes('OpenAI Codex'),'原生新对话界面未出现');
                                                      
  const newEndBeforePrompt=events().filter(e=>e.hook_event_name==='SessionEnd').length;
  s=await status();assert.equal(s.peers.find((p:any)=>p.id===x.id).sessionId,original);
  const accepted=await brokerCall<any>('send',{actor:ca,message:'NX_LINEAGE_WAITING_BODY'},{home});assert.equal((await status()).messages.find((m:any)=>m.id===accepted.message_id).state,'accepted');
  pickup=true;phase++;await turn('物化新上下文并读取搭档来信');s=await status();let current=s.peers.find((p:any)=>p.id===x.id);assert.notEqual(current.sessionId,original);assert.equal(s.pair.id,pair.id);assert.equal(s.questions.find((q:any)=>q.id===pending.request_id).status,'cancelled');
  assert.ok(requests.some(r=>r.input?.some((i:any)=>i.type==='function_call_output'&&i.call_id==='lineage-pickup-'+phase&&JSON.stringify(i).includes('NX_LINEAGE_WAITING_BODY'))));assert.equal(s.messages.filter((m:any)=>m.id===accepted.message_id).length,1);
  const fresh=current.sessionId,epoch=current.context.epoch;await terminal.prompt('/compact');await wait(()=>events().some(e=>e.hook_event_name==='PostCompact'),'未完成压缩');phase++;await turn('压缩后继续');current=(await status()).peers.find((p:any)=>p.id===x.id);assert.equal(current.sessionId,fresh);assert.equal(current.context.epoch,epoch);
  const forkOffset=terminal.output.length;await terminal.prompt('/fork');await wait(()=>stripVTControlCharacters(terminal!.output.slice(forkOffset)).replace(/\s+/gu,'').includes('Forkcreated.Youcancontinuehere.'),'原生分支未完成');phase++;await turn('分支后继续');s=await status();assert.notEqual(s.peers.find((p:any)=>p.id===x.id).sessionId,fresh);assert.equal(s.pair.id,pair.id);
  const resumeOffset=terminal.output.length;await terminal.prompt('/resume '+original);await wait(()=>terminal!.output.slice(resumeOffset).includes('LINEAGE_DONE_0'),'原生旧对话未恢复');phase++;await turn('恢复后继续');s=await status();assert.equal(s.peers.find((p:any)=>p.id===x.id).sessionId,original);assert.equal(s.pair.id,pair.id);assert.equal(terminal.identity.pid,native.pid);
  await terminal.close();terminal=await start(['resume',original]);
  await wait(async()=>{const snapshot=await status();return snapshot.endpoints.some((e:any)=>e.active&&e.pid===terminal!.identity.pid&&e.pendingContext);},'第一轮之前的 resume 窗口未登记候选');
  const beforeResume=await brokerCall<any>('send',{actor:{...ca,callId:'before-resume'},message:'NX_BEFORE_RESUME_PROMPT'},{home});assert.equal((await status()).messages.find((m:any)=>m.id===beforeResume.message_id).attempts,0);
  phase++;await turn('重新打开并沿袭原搭档');s=await status();current=s.peers.find((p:any)=>p.id===x.id);assert.equal(current.sessionId,original);assert.equal(s.pair.id,pair.id);assert.notEqual(terminal.identity.pid,native.pid);assert.equal(s.bindings.filter((b:any)=>b.peerId===x.id&&b.active).length,1);
  assert.ok(requests.some(r=>JSON.stringify(r.input).includes('NX_BEFORE_RESUME_PROMPT')));
  hold=true;const heldAt=requests.length;await terminal.prompt('等待原生 Esc 中断验收');await wait(()=>requests.length>heldAt,'未开始可中断的原生请求');terminal.send('\u001b');
  await wait(async()=>(await status()).peers.find((p:any)=>p.id===x.id)?.state==='paused','实际 Esc 未暂停原窗口');hold=false;
  const paused=await brokerCall<any>('send',{actor:{...ca,callId:'after-esc'},message:'NX_AFTER_ESC_HELD'},{home});assert.match(paused.message,/held: user interrupted codex window/);
  const pausedRequests=requests.length;await new Promise(resolve=>setTimeout(resolve,500));assert.equal(requests.length,pausedRequests);assert.equal((await status()).messages.find((m:any)=>m.id===paused.message_id).attempts,0);
  phase++;await turn('由用户输入继续原窗口');assert.ok(requests.some(r=>JSON.stringify(r.input).includes('NX_AFTER_ESC_HELD')));assert.equal(errors.length,0);
  t.diagnostic(JSON.stringify({pair:pair.id,member:x.id,newEndBeforePrompt,lineage:current.context.lineage.map((v:any)=>({sessionId:v.sessionId,reason:v.reason})),requests:requests.length,oldPid:native.pid,newPid:terminal.identity.pid,realModelCalls:0}));
});
