import { overrideEnvironment } from '../tests/support/environment.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { temporaryDirectory } from '../tests/support/temporary.js';
import { setupPublish as setup } from './publish-fixture.js';
import { brokerCall } from '../ipc/ipc.js';
import {DEFAULT_CONFIG} from '../config/defaults.js';
import {delay} from '../shared/time.js';
import {runCli} from '../process/host-command.js';
import {windowsPowerShell} from '../shared/windows-tools.js';
import { processIdentity } from '../process/process.js';
import { pairLegacyClaude } from './legacy-claude-fixture.js';

const execute=promisify(execFile);

                                                   
test('官方 Claude：Agent 返回 ID 与完成事件一致，nxref 边界进入子代理首请求', {skip:process.platform!=='win32',timeout:120000},async t=>{
  const temp=temporaryDirectory(),directory=temp.directory,home=path.join(directory,'bridge'),claudehome=path.join(directory,'claude');
  for(const d of [home,claudehome,path.join(directory,'codex')])mkdirSync(d,{recursive:true});
  const requests:any[]=[],pids=new Set<number>();let sessionId='',sourceId='',modelError='';
  const full='NATIVE_CLAUDE_REF_FULL 中文长正文 '+ '内容 '.repeat(1000);
  const model=http.createServer(async(req,res)=>{
    try{
      let raw='';for await(const chunk of req)raw+=chunk;
      if(!req.url?.includes('/v1/messages')||req.url.includes('count_tokens')){res.writeHead(200,{'content-type':'application/json'});res.end('{"input_tokens":1,"data":[]}');return;}
      const body=JSON.parse(raw);requests.push(body);
      const child=/haiku/.test(body.model),main=!child&&body.tools?.some((v:any)=>v.name==='Agent');
      const results=(body.messages??[]).flatMap((m:any)=>Array.isArray(m.content)?m.content:[]).filter((v:any)=>v.type==='tool_result');
      const spawn=main?(!results.some((v:any)=>v.tool_use_id==='native-agent')?'native-agent':!results.some((v:any)=>v.tool_use_id==='native-agent-reuse')?'native-agent-reuse':undefined):undefined;
      const item=spawn?{type:'tool_use',id:spawn,name:'Agent',input:{}}:{type:'text',text:''};
      const delta=spawn?{type:'input_json_delta',partial_json:JSON.stringify({description:'核验代理引用',subagent_type:'general-purpose',model:'haiku',prompt:spawn==='native-agent'?'请输出最终答案。任务 nxref:msg:'+sourceId:'请输出最终答案。原任务 '+full})}:{type:'text_delta',text:child?'NATIVE_CLAUDE_REF_CHILD_FINAL 中文最终答复':main?'NATIVE_CLAUDE_REF_PARENT_DONE':JSON.stringify(body.system).includes('security monitor')?'<severity>0</severity>':'{"state":"done"}'};
      const content=spawn?{...item,input:JSON.parse(delta.partial_json!)}:{type:'text',text:delta.text};
      if(!body.stream){res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({id:'probe',type:'message',role:'assistant',model:body.model,content:[content],stop_reason:spawn?'tool_use':'end_turn',stop_sequence:null,usage:{input_tokens:10,output_tokens:10}}));return;}
      res.writeHead(200,{'content-type':'text/event-stream'});
      for(const e of [{type:'message_start',message:{id:'probe',type:'message',role:'assistant',model:body.model,content:[],usage:{input_tokens:10,output_tokens:1}}},{type:'content_block_start',index:0,content_block:item},{type:'content_block_delta',index:0,delta},{type:'content_block_stop',index:0},{type:'message_delta',delta:{stop_reason:spawn?'tool_use':'end_turn',stop_sequence:null},usage:{output_tokens:10}},{type:'message_stop'}])res.write(`event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`);
      res.end();
    }catch(error){modelError+=String(error);res.writeHead(400);res.end(String(error));}
  });
  await new Promise<void>(resolve=>model.listen(0,'127.0.0.1',resolve));
  const env={NXBRIDGE_HOME:home,CLAUDE_CONFIG_DIR:claudehome,CODEX_HOME:path.join(directory,'codex'),ANTHROPIC_API_KEY:'nxbridge-test-key',ANTHROPIC_BASE_URL:`http://127.0.0.1:${(model.address() as AddressInfo).port}`,DISABLE_AUTOUPDATER:'1',DISABLE_TELEMETRY:'1',CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC:'1'};
  const restoreEnvironment=overrideEnvironment(env);
  t.after(async()=>{
    model.closeAllConnections();await new Promise<void>(resolve=>model.close(()=>resolve()));
    try{await temp.cleanup();}finally{restoreEnvironment();}
  });
  writeFileSync(path.join(home,'config.json'),JSON.stringify({...DEFAULT_CONFIG,compatibilityWake:'strict'}),'utf8');
  const nativeCwd=(await execute(windowsPowerShell(),['-NoProfile','-NonInteractive','-Command','(Get-Location).Path'],{cwd:directory,windowsHide:true})).stdout.trim();
  const shortCwd=(await execute(windowsPowerShell(),['-NoProfile','-NonInteractive','-Command','$fs=New-Object -ComObject Scripting.FileSystemObject; $fs.GetFolder((Get-Location).Path).ShortPath'],{cwd:directory,windowsHide:true})).stdout.trim();
  const projects=Object.fromEntries([directory,nativeCwd,shortCwd].map(p=>[p.replaceAll('\\','/'),{hasTrustDialogAccepted:true}]));
  writeFileSync(path.join(claudehome,'.claude.json'),JSON.stringify({hasCompletedOnboarding:true,customApiKeyResponses:{approved:[env.ANTHROPIC_API_KEY.slice(-20)],rejected:[]},projects}),'utf8');
                                                                                             
  writeFileSync(path.join(claudehome,'settings.json'),JSON.stringify({crossSessionInbound:'accept',autoUpdatesChannel:'stable',permissions:{defaultMode:'default'},env:{ANTHROPIC_API_KEY:env.ANTHROPIC_API_KEY,ANTHROPIC_BASE_URL:env.ANTHROPIC_BASE_URL,CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC:'1'}}),'utf8');
  await setup();
  const runtime=await processIdentity(process.pid);
  const source=await brokerCall('register',{host:'codex',sessionId:'fixture',cwd:directory,kind:'root',permission:'prompting',endpoint:{mode:'embedded',address:'',epoch:'fixture',pid:process.pid,procStart:runtime.startedAt}});
  await pairLegacyClaude(home,directory,{...DEFAULT_CONFIG,compatibilityWake:'strict',claudeHome:claudehome},source.id);
  sourceId=(await brokerCall('send',{actor:{host:'codex',sessionId:'fixture',callId:'source'},message:full})).message_id;
  const findId=(value:any):string|undefined=>{
    if(typeof value==='string'){try{return findId(JSON.parse(value));}catch{return /agent_?id["']?\s*[:=]\s*["']?([\w-]+)/i.exec(value)?.[1];}}
    if(value&&typeof value==='object'){if(typeof value.agentId==='string')return value.agentId;if(typeof value.agent_id==='string')return value.agent_id;for(const v of Object.values(value)){const id=findId(v);if(id)return id;}}
  };
  let childId='',expanded:any;
  const deadline=Date.now()+60000;
  while(Date.now()<deadline){
    const status=await brokerCall('status'),peer=status.pair&&status.peers.find((p:any)=>p.id===status.pair.claude);sessionId=peer?.sessionId??'';
    for(const ep of status.endpoints??[])if(ep.peerId===peer?.id&&ep.pid)pids.add(ep.pid);
    const result=requests.flatMap(r=>r.messages??[]).flatMap(m=>Array.isArray(m.content)?m.content:[]).find(v=>v.type==='tool_result'&&v.tool_use_id==='native-agent');
    if(result)childId=findId(result.content)??'';
    if(childId&&sessionId)try{expanded=await brokerCall('ref.expand',{actor:{host:'claude',sessionId,callId:'capture'},text:'nxref:agent:'+childId});if(expanded.text.includes('NATIVE_CLAUDE_REF_CHILD_FINAL')&&requests.some(r=>JSON.stringify(r.messages).includes('nxbridge tip (auto match check')))break;}catch{}
    await delay(100);
  }
  if(!expanded){let logs='';try{const a=JSON.parse(await runCli('claude',['agents','--json','--all'])).find((v:any)=>v.sessionId===sessionId);if(a?.id)logs=await runCli('claude',['logs',a.id]);}catch{}const debug=path.join(claudehome,'debug'),debugErrors=existsSync(debug)?readdirSync(debug).filter(name=>name.endsWith('.txt')&&name!=='latest').flatMap(name=>{try{return readFileSync(path.join(debug,name),'utf8').split('\n').filter(line=>/nxbridge|error|failed/i.test(line)).slice(-12);}catch{return[];}}).slice(-25):[];t.diagnostic(JSON.stringify({childId,sessionId,modelError,debugErrors,events:await brokerCall('events'),requests:requests.map(r=>({model:r.model,tools:r.tools?.map((v:any)=>v.name),results:(r.messages??[]).flatMap((m:any)=>Array.isArray(m.content)?m.content:[]).filter((v:any)=>v.type==='tool_result'&&v.tool_use_id==='native-agent')})),logs:logs.slice(-1500)},null,2));}
  assert.ok(childId,'Agent 结果没有代理 ID');assert.equal(expanded?.text,`[nxref agent:${childId}]\nNATIVE_CLAUDE_REF_CHILD_FINAL 中文最终答复\n[/nxref]`);
  const child=requests.find(r=>/haiku/.test(r.model));assert.ok(child,'未收到子代理请求');assert.ok(JSON.stringify(child.messages).includes(`[nxref msg:${sourceId}]`));assert.ok(JSON.stringify(child.messages).includes(full));
  assert.ok(requests.some(r=>!/haiku/.test(r.model)&&JSON.stringify(r.messages).includes('nxbridge tip (auto match check')&&JSON.stringify(r.messages).includes('nxref:msg:'+sourceId)),'原生 Agent 结果未附精确复用提示');
  t.diagnostic(JSON.stringify({agentToolId:childId,modCaptureId:childId,sessionId,realModelCalls:0}));
});
