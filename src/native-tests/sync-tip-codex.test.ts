import { overrideEnvironment } from '../tests/support/environment.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import { mkdirSync, writeFileSync } from 'node:fs';
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
import { holdModelStream } from './model-stream-fixture.js';

test('安装版 Codex：从未联系也收到三次提醒，真实输入用量随 PostToolUse 进入长上下文提醒',{skip:process.platform!=='win32',timeout:170000},async t=>{
  const temp=temporaryDirectory(),root=temp.directory,home=path.join(root,'bridge'),codexhome=path.join(root,'codex'),claudehome=path.join(root,'claude');
  for(const d of [home,codexhome,claudehome])mkdirSync(d,{recursive:true});
  const requests:any[]=[],errors:string[]=[],tip='recheck split per nxbridge routing + any extra user rules';
  const model=http.createServer(async(req,res)=>{try{
    const raw=await readModelBody(req);
    if(!req.url?.includes('/responses')){res.writeHead(200,{'content-type':'application/json'});res.end('{"data":[]}');return;}
    const body=JSON.parse(raw.toString());requests.push(body);const working=JSON.stringify(body.input).includes('SYNC_CODEX_WORK');
    let spec:any;for(const tool of body.tools??[]){if(tool.type==='namespace'){const inner=tool.tools.find((v:any)=>/receive_messages$/.test(v.name));if(inner)spec={...inner,namespace:tool.name};}else if(/receive_messages$/.test(tool.name))spec=tool;}
    const has=(id:string)=>body.input?.some((item:any)=>item.type==='function_call_output'&&item.call_id===id),call=working&&spec?['sync-first','sync-second','sync-third','sync-fourth','sync-fifth'].find(id=>!has(id)):undefined;
    const id='sync-'+requests.length,item=call?{type:'function_call',id:'fc-'+id,call_id:call,name:spec.name,...(spec.namespace?{namespace:spec.namespace}:{}),arguments:'{}'}:{type:'message',id:'msg-'+id,role:'assistant',status:'completed',content:[{type:'output_text',text:'SYNC_CODEX_DONE'}]};
    res.writeHead(200,{'content-type':'text/event-stream'});const emit=(event:any)=>res.write('data: '+JSON.stringify(event)+'\n\n');
    emit({type:'response.created',response:{id,status:'in_progress',output:[]}});emit({type:'response.output_item.added',output_index:0,item:call?{...item,arguments:''}:item});
    if(['sync-second','sync-third','sync-fourth'].includes(call??'')&&!await holdModelStream(res,33000))return;
    emit({type:'response.output_item.done',output_index:0,item});emit({type:'response.completed',response:{id,status:'completed',output:[item],usage:{input_tokens:45,input_tokens_details:{cached_tokens:40},output_tokens:5,total_tokens:50}}});res.end();
  }catch(error){errors.push(String(error));res.writeHead(500);res.end(String(error));}});
  await new Promise<void>(resolve=>model.listen(0,'127.0.0.1',resolve));
  const env={NXBRIDGE_HOME:home,CODEX_HOME:codexhome,CLAUDE_CONFIG_DIR:claudehome,OPENAI_API_KEY:'sync-native-local-only'},restoreEnvironment=overrideEnvironment(env);
  let terminal:NativeTerminal|undefined;
  t.after(async()=>{try{await terminal?.close();try{await brokerCall('shutdown',{releaseOwned:false},{home,start:false});}catch{}await temp.cleanup();}finally{model.closeAllConnections();await new Promise<void>(resolve=>model.close(()=>resolve()));restoreEnvironment();}});
  writeFileSync(path.join(home,'config.json'),JSON.stringify({...DEFAULT_CONFIG,implicit:'never',compatibilityWake:'strict',syncTipMinutes:1,contextTipTokens:[20,40,60],codexHome:codexhome,claudeHome:claudehome}),'utf8');
  writeFileSync(path.join(codexhome,'config.toml'),stringify({model:'gpt-5.1-codex',model_provider:'local_sync',model_reasoning_effort:'low',approval_policy:'never',sandbox_mode:'read-only',suppress_unstable_features_warning:true,check_for_update_on_startup:false,features:{hooks:true,apps:false,remote_plugin:false,code_mode:{enabled:false,direct_only_tool_namespaces:['claude']},non_prefixed_mcp_tool_names:{enabled:true,server_names:['claude']}},model_providers:{local_sync:{name:'本地同步提醒验收',base_url:`http://127.0.0.1:${(model.address() as any).port}/v1`,wire_api:'responses',requires_openai_auth:false}},projects:{[root]:{trust_level:'trusted'}}}),'utf8');
  const marketplace=await preparePlugins(home,{packageRoot:path.join(PACKAGE_ROOT,'publish')});await runCli('codex',['plugin','marketplace','add',marketplace,'--json']);await runCli('codex',['plugin','add','nxbridge@nxbridge-local','--json']);(await ensureBroker(home)).close();const exe=resolveCli('codex');
  terminal=await NativeTerminal.start(root,home,exe.command,[...exe.prefix,'--no-daemon','--no-alt-screen','--dangerously-bypass-hook-trust'],root,{...process.env,TERM:'xterm-256color',COLORTERM:'truecolor'});
  const status=()=>brokerCall<any>('status',{}, {home});await terminal.prompt('初始化同步提醒验收');
  await terminal.wait(()=>{const output=stripVTControlCharacters(terminal!.output),end=output.lastIndexOf('SYNC_CODEX_DONE');return end!==-1&&output.slice(end+'SYNC_CODEX_DONE'.length).includes('Worked for');},'初始原生轮次未完成',30000);
  const s=await status(),x=s.peers.find((peer:any)=>peer.host==='codex'&&peer.context);assert.ok(x,'真实 hooks 未登记原生窗口');
  const identity=await processIdentity(process.pid),c=await brokerCall<any>('register',{host:'claude',sessionId:'sync-counterpart',cwd:root,kind:'root',state:'ready',permission:'prompting',endpoint:{mode:'embedded',address:'',epoch:'sync-counterpart',pid:process.pid,procStart:identity.startedAt}},{home});
  await brokerCall('pair',{claude:c.id,codex:x.id},{home});await terminal.prompt('SYNC_CODEX_WORK 继续已有任务并读取搭档消息');
  await terminal.wait(()=>requests.some(body=>JSON.stringify(body.input).includes('tip 3/3, last this stretch')),'重复协作提醒未进入原生模型请求；'+errors.join(';'),125000);
  assert.ok(requests.some(body=>JSON.stringify(body.input).includes(tip)&&JSON.stringify(body.input).includes('long context')));
  const events=await brokerCall<any[]>('events',{}, {home}),tips=events.filter(event=>event.type==='communication.syncTip'&&event.data.peerId===x.id);assert.deepEqual(tips.map(event=>event.data.ordinal),[1,2,3]);assert.equal(tips[0].data.contextBand,40);assert.equal(events.filter(event=>event.type==='message.accepted').length,0);assert.equal(errors.length,0);
  t.diagnostic(JSON.stringify({nativePid:terminal.identity.pid,neverContacted:true,repeatTips:3,contextInModel:true,realModelCalls:0}));
});
