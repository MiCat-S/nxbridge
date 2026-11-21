import { overrideEnvironment } from '../tests/support/environment.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import { mkdirSync, writeFileSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify, stripVTControlCharacters } from 'node:util';
import { readModelBody } from './model-http-fixture.js';
import { stringify } from 'smol-toml';
import { temporaryDirectory } from '../tests/support/temporary.js';
import { preparePlugins } from '../install/setup.js';
import { brokerCall, ensureBroker } from '../ipc/ipc.js';
import {DEFAULT_CONFIG} from '../config/defaults.js';
import {resolveCli,runCli} from '../process/host-command.js';
import {windowsPowerShell} from '../shared/windows-tools.js';
import { NativeTerminal } from './terminal-fixture.js';

                                        
test('实际原生窗口唯一候选仍先确认及配对码：保留原消息，输入码不进入模型', {skip:process.platform!=='win32',timeout:170000},async t=>{
  const temp=temporaryDirectory(),root=temp.directory,home=path.join(root,'bridge'),codexhome=path.join(root,'codex'),claudehome=path.join(root,'claude');
  for(const d of [home,codexhome,claudehome])mkdirSync(d,{recursive:true});
  let phase=0;const requests:{host:string;body:any}[]=[],errors:string[]=[],terminals:NativeTerminal[]=[];
  const model=http.createServer(async(req,res)=>{try{
    const raw=await readModelBody(req);
    const anthropic=req.url?.includes('/v1/messages')&&!req.url.includes('count_tokens'),openai=req.url?.includes('/responses');
    if(!anthropic&&!openai){res.writeHead(200,{'content-type':'application/json'});res.end('{"input_tokens":1,"data":[]}');return;}
    const body=JSON.parse(raw.toString()),host=anthropic?'claude':'codex';requests.push({host,body});
    if(openai){
      const id='pair-codex-'+requests.length,item={type:'message',id:'msg-'+id,role:'assistant',status:'completed',content:[{type:'output_text',text:'PAIR_CODEX_DONE'}]};
      res.writeHead(200,{'content-type':'text/event-stream'});
      for(const e of [{type:'response.created',response:{id,status:'in_progress',output:[]}},{type:'response.output_item.added',output_index:0,item},{type:'response.output_item.done',output_index:0,item},{type:'response.completed',response:{id,status:'completed',output:[item],usage:{input_tokens:10,output_tokens:5,total_tokens:15}}}])res.write('data: '+JSON.stringify(e)+'\n\n');res.end();return;
    }
    const callId='native-pair-send-'+phase,listId='native-pair-list-'+phase,main=body.tools?.some((v:any)=>v.name==='ListAgents'),results=(body.messages??[]).flatMap((m:any)=>Array.isArray(m.content)?m.content:[]);
    const tool=main&&!results.some((v:any)=>v.type==='tool_result'&&v.tool_use_id===listId)?'ListAgents':main&&!results.some((v:any)=>v.type==='tool_result'&&v.tool_use_id===callId)?'SendMessage':undefined,send=!!tool,text=main?'PAIR_CLAUDE_DONE_'+phase:'{"state":"done"}';
    const toolInput=tool==='ListAgents'?{}:{to:'nxbridge:codex',message:'PAIR_NATIVE_DRAFT_'+phase},content=send?{type:'tool_use',id:tool==='ListAgents'?listId:callId,name:tool,input:toolInput}:{type:'text',text};
    const response={id:'pair-'+requests.length,type:'message',role:'assistant',model:body.model,content:[content],stop_reason:send?'tool_use':'end_turn',stop_sequence:null,usage:{input_tokens:10,output_tokens:5}};
    if(!body.stream){res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify(response));return;}
    res.writeHead(200,{'content-type':'text/event-stream'});
    for(const e of [{type:'message_start',message:{...response,content:[],stop_reason:null}},{type:'content_block_start',index:0,content_block:send?{...content,input:{}}:{type:'text',text:''}},{type:'content_block_delta',index:0,delta:send?{type:'input_json_delta',partial_json:JSON.stringify(toolInput)}:{type:'text_delta',text}},{type:'content_block_stop',index:0},{type:'message_delta',delta:{stop_reason:response.stop_reason,stop_sequence:null},usage:{output_tokens:5}},{type:'message_stop'}])res.write('event: '+e.type+'\ndata: '+JSON.stringify(e)+'\n\n');res.end();
  }catch(error){errors.push(String(error));res.writeHead(500);res.end(String(error));}});
  await new Promise<void>(r=>model.listen(0,'127.0.0.1',r));const base=`http://127.0.0.1:${(model.address() as any).port}`;
  const env={NXBRIDGE_HOME:home,CODEX_HOME:codexhome,CLAUDE_CONFIG_DIR:claudehome,OPENAI_API_KEY:'pair-local-only',ANTHROPIC_API_KEY:'pair-local-only',ANTHROPIC_BASE_URL:base,DISABLE_AUTOUPDATER:'1',DISABLE_TELEMETRY:'1',CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC:'1'},restoreEnvironment=overrideEnvironment(env);
  t.after(async()=>{try{for(const terminal of terminals)await terminal.close();try{await brokerCall('shutdown',{releaseOwned:false},{home,start:false});}catch{}await temp.cleanup();}finally{model.closeAllConnections();await new Promise<void>(r=>model.close(()=>r()));restoreEnvironment();}});
  writeFileSync(path.join(home,'config.json'),JSON.stringify({...DEFAULT_CONFIG,implicit:'never',compatibilityWake:'strict',codexHome:codexhome,claudeHome:claudehome}),'utf8');
  writeFileSync(path.join(codexhome,'config.toml'),stringify({model:'gpt-5.1-codex',model_provider:'pair_local',approval_policy:'never',sandbox_mode:'read-only',web_search:'disabled',suppress_unstable_features_warning:true,check_for_update_on_startup:false,features:{hooks:true,apps:false,remote_plugin:false,code_mode:{enabled:false,direct_only_tool_namespaces:['claude']},non_prefixed_mcp_tool_names:{enabled:true,server_names:['claude']}},model_providers:{pair_local:{name:'原生配对本地验收',base_url:base+'/v1',wire_api:'responses',requires_openai_auth:false}},projects:{[root]:{trust_level:'trusted'}}}),'utf8');
  const execute=promisify(execFile),nativeCwd=(await execute(windowsPowerShell(),['-NoProfile','-NonInteractive','-Command','(Get-Location).Path'],{cwd:root,windowsHide:true})).stdout.trim(),shortCwd=(await execute(windowsPowerShell(),['-NoProfile','-NonInteractive','-Command','$fs=New-Object -ComObject Scripting.FileSystemObject; $fs.GetFolder((Get-Location).Path).ShortPath'],{cwd:root,windowsHide:true})).stdout.trim();
  writeFileSync(path.join(claudehome,'.claude.json'),JSON.stringify({hasCompletedOnboarding:true,customApiKeyResponses:{approved:[env.ANTHROPIC_API_KEY.slice(-20)],rejected:[]},projects:Object.fromEntries([root,nativeCwd,shortCwd].map(p=>[p.replaceAll('\\','/'),{hasTrustDialogAccepted:true}]))}),'utf8');
  writeFileSync(path.join(claudehome,'settings.json'),JSON.stringify({crossSessionInbound:'accept',autoUpdatesChannel:'stable',env:{ANTHROPIC_API_KEY:env.ANTHROPIC_API_KEY,ANTHROPIC_BASE_URL:base,CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC:'1'}}),'utf8');
  const marketplace=await preparePlugins(home);await runCli('codex',['plugin','marketplace','add',marketplace,'--json']);await runCli('codex',['plugin','add','nxbridge@nxbridge-local','--json']);(await ensureBroker(home)).close();
  const launch=async(host:'codex'|'claude')=>{const cli=resolveCli(host),args=host==='codex'?['--no-daemon','--no-alt-screen','--dangerously-bypass-hook-trust']:['--plugin-dir',path.join(marketplace,'plugins/claude'),'--model','claude-sonnet-4-6'];const terminal=await NativeTerminal.start(root,home,cli.command,[...cli.prefix,...args],root,{...process.env,TERM:'xterm-256color',COLORTERM:'truecolor'});terminals.push(terminal);return terminal;};
  const status=()=>brokerCall<any>('status',{}, {home}),codex:NativeTerminal[]=[];
  const addCandidate=async()=>{const terminal=await launch('codex');codex.push(terminal);await terminal.prompt('初始化配对候选 '+codex.length);await terminal.wait(()=>{const output=stripVTControlCharacters(terminal.output),end=output.lastIndexOf('PAIR_CODEX_DONE');return end!==-1&&output.slice(end+'PAIR_CODEX_DONE'.length).includes('Worked for');},'Codex 候选未完成原生初始化',25000);};
  await addCandidate();
  let targets=(await status()).peers.filter((p:any)=>p.host==='codex'&&p.context);assert.equal(targets.length,1);
  const claude=await launch('claude');await claude.prompt('发送第一条配对验收消息');await claude.wait(()=>{const screen=stripVTControlCharacters(claude.output).replace(/\s+/gu,'');return screen.includes('这个项目里已经开着一个还没配对的Codex窗口')&&screen.includes('Entertoselect');},'唯一候选未完整显示原生选择表单',30000);
  assert.equal((await status()).pairs.length,0);assert.equal((await status()).messages.length,0);
  await claude.prompt('');await claude.wait(()=>claude.output.includes('PAIR_CLAUDE_DONE_0'),'原生用户选择未完成发信',25000);
  let s=await status();assert.equal(s.pairs.length,1);const first=s.pairs[0],message=s.messages.find((m:any)=>m.body==='PAIR_NATIVE_DRAFT_0');assert.equal(message.to,first.codex);assert.equal(s.messages.length,1);
  await addCandidate();targets=(await status()).peers.filter((p:any)=>p.host==='codex'&&p.context);assert.equal(targets.length,2);
  await brokerCall('unpair',{pair_id:first.id},{home});phase=1;const offset=claude.output.length;await claude.prompt('再发一条消息，这次在目标窗口输入配对码');
  let code='';await claude.wait(()=>{code=/nxbridgepair(\d{4})/.exec(stripVTControlCharacters(claude.output.slice(offset)).replace(/\s+/gu,''))?.[1]??'';return!!code;},'原生表单未显示配对码',25000);
  const target=targets.find((p:any)=>p.id!==first.codex),targetPid=(await status()).bindings.find((b:any)=>b.peerId===target.id&&b.active).pid,targetIndex=codex.findIndex(v=>v.identity.pid===targetPid),before=requests.filter(r=>r.host==='codex').length;assert.notEqual(targetIndex,-1);await codex[targetIndex]!.prompt('nxbridge pair '+code);
  await codex[targetIndex]!.wait(async()=>(await status()).pairs.length===1,'原生配对码未提交',25000);
  await codex[targetIndex]!.wait(()=>stripVTControlCharacters(codex[targetIndex]!.output).replace(/\s+/gu,'').includes('对方的消息已送出'),'配对码缺少原生拦截反馈',25000);
  claude.send('\x1b');await claude.wait(()=>claude.output.includes('PAIR_CLAUDE_DONE_1'),'配对码提交后原选择未结束',25000);
  s=await status();assert.equal(s.pairs[0].codex,target.id);assert.equal(s.messages.filter((m:any)=>m.body==='PAIR_NATIVE_DRAFT_1').length,1);assert.equal(s.messages.length,2);
  assert.equal(requests.filter(r=>r.host==='codex').length,before,'原生配对码被送进模型；新增请求：'+JSON.stringify(requests.filter(r=>r.host==='codex').slice(before).map(r=>({input:r.body.input?.slice(-3),tools:r.body.tools?.map((v:any)=>v.name)}))));assert.equal(errors.length,0);
  assert.ok(requests.filter(r=>r.host==='codex').every(r=>!JSON.stringify(r.body).includes('nxbridge pair '+code)),'模型请求泄漏原生配对命令');
  const changeOffset=claude.output.length;await claude.prompt('/nxbridge pair');await claude.wait(()=>stripVTControlCharacters(claude.output.slice(changeOffset)).replace(/\s+/gu,'').includes('当前搭档'),'已配对窗口没有打开原地改绑表单',20000);
  assert.equal((await status()).pairs.length,1,'打开改绑表单不能提前解除');claude.send('\x1b[B');await new Promise(resolve=>setTimeout(resolve,100));claude.send('\r');
  await claude.wait(async()=>(await status()).pairs.length===0,'原生改绑表单未完成解除配对',20000);assert.equal((await status()).messages.length,2);
  t.diagnostic(JSON.stringify({nativeWindows:terminals.map(v=>v.identity.pid),selection:true,pairingCode:true,changePicker:true,unpair:true,messages:s.messages.map((m:any)=>m.id),realModelCalls:0}));
});
