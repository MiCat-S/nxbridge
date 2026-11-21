import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { readModelBody } from './model-http-fixture.js';
import { stringify } from 'smol-toml';
import { temporaryDirectory } from '../tests/support/temporary.js';
import {resolveCli,runCli} from '../process/host-command.js';
import { NativeTerminal } from './terminal-fixture.js';
import {delay} from '../shared/time.js';

test('安装版 Codex TUI：压缩事件与下轮上下文注入能力',{skip:process.platform!=='win32',timeout:150000},async t=>{
  const temp=temporaryDirectory(),root=temp.directory,home=path.join(root,'bridge'),codexhome=path.join(root,'codex'),claudehome=path.join(root,'claude'),events=path.join(root,'events.jsonl');
  for(const d of [home,codexhome,claudehome])mkdirSync(d,{recursive:true});
  const requests:any[]=[],model=http.createServer(async(req,res)=>{
    try{
      const raw=await readModelBody(req);
      if(!req.url?.includes('/responses')){res.writeHead(200,{'content-type':'application/json'});res.end('{"data":[]}');return;}
      const body=JSON.parse(raw.toString());requests.push({url:req.url,body});const id='probe-'+requests.length,item={type:'message',id:'msg-'+id,role:'assistant',status:'completed',content:[{type:'output_text',text:'NATIVE_PROBE_DONE'}]};
      res.writeHead(200,{'content-type':'text/event-stream'});
      for(const event of [{type:'response.created',response:{id,status:'in_progress',output:[]}},{type:'response.output_item.added',output_index:0,item},{type:'response.output_item.done',output_index:0,item},{type:'response.completed',response:{id,status:'completed',output:[item],usage:{input_tokens:20,output_tokens:5,total_tokens:25}}}])res.write('data: '+JSON.stringify(event)+'\n\n');res.end();
    }catch(e){res.writeHead(500);res.end(String(e));}
  });
  await new Promise<void>(r=>model.listen(0,'127.0.0.1',r));
  const hook=path.join(root,'hook.cjs');
  writeFileSync(hook,`const fs=require('node:fs');let raw='';process.stdin.setEncoding('utf8');process.stdin.on('data',c=>raw+=c);process.stdin.on('end',()=>{const e=JSON.parse(raw);fs.appendFileSync(${JSON.stringify(events)},JSON.stringify(e)+'\\n');console.log(JSON.stringify(e.hook_event_name==='PreCompact'?{hookSpecificOutput:{hookEventName:'PreCompact',additionalContext:'NX_PRECOMPACT_CONTEXT_PROBE'}}:e.hook_event_name==='SessionStart'&&e.source==='compact'?{hookSpecificOutput:{hookEventName:'SessionStart',additionalContext:'NX_COMPACT_GROUNDING_PROBE'}}:{}));});`,'utf8');
  const command='node "'+hook+'"',hooks=Object.fromEntries(['SessionStart','SessionEnd','PreCompact','PostCompact','UserPromptSubmit','Stop'].map(name=>[name,[{hooks:[{type:'command',command,timeout:5}]}]]));
  writeFileSync(path.join(codexhome,'hooks.json'),JSON.stringify({hooks}),'utf8');
  writeFileSync(path.join(codexhome,'config.toml'),stringify({model:'gpt-5.1-codex',model_provider:'local_probe',model_reasoning_effort:'low',approval_policy:'never',sandbox_mode:'read-only',suppress_unstable_features_warning:true,check_for_update_on_startup:false,features:{hooks:true,apps:false,remote_plugin:false},model_providers:{local_probe:{name:'本地原生探针',base_url:`http://127.0.0.1:${(model.address() as any).port}/v1`,wire_api:'responses',requires_openai_auth:false}},projects:{[root]:{trust_level:'trusted'}}}),'utf8');
  const readEvents=()=>existsSync(events)?readFileSync(events,'utf8').trim().split('\n').filter(Boolean).map(v=>JSON.parse(v)):[];
  let terminal:NativeTerminal|undefined;
  t.after(async()=>{try{await terminal?.close();await runCli('codex',['app-server','daemon','stop'],{env:{CODEX_HOME:codexhome},timeout:15000}).catch(e=>t.diagnostic('隔离 daemon 收尾：'+String(e)));t.diagnostic(JSON.stringify({events:readEvents().map(e=>({event:e.hook_event_name,source:e.source,trigger:e.trigger})),requests:requests.map(r=>({url:r.url,grounded:JSON.stringify(r.body).includes('NX_COMPACT_GROUNDING_PROBE')})),errors:terminal?.errors}));}finally{model.closeAllConnections();await new Promise<void>(r=>model.close(()=>r()));await temp.cleanup();}});
  const exe=resolveCli('codex');terminal=await NativeTerminal.start(root,home,exe.command,[...exe.prefix,'--no-alt-screen','--dangerously-bypass-hook-trust'],root,{...process.env,TERM:'xterm-256color',COLORTERM:'truecolor',NXBRIDGE_HOME:home,CODEX_HOME:codexhome,CLAUDE_CONFIG_DIR:claudehome,OPENAI_API_KEY:'local-probe-only'});
  await terminal.prompt('first native compaction probe');await terminal.wait(()=>readEvents().some(e=>e.hook_event_name==='Stop'),'首轮未完成',30000);
  const initial=readEvents().find(e=>e.hook_event_name==='SessionStart'),before=requests.length;
  await terminal.prompt('/compact');
  await terminal.wait(()=>readEvents().some(e=>e.hook_event_name==='PostCompact'),'压缩没有发出 PostCompact',30000);
  assert.equal(readEvents().filter(e=>e.hook_event_name==='PreCompact'&&e.trigger==='manual').length,1);
  assert.equal(readEvents().filter(e=>e.hook_event_name==='PostCompact'&&e.trigger==='manual').length,1);
  assert.ok(requests.every(r=>!JSON.stringify(r.body).includes('NX_PRECOMPACT_CONTEXT_PROBE')),'PreCompact 不能把 additionalContext 注入压缩请求');
  const compactBeforeNextPrompt=readEvents().filter(e=>e.hook_event_name==='SessionStart'&&e.source==='compact').length;
  await terminal.prompt('after native compaction probe');
  await terminal.wait(()=>requests.length>before&&requests.some(r=>JSON.stringify(r.body).includes('NX_COMPACT_GROUNDING_PROBE')),'下轮模型未收到压缩恢复上下文',30000);
  const compact=readEvents().filter(e=>e.hook_event_name==='SessionStart'&&e.source==='compact');assert.equal(compact.length,1);assert.equal(compact[0].session_id,initial.session_id);
  assert.equal(readEvents().filter(e=>e.hook_event_name==='UserPromptSubmit').at(-1).session_id,initial.session_id);
  const representation=()=>requests.map(r=>(r.body.input??[]).filter((i:any)=>JSON.stringify(i).includes('NX_COMPACT_GROUNDING_PROBE')).map((i:any)=>({type:i.type,role:i.role,text:JSON.stringify(i)})));
  await terminal.wait(()=>readEvents().filter(e=>e.hook_event_name==='Stop').length>=2,'恢复轮未结束');
  await terminal.prompt('one more grounding retention probe');await terminal.wait(()=>readEvents().filter(e=>e.hook_event_name==='Stop').length>=3,'后续轮未结束');
  await terminal.prompt('/compact');await terminal.wait(()=>readEvents().filter(e=>e.hook_event_name==='PostCompact').length>=2,'第二次压缩未结束');
  await terminal.prompt('after second grounding compaction');await terminal.wait(()=>readEvents().filter(e=>e.hook_event_name==='Stop').length>=4,'第二次恢复轮未结束');
  await terminal.prompt('/new');await delay(1000);const newEndBeforePrompt=readEvents().filter(e=>e.hook_event_name==='SessionEnd').length;
  await terminal.prompt('new context hook event probe');await terminal.wait(()=>readEvents().filter(e=>e.hook_event_name==='Stop').length>=5,'新对话轮未结束');
  t.diagnostic(JSON.stringify({installed:'0.164.0',pid:terminal.identity.pid,compactBeforeNextPrompt,newEndBeforePrompt,compactSessionStart:readEvents().filter(e=>e.hook_event_name==='SessionStart'&&e.source==='compact').length,representation:representation(),events:readEvents().map(e=>({event:e.hook_event_name,source:e.source,trigger:e.trigger,session:e.session_id})),requests:requests.map(r=>({url:r.url,grounded:JSON.stringify(r.body).includes('NX_COMPACT_GROUNDING_PROBE')}))}));
});
